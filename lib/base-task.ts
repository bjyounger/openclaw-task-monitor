// base-task.ts
// Task 基类设计方案 - 提供统一的任务管理抽象

import AsyncLock from "async-lock";
import type { StateManager, TaskState, TaskType, TaskStatus } from "./state-manager";

// ==================== 接口定义 ====================

/**
 * 任务配置接口
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
  /** 任务元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 重试配置接口
 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟 (毫秒) */
  initialDelay: number;
  /** 退避乘数 */
  backoffMultiplier: number;
  /** 最大延迟 (毫秒) */
  maxDelay: number;
}

/**
 * 通知配置接口
 */
export interface NotificationConfig {
  /** 是否启用通知 */
  enabled: boolean;
  /** 通知渠道 (wecom, telegram 等) */
  channel?: string;
  /** 通知目标 */
  target?: string;
  /** 通知事件列表 */
  events: NotificationEvent[];
}

/**
 * 通知事件类型
 */
export type NotificationEvent =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_timeout"
  | "retry_scheduled"
  | "retry_executed"
  | "retry_exhausted";

/**
 * 任务执行结果
 */
export interface TaskResult {
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行时长 (毫秒) */
  duration: number;
}

/**
 * 任务状态快照
 */
export interface TaskSnapshot {
  id: string;
  type: TaskType;
  status: TaskStatus;
  startTime: number;
  elapsed: number;
  retryCount: number;
  lastHeartbeat: number;
  metadata: Record<string, unknown>;
}

// ==================== 默认配置 ====================

/**
 * 默认重试配置
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  initialDelay: 30_000, // 30 秒
  backoffMultiplier: 2,
  maxDelay: 300_000, // 5 分钟
};

/**
 * 默认通知配置
 */
export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  events: ["task_failed", "task_timeout", "retry_exhausted"],
};

// ==================== 抽象基类 ====================

/**
 * 任务抽象基类
 * 提供任务管理的通用属性和方法
 * 
 * @example
 * ```typescript
 * class MyTask extends BaseTask {
 *   async start(): Promise<void> {
 *     // 实现启动逻辑
 *   }
 *   
 *   async complete(result: TaskResult): Promise<void> {
 *     // 实现完成逻辑
 *   }
 *   
 *   async fail(error: Error): Promise<void> {
 *     // 实现失败逻辑
 *   }
 * }
 * ```
 */
export abstract class BaseTask {
  // ==================== 核心属性 ====================
  
  /** 任务 ID */
  public readonly id: string;
  
  /** 任务类型 */
  public readonly type: TaskType;
  
  /** 任务状态 */
  protected _status: TaskStatus = "pending";
  
  /** 超时时间 (毫秒) */
  public readonly timeoutMs: number;
  
  /** 父任务 ID */
  public readonly parentTaskId: string | null;
  
  /** 任务元数据 */
  protected _metadata: Record<string, unknown>;
  
  /** 开始时间 */
  protected _startTime: number = 0;
  
  /** 最后心跳时间 */
  protected _lastHeartbeat: number = 0;

  // ==================== 重试相关 ====================
  
  /** 重试配置 */
  protected readonly retryConfig: RetryConfig;
  
  /** 当前重试次数 */
  protected _retryCount: number = 0;
  
  /** 最后一次重试时间 */
  protected _lastRetryTime: number = 0;
  
  /** 重试历史记录 */
  protected _retryHistory: Array<{
    attemptNumber: number;
    timestamp: number;
    outcome: "ok" | "error" | "timeout";
    reason?: string;
    duration: number;
  }> = [];

  // ==================== 通知相关 ====================
  
  /** 通知配置 */
  protected readonly notificationConfig: NotificationConfig;

  // ==================== 依赖注入 ====================
  
  /** 状态管理器实例 */
  protected readonly stateManager?: StateManager;
  
  /** 并发锁 */
  protected static readonly lock = new AsyncLock();

  // ==================== 构造函数 ====================

