/**
 * SubagentEnded 事件处理器
 * 
 * 职责：
 * 1. 处理任务完成/失败/超时
 * 2. 重试决策
 * 3. 告警发送
 * 4. 通知父会话
 */

import type { IHandler, SubagentEndedPayload } from './interfaces';
import type { OpenClawPluginApi } from './interfaces';
import type { ITaskSystem } from '../lib/v2/plugin-integration';
import type { StateManager, TaskState } from '../lib';

// sendNotification 函数类型
export type SendNotificationFn = (
  alertType: string,
  message: string,
  config: any,
  channel?: string,
  target?: string
) => Promise<void>;

/**
 * SubagentEnded 处理器
 */
export class SubagentEndedHandler implements IHandler {
  public readonly name = 'SubagentEndedHandler';

  private taskSystem: ITaskSystem;
  private stateManager: StateManager;
  private config: any;
  private taskChainManager: any;
  private sendNotificationFn: SendNotificationFn;

  constructor(
    taskSystem: ITaskSystem,
    stateManager: StateManager,
    config: any,
    sendNotificationFn: SendNotificationFn,
    taskChainManager?: any
  ) {
    this.taskSystem = taskSystem;
    this.stateManager = stateManager;
    this.config = config;
    this.sendNotificationFn = sendNotificationFn;
    this.taskChainManager = taskChainManager;
  }

