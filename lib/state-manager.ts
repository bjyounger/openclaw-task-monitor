// state-manager.ts

import * as fs from 'fs';
import * as path from 'path';

/**
 * 任务类型
 * - main: 主任务
 * - sub: 子任务（通过 sessions_spawn 创建）
 * - embedded: 嵌入式运行（主任务内部的 LLM 调用）
 * - exec: 后台进程执行（通过 Bash 工具启动的命令）
 */
export type TaskType = 'main' | 'sub' | 'embedded' | 'exec';

/**
 * 任务状态 (v3 扩展版)
 * - scheduled: 已安排重试，等待延迟后执行
 * - abandoned: 放弃（重试耗尽）
 * - killed: 用户终止（不可重试）
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'scheduled' | 'abandoned' | 'killed';

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

/**
 * 任务状态接口 (v3 扩展版)
 */
export interface TaskState {
  /** 任务唯一标识 (runId，整个生命周期不变) */
  id: string;
  /** 任务类型: main 或 sub */
  type: TaskType;
  /** 任务状态 */
  status: TaskStatus;
  /** 任务开始时间 (毫秒时间戳) */
  startTime: number;
  /** 最后心跳时间 (毫秒时间戳) */
  lastHeartbeat: number;
  /** 超时时间 (毫秒) */
  timeoutMs: number;
  /** 父任务ID (子任务时有效) */
  parentTaskId: string | null;

  // === 重试相关字段 (v3 新增) ===
  /** 当前重试次数 (0, 1, 2) */
  retryCount: number;
  /** 最大重试次数，默认 2 */
  maxRetries: number;
  /** 最后一次重试时间 */
  lastRetryTime?: number;
  /** 重试历史记录 */
  retryHistory: RetryRecord[];

  /** 任务元数据 */
  metadata: Record<string, unknown>;
}

/**
 * 调度重试条目
 */
export interface ScheduledRetry {
  /** 任务 ID (runId，不变) */
  runId: string;
  /** 计划执行时间 (毫秒时间戳) */
  scheduledTime: number;
  /** 本次是第几次重试 (1 或 2) */
  retryCount: number;
  /** 调度创建时间 */
  createdAt: number;
  /** 调度状态 */
  status: 'pending' | 'executed' | 'cancelled';
}

/**
 * 重试调度文件结构
 */
export interface RetryScheduleFile {
  tasks: ScheduledRetry[];
  version: string;
  lastUpdated: number;
}

/**
 * 状态文件结构
 */
export interface StateFile {
  tasks: TaskState[];
  version: string;
  lastUpdated: number;
}

/**
 * Watchdog 配置
 */
export interface WatchdogConfig {
  /** 扫描间隔 (毫秒)，默认 10 秒 */
  scanIntervalMs: number;
  /** 锁文件路径 */
  lockFile: string;
  /** 调度文件路径 */
  scheduleFile: string;
  /** 单次扫描最大处理任务数 */
  maxBatchSize: number;
  /** 锁超时时间 (毫秒) */
  lockTimeoutMs: number;
}

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  scanIntervalMs: 10_000,
  lockFile: '.watchdog.lock',
  scheduleFile: 'scheduled-retries.json',
  maxBatchSize: 5,
  lockTimeoutMs: 30_000,
};

/**
 * 状态管理器类
 * 负责管理任务状态的持久化和并发访问
 */
export class StateManager {
  /** 状态文件路径 */
  public readonly filePath: string;
  /** 锁文件路径 */
  public readonly lockPath: string;
  /** 重试调度文件路径 */
  public readonly scheduleFilePath: string;
  /** Watchdog 锁文件路径 */
  public readonly watchdogLockPath: string;
  
  /** 锁超时时间 (毫秒) */
  private static readonly LOCK_TIMEOUT_MS = 5000;
  /** 锁轮询间隔 (毫秒) */
  private static readonly LOCK_POLL_INTERVAL_MS = 50;
  /** 状态文件版本 */
  private static readonly VERSION = '2.0.0';
  /** 默认最大重试次数 */
  public static readonly DEFAULT_MAX_RETRIES = 2;
  /** 重试延迟 (毫秒) */
  public static readonly RETRY_DELAY_MS = 30_000; // 30 秒

  /**
   * 创建状态管理器实例
   * @param basePath 状态文件存储的基础路径
   */
  constructor(basePath: string) {
    this.filePath = path.join(basePath, 'state.json');
    this.lockPath = path.join(basePath, 'state.lock');
    this.scheduleFilePath = path.join(basePath, 'scheduled-retries.json');
    this.watchdogLockPath = path.join(basePath, '.watchdog.lock');
    
    // 确保目录存在
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 初始化状态文件
    if (!fs.existsSync(this.filePath)) {
      this.writeState({ tasks: [], version: StateManager.VERSION, lastUpdated: Date.now() });
    }

    // 初始化调度文件
    if (!fs.existsSync(this.scheduleFilePath)) {
      this.writeSchedule({ tasks: [], version: StateManager.VERSION, lastUpdated: Date.now() });
    }
  }

