/**
 * Health Checker - 健康检查
 * 
 * 检测机制本身的可靠性，包括定时器运行状态、钩子完整性等
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AlertManager } from "./alert-manager";
import type { ActivityTracker, HookRegistrationStatus } from "./activity-tracker";

// ==================== 类型定义 ====================

/**
 * 健康状态
 */
export interface HealthStatus {
  /** 整体状态 */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** 检查时间 */
  checkTime: number;
  /** 定时器运行状态 */
  timers: {
    activityDetection: boolean;
    toolTimeout: boolean;
    cleanup: boolean;
    healthCheck: boolean;
  };
  /** 钩子注册状态 */
  hooks: HookRegistrationStatus;
  /** 最后检查时间 */
  lastCheckTime: number;
  /** 定时器阻塞时间（毫秒） */
  timerBlockedMs: number;
  /** 活跃任务数 */
  activityCount: number;
  /** 工具调用数 */
  toolCallCount: number;
  /** 问题列表 */
  issues: string[];
}

/**
 * 健康检查配置
 */
export interface HealthCheckerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 检查间隔（毫秒） */
  checkInterval: number;
  /** 定时器阻塞阈值（毫秒） */
  timerBlockedThreshold: number;
  /** 是否在阻塞时告警 */
  alertOnBlocked: boolean;
}

// ==================== 默认配置 ====================

export const DEFAULT_HEALTH_CHECKER_CONFIG: HealthCheckerConfig = {
  enabled: true,
  checkInterval: 300000,        // 5 分钟
  timerBlockedThreshold: 15000, // 15 秒
  alertOnBlocked: true,
};

// ==================== HealthChecker 类 ====================

/**
 * 健康检查器
 * 
 * 监控检测机制的运行状态
 */
export class HealthChecker {
  /** 配置 */
  private config: HealthCheckerConfig;
  
  /** API 引用 */
  private api: OpenClawPluginApi | null = null;
  
  /** 告警管理器引用 */
  private alertManager: AlertManager | null = null;
  
  /** 活跃追踪器引用 */
  private activityTracker: ActivityTracker | null = null;
  
  /** 健康检查定时器 */
  private healthTimer: NodeJS.Timeout | null = null;
  
  /** 最后健康状态 */
  private lastHealthStatus: HealthStatus | null = null;
  
  /** 告警冷却映射 */
  private alertCooldowns = new Map<string, number>();
  
  /** 最后告警时间 */
  private lastAlertTime = 0;

