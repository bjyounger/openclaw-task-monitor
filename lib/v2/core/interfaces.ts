import type {
  TaskType,
  TaskStatus,
  TaskEventType,
  TaskPriority,
  ErrorType,
  ITaskEvent,
  IRetryRecord,
  INotificationRecord,
  ITaskDependency,
  ITaskMetrics,
} from './types';

// ==================== 日志器接口 ====================

/**
 * 日志器接口
 * 
 * 优化项 5.1：类型安全，消除 any
 */
export interface ILogger {
  debug?: (message: string, data?: Record<string, unknown>) => void;
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn?: (message: string, data?: Record<string, unknown>) => void;
  error?: (message: string, data?: Record<string, unknown>) => void;
}

// ==================== 任务状态接口 ====================

/**
 * 任务状态接口
 */
export interface ITaskState {
  /** 任务唯一标识 */
  id: string;
  /** 任务类型 */
  type: TaskType;
  /** 任务状态 */
  status: TaskStatus;
  /** 任务优先级 */
  priority: TaskPriority;
  /** 创建时间 */
  createdAt: number;
  /** 开始时间 */
  startTime: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** 完成时间 */
  completedAt?: number;
  /** 超时时间 (毫秒) */
  timeoutMs: number;
  /** 父任务ID */
  parentTaskId: string | null;
  /** 当前重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 最后一次重试时间 */
  lastRetryTime?: number;
  /** 重试历史记录 */
  retryHistory: IRetryRecord[];
  /** 任务标签 */
  label?: string;
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 通知历史 */
  notificationHistory?: INotificationRecord[];
  /** 任务依赖 */
  dependencies?: ITaskDependency[];
  /** 等待依赖完成的任务列表 */
  waitingFor?: string[];
}

/**
 * 任务配置接口
 */
export interface ITaskConfig {
  /** 任务唯一标识 */
  id: string;
  /** 任务类型 */
  type: TaskType;
  /** 任务优先级 */
  priority?: TaskPriority;
  /** 超时时间 (毫秒) */
  timeoutMs?: number;
  /** 父任务ID */
  parentTaskId?: string | null;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 任务标签 */
  label?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 任务依赖 */
  dependencies?: ITaskDependency[];
}

// ==================== 依赖注入接口 ====================

/**
 * 任务依赖注入接口
 * 
 * 优化项 1.1：实例级依赖注入，提高测试性和可维护性
 */
export interface ITaskDependencies {
  /** 事件发射器 */
  eventEmitter: ITaskEventEmitter;
  /** 重试策略 */
  retryStrategy: IRetryStrategy;
  /** 通知策略 */
  notificationStrategy: INotificationStrategy;
  /** 日志器 */
  logger: ILogger;
  /** 指标收集器（可选） */
  metricsCollector?: IMetricsCollector;
}

// ==================== 任务接口 ====================

/**
 * 任务接口
 */
export interface ITask {
  /** 获取任务 ID */
  getId(): string;
  
  /** 获取任务类型 */
  getType(): TaskType;
  
  /** 获取当前状态 */
  getStatus(): TaskStatus;
  
  /** 获取完整状态快照 */
  getState(): Readonly<ITaskState>;
  
  /** 启动任务 */
  start(signal?: AbortSignal): Promise<void>;
  
  /** 完成任务 */
  complete(result?: unknown): Promise<void>;
  
  /** 任务失败 */
  fail(error: string, errorType?: ErrorType): Promise<void>;
  
  /** 更新心跳 */
  heartbeat(): Promise<void>;
  
  /** 终止任务 */
  kill(reason?: string): Promise<void>;
  
  /** 取消任务 */
  cancel(): void;
  
  /** 检查是否超时 */
  isTimedOut(): boolean;
  
  /** 检查是否可以重试 */
  canRetry(errorType?: ErrorType): boolean;
  
  /** 执行重试 */
  executeRetry(): Promise<void>;
  
  /** 添加事件监听器 */
  addEventListener(listener: ITaskObserver): void;
  
  /** 移除事件监听器 */
  removeEventListener(listener: ITaskObserver): void;
  
  /** 销毁任务 */
  destroy(): void;
}

/**
 * 任务构造器接口
 */
export interface ITaskConstructor {
  new (config: ITaskConfig, dependencies: ITaskDependencies): ITask;
}

