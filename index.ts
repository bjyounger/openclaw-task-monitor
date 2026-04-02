/**
 * Task Monitor Plugin - V2 架构重写
 * 
 * 功能：
 * 1. 监控子任务生命周期
 * 2. 自动重试机制
 * 3. 任务链追踪
 * 4. 主任务监控
 * 5. Exec 进程监控
 * 6. 失败实时上报
 * 
 * 架构：
 * - V2 核心架构（lib/v2/）
 * - 模块化 Handler（handlers/）
 * - 观察者模式
 */

import * as path from 'path';
import AsyncLock from 'async-lock';

// V1 管理器（兼容层）
import {
  StateManager,
  AlertManager,
  TaskChainManager,
  loadConfig,
  ActivityTracker,
  getActivityTracker,
  InterruptHandler,
  getInterruptHandler,
  HealthChecker,
  getHealthChecker,
  MemoryManager,
  TimerManager,
  getTimerManager,
  resetTimerManager,
  DEFAULT_TICK_STRATEGY,
  type TaskState,
  type TaskMonitorConfig,
  type SessionType,
  type MemoryConfig,
} from './lib';

// V2 架构
import { initializeTaskSystem, type ITaskSystem } from './lib/v2/plugin-integration';

// Handlers
import { SubagentSpawnedHandler } from './handlers/subagent-spawned.handler';
import { SubagentEndedHandler } from './handlers/subagent-ended.handler';
import { ExecHandler } from './handlers/exec.handler';
import { TranscriptHandler } from './handlers/transcript.handler';
import { AgentEventHandler } from './handlers/agent-event.handler';
import type { IHandlerContext } from './handlers/interfaces';

// ==================== 类型定义 ====================

interface SubagentSpawnedPayload {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: 'run' | 'session';
  runId: string;
  taskDescription?: string;
  parentTaskId?: string;
}

interface SubagentEndedPayload {
  targetSessionKey: string;
  outcome: 'ok' | 'error' | 'timeout' | 'killed';
  runId?: string;
  endedAt?: number;
  error?: string;
}

// ==================== 辅助函数 ====================

/**
 * 判断是否是子任务会话 key
 */
function isSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(':subagent:');
}

/**
 * 解析子任务深度
 */
function getSubagentDepth(sessionKey: string): number {
  if (!sessionKey) return 0;
  const parts = sessionKey.split(':subagent:');
  return parts.length - 1;
}

/**
 * 从会话 key 提取频道信息
 */
function getSessionChannelInfo(sessionKey: string): { channel: string; target: string } | null {
  const parts = sessionKey.split(':');
  if (parts.length < 5) return null;
  
  const channel = parts[2];
  const target = parts.slice(4).join(':');
  
  return { channel, target };
}

/**
 * 发送通知（通过 AlertManager）
 */
async function sendNotification(
  alertManager: AlertManager,
  alertType: string,
  message: string,
  config: TaskMonitorConfig,
  channel?: string | null,
  target?: string | null
): Promise<void> {
  if (!alertManager) return;
  
  const finalChannel = channel || config.notification.channel;
  const finalTarget = target || config.notification.target;
  
  try {
    await alertManager.sendAlertToTarget(alertType, message, alertType, finalChannel, finalTarget);
  } catch (e) {
  }
}

// ==================== 插件定义 ====================