  /**
   * 创建任务实例
   * @param config 任务配置
   * @param stateManager 状态管理器实例 (可选)
   * @param retryConfig 重试配置 (可选)
   * @param notificationConfig 通知配置 (可选)
   */
  constructor(
    config: TaskConfig,
    stateManager?: StateManager,
    retryConfig?: Partial<RetryConfig>,
    notificationConfig?: Partial<NotificationConfig>
  ) {
    this.id = config.id;
    this.type = config.type;
    this.timeoutMs = config.timeoutMs;
    this.parentTaskId = config.parentTaskId ?? null;
    this._metadata = config.metadata ?? {};
    
    this.stateManager = stateManager;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    this.notificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG, ...notificationConfig };
  }

  // ==================== 抽象方法 ====================

  /**
   * 启动任务
   * 子类必须实现此方法
   */
  abstract start(): Promise<void>;

  /**
   * 完成任务
   * 子类必须实现此方法
   * @param result 任务结果
   */
  abstract complete(result: TaskResult): Promise<void>;

  /**
   * 任务失败
   * 子类必须实现此方法
   * @param error 错误对象
   */
  abstract fail(error: Error): Promise<void>;

  // ==================== 具体方法 ====================

  /**
   * 获取当前状态
   */
  public get status(): TaskStatus {
    return this._status;
  }

  /**
   * 获取当前重试次数
   */
  public get retryCount(): number {
    return this._retryCount;
  }

  /**
   * 获取任务元数据
   */
  public get metadata(): Record<string, unknown> {
    return { ...this._metadata };
  }

  /**
   * 获取开始时间
   */
  public get startTime(): number {
    return this._startTime;
  }

  /**
   * 更新心跳
   * 用于表明任务仍在活跃执行
   * 
   * @returns 是否更新成功
   */
  public async heartbeat(): Promise<boolean> {
    return BaseTask.lock.acquire(`heartbeat:${this.id}`, async () => {
      const now = Date.now();
      this._lastHeartbeat = now;

      // 如果有状态管理器，同步更新
      if (this.stateManager) {
        return this.stateManager.heartbeat(this.id);
      }

      return true;
    });
  }

  /**
   * 检查是否应该重试
   * @param reason 失败原因
   * @returns 是否应该重试
   */
  public async shouldRetry(reason?: string): Promise<boolean> {
    return BaseTask.lock.acquire(`retry:${this.id}`, async () => {
      // 检查状态
      if (this._status !== "failed" && this._status !== "timeout") {
        return false;
      }

      // 检查重试次数
      if (this._retryCount >= this.retryConfig.maxRetries) {
        return false;
      }

      // 如果有状态管理器，查询其状态
      if (this.stateManager) {
        return this.stateManager.shouldRetry(this.id);
      }

      return true;
    });
  }

  /**
   * 计算重试延迟
   * 使用指数退避算法
   * 
   * @returns 延迟时间 (毫秒)
   */
  protected calculateRetryDelay(): number {
    const { initialDelay, backoffMultiplier, maxDelay } = this.retryConfig;
    const delay = initialDelay * Math.pow(backoffMultiplier, this._retryCount);
    return Math.min(delay, maxDelay);
  }

  /**
   * 安排重试
   * @returns 调度时间
   */
  public async scheduleRetry(): Promise<number> {
    return BaseTask.lock.acquire(`retry:${this.id}`, async () => {
      if (this._retryCount >= this.retryConfig.maxRetries) {
        throw new Error(`重试次数已达上限: ${this.id}`);
      }

      const delayMs = this.calculateRetryDelay();
      const scheduledTime = Date.now() + delayMs;

      // 更新状态
      this._status = "scheduled";
      this._retryCount++;
      this._lastRetryTime = Date.now();

      // 如果有状态管理器，同步调度
      if (this.stateManager) {
        await this.stateManager.scheduleRetry(this.id, delayMs);
      }

      return scheduledTime;
    });
  }

  /**
   * 发送通知
   * @param event 通知事件类型
   * @param message 通知消息
   */
  public async notify(event: NotificationEvent, message: string): Promise<void> {
    // 检查是否启用通知
    if (!this.notificationConfig.enabled) {
      return;
    }

    // 检查是否订阅该事件
    if (!this.notificationConfig.events.includes(event)) {
      return;
    }

    // 如果有状态管理器，使用其发送通知的能力
    // 否则输出日志
    console.log(`[Task:${this.id}] [${event}] ${message}`);
  }

  /**
   * 保存任务状态
   * 将当前状态持久化到存储
   */
  public async save(): Promise<void> {
    return BaseTask.lock.acquire(`save:${this.id}`, async () => {
      if (!this.stateManager) {
        return;
      }

      // 构建任务状态对象
      const taskState: Partial<TaskState> = {
        status: this._status,
        lastHeartbeat: this._lastHeartbeat,
        retryCount: this._retryCount,
        lastRetryTime: this._lastRetryTime || undefined,
        retryHistory: this._retryHistory,
        metadata: this._metadata,
      };

      // 更新状态
      await this.stateManager.updateTask(this.id, taskState);
    });
  }

  /**
   * 加载任务状态
   * 从存储恢复任务状态
   */
  public async load(): Promise<boolean> {
    if (!this.stateManager) {
      return false;
    }

    return BaseTask.lock.acquire(`load:${this.id}`, async () => {
      const state = await this.stateManager.getTask(this.id);
      
      if (!state) {
        return false;
      }

      // 恢复状态
      this._status = state.status;
      this._startTime = state.startTime;
      this._lastHeartbeat = state.lastHeartbeat;
      this._retryCount = state.retryCount;
      this._lastRetryTime = state.lastRetryTime ?? 0;
      this._retryHistory = state.retryHistory;
      this._metadata = state.metadata;

      return true;
    });
  }

  /**
   * 获取任务快照
   * @returns 任务状态快照
   */
  public getSnapshot(): TaskSnapshot {
    const now = Date.now();
    return {
      id: this.id,
      type: this.type,
      status: this._status,
      startTime: this._startTime,
      elapsed: this._startTime > 0 ? now - this._startTime : 0,
      retryCount: this._retryCount,
      lastHeartbeat: this._lastHeartbeat,
      metadata: { ...this._metadata },
    };
  }

  /**
   * 检查是否超时
   * @returns 是否超时
   */
  public isTimedOut(): boolean {
    if (this._status !== "running" && this._status !== "scheduled") {
      return false;
    }

    const now = Date.now();
    return now - this._lastHeartbeat > this.timeoutMs;
  }

  /**
   * 记录重试结果
   * @param outcome 结果
   * @param reason 原因 (失败时)
   * @param duration 执行时长
   */
  protected async recordRetryOutcome(
    outcome: "ok" | "error" | "timeout",
    reason?: string,
    duration?: number
  ): Promise<void> {
    const record = {
      attemptNumber: this._retryCount,
      timestamp: Date.now(),
      outcome,
      reason,
      duration: duration ?? (Date.now() - this._lastRetryTime),
    };

    this._retryHistory.push(record);

    // 如果有状态管理器，同步记录
    if (this.stateManager) {
      await this.stateManager.recordRetryOutcome(this.id, outcome, reason);
    }
  }

  /**
   * 更新元数据
   * @param key 键名
   * @param value 值
   */
  protected updateMetadata(key: string, value: unknown): void {
    this._metadata[key] = value;
  }

  /**
   * 设置状态
   * @param status 新状态
   */
  protected async setStatus(status: TaskStatus): Promise<void> {
    this._status = status;
    
    if (this.stateManager) {
      await this.stateManager.updateTask(this.id, { status });
    }
  }
}