// ==================== 观察者接口 ====================

/**
 * 任务观察者接口
 */
export interface ITaskObserver {
  /** 观察者名称 */
  readonly name: string;
  
  /** 处理任务事件 */
  onTaskEvent(event: ITaskEvent): Promise<void>;
}

/**
 * 状态观察者接口
 */
export interface IStateObserver extends ITaskObserver {
  /** 持久化任务状态 */
  persistState(taskId: string, state: ITaskState): Promise<void>;
  
  /** 加载任务状态 */
  loadState(taskId: string): Promise<ITaskState | null>;
}

/**
 * 告警观察者接口
 */
export interface IAlertObserver extends ITaskObserver {
  /** 发送告警 */
  sendAlert(taskId: string, message: string, type: string, channel?: string, target?: string): Promise<boolean>;
}

/**
 * 重试观察者接口
 */
export interface IRetryObserver extends ITaskObserver {
  /** 安排重试 */
  scheduleRetry(taskId: string, delayMs: number): Promise<void>;
  
  /** 取消重试 */
  cancelRetry(taskId: string): Promise<void>;
  
  /** 获取到期的重试任务 */
  getDueRetries(limit: number): Promise<string[]>;
}

/**
 * 超时观察者接口
 */
export interface ITimerObserver extends ITaskObserver {
  /** 检查超时任务 */
  checkTimeouts(): Promise<void>;
}

// ==================== 管理器接口 ====================

/**
 * 状态管理器接口
 */
export interface IStateManager {
  /** 注册任务 */
  registerTask(task: Partial<ITaskState> & { id: string; type: TaskType }): Promise<ITaskState>;
  
  /** 获取任务 */
  getTask(taskId: string): Promise<ITaskState | null>;
  
  /** 更新任务 */
  updateTask(taskId: string, updates: Partial<ITaskState>): Promise<void>;
  
  /** 删除任务 */
  deleteTask(taskId: string): Promise<void>;
  
  /** 更新心跳 */
  heartbeat(taskId: string): Promise<boolean>;
  
  /** 获取所有超时任务 */
  getTimedOutTasks(): Promise<ITaskState[]>;
  
  /** 获取所有活跃任务 */
  getActiveTasks(): Promise<ITaskState[]>;
}

/**
 * 告警管理器接口
 */
export interface IAlertManager {
  /** 发送告警 */
  sendAlert(taskId: string, message: string, type: string, channel?: string, target?: string): Promise<boolean>;
  
  /** 检查是否应该发送 */
  shouldAlert(taskId: string, type: string): boolean;
  
  /** 记录告警 */
  recordAlert(taskId: string, type: string): void;
}

/**
 * 重试管理器接口
 */
export interface IRetryManager {
  /** 安排重试 */
  scheduleRetry(taskId: string, delayMs: number): Promise<void>;
  
  /** 取消重试 */
  cancelRetry(taskId: string): Promise<void>;
  
  /** 获取到期的重试 */
  getDueRetries(limit: number): Promise<string[]>;
  
  /** 标记重试执行 */
  markRetryExecuted(taskId: string): Promise<void>;
}

/**
 * 定时器管理器接口
 */
export interface ITimerManager {
  /** 注册定时器 */
  registerTimer(name: string, callback: () => Promise<void>, interval: number): void;
  
  /** 注销定时器 */
  unregisterTimer(name: string): void;
  
  /** 启动 */
  start(): void;
  
  /** 停止 */
  stop(): void;
  
  /** 获取状态 */
  getStatus(): {
    isStopped: boolean;
    isExecuting: boolean;
    timerCount: number;
  };
}

// ==================== 策略接口 ====================

/**
 * 重试策略接口
 */
export interface IRetryStrategy {
  /** 名称 */
  readonly name: string;
  
  /** 计算重试延迟 */
  calculateDelay(retryCount: number, errorType?: ErrorType): number;
  
  /** 判断是否应该重试 */
  shouldRetry(retryCount: number, maxRetries: number, errorType?: ErrorType): boolean;
  
  /** 分类错误类型 */
  classifyError(error: string): ErrorType;
}

/**
 * 通知策略接口
 */
export interface INotificationStrategy {
  /** 名称 */
  readonly name: string;
  
  /** 判断是否应该发送通知 */
  shouldNotify(event: ITaskEvent): boolean;
  
