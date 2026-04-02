/**
 * Interrupt Handler - 中断处理器
 * 
 * 统一处理各种中断事件，包括告警去重、状态记录和恢复尝试
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { StateManager, TaskState } from "./state-manager";
import type { AlertManager } from "./alert-manager";
import type { ActivityState, ToolCallInfo } from "./activity-tracker";

// ==================== 类型定义 ====================

/**
 * 中断原因
 */
export type InterruptReason =
  | 'activity_timeout'      // Layer 1: 活跃超时
  | 'tool_timeout'          // Layer 2: 工具超时
  | 'orphaned_subagent'     // Layer 3: 孤儿子任务
  | 'fallback_timeout';     // Layer 4: 兜底超时

/**
 * 中断上下文
 */
export interface InterruptContext {
  activity?: ActivityState;
  toolCall?: ToolCallInfo;
  task?: TaskState;
  elapsed?: number;
  threshold?: number;
  error?: string;
  record?: any;
}

/**
 * 中断记录
 */
export interface InterruptRecord {
  runId: string;
  reason: InterruptReason;
  timestamp: number;
  context: InterruptContext;
  handled: boolean;
  recovered: boolean;
  retryAttempt?: number;
}

/**
 * 中断处理器配置
 */
export interface InterruptHandlerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 告警冷却期（毫秒） */
  alertCooldownPeriod: number;
  /** 是否启用自动重试 */
  autoRetryEnabled: boolean;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试递增倍数 */
  backoffMultiplier: number;
  /** 初始重试延迟（毫秒） */
  initialDelay: number;
  /** 不重试的原因列表 */
  noRetryReasons: InterruptReason[];
}

// ==================== 默认配置 ====================

export const DEFAULT_INTERRUPT_HANDLER_CONFIG: InterruptHandlerConfig = {
  enabled: true,
  alertCooldownPeriod: 300000,  // 5 分钟
  autoRetryEnabled: true,
  maxRetries: 2,
  backoffMultiplier: 2,
  initialDelay: 60000,          // 1 分钟
  noRetryReasons: [],
};

// ==================== 中断原因标签 ====================

const INTERRUPT_REASON_LABELS: Record<InterruptReason, string> = {
  activity_timeout: '活跃超时（秒级检测）',
  tool_timeout: '工具调用超时',
  orphaned_subagent: '孤儿子任务',
  fallback_timeout: '兜底超时（小时级检测）',
};

// ==================== InterruptHandler 类 ====================

/**
 * 中断处理器
 * 
 * 统一处理各种中断事件
 */
export class InterruptHandler {
  /** 配置 */
  private config: InterruptHandlerConfig;
  
  /** API 引用 */
  private api: OpenClawPluginApi | null = null;
  
  /** 状态管理器引用 */
  private stateManager: StateManager | null = null;
  
  /** 告警管理器引用 */
  private alertManager: AlertManager | null = null;
  
  /** 中断记录 */
  private interruptRecords = new Map<string, InterruptRecord[]>();
  
  /** 告警冷却映射 */
  private alertCooldowns = new Map<string, number>();
  
  /** 重试回调 */
  private onRetry: ((runId: string, task: TaskState) => Promise<void>) | null = null;

  constructor(config: Partial<InterruptHandlerConfig> = {}) {
    this.config = { ...DEFAULT_INTERRUPT_HANDLER_CONFIG, ...config };
  }

  /**
   * 初始化中断处理器
   */
  public initialize(
    api: OpenClawPluginApi,
    stateManager: StateManager,
    alertManager: AlertManager
  ): void {
    this.api = api;
    this.stateManager = stateManager;
    this.alertManager = alertManager;
    
    api.logger.info?.('[interrupt-handler] Initialized');
  }

  /**
   * 设置重试回调
   */
  public setRetryCallback(callback: (runId: string, task: TaskState) => Promise<void>): void {
    this.onRetry = callback;
  }

  // ==================== 核心处理方法 ====================

  /**
   * 处理中断（统一入口）
   */
  // 已发送过活跃超时告警的 runId 集合（永久去重）
  private activityTimeoutAlerted: Set<string> = new Set();

