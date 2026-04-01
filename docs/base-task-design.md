# BaseTask 基类设计方案

## 概述

为 task-monitor 插件设计统一的任务基类，整合生命周期管理、心跳、重试、通知等通用逻辑，并通过抽象方法提供子类扩展点。

---

## 1. 接口定义

```typescript
// ==================== 核心类型 ====================

/**
 * 任务类型
 */
export type TaskType = 'main' | 'sub' | 'exec' | 'embedded';

/**
 * 任务状态
 */
export type TaskStatus = 
  | 'pending'    // 等待执行
  | 'running'    // 执行中
  | 'completed'  // 已完成
  | 'failed'     // 失败
  | 'timeout'    // 超时
  | 'scheduled'  // 已安排重试
  | 'abandoned'  // 放弃（重试耗尽）
  | 'killed';    // 用户终止

/**
 * 重试记录
 */
export interface RetryRecord {
  /** 第几次尝试 (1, 2, 3) */
  attemptNumber: number;
  /** 尝试时间戳 */
  timestamp: number;
  /** 结果 */
  outcome: 'error' | 'timeout' | 'ok';
  /** 失败原因 */
  reason?: string;
  /** 执行时长 (毫秒) */
  duration: number;
}

// ==================== 配置接口 ====================

/**
 * 任务基础配置
 */
export interface TaskConfig {
  /** 任务唯一标识 */
  id: string;
  /** 任务类型 */
  type: TaskType;
  /** 超时时间 (毫秒) */
  timeoutMs: number;
  /** 父任务ID */
  parentTaskId?: string | null;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 任务标签 */
  label?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 通知配置
 */
export interface NotificationConfig {
  /** 是否启用通知 */
  enabled: boolean;
  /** 通知渠道 */
  channel?: string;
  /** 通知目标 */
  target?: string;
  /** 节流间隔 (毫秒) */
  throttle?: number;
  /** 最大消息长度 */
  maxMessageLength?: number;
  /** 通知事件配置 */
  events?: {
    onStart?: boolean;
    onComplete?: boolean;
    onFailed?: boolean;
    onRetry?: boolean;
    onTimeout?: boolean;
  };
}

/**
 * 重试配置
 */
export interface RetryConfig {
  /** 是否启用重试 */
  enabled: boolean;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟 (毫秒) */
  initialDelay: number;
  /** 退避系数 */
  backoffMultiplier: number;
  /** 最大延迟 (毫秒) */
  maxDelay: number;
}

/**
 * 心跳配置
 */
export interface HeartbeatConfig {
  /** 是否启用心跳 */
  enabled: boolean;
  /** 心跳间隔 (毫秒) */
  interval: number;
  /** 心跳超时阈值 (毫秒) */
  timeoutThreshold: number;
}

// ==================== 状态接口 ====================

/**
 * 任务状态 (持久化)
 */
export interface TaskState {
  // === 基础属性 ===
  /** 任务唯一标识 */
  id: string;
  /** 任务类型 */
  type: TaskType;
  /** 任务状态 */
  status: TaskStatus;
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
  
  // === 超时相关 ===
  /** 超时时间 (毫秒) */
  timeoutMs: number;
  
  // === 层级关系 ===
  /** 父任务ID */
  parentTaskId: string | null;
  
  // === 重试相关 ===
  /** 当前重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 最后一次重试时间 */
  lastRetryTime?: number;
  /** 重试历史记录 */
  retryHistory: RetryRecord[];
  
  // === 元数据 ===
  /** 任务标签 */
  label?: string;
  /** 扩展元数据 */
  metadata: Record<string, unknown>;
  
  // === 通知相关 ===
  /** 是否已通知 */
  notified?: boolean;
  /** 通知记录 */
  notificationHistory?: Array<{
    type: string;
    timestamp: number;
    channel: string;
    target: string;
  }>;
}
```

---

## 2. 抽象基类