  constructor(config: Partial<HealthCheckerConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_CHECKER_CONFIG, ...config };
  }

  /**
   * 初始化健康检查器
   */
  public initialize(
    api: OpenClawPluginApi,
    alertManager: AlertManager,
    activityTracker: ActivityTracker
  ): void {
    this.api = api;
    this.alertManager = alertManager;
    this.activityTracker = activityTracker;
    
    api.logger.info?.('[health-checker] Initialized');
  }

  /**
   * 启动健康检查定时器
   */
  public startHealthCheck(): void {
    if (!this.config.enabled) {
      this.api?.logger.info?.('[health-checker] Health check disabled');
      return;
    }
    
    this.healthTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.checkInterval);
    
    this.api?.logger.info?.(`[health-checker] Health check started, interval: ${this.config.checkInterval}ms`);
  }

  /**
   * 停止健康检查定时器
   */
  public stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
      this.api?.logger.info?.('[health-checker] Health check stopped');
    }
  }

  /**
   * 执行健康检查
   */
  public async performHealthCheck(): Promise<HealthStatus> {
    const now = Date.now();
    const issues: string[] = [];
    
    // 获取活跃追踪器状态
    const trackerStatus = this.activityTracker?.getHealthStatus() || {
      timerRunning: false,
      lastCheckTime: 0,
      hooksRegistered: {
        before_tool_call: false,
        after_tool_call: false,
        session_start: false,
        session_end: false,
        onAgentEvent: false,
      },
      activityCount: 0,
      toolCallCount: 0,
    };
    
    // 检测定时器状态
    const timerBlockedMs = now - trackerStatus.lastCheckTime;
    const timers = {
      activityDetection: trackerStatus.timerRunning,
      toolTimeout: trackerStatus.timerRunning,
      cleanup: true, // cleanup timer is internal to activityTracker
      healthCheck: this.healthTimer !== null,
    };
    
    // 检测定时器阻塞
    if (timerBlockedMs > this.config.timerBlockedThreshold) {
      issues.push(`Timer blocked for ${timerBlockedMs}ms`);
      
      if (this.config.alertOnBlocked && this.shouldSendAlert('timer_blocked')) {
        await this.sendTimerBlockedAlert(timerBlockedMs);
        this.recordAlert('timer_blocked');
      }
    }
    
    // 检测定时器是否运行
    if (!timers.activityDetection) {
      issues.push('Activity detection timer not running');
    }
    
    if (!timers.healthCheck) {
      issues.push('Health check timer not running');
    }
    
    // 检查钩子完整性
    const hooks = trackerStatus.hooksRegistered;
    const missingHooks = Object.entries(hooks)
      .filter(([, registered]) => !registered)
      .map(([name]) => name);
    
    if (missingHooks.length > 0) {
      issues.push(`Missing hooks: ${missingHooks.join(', ')}`);
      
      if (this.shouldSendAlert('missing_hooks')) {
        await this.sendMissingHooksAlert(missingHooks);
        this.recordAlert('missing_hooks');
      }
    }
    
    // 确定整体状态
    let status: 'healthy' | 'degraded' | 'unhealthy';
    
    if (issues.length === 0) {
      status = 'healthy';
    } else if (issues.some(i => i.includes('not running') || i.includes('Missing hooks: before_tool_call, after_tool_call'))) {
      status = 'unhealthy';
    } else {
      status = 'degraded';
    }
    
    // 构建健康状态
    const healthStatus: HealthStatus = {
      status,
      checkTime: now,
      timers,
      hooks,
      lastCheckTime: trackerStatus.lastCheckTime,
      timerBlockedMs,
      activityCount: trackerStatus.activityCount,
      toolCallCount: trackerStatus.toolCallCount,
      issues,
    };
    
    // 保存最后状态
    this.lastHealthStatus = healthStatus;
    
    // 记录日志
    if (status !== 'healthy') {
      this.api?.logger.warn?.(`[health-checker] Health check: ${status}, issues: ${issues.join('; ')}`);
    } else {
      this.api?.logger.debug?.(`[health-checker] Health check: ${status}`);
    }
    
    return healthStatus;
  }

  /**
   * 获取最后健康状态
   */
  public getLastHealthStatus(): HealthStatus | null {
    return this.lastHealthStatus;
  }

  /**
   * 获取健康状态摘要
   */
  public getHealthSummary(): string {
    if (!this.lastHealthStatus) {
      return 'No health check performed yet';
    }
    
    const status = this.lastHealthStatus;
    const lines = [
      `Status: ${status.status}`,
      `Activity Count: ${status.activityCount}`,
      `Tool Call Count: ${status.toolCallCount}`,
      `Timer Blocked: ${status.timerBlockedMs}ms`,
      `Hooks: ${Object.entries(status.hooks).filter(([, v]) => v).length}/5 registered`,
    ];
    
    if (status.issues.length > 0) {
      lines.push(`Issues: ${status.issues.join('; ')}`);
    }
    
    return lines.join('\n');
  }

  // ==================== 告警方法 ====================

  /**
   * 检查是否应该发送告警
   */
  private shouldSendAlert(alertType: string, cooldownPeriod: number = 3600000): boolean {
    const lastAlert = this.alertCooldowns.get(alertType);
    if (!lastAlert) return true;
    return Date.now() - lastAlert > cooldownPeriod;
  }

  /**
   * 记录告警
   */
  private recordAlert(alertType: string): void {
    this.alertCooldowns.set(alertType, Date.now());
    this.lastAlertTime = Date.now();
  }

  /**
   * 发送定时器阻塞告警
   */
  private async sendTimerBlockedAlert(blockedMs: number): Promise<void> {
    if (!this.alertManager) return;
    
    try {
      await this.alertManager.sendAlert(
        'health_check_timer_blocked',
        `⚠️ task-monitor 健康检查警告\n\n` +
        `定时器可能已阻塞\n` +
        `阻塞时间: ${Math.floor(blockedMs / 1000)}秒\n` +
        `时间: ${new Date().toLocaleString("zh-CN")}`,
        'health_check_warning'
      );
    } catch (e) {
      this.api?.logger.error?.(`[health-checker] Failed to send timer blocked alert: ${e}`);
    }
  }

  /**
   * 发送钩子缺失告警
   */
  private async sendMissingHooksAlert(missingHooks: string[]): Promise<void> {
    if (!this.alertManager) return;
    
    try {
      await this.alertManager.sendAlert(
        'health_check_missing_hooks',
        `⚠️ task-monitor 健康检查警告\n\n` +
        `关键钩子未注册\n` +
        `缺失: ${missingHooks.join(', ')}\n` +
        `时间: ${new Date().toLocaleString("zh-CN")}\n\n` +
        `部分检测功能可能已降级`,
        'health_check_warning'
      );
    } catch (e) {
      this.api?.logger.error?.(`[health-checker] Failed to send missing hooks alert: ${e}`);
    }
  }

  // ==================== 生命周期管理 ====================

  /**
   * 关闭健康检查器
   */
  public shutdown(): void {
    this.stopHealthCheck();
    this.alertCooldowns.clear();
    this.api?.logger.info?.('[health-checker] Shutdown complete');
  }
}

// ==================== 单例导出 ====================

let healthCheckerInstance: HealthChecker | null = null;

/**
 * 获取 HealthChecker 单例
 */
export function getHealthChecker(config?: Partial<HealthCheckerConfig>): HealthChecker {
  if (!healthCheckerInstance) {
    healthCheckerInstance = new HealthChecker(config);
  }
  return healthCheckerInstance;
}

/**
 * 重置 HealthChecker 单例（用于测试）
 */
export function resetHealthChecker(): void {
  if (healthCheckerInstance) {
    healthCheckerInstance.shutdown();
    healthCheckerInstance = null;
  }
}

export default HealthChecker;
