import { Mutex } from 'async-mutex';
import type {
  ITask,
  ITaskState,
  ITaskConfig,
  ITaskDependencies,
  ITaskObserver,
  ITaskEventEmitter,
  IRetryStrategy,
  INotificationStrategy,
  ILogger,
  IMetricsCollector,
} from './interfaces';
import type {
  TaskType,
  TaskStatus,
  TaskEventType,
  TaskPriority,
  ErrorType,
  ITaskEvent,
} from './types';

/**
 * 任务抽象基类（优化版）
 * 
 * 优化项：
 * 1. 依赖注入改进：静态属性改为实例级依赖注入
 * 2. 性能优化：心跳机制按任务类型动态调整
 * 3. 错误处理增强：重试策略按错误类型区分
 * 4. 功能完善：任务优先级、AbortSignal 取消机制
 * 5. 代码质量：类型安全、JSDoc 文档、资源管理
 * 6. 可观测性：指标收集
 * 
 * 设计模式：
 * - 模板方法模式：定义算法骨架，子类实现细节
 * - 观察者模式：状态变化时发射事件
 * - 依赖注入：通过构造函数传递依赖
 */
export abstract class Task implements ITask {
  // ==================== 实例属性（依赖注入） ====================
  
  /** 事件发射器（实例级） */
  protected readonly eventEmitter: ITaskEventEmitter;
  
  /** 重试策略（实例级） */
  protected readonly retryStrategy: IRetryStrategy;
  
  /** 通知策略（实例级） */
  protected readonly notificationStrategy: INotificationStrategy;
  
  /** 日志器（实例级，类型安全） */
  protected readonly logger: ILogger;
  
  /** 指标收集器（可选） */
  protected readonly metricsCollector?: IMetricsCollector;
  
  // ==================== 状态属性 ====================
  
  /** 任务状态 */
  protected state: ITaskState;
  
  /** 状态互斥锁 */
  protected stateMutex = new Mutex();
  
  /** 心跳定时器 */
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  
  /** 是否已销毁 */
  protected isDestroyed = false;
  
  /** AbortController 用于取消任务 */
  protected abortController: AbortController = new AbortController();
  
  // ==================== 构造函数（依赖注入） ====================
  
  /**
   * 构造函数
   * 
   * @param config - 任务配置
   * @param dependencies - 依赖注入（eventEmitter, retryStrategy, logger 等）
   * 
   * 优化项 1.1：通过构造函数传递依赖，提高测试性和可维护性
   */
  constructor(config: ITaskConfig, dependencies: ITaskDependencies) {
    // 依赖注入
    this.eventEmitter = dependencies.eventEmitter;
    this.retryStrategy = dependencies.retryStrategy;
    this.notificationStrategy = dependencies.notificationStrategy;
    this.logger = dependencies.logger;
    this.metricsCollector = dependencies.metricsCollector;
    
    const now = Date.now();
    
    this.state = {
      id: config.id,
      type: config.type,
      status: 'pending',
      priority: config.priority ?? 'medium', // 优化项 4.1：默认优先级
      createdAt: now,
      startTime: now,
      updatedAt: now,
      lastHeartbeat: now,
      timeoutMs: config.timeoutMs ?? this.getDefaultTimeout(),
      parentTaskId: config.parentTaskId ?? null,
      retryCount: 0,
      maxRetries: config.maxRetries ?? this.getDefaultMaxRetries(),
      retryHistory: [],
      label: config.label,
      metadata: config.metadata ?? {},
      dependencies: config.dependencies,
    };
    
    // 发射创建事件
    this.emitEvent('task_created');
    
    // 记录指标
    this.metricsCollector?.recordTaskCreated(this.state.type, this.state.priority);
    
    this.logger.debug?.(`[Task] Created: ${this.state.id} (${this.state.type}, priority: ${this.state.priority})`);
  }
  
  // ==================== 生命周期方法 ====================
  
  /**
   * 启动任务
   * 
   * @param signal - AbortSignal 用于取消任务
   * @throws Error 如果任务状态不是 pending 或 scheduled
   * 
   * 优化项 4.3：支持 AbortSignal 取消机制
   */
  public async start(signal?: AbortSignal): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      // 检查取消信号
      if (signal?.aborted || this.abortController.signal.aborted) {
        throw new Error('Task cancelled before start');
      }
      
