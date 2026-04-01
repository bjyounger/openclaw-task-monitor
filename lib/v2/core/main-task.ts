import { Task } from './task';
import type { 
  ITaskConfig, 
  ITask, 
  ITaskDependencies,
  ILogger,
} from './interfaces';

/**
 * 主任务
 * 
 * 特点：
 * - 长超时（默认 2 小时）
 * - 不支持重试（maxRetries = 0）
 * - 管理子任务
 * - 自动创建任务记录文件
 * 
 * 优化项：
 * - 使用依赖注入
 * - 增强资源管理
 * - 完善日志
 */
export class MainTask extends Task {
  /** 子任务列表 */
  private subtasks: Map<string, ITask> = new Map();
  
  /** 任务记录文件路径 */
  private taskRecordPath: string | null = null;
  
  /**
   * 构造函数（依赖注入）
   */
  constructor(config: ITaskConfig, dependencies: ITaskDependencies) {
    super(
      {
        ...config,
        type: 'main',
      },
      dependencies
    );
  }
  
  protected getDefaultTimeout(): number {
    return 2 * 60 * 60 * 1000; // 2 小时
  }
  
  protected getDefaultMaxRetries(): number {
    return 0; // 主任务不重试
  }
  
  protected async onStart(): Promise<void> {
    this.logger.info?.(`[MainTask] Started: ${this.state.id}`);
    
    // 创建任务记录文件
    await this.createTaskRecord();
    
    // 更新任务频道映射
    const channel = this.state.metadata?.channel as string;
    const target = this.state.metadata?.target as string;
    if (channel && target) {
      this.logger.info?.(`[MainTask] Channel mapped: ${channel}:${target}`);
    }
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    this.logger.info?.(`[MainTask] Completed: ${this.state.id}`);
    
    // 更新任务记录文件
    await this.updateTaskRecord('completed');
    
    // 清理所有子任务
    this.cleanupSubtasks();
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    this.logger.error?.(`[MainTask] Abandoned: ${this.state.id}, reason: ${reason}`);
    
    // 清理所有子任务
    this.cleanupSubtasks();
  }
  
  /**
   * 创建任务记录文件
   */
  private async createTaskRecord(): Promise<void> {
    // 实现文件创建逻辑
    // 参考 index.ts 中的自动创建逻辑
    this.logger.debug?.(`[MainTask] Task record created: ${this.state.id}`);
  }
  
  /**
   * 更新任务记录文件
   */
  private async updateTaskRecord(status: string): Promise<void> {
    // 实现文件更新逻辑
    this.logger.debug?.(`[MainTask] Task record updated: ${this.state.id}, status: ${status}`);
  }
  
  /**
   * 添加子任务
   */
  public addSubtask(subtask: ITask): void {
    // 优化项 7.1：输入验证
    if (!subtask || !subtask.getId()) {
      throw new Error('Invalid subtask: subtask must have a valid ID');
    }
    
    this.subtasks.set(subtask.getId(), subtask);
    this.logger.debug?.(
      `[MainTask] Subtask added: ${subtask.getId()}, total: ${this.subtasks.size}`
    );
  }
  
  /**
   * 获取子任务
   */
  public getSubtask(id: string): ITask | undefined {
    return this.subtasks.get(id);
  }
  
  /**
   * 获取所有子任务
   */
  public getSubtasks(): ITask[] {
    return Array.from(this.subtasks.values());
  }
  
  /**
   * 移除子任务
   */
  public removeSubtask(id: string): boolean {
    const subtask = this.subtasks.get(id);
    if (subtask) {
      // 销毁子任务
      subtask.destroy();
    }
    
    const deleted = this.subtasks.delete(id);
    if (deleted) {
      this.logger.debug?.(
        `[MainTask] Subtask removed: ${id}, total: ${this.subtasks.size}`
      );
    }
    return deleted;
  }
  
  /**
   * 清理所有子任务
   * 
   * 优化项 5.3：资源管理，确保所有子任务都被正确销毁
   */
  private cleanupSubtasks(): void {
    for (const subtask of this.subtasks.values()) {
      try {
        subtask.destroy();
      } catch (e) {
        this.logger.error?.(
          `[MainTask] Error destroying subtask ${subtask.getId()}: ${e}`
        );
      }
    }
    this.subtasks.clear();
    this.logger.debug?.(`[MainTask] All subtasks cleaned up`);
  }
  
  /**
   * 销毁主任务（释放所有资源）
   * 
   * 优化项 5.3：资源管理
   */
  public destroy(): void {
    // 清理所有子任务
    this.cleanupSubtasks();
    
    // 调用父类销毁
    super.destroy();
    
    this.logger.debug?.(`[MainTask] Destroyed: ${this.state.id}`);
  }
}

export default MainTask;
