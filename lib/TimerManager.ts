/**
 * TimerManager - 统一定时器管理器
 * 
 * 使用 Mutex 确保定时器回调的互斥执行，避免并发问题
 * 支持 tick 策略调度，合并多个定时器为一个
 */

import { Mutex } from 'async-mutex';

// ==================== 类型定义 ====================

/**
 * Tick 策略配置
 */
export interface TickStrategy {
  /** 基础间隔（毫秒） */
  baseInterval: number;
  /** 各定时器的 tick 间隔（每 N 个 tick 执行一次） */
  intervals: {
    timeoutChecker: number;       // 超时检查
    retryChecker: number;         // 重试检查
    activityCheckTimer: number;   // 活跃检测
    toolTimeoutsTimer: number;    // 工具超时
    cleanupTimer: number;         // 清理任务
  };
}

/**
 * 定时器回调函数
 */
export type TimerCallback = () => Promise<void>;

/**
 * 定时器配置
 */
export interface TimerConfig {
  name: string;
  tickInterval: number;
  callback: TimerCallback;
  enabled?: boolean;
}

/**
 * TimerManager 配置
 */
export interface TimerManagerConfig {
  /** 是否使用旧版定时器（回滚开关） */
  useLegacy: boolean;
  /** tick 策略 */
  tickStrategy: TickStrategy;
  /** 执行超时（毫秒），超过后自动释放锁 */
  executionTimeout: number;
}

// ==================== 默认配置 ====================

/**
 * 默认 tick 策略
 * 
 * 基础间隔：6 秒
 * - timeoutChecker: 每次 tick（6秒）
 * - retryChecker: 每 2 个 tick（12秒）
 * - activityCheckTimer: 每 3 个 tick（18秒）
 * - toolTimeoutsTimer: 每 5 个 tick（30秒）
 * - cleanupTimer: 每 600 个 tick（1小时）
 */
export const DEFAULT_TICK_STRATEGY: TickStrategy = {
  baseInterval: 6000, // 6 秒
  intervals: {
    timeoutChecker: 1,      // 6 秒
    retryChecker: 2,        // 12 秒
    activityCheckTimer: 3,  // 18 秒
    toolTimeoutsTimer: 5,   // 30 秒
    cleanupTimer: 600,      // 1 小时
  },
};

export const DEFAULT_TIMER_MANAGER_CONFIG: TimerManagerConfig = {
  useLegacy: false,
  tickStrategy: DEFAULT_TICK_STRATEGY,
  executionTimeout: 30000, // 30 秒
};

// ==================== TimerManager 类 ====================

/**
 * 统一定时器管理器
 * 
 * 功能：
 * 1. 使用 Mutex 确保回调互斥执行
 * 2. 支持执行超时自动解锁（防止死锁）
 * 3. 支持 tick 策略调度（合并多个定时器）
 * 4. 支持优雅停止
 */
export class TimerManager {
  /** Mutex 锁 */
  private mutex = new Mutex();
  
  /** 配置 */
  private config: TimerManagerConfig;
  
  /** 定时器映射 */
  private timers = new Map<string, NodeJS.Timeout>();
  
  /** 定时器配置映射 */
  private timerConfigs = new Map<string, TimerConfig>();
  
  /** Master tick 计数器 */
  private masterTickCount = 0;
  
  /** Master tick 定时器 */
  private masterTimer: NodeJS.Timeout | null = null;
  
  /** 是否已停止 */
  private isStopped = false;
  
  /** 是否正在执行 */
  private isExecuting = false;
  
  /** 执行超时定时器 */
  private executionTimeoutTimer: NodeJS.Timeout | null = null;
  
  /** 日志器 */
  private logger: any;

