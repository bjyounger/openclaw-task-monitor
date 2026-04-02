/**
 * SubagentSpawned 事件处理器
 * 
 * 职责：
 * 1. 创建任务记录
 * 2. 注册到 StateManager
 * 3. 处理重试场景（更新现有任务）
 */

import type { IHandler, SubagentSpawnedPayload } from './interfaces';
import type { OpenClawPluginApi } from './interfaces';
import type { ITaskSystem } from '../lib/v2/plugin-integration';
import type { StateManager } from '../lib/state-manager';

/**
 * 判断是否是主任务会话 key
 */
function isMainTaskSession(sessionKey: string): boolean {
  // 主任务格式: agent:main:<channel>:...
  // 子任务格式: agent:main:subagent:...
  return sessionKey.startsWith('agent:main:') && !sessionKey.includes(':subagent:');
}

/**
 * 从会话 key 提取频道信息
 */
function getSessionChannelInfo(sessionKey: string): { channel: string; target: string } | null {
  // 格式: agent:main:<channel>:<type>:<target>
  // 例如: agent:main:telegram:direct:8665573247
  //       agent:main:wecom:direct:yangke
  
  const parts = sessionKey.split(':');
  
  // 至少需要: agent, main, channel, type, target
  if (parts.length < 5) return null;
  
  const channel = parts[2]; // telegram, wecom, etc.
  const type = parts[3];    // direct, group, etc.
  const target = parts.slice(4).join(':'); // 支持包含冒号的 target
  
  return { channel, target };
}

/**
 * SubagentSpawned 处理器
 */
export class SubagentSpawnedHandler implements IHandler {
  public readonly name = 'SubagentSpawnedHandler';

  private taskSystem: ITaskSystem;
  private stateManager: StateManager;
  private config: any;
  private taskChainManager: any;

  constructor(
    taskSystem: ITaskSystem,
    stateManager: StateManager,
    config: any,
    taskChainManager?: any
  ) {
    this.taskSystem = taskSystem;
    this.stateManager = stateManager;
    this.config = config;
    this.taskChainManager = taskChainManager;
  }

  public register(api: OpenClawPluginApi): void {
    api.on('subagent_spawned', async (event: any) => {
      try {
        const data = event as SubagentSpawnedPayload;
        api.logger.info?.(`[task-monitor] Subagent spawned: ${data.runId} - ${data.label}`);

        const runId = data.runId;
        if (!runId || !this.stateManager) return;

        // 判断是否是主任务派发
        const isMainTask = data.parentTaskId ? true : isMainTaskSession(data.childSessionKey);

        // 检查任务是否已存在（重试场景）
        const existingTask = await this.stateManager.getTask(runId);
        if (existingTask) {
          // 更新现有任务状态
          await this.stateManager.updateTask(runId, { status: 'running' });
          api.logger.info?.(`[task-monitor] Task re-activated for retry: ${runId}`);
          return;
        }

        // 获取频道信息
        let channelInfo: { channel: string; target: string } | null = null;
        
        if (isMainTask) {
          // 主任务派发，直接从 childSessionKey 获取
          channelInfo = getSessionChannelInfo(data.childSessionKey);
        } else {
          // 子任务派发，从父会话获取
          const parts = data.childSessionKey.split(':subagent:');
          if (parts.length >= 2) {
            const parentSessionKey = parts[0];
            channelInfo = getSessionChannelInfo(parentSessionKey);
          }
        }

        // 注册新任务到状态管理器
        const task = await this.stateManager.registerTask({
          id: runId,
          type: 'sub',
          status: 'running',
          timeoutMs: this.config.monitoring.subtaskTimeout,
          parentTaskId: null,
          maxRetries: this.config.retry?.maxRetries || 2,
          // v4: 保存会话和频道信息
          sessionKey: data.childSessionKey,
          channel: channelInfo?.channel,
          target: channelInfo?.target,
          // v5: 提升到顶级字段
          label: data.label,
          agentId: data.agentId,
          mode: data.mode as 'run' | 'session' | undefined,
          metadata: {
            taskDescription: data.taskDescription || data.label,
            isMainTask,
          },
        });

        api.logger.info?.(`[task-monitor] Task registered: ${task.id}`);

        // 发射任务创建事件（V2）
        this.taskSystem.eventEmitter.emit({
          type: 'task_created',
          taskId: runId,
          timestamp: Date.now(),
          data: {
            taskType: 'sub',
            label: data.label,
            sessionKey: data.childSessionKey,
            channel: channelInfo?.channel,
            target: channelInfo?.target,
            metadata: task.metadata,
          },
        });

      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in subagent_spawned hook: ${e}`);
      }
    });
  }
}

export default SubagentSpawnedHandler;