```typescript
import { Mutex } from 'async-mutex';
import { StateManager } from './state-manager';
import { AlertManager } from './alert-manager';
import { TimerManager } from './timer-manager';

/**
 * 任务基类 - 所有任务类型的抽象基类
 * 
 * 职责：
 * 1. 生命周期管理 (start, complete, fail)
 * 2. 心跳管理
 * 3. 重试管理
 * 4. 通知管理
 * 5. 定时器管理
 * 6. 状态持久化
 */
export abstract class BaseTask {
  // ==================== 静态属性 ====================
  
  /** 状态管理器 (全局单例) */
  protected static stateManager: StateManager;
  
  /** 告警管理器 (全局单例) */
  protected static alertManager: AlertManager;
  
  /** 定时器管理器 (全局单例) */
  protected static timerManager: TimerManager;
  
  /** 日志器 */
  protected static logger: any;
  
  /** 默认配置 */
  protected static DEFAULT_CONFIG = {
    notification: {
      enabled: true,
      throttle: 3000,
      maxMessageLength: 200,
      events: {
        onStart: false,
        onComplete: true,
        onFailed: true,
        onRetry: true,
        onTimeout: true,
      },
    },
    retry: {
      enabled: true,
      maxRetries: 2,
      initialDelay: 30000,
      backoffMultiplier: 2,
      maxDelay: 300000,
    },
    heartbeat: {
      enabled: true,
      interval: 10000,
      timeoutThreshold: 60000,
    },
  };
  
  // ==================== 实例属性 ====================
  
  /** 任务状态 */
  protected state: TaskState;
  
  /** 任务配置 */
  protected config: TaskConfig;
  
  /** 通知配置 */
  protected notificationConfig: NotificationConfig;
  
  /** 重试配置 */
  protected retryConfig: RetryConfig;
  
  /** 心跳配置 */
  protected heartbeatConfig: HeartbeatConfig;
  
  /** 状态持久化 Mutex */
  protected stateMutex = new Mutex();
  
  /** 心跳定时器 */
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  
  /** 超时定时器 */
  protected timeoutTimer: NodeJS.Timeout | null = null;
  
  /** 是否已销毁 */
  protected isDestroyed = false;
  
  // ==================== 构造函数 ====================
  
  /**
   * 创建任务实例
   * @param config 任务配置
   * @param state 已有状态（恢复场景）
   */
  constructor(config: TaskConfig, state?: TaskState) {
    this.config = config;
    this.notificationConfig = { 
      ...BaseTask.DEFAULT_CONFIG.notification,
      ...(config.metadata?.notification as Partial<NotificationConfig>),
    };
    this.retryConfig = {
      ...BaseTask.DEFAULT_CONFIG.retry,
      maxRetries: config.maxRetries ?? BaseTask.DEFAULT_CONFIG.retry.maxRetries,
    };
    this.heartbeatConfig = BaseTask.DEFAULT_CONFIG.heartbeat;
    
    // 初始化或恢复状态
    const now = Date.now();
    this.state = state || {
      id: config.id,
      type: config.type,
      status: 'pending',
      createdAt: now,
      startTime: now,
      updatedAt: now,
      lastHeartbeat: now,
      timeoutMs: config.timeoutMs,
      parentTaskId: config.parentTaskId ?? null,
      retryCount: 0,
      maxRetries: this.retryConfig.maxRetries,
      retryHistory: [],
      label: config.label,
      metadata: config.metadata || {},
    };
  }
  
  // ==================== 静态方法 ====================
  
  /**
   * 初始化全局管理器
   */
  public static initialize(
    stateManager: StateManager,
    alertManager: AlertManager,
    timerManager: TimerManager,
    logger: any
  ): void {
    BaseTask.stateManager = stateManager;
    BaseTask.alertManager = alertManager;
    BaseTask.timerManager = timerManager;
    BaseTask.logger = logger;
  }
  
  /**
   * 从持久化状态恢复任务
   */
  public static async restore<T extends BaseTask>(
    taskClass: new (config: TaskConfig, state: TaskState) => T,
    taskId: string
  ): Promise<T | null> {
    const state = await BaseTask.stateManager.getTask(taskId);
    if (!state) return null;
    
    const config: TaskConfig = {
      id: state.id,
      type: state.type,
      timeoutMs: state.timeoutMs,
      parentTaskId: state.parentTaskId,
      maxRetries: state.maxRetries,
      label: state.label,
      metadata: state.metadata,
    };
    
    return new taskClass(config, state);
  }
  
  // ==================== 生命周期方法 ====================
  
  /**
   * 启动任务
   * 子类可重写以添加启动前检查
   */
  public async start(): Promise<void> {
    if (this.state.status !== 'pending') {
      throw new Error(`Cannot start task in status: ${this.state.status}`);
    }
    
    await this.updateState({ 
      status: 'running', 
      startTime: Date.now() 
    });
    
    // 启动心跳
    this.startHeartbeat();
    
    // 启动超时检测
    this.startTimeoutTimer();
    
    // 发送启动通知
    if (this.notificationConfig.events?.onStart) {
      await this.sendNotification('task_started', `🚀 任务开始\n\n任务: ${this.state.label || this.state.id}`);
    }
    
    // 调用子类启动逻辑
    await this.onStart();
    
    BaseTask.logger?.info?.(`[BaseTask] Task started: ${this.state.id}`);
  }
  
  /**
   * 完成任务
   */
  public async complete(result?: unknown): Promise<void> {
    await this.updateState({ 
      status: 'completed',
      completedAt: Date.now(),
      metadata: { ...this.state.metadata, result },
    });
    
    // 停止定时器
    this.stopTimers();
    
    // 记录重试结果
    if (this.state.retryCount > 0) {
      await BaseTask.stateManager.recordRetryOutcome(this.state.id, 'ok');
    }
    
    // 发送完成通知
    if (this.notificationConfig.events?.onComplete) {
      await this.sendNotification(
        'task_completed',
        `✅ 任务完成\n\n任务: ${this.state.label || this.state.id}\n重试次数: ${this.state.retryCount}`
      );
    }
    
    // 调用子类完成逻辑
    await this.onComplete(result);
    
    BaseTask.logger?.info?.(`[BaseTask] Task completed: ${this.state.id}`);
  }
  
  /**
   * 任务失败
   */
  public async fail(error: string, shouldRetry?: boolean): Promise<void> {
    await this.updateState({ 
      status: 'failed',
      metadata: { ...this.state.metadata, error },
    });
    
    // 停止定时器
    this.stopTimers();
    
    // 记录重试结果
    await BaseTask.stateManager.recordRetryOutcome(this.state.id, 'error', error);
    
    // 判断是否应该重试
    const canRetry = shouldRetry ?? (this.retryConfig.enabled && this.state.retryCount < this.state.maxRetries);
    
    if (canRetry) {
      // 安排重试
      await this.scheduleRetry();
    } else {
      // 放弃任务
      await this.abandon(error);
    }
  }
  
  /**
   * 任务超时
   */
  public async timeout(): Promise<void> {
    await this.updateState({ status: 'timeout' });
    
    // 停止定时器
    this.stopTimers();
    
    // 记录重试结果
    await BaseTask.stateManager.recordRetryOutcome(this.state.id, 'timeout');
    
    // 发送超时通知
    if (this.notificationConfig.events?.onTimeout) {
      await this.sendNotification(
        'task_timeout',
        `⏰ 任务超时\n\n任务: ${this.state.label || this.state.id}\n运行时间: ${Math.floor((Date.now() - this.state.startTime) / 60000)} 分钟`
      );
    }
    
    // 判断是否应该重试
    if (this.retryConfig.enabled && this.state.retryCount < this.state.maxRetries) {
      await this.scheduleRetry();
    } else {
      await this.abandon('Timeout and retries exhausted');
    }
    
    // 调用子类超时逻辑
    await this.onTimeout();
  }
  
  /**
   * 终止任务
   */
  public async kill(reason?: string): Promise<void> {
    await this.updateState({ 
      status: 'killed',
      metadata: { ...this.state.metadata, killReason: reason },
    });
    
    // 停止定时器
    this.stopTimers();
    
    // 取消重试调度
    await BaseTask.stateManager.cancelScheduledRetry(this.state.id);
    
    BaseTask.logger?.info?.(`[BaseTask] Task killed: ${this.state.id}`);
  }
  
  /**
   * 放弃任务
   */
  protected async abandon(reason: string): Promise<void> {
    await this.updateState({ status: 'abandoned' });
    
    // 发送放弃通知
    await this.sendNotification(
      'task_abandoned',
      `❌ 任务最终失败\n\n任务: ${this.state.label || this.state.id}\n重试次数: ${this.state.retryCount}/${this.state.maxRetries}\n原因: ${reason}`
    );
    
    // 调用子类放弃逻辑
    await this.onAbandon(reason);
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
   * 子类超时逻辑
   */
  protected abstract onTimeout(): Promise<void>;
  
  /**
   * 子类放弃逻辑
   */
  protected abstract onAbandon(reason: string): Promise<void>;
  
  // ==================== 心跳管理 ====================
  
  /**
   * 启动心跳
   */
  protected startHeartbeat(): void {
    if (!this.heartbeatConfig.enabled) return;
    
    this.heartbeatTimer = setInterval(async () => {
      if (this.isDestroyed) return;
      
      try {
        await this.updateHeartbeat();
      } catch (e) {
        BaseTask.logger?.error?.(`[BaseTask] Heartbeat error: ${e}`);
      }
    }, this.heartbeatConfig.interval);
  }
  
  /**
   * 更新心跳
   */
  protected async updateHeartbeat(): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      this.state.lastHeartbeat = Date.now();
      await BaseTask.stateManager.heartbeat(this.state.id);
    } finally {
      release();
    }
  }
  
  // ==================== 超时管理 ====================
  
  /**
   * 启动超时定时器
   */
  protected startTimeoutTimer(): void {
    if (this.state.timeoutMs <= 0) return;
    
    this.timeoutTimer = setTimeout(async () => {
      if (this.state.status === 'running') {
        await this.timeout();
      }
    }, this.state.timeoutMs);
  }
  
  // ==================== 重试管理 ====================
  
  /**
   * 安排重试
   */
  protected async scheduleRetry(): Promise<void> {
    // 计算延迟（指数退避）
    const delay = this.calculateRetryDelay();
    
    // 调度重试
    const schedule = await BaseTask.stateManager.scheduleRetry(this.state.id, delay);
    
    // 更新状态
    await this.updateState({ status: 'scheduled' });
    
    // 发送重试通知
    if (this.notificationConfig.events?.onRetry) {
      await this.sendNotification(
        'retry_scheduled',
        `⚠️ 任务失败，已安排重试\n\n任务: ${this.state.label || this.state.id}\n重试次数: ${this.state.retryCount + 1}/${this.state.maxRetries}\n预计执行: ${new Date(schedule.scheduledTime).toLocaleString('zh-CN')}`
      );
    }
    
    BaseTask.logger?.info?.(`[BaseTask] Retry scheduled: ${this.state.id}, delay: ${delay}ms`);
  }
  
  /**
   * 计算重试延迟（指数退避）
   */
  protected calculateRetryDelay(): number {
    const { initialDelay, backoffMultiplier, maxDelay } = this.retryConfig;
    const delay = initialDelay * Math.pow(backoffMultiplier, this.state.retryCount);
    return Math.min(delay, maxDelay);
  }
  
  /**
   * 执行重试
   * 子类可重写以自定义重试逻辑
   */
  public async executeRetry(): Promise<void> {
    if (this.state.status !== 'scheduled') {
      throw new Error(`Cannot retry task in status: ${this.state.status}`);
    }
    
    // 标记重试执行
    await BaseTask.stateManager.markRetryExecuted(this.state.id);
    
    // 更新状态
    await this.updateState({ status: 'running' });
    
    // 重启心跳和超时定时器
    this.startHeartbeat();
    this.startTimeoutTimer();
    
    // 调用子类重试逻辑
    await this.onRetry();
    
    BaseTask.logger?.info?.(`[BaseTask] Retry executed: ${this.state.id}`);
  }
  
  /**
   * 子类重试逻辑
   * 默认调用 onStart
   */
  protected async onRetry(): Promise<void> {
    await this.onStart();
  }
  
  // ==================== 通知管理 ====================
  
  /**
   * 发送通知
   */
  protected async sendNotification(type: string, message: string): Promise<void> {
    if (!this.notificationConfig.enabled) return;
    
    const channel = this.notificationConfig.channel || 
                    this.state.metadata?.channel as string;
    const target = this.notificationConfig.target || 
                   this.state.metadata?.target as string;
    
    if (!channel || !target) {
      BaseTask.logger?.warn?.(`[BaseTask] No notification target for task: ${this.state.id}`);
      return;
    }
    
    try {
      const sent = await BaseTask.alertManager.sendAlertToTarget(
        this.state.id,
        message,
        type,
        channel,
        target
      );
      
      if (!sent) {
        BaseTask.logger?.warn?.(`[BaseTask] Notification send returned false: ${type}`);
      }
      
      // 记录通知历史
      const notificationRecord = {
        type,
        timestamp: Date.now(),
        channel,
        target,
      };
      
      await this.updateState({
        notificationHistory: [
          ...(this.state.notificationHistory || []),
          notificationRecord,
        ],
      });
    } catch (e) {
      BaseTask.logger?.error?.(`[BaseTask] Failed to send notification: ${e}`);
    }
  }
  
  // ==================== 状态持久化 ====================
  
  /**
   * 更新状态（带锁保护）
   */
  protected async updateState(updates: Partial<TaskState>): Promise<void> {
    const release = await this.stateMutex.acquire();
    try {
      // 更新内存状态
      this.state = {
        ...this.state,
        ...updates,
        updatedAt: Date.now(),
      };
      
      // 持久化到状态管理器
      await BaseTask.stateManager.updateTask(this.state.id, updates);
    } finally {
      release();
    }
  }
  
  /**
   * 注册任务到状态管理器
   */
  protected async registerTask(): Promise<void> {
    await BaseTask.stateManager.registerTask({
      id: this.state.id,
      type: this.state.type,
      status: this.state.status,
      timeoutMs: this.state.timeoutMs,
      parentTaskId: this.state.parentTaskId,
      maxRetries: this.state.maxRetries,
      metadata: this.state.metadata,
    });
  }
  
  // ==================== 定时器管理 ====================
  
  /**
   * 停止所有定时器
   */
  protected stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
  
  /**
   * 销毁任务
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.stopTimers();
    BaseTask.logger?.debug?.(`[BaseTask] Task destroyed: ${this.state.id}`);
  }
  
  // ==================== 工具方法 ====================
  
  /**
   * 获取任务状态
   */
  public getState(): Readonly<TaskState> {
    return { ...this.state };
  }
  
  /**
   * 获取任务 ID
   */
  public getId(): string {
    return this.state.id;
  }
  
  /**
   * 获取任务类型
   */
  public getType(): TaskType {
    return this.state.type;
  }
  
  /**
   * 获取任务状态
   */
  public getStatus(): TaskStatus {
    return this.state.status;
  }
  
  /**
   * 是否正在运行
   */
  public isRunning(): boolean {
    return this.state.status === 'running';
  }
  
  /**
   * 是否已完成
   */
  public isCompleted(): boolean {
    return this.state.status === 'completed';
  }
  
  /**
   * 是否可以重试
   */
  public canRetry(): boolean {
    return (
      this.retryConfig.enabled &&
      this.state.retryCount < this.state.maxRetries &&
      (this.state.status === 'failed' || this.state.status === 'timeout')
    );
  }
}
```

