import type { ITaskFactory, ITask, ITaskState, ITaskConfig, ITaskConstructor, ITaskEventEmitter, ITaskDependencies } from '../core/interfaces';
import { MainTask } from '../core/main-task';
import { SubTask } from '../core/sub-task';
import { ExecTask } from '../core/exec-task';
import { EmbeddedTask } from '../core/embedded-task';

/**
 * 任务工厂
 * 
 * 使用工厂模式创建不同类型的任务实例
 * 支持动态注册新的任务类型
 */
export class TaskFactory implements ITaskFactory {
  /** 注册的任务类型 */
  private taskTypes: Map<string, ITaskConstructor> = new Map();
  
  /** 日志器 */
  private logger: any;
  
  /** 依赖注入 */
  private dependencies: ITaskDependencies;
  
  constructor(dependencies: ITaskDependencies, logger?: any) {
    this.dependencies = dependencies;
    this.logger = logger ?? dependencies.logger;
    
    // 注册默认任务类型（不包含 ExecTask，因为需要额外参数）
    this.registerTaskType('main', MainTask);
    this.registerTaskType('sub', SubTask);
    this.registerTaskType('embedded', EmbeddedTask);
  }
  
  /**
   * 创建任务
   */
  public createTask(config: ITaskConfig): ITask {
    const TaskClass = this.taskTypes.get(config.type);
    
    // 特殊处理 ExecTask
    if (config.type === 'exec' && config.metadata?.command) {
      return new ExecTask(config as ITaskConfig & { command: string }, this.dependencies);
    }
    
    if (!TaskClass) {
      throw new Error(`Unknown task type: ${config.type}`);
    }
    
    this.logger?.debug?.(`[TaskFactory] Creating task: ${config.id} (${config.type})`);
    
    return new TaskClass(config, this.dependencies);
  }
  
  /**
   * 从状态恢复任务
   */
  public restoreTask(state: ITaskState): ITask | null {
    const TaskClass = this.taskTypes.get(state.type);
    
    if (!TaskClass && state.type !== 'exec') {
      this.logger?.error?.(`[TaskFactory] Unknown task type for restore: ${state.type}`);
      return null;
    }
    
    this.logger?.debug?.(`[TaskFactory] Restoring task: ${state.id} (${state.type})`);
    
    // 创建配置
    const config: ITaskConfig = {
      id: state.id,
      type: state.type,
      timeoutMs: state.timeoutMs,
      parentTaskId: state.parentTaskId,
      maxRetries: state.maxRetries,
      label: state.label,
      metadata: state.metadata,
    };
    
    // 创建任务实例
    const task = this.createTask(config);
    
    // 恢复状态（通过内部方法）
    (task as any).state = { ...state };
    
    return task;
  }
  
  /**
   * 注册任务类型
   */
  public registerTaskType(type: string, taskClass: ITaskConstructor): void {
    if (this.taskTypes.has(type)) {
      this.logger?.warn?.(`[TaskFactory] Task type already registered: ${type}, overwriting`);
    }
    
    this.taskTypes.set(type, taskClass);
    this.logger?.info?.(`[TaskFactory] Task type registered: ${type}`);
  }
  
  /**
   * 注销任务类型
   */
  public unregisterTaskType(type: string): boolean {
    const deleted = this.taskTypes.delete(type);
    if (deleted) {
      this.logger?.info?.(`[TaskFactory] Task type unregistered: ${type}`);
    }
    return deleted;
  }
  
  /**
   * 检查任务类型是否已注册
   */
  public hasTaskType(type: string): boolean {
    return this.taskTypes.has(type);
  }
  
  /**
   * 获取所有注册的任务类型
   */
  public getRegisteredTypes(): string[] {
    return Array.from(this.taskTypes.keys());
  }
}

export default TaskFactory;
