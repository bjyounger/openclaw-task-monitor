import type {
  IRetryObserver,
  IRetryManager,
  IRetryStrategy,
} from '../core/interfaces';
import type { ITaskEvent } from '../core/types';

/**
 * 重试观察者
 * 
 * 职责：
 * - 监听重试调度事件
 * - 管理重试计划
 */
export class RetryObserver implements IRetryObserver {
  public readonly name = 'RetryObserver';
  
  private retryManager: IRetryManager;
  private retryStrategy: IRetryStrategy;
  private logger: any;
  
  constructor(
    retryManager: IRetryManager,
    retryStrategy: IRetryStrategy,
    logger?: any
  ) {
    this.retryManager = retryManager;
    this.retryStrategy = retryStrategy;
    this.logger = logger;
  }
  
  public async onTaskEvent(event: ITaskEvent): Promise<void> {
    switch (event.type) {
      case 'task_retry_scheduled':
        await this.handleRetryScheduled(event);
        break;
      
      case 'task_completed':
      case 'task_killed':
      case 'task_abandoned':
        // 任务已完成或终止，取消未执行的重试
        await this.cancelRetry(event.taskId);
        break;
      
      case 'task_retry_executed':
        // 重试已执行，标记
        await this.retryManager.markRetryExecuted(event.taskId);
        break;
    }
  }
  
  /**
   * 处理重试调度事件
   */
  private async handleRetryScheduled(event: ITaskEvent): Promise<void> {
    const delay = event.data?.delay as number;
    
    if (delay === undefined) {
      this.logger?.error?.(
        `[RetryObserver] Missing delay in retry_scheduled event for ${event.taskId}`
      );
      return;
    }
    
    await this.scheduleRetry(event.taskId, delay);
  }
  
  public async scheduleRetry(taskId: string, delayMs: number): Promise<void> {
    await this.retryManager.scheduleRetry(taskId, delayMs);
    
    this.logger?.info?.(
      `[RetryObserver] Retry scheduled: ${taskId} in ${Math.floor(delayMs / 1000)}s`
    );
  }
  
  public async cancelRetry(taskId: string): Promise<void> {
    try {
      await this.retryManager.cancelRetry(taskId);
      this.logger?.debug?.(`[RetryObserver] Retry cancelled: ${taskId}`);
    } catch (e) {
      // 忽略取消不存在的重试
      this.logger?.debug?.(`[RetryObserver] Cancel retry failed (may not exist): ${taskId}`);
    }
  }
  
  public async getDueRetries(limit: number): Promise<string[]> {
    return this.retryManager.getDueRetries(limit);
  }
  
  /**
   * 更新重试策略
   */
  public setRetryStrategy(strategy: IRetryStrategy): void {
    this.retryStrategy = strategy;
    this.logger?.info?.(`[RetryObserver] Retry strategy updated: ${strategy.name}`);
  }
}

export default RetryObserver;