---

## 3. 具体实现

### 3.1 MainTask (主任务)

```typescript
/**
 * 主任务
 * 
 * 特点：
 * - 不支持重试（maxRetries = 0）
 * - 长超时（默认 2 小时）
 * - 任务链管理
 * - 自动创建任务记录文件
 */
export class MainTask extends BaseTask {
  /** 任务记录文件路径 */
  private taskRecordPath: string | null = null;
  
  /** 子任务列表 */
  private subtasks: Map<string, BaseTask> = new Map();
  
  constructor(config: TaskConfig) {
    super({
      ...config,
      type: 'main',
      timeoutMs: config.timeoutMs || 2 * 60 * 60 * 1000, // 2 小时
      maxRetries: 0, // 主任务不重试
    });
  }
  
  protected async onStart(): Promise<void> {
    // 创建任务记录文件
    await this.createTaskRecord();
    
    // 更新任务频道映射
    const channel = this.state.metadata?.channel as string;
    const target = this.state.metadata?.target as string;
    if (channel && target) {
      // 更新全局 taskChannelMap（需要在插件中实现）
      BaseTask.logger?.info?.(`[MainTask] Channel mapped: ${channel}:${target}`);
    }
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    // 更新任务记录文件状态
    await this.updateTaskRecord('completed');
    
    // 清理所有子任务
    for (const subtask of this.subtasks.values()) {
      subtask.destroy();
    }
    this.subtasks.clear();
  }
  
  protected async onTimeout(): Promise<void> {
    // 主任务超时，发送告警
    await this.sendNotification(
      'main_task_timeout',
      `⏰ 主任务超时\n\n任务: ${this.state.label || this.state.id}\n运行时间: ${Math.floor((Date.now() - this.state.startTime) / 60000)} 分钟`
    );
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    // 主任务不会放弃（不重试），但需要记录异常状态
    BaseTask.logger?.error?.(`[MainTask] Task abandoned: ${this.state.id}, reason: ${reason}`);
  }
  
  /**
   * 创建任务记录文件
   */
  private async createTaskRecord(): Promise<void> {
    // 实现文件创建逻辑
    // 参考 index.ts 中的自动创建逻辑
  }
  
  /**
   * 更新任务记录文件
   */
  private async updateTaskRecord(status: string): Promise<void> {
    // 实现文件更新逻辑
  }
  
  /**
   * 添加子任务
   */
  public addSubtask(subtask: BaseTask): void {
    this.subtasks.set(subtask.getId(), subtask);
  }
  
  /**
   * 获取子任务
   */
  public getSubtask(subtaskId: string): BaseTask | undefined {
    return this.subtasks.get(subtaskId);
  }
  
  /**
   * 获取所有子任务
   */
  public getSubtasks(): BaseTask[] {
    return Array.from(this.subtasks.values());
  }
}
```

