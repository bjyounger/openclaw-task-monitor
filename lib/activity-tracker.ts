/**
 * Activity Tracker - 活跃状态追踪
 * 
 * 用于追踪任务/会话的活跃状态，实现 Layer 1 秒级检测
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ==================== 类型定义 ====================

/**
 * 会话类型
 */
export type SessionType = 'main' | 'sub' | 'acp';

/**
 * 等待状态类型
 */
export type WaitStateType = 'api_response' | 'user_input' | 'file_lock' | 'subagent_wait' | 'browser_wait';

/**
 * 等待状态
 */
export interface WaitState {
  /** 等待类型 */
  type: WaitStateType;
  /** 开始等待时间 */
  since: number;
  /** 超时时间（毫秒） */
  timeout: number;
}

/**
 * 活跃状态
 */
export interface ActivityState {
  /** 运行 ID */
  runId: string;
  /** 会话 Key */
  sessionKey: string;
  /** 会话类型 */
  type: SessionType;
  /** 开始时间 */
  startTime: number;
  /** 最后工具调用时间 */
  lastToolCall: number;
  /** 最后流式输出时间 */
  lastStream: number;
  /** 最后活跃时间 */
  lastActivity: number;
  /** 正在执行的工具调用 ID 集合 */
  activeToolCalls: Set<string>;
  /** 等待状态（可选） */
  waitState?: WaitState;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 工具调用追踪信息
 */
export interface ToolCallInfo {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 运行 ID */
  runId: string;
  /** 会话 Key */
  sessionKey?: string;
  /** 开始时间 */
  startTime: number;
  /** 超时时间（毫秒） */
  timeout: number;
  /** 工具参数 */
  params?: Record<string, unknown>;
}

/**
 * 活跃追踪配置
 */
export interface ActivityTrackerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 检查间隔（毫秒） */
  checkInterval: number;
  /** 活跃超时阈值 */
  thresholds: {
    main: number;
    sub: number;
    acp: number;
  };
  /** 排除的工具（这些工具不计入活跃检测） */
  excludeTools: string[];
  /** 等待状态默认超时 */
  waitForStates: Record<WaitStateType, number>;
  /** 陈旧记录清理间隔（毫秒） */
  staleCleanupInterval: number;
  /** 陈旧记录阈值（毫秒） */
  staleThreshold: number;
}

/**
 * 钩子注册状态
 */
export interface HookRegistrationStatus {
  before_tool_call: boolean;
  after_tool_call: boolean;
  session_start: boolean;
  session_end: boolean;
  onAgentEvent: boolean;
}

// ==================== 默认配置 ====================

export const DEFAULT_ACTIVITY_TRACKER_CONFIG: ActivityTrackerConfig = {
  enabled: true,
  checkInterval: 10000, // 10 秒
  thresholds: {
    main: 60000,      // 主任务 60 秒
    sub: 180000,      // 子任务 3 分钟
    acp: 300000,      // ACP 会话 5 分钟
  },
  excludeTools: ['read', 'web_fetch'],
  waitForStates: {
    api_response: 300000,    // 5 分钟
    user_input: 600000,      // 10 分钟
    file_lock: 60000,        // 1 分钟
    subagent_wait: 600000,   // 10 分钟
    browser_wait: 300000,    // 5 分钟
  },
  staleCleanupInterval: 3600000,  // 1 小时
  staleThreshold: 21600000,       // 6 小时
};

// ==================== 工具超时配置 ====================

export const DEFAULT_TOOL_TIMEOUTS: Record<string, number> = {
  exec: 300000,            // 5 分钟
  http: 120000,            // 2 分钟
  read: 30000,             // 30 秒
  write: 30000,            // 30 秒
  browser: 300000,         // 5 分钟
  sessions_spawn: 600000,  // 10 分钟
  process: 300000,         // 5 分钟
  canvas: 300000,          // 5 分钟
};

// ==================== ActivityTracker 类 ====================