  /**
   * 原子操作方法
   * 获取锁后执行操作，操作完成后释放锁
   * @param fn 要执行的操作函数
   * @returns 操作函数的返回值
   */
  public async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      const result = await fn();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * 获取文件锁
   * 使用轮询方式等待锁，超时后抛出错误
   */
  private async acquireLock(): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < StateManager.LOCK_TIMEOUT_MS) {
      try {
        // 尝试创建锁文件 (使用 exclusive 标志)
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({
          pid: process.pid,
          timestamp: Date.now()
        }));
        fs.closeSync(fd);
        return;
      } catch (error: any) {
        // 文件已存在，检查是否过期
        if (error.code === 'EEXIST') {
          try {
            const lockContent = fs.readFileSync(this.lockPath, 'utf-8');
            const lockData = JSON.parse(lockContent);
            
            // 如果锁文件过期，删除并重试
            if (Date.now() - lockData.timestamp > StateManager.LOCK_TIMEOUT_MS) {
              fs.unlinkSync(this.lockPath);
              continue;
            }
          } catch {
            // 锁文件损坏或不存在，删除并重试
            try {
              fs.unlinkSync(this.lockPath);
            } catch {
              // 忽略删除失败
            }
          }
          
          // 等待后重试
          await this.sleep(StateManager.LOCK_POLL_INTERVAL_MS);
        } else {
          throw error;
        }
      }
    }
    
    throw new Error(`获取文件锁超时: ${this.lockPath}`);
  }

  /**
   * 释放文件锁
   */
  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch (error) {
      // 忽略释放锁时的错误，锁文件可能已被其他进程清理
    }
  }

  /**
   * 读取状态文件
   * @returns 状态文件内容
   */
  private readState(): StateFile {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const state: StateFile = JSON.parse(content);
      
      // 版本兼容性检查
      if (state.version !== StateManager.VERSION) {
        console.warn(`状态文件版本不匹配: ${state.version} !== ${StateManager.VERSION}`);
      }
      
      return state;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { tasks: [], version: StateManager.VERSION, lastUpdated: Date.now() };
      }
      throw error;
    }
  }

  /**
   * 写入状态文件
   * @param state 要写入的状态
   */
  private writeState(state: StateFile): void {
    state.lastUpdated = Date.now();
    const content = JSON.stringify(state, null, 2);
    
    // 先写入临时文件，再原子替换
    const tempPath = this.filePath + '.tmp';
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }

  /**
   * 更新任务心跳
   * @param taskId 任务ID
   * @returns 是否更新成功
   */
  public async heartbeat(taskId: string): Promise<boolean> {
    return this.withLock(async () => {
      const state = this.readState();
      const taskIndex = state.tasks.findIndex(t => t.id === taskId);
      
      if (taskIndex === -1) {
        return false;
      }
      
      state.tasks[taskIndex].lastHeartbeat = Date.now();
      this.writeState(state);
      return true;
    });
  }

  /**
   * 注册新任务
   * @param task 任务状态 (不需要提供 startTime, lastHeartbeat, retryCount, retryHistory，会自动设置)
   * @returns 注册后的任务状态
   */
  public async registerTask(task: Omit<TaskState, 'startTime' | 'lastHeartbeat' | 'retryCount' | 'retryHistory'>): Promise<TaskState> {
    return this.withLock(async () => {
      const state = this.readState();
      
      // 检查任务是否已存在
      if (state.tasks.some(t => t.id === task.id)) {
        throw new Error(`任务已存在: ${task.id}`);
      }
      
      const now = Date.now();
      const newTask: TaskState = {
        ...task,
        startTime: now,
        lastHeartbeat: now,
        retryCount: task.retryCount ?? 0,
        maxRetries: task.maxRetries ?? StateManager.DEFAULT_MAX_RETRIES,
        retryHistory: task.retryHistory ?? [],
      };
      
      state.tasks.push(newTask);
      this.writeState(state);
      
      return newTask;
    });
  }

  /**
   * 更新任务状态
   * @param taskId 任务ID
   * @param updates 要更新的字段
   * @returns 更新后的任务状态，如果任务不存在则返回 null
   */
  public async updateTask(taskId: string, updates: Partial<Omit<TaskState, 'id' | 'startTime'>>): Promise<TaskState | null> {
    return this.withLock(async () => {
      const state = this.readState();
      const taskIndex = state.tasks.findIndex(t => t.id === taskId);
      
      if (taskIndex === -1) {
        return null;
      }
      
      // 合并更新
      state.tasks[taskIndex] = {
        ...state.tasks[taskIndex],
        ...updates
      };
      
      this.writeState(state);
      return state.tasks[taskIndex];
    });
  }

  /**
   * 获取任务状态
   * @param taskId 任务ID
   * @returns 任务状态，如果不存在则返回 null
   */
  public async getTask(taskId: string): Promise<TaskState | null> {
    return this.withLock(async () => {
      const state = this.readState();
      return state.tasks.find(t => t.id === taskId) || null;
    });
  }

  /**
   * 获取所有任务
   * @returns 所有任务列表
   */
  public async getAllTasks(): Promise<TaskState[]> {
    return this.withLock(async () => {
      const state = this.readState();
      return [...state.tasks];
    });
  }

  /**
   * 删除任务
   * @param taskId 任务ID
   * @returns 是否删除成功
   */
  public async removeTask(taskId: string): Promise<boolean> {
    return this.withLock(async () => {
      const state = this.readState();
      const taskIndex = state.tasks.findIndex(t => t.id === taskId);
      
      if (taskIndex === -1) {
        return false;
      }
      
      state.tasks.splice(taskIndex, 1);
      this.writeState(state);
      return true;
    });
  }

  /**
   * 检查并清理超时任务
   * @returns 超时的任务列表
   */
  public async checkTimeouts(): Promise<TaskState[]> {
    return this.withLock(async () => {
      const state = this.readState();
      const now = Date.now();
      const timedOutTasks: TaskState[] = [];
      
      for (const task of state.tasks) {
        // 检查是否超时 (基于最后心跳时间)
        // 支持 running 和 scheduled 状态的超时检查
        const isActive = task.status === 'running' || task.status === 'scheduled';
        if (now - task.lastHeartbeat > task.timeoutMs && isActive) {
          task.status = 'timeout';
          timedOutTasks.push(task);
        }
      }
      
      if (timedOutTasks.length > 0) {
        this.writeState(state);
      }
      
      return timedOutTasks;
    });
  }

  /**
   * 获取子任务列表
   * @param parentId 父任务ID
   * @returns 子任务列表
   */
  public async getSubTasks(parentId: string): Promise<TaskState[]> {
    return this.withLock(async () => {
      const state = this.readState();
      return state.tasks.filter(t => t.parentTaskId === parentId);
    });
  }

  /**
   * 辅助方法: 睡眠
   * @param ms 睡眠时间 (毫秒)
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== 重试调度方法 (v3 新增) ====================

  /**
   * 读取重试调度文件
   */
  private readSchedule(): RetryScheduleFile {
    try {
      const content = fs.readFileSync(this.scheduleFilePath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { tasks: [], version: StateManager.VERSION, lastUpdated: Date.now() };
      }
      throw error;
    }
  }

  /**
   * 写入重试调度文件
   */
  private writeSchedule(schedule: RetryScheduleFile): void {
    schedule.lastUpdated = Date.now();
    const content = JSON.stringify(schedule, null, 2);
    const tempPath = this.scheduleFilePath + '.tmp';
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, this.scheduleFilePath);
  }

  /**
   * 安排任务重试
   * @param runId 任务 ID
   * @param delayMs 延迟时间 (毫秒)，默认 30 秒
   * @returns 调度后的重试条目
   */
  public async scheduleRetry(runId: string, delayMs: number = StateManager.RETRY_DELAY_MS): Promise<ScheduledRetry> {
    return this.withLock(async () => {
      const state = this.readState();
      const task = state.tasks.find(t => t.id === runId);
      
      if (!task) {
        throw new Error(`任务不存在: ${runId}`);
      }

      // 检查是否还能重试
      if (task.retryCount >= task.maxRetries) {
        throw new Error(`重试次数已达上限: ${runId}`);
      }

      // 更新任务状态为 scheduled
      task.status = 'scheduled';
      task.retryCount += 1;
      task.lastRetryTime = Date.now();
      this.writeState(state);

      // 创建调度条目
      const schedule = this.readSchedule();
      const scheduledRetry: ScheduledRetry = {
        runId,
        scheduledTime: Date.now() + delayMs,
        retryCount: task.retryCount,
        createdAt: Date.now(),
        status: 'pending',
      };

      schedule.tasks.push(scheduledRetry);
      this.writeSchedule(schedule);

      return scheduledRetry;
    });
  }

  /**
   * 获取下一个需要执行的重试任务
   * @returns 到期的重试任务，如果没有则返回 null
   */
  public async getNextScheduledRetry(): Promise<ScheduledRetry | null> {
    return this.withLock(async () => {
      const schedule = this.readSchedule();
      const now = Date.now();

      // 找出最早到期的 pending 任务
      const dueTask = schedule.tasks
        .filter(t => t.status === 'pending' && t.scheduledTime <= now)
        .sort((a, b) => a.scheduledTime - b.scheduledTime)[0];

      return dueTask || null;
    });
  }

  /**
   * 获取所有到期的重试任务
   * @param maxCount 最大返回数量
   * @returns 到期的重试任务列表
   */
  public async getDueScheduledRetries(maxCount: number = 5): Promise<ScheduledRetry[]> {
    return this.withLock(async () => {
      const schedule = this.readSchedule();
      const now = Date.now();

      return schedule.tasks
        .filter(t => t.status === 'pending' && t.scheduledTime <= now)
        .sort((a, b) => a.scheduledTime - b.scheduledTime)
        .slice(0, maxCount);
    });
  }

  /**
   * 标记重试已执行
   * @param runId 任务 ID
   * @returns 是否成功
   */
  public async markRetryExecuted(runId: string): Promise<boolean> {
    return this.withLock(async () => {
      const schedule = this.readSchedule();
      const scheduleIndex = schedule.tasks.findIndex(
        t => t.runId === runId && t.status === 'pending'
      );

      if (scheduleIndex === -1) {
        return false;
      }

      schedule.tasks[scheduleIndex].status = 'executed';
      this.writeSchedule(schedule);

      // 同时更新任务状态
      const state = this.readState();
      const taskIndex = state.tasks.findIndex(t => t.id === runId);
      if (taskIndex !== -1) {
        state.tasks[taskIndex].status = 'running';
        state.tasks[taskIndex].lastHeartbeat = Date.now();
        this.writeState(state);
      }

      return true;
    });
  }

  /**
   * 取消重试调度
   * @param runId 任务 ID
   * @returns 是否成功
   */
  public async cancelScheduledRetry(runId: string): Promise<boolean> {
    return this.withLock(async () => {
      const schedule = this.readSchedule();
      const scheduleIndex = schedule.tasks.findIndex(
        t => t.runId === runId && t.status === 'pending'
      );

      if (scheduleIndex === -1) {
        return false;
      }

      schedule.tasks[scheduleIndex].status = 'cancelled';
      this.writeSchedule(schedule);

      return true;
    });
  }

  /**
   * 记录重试结果
   * @param runId 任务 ID
   * @param outcome 结果
   * @param reason 原因 (失败时)
   */
  public async recordRetryOutcome(
    runId: string,
    outcome: 'ok' | 'error' | 'timeout',
    reason?: string
  ): Promise<void> {
    return this.withLock(async () => {
      const state = this.readState();
      const task = state.tasks.find(t => t.id === runId);

      if (!task) {
        throw new Error(`任务不存在: ${runId}`);
      }

      // 添加重试记录
      task.retryHistory.push({
        attemptNumber: task.retryCount,
        timestamp: Date.now(),
        outcome,
        reason,
        duration: Date.now() - (task.lastRetryTime || task.startTime),
      });

      this.writeState(state);
    });
  }

  /**
   * 检查是否应该重试
   * @param runId 任务 ID
   * @returns 是否应该重试
   */
  public async shouldRetry(runId: string): Promise<boolean> {
    return this.withLock(async () => {
      const state = this.readState();
      const task = state.tasks.find(t => t.id === runId);

      if (!task) {
        return false;
      }

      // 检查状态是否为可重试
      if (task.status !== 'failed' && task.status !== 'timeout') {
        return false;
      }

      // 检查重试次数
      return task.retryCount < task.maxRetries;
    });
  }

  /**
   * 放弃任务 (重试耗尽)
   * @param runId 任务 ID
   * @returns 更新后的任务状态
   */
  public async abandonTask(runId: string): Promise<TaskState | null> {
    return this.withLock(async () => {
      const state = this.readState();
      const taskIndex = state.tasks.findIndex(t => t.id === runId);

      if (taskIndex === -1) {
        return null;
      }

      state.tasks[taskIndex].status = 'abandoned';
      this.writeState(state);

      return state.tasks[taskIndex];
    });
  }

  /**
   * 清理已执行/已取消的调度记录 (超过 24 小时)
   */
  public async cleanupSchedule(): Promise<number> {
    return this.withLock(async () => {
      const schedule = this.readSchedule();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 小时前

      const before = schedule.tasks.length;
      schedule.tasks = schedule.tasks.filter(
        t => t.status === 'pending' || t.createdAt > cutoff
      );
      const removed = before - schedule.tasks.length;

      if (removed > 0) {
        this.writeSchedule(schedule);
      }

      return removed;
    });
  }
}

export default StateManager;