### 3.2 SubTask (子任务)

```typescript
/**
 * 子任务
 * 
 * 特点：
 * - 支持重试（默认 2 次）
 * - 中等超时（默认 30 分钟）
 * - 反馈流到父会话
 * - 重试调度
 */
export class SubTask extends BaseTask {
  /** 父会话 key */
  private parentSessionKey: string | null = null;
  
  /** 进度报告定时器 */
  private progressTimer: NodeJS.Timeout | null = null;
  
  constructor(config: TaskConfig) {
    super({
      ...config,
      type: 'sub',
      timeoutMs: config.timeoutMs || 30 * 60 * 1000, // 30 分钟
      maxRetries: config.maxRetries ?? 2,
    });
  }
  
  protected async onStart(): Promise<void> {
    // 启动进度报告
    this.startProgressReport();
    
    // 注册到任务链
    // 参考 index.ts 中的 taskChainManager.addSubtask
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    // 停止进度报告
    this.stopProgressReport();
    
    // 通知父会话
    await this.notifyParent(`✅ 子任务完成\n\n任务: ${this.state.label || this.state.id}`);
  }
  
  protected async onTimeout(): Promise<void> {
    // 停止进度报告
    this.stopProgressReport();
    
    // 通知父会话
    await this.notifyParent(`⏰ 子任务超时\n\n任务: ${this.state.label || this.state.id}`);
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    // 停止进度报告
    this.stopProgressReport();
    
    // 通知父会话
    await this.notifyParent(`❌ 子任务最终失败\n\n任务: ${this.state.label || this.state.id}\n原因: ${reason}`);
  }
  
  protected async onRetry(): Promise<void> {
    // 子任务重试需要重新 spawn
    const agentId = this.state.metadata?.agentId as string;
    const taskDescription = this.state.metadata?.taskDescription as string;
    
    if (!agentId || !taskDescription) {
      throw new Error('Missing agentId or taskDescription for retry');
    }
    
    // 执行重试 spawn
    // 参考 index.ts 中的 executeRetrySafely
  }
  
  /**
   * 启动进度报告
   */
  private startProgressReport(): void {
    const reportInterval = 5 * 60 * 1000; // 5 分钟
    
    this.progressTimer = setInterval(async () => {
      const runtime = Math.floor((Date.now() - this.state.startTime) / 60000);
      await this.sendNotification(
        'progress',
        `⏳ 子任务执行中\n\n任务: ${this.state.label || this.state.id}\n运行时间: ${runtime} 分钟`
      );
    }, reportInterval);
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
   * 通知父会话
   */
  private async notifyParent(message: string): Promise<void> {
    if (!this.parentSessionKey) return;
    
    // 通过 API 发送系统事件到父会话
    // 参考 index.ts 中的 enqueueSystemEvent
  }
  
  /**
   * 设置父会话
   */
  public setParentSession(sessionKey: string): void {
    this.parentSessionKey = sessionKey;
  }
}
```