/**
 * 活跃追踪器
 * 
 * 管理任务/会话的活跃状态，支持钩子追踪和定时检测
 */
export class ActivityTracker {
  /** 活跃状态内存映射 */
  private activityMap = new Map<string, ActivityState>();
  
  /** 工具调用追踪映射 */
  private toolCallMap = new Map<string, ToolCallInfo>();
  
  /** 告警冷却映射 */
  private alertCooldowns = new Map<string, number>();
  
  /** 钩子注册状态 */
  private hookStatus: HookRegistrationStatus = {
    before_tool_call: false,
    after_tool_call: false,
    session_start: false,
    session_end: false,
    onAgentEvent: false,
  };
  
  /** 配置 */
  private config: ActivityTrackerConfig;
  
  /** 工具超时配置 */
  private toolTimeouts: Record<string, number>;
  
  /** API 引用 */
  private api: OpenClawPluginApi | null = null;
  
  /** 活跃检测定时器 */
  private activityTimer: NodeJS.Timeout | null = null;
  
  /** 工具超时检测定时器 */
  private toolTimeoutTimer: NodeJS.Timeout | null = null;
  
  /** 清理定时器 */
  private cleanupTimer: NodeJS.Timeout | null = null;
  
  /** 最后健康检查时间 */
  private lastHealthCheckTime = 0;
  
  /** 最后定时器更新时间 */
  private lastTimerUpdateTime = Date.now();
  
  /** 中断处理器回调 */
  private onInterrupt: ((runId: string, reason: string, context: any) => Promise<void>) | null = null;
  
  /** 工具超时处理器回调 */
  private onToolTimeout: ((toolCall: ToolCallInfo) => Promise<void>) | null = null;

  constructor(
    config: Partial<ActivityTrackerConfig> = {},
    toolTimeouts: Partial<Record<string, number>> = {}
  ) {
    this.config = { ...DEFAULT_ACTIVITY_TRACKER_CONFIG, ...config };
    this.toolTimeouts = { ...DEFAULT_TOOL_TIMEOUTS, ...toolTimeouts };
  }

  /**
   * 初始化追踪器
   */
  public initialize(api: OpenClawPluginApi): void {
    this.api = api;
    this.lastHealthCheckTime = Date.now();
    this.lastTimerUpdateTime = Date.now();
    
    api.logger.info?.('[activity-tracker] Initialized with config: ' +
      `checkInterval=${this.config.checkInterval}ms, ` +
      `thresholds=main:${this.config.thresholds.main}/sub:${this.config.thresholds.sub}/acp:${this.config.thresholds.acp}`);
  }

  /**
   * 设置中断处理器
   */
  public setInterruptHandler(handler: (runId: string, reason: string, context: any) => Promise<void>): void {
    this.onInterrupt = handler;
  }

  /**
   * 设置工具超时处理器
   */
  public setToolTimeoutHandler(handler: (toolCall: ToolCallInfo) => Promise<void>): void {
    this.onToolTimeout = handler;
  }

  // ==================== 钩子注册方法 ====================

  /**
   * 获取钩子注册状态
   */
  public getHookStatus(): HookRegistrationStatus {
    return { ...this.hookStatus };
  }

  /**
   * 标记钩子已注册
   */
  public markHookRegistered(hookName: keyof HookRegistrationStatus): void {
    this.hookStatus[hookName] = true;
    this.api?.logger.debug?.(`[activity-tracker] Hook registered: ${hookName}`);
  }

  /**
   * 标记钩子注册失败
   */
  public markHookFailed(hookName: keyof HookRegistrationStatus, error: any): void {
    this.hookStatus[hookName] = false;
    this.api?.logger.error?.(`[activity-tracker] Hook registration failed: ${hookName}, error: ${error}`);
  }

  /**
   * 检查关键钩子是否都已注册
   */
  public areCriticalHooksRegistered(): boolean {
    return this.hookStatus.before_tool_call && this.hookStatus.after_tool_call;
  }

  // ==================== 活跃状态管理 ====================

