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
import * as fs from 'fs';
import { execSync } from 'child_process';
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

// Token Budget Checker
import {
  TokenBudgetChecker,
  createTokenBudgetChecker,
  type TokenBudgetConfig,
} from './lib/token-budget-checker';

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
    // 捕获上下文变量用于 checkTimeouts 回调
    const _logger = logger;
    const _config = config;
    const _workspaceDir = workspaceDir;

    // ==================== 初始化 Token Budget Checker ====================
    const tokenBudgetChecker = createTokenBudgetChecker(
      config.tokenBudget || {},
      alertManager,
      logger
    );
    
    // 注册手动检查工具
    api.registerTool({
      name: 'check_token_budget',
      description: '检查 workspace 核心配置文件的 token 预算',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const result = tokenBudgetChecker.check();
        return {
          ok: true,
          data: result,
          message: result.hasIssues
            ? `⚠️ 预算超限:\n${result.issues.join('\n')}`
            : `✅ 所有文件在预算内 (${result.total.actual}t / 5000t)`,
        };
      },
    });

    resetTimerManager();
    const timerManager = getTimerManager();

    // 定时器健康指标
    let lastTimeoutCheck = 0;

    timerManager.registerTimer({
      name: 'checkTimeouts',
      tickInterval: 1,
      callback: async () => {
        _logger.debug?.('[checkTimeouts] Running timeout check...');
        
        let checkedCount = 0;
        let timeoutCount = 0;
        
        try {
          const TASKS_DIR = path.join(_workspaceDir, 'memory', 'tasks');
          const runningDir = path.join(TASKS_DIR, 'running');
          
          // 边界条件：检查目录是否存在
          if (!fs.existsSync(runningDir)) {
            _logger.debug?.('[checkTimeouts] running directory does not exist, skipping');
            lastTimeoutCheck = Date.now();
            return;
          }
          
          const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith('.md'));
          
          const mainTaskTimeout = _config.monitoring?.mainTaskTimeout || 3600000; // 默认 1 小时
          const stalledThreshold = _config.monitoring?.stalledRunningThreshold || 600000; // 默认 10 分钟
          
          for (const file of taskFiles) {
            try {
              const filePath = path.join(runningDir, file);
              const content = fs.readFileSync(filePath, 'utf-8');
              
              // 解析任务状态
              const statusMatch = content.match(/\*\*状态\*\*:\s*(\w+)/);
              const status = statusMatch ? statusMatch[1] : 'unknown';
              
              // 只检查 running 状态的任务
              if (status !== 'running') {
                continue;
              }
              
              // 解析创建时间
              const createdTimeMatch = content.match(/\*\*创建时间\*\*:\s*(.+)/);
              if (!createdTimeMatch) {
                _logger.warn?.(`[checkTimeouts] Task file missing created time: ${file}`);
                continue;
              }
              
              const createdTime = new Date(createdTimeMatch[1]).getTime();
              
              // 边界条件：校验日期解析结果
              if (isNaN(createdTime)) {
                _logger.warn?.(`[checkTimeouts] Invalid created time format in ${file}`);
                continue;
              }
              
              const elapsed = Date.now() - createdTime;
              
              // 检查是否超时
              const isTimeout = elapsed > mainTaskTimeout;
              const isStalled = elapsed > stalledThreshold;
              
              checkedCount++;
              
              if (isTimeout || isStalled) {
                timeoutCount++;
                const sessionKeyMatch = content.match(/\*\*SessionKey\*\*:\s*(\S+)/);
                const channelMatch = content.match(/\*\*频道\*\*:\s*(\S+)/);
                const targetMatch = content.match(/\*\*通知目标\*\*:\s*(\S+)/);
                
                const sessionKey = sessionKeyMatch ? sessionKeyMatch[1] : 'unknown';
                const channel = channelMatch ? channelMatch[1] : _config.notification.channel;
                const target = targetMatch ? targetMatch[1] : _config.notification.target;
                
                const timeoutType = isTimeout ? '任务超时' : '任务停滞';
                const threshold = isTimeout ? mainTaskTimeout : stalledThreshold;
                const elapsedMinutes = Math.floor(elapsed / 60000);
                const thresholdMinutes = Math.floor(threshold / 60000);
                
                const timeoutMessage = `⚠️ ${timeoutType}检测\n\n任务文件: ${file}\nSessionKey: ${sessionKey}\n运行时间: ${elapsedMinutes} 分钟\n超时阈值: ${thresholdMinutes} 分钟`;
                
                // 发送通知
                try {
                  execSync(
                    `openclaw message send --channel "${channel}" --target "${target}" --message "${timeoutMessage}"`,
                    { timeout: 15000, stdio: 'pipe' }
                  );
                  _logger.info?.(`[checkTimeouts] ✅ Timeout notification sent: ${file}`);
                } catch (e) {
                  _logger.error?.(`[checkTimeouts] Failed to send notification: ${e}`);
                }
                
                // 更新任务状态为 timeout
                let updatedContent = content.replace('**状态**: running', '**状态**: timeout');
                
                // 添加超时日志
                const timeoutTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                const timeoutLog = `- ${timeoutTime} ⚠️ 任务超时检测（运行 ${elapsedMinutes} 分钟）\n`;
                
                if (updatedContent.includes('## 执行日志')) {
                  updatedContent = updatedContent.replace('## 执行日志\n', `## 执行日志\n${timeoutLog}`);
                } else {
                  updatedContent += `\n## 执行日志\n${timeoutLog}`;
                }
                
                fs.writeFileSync(filePath, updatedContent, 'utf-8');
                _logger.info?.(`[checkTimeouts] ✅ Task status updated to timeout: ${file}`);
              }
            } catch (fileError) {
              _logger.error?.(`[checkTimeouts] Error processing file ${file}: ${fileError}`);
            }
          }
          
          lastTimeoutCheck = Date.now();
          _logger.info?.(`[checkTimeouts] Checked ${checkedCount} tasks, found ${timeoutCount} timeouts`);
        } catch (error) {
          _logger.error?.(`[checkTimeouts] Error in timeout check: ${error}`);
          lastTimeoutCheck = Date.now();
        }
      },
    });

    // Token Budget 定时检查（每 24 小时）
    timerManager.registerTimer({
      name: 'checkTokenBudget',
      tickInterval: 1440, // 每 1440 ticks (24 小时)
      callback: async () => {
        _logger.debug?.('[checkTokenBudget] Running token budget check...');
        try {
          tokenBudgetChecker.periodicCheck();
        } catch (error) {
          _logger.error?.(`[checkTokenBudget] Error: ${error}`);
        }
      },
    });

    // 定时器健康检查
    timerManager.registerTimer({
      name: 'timerHealthCheck',
      tickInterval: 60,
      callback: async () => {
        const now = Date.now();
        const elapsed = now - lastTimeoutCheck;
        
        if (lastTimeoutCheck === 0) {
          _logger.debug?.('[timerHealthCheck] checkTimeouts not yet run, skipping health check');
          return;
        }
        
        if (elapsed > 120000) {
          _logger.error?.(`[timerHealthCheck] 🚨 checkTimeouts stalled for ${Math.floor(elapsed / 1000)} seconds!`);
          
          // 发送告警
          try {
            execSync(
              `openclaw message send --channel "${_config.notification.channel}" --target "${_config.notification.target}" --message "🚨 定时器停滞告警\n\ncheckTimeouts 已停滞 ${Math.floor(elapsed / 1000)} 秒\n上次检查时间: ${new Date(lastTimeoutCheck).toISOString()}\n请检查 task-monitor 插件状态"`,
              { timeout: 15000, stdio: 'pipe' }
            );
            _logger.info?.('[timerHealthCheck] Alert sent');
          } catch (e) {
            _logger.error?.(`[timerHealthCheck] Failed to send alert: ${e}`);
          }
        } else {
          _logger.debug?.(`[timerHealthCheck] Timer healthy, last check ${Math.floor(elapsed / 1000)}s ago`);
        }
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

    // 定时清理过期任务（每 24 小时）
    timerManager.registerTimer({
      name: 'cleanupStaleTasks',
      tickInterval: 1440, // 每 1440 ticks (24 小时，tick 单位为分钟)
      callback: async () => {
        _logger.debug?.('[cleanupStaleTasks] Running stale task cleanup...');
        try {
          const result = await stateManager.cleanupStaleTasks();
          if (result.removedCompleted > 0 || result.removedFailed > 0 || result.markedStale > 0) {
            _logger.info?.(
              `[cleanupStaleTasks] Cleanup result: removed ${result.removedCompleted} completed, ${result.removedFailed} failed, marked ${result.markedStale} stale. Total: ${result.totalBefore} → ${result.totalAfter}`
            );
          } else {
            _logger.debug?.('[cleanupStaleTasks] No stale tasks to clean up');
          }
        } catch (error) {
          _logger.error?.(`[cleanupStaleTasks] Error: ${error}`);
        }
      },
    });

    timerManager.start();

    // 启动时执行一次清理
    stateManager.cleanupStaleTasks().then(result => {
      if (result.removedCompleted > 0 || result.removedFailed > 0 || result.markedStale > 0) {
        logger.info?.(
          `[task-monitor] Initial cleanup: removed ${result.removedCompleted} completed, ${result.removedFailed} failed, marked ${result.markedStale} stale. Total: ${result.totalBefore} → ${result.totalAfter}`
        );
      } else {
        logger.debug?.('[task-monitor] Initial cleanup: no stale tasks found');
      }
    }).catch(error => {
      logger.error?.(`[task-monitor] Initial cleanup error: ${error}`);
    });

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

    // ==================== Session 事件处理（主任务监控） ====================
    api.on('session_start', async (event: any, ctx: any) => {
      const sessionKey = event.sessionKey || ctx?.sessionKey;
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

    api.on('session_end', async (event: any, ctx: any) => {
      const sessionKey = event.sessionKey || ctx?.sessionKey;
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