// ==================== 子类实现 ====================

/**
 * 主任务类
 * 不支持重试，用于追踪主任务状态
 */
export class MainTask extends BaseTask {
  constructor(
    id: string,
    stateManager?: StateManager,
    metadata?: Record<string, unknown>
  ) {
    super({
      id,
      type: "main",
      timeoutMs: 30 * 60 * 1000, // 30 分钟
      metadata,
    }, stateManager, { maxRetries: 0 }); // 主任务不支持重试
  }

  /**
   * 启动主任务
   */
  async start(): Promise<void> {
    this._startTime = Date.now();
    this._lastHeartbeat = Date.now();
    await this.setStatus("running");
    
    await this.notify("task_started", `主任务开始: ${this.id}`);
  }

  /**
   * 完成主任务
   */
  async complete(result: TaskResult): Promise<void> {
    await this.setStatus("completed");
    this.updateMetadata("result", result);
    
    await this.notify("task_completed", `主任务完成: ${this.id}, 耗时: ${result.duration}ms`);
    await this.save();
  }

  /**
   * 主任务失败
   */
  async fail(error: Error): Promise<void> {
    await this.setStatus("failed");
    this.updateMetadata("error", error.message);
    
    await this.notify("task_failed", `主任务失败: ${this.id}, 错误: ${error.message}`);
    await this.save();
  }
}

/**
 * 子任务类
 * 支持重试，用于追踪子任务执行
 */
export class SubTask extends BaseTask {
  constructor(
    id: string,
    parentTaskId: string,
    stateManager?: StateManager,
    retryConfig?: Partial<RetryConfig>,
    metadata?: Record<string, unknown>
  ) {
    super({
      id,
      type: "sub",
      timeoutMs: 10 * 60 * 1000, // 10 分钟
      parentTaskId,
      metadata,
    }, stateManager, retryConfig);
  }