  /**
   * 创建活跃状态
   */
  public createActivity(
    runId: string,
    sessionKey: string,
    type: SessionType,
    metadata?: Record<string, unknown>
  ): ActivityState {
    const now = Date.now();
    const activity: ActivityState = {
      runId,
      sessionKey,
      type,
      startTime: now,
      lastToolCall: now,
      lastStream: now,
      lastActivity: now,
      activeToolCalls: new Set(),
      metadata,
    };
    
    this.activityMap.set(runId, activity);
    this.api?.logger.debug?.(`[activity-tracker] Activity created: ${runId}, type: ${type}`);
    
    return activity;
  }

  /**
   * 获取活跃状态
   */
  public getActivity(runId: string): ActivityState | undefined {
    return this.activityMap.get(runId);
  }

  /**
   * 更新活跃状态
   */
  public updateActivity(runId: string, updates: Partial<ActivityState>): ActivityState | undefined {
    const activity = this.activityMap.get(runId);
    if (!activity) return undefined;
    
    Object.assign(activity, updates);
    this.activityMap.set(runId, activity);
    
    return activity;
  }

  /**
   * 删除活跃状态
   */
  public deleteActivity(runId: string): boolean {
    const deleted = this.activityMap.delete(runId);
    if (deleted) {
      this.api?.logger.debug?.(`[activity-tracker] Activity deleted: ${runId}`);
    }
    return deleted;
  }

  /**
   * 追踪会话开始
   */
  public trackSessionStart(runId: string, sessionKey: string, type: 'main' | 'sub' | 'acp' = 'main'): void {
    const now = Date.now();
    
    // 检查是否已存在
    if (this.activityMap.has(runId)) {
      this.logger.debug?.(`[activity-tracker] Session already tracked: ${runId}`);
      return;
    }
    
    const activity: ActivityState = {
      runId,
      sessionKey,
      type,
      startTime: now,
      lastToolCall: now,
      lastStream: now,
      lastActivity: now,
      activeToolCalls: new Set(),
    };
    
    this.activityMap.set(runId, activity);
    this.logger.debug?.(`[activity-tracker] Session started: ${runId}, type: ${type}`);
  }

  /**
   * 追踪会话结束
   */
  public trackSessionEnd(runId: string, sessionKey: string): void {
    const deleted = this.activityMap.delete(runId);
    
    // 同时清理该会话的所有工具调用
    for (const [toolCallId, call] of this.toolCallMap) {
      if (call.runId === runId || call.sessionKey === sessionKey) {
        this.toolCallMap.delete(toolCallId);
      }
    }
    
    if (deleted) {
      this.logger.debug?.(`[activity-tracker] Session ended: ${runId}`);
    }
  }

  /**
   * 获取所有活跃状态
   */
  public getAllActivities(): ActivityState[] {
    return Array.from(this.activityMap.values());
  }

  /**
   * 获取活跃状态数量
   */
  public getActivityCount(): number {
    return this.activityMap.size;
  }

  // ==================== 工具调用追踪 ====================

  /**
   * 开始工具调用追踪
   */
  public startToolCall(
    toolCallId: string,
    toolName: string,
    runId: string,
    params?: Record<string, unknown>,
    sessionKey?: string
  ): ToolCallInfo {
    const timeout = this.toolTimeouts[toolName] || 300000; // 默认 5 分钟
    
    const call: ToolCallInfo = {
      toolCallId,
      toolName,
      runId,
      sessionKey,
      startTime: Date.now(),
      timeout,
      params,
    };
    
    this.toolCallMap.set(toolCallId, call);
    
    // 更新活跃状态
    const activity = this.activityMap.get(runId);
    if (activity) {
      activity.activeToolCalls.add(toolCallId);
      activity.lastToolCall = Date.now();
      activity.lastActivity = Date.now();
      
      // 设置等待状态
      this.setWaitStateForTool(runId, toolName);
    }
    
    this.api?.logger.debug?.(`[activity-tracker] Tool call started: ${toolName} (${toolCallId})`);
    
    return call;
  }