### 3.3 ExecTask (后台进程任务)

```typescript
/**
 * 后台进程任务
 * 
 * 特点：
 * - 短生命周期（默认 5 分钟）
 * - 不支持重试（maxRetries = 0）
 * - 实时失败上报
 * - 追踪 exec 命令
 */
export class ExecTask extends BaseTask {
  /** 命令内容 */
  private command: string;
  
  /** 进程 ID */
  private pid: number | null = null;
  
  constructor(config: TaskConfig & { command: string }) {
    super({
      ...config,
      type: 'exec',
      timeoutMs: config.timeoutMs || 5 * 60 * 1000, // 5 分钟
      maxRetries: 0, // exec 不重试
    });
    
    this.command = config.command;
  }
  
  protected async onStart(): Promise<void> {
    // 记录命令开始
    BaseTask.logger?.info?.(`[ExecTask] Command started: ${this.command.slice(0, 100)}`);
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    const duration = Date.now() - this.state.startTime;
    BaseTask.logger?.info?.(
      `[ExecTask] Command completed: ${this.command.slice(0, 100)}, duration: ${duration}ms`
    );
  }
  
  protected async onTimeout(): Promise<void> {
    // 实时上报超时
    await this.sendNotification(
      'exec_timeout',
      `⚠️ Exec 超时\n\n命令: ${this.command.slice(0, 100)}\n执行时长: ${Math.floor((Date.now() - this.state.startTime) / 1000)}秒`
    );
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    // ExecTask 不重试，直接记录失败
    BaseTask.logger?.error?.(`[ExecTask] Command failed: ${this.command.slice(0, 100)}, reason: ${reason}`);
  }
  
  /**
   * 设置进程 ID
   */
  public setPid(pid: number): void {
    this.pid = pid;
  }
  
  /**
   * 获取命令
   */
  public getCommand(): string {
    return this.command;
  }
}
```

