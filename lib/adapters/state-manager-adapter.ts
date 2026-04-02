// lib/adapters/state-manager-adapter.ts
/**
 * StateManager 适配器
 * 
 * 封装 V1 StateManager，提供 V2 IStateManager 接口
 * 使 V1 实现可以在 V2 架构中使用
 */

import type { StateManager, TaskState as V1TaskState } from '../state-manager';
import type { IStateManager, ITaskState } from '../v2/core/interfaces';
import type { IRetryRecord, TaskType, TaskStatus } from '../v2/core/types';

/**
 * 将 V1 TaskState 转换为 V2 ITaskState
 */
function convertV1ToV2(v1State: V1TaskState): ITaskState {
  return {
    id: v1State.id,
    type: v1State.type as TaskType,
    status: v1State.status as TaskStatus,
    priority: (v1State.metadata?.priority as ITaskState['priority']) || 'medium',
    createdAt: v1State.startTime,
    startTime: v1State.startTime,
    updatedAt: v1State.lastHeartbeat,
    lastHeartbeat: v1State.lastHeartbeat,
    timeoutMs: v1State.timeoutMs,
    parentTaskId: v1State.parentTaskId,
    retryCount: v1State.retryCount,
    maxRetries: v1State.maxRetries,
    lastRetryTime: v1State.lastRetryTime,
    retryHistory: v1State.retryHistory.map(r => ({
      attemptNumber: r.attemptNumber,
      timestamp: r.timestamp,
      outcome: r.outcome,
      reason: r.reason,
      duration: r.duration,
    })) as IRetryRecord[],
    label: v1State.metadata?.label as string | undefined,
    metadata: v1State.metadata,
    notificationHistory: v1State.metadata?.notificationHistory as ITaskState['notificationHistory'],
    dependencies: v1State.metadata?.dependencies as ITaskState['dependencies'],
  };
}

/**
 * 将 V2 ITaskState 部分字段转换为 V1 更新字段
 */
function convertV2ToV1Updates(v2Updates: Partial<ITaskState>): Partial<V1TaskState> {
  const v1Updates: Partial<V1TaskState> = {};

  if (v2Updates.status !== undefined) {
    v1Updates.status = v2Updates.status as V1TaskState['status'];
  }
  if (v2Updates.timeoutMs !== undefined) {
    v1Updates.timeoutMs = v2Updates.timeoutMs;
  }
  if (v2Updates.retryCount !== undefined) {
    v1Updates.retryCount = v2Updates.retryCount;
  }
  if (v2Updates.maxRetries !== undefined) {
    v1Updates.maxRetries = v2Updates.maxRetries;
  }
  if (v2Updates.lastRetryTime !== undefined) {
    v1Updates.lastRetryTime = v2Updates.lastRetryTime;
  }
  if (v2Updates.retryHistory !== undefined) {
    v1Updates.retryHistory = v2Updates.retryHistory.map(r => ({
      attemptNumber: r.attemptNumber,
      timestamp: r.timestamp,
      outcome: r.outcome,
      reason: r.reason,
      duration: r.duration,
    }));
  }
  if (v2Updates.metadata !== undefined) {
    v1Updates.metadata = v2Updates.metadata;
  }

  return v1Updates;
}

/**
 * StateManager 适配器类
 * 
 * 实现 V2 IStateManager 接口，内部使用 V1 StateManager
 */
export class StateManagerAdapter implements IStateManager {
  constructor(private stateManager: StateManager) {}

  /**
   * 注册任务
   * @param task 任务配置
   */
  async registerTask(task: Partial<ITaskState> & { id: string; type: TaskType }): Promise<ITaskState> {
    const v1Task = {
      id: task.id,
      type: task.type,
      status: task.status || 'pending',
      timeoutMs: task.timeoutMs || 300000,
      parentTaskId: task.parentTaskId || null,
      retryCount: task.retryCount || 0,
      maxRetries: task.maxRetries || 2,
      metadata: task.metadata || {},
      channel: task.metadata?.channel as string | undefined,
      target: task.metadata?.target as string | undefined,
      sessionKey: task.metadata?.sessionKey as string | undefined,
    };

    const result = await this.stateManager.registerTask(v1Task);
    return convertV1ToV2(result);
  }

  /**
   * 获取任务状态
   * @param taskId 任务 ID
   */
  async getTask(taskId: string): Promise<ITaskState | null> {
    const result = await this.stateManager.getTask(taskId);
    return result ? convertV1ToV2(result) : null;
  }

  /**
   * 更新任务状态
   * @param taskId 任务 ID
   * @param updates 要更新的字段
   */
  async updateTask(taskId: string, updates: Partial<ITaskState>): Promise<void> {
    const v1Updates = convertV2ToV1Updates(updates);
    await this.stateManager.updateTask(taskId, v1Updates);
  }

  /**
   * 删除任务
   * @param taskId 任务 ID
   */
  async deleteTask(taskId: string): Promise<void> {
    await this.stateManager.removeTask(taskId);
  }

  /**
   * 更新心跳
   * @param taskId 任务 ID
   */
  async heartbeat(taskId: string): Promise<boolean> {
    return this.stateManager.heartbeat(taskId);
  }

  /**
   * 获取所有超时任务
   */
  async getTimedOutTasks(): Promise<ITaskState[]> {
    const tasks = await this.stateManager.checkTimeouts();
    return tasks.map(convertV1ToV2);
  }

  /**
   * 获取所有活跃任务
   */
  async getActiveTasks(): Promise<ITaskState[]> {
    const allTasks = await this.stateManager.getAllTasks();
    return allTasks
      .filter(t => t.status === 'running' || t.status === 'pending')
      .map(convertV1ToV2);
  }

  // ==================== 扩展方法（适配 V1 特有功能） ====================

  /**
   * 安排重试
   * @param runId 任务 ID
   * @param delayMs 延迟时间
   */
  async scheduleRetry(runId: string, delayMs?: number): Promise<void> {
    await this.stateManager.scheduleRetry(runId, delayMs);
  }

  /**
   * 获取到期重试任务
   * @param maxCount 最大数量
   */
  async getDueScheduledRetries(maxCount: number = 5) {
    return this.stateManager.getDueScheduledRetries(maxCount);
  }

  /**
   * 标记重试已执行
   * @param runId 任务 ID
   */
  async markRetryExecuted(runId: string): Promise<boolean> {
    return this.stateManager.markRetryExecuted(runId);
  }

  /**
   * 检查是否应该重试
   * @param runId 任务 ID
   */
  async shouldRetry(runId: string): Promise<boolean> {
    return this.stateManager.shouldRetry(runId);
  }

  /**
   * 记录重试结果
   * @param runId 任务 ID
   * @param outcome 结果
   * @param reason 原因
   */
  async recordRetryOutcome(
    runId: string,
    outcome: 'ok' | 'error' | 'timeout',
    reason?: string
  ): Promise<void> {
    await this.stateManager.recordRetryOutcome(runId, outcome, reason);
  }

  /**
   * 放弃任务
   * @param runId 任务 ID
   */
  async abandonTask(runId: string): Promise<ITaskState | null> {
    const result = await this.stateManager.abandonTask(runId);
    return result ? convertV1ToV2(result) : null;
  }
}

export default StateManagerAdapter;
