import { Task } from '../core/task';
import type { ITaskConfig, ITask } from '../core/interfaces';

/**
 * 子任务
 * 
 * 特点：
 * - 中等超时（默认 30 分钟）
 * - 支持重试（默认 2 次）
 * - 进度报告
 * - 反馈流到父会话
 */
export class SubTask extends Task {
  /** 父会话 key */
  private parentSessionKey: string | null = null;
  
  /** 进度报告定时器 */
  private progressTimer: NodeJS.Timeout | null = null;
  
  /** 进度报告间隔 (毫秒) */
  private progressInterval: number = 5 * 60 * 1000; // 5 分钟
  
  constructor(config: ITaskConfig) {
    super({
      ...config,
      type: 'sub',
    });
    
    // 从 metadata 中提取父会话 key
    this.parentSessionKey = config.metadata?.parentSessionKey as string || null;
  }
  
  protected getDefaultTimeout(): number {
    return 30 * 60 * 1000; // 30 分钟
  }
  
  protected getDefaultMaxRetries(): number {
    return 2;
  }
  
  protected async onStart(): Promise<void> {
    Task.logger?.info?.(`[SubTask] Started: ${this.state.id}`);
    
    // 启动进度报告
    this.startProgressReport();
    
    // 注册到任务链（如果有）
    // 参考 index.ts 中的 taskChainManager.addSubtask
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    Task.logger?.info?.(`[SubTask] Completed: ${this.state.id}`);
    
    // 停止进度报告
    this.stopProgressReport();
    
    // 记录重试结果
    if (this.state.retryCount > 0) {
      this.recordRetryOutcome('ok');
    }
    
    // 通知父会话
    await this.notifyParent('completed', result);
  }
  
  protected async onTimeout(): Promise<void> {
    Task.logger?.warn?.(`[SubTask] Timeout: ${this.state.id}`);
    
    // 停止进度报告
    this.stopProgressReport();
    
    // 通知父会话
    await this.notifyParent('timeout');
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    Task.logger?.error?.(`[SubTask] Abandoned: ${this.state.id}, reason: ${reason}`);
    
    // 停止进度报告
    this.stopProgressReport();
    
    // 通知父会话
    await this.notifyParent('abandoned', { reason });
  }
  
  /**
   * 启动进度报告
   */
  private startProgressReport(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
    }
    
    this.progressTimer = setInterval(async () => {
      if (this.isDestroyed) return;
      
      try {
        await this.reportProgress();
      } catch (e) {
        Task.logger?.error?.(`[SubTask] Progress report error: ${e}`);
      }
    }, this.progressInterval);
  }
  
  /**
   * 停止进度报告
   */
  private stopProgressReport(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }
  
  /**
   * 报告进度
   */
  private async reportProgress(): Promise<void> {
    const runtime = Math.floor((Date.now() - this.state.startTime) / 60000);
    
    Task.logger?.debug?.(
      `[SubTask] Progress: ${this.state.id}, runtime: ${runtime}min, retry: ${this.state.retryCount}`
    );
    
    // 发送进度通知
    this.emitEvent('task_heartbeat', { runtime, progressReport: true });
  }
  
  /**
   * 通知父会话
   */
  private async notifyParent(status: string, data?: unknown): Promise<void> {
    if (!this.parentSessionKey) {
      return;
    }
    
    // 通过 API 发送系统事件到父会话
    // 参考 index.ts 中的 enqueueSystemEvent
    Task.logger?.debug?.(
      `[SubTask] Notify parent: ${this.parentSessionKey}, status: ${status}`
    );
  }
  
  /**
   * 设置父会话
   */
  public setParentSession(sessionKey: string): void {
    this.parentSessionKey = sessionKey;
  }
  
  /**
   * 获取父会话
   */
  public getParentSession(): string | null {
    return this.parentSessionKey;
  }
  
  /**
   * 销毁
   */
  public destroy(): void {
    this.stopProgressReport();
    super.destroy();
  }
}

export default SubTask;