  /**
   * 结束工具调用追踪
   */
  public endToolCall(toolCallId: string, isError: boolean = false): ToolCallInfo | undefined {
    const call = this.toolCallMap.get(toolCallId);
    if (!call) return undefined;
    
    this.toolCallMap.delete(toolCallId);
    
    // 更新活跃状态
    const activity = this.activityMap.get(call.runId);
    if (activity) {
      activity.activeToolCalls.delete(toolCallId);
      activity.lastToolCall = Date.now();
      activity.lastActivity = Date.now();
      
      // 清除等待状态
      if (activity.waitState) {
        activity.waitState = undefined;
      }
    }
    
    const duration = Date.now() - call.startTime;
    this.api?.logger.debug?.(
      `[activity-tracker] Tool call ended: ${call.toolName} (${toolCallId}), ` +
      `duration: ${duration}ms, error: ${isError}`
    );
    
    return call;
  }

  /**
   * 获取工具调用追踪
   */
  public getToolCall(toolCallId: string): ToolCallInfo | undefined {
    return this.toolCallMap.get(toolCallId);
  }

  /**
   * 获取所有工具调用
   */
  public getAllToolCalls(): ToolCallInfo[] {
    return Array.from(this.toolCallMap.values());
  }

  // ==================== 等待状态管理 ====================

  /**
   * 设置等待状态
   */
  public setWaitState(runId: string, type: WaitStateType, timeout?: number): void {
    const activity = this.activityMap.get(runId);
    if (!activity) return;
    
    const waitTimeout = timeout || this.config.waitForStates[type] || 300000;
    
    activity.waitState = {
      type,
      since: Date.now(),
      timeout: waitTimeout,
    };
    
    this.api?.logger.debug?.(`[activity-tracker] Wait state set: ${runId}, type: ${type}, timeout: ${waitTimeout}ms`);
  }

  /**
   * 清除等待状态
   */
  public clearWaitState(runId: string): void {
    const activity = this.activityMap.get(runId);
    if (!activity) return;
    
    activity.waitState = undefined;
    this.api?.logger.debug?.(`[activity-tracker] Wait state cleared: ${runId}`);
  }

  /**
   * 根据工具名称设置等待状态
   */
  private setWaitStateForTool(runId: string, toolName: string): void {
    const waitStateMap: Record<string, WaitStateType> = {
      exec: 'api_response',
      http: 'api_response',
      browser: 'browser_wait',
      sessions_spawn: 'subagent_wait',
      process: 'api_response',
      canvas: 'api_response',
    };
    
    const waitType = waitStateMap[toolName];
    if (waitType) {
      this.setWaitState(runId, waitType);
    }
  }

  // ==================== 活跃检测 ====================

  /**
   * 启动活跃检测定时器
   */
  public startActivityDetection(): void {
    if (!this.config.enabled) {
      this.api?.logger.info?.('[activity-tracker] Activity detection disabled');
      return;
    }
    
    this.activityTimer = setInterval(() => {
      this.checkActivity();
    }, this.config.checkInterval);
    
    this.api?.logger.info?.(`[activity-tracker] Activity detection started, interval: ${this.config.checkInterval}ms`);
  }