### 3.4 EmbeddedTask (内嵌调用任务)

```typescript
/**
 * 内嵌调用任务
 * 
 * 特点：
 * - 极短生命周期（默认 1 分钟）
 * - 不支持重试
 * - 无通知（静默）
 * - 仅记录状态
 */
export class EmbeddedTask extends BaseTask {
  constructor(config: TaskConfig) {
    super({
      ...config,
      type: 'embedded',
      timeoutMs: config.timeoutMs || 60 * 1000, // 1 分钟
      maxRetries: 0,
    });
    
    // 内嵌任务默认不发送通知
    this.notificationConfig.enabled = false;
  }
  
  protected async onStart(): Promise<void> {
    // 内嵌任务静默启动
    BaseTask.logger?.debug?.(`[EmbeddedTask] Embedded task started: ${this.state.id}`);
  }
  
  protected async onComplete(result?: unknown): Promise<void> {
    // 内嵌任务静默完成
    BaseTask.logger?.debug?.(`[EmbeddedTask] Embedded task completed: ${this.state.id}`);
  }
  
  protected async onTimeout(): Promise<void> {
    // 内嵌任务超时记录
    BaseTask.logger?.warn?.(`[EmbeddedTask] Embedded task timeout: ${this.state.id}`);
  }
  
  protected async onAbandon(reason: string): Promise<void> {
    // 内嵌任务失败记录
    BaseTask.logger?.error?.(`[EmbeddedTask] Embedded task failed: ${this.state.id}, reason: ${reason}`);
  }
}
```

