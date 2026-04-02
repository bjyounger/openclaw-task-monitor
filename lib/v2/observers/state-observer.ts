import type {
  IStateObserver,
  ITaskState,
  IStateManager,
} from '../core/interfaces';
import type { ITaskEvent, TaskEventType } from '../core/types';

/**
 * 状态观察者
 * 
 * 职责：
 * - 持久化任务状态
 * - 响应所有状态变化事件
 */
export class StateObserver implements IStateObserver {
  public readonly name = 'StateObserver';
  
  private stateManager: IStateManager;
  private logger: any;
  
  /** 需要持久化的事件 */
  private static readonly PERSIST_EVENTS: Set<TaskEventType> = new Set([
    'task_created',
    'task_started',
    'task_completed',
    'task_failed',
    'task_timeout',
    'task_retry_scheduled',
    'task_abandoned',
    'task_killed',
    'task_heartbeat',
  ]);
  
  constructor(stateManager: IStateManager, logger?: any) {
    this.stateManager = stateManager;
    this.logger = logger;
  }
  
  public async onTaskEvent(event: ITaskEvent): Promise<void> {
    // 只处理需要持久化的事件
    if (!StateObserver.PERSIST_EVENTS.has(event.type)) {
      return;
    }
    
    try {
      const taskId = event.taskId;
      const updates = this.eventToUpdates(event);
      
      await this.stateManager.updateTask(taskId, updates);
      
      this.logger?.debug?.(
        `[StateObserver] Persisted event: ${event.type} for ${taskId}`
      );
    } catch (e) {
      this.logger?.error?.(`[StateObserver] Error persisting event: ${e}`);
    }
  }
  
  public async persistState(taskId: string, state: ITaskState): Promise<void> {
    await this.stateManager.updateTask(taskId, state);
  }
  
  public async loadState(taskId: string): Promise<ITaskState | null> {
    return this.stateManager.getTask(taskId);
  }
  
  /**
   * 将事件转换为状态更新
   */
  private eventToUpdates(event: ITaskEvent): Partial<ITaskState> {
    const updates: Partial<ITaskState> = {
      updatedAt: event.timestamp,
    };
    
    switch (event.type) {
      case 'task_created':
        updates.status = 'pending';
        updates.createdAt = event.timestamp;
        if (event.data?.metadata) {
          updates.metadata = event.data.metadata as Record<string, unknown>;
        }
        break;
        
      case 'task_started':
        updates.status = 'running';
        updates.startTime = event.timestamp;
        updates.lastHeartbeat = event.timestamp;
        break;
        
      case 'task_completed':
        updates.status = 'completed';
        updates.completedAt = event.timestamp;
        break;
        
      case 'task_failed':
        updates.status = 'failed';
        break;
        
      case 'task_timeout':
        updates.status = 'timeout';
        break;
        
      case 'task_retry_scheduled':
        updates.status = 'scheduled';
        if (event.data?.retryCount !== undefined) {
          updates.retryCount = event.data.retryCount as number;
        }
        if (event.data?.scheduledTime) {
          updates.lastRetryTime = event.timestamp;
        }
        break;
        
      case 'task_abandoned':
        updates.status = 'abandoned';
        break;
        
      case 'task_killed':
        updates.status = 'killed';
        break;
        
      case 'task_heartbeat':
        updates.lastHeartbeat = event.timestamp;
        break;
    }
    
    // 合并 metadata
    if (event.data && typeof event.data === 'object') {
      const eventData = event.data;
      if (eventData.metadata) {
        updates.metadata = {
          ...updates.metadata,
          ...(eventData.metadata as Record<string, unknown>),
        };
      }
    }
    
    return updates;
  }
}

export default StateObserver;