      if (this.state.status !== 'pending' && this.state.status !== 'scheduled') {
        throw new Error(`Cannot start task in status: ${this.state.status}`);
      }
      
      const previousStatus = this.state.status;
      
      this.state.status = 'running';
      this.state.startTime = Date.now();
      this.state.updatedAt = Date.now();
      this.state.lastHeartbeat = Date.now();
      
      // 启动心跳
      this.startHeartbeat();
      
      // 发射启动事件
      this.emitEvent('task_started');
      
      if (previousStatus === 'scheduled') {
        // 如果是从 scheduled 状态启动，说明是重试
        this.emitEvent('task_retry_executed', { retryCount: this.state.retryCount });
      }
      
      // 监听取消信号
      if (signal) {
        signal.addEventListener('abort', () => {
          this.cancel();
        });
      }
      
      // 调用子类启动逻辑 (模板方法)
      await this.onStart();
      
      this.logger.info?.(`[Task] Started: ${this.state.id} (${this.state.type})`);
      
    } catch (error) {
      // 优化项 3.2：增强异常处理和日志
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error?.(`[Task] Start failed: ${this.state.id}`, { 
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined 
      });
      throw error;
    } finally {
      release();
    }
  }
  
  /**
   * 完成任务
   * 
   * @param result - 任务结果（可选）
   */
  public async complete(result?: unknown): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      if (this.state.status !== 'running') {
        this.logger.warn?.(`[Task] Complete called in non-running status: ${this.state.status}`);
        return;
      }
      
      const duration = Date.now() - this.state.startTime;
      
      this.state.status = 'completed';
      this.state.completedAt = Date.now();
      this.state.updatedAt = Date.now();
      this.state.metadata = { ...this.state.metadata, result };
      
      // 停止心跳
      this.stopHeartbeat();
      
      // 发射完成事件
      this.emitEvent('task_completed', { result, duration });
      
      // 调用子类完成逻辑
      await this.onComplete(result);
      
      // 记录指标
      this.metricsCollector?.recordTaskCompleted(this.state.type, this.state.priority, duration);
      
      this.logger.info?.(
        `[Task] Completed: ${this.state.id}, duration: ${duration}ms`
      );
      
    } finally {
      release();
    }
  }
  
  /**
   * 任务失败
   * 
   * @param error - 错误信息
   * @param errorType - 错误类型（优化项 3.1：按错误类型区分重试策略）
   */
  public async fail(error: string, errorType?: ErrorType): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      if (this.state.status !== 'running') {
        this.logger.warn?.(`[Task] Fail called in non-running status: ${this.state.status}`);
        return;
      }
      
      // 分类错误类型
      const classifiedErrorType = errorType ?? this.retryStrategy.classifyError(error);
      
      this.state.status = 'failed';
      this.state.updatedAt = Date.now();
      this.state.metadata = { ...this.state.metadata, error, errorType: classifiedErrorType };
      
      // 停止心跳
      this.stopHeartbeat();
      
      // 记录重试历史
      if (this.state.retryCount > 0) {
        this.recordRetryOutcome('error', error, classifiedErrorType);
      }
      
      // 发射失败事件
      this.emitEvent('task_failed', { error, errorType: classifiedErrorType });
      
      // 记录指标
      this.metricsCollector?.recordTaskFailed(this.state.type, this.state.priority, classifiedErrorType);
      
      // 判断是否应该重试（基于错误类型）
      if (this.canRetry(classifiedErrorType)) {
        await this.scheduleRetry(classifiedErrorType);
      } else {
        await this.abandon(error);
      }
      
    } finally {
      release();
    }
  }
  
  /**
   * 更新心跳
   */
  public async heartbeat(): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      this.state.lastHeartbeat = Date.now();
      this.state.updatedAt = Date.now();
      
      // 发射心跳事件
      this.emitEvent('task_heartbeat');
      
    } finally {
      release();
    }
  }
  
  /**
   * 终止任务（强制终止）
   * 
   * @param reason - 终止原因
   */
  public async kill(reason?: string): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      this.state.status = 'killed';
      this.state.updatedAt = Date.now();
      this.state.metadata = { ...this.state.metadata, killReason: reason };
      
      // 停止心跳
      this.stopHeartbeat();
      
      // 触发取消
      this.abortController.abort();
      
      // 发射终止事件
      this.emitEvent('task_killed', { reason });
      
      this.logger.info?.(`[Task] Killed: ${this.state.id}, reason: ${reason}`);
      
    } finally {
      release();
    }
  }
  
  /**
   * 取消任务（优雅取消）
   * 
   * 优化项 4.3：基于 AbortSignal 的取消机制
   */
  public cancel(): void {
    if (this.state.status === 'pending' || this.state.status === 'scheduled') {
      this.state.status = 'killed';
      this.state.updatedAt = Date.now();
      this.abortController.abort();
      this.emitEvent('task_cancelled');
      this.logger.info?.(`[Task] Cancelled: ${this.state.id}`);
    }
  }
  
  /**
   * 标记超时
   */
  public async timeout(): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      if (this.state.status !== 'running' && this.state.status !== 'scheduled') {
        return;
      }
      
      this.state.status = 'timeout';
      this.state.updatedAt = Date.now();
      
      // 停止心跳
      this.stopHeartbeat();
      
      // 记录重试历史
      if (this.state.retryCount > 0) {
        this.recordRetryOutcome('timeout', undefined, 'timeout');
      }
      
      // 发射超时事件
      this.emitEvent('task_timeout');
      
      // 记录指标
      this.metricsCollector?.recordTaskTimeout(this.state.type, this.state.priority);
      
      // 调用子类超时逻辑
      await this.onTimeout();
      
      // 判断是否应该重试
      if (this.canRetry('timeout')) {
        await this.scheduleRetry('timeout');
      } else {
        await this.abandon('Timeout and retries exhausted');
      }
      
    } finally {
      release();
    }
  }
  
  // ==================== 检查方法 ====================
  
  /**
   * 检查是否超时
   */
  public isTimedOut(): boolean {
    if (this.state.status !== 'running' && this.state.status !== 'scheduled') {
      return false;
    }
    
    const now = Date.now();
    return now - this.state.lastHeartbeat > this.state.timeoutMs;
  }
  
  /**
   * 检查是否可以重试
   * 
   * @param errorType - 错误类型（优化项 3.1：基于错误类型判断）
   */
  public canRetry(errorType?: ErrorType): boolean {
    return this.retryStrategy.shouldRetry(
      this.state.retryCount,
      this.state.maxRetries,
      errorType
    );
  }
  
  // ==================== 重试管理 ====================
  
  /**
   * 安排重试
   * 
   * @param errorType - 错误类型（用于计算延迟）
   */
  protected async scheduleRetry(errorType?: ErrorType): Promise<void> {
    const delay = this.retryStrategy.calculateDelay(this.state.retryCount, errorType);
    
    this.state.status = 'scheduled';
    this.state.retryCount++;
    this.state.lastRetryTime = Date.now();
    this.state.updatedAt = Date.now();
    
    // 发射重试调度事件
    this.emitEvent('task_retry_scheduled', { 
      delay, 
      retryCount: this.state.retryCount,
      scheduledTime: Date.now() + delay,
      errorType,
    });
    
    // 记录指标
    this.metricsCollector?.recordRetry(this.state.type);
    
    this.logger.info?.(
      `[Task] Retry scheduled: ${this.state.id}, attempt ${this.state.retryCount}, delay ${delay}ms`
    );
  }
  
  /**
   * 执行重试
   */
  public async executeRetry(): Promise<void> {
    if (this.state.status !== 'scheduled') {
      throw new Error(`Cannot retry task in status: ${this.state.status}`);
    }
    
    await this.start();
  }
  
  /**
   * 放弃任务
   */
  protected async abandon(reason: string): Promise<void> {
    this.state.status = 'abandoned';
    this.state.updatedAt = Date.now();
    
    // 发射放弃事件
    this.emitEvent('task_abandoned', { reason });
    
    // 调用子类放弃逻辑
    await this.onAbandon(reason);
    
    this.logger.warn?.(`[Task] Abandoned: ${this.state.id}, reason: ${reason}`);
  }
  
  // ==================== 观察者管理 ====================
  
  /**
   * 添加事件监听器
   */
  public addEventListener(listener: ITaskObserver): void {
    this.eventEmitter.addListener(listener);
  }
  
  /**
   * 移除事件监听器
   */
  public removeEventListener(listener: ITaskObserver): void {
    this.eventEmitter.removeListener(listener);
  }
  
  // ==================== 状态访问 ====================
  
  public getId(): string {
    return this.state.id;
  }
  
  public getType(): TaskType {
    return this.state.type;
  }
  
  public getStatus(): TaskStatus {
    return this.state.status;
  }
  
  public getState(): Readonly<ITaskState> {
    return { ...this.state };
  }
  
  // ==================== 抽象方法 (子类必须实现) ====================
  
  /**
   * 子类启动逻辑
   */
  protected abstract onStart(): Promise<void>;
  
  /**
   * 子类完成逻辑
   */
  protected abstract onComplete(result?: unknown): Promise<void>;
  
  /**
   * 获取默认超时时间
   */
  protected abstract getDefaultTimeout(): number;
  
  /**
   * 获取默认最大重试次数
   */
  protected abstract getDefaultMaxRetries(): number;
  
  // ==================== 可选钩子方法 ====================
  
  /**
   * 任务超时时调用
   */
  protected async onTimeout(): Promise<void> {
    // 默认空实现，子类可重写
  }
  
  /**
   * 任务放弃时调用
   */
  protected async onAbandon(reason: string): Promise<void> {
    // 默认空实现，子类可重写
  }
  
  // ==================== 内部方法 ====================
  
  /**
   * 发射事件
   */
  protected emitEvent(type: TaskEventType, data?: Record<string, unknown>): void {
    const event: ITaskEvent = {
      type,
      taskId: this.state.id,
      timestamp: Date.now(),
      data: {
        ...data,
        taskType: this.state.type,
        taskStatus: this.state.status,
        priority: this.state.priority,
        parentTaskId: this.state.parentTaskId,
        label: this.state.label,
        retryCount: this.state.retryCount,
        maxRetries: this.state.maxRetries,
        channel: this.state.metadata?.channel,
        target: this.state.metadata?.target,
      },
    };
    
    this.eventEmitter.emit(event);
  }
  
  /**
   * 记录重试结果
   */
  protected recordRetryOutcome(
    outcome: 'ok' | 'error' | 'timeout', 
    reason?: string,
    errorType?: ErrorType
  ): void {
    this.state.retryHistory.push({
      attemptNumber: this.state.retryCount,
      timestamp: Date.now(),
      outcome,
      reason,
      errorType,
      duration: Date.now() - (this.state.lastRetryTime || this.state.startTime),
    });
  }
  
  /**
   * 启动心跳
   * 
   * 优化项 2.2：按任务类型动态调整心跳间隔
   */
  protected startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    
    const interval = this.getHeartbeatInterval();
    
    this.heartbeatTimer = setInterval(async () => {
      if (this.isDestroyed) return;
      
      try {
        await this.heartbeat();
      } catch (e) {
        this.logger.error?.(`[Task] Heartbeat error: ${e}`, {
          taskId: this.state.id,
          error: e instanceof Error ? e.stack : String(e)
        });
      }
    }, interval);
    
    this.logger.debug?.(`[Task] Heartbeat started: ${this.state.id}, interval: ${interval}ms`);
  }
  
  /**
   * 停止心跳
   */
  protected stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  /**
   * 获取心跳间隔（动态调整）
   * 
   * 优化项 2.2：按任务类型动态调整心跳间隔
   * - main: 30s（长时间运行，降低频率）
   * - sub: 15s（中等时间）
   * - exec: 5s（短时间，高频监控）
   * - embedded: 2s（嵌入式，需要快速响应）
   */
  protected getHeartbeatInterval(): number {
    switch (this.state.type) {
      case 'main': return 30_000;     // 30秒
      case 'sub': return 15_000;      // 15秒
      case 'exec': return 5_000;      // 5秒
      case 'embedded': return 2_000;  // 2秒
      default: return 10_000;
    }
  }
  
  /**
   * 销毁任务（释放所有资源）
   * 
   * 优化项 5.3：资源管理，确保所有资源都能正确释放
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.stopHeartbeat();
    this.abortController.abort();
    this.logger.debug?.(`[Task] Destroyed: ${this.state.id}`);
  }
}

export default Task;