  /**
   * 启动子任务
   */
  async start(): Promise<void> {
    this._startTime = Date.now();
    this._lastHeartbeat = Date.now();
    await this.setStatus("running");
    
    await this.notify("task_started", `子任务开始: ${this.id}`);
  }

  /**
   * 完成子任务
   */
  async complete(result: TaskResult): Promise<void> {
    await this.setStatus("completed");
    this.updateMetadata("result", result);
    
    // 如果是重试成功，记录结果
    if (this._retryCount > 0) {
      await this.recordRetryOutcome("ok", undefined, result.duration);
      await this.notify("retry_executed", `子任务重试成功: ${this.id}, 第 ${this._retryCount} 次重试`);
    }
    
    await this.notify("task_completed", `子任务完成: ${this.id}, 耗时: ${result.duration}ms`);
    await this.save();
  }

  /**
   * 子任务失败
   */
  async fail(error: Error): Promise<void> {
    const outcome = error.message.toLowerCase().includes("timeout") ? "timeout" : "error";
    
    // 记录失败
    if (this._retryCount > 0) {
      await this.recordRetryOutcome(outcome, error.message);
    }
    
    // 检查是否应该重试
    const shouldRetry = await this.shouldRetry(error.message);
    
    if (shouldRetry) {
      const scheduledTime = await this.scheduleRetry();
      await this.notify(
        "retry_scheduled",
        `子任务失败，已安排重试: ${this.id}, 第 ${this._retryCount} 次重试, 计划时间: ${new Date(scheduledTime).toLocaleString()}`
      );
    } else {
      await this.setStatus("failed");
      this.updateMetadata("error", error.message);
      
      await this.notify("retry_exhausted", `子任务最终失败: ${this.id}, 重试耗尽`);
      await this.save();
    }
  }
}

/**
 * Exec 进程任务类
 * 用于追踪 Bash/Exec 命令执行
 */
export class ExecTask extends BaseTask {
  /** 执行命令 */
  public readonly command: string;

  constructor(
    id: string,
    command: string,
    stateManager?: StateManager,
    metadata?: Record<string, unknown>
  ) {
    super({
      id,
      type: "exec",
      timeoutMs: 5 * 60 * 1000, // 5 分钟
      metadata: { ...metadata, command },
    }, stateManager, { maxRetries: 0 }); // Exec 任务不支持重试
    
    this.command = command;
  }

  /**
   * 启动 Exec 任务
   */
  async start(): Promise<void> {
    this._startTime = Date.now();
    this._lastHeartbeat = Date.now();
    await this.setStatus("running");
    
    await this.notify("task_started", `Exec 任务开始: ${this.id}, 命令: ${this.command.slice(0, 100)}`);
  }

  /**
   * 完成 Exec 任务
   */
  async complete(result: TaskResult): Promise<void> {
    await this.setStatus("completed");
    this.updateMetadata("result", result);
    this.updateMetadata("duration", result.duration);
    
    await this.notify("task_completed", `Exec 任务完成: ${this.id}, 耗时: ${result.duration}ms`);
    await this.save();
  }

  /**
   * Exec 任务失败
   */
  async fail(error: Error): Promise<void> {
    const isTimeout = error.message.toLowerCase().includes("timeout");
    await this.setStatus(isTimeout ? "timeout" : "failed");
    this.updateMetadata("error", error.message);
    
    await this.notify(
      isTimeout ? "task_timeout" : "task_failed",
      `Exec 任务${isTimeout ? "超时" : "失败"}: ${this.id}, 错误: ${error.message}`
    );
    await this.save();
  }
}

/**
 * 嵌入式任务类
 * 用于追踪主任务内部的 LLM 调用
 */
export class EmbeddedTask extends BaseTask {
  constructor(
    id: string,
    parentTaskId: string,
    stateManager?: StateManager,
    metadata?: Record<string, unknown>
  ) {
    super({
      id,
      type: "embedded",
      timeoutMs: 60 * 1000, // 1 分钟
      parentTaskId,
      metadata,
    }, stateManager, { maxRetries: 0 }); // 嵌入式任务不支持重试
  }

  /**
   * 启动嵌入式任务
   */
  async start(): Promise<void> {
    this._startTime = Date.now();
    this._lastHeartbeat = Date.now();
    await this.setStatus("running");
    
    // 嵌入式任务通常不需要通知
  }