  /** 构建通知消息 */
  buildMessage(event: ITaskEvent): string;
  
  /** 获取通知渠道 */
  getChannel(event: ITaskEvent): string | undefined;
  
  /** 获取通知目标 */
  getTarget(event: ITaskEvent): string | undefined;
}

// ==================== 工厂接口 ====================

/**
 * 任务工厂接口
 */
export interface ITaskFactory {
  /** 创建任务 */
  createTask(config: ITaskConfig, dependencies: ITaskDependencies): ITask;
  
  /** 从状态恢复任务 */
  restoreTask(state: ITaskState, dependencies: ITaskDependencies): ITask | null;
  
  /** 注册任务类型 */
  registerTaskType(type: string, taskClass: ITaskConstructor): void;
}

// ==================== 事件发射器接口 ====================

/**
 * 事件发射器接口
 */
export interface ITaskEventEmitter {
  /** 发射事件 */
  emit(event: ITaskEvent): void;
  
  /** 添加监听器 */
  addListener(observer: ITaskObserver): void;
  
  /** 移除监听器 */
  removeListener(observer: ITaskObserver): void;
  
  /** 获取所有监听器 */
  getListeners(): ITaskObserver[];
}

// ==================== 模板接口 ====================

/**
 * 任务模板接口
 */
export interface ITaskTemplate {
  /** 模板名称 */
  name: string;
  
  /** 模板描述 */
  description: string;
  
  /** 创建任务配置 */
  createConfig(overrides?: Partial<ITaskConfig>): ITaskConfig;
}

/**
 * 任务模板管理器接口
 */
export interface ITaskTemplateManager {
  /** 注册模板 */
  registerTemplate(template: ITaskTemplate): void;
  
  /** 获取模板 */
  getTemplate(name: string): ITaskTemplate | undefined;
  
  /** 从模板创建任务 */
  createFromTemplate(templateName: string, factory: ITaskFactory, dependencies: ITaskDependencies, overrides?: Partial<ITaskConfig>): ITask;
}

// ==================== 依赖管理接口 ====================

/**
 * 任务依赖管理器接口
 * 
 * 优化项 4.2：任务依赖关系管理
 */
export interface ITaskDependencyManager {
  /** 添加依赖关系 */
  addDependency(taskId: string, dependency: ITaskDependency): void;
  
  /** 移除依赖关系 */
  removeDependency(taskId: string, dependsOnTaskId: string): void;
  
  /** 获取任务的所有依赖 */
  getDependencies(taskId: string): ITaskDependency[];
  
  /** 获取依赖此任务的所有任务 */
  getDependents(taskId: string): string[];
  
  /** 检查依赖是否已满足 */
  areDependenciesMet(taskId: string, completedTasks: Set<string>): boolean;
  
  /** 获取所有依赖已完成的任务（可执行） */
  getReadyTasks(completedTasks: Set<string>): string[];
  
  /** 检测循环依赖 */
  hasCircularDependency(taskId: string): boolean;
  
  /** 获取依赖图拓扑排序 */
  getTopologicalOrder(): string[];
}

// ==================== 指标收集接口 ====================

/**
 * 指标收集器接口
 * 
 * 优化项 6：可观测性增强
 */
export interface IMetricsCollector {
  /** 记录任务创建 */
  recordTaskCreated(type: TaskType, priority: TaskPriority): void;
  
  /** 记录任务完成 */
  recordTaskCompleted(type: TaskType, priority: TaskPriority, duration: number): void;
  
  /** 记录任务失败 */
  recordTaskFailed(type: TaskType, priority: TaskPriority, errorType: ErrorType): void;
  
  /** 记录任务超时 */
  recordTaskTimeout(type: TaskType, priority: TaskPriority): void;
  
  /** 记录重试 */
  recordRetry(type: TaskType): void;
  
  /** 更新活跃任务数 */
  updateActiveCount(count: number): void;
  
  /** 获取指标快照 */
  getMetrics(): ITaskMetrics;
  
  /** 重置指标 */
  reset(): void;
}

export type {
  ITaskState as default,
  ILogger,
  ITaskDependencies,
  ITask,
  ITaskObserver,
  IStateManager,
  IAlertManager,
  IRetryStrategy,
  INotificationStrategy,
  ITaskDependencyManager,
  IMetricsCollector,
};