---

## 4. 使用示例

### 4.1 插件初始化

```typescript
// index.ts
import { BaseTask, MainTask, SubTask, ExecTask, EmbeddedTask } from './tasks';

export default {
  register(api: OpenClawPluginApi) {
    // 初始化 BaseTask
    BaseTask.initialize(
      stateManager,
      alertManager,
      timerManager,
      api.logger
    );
    
    // 任务工厂映射
    const taskFactory = {
      main: MainTask,
      sub: SubTask,
      exec: ExecTask,
      embedded: EmbeddedTask,
    };
    
    // 监听事件
    api.on('subagent_spawned', async (event) => {
      const TaskClass = taskFactory[event.type] || SubTask;
      const task = new TaskClass({
        id: event.runId,
        type: event.type,
        timeoutMs: config.monitoring.subtaskTimeout,
        parentTaskId: event.parentRunId,
        metadata: event,
      });
      
      await task.registerTask();
      await task.start();
    });
    
    api.on('subagent_ended', async (event) => {
      const task = await BaseTask.restore(SubTask, event.runId);
      if (!task) return;
      
      if (event.outcome === 'ok') {
        await task.complete();
      } else if (event.outcome === 'timeout') {
        await task.timeout();
      } else if (event.outcome === 'killed') {
        await task.kill(event.reason);
      } else {
        await task.fail(event.error);
      }
    });
  },
};
```

