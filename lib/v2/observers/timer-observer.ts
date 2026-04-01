import type {
  ITimerObserver,
  ITaskEvent,
  IStateManager,
  ITaskState,
} from '../core/interfaces';

/**
 * 超时观察者
 * 
 * 职责：
 * - 检查超时任务
 * - 由 TimerManager 定时调用
 */
export class TimerObserver implements ITimerObserver {
  public readonly name = 'TimerObserver';
  
  private stateManager: IStateManager;
  private logger: any;
  
  /** 超时任务处理器 */
  private timeoutHandler?: (taskId: string) => Promise<void>;
  
  constructor(stateManager: IStateManager, logger?: any) {
    this.stateManager = stateManager;
    this.logger = logger;
  }
  
  public async onTaskEvent(event: ITaskEvent): Promise<void> {
    // 超时观察者不响应事件，而是由定时器轮询
  }
  
  /**
   * 设置超时处理器
   */
  public setTimeoutHandler(handler: (taskId: string) => Promise<void>): void {
    this.timeoutHandler = handler;
  }
  
  /**
   * 检查超时任务
   * 由 TimerManager 定时调用
   */
  public async checkTimeouts(): Promise<ITaskState[]> {
    try {
      const timedOutTasks = await this.stateManager.getTimedOutTasks();
      
      if (timedOutTasks.length === 0) {
        return [];
      }
      
      this.logger?.info?.(
        `[TimerObserver] Found ${timedOutTasks.length} timed out tasks`
      );
      
      // 调用处理器处理超时任务
      if (this.timeoutHandler) {
        for (const task of timedOutTasks) {
          try {
            await this.timeoutHandler(task.id);
          } catch (e) {
            this.logger?.error?.(
              `[TimerObserver] Error handling timeout for ${task.id}: ${e}`
            );
          }
        }
      }
      
      return timedOutTasks;
    } catch (e) {
      this.logger?.error?.(`[TimerObserver] Error checking timeouts: ${e}`);
      return [];
    }
  }
  
  /**
   * 获取活跃任务
   */
  public async getActiveTasks(): Promise<ITaskState[]> {
    return this.stateManager.getActiveTasks();
  }
}

export default TimerObserver;