  public async handleInterrupt(
    runId: string,
    reason: InterruptReason,
    context: InterruptContext
  ): Promise<void> {
    if (!this.config.enabled) {
      this.api?.logger.debug?.(`[interrupt-handler] Interrupt handling disabled, skipping: ${runId}`);
      return;
    }
    
    // 活跃超时告警：每个 runId 只发送一次
    if (reason === 'activity_timeout') {
      if (this.activityTimeoutAlerted.has(runId)) {
        this.api?.logger.debug?.(`[interrupt-handler] Activity timeout alert already sent for ${runId}, skipping`);
        return;
      }
      this.activityTimeoutAlerted.add(runId);
    }
    
    // 检查告警冷却
    if (this.isInCooldown(runId)) {
      this.api?.logger.debug?.(`[interrupt-handler] Alert in cooldown, skipping: ${runId}, reason: ${reason}`);
      return;
    }
    
    this.api?.logger.warn?.(`[interrupt-handler] Handling interrupt: ${runId}, reason: ${reason}`);
    
    // 1. 记录中断
    await this.recordInterrupt(runId, reason, context);
    
    // 2. 更新任务状态
    await this.updateTaskStatus(runId, reason, context);
    
    // 3. 发送告警
    await this.sendAlert(runId, reason, context);
    
    // 4. 记录告警冷却
    this.alertCooldowns.set(runId, Date.now());
    
    // 5. 尝试恢复
    if (this.config.autoRetryEnabled) {
      await this.attemptRecovery(runId, reason, context);
    }
    
    // 6. 清理已中断的 activity 记录（避免重复检测）
    if (reason === 'activity_timeout' && context.activity) {
      // 通知 activity-tracker 删除该记录
      // 这需要通过回调实现
    }
  }

  /**
   * 处理活跃超时
   */
  public async handleActivityTimeout(runId: string, activity: ActivityState, elapsed: number, threshold: number): Promise<void> {
    await this.handleInterrupt(runId, 'activity_timeout', {
      activity,
      elapsed,
      threshold,
    });
  }

  /**
   * 处理工具超时
   */
  public async handleToolTimeout(toolCall: ToolCallInfo): Promise<void> {
    const elapsed = Date.now() - toolCall.startTime;
    await this.handleInterrupt(toolCall.runId, 'tool_timeout', {
      toolCall,
      elapsed,
      threshold: toolCall.timeout,
    });
  }

  /**
   * 处理孤儿子任务
   */
  public async handleOrphanedSubagent(runId: string, record: any): Promise<void> {
    await this.handleInterrupt(runId, 'orphaned_subagent', {
      record,
    });
  }

  /**
   * 处理兜底超时
   */
  public async handleFallbackTimeout(task: TaskState): Promise<void> {
    await this.handleInterrupt(task.id, 'fallback_timeout', {
      task,
    });
  }

  // ==================== 内部方法 ====================

  /**
   * 记录中断
   */
  private async recordInterrupt(runId: string, reason: InterruptReason, context: InterruptContext): Promise<void> {
    const record: InterruptRecord = {
      runId,
      reason,
      timestamp: Date.now(),
      context,
      handled: true,
      recovered: false,
    };
    
    // 添加到中断记录
    const records = this.interruptRecords.get(runId) || [];
    records.push(record);
    this.interruptRecords.set(runId, records);
    
    // 只保留最近 10 条记录
    if (records.length > 10) {
      records.splice(0, records.length - 10);
    }
    
    this.api?.logger.debug?.(`[interrupt-handler] Interrupt recorded: ${runId}, reason: ${reason}`);
  }

  /**
   * 更新任务状态
   */
  private async updateTaskStatus(runId: string, reason: InterruptReason, context: InterruptContext): Promise<void> {
    if (!this.stateManager) return;
    
    try {
      const task = await this.stateManager.getTask(runId);
      
      if (task) {
        await this.stateManager.updateTask(runId, {
          status: 'interrupted',
          metadata: {
            ...task.metadata,
            interruptReason: reason,
            interruptedAt: Date.now(),
            interruptContext: JSON.stringify(context),
          },
        });
      }
    } catch (e) {
      this.api?.logger.error?.(`[interrupt-handler] Failed to update task status: ${e}`);
    }
  }