  /**
   * 停止活跃检测定时器
   */
  public stopActivityDetection(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
      this.api?.logger.info?.('[activity-tracker] Activity detection stopped');
    }
  }

  /**
   * 检查活跃状态
   */
  private async checkActivity(): Promise<void> {
    const now = Date.now();
    
    // 更新健康检查时间
    this.lastHealthCheckTime = now;
    
    // 检测定时器是否阻塞
    if (now - this.lastTimerUpdateTime > 15000) {
      this.api?.logger.warn?.(
        `[activity-tracker] Timer may have been blocked for ${now - this.lastTimerUpdateTime}ms`
      );
    }
    this.lastTimerUpdateTime = now;
    
    // 检查活跃状态
    for (const [runId, activity] of this.activityMap) {
      try {
        await this.checkActivityForRun(runId, activity, now);
      } catch (e) {
        this.api?.logger.error?.(`[activity-tracker] Error checking activity for ${runId}: ${e}`);
      }
    }
  }

  /**
   * 检查单个任务的活跃状态
   */
  private async checkActivityForRun(runId: string, activity: ActivityState, now: number): Promise<void> {
    // 如果有活跃的工具调用，跳过
    if (activity.activeToolCalls.size > 0) {
      return;
    }
    
    // 如果在等待状态，检查等待超时
    if (activity.waitState) {
      const waitElapsed = now - activity.waitState.since;
      if (waitElapsed < activity.waitState.timeout) {
        // 还在合理等待时间内
        return;
      }
      // 等待超时，继续检测
      this.api?.logger.warn?.(
        `[activity-tracker] Wait state timeout: ${runId}, type: ${activity.waitState.type}, ` +
        `elapsed: ${waitElapsed}ms, timeout: ${activity.waitState.timeout}ms`
      );
    }
    
    // 检查活跃超时
    const threshold = this.config.thresholds[activity.type];
    
    // 阈值为 0 表示禁用该类型的活跃检测
    if (!threshold || threshold <= 0) {
      return;
    }
    
    const elapsed = now - activity.lastActivity;
    
    if (elapsed > threshold) {
      // 检查告警冷却
      if (this.isInCooldown(runId)) {
        this.api?.logger.debug?.(`[activity-tracker] Alert in cooldown: ${runId}`);
        return;
      }
      
      // 触发中断处理
      this.api?.logger.warn?.(
        `[activity-tracker] Activity timeout detected: ${runId}, ` +
        `type: ${activity.type}, elapsed: ${elapsed}ms, threshold: ${threshold}ms`
      );
      
      // 记录告警冷却
      this.alertCooldowns.set(runId, now);
      
      // 调用中断处理器
      if (this.onInterrupt) {
        await this.onInterrupt(runId, 'activity_timeout', {
          activity,
          elapsed,
          threshold,
        });
      }
      
      // 删除已告警的 activity 记录，避免重复检测
      this.activityMap.delete(runId);
      this.api?.logger.debug?.(`[activity-tracker] Removed activity record after alert: ${runId}`);
    }
  }

  // ==================== 工具超时检测 ====================

  /**
   * 启动工具超时检测
   */
  public startToolTimeoutDetection(): void {
    if (!this.config.enabled) return;
    
    this.toolTimeoutTimer = setInterval(() => {
      this.checkToolTimeouts();
    }, 30000); // 30 秒检查一次
    
    this.api?.logger.info?.('[activity-tracker] Tool timeout detection started');
  }

  /**
   * 停止工具超时检测
   */
  public stopToolTimeoutDetection(): void {
    if (this.toolTimeoutTimer) {
      clearInterval(this.toolTimeoutTimer);
      this.toolTimeoutTimer = null;
      this.api?.logger.info?.('[activity-tracker] Tool timeout detection stopped');
    }
  }

  /**
   * 检查工具超时
   */
  private async checkToolTimeouts(): Promise<void> {
    const now = Date.now();
    
    for (const [toolCallId, call] of this.toolCallMap) {
      const elapsed = now - call.startTime;
      
      if (elapsed > call.timeout) {
        this.api?.logger.warn?.(
          `[activity-tracker] Tool timeout detected: ${call.toolName} (${toolCallId}), ` +
          `elapsed: ${elapsed}ms, timeout: ${call.timeout}ms`
        );
        
        // 从追踪中移除
        this.toolCallMap.delete(toolCallId);
        
        // 更新活跃状态
        const activity = this.activityMap.get(call.runId);
        if (activity) {
          activity.activeToolCalls.delete(toolCallId);
        }
        
        // 调用工具超时处理器
        if (this.onToolTimeout) {
          await this.onToolTimeout(call);
        }
      }
    }
  }

  // ==================== 清理机制 ====================

  /**
   * 启动清理定时器
   */
  public startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleRecords();
    }, this.config.staleCleanupInterval);
    
    this.api?.logger.info?.(
      `[activity-tracker] Cleanup timer started, interval: ${this.config.staleCleanupInterval}ms`
    );
  }

  /**
   * 停止清理定时器
   */
  public stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.api?.logger.info?.('[activity-tracker] Cleanup timer stopped');
    }
  }

  /**
   * 清理陈旧记录
   */
  private cleanupStaleRecords(): void {
    const now = Date.now();
    const threshold = this.config.staleThreshold;
    
    // 清理 activityMap
    let cleanedActivities = 0;
    for (const [runId, activity] of this.activityMap) {
      if (now - activity.lastActivity > threshold) {
        this.activityMap.delete(runId);
        cleanedActivities++;
      }
    }
    
    // 清理 toolCallMap
    let cleanedToolCalls = 0;
    for (const [toolCallId, call] of this.toolCallMap) {
      if (now - call.startTime > threshold) {
        this.toolCallMap.delete(toolCallId);
        cleanedToolCalls++;
      }
    }
    
    // 清理告警冷却记录
    let cleanedCooldowns = 0;
    for (const [runId, lastAlert] of this.alertCooldowns) {
      if (now - lastAlert > 3600000) { // 1 小时
        this.alertCooldowns.delete(runId);
        cleanedCooldowns++;
      }
    }
    
    if (cleanedActivities > 0 || cleanedToolCalls > 0 || cleanedCooldowns > 0) {
      this.api?.logger.info?.(
        `[activity-tracker] Cleanup completed: ` +
        `${cleanedActivities} activities, ${cleanedToolCalls} tool calls, ${cleanedCooldowns} cooldowns`
      );
    }
  }

  // ==================== 告警冷却 ====================

  /**
   * 检查是否在冷却期
   */
  public isInCooldown(runId: string, cooldownPeriod: number = 300000): boolean {
    const lastAlert = this.alertCooldowns.get(runId);
    if (!lastAlert) return false;
    return Date.now() - lastAlert < cooldownPeriod;
  }

  /**
   * 记录告警
   */
  public recordAlert(runId: string): void {
    this.alertCooldowns.set(runId, Date.now());
  }

  // ==================== 健康检查 ====================

  /**
   * 获取健康状态
   */
  public getHealthStatus(): {
    timerRunning: boolean;
    lastCheckTime: number;
    hooksRegistered: HookRegistrationStatus;
    activityCount: number;
    toolCallCount: number;
  } {
    return {
      timerRunning: this.activityTimer !== null,
      lastCheckTime: this.lastHealthCheckTime,
      hooksRegistered: { ...this.hookStatus },
      activityCount: this.activityMap.size,
      toolCallCount: this.toolCallMap.size,
    };
  }

  // ==================== 生命周期管理 ====================

  /**
   * 停止所有定时器
   */
  public shutdown(): void {
    this.stopActivityDetection();
    this.stopToolTimeoutDetection();
    this.stopCleanup();
    
    this.activityMap.clear();
    this.toolCallMap.clear();
    this.alertCooldowns.clear();
    
    this.api?.logger.info?.('[activity-tracker] Shutdown complete');
  }
}

// ==================== 单例导出 ====================

let activityTrackerInstance: ActivityTracker | null = null;

/**
 * 获取 ActivityTracker 单例
 */
export function getActivityTracker(
  config?: Partial<ActivityTrackerConfig>,
  toolTimeouts?: Partial<Record<string, number>>
): ActivityTracker {
  if (!activityTrackerInstance) {
    activityTrackerInstance = new ActivityTracker(config, toolTimeouts);
  }
  return activityTrackerInstance;
}

/**
 * 重置 ActivityTracker 单例（用于测试）
 */
export function resetActivityTracker(): void {
  if (activityTrackerInstance) {
    activityTrackerInstance.shutdown();
    activityTrackerInstance = null;
  }
}

export default ActivityTracker;
