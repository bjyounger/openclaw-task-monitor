import { Task } from '../core/task';
import type { ITaskConfig } from '../core/interfaces';

/**
 * Exec 任务
 * 
 * 特点：
 * - 短超时（默认 5 分钟）
 * - 不支持重试（maxRetries = 0）
 * - 追踪命令
 * - 实时失败上报
 */
export class ExecTask extends Task {
  /** 命令内容 */
  private command: string;
  
  /** 进程 ID */
  private pid: number | null = null;
  
  constructor(config: ITaskConfig & { command: string }) {
    super({
      ...config,
      type: 'exec',
      metadata: { ...config.metadata, command: config.command },
    });
    
    this.command = config.command;
  }
  
  protected getDefaultTimeout(): number {
    return 5 * 60 * 1000; // 5 分钟
  }
  
  protected getDefaultMaxRetries(): number {
    return 0; // Exec 任务不重试
  }
  
  protected async onStart(): Promise<void> {
    Task.logger?.info?.(
      `[ExecTask] Started: ${this.state.id}, command: ${this.command.slice(0, 100)}`
    );
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    const duration = Date.now() - this.state.startTime;
    
    Task.logger?.info?.(
      `[ExecTask] Completed: ${this.state.id}, duration: ${duration}ms`
    );
  }
  
  protected async onTimeout(): Promise<void> {
    const duration = Math.floor((Date.now() - this.state.startTime) / 1000);
    
    Task.logger?.warn?.(
      `[ExecTask] Timeout: ${this.state.id}, duration: ${duration}s, command: ${this.command.slice(0, 100)}`
    );
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    Task.logger?.error?.(
      `[ExecTask] Abandoned: ${this.state.id}, reason: ${reason}, command: ${this.command.slice(0, 100)}`
    );
  }
  
  /**
   * 设置进程 ID
   */
  public setPid(pid: number): void {
    this.pid = pid;
    this.state.metadata = { ...this.state.metadata, pid };
  }
  
  /**
   * 获取进程 ID
   */
  public getPid(): number | null {
    return this.pid;
  }
  
  /**
   * 获取命令
   */
  public getCommand(): string {
    return this.command;
  }
  
  /**
   * 获取命令摘要（前 100 字符）
   */
  public getCommandSummary(): string {
    return this.command.length > 100 
      ? this.command.slice(0, 100) + '...' 
      : this.command;
  }
}

export default ExecTask;
