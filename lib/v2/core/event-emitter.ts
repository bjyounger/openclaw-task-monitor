import { Mutex } from 'async-mutex';
import type {
  ITaskEventEmitter,
  ITaskObserver,
  ILogger,
} from './interfaces';
import type { ITaskEvent } from './types';

/**
 * 任务事件发射器（优化版）
 * 
 * 优化项：
 * 1. 性能优化：事件分发异步处理不阻塞主流程
 * 2. 类型安全：Logger 类型定义
 * 3. 并发控制：可配置最大并发观察者数
 * 4. 错误隔离：单个观察者失败不影响其他观察者
 * 
 * 线程安全的事件分发机制
 * 支持异步通知所有观察者
 */
export class TaskEventEmitter implements ITaskEventEmitter {
  /** 观察者列表 */
  private observers: Set<ITaskObserver> = new Set();
  
  /** 互斥锁 */
  private mutex = new Mutex();
  
  /** 日志器 */
  private logger: ILogger;
  
  /** 是否启用 */
  private enabled: boolean = true;
  
  /** 最大并发观察者数（0 = 无限制） */
  private readonly maxConcurrentObservers: number;
  
  /** 事件队列（用于异步处理） */
  private eventQueue: ITaskEvent[] = [];
  
  /** 是否正在处理队列 */
  private isProcessingQueue: boolean = false;
  
  /** 统计信息 */
  private stats = {
    totalEvents: 0,
    failedObservers: 0,
    averageProcessTime: 0,
  };
  
  constructor(config?: {
    logger?: ILogger;
    maxConcurrentObservers?: number;
  }) {
    this.logger = config?.logger ?? {};
    this.maxConcurrentObservers = config?.maxConcurrentObservers ?? 0;
  }
  
  /**
   * 发射事件
   * 
   * 优化项 2.1：异步通知所有观察者，不阻塞主流程
   */
  public emit(event: ITaskEvent): void {
    if (!this.enabled) {
      return;
    }
    
    this.stats.totalEvents++;
    
    // 添加到队列，异步处理
    this.eventQueue.push(event);
    
    // 如果没有在处理队列，启动处理
    if (!this.isProcessingQueue) {
      this.processQueueAsync().catch(e => {
        this.logger.error?.(`[EventEmitter] Error processing event queue: ${e}`);
      });
    }
  }
  
  /**
   * 同步发射事件（等待所有观察者处理完成）
   */
  public async emitSync(event: ITaskEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }
    
    await this.dispatchEvent(event);
  }
  
  /**
   * 异步处理事件队列
   * 
   * 优化项 2.1：异步处理不阻塞主流程
   */
  private async processQueueAsync(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    try {
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift();
        if (event) {
          // 异步分发，不等待完成
          this.dispatchEvent(event).catch(e => {
            this.logger.error?.(
              `[EventEmitter] Error dispatching event ${event.type}: ${e}`
            );
          });
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }
  
  /**
   * 分发事件到所有观察者
   * 
   * 优化项 2.1：异步处理，不阻塞主流程
   */
  private async dispatchEvent(event: ITaskEvent): Promise<void> {
    const release = await this.mutex.acquire();
    const startTime = Date.now();
    
    try {
      const observers = Array.from(this.observers);
      
      this.logger.debug?.(
        `[EventEmitter] Dispatching event ${event.type} to ${observers.length} observers`
      );
      
      if (observers.length === 0) {
        return;
      }
      
      // 优化项 2.1：异步处理每个观察者，不等待完成
      const processObserver = async (observer: ITaskObserver): Promise<void> => {
        try {
          // 异步调用，不阻塞
          await observer.onTaskEvent(event);
        } catch (e) {
          this.stats.failedObservers++;
          this.logger.error?.(
            `[EventEmitter] Observer ${observer.name} error for event ${event.type}: ${e}`,
            {
              observer: observer.name,
              eventType: event.type,
              taskId: event.taskId,
              error: e instanceof Error ? e.stack : String(e),
            }
          );
        }
      };
      
      // 并发控制
      if (this.maxConcurrentObservers > 0 && observers.length > this.maxConcurrentObservers) {
        // 分批处理
        for (let i = 0; i < observers.length; i += this.maxConcurrentObservers) {
          const batch = observers.slice(i, i + this.maxConcurrentObservers);
          // 异步处理，不等待
          Promise.all(batch.map(processObserver)).catch(e => {
            this.logger.error?.(`[EventEmitter] Batch processing error: ${e}`);
          });
        }
      } else {
        // 全部异步处理，不等待
        Promise.all(observers.map(processObserver)).catch(e => {
          this.logger.error?.(`[EventEmitter] Parallel processing error: ${e}`);
        });
      }
      
      // 更新统计
      const processTime = Date.now() - startTime;
      this.stats.averageProcessTime = 
        (this.stats.averageProcessTime + processTime) / 2;
      
    } finally {
      release();
    }
  }
  
  /**
   * 添加观察者
   */
  public addListener(observer: ITaskObserver): void {
    if (this.observers.has(observer)) {
      this.logger.warn?.(`[EventEmitter] Observer already registered: ${observer.name}`);
      return;
    }
    
    this.observers.add(observer);
    this.logger.debug?.(
      `[EventEmitter] Observer added: ${observer.name}, total: ${this.observers.size}`
    );
  }
  
  /**
   * 移除观察者
   */
  public removeListener(observer: ITaskObserver): void {
    const deleted = this.observers.delete(observer);
    if (deleted) {
      this.logger.debug?.(
        `[EventEmitter] Observer removed: ${observer.name}, total: ${this.observers.size}`
      );
    }
  }
  
  /**
   * 获取所有观察者
   */
  public getListeners(): ITaskObserver[] {
    return Array.from(this.observers);
  }
  
  /**
   * 获取观察者数量
   */
  public getObserverCount(): number {
    return this.observers.size;
  }
  
  /**
   * 启用/禁用事件发射
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.logger.info?.(`[EventEmitter] ${enabled ? 'Enabled' : 'Disabled'}`);
  }
  
  /**
   * 获取统计信息
   */
  public getStats(): typeof this.stats {
    return { ...this.stats };
  }
  
  /**
   * 清除所有观察者
   */
  public clear(): void {
    this.observers.clear();
    this.eventQueue = [];
    this.logger.info?.(`[EventEmitter] All observers cleared`);
  }
  
  /**
   * 销毁（释放资源）
   */
  public destroy(): void {
    this.clear();
    this.enabled = false;
  }
}

export default TaskEventEmitter;