### 4.2 重试调度

```typescript
// 定时器回调
async function retryCheckerCallback(): Promise<void> {
  const dueRetries = await stateManager.getDueScheduledRetries(5);
  
  for (const retry of dueRetries) {
    const task = await BaseTask.restore(SubTask, retry.runId);
    if (!task) continue;
    
    await task.executeRetry();
  }
}
```

---

## 5. 设计优势

### 5.1 统一的生命周期管理

- 所有任务类型共享相同的生命周期流程
- 状态转换有明确约束
- 定时器自动管理

### 5.2 线程安全

- 使用 Mutex 保护状态更新
- 防止并发写入导致的状态不一致
- 与 TimerManager 的 Mutex 机制一致

### 5.3 可扩展性

- 抽象方法定义了清晰的扩展点
- 子类只需关注差异化逻辑
- 配置驱动，易于定制

### 5.4 可恢复性

- 支持从持久化状态恢复
- 状态完整保存，重启后可继续

### 5.5 可测试性

- 依赖注入（StateManager, AlertManager）
- 抽象方法便于 mock
- 状态只读访问

---

## 6. 迁移计划

### Phase 1: 添加 BaseTask（不破坏现有代码）

1. 创建 `lib/tasks/` 目录
2. 实现 BaseTask 和各子类
3. 添加单元测试

### Phase 2: 逐步迁移

1. 新建任务使用 BaseTask
2. 现有任务保持不变
3. 并行运行两套逻辑

### Phase 3: 完全迁移

1. 所有任务使用 BaseTask
2. 移除旧的事件处理代码
3. 清理 redundant 代码

---

## 7. 文件结构

```
lib/
├── tasks/
│   ├── index.ts           # 导出所有任务类
│   ├── base-task.ts       # BaseTask 基类
│   ├── main-task.ts       # MainTask 主任务
│   ├── sub-task.ts        # SubTask 子任务
│   ├── exec-task.ts       # ExecTask 后台进程
│   └── embedded-task.ts   # EmbeddedTask 内嵌调用
├── state-manager.ts       # 状态管理（已有）
├── timer-manager.ts       # 定时器管理（已有）
└── alert-manager.ts       # 告警管理（已有）
```

---

*设计时间: 2026-04-01*
*版本: v1.0*