  /**
   * 发送告警
   */
  private async sendAlert(runId: string, reason: InterruptReason, context: InterruptContext): Promise<void> {
    if (!this.alertManager) return;
    
    try {
      const reasonLabel = INTERRUPT_REASON_LABELS[reason];
      const elapsed = context.elapsed ? Math.floor(context.elapsed / 1000) : 0;
      const threshold = context.threshold ? Math.floor(context.threshold / 1000) : 0;
      
      let details = '';
      if (context.activity) {
        details = `类型: ${context.activity.type}`;
      } else if (context.toolCall) {
        details = `工具: ${context.toolCall.toolName}`;
      } else if (context.task) {
        details = `任务类型: ${context.task.type}`;
      }
      
      const message = `⚠️ 任务中断\n\n` +
        `原因: ${reasonLabel}\n` +
        `${details ? details + '\n' : ''}` +
        `运行时间: ${elapsed}秒\n` +
        `阈值: ${threshold}秒\n` +
        `时间: ${new Date().toLocaleString("zh-CN")}\n` +
        `RunId: ${runId}`;
      
      await this.alertManager.sendAlert(
        `interrupt_${reason}_${runId}`,
        message,
        `interrupt_${reason}`
      );
    } catch (e) {
      this.api?.logger.error?.(`[interrupt-handler] Failed to send alert: ${e}`);
    }
  }

