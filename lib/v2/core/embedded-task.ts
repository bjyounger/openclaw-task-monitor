import { Task } from '../core/task';
import type { ITaskConfig } from '../core/interfaces';

/**
 * 嵌入式任务
 * 
 * 特点：
 * - 极短超时（默认 1 分钟）
 * - 不支持重试
 * - 静默执行（无通知）
 * - 仅记录状态
 */
export class EmbeddedTask extends Task {
  constructor(config: ITaskConfig) {
    super({
      ...config,
      type: 'embedded',
    });
    
    // 嵌入式任务默认不发送通知
    // 通过 metadata 控制是否通知
  }
  
  protected getDefaultTimeout(): number {
    return 60 * 1000; // 1 分钟
  }
  
  protected getDefaultMaxRetries(): number {
    return 0;
  }
  
  protected async onStart(): Promise<void> {
    // 嵌入式任务静默启动
    Task.logger?.debug?.(`[EmbeddedTask] Started: ${this.state.id}`);
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    // 嵌入式任务静默完成
    Task.logger?.debug?.(`[EmbeddedTask] Completed: ${this.state.id}`);
  }
  
  protected async onTimeout(): Promise<void> {
    // 嵌入式任务超时记录
    Task.logger?.warn?.(`[EmbeddedTask] Timeout: ${this.state.id}`);
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    // 嵌入式任务失败记录
    Task.logger?.error?.(`[EmbeddedTask] Abandoned: ${this.state.id}, reason: ${reason}`);
  }
}

export default EmbeddedTask;