const plugin = {
  id: 'task-monitor',
  name: 'Task Monitor',
  description: '监控子任务生命周期、自动重试、任务链追踪、主任务监控、exec进程监控、失败实时上报（V2 架构）',
  configSchema: {},

  register(api: any) {
    const logger = api.logger;
    logger.info?.('[task-monitor] Plugin registering (V2 architecture)...');

    // ==================== 加载配置 ====================
    const config = loadConfig();
    const STATE_DIR = config.storage.stateDir;

    // ==================== 初始化 V1 管理器 ====================
    const stateManager = new StateManager(STATE_DIR);
    const alertManager = new AlertManager(
      {
        channel: config.notification.channel,
        target: config.notification.target,
      },
      path.join(STATE_DIR, 'alert-records.json')
    );
    const taskChainManager = new TaskChainManager(STATE_DIR);

    // 初始化消息队列

    // 初始化活跃追踪器
    const activityConfig = config.activityDetection || {};
    const toolTimeoutsConfig = config.toolTimeouts?.timeouts || {};
    const activityTracker = getActivityTracker(activityConfig, toolTimeoutsConfig);
    activityTracker.initialize(api);

    // 初始化中断处理器
    const interruptConfig = {
      enabled: config.alertDeduplication?.enabled ?? true,
      alertCooldownPeriod: config.alertDeduplication?.cooldownPeriod ?? 300000,
      autoRetryEnabled: config.retry.maxRetries > 0,
      maxRetries: config.retry.maxRetries,
      backoffMultiplier: config.retry.backoffMultiplier,
      initialDelay: config.retry.initialDelay,
    };
    const interruptHandler = getInterruptHandler(interruptConfig);
    interruptHandler.initialize(api, stateManager, alertManager);

    // 初始化健康检查器
    const healthConfig = config.healthCheck || {};
    const healthChecker = getHealthChecker(healthConfig);
    healthChecker.initialize(api, alertManager, activityTracker);

    // 初始化 Memory Manager
    const workspaceDir = api.config?.workspaceDir || '/root/.openclaw/workspace';
    const memoryConfig: MemoryConfig = {
      enableAutoConsolidation: config.memory?.enableAutoConsolidation ?? true,
      enablePeriodicRefinement: config.memory?.enablePeriodicRefinement ?? true,
      consolidationPath: config.memory?.consolidationPath || path.join(workspaceDir, 'memory'),
      knowledgeBasePath: config.memory?.knowledgeBasePath || path.join(workspaceDir, 'memory/knowledge-base'),
      refinementSchedule: { dayOfWeek: 0, hour: 22, minute: 0 },
      accessThreshold: 5,
    };
    const memoryManager = new MemoryManager(memoryConfig, stateManager, api);
    memoryManager.startPeriodicRefinement();

    // ==================== 初始化 V2 架构 ====================
    const taskSystem: ITaskSystem = initializeTaskSystem({
      stateManager,
      alertManager,
      logger,
      enableStateObserver: true,
      enableAlertObserver: true,
      enableRetryObserver: true,
    });

    logger.info?.('[task-monitor] V2 Task system initialized');

    // ==================== 初始化 Timer Manager ====================
    resetTimerManager();
    const timerManager = getTimerManager();

    timerManager.registerTimer({
      name: 'checkTimeouts',
      tickInterval: 1,
      callback: async () => {
        // 超时检查逻辑
      },
    });

    timerManager.registerTimer({
      name: 'checkDueRetries',
      tickInterval: 2,
      callback: async () => {
        const dueRetries = await stateManager.getDueScheduledRetries(10);
        for (const retry of dueRetries) {
          taskSystem.eventEmitter.emit({
            type: 'task_retry_executed',
            taskId: retry.runId,
            timestamp: Date.now(),
            data: { scheduledTime: retry.scheduledTime },
          });
        }
      },
    });

    timerManager.start();

    // ==================== 注册 Handlers ====================

    // SubagentSpawned Handler
    const subagentSpawnedHandler = new SubagentSpawnedHandler(
      taskSystem,
      stateManager,
      config,
      taskChainManager
    );
    subagentSpawnedHandler.register(api);

    // SubagentEnded Handler
    const sendNotificationFn = async (
      alertType: string,
      message: string,
      config: any,
      channel?: string,
      target?: string
    ) => {
      await sendNotification(alertManager, alertType, message, config, channel, target);
    };
    
    const subagentEndedHandler = new SubagentEndedHandler(
      taskSystem,
      stateManager,
      config,
      sendNotificationFn,
      taskChainManager
    );
    subagentEndedHandler.register(api);

    // ==================== 共享 Context 和 Lock ====================
    const mapLock = new AsyncLock();
    const taskChannelMap = new Map<string, { channel: string; target: string }>();

    // 创建共享的 handler context
    const handlerContext: IHandlerContext = {
      stateManager,
      alertManager,
      taskChainManager,
      config,
      mapLock,
      taskChannelMap,
      logger,
    };

    // Exec Handler（替换原有的直接实现）
    const execHandler = new ExecHandler(handlerContext);
    execHandler.register(api);

    // Transcript Handler（主任务心跳更新）
    const transcriptHandler = new TranscriptHandler(handlerContext);
    transcriptHandler.register(api);

    // Agent Event Handler（lifecycle 事件处理）
    const agentEventHandler = new AgentEventHandler(handlerContext);
    agentEventHandler.register(api);

    // ==================== Turn 事件处理（主任务监控） ====================
    api.on('turn_started', async (event: any) => {
      const sessionKey = event.sessionKey;
      if (!sessionKey || isSubagentSessionKey(sessionKey)) return;

      logger.info?.(`[task-monitor] Main task started: ${sessionKey}`);

      const channelInfo = getSessionChannelInfo(sessionKey);
      if (stateManager) {
        await stateManager.registerTask({
          id: sessionKey,
          type: 'main',
          status: 'running',
          timeoutMs: config.monitoring.mainTaskTimeout,
          parentTaskId: null,
          maxRetries: 0,
          sessionKey,
          channel: channelInfo?.channel,
          target: channelInfo?.target,
          metadata: { depth: getSubagentDepth(sessionKey) },
        });
      }
    });

    api.on('turn_ended', async (event: any) => {
      const sessionKey = event.sessionKey;
      if (!sessionKey || isSubagentSessionKey(sessionKey)) return;

      logger.info?.(`[task-monitor] Main task ended: ${sessionKey}`);

      if (stateManager) {
        await stateManager.updateTask(sessionKey, { status: 'completed' });
      }
    });

    // ==================== 清理定时器 ====================
    const cleanup = async () => {
      timerManager.stop();
      interruptHandler.shutdown();
      await memoryManager.destroy();
      logger.info?.('[task-monitor] Cleanup complete');
    };

    process.on('SIGTERM', () => { cleanup(); });
    process.on('SIGINT', () => { cleanup(); });
    process.on('uncaughtException', (error) => {
      logger.error?.('[task-monitor] Uncaught exception:', error);
      cleanup();
    });
    process.on('unhandledRejection', (reason) => {
      logger.error?.('[task-monitor] Unhandled rejection:', reason);
      cleanup();
    });

    logger.info?.('[task-monitor] Plugin registration complete (V2 architecture)');
  },
};

export default plugin;