  /**
   * 尝试恢复
   */
  private async attemptRecovery(runId: string, reason: InterruptReason, context: InterruptContext): Promise<void> {
    // 检查是否适合重试
    if (!this.shouldRetry(reason, runId)) {
      this.api?.logger.debug?.(`[interrupt-handler] Recovery skipped: ${runId}, reason: ${reason}`);
      return;
    }
    
    if (!this.stateManager) return;
    
    try {
      const task = await this.stateManager.getTask(runId);
      
      if (!task) {
        this.api?.logger.debug?.(`[interrupt-handler] Task not found for recovery: ${runId}`);
        return;
      }
      
      // 检查重试次数
      if (task.retryCount >= task.maxRetries) {
        this.api?.logger.warn?.(`[interrupt-handler] Task exhausted retries, marking as failed: ${runId}`);
        await this.stateManager.updateTask(runId, { status: 'failed' });
        await this.sendExhaustedAlert(runId, task);
        return;
      }
      
      // 执行重试
      await this.executeRetry(runId, task);
      
    } catch (e) {
      this.api?.logger.error?.(`[interrupt-handler] Recovery attempt failed: ${e}`);
    }
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(reason: InterruptReason, runId: string): boolean {
    // 某些原因不重试
    if (this.config.noRetryReasons.includes(reason)) {
      return false;
    }
    
    // 检查最近是否已重试过
    const records = this.interruptRecords.get(runId) || [];
    const lastRecord = records[records.length - 1];
    
    if (lastRecord) {
      const elapsed = Date.now() - lastRecord.timestamp;
      const minInterval = this.config.initialDelay * Math.pow(this.config.backoffMultiplier, records.length - 1);
      
      if (elapsed < minInterval) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 执行重试
   */
  private async executeRetry(runId: string, task: TaskState): Promise<void> {
    if (!this.stateManager) return;
    
    try {
      // 更新任务状态
      const newRetryCount = task.retryCount + 1;
      
      await this.stateManager.updateTask(runId, {
        status: 'pending',
        retryCount: newRetryCount,
        metadata: {
          ...task.metadata,
          retryHistory: [
            ...(Array.isArray(task.metadata?.retryHistory) ? task.metadata.retryHistory : []),
            {
              attempt: newRetryCount,
              startTime: Date.now(),
              reason: 'auto_retry',
            },
          ],
        },
      });
      
      this.api?.logger.info?.(`[interrupt-handler] Retrying task: ${runId}, attempt ${newRetryCount}`);
      
      // 调用重试回调
      if (this.onRetry) {
        await this.onRetry(runId, task);
      }
      
      // 更新中断记录
      const records = this.interruptRecords.get(runId) || [];
      if (records.length > 0) {
        records[records.length - 1].recovered = true;
        records[records.length - 1].retryAttempt = newRetryCount;
      }
      
    } catch (e) {
      this.api?.logger.error?.(`[interrupt-handler] Retry execution failed: ${e}`);
    }
  }

  /**
   * 发送重试耗尽告警
   */
  private async sendExhaustedAlert(runId: string, task: TaskState): Promise<void> {
    if (!this.alertManager) return;
    
    const label = task.metadata?.label || runId;
    
    await this.alertManager.sendAlert(
      `retry_exhausted_${runId}`,
      `❌ 任务最终失败\n\n任务: ${label}\n重试耗尽，已放弃`,
      'retry_exhausted'
    );
  }

  // ==================== 告警冷却 ====================

  /**
   * 检查是否在冷却期
   */
  public isInCooldown(runId: string): boolean {
    const lastAlert = this.alertCooldowns.get(runId);
    if (!lastAlert) return false;
    return Date.now() - lastAlert < this.config.alertCooldownPeriod;
  }

  /**
   * 清除冷却
   */
  public clearCooldown(runId: string): void {
    this.alertCooldowns.delete(runId);
  }

  // ==================== 查询方法 ====================

  /**
   * 获取中断记录
   */
  public getInterruptRecords(runId: string): InterruptRecord[] {
    return this.interruptRecords.get(runId) || [];
  }

  /**
   * 获取最近的中断记录
   */
  public getRecentInterrupt(runId: string): InterruptRecord | undefined {
    const records = this.interruptRecords.get(runId);
    return records?.[records.length - 1];
  }

  /**
   * 获取所有中断记录
   */
  public getAllInterruptRecords(): Map<string, InterruptRecord[]> {
    return this.interruptRecords;
  }

  // ==================== 生命周期管理 ====================

  /**
   * 清理陈旧记录
   */
  public cleanup(maxAge: number = 86400000): number {
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;
    
    for (const [runId, records] of this.interruptRecords) {
      const filtered = records.filter(r => r.timestamp > cutoff);
      
      if (filtered.length === 0) {
        this.interruptRecords.delete(runId);
        // 同时清理 activityTimeoutAlerted 中的记录
        this.activityTimeoutAlerted.delete(runId);
        cleaned += records.length;
      } else if (filtered.length < records.length) {
        this.interruptRecords.set(runId, filtered);
        cleaned += records.length - filtered.length;
      }
    }
    
    // 清理告警冷却记录
    for (const [runId, lastAlert] of this.alertCooldowns) {
      if (lastAlert < cutoff) {
        this.alertCooldowns.delete(runId);
      }
    }
    
    if (cleaned > 0) {
      this.api?.logger.debug?.(`[interrupt-handler] Cleaned ${cleaned} old interrupt records`);
    }
    
    return cleaned;
  }

  /**
   * 关闭处理器
   */
  public shutdown(): void {
    this.interruptRecords.clear();
    this.alertCooldowns.clear();
    this.activityTimeoutAlerted.clear();
    this.api?.logger.info?.('[interrupt-handler] Shutdown complete');
  }
}

// ==================== 单例导出 ====================

let interruptHandlerInstance: InterruptHandler | null = null;

/**
 * 获取 InterruptHandler 单例
 */
export function getInterruptHandler(config?: Partial<InterruptHandlerConfig>): InterruptHandler {
  if (!interruptHandlerInstance) {
    interruptHandlerInstance = new InterruptHandler(config);
  }
  return interruptHandlerInstance;
}

/**
 * 重置 InterruptHandler 单例（用于测试）
 */
export function resetInterruptHandler(): void {
  if (interruptHandlerInstance) {
    interruptHandlerInstance.shutdown();
    interruptHandlerInstance = null;
  }
}

export default InterruptHandler;