  public register(api: OpenClawPluginApi): void {
    api.on('subagent_ended', async (event: any) => {
      try {
        const data = event as SubagentEndedPayload;
        api.logger.info?.(
          `[task-monitor] Subagent ended: ${data.runId} - outcome: ${data.outcome}`
        );

        const runId = data.runId;
        if (!runId || !this.stateManager) return;

        // 更新任务链中的子任务状态
        if (this.taskChainManager) {
          const chain = await this.taskChainManager.findChainBySubtaskRunId(runId);
          if (chain) {
            const status = data.outcome === 'ok' ? 'completed' :
                          data.outcome === 'timeout' ? 'timeout' : 'failed';
            await this.taskChainManager.updateSubtask(chain.mainTaskId, runId, {
              status,
              endedAt: data.endedAt || Date.now(),
            });
            api.logger.info?.(
              `[task-monitor] Subtask status updated in chain ${chain.mainTaskId}: ${runId} -> ${status}`
            );
          }
        }

        // 获取任务信息
        const task = await this.stateManager.getTask(runId);
        if (!task) {
          api.logger.warn?.(`[task-monitor] Task not found: ${runId}`);
          return;
        }

        const label = (task.metadata?.label as string) || runId;
        const isKilled = data.outcome === 'killed';
        
        // 从任务对象获取频道信息
        const taskChannel = task.channel ?? undefined;
        const taskTarget = task.target ?? undefined;

        // === 情况 1: 成功完成 ===
        if (data.outcome === 'ok') {
          await this.handleSuccess(api, runId, task, label, taskChannel, taskTarget, data);
          return;
        }

        // === 情况 2: 用户终止 (不可重试) ===
        if (isKilled) {
          await this.handleKilled(runId, label, taskChannel, taskTarget);
          return;
        }

        // === 情况 3: 失败或超时 (可重试) ===
        await this.handleFailure(api, runId, task, label, taskChannel, taskTarget, data);

      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in subagent_ended hook: ${e}`);
      }
    });
  }

  /**
   * 处理成功完成
   */
  private async handleSuccess(
    api: OpenClawPluginApi,
    runId: string,
    task: TaskState,
    label: string,
    channel?: string,
    target?: string,
    data?: SubagentEndedPayload
  ): Promise<void> {
    await this.stateManager.updateTask(runId, { status: 'completed' });
    await this.stateManager.recordRetryOutcome(runId, 'ok');
    
    await this.sendNotificationFn(
      'task_completed',
      `✅ 子任务完成\n\n任务: ${label}\n重试次数: ${task.retryCount}`,
      this.config,
      channel,
      target
    );

    // 发射完成事件（V2）
    this.taskSystem.eventEmitter.emit({
      type: 'task_completed',
      taskId: runId,
      timestamp: Date.now(),
      data: {
        taskType: 'sub',
        label,
        retryCount: task.retryCount,
      },
    });

    // 通知父会话
    if (data?.targetSessionKey) {
      try {
        await api.runtime.system.enqueueSystemEvent(
          `[Task Monitor] Subagent ${runId} completed successfully`,
          { sessionKey: data.targetSessionKey }
        );
        await api.runtime.system.requestHeartbeatNow({});
      } catch (e) {
        api.logger.error?.(`[task-monitor] Failed to notify parent: ${e}`);
      }
    }
  }

  /**
   * 处理用户终止
   */
  private async handleKilled(
    runId: string,
    label: string,
    channel?: string,
    target?: string
  ): Promise<void> {
    await this.stateManager.updateTask(runId, { status: 'killed' });
    await this.stateManager.cancelScheduledRetry(runId);
    
    await this.sendNotificationFn(
      'task_killed',
      `🛑 子任务已终止\n\n任务: ${label}`,
      this.config,
      channel,
      target
    );

    // 发射终止事件（V2）
    this.taskSystem.eventEmitter.emit({
      type: 'task_killed',
      taskId: runId,
      timestamp: Date.now(),
      data: {
        taskType: 'sub',
        label,
      },
    });
  }

  /**
   * 处理失败/超时
   */
  private async handleFailure(
    api: OpenClawPluginApi,
    runId: string,
    task: TaskState,
    label: string,
    channel?: string,
    target?: string,
    data?: SubagentEndedPayload
  ): Promise<void> {
    const outcome = data?.outcome as 'error' | 'timeout';
    const status = outcome === 'timeout' ? 'timeout' : 'failed';
    
    await this.stateManager.updateTask(runId, { status });
    await this.stateManager.recordRetryOutcome(runId, outcome, data?.error);

    // 实时上报失败
    const failureMessage = data?.error || outcome;
    await this.sendNotificationFn(
      outcome === 'timeout' ? 'subtask_timeout_realtime' : 'subtask_failed_realtime',
      `🚨 子任务${outcome === 'timeout' ? '超时' : '失败'} (实时告警)\n\n` +
      `任务: ${label}\n` +
      `原因: ${failureMessage.slice(0, 200)}`,
      this.config,
      channel,
      target
    );
    
    api.logger.warn?.(
      `[task-monitor] Subagent failed (real-time report): ${runId}, outcome: ${outcome}`
    );

    // 发射失败事件（V2）
    this.taskSystem.eventEmitter.emit({
      type: 'task_failed',
      taskId: runId,
      timestamp: Date.now(),
      data: {
        taskType: 'sub',
        label,
        error: data?.error,
        errorType: outcome,
      },
    });

    // 检查是否应该重试
    const shouldRetry = await this.stateManager.shouldRetry(runId);

    if (shouldRetry) {
      await this.handleRetry(runId, task, label, channel, target, outcome);
    } else {
      await this.handleAbandon(runId, task, label, channel, target, data?.error, outcome);
    }

    // 通知父会话
    if (data?.targetSessionKey) {
      try {
        await api.runtime.system.enqueueSystemEvent(
          `[Task Monitor] Subagent ${runId} ended with outcome: ${data.outcome}, retry: ${shouldRetry}`,
          { sessionKey: data.targetSessionKey }
        );
        await api.runtime.system.requestHeartbeatNow({});
      } catch (e) {
        api.logger.error?.(`[task-monitor] Failed to notify parent: ${e}`);
      }
    }
  }

  /**
   * 处理重试
   */
  private async handleRetry(
    runId: string,
    task: TaskState,
    label: string,
    channel?: string,
    target?: string,
    outcome?: 'error' | 'timeout'
  ): Promise<void> {
    const schedule = await this.stateManager.scheduleRetry(runId);
    
    this.taskSystem.eventEmitter.emit({
      type: 'task_retry_scheduled',
      taskId: runId,
      timestamp: Date.now(),
      data: {
        taskType: 'sub',
        label,
        retryCount: task.retryCount + 1,
        scheduledTime: schedule.scheduledTime,
        errorType: outcome,
      },
    });
    
    await this.sendNotificationFn(
      'retry_scheduled',
      `⚠️ 子任务${outcome === 'timeout' ? '超时' : '失败'}，已安排重试\n\n` +
      `任务: ${label}\n` +
      `重试次数: ${task.retryCount + 1}/${task.maxRetries}\n` +
      `预计执行: ${new Date(schedule.scheduledTime).toLocaleString('zh-CN')}`,
      this.config,
      channel,
      target
    );
  }

  /**
   * 处理放弃任务
   */
  private async handleAbandon(
    runId: string,
    task: TaskState,
    label: string,
    channel?: string,
    target?: string,
    error?: string,
    outcome?: 'error' | 'timeout'
  ): Promise<void> {
    await this.stateManager.abandonTask(runId);
    
    this.taskSystem.eventEmitter.emit({
      type: 'task_abandoned',
      taskId: runId,
      timestamp: Date.now(),
      data: {
        taskType: 'sub',
        label,
        reason: error || outcome,
      },
    });
    
    await this.sendNotificationFn(
      'task_failed',
      `❌ 子任务最终失败\n\n` +
      `任务: ${label}\n` +
      `重试次数: ${task.retryCount}/${task.maxRetries}\n` +
      `原因: ${error || outcome}`,
      this.config,
      channel,
      target
    );
  }
}

export default SubagentEndedHandler;