  constructor(config: Partial<TimerManagerConfig> = {}, logger?: any) {
    this.config = { ...DEFAULT_TIMER_MANAGER_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * 注册定时器
   */
  public registerTimer(config: TimerConfig): void {
    if (this.timerConfigs.has(config.name)) {
      this.logger?.warn?.(`[timer-manager] Timer already registered: ${config.name}`);
      return;
    }
    
    this.timerConfigs.set(config.name, {
      ...config,
      enabled: config.enabled ?? true,
    });
    
    this.logger?.debug?.(`[timer-manager] Timer registered: ${config.name}, tickInterval: ${config.tickInterval}`);
  }

  /**
   * 注销定时器
   */
  public unregisterTimer(name: string): void {
    this.timerConfigs.delete(name);
    this.logger?.debug?.(`[timer-manager] Timer unregistered: ${name}`);
  }

  /**
   * 启动定时器管理器
   */
  public start(): void {
    if (this.config.useLegacy) {
      this.logger?.info?.('[timer-manager] Using legacy timer mode');
      this.startLegacyMode();
    } else {
      this.logger?.info?.('[timer-manager] Using unified timer mode');
      this.startUnifiedMode();
    }
    
    this.isStopped = false;
  }

  /**
   * 停止定时器管理器（优雅停止）
   */
  public stop(): void {
    this.isStopped = true;
    
    // 停止 master timer
    if (this.masterTimer) {
      clearInterval(this.masterTimer);
      this.masterTimer = null;
    }
    
    // 停止所有旧版定时器
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      this.logger?.debug?.(`[timer-manager] Legacy timer stopped: ${name}`);
    }
    this.timers.clear();
    
    // 清除执行超时定时器
    if (this.executionTimeoutTimer) {
      clearTimeout(this.executionTimeoutTimer);
      this.executionTimeoutTimer = null;
    }
    
    this.logger?.info?.('[timer-manager] All timers stopped');
  }

  /**
   * 启动统一定时器模式
   */
  private startUnifiedMode(): void {
    const { baseInterval } = this.config.tickStrategy;
    
    this.masterTimer = setInterval(() => {
      this.executeMasterTick();
    }, baseInterval);
    
    this.logger?.info?.(
      `[timer-manager] Master timer started, baseInterval: ${baseInterval}ms, ` +
      `timers: ${Array.from(this.timerConfigs.keys()).join(', ')}`
    );
  }

  /**
   * 执行 Master Tick
   */
  private async executeMasterTick(): Promise<void> {
    // 如果已停止，不执行
    if (this.isStopped) {
      return;
    }
    
    // 如果正在执行，跳过本次 tick（避免堆积）
    if (this.isExecuting) {
      this.logger?.debug?.('[timer-manager] Skipping tick, previous execution still running');
      return;
    }
    
    // 使用取模运算避免溢出
    this.masterTickCount = (this.masterTickCount + 1) % Number.MAX_SAFE_INTEGER;
    const currentTick = this.masterTickCount;
    
    this.logger?.debug?.(`[timer-manager] Master tick: ${currentTick}`);
    
    // 收集需要执行的定时器
    const timersToExecute: TimerConfig[] = [];
    
    for (const [name, config] of this.timerConfigs) {
      if (!config.enabled) continue;
      
      // 使用取模运算判断是否应该执行
      if (currentTick % config.tickInterval === 0) {
        timersToExecute.push(config);
      }
    }
    
    if (timersToExecute.length === 0) {
      return;
    }
    
    // 使用 Mutex 确保互斥执行
    const release = await this.mutex.acquire();
    
    try {
      this.isExecuting = true;
      
      // 设置执行超时
      this.executionTimeoutTimer = setTimeout(() => {
        this.logger?.warn?.('[timer-manager] Execution timeout, releasing lock');
        this.isExecuting = false;
        release();
      }, this.config.executionTimeout);
      
      // 依次执行定时器回调
      for (const config of timersToExecute) {
        if (this.isStopped) break;
        
        try {
          this.logger?.debug?.(`[timer-manager] Executing timer: ${config.name}`);
          await config.callback();
        } catch (e) {
          this.logger?.error?.(`[timer-manager] Timer callback error (${config.name}): ${e}`);
        }
      }
      
    } finally {
      // 清除执行超时定时器
      if (this.executionTimeoutTimer) {
        clearTimeout(this.executionTimeoutTimer);
        this.executionTimeoutTimer = null;
      }
      
      this.isExecuting = false;
      release();
    }
  }

  /**
   * 启动旧版定时器模式（回滚用）
   */
  private startLegacyMode(): void {
    // 为每个定时器创建独立的 setInterval
    for (const [name, config] of this.timerConfigs) {
      if (!config.enabled) continue;
      
      // 根据 tickInterval 计算实际间隔
      const interval = config.tickInterval * this.config.tickStrategy.baseInterval;
      
      const timer = setInterval(async () => {
        if (this.isStopped) return;
        
        try {
          await config.callback();
        } catch (e) {
          this.logger?.error?.(`[timer-manager] Legacy timer error (${name}): ${e}`);
        }
      }, interval);
      
      this.timers.set(name, timer);
      this.logger?.info?.(`[timer-manager] Legacy timer started: ${name}, interval: ${interval}ms`);
    }
  }

  /**
   * 获取状态
   */
  public getStatus(): {
    isStopped: boolean;
    isExecuting: boolean;
    masterTickCount: number;
    timerCount: number;
    useLegacy: boolean;
  } {
    return {
      isStopped: this.isStopped,
      isExecuting: this.isExecuting,
      masterTickCount: this.masterTickCount,
      timerCount: this.timerConfigs.size,
      useLegacy: this.config.useLegacy,
    };
  }

  /**
   * 更新配置
   */
  public updateConfig(config: Partial<TimerManagerConfig>): void {
    const wasRunning = !this.isStopped;
    
    if (wasRunning) {
      this.stop();
    }
    
    this.config = { ...this.config, ...config };
    
    if (wasRunning) {
      this.start();
    }
    
    this.logger?.info?.(`[timer-manager] Config updated, useLegacy: ${this.config.useLegacy}`);
  }
}

// ==================== 单例导出 ====================

let timerManagerInstance: TimerManager | null = null;

/**
 * 获取 TimerManager 单例
 */
export function getTimerManager(
  config?: Partial<TimerManagerConfig>,
  logger?: any
): TimerManager {
  if (!timerManagerInstance) {
    timerManagerInstance = new TimerManager(config, logger);
  }
  return timerManagerInstance;
}

/**
 * 重置 TimerManager 单例（用于测试）
 */
export function resetTimerManager(): void {
  if (timerManagerInstance) {
    timerManagerInstance.stop();
    timerManagerInstance = null;
  }
}

export default TimerManager;