  /**
   * 完成嵌入式任务
   */
  async complete(result: TaskResult): Promise<void> {
    await this.setStatus("completed");
    this.updateMetadata("result", result);
    await this.save();
  }

  /**
   * 嵌入式任务失败
   */
  async fail(error: Error): Promise<void> {
    const isTimeout = error.message.toLowerCase().includes("timeout");
    await this.setStatus(isTimeout ? "timeout" : "failed");
    this.updateMetadata("error", error.message);
    
    await this.notify(
      isTimeout ? "task_timeout" : "task_failed",
      `嵌入式任务${isTimeout ? "超时" : "失败"}: ${this.id}`
    );
    await this.save();
  }
}

// ==================== 工厂类 ====================

/**
 * 任务工厂类
 * 用于创建不同类型的任务实例
 */
export class TaskFactory {
  private readonly stateManager?: StateManager;
  private readonly defaultRetryConfig?: Partial<RetryConfig>;
  private readonly defaultNotificationConfig?: Partial<NotificationConfig>;

  constructor(
    stateManager?: StateManager,
    retryConfig?: Partial<RetryConfig>,
    notificationConfig?: Partial<NotificationConfig>
  ) {
    this.stateManager = stateManager;
    this.defaultRetryConfig = retryConfig;
    this.defaultNotificationConfig = notificationConfig;
  }

  /**
   * 创建主任务
   */
  createMainTask(id: string, metadata?: Record<string, unknown>): MainTask {
    return new MainTask(id, this.stateManager, metadata);
  }

  /**
   * 创建子任务
   */
  createSubTask(
    id: string,
    parentTaskId: string,
    retryConfig?: Partial<RetryConfig>,
    metadata?: Record<string, unknown>
  ): SubTask {
    return new SubTask(
      id,
      parentTaskId,
      this.stateManager,
      { ...this.defaultRetryConfig, ...retryConfig },
      metadata
    );
  }

  /**
   * 创建 Exec 任务
   */
  createExecTask(id: string, command: string, metadata?: Record<string, unknown>): ExecTask {
    return new ExecTask(id, command, this.stateManager, metadata);
  }

  /**
   * 创建嵌入式任务
   */
  createEmbeddedTask(
    id: string,
    parentTaskId: string,
    metadata?: Record<string, unknown>
  ): EmbeddedTask {
    return new EmbeddedTask(id, parentTaskId, this.stateManager, metadata);
  }

  /**
   * 从状态恢复任务
   * 根据任务类型创建对应的任务实例
   */
  async restoreFromState(taskState: TaskState): Promise<BaseTask | null> {
    const { id, type, parentTaskId, metadata, retryCount, lastRetryTime, retryHistory } = taskState;

    let task: BaseTask;

    switch (type) {
      case "main":
        task = this.createMainTask(id, metadata);
        break;
      
      case "sub":
        if (!parentTaskId) {
          console.error(`子任务缺少 parentTaskId: ${id}`);
          return null;
        }
        task = this.createSubTask(id, parentTaskId, undefined, metadata);
        break;
      
      case "exec":
        const command = (metadata?.command as string) || "unknown";
        task = this.createExecTask(id, command, metadata);
        break;
      
      case "embedded":
        if (!parentTaskId) {
          console.error(`嵌入式任务缺少 parentTaskId: ${id}`);
          return null;
        }
        task = this.createEmbeddedTask(id, parentTaskId, metadata);
        break;
      
      default:
        console.error(`未知任务类型: ${type}`);
        return null;
    }

    // 恢复状态
    task["_status"] = taskState.status;
    task["_startTime"] = taskState.startTime;
    task["_lastHeartbeat"] = taskState.lastHeartbeat;
    task["_retryCount"] = retryCount;
    task["_lastRetryTime"] = lastRetryTime ?? 0;
    task["_retryHistory"] = retryHistory;

    return task;
  }

  /**
   * 注册任务到状态管理器
   */
  async registerTask(task: BaseTask): Promise<TaskState | null> {
    if (!this.stateManager) {
      return null;
    }

    return this.stateManager.registerTask({
      id: task.id,
      type: task.type,
      timeoutMs: task.timeoutMs,
      parentTaskId: task.parentTaskId,
      maxRetries: task.retryConfig.maxRetries,
      metadata: task.metadata,
    });
  }
}

// ==================== 导出 ====================

export default BaseTask;
