import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import * as path from "path";
import * as fs from "fs";
import { spawn, exec as execCallback, execSync } from "child_process";
import * as readline from "readline";
import { 
  StateManager, 
  AlertManager, 
  TaskChainManager, 
  loadConfig,
  messageQueue,
  ActivityTracker,
  getActivityTracker,
  InterruptHandler,
  getInterruptHandler,
  HealthChecker,
  getHealthChecker,
  MemoryManager,
  type TaskState, 
  type ScheduledRetry,
  type TaskMonitorConfig,
  type ActivityState,
  type SessionType,
  type MemoryConfig,
} from "./lib";

// ==================== Session Key 辅助函数 ====================

/**
 * 判断是否是子任务会话 key
 */
function isSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":subagent:");
}

/**
 * 解析子任务深度
 */
function getSubagentDepth(sessionKey: string): number {
  if (!sessionKey) return 0;
  const parts = sessionKey.split(":subagent:");
  return parts.length - 1;
}

/**
 * 解析父会话 key
 */
function resolveThreadParentSessionKey(sessionKey: string): string | null {
  if (!sessionKey || !isSubagentSessionKey(sessionKey)) return null;
  const parts = sessionKey.split(":subagent:");
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join(":subagent:");
}

/**
 * 解析 agent 会话 key
 */
function parseAgentSessionKey(sessionKey: string): { agentId: string; rest: string } | null {
  if (!sessionKey) return null;
  // 格式: agent:<agentId>:...
  const match = sessionKey.match(/^agent:([^:]+):(.*)$/);
  if (!match) return null;
  return { agentId: match[1], rest: match[2] };
}

// ==================== 子任务反馈流配置 ====================

/**
 * 子任务反馈流配置（独立于主配置）
 */
interface StreamFilter {
  toolCalls?: boolean;
  thinking?: boolean;
  errors?: boolean;
  progress?: boolean;
}

interface StreamConfig {
  streamToParent: boolean;
  streamFilter: StreamFilter;
  throttle: number;
  maxMessageLength: number;
  showTimestamp: boolean;
}

// 默认反馈流配置
const defaultStreamConfig: StreamConfig = {
  streamToParent: true,
  streamFilter: {
    toolCalls: true,
    thinking: false,
    errors: true,
    progress: true,
  },
  throttle: 3000,
  maxMessageLength: 200,
  showTimestamp: false,
};

// ==================== Transcript 监听辅助函数 ====================

/**
 * 从会话文件路径提取 session ID (UUID)
 */
function extractSessionIdFromPath(sessionFile: string): string | null {
  const basename = path.basename(sessionFile, ".jsonl");
  // UUID 格式验证
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(basename) ? basename : null;
}

/**
 * 读取会话文件最后 N 行消息
 */
async function readLastMessages(
  sessionFile: string,
  count: number = 3
): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    
    if (!fs.existsSync(sessionFile)) {
      resolve([]);
      return;
    }
    
    try {
      const content = fs.readFileSync(sessionFile, "utf-8");
      const lines = content.trim().split("\n");
      
      // 从后往前读取
      for (let i = lines.length - 1; i >= 0 && messages.length < count; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        
        try {
          const obj = JSON.parse(line);
          // 只关注消息类型
          if (obj.type === "message" && obj.message) {
            messages.unshift(obj);
          }
        } catch {
          // 忽略解析错误
        }
      }
      
      resolve(messages);
    } catch (e) {
      console.error("[task-monitor] Error reading session file:", e);
      resolve([]);
    }
  });
}

/**
 * 格式化消息为用户可读文本
 */
function formatTranscriptMessage(
  msgObj: any,
  config: StreamConfig
): string | null {
  const { streamFilter, maxMessageLength } = config;
  const msg = msgObj.message;
  
  if (!msg) return null;
  
  const role = msg.role;
  const content = msg.content;
  
  // 只处理 assistant 的消息（工具调用等）
  if (role === "assistant") {
    // 检查是否有工具调用
    const toolCalls = content?.tool_calls || msg.tool_calls;
    if (toolCalls && streamFilter.toolCalls) {
      const toolNames = toolCalls
        .map((tc: any) => tc.function?.name || tc.name || "unknown")
        .slice(0, 3)
        .join(", ");
      return `🔧 调用工具: ${toolNames}${toolCalls.length > 3 ? ` (+${toolCalls.length - 3})` : ""}`;
    }
    
    // 文本内容
    if (typeof content === "string" && content.trim()) {
      const preview = content.trim().slice(0, maxMessageLength);
      return `💬 ${preview}${content.length > maxMessageLength ? "..." : ""}`;
    }
    
    // 内容数组
    if (Array.isArray(content)) {
      const textBlocks = content.filter(
        (b: any) => b.type === "text" && b.text?.trim()
      );
      if (textBlocks.length > 0) {
        const preview = textBlocks[0].text.trim().slice(0, maxMessageLength);
        return `💬 ${preview}${textBlocks[0].text.length > maxMessageLength ? "..." : ""}`;
      }
    }
  }
  
  // tool_result 消息
  if (role === "toolResult" || role === "tool_result") {
    const isError = msg.is_error || msg.isError;
    const toolName = msg.tool_name || msg.toolName || "unknown";
    const result = msg.content || msg.result || "";
    const preview = String(result).slice(0, maxMessageLength / 2);
    
    if (isError && streamFilter.errors) {
      return `❌ ${toolName}: ${preview}`;
    } else if (streamFilter.toolCalls) {
      return `✅ ${toolName}: ${preview}`;
    }
  }
  
  return null;
}

/**
 * 从会话文件路径查找 sessionKey
 * 通过读取 sessions.json 进行反向查找
 */
async function findSessionKeyByFile(sessionFile: string): Promise<string | null> {
  try {
    // 提取可能的 agentId（从路径中）
    const pathParts = sessionFile.split("/");
    const agentsIndex = pathParts.findIndex(p => p === "agents");
    const agentId = agentsIndex >= 0 && pathParts.length > agentsIndex + 1
      ? pathParts[agentsIndex + 1]
      : "main";
    
    const sessionsJsonPath = path.join(
      process.env.HOME || "/root",
      ".openclaw/agents",
      agentId,
      "sessions/sessions.json"
    );
    
    if (!fs.existsSync(sessionsJsonPath)) {
      return null;
    }
    
    const content = fs.readFileSync(sessionsJsonPath, "utf-8");
    const sessions = JSON.parse(content);
    
    // 遍历查找 sessionFile 对应的 sessionKey
    for (const [key, entry] of Object.entries(sessions)) {
      const entryObj = entry as { sessionFile?: string };
      if (entryObj.sessionFile === sessionFile) {
        return key;
      }
    }
    
    return null;
  } catch (e) {
    console.error("[task-monitor] Error in findSessionKeyByFile:", e);
    return null;
  }
}

/**
 * 获取会话的频道信息
 * @param sessionKey 会话 key
 * @returns 频道信息 {channel, target} 或 null
 */
function getSessionChannelInfo(sessionKey: string): { channel: string; target: string } | null {
  try {
    // 从 sessionKey 提取 agentId（格式: agent:main:xxx 或 agent:subagent:xxx）
    const parts = sessionKey.split(":");
    const agentId = parts[1] || "main";
    
    const sessionsJsonPath = path.join(
      process.env.HOME || "/root",
      ".openclaw/agents",
      agentId,
      "sessions/sessions.json"
    );
    
    if (!fs.existsSync(sessionsJsonPath)) {
      return null;
    }
    
    const content = fs.readFileSync(sessionsJsonPath, "utf-8");
    const sessions = JSON.parse(content);
    
    const entry = sessions[sessionKey] as any;
    if (!entry) {
      return null;
    }
    
    // 提取频道信息
    const channel = entry.lastChannel || entry.deliveryContext?.channel || entry.origin?.provider || null;
    
    // 提取目标信息
    // Telegram: sessionKey 格式为 agent:main:telegram:direct:8665573247
    // 企业微信: sessionKey 格式为 agent:main:wecom:direct:yangke
    let target = null;
    if (entry.deliveryContext?.to) {
      // deliveryContext.to 格式: "telegram:8665573247" 或 "wecom:YangKe"
      target = entry.deliveryContext.to.split(":")[1];
    } else if (parts.length >= 5 && parts[4]) {
      // 从 sessionKey 提取
      target = parts[4];
    }
    
    if (channel && target) {
      return { channel, target };
    }
    
    return null;
  } catch (e) {
    console.error("[task-monitor] Error in getSessionChannelInfo:", e);
    return null;
  }
}

/**
 * 获取子任务深度（使用 SDK 函数）
 */
function getSubagentDepthLocal(sessionKey: string): number {
  return getSubagentDepth(sessionKey);
}

// 格式化 Agent Event 为用户可读消息
function formatAgentEvent(evt: any, config: StreamConfig): string | null {
  const { stream, data } = evt;
  const { streamFilter, maxMessageLength } = config;

  switch (stream) {
    case "tool":
      // 工具事件有三个 phase: start, update, end
      if (!streamFilter.toolCalls) return null;
      const phase = data?.phase;
      const toolName = data?.name || "unknown";
      
      if (phase === "start") {
        const toolArgs = data?.args ? JSON.stringify(data.args).slice(0, 100) : "";
        return `🔧 调用工具: ${toolName}${toolArgs ? ` (${toolArgs})` : ""}`;
      } else if (phase === "end") {
        const isError = data?.isError;
        const resultPreview = data?.result ? String(data.result).slice(0, maxMessageLength) : "完成";
        return isError ? `❌ ${toolName}: ${resultPreview}` : `✅ ${toolName}: ${resultPreview}`;
      }
      // update 阶段不显示（太多）
      return null;

    case "assistant":
      // AI 输出文本流（太频繁，不显示）
      return null;

    case "thinking":
      if (!streamFilter.thinking) return null;
      return `💭 思考中...`;

    case "error":
      if (!streamFilter.errors) return null;
      const errorMsg = data?.error ? String(data.error).slice(0, maxMessageLength) : "未知错误";
      return `❌ 错误: ${errorMsg}`;

    case "progress":
      if (!streamFilter.progress) return null;
      const progressMsg = data?.message ? String(data.message).slice(0, maxMessageLength) : "处理中...";
      return `📊 ${progressMsg}`;

    default:
      return null; // 未识别的事件类型
  }
}

// 初始化管理器
let stateManager: StateManager | null = null;
let alertManager: AlertManager | null = null;
let taskChainManager: TaskChainManager | null = null;

// 任务频道映射：sessionKey → {channel, target}
const taskChannelMap = new Map<string, { channel: string; target: string }>();

interface SubagentSpawnedPayload {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  runId: string;
  taskDescription?: string;
}

interface SubagentEndedPayload {
  targetSessionKey: string;
  reason: string;
  outcome: "ok" | "error" | "timeout" | "killed";
  runId?: string;
  endedAt?: number;
  error?: string;
}

/**
 * 安全执行重试任务 (v3: spawn + 数组参数，避免命令注入)
 */
async function executeRetrySafely(
  runId: string,
  agentId: string,
  taskDescription: string,
  spawnTimeout: number
): Promise<{ pid: number; runId: string; startTime: number }> {
  return new Promise((resolve, reject) => {
    // 使用数组参数，避免 shell 解析
    const args = [
      "--agent", agentId,
      "--print", taskDescription
    ];

    const child = spawn("claude", args, {
      detached: false,
      stdio: "ignore",
      timeout: spawnTimeout,
    });

    const startTime = Date.now();

    // v3 修复：添加 resolved 标志防止双重 resolve
    let resolved = false;

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to spawn retry: ${err.message}`));
      }
    });

    child.on("exit", (code, signal) => {
      if (!resolved) {
        resolved = true;
        if (code === 0) {
          resolve({ pid: child.pid!, runId, startTime });
        } else {
          reject(new Error(`Retry exited with code ${code}, signal ${signal}`));
        }
      }
    });

    // v3 修复：只在成功启动时 resolve
    if (child.pid) {
      resolved = true;
      resolve({ pid: child.pid, runId, startTime });
    }
  });
}

/**
 * 发送通知（通过 AlertManager，支持去重和冷却期）
 * 如果发送失败，将消息加入队列等待重试
 */
async function sendNotification(alertType: string, message: string, channel?: string, target?: string): Promise<void> {
  if (!alertManager) {
    console.error("[task-monitor] AlertManager not initialized");
    return;
  }
  
  // 如果未提供 channel/target，从 taskChannelMap 中查找当前任务
  if (!channel || !target) {
    // 尝试从最近的任务中获取频道信息
    for (const [sessionKey, info] of taskChannelMap.entries()) {
      if (!channel) channel = info.channel;
      if (!target) target = info.target;
      break; // 使用最新的一条
    }
  }
  
  // 配置文件优先级最高（用户明确设置的通知目标）
  // 只有配置文件没有设置时，才使用会话频道作为 fallback
  channel = config.notification.channel || channel;
  target = config.notification.target || target;
  
  try {
    const sent = await alertManager.sendAlertToTarget(alertType, message, alertType, channel, target);
    if (!sent) {
      // 发送失败，加入消息队列
      console.warn("[task-monitor] Alert send returned false, queuing message");
      messageQueue.enqueue(alertType, message, alertType);
    }
  } catch (e) {
    console.error("[task-monitor] Failed to send notification:", e);
    // 异常时也加入队列
    messageQueue.enqueue(alertType, message, alertType);
  }
}

const plugin = {
  id: "task-monitor",
  name: "Task Monitor",
  description: "监控子任务生命周期、自动重试、任务链追踪、进度报告、主任务监控、停滞检测、超时检测、exec进程监控、失败实时上报（v12）",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // ==================== 加载配置 ====================
    const config = loadConfig();
    console.log(`[task-monitor] Plugin registering (v12, config version: ${config.version})...`);
    api.logger.info?.(`[task-monitor] Plugin registering (v12, config version: ${config.version})...`);

    // 从配置中提取常用路径
    const TASKS_DIR = config.storage.tasksDir;
    const STATE_DIR = config.storage.stateDir;

    // 初始化状态管理器
    stateManager = new StateManager(STATE_DIR);
    alertManager = new AlertManager(
      { 
        channel: config.notification.channel, 
        target: config.notification.target 
      },
      path.join(STATE_DIR, "alert-records.json")
    );
    taskChainManager = new TaskChainManager(STATE_DIR);

    // 初始化消息队列
    messageQueue.setAlertManager(alertManager);
    // 应用配置
    if (config.messageQueue) {
      // MessageQueue 已经是单例，配置在构造时已设置
      // 这里可以添加动态配置更新逻辑
      api.logger.info?.(`[task-monitor] Message queue config: maxQueueSize=${config.messageQueue.maxQueueSize}, maxRetries=${config.messageQueue.maxRetries}`);
    }
    api.logger.info?.("[task-monitor] Message queue initialized");

    // ==================== 新增：活跃检测初始化 ====================
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
    
    api.logger.info?.("[task-monitor] Activity detection initialized (Layer 1)");
    
    // ==================== 新增：Memory Manager 初始化 ====================
    const workspaceDir = api.config?.workspaceDir || '/root/.openclaw/workspace';
    const memoryConfig: MemoryConfig = {
      enableAutoConsolidation: config.memory?.enableAutoConsolidation ?? true,
      enablePeriodicRefinement: config.memory?.enablePeriodicRefinement ?? true,
      consolidationPath: config.memory?.consolidationPath || path.join(workspaceDir, 'memory'),
      knowledgeBasePath: config.memory?.knowledgeBasePath || path.join(workspaceDir, 'memory/knowledge-base'),
      refinementSchedule: { dayOfWeek: 0, hour: 22, minute: 0 },
      accessThreshold: 5
    };
    const memoryManager = new MemoryManager(memoryConfig, stateManager, api);
    memoryManager.startPeriodicRefinement();
    api.logger.info?.("[task-monitor] Memory manager initialized");
    
    // ==================== 新增：钩子注册 ====================
    // 注册 before_tool_call 钩子
    try {
      api.on("before_tool_call", async (event) => {
        try {
          // 排除不需要追踪的工具
          const excludeTools = activityConfig.excludeTools || ['read', 'web_fetch'];
          if (excludeTools.includes(event.toolName)) return;
          
          const runId = event.runId || event.toolCallId;
          const sessionKey = (event as any).sessionKey || '';
          
          // 如果还没有活跃状态，创建一个
          if (!activityTracker.getActivity(runId)) {
            const type: SessionType = sessionKey.includes(':subagent:') ? 'sub' : 
                                      sessionKey.includes(':acp:') ? 'acp' : 'main';
            activityTracker.createActivity(runId, sessionKey, type);
          }
          
          // 开始工具调用追踪
          activityTracker.startToolCall(
            event.toolCallId,
            event.toolName,
            runId,
            event.params as Record<string, unknown>,
            sessionKey
          );
        } catch (e) {
          api.logger.error?.(`[task-monitor] Error in before_tool_call hook: ${e}`);
        }
      });
      activityTracker.markHookRegistered('before_tool_call');
      api.logger.debug?.("[task-monitor] Hook registered: before_tool_call");
    } catch (e) {
      activityTracker.markHookFailed('before_tool_call', e);
    }
    
    // 注册 after_tool_call 钩子
    try {
      api.on("after_tool_call", async (event) => {
        try {
          const runId = event.runId || event.toolCallId;
          const toolName = event.toolName || event.tool_name || event.name;
          const isError = !!event.error;
          const result = event.result || event.output || event.error;
          
          // 监控 sessions_spawn 失败
          if (toolName === 'sessions_spawn' && isError) {
            const errorMsg = typeof result === 'string' ? result : JSON.stringify(result);
            api.logger.error?.(`[task-monitor] sessions_spawn failed: ${errorMsg}`);
            
            // 发送告警
            if (alertManager?.shouldAlert(`spawn_failed_${Date.now()}`, "spawn_failed")) {
              const message = `❌ 子任务创建失败\n\n错误: ${errorMsg.slice(0, 500)}`;
              await sendNotification("spawn_failed", message);
              alertManager.recordAlert(`spawn_failed_${Date.now()}`, "spawn_failed");
            }
          }
          
          // 结束工具调用追踪
          activityTracker.endToolCall(event.toolCallId, isError);
        } catch (e) {
          api.logger.error?.(`[task-monitor] Error in after_tool_call hook: ${e}`);
        }
      });
      activityTracker.markHookRegistered('after_tool_call');
      api.logger.debug?.("[task-monitor] Hook registered: after_tool_call");
    } catch (e) {
      activityTracker.markHookFailed('after_tool_call', e);
    }
    
    // 注册 session_start 钩子
    try {
      api.on("session_start", async (event: any) => {
        try {
          const sessionKey = event.sessionKey || event.key;
          const runId = event.runId || event.id;
          
          if (sessionKey && !sessionKey.includes(":subagent:")) {
            activityTracker.trackSessionStart(runId, sessionKey, 'main');
            api.logger.debug?.(`[task-monitor] Session started: ${sessionKey}`);
          }
        } catch (e) {
          api.logger.error?.(`[task-monitor] Error in session_start hook: ${e}`);
        }
      });
      activityTracker.markHookRegistered('session_start');
      api.logger.debug?.("[task-monitor] Hook registered: session_start");
    } catch (e) {
      activityTracker.markHookFailed('session_start', e);
    }
    
    // 注册 session_end 钩子
    try {
      api.on("session_end", async (event: any) => {
        try {
          const sessionKey = event.sessionKey || event.key;
          const runId = event.runId || event.id;
          
          if (sessionKey) {
            activityTracker.trackSessionEnd(runId, sessionKey);
            api.logger.debug?.(`[task-monitor] Session ended: ${sessionKey}`);
            
            // 主任务完成即时通知（session_end 触发）
            if (!sessionKey.includes(":subagent:") && !sessionKey.includes(":acp:")) {
              const alertId = `main_completed_${sessionKey}`;
              
              // 原子操作：先记录再发送，避免并发重复
              if (alertManager?.shouldAlert(alertId, "main_completed")) {
                alertManager.recordAlert(alertId, "main_completed");
                
                // 获取通知目标：taskChannelMap → config
                const channelInfo = taskChannelMap.get(sessionKey) || {
                  channel: config.notification.channel,
                  target: config.notification.target
                };
                
                const notifyMessage = `✅ 主任务完成\n\n会话: ${sessionKey}\n时间: ${new Date().toLocaleString("zh-CN")}`;
                
                try {
                  execSync(
                    `openclaw message send --channel "${channelInfo.channel}" --target "${channelInfo.target}" --message "${notifyMessage.replace(/\n/g, '\\n')}"`,
                    { timeout: 15000, stdio: 'pipe' }
                  );
                  api.logger.info?.(`[task-monitor] ✅ Main task completion notification sent via session_end: ${sessionKey}`);
                } catch (e) {
                  // 发送失败，移除记录允许重试
                  alertManager.alertRecords?.delete(alertId);
                  api.logger.error?.(`[task-monitor] Failed to send completion notification: ${e}`);
                  
                  // 加入消息队列重试
                  messageQueue.enqueue(sessionKey, notifyMessage, "main_completed");
                }
              } else {
                api.logger.debug?.(`[task-monitor] Alert already sent for ${alertId}, skipping`);
              }
            }
          }
        } catch (e) {
          api.logger.error?.(`[task-monitor] Error in session_end hook: ${e}`);
        }
      });
      activityTracker.markHookRegistered('session_end');
      api.logger.debug?.("[task-monitor] Hook registered: session_end");
    } catch (e) {
      activityTracker.markHookFailed('session_end', e);
    }
    
    // 注册流式输出监听（已在 onAgentEvent 中处理）
    activityTracker.markHookRegistered('onAgentEvent');
    
    // 检查钩子完整性，决定是否降级
    if (!activityTracker.areCriticalHooksRegistered()) {
      api.logger.warn?.("[task-monitor] Critical hooks not registered, some features may be degraded");
      if (config.degradation?.fallbackToLayer4Only) {
        api.logger.warn?.("[task-monitor] Degraded mode: Layer 1/2/3 disabled, Layer 4 only");
      }
    } else {
      api.logger.info?.("[task-monitor] All critical hooks registered successfully");
    }
    
    // ==================== 新增：设置中断处理器回调 ====================
    interruptHandler.setRetryCallback(async (runId: string, task: TaskState) => {
      // 执行重试逻辑
      try {
        const agentId = task.metadata?.agentId as string;
        const taskDescription = task.metadata?.taskDescription as string || task.metadata?.label as string || "retry task";
        
        await executeRetrySafely(runId, agentId, taskDescription, config.retry.spawnTimeout);
        api.logger.info?.(`[task-monitor] Retry spawned from interrupt handler: ${runId}`);
      } catch (e) {
        api.logger.error?.(`[task-monitor] Failed to spawn retry from interrupt handler: ${e}`);
        await stateManager?.recordRetryOutcome(runId, "error", String(e));
      }
    });
    
    // ==================== 新增：启动活跃检测定时器 ====================
    activityTracker.setInterruptHandler(async (runId, reason, context) => {
      await interruptHandler.handleInterrupt(runId, reason as any, context);
    });
    
    activityTracker.setToolTimeoutHandler(async (toolCall) => {
      await interruptHandler.handleToolTimeout(toolCall);
    });
    
    activityTracker.startActivityDetection();
    activityTracker.startToolTimeoutDetection();
    activityTracker.startCleanup();
    
    // 启动健康检查
    healthChecker.startHealthCheck();
    
    api.logger.info?.("[task-monitor] Activity detection timers started");

    // ==================== 启动时状态恢复 ====================
    async function recoverRunningTasks(): Promise<void> {
      const runningDir = path.join(TASKS_DIR, "running");
      
      if (!fs.existsSync(runningDir)) {
        api.logger.info?.("[task-monitor] No running tasks directory, skip recovery");
        return;
      }
      
      const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));
      
      if (taskFiles.length === 0) {
        api.logger.info?.("[task-monitor] No running tasks to recover");
        return;
      }
      
      api.logger.info?.(`[task-monitor] Found ${taskFiles.length} running tasks, checking for recovery...`);
      
      let recovered = 0;
      for (const file of taskFiles) {
        const filePath = path.join(runningDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          
          // 提取 sessionKey
          const sessionKeyMatch = content.match(/\*\*SessionKey\*\*:\s*(.+)/m);
          if (!sessionKeyMatch) continue;
          
          const sessionKey = sessionKeyMatch[1].trim();
          
          // 检查 StateManager 中是否有对应任务
          const existingTask = await stateManager?.getTask(sessionKey);
          
          if (!existingTask) {
            // 检查任务状态
            const isCompleted = content.includes("**状态**: completed") || content.includes("状态: completed");
            const isPending = content.includes("**状态**: pending") || content.includes("状态: pending");
            const isRunning = content.includes("**状态**: running") || content.includes("状态: running");
            
            // 只恢复 running 状态的任务
            if (isRunning && !isCompleted) {
              await stateManager?.registerTask({
                id: sessionKey,
                type: 'main',
                status: 'running',
                timeoutMs: config.monitoring.mainTaskTimeout,
                parentTaskId: null,
                maxRetries: 0,
                metadata: {
                  recovered: true,
                  recoveredAt: Date.now(),
                  sourceFile: file
                }
              });
              
              api.logger.info?.(`[task-monitor] Recovered task: ${sessionKey}`);
              recovered++;
            }
          }
        } catch (e) {
          api.logger.error?.(`[task-monitor] Error recovering task ${file}: ${e}`);
        }
      }
      
      if (recovered > 0) {
        api.logger.info?.(`[task-monitor] ✅ Recovered ${recovered} tasks`);
      } else {
        api.logger.info?.("[task-monitor] No tasks needed recovery");
      }
    }
    
    // 执行状态恢复
    recoverRunningTasks().catch(e => {
      api.logger.error?.(`[task-monitor] Recovery failed: ${e}`);
    });

    // ==================== 消息队列定时器：定期清空队列 ====================
    const queueFlushTimer = setInterval(async () => {
      if (messageQueue.size() > 0) {
        api.logger.debug?.(`[task-monitor] Auto-flushing message queue, size: ${messageQueue.size()}`);
        await messageQueue.flushQueue();
      }
    }, 30000); // 每 30 秒尝试一次

    // ==================== 进度报告定时器存储 ====================
    const progressReporters = new Map<string, NodeJS.Timeout>();

    // ==================== 定时器 1: 超时检查 + 主任务完成检测 ====================
    const timeoutChecker = setInterval(async () => {
      if (!stateManager || !taskChainManager) return;
      try {
        // 任务超时检查
        const timedOutTasks = await stateManager.checkTimeouts();
        for (const task of timedOutTasks) {
          api.logger.warn?.(`[task-monitor] Task timeout: ${task.id}`);
          
          // 获取动态频道（优先级：metadata > taskChannelMap > 最近主任务）
          let channelInfo = null;
          
          // 1. 从 task.metadata 读取（最可靠）
          if (task.metadata?.channel && task.metadata?.target) {
            channelInfo = {
              channel: task.metadata.channel as string,
              target: task.metadata.target as string
            };
          }
          
          // 2. 从 taskChannelMap 读取
          if (!channelInfo) {
            channelInfo = taskChannelMap.get(task.id);
          }
          
          // 3. 如果是 exec 类型，尝试从 sessionKey 获取
          if (!channelInfo && task.type === 'exec' && task.metadata?.sessionKey) {
            channelInfo = getSessionChannelInfo(task.metadata.sessionKey as string);
          }
          
          // 4. 最后尝试最近的主任务频道
          if (!channelInfo && task.type === 'exec' && taskChannelMap.size > 0) {
            const lastEntry = Array.from(taskChannelMap.entries()).pop();
            if (lastEntry) {
              channelInfo = lastEntry[1];
              api.logger.info?.(`[task-monitor] Using latest channel for exec task: ${lastEntry[0]}`);
            }
          }
          
          const message = `任务超时！类型: ${task.type}, 运行时间: ${Math.floor((Date.now() - task.startTime) / 60000)} 分钟`;
          
          if (channelInfo) {
            await alertManager?.sendAlertToTarget(
              task.id,
              message,
              "timeout",
              channelInfo.channel,
              channelInfo.target
            );
          } else {
            await alertManager?.sendAlert(task.id, message, "timeout");
          }
        }

        // 任务链超时检查
        const timedOutChains = await taskChainManager.checkTimeouts();
        for (const chain of timedOutChains) {
          api.logger.warn?.(`[task-monitor] Task chain timeout: ${chain.mainTaskId}`);
          
          // 尝试从 taskChannelMap 获取动态频道
          const channelInfo = taskChannelMap.get(chain.mainTaskId);
          const message = `任务链超时！\n\n主任务: ${chain.label || chain.mainTaskId}\n子任务数: ${chain.subtasks.length}\n运行时间: ${Math.floor((Date.now() - chain.createdAt) / 60000)} 分钟`;
          
          if (channelInfo) {
            await alertManager?.sendAlertToTarget(
              chain.mainTaskId,
              message,
              "chain_timeout",
              channelInfo.channel,
              channelInfo.target
            );
          } else {
            await alertManager?.sendAlert(chain.mainTaskId, message, "chain_timeout");
          }
        }

        // ==================== 主任务完成检测 ====================
        const runningDir = path.join(TASKS_DIR, "running");
        const completedDir = path.join(TASKS_DIR, "completed");
        
        if (fs.existsSync(runningDir)) {
          const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));
          
          for (const file of taskFiles) {
            const filePath = path.join(runningDir, file);
            try {
              const content = fs.readFileSync(filePath, "utf-8");
              const stat = fs.statSync(filePath);
              const elapsed = (Date.now() - stat.mtimeMs) / 1000; // 秒
              
              // 检测完成状态
              if (content.includes("**状态**: completed") || content.includes("状态: completed")) {
                const taskName = file.replace(".md", "");
                
                // 先移动文件到 completed 目录，避免重复检测
                if (!fs.existsSync(completedDir)) {
                  fs.mkdirSync(completedDir, { recursive: true });
                }
                const targetPath = path.join(completedDir, file);
                
                // 检查文件是否已经被移动（避免竞争）
                if (fs.existsSync(filePath) && !fs.existsSync(targetPath)) {
                  fs.renameSync(filePath, targetPath);
                  api.logger.info?.(`[task-monitor] Task file moved to completed: ${file}`);
                  
                  // 移动成功后再发送通知
                  // 从任务记录中直接读取频道和通知目标
                  const channelMatch = content.match(/\*\*频道\*\*:\s*(\S+)/);
                  const notifyTargetMatch = content.match(/\*\*通知目标\*\*:\s*(\S+)/);
                  const taskChannel = channelMatch ? channelMatch[1] : config.notification.channel;
                  const notifyTarget = notifyTargetMatch ? notifyTargetMatch[1] : config.notification.target;
                  
                  api.logger.info?.(`[task-monitor] Sending completion notification to ${taskChannel}: ${notifyTarget}`);
                  
                  // 直接调用 message 命令发送通知（带去重）
                  const alertId = `main_completed_${taskName}`;
                  
                  // 检查是否已发送过（内存缓存 + 文件记录）
                  if (alertManager?.shouldAlert(alertId, "main_completed")) {
                    const notifyMessage = `✅ 主任务完成\n\n任务: ${taskName}\n时间: ${new Date().toLocaleString("zh-CN")}`;
                    try {
                      execSync(
                        `openclaw message send --channel "${taskChannel}" --target "${notifyTarget}" --message "${notifyMessage.replace(/\n/g, '\\n')}"`,
                        { timeout: 15000, stdio: 'pipe' }
                      );
                      // 记录已发送
                      alertManager?.recordAlert(alertId, "main_completed");
                      api.logger.info?.(`[task-monitor] ✅ Notification sent to ${taskChannel}: ${notifyTarget}`);
                    } catch (e) {
                      api.logger.error?.(`[task-monitor] Failed to send completion notification: ${e}`);
                    }
                  } else {
                    api.logger.debug?.(`[task-monitor] Alert already sent for ${alertId}, skipping`);
                  }
                }
                
                // 从 StateManager 中移除已完成的任务（避免重复检测）
                const existingTask = await stateManager?.getTask(taskName);
                if (existingTask) {
                  await stateManager?.updateTask(taskName, { 
                    status: 'completed',
                    notified: true,
                    completedAt: Date.now()
                  });
                  api.logger.debug?.(`[task-monitor] Marked task as completed in StateManager: ${taskName}`);
                }
              }
              // ==================== 停滞任务检测 ====================
              else if ((content.includes("**状态**: pending") || content.includes("状态: pending")) && elapsed > config.monitoring.stalledPendingThreshold / 1000) {
                // pending 状态超过阈值
                const taskName = file.replace(".md", "");
                await alertManager?.sendAlert(
                  `stalled_pending_${taskName}`,
                  `⚠️ 任务停滞\n\n任务: ${taskName}\n状态: pending\n停滞时间: ${Math.floor(elapsed / 60)} 分钟\n原因: 任务创建后未开始执行`,
                  "stalled_pending"
                );
                api.logger.warn?.(`[task-monitor] Stalled task detected (pending): ${file}`);
              }
              // ==================== 任务状态一致性检测 ====================
              else if ((content.includes("**状态**: running") || content.includes("状态: running")) && elapsed > config.monitoring.stalledRunningThreshold / 1000) {
                // running 状态超过阈值，检查是否有对应的子任务
                const taskName = file.replace(".md", "");
                
                // 检查状态管理器中是否有对应的活跃任务
                const allTasks = await stateManager?.getAllTasks() || [];
                const hasActiveSubagent = allTasks.some(t => 
                  t.status === 'running' && 
                  (t.id === taskName || 
                   t.metadata?.parentTaskId === taskName ||
                   t.metadata?.mainTaskId === taskName)
                );
                
                if (!hasActiveSubagent) {
                  await alertManager?.sendAlert(
                    `stalled_running_${taskName}`,
                    `⚠️ 任务状态不一致\n\n任务: ${taskName}\n状态: running\n停滞时间: ${Math.floor(elapsed / 60)} 分钟\n原因: 任务状态为 running 但无活跃子任务执行`,
                    "stalled_running"
                  );
                  api.logger.warn?.(`[task-monitor] Stalled task detected (running, no subagent): ${file}`);
                }
              }
              // ==================== 主任务超时检测 ====================
              // pending 状态超时（独立检测，不受停滞检测影响）
              if ((content.includes("**状态**: pending") || content.includes("状态: pending")) && elapsed > config.monitoring.mainTaskTimeout / 1000) {
                const taskName = file.replace(".md", "");
                await alertManager?.sendAlert(
                  `main_task_timeout_${taskName}`,
                  `⏰ 主任务超时\n\n任务: ${taskName}\n状态: pending\n运行时间: ${Math.floor(elapsed / 60)} 分钟\n原因: 任务创建后长时间未开始`,
                  "main_task_timeout"
                );
                api.logger.warn?.(`[task-monitor] Main task timeout (pending): ${file}`);
              }
              // running 状态超时
              if ((content.includes("**状态**: running") || content.includes("状态: running")) && elapsed > config.monitoring.mainTaskTimeout / 1000) {
                const taskName = file.replace(".md", "");
                await alertManager?.sendAlert(
                  `main_task_timeout_${taskName}`,
                  `⏰ 主任务超时\n\n任务: ${taskName}\n状态: running\n运行时间: ${Math.floor(elapsed / 60)} 分钟\n原因: 任务执行时间过长`,
                  "main_task_timeout"
                );
                api.logger.warn?.(`[task-monitor] Main task timeout (running): ${file}`);
              }
            } catch (e) {
              // 忽略单个文件读取错误
            }
          }
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Timeout check error: ${e}`);
      }
    }, config.progress.timeoutCheckInterval);

    // ==================== 定时器 2: 重试调度检查 ====================
    const retryChecker = setInterval(async () => {
      if (!stateManager) return;
      try {
        const dueRetries = await stateManager.getDueScheduledRetries(5);

        for (const retry of dueRetries) {
          api.logger.info?.(`[task-monitor] Executing scheduled retry: ${retry.runId} (attempt ${retry.retryCount})`);

          // 获取任务信息
          const task = await stateManager.getTask(retry.runId);
          if (!task) {
            api.logger.warn?.(`[task-monitor] Task not found for retry: ${retry.runId}`);
            await stateManager.cancelScheduledRetry(retry.runId);
            continue;
          }

          // 标记调度已执行
          await stateManager.markRetryExecuted(retry.runId);

          // 发送重试通知
          const label = task.metadata?.label || retry.runId;
          await sendNotification("retry_started", `🔄 开始重试子任务\n\n任务: ${label}\n重试次数: ${retry.retryCount}/${task.maxRetries}`);

          // 执行重试 (spawn 安全执行)
          try {
            const agentId = task.metadata?.agentId as string;
            const taskDescription = task.metadata?.taskDescription as string || task.metadata?.label as string || "retry task";

            await executeRetrySafely(retry.runId, agentId, taskDescription, config.retry.spawnTimeout);
            api.logger.info?.(`[task-monitor] Retry spawned successfully: ${retry.runId}`);
          } catch (e) {
            api.logger.error?.(`[task-monitor] Failed to spawn retry: ${e}`);

            // 记录失败，检查是否还能重试
            await stateManager.recordRetryOutcome(retry.runId, "error", String(e));
            const shouldRetry = await stateManager.shouldRetry(retry.runId);

            if (shouldRetry) {
              // 再次安排重试
              await stateManager.scheduleRetry(retry.runId);
            } else {
              // 放弃任务
              await stateManager.abandonTask(retry.runId);
              await sendNotification("retry_exhausted", `❌ 任务最终失败\n\n任务: ${label}\n重试耗尽，已放弃`);
            }
          }
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Retry check error: ${e}`);
      }
    }, config.retry.checkInterval);

    // ==================== 定时器 3: InterruptHandler 清理 ====================
    // 每小时清理一次陈旧的中断记录，防止内存泄漏
    const cleanupChecker = setInterval(() => {
      try {
        interruptHandler.cleanup(3600000);  // 清理 1 小时前的记录
      } catch (e) {
        api.logger.error?.(`[task-monitor] Cleanup error: ${e}`);
      }
    }, 3600000);  // 每小时执行一次

    // ==================== 子任务反馈流配置 ====================
    // 使用主配置中的通知参数作为基础
    const streamConfig: StreamConfig = {
      streamToParent: true,
      streamFilter: {
        toolCalls: true,
        thinking: false,
        errors: true,
        progress: true,
      },
      throttle: config.notification.throttle,
      maxMessageLength: config.notification.maxMessageLength,
      showTimestamp: false,
    };
    api.logger.info?.(`[task-monitor] Stream config initialized: throttle=${streamConfig.throttle}ms, maxLen=${streamConfig.maxMessageLength}`);

    // 节流控制：避免频繁发送消息
    const lastSentMap = new Map<string, number>();

    // ==================== 监听 Agent Events (v5: 子任务反馈流式转发 + 主任务完成检测) ====================
    api.runtime.events.onAgentEvent(async (evt) => {
      try {
        // 调试日志：检查事件是否触发
        api.logger.debug?.(`[task-monitor] onAgentEvent triggered: stream=${evt.stream}, runId=${evt.runId}, sessionKey=${evt.sessionKey || "empty"}`);

        // 1. 处理 lifecycle 事件
        if (evt.stream === "lifecycle") {
          const phase = (evt.data as any)?.phase;
          
          // 处理 turn_started 事件（主任务开始 - 检查任务记录）
          // OpenClaw 发送 phase: "start"，不是 "turn_started"
          if (phase === "start" || phase === "turn_started") {
            // 排除子任务
            if (evt.sessionKey && !evt.sessionKey.includes(":subagent:")) {
              api.logger.info?.(`[task-monitor] Main task turn started: ${evt.sessionKey}`);
              
              // v10: 自动创建任务记录
              try {
                const runningDir = path.join(TASKS_DIR, "running");
                
                // 确保 running 目录存在
                if (!fs.existsSync(runningDir)) {
                  fs.mkdirSync(runningDir, { recursive: true });
                }
                
                // 检查是否已有该 sessionKey 的任务记录
                const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));
                const hasRecord = taskFiles.some(f => {
                  const content = fs.readFileSync(path.join(runningDir, f), "utf-8");
                  return content.includes(evt.sessionKey!);
                });
                
                // 如果没有记录，自动创建
                if (!hasRecord) {
                  const sessionShort = evt.sessionKey.split(":").pop() || evt.sessionKey.slice(-8);
                  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                  const taskFileName = `main-${sessionShort}-${timestamp}.md`;
                  const taskFilePath = path.join(runningDir, taskFileName);
                  
                  // 从事件数据中提取频道信息
                  const eventData = evt.data as any;
                  const channel = eventData?.inboundMeta?.channel || eventData?.channel || config.notification.channel;
                  const senderId = eventData?.inboundMeta?.sender_id || eventData?.senderId || "unknown";
                  
                  // 确定通知目标（cron 任务使用默认配置）
                  const notifyTarget = (senderId === "unknown" || !senderId) 
                    ? config.notification.target 
                    : senderId;
                  
                  const taskContent = `# 任务记录

**SessionKey**: ${evt.sessionKey}
**RunId**: ${evt.runId || "N/A"}
**创建时间**: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
**状态**: running
**频道**: ${channel}
**通知目标**: ${notifyTarget}

## 任务描述

（待填写）

## 执行日志

- ${new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })} 任务开始
`;
                  
                  fs.writeFileSync(taskFilePath, taskContent, "utf-8");
                  
                  // 更新任务频道映射
                  taskChannelMap.set(evt.sessionKey, { channel, target: notifyTarget });
                  
                  api.logger.info?.(`[task-monitor] Auto-created task record: ${taskFileName} (channel: ${channel}, notifyTarget: ${notifyTarget})`);
                }
              } catch (error) {
                api.logger.error?.(`[task-monitor] Failed to create task record: ${error}`);
              }
            }
          }
          
          // 处理 end 事件（主任务完成检测）
          if (phase === "end") {
            // 排除子任务
            if (evt.sessionKey && !evt.sessionKey.includes(":subagent:")) {
              api.logger.info?.(`[task-monitor] Main task turn ended: ${evt.sessionKey}`);
              
              // v10: 自动更新任务状态为 completed
              try {
                const runningDir = path.join(TASKS_DIR, "running");
                if (fs.existsSync(runningDir)) {
                  const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));
                  
                  // 查找包含该 sessionKey 的任务记录
                  for (const file of taskFiles) {
                    const filePath = path.join(runningDir, file);
                    let content = fs.readFileSync(filePath, "utf-8");
                    
                    if (content.includes(evt.sessionKey!) && content.includes("**状态**: running")) {
                      // 更新状态为 completed
                      content = content.replace("**状态**: running", "**状态**: completed");
                      
                      // 添加完成日志
                      const completedTime = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" });
                      const logLine = `- ${completedTime} 任务完成\n`;
                      
                      // 在执行日志部分添加完成记录
                      if (content.includes("## 执行日志")) {
                        content = content.replace("## 执行日志\n", `## 执行日志\n${logLine}`);
                      } else {
                        content += `\n## 执行日志\n${logLine}`;
                      }
                      
                      fs.writeFileSync(filePath, content, "utf-8");
                      api.logger.info?.(`[task-monitor] Updated task status to completed: ${file}`);
                      
                      // 从任务记录中直接读取频道和通知目标
                      const channelMatch = content.match(/\*\*频道\*\*:\s*(\S+)/);
                      const notifyTargetMatch = content.match(/\*\*通知目标\*\*:\s*(\S+)/);
                      const taskChannel = channelMatch ? channelMatch[1] : config.notification.channel;
                      const notifyTarget = notifyTargetMatch ? notifyTargetMatch[1] : config.notification.target;
                      
                      api.logger.info?.(`[task-monitor] Sending completion notification to ${taskChannel}: ${notifyTarget}`);
                      
                      // 直接调用 message 命令发送通知
                      const notifyMessage = `✅ 主任务对话完成\n\n任务: ${file.replace('.md', '')}\n时间: ${new Date().toLocaleString("zh-CN")}`;
                      try {
                        execSync(
                          `openclaw message send --channel "${taskChannel}" --target "${notifyTarget}" --message "${notifyMessage.replace(/\n/g, '\\n')}"`,
                          { timeout: 15000, stdio: 'pipe' }
                        );
                        api.logger.info?.(`[task-monitor] ✅ Notification sent to ${taskChannel}: ${notifyTarget}`);
                      } catch (e) {
                        api.logger.error?.(`[task-monitor] Failed to send completion notification: ${e}`);
                      }
                      
                      break;
                    }
                  }
                }
              } catch (error) {
                api.logger.error?.(`[task-monitor] Failed to update task status: ${error}`);
              }
              
              // Memory: 处理任务完成，生成摘要
              if (evt.runId) {
                memoryManager.handleTaskCompletion(evt.runId).catch(err => {
                  api.logger.error?.(`[memory] Failed to handle completion:`, err);
                });
              }
            }
          }
          
          // 处理 error 事件（原有逻辑）
          if (phase === "error") {
            const errorText = String((evt.data as any)?.error || "");
            const isTimeout = /timed?out/i.test(errorText);

            if (isTimeout) {
              api.logger.warn?.(`[task-monitor] Embedded run timeout detected: ${evt.runId}`);
              await alertManager?.sendAlert(
                evt.runId,
                `Embedded run 超时！\n\nrunId: ${evt.runId}\n错误: ${errorText}`,
                "embedded_timeout"
              );

              if (stateManager) {
                let task = await stateManager.getTask(evt.runId);
                if (!task) {
                  task = await stateManager.registerTask({
                    id: evt.runId,
                    type: "embedded",
                    status: "timeout",
                    timeoutMs: 0,
                    parentTaskId: null,
                    metadata: { label: `Embedded run ${evt.runId}` },
                  });
                }
                await stateManager.recordRetryOutcome(evt.runId, "timeout", errorText);
              }
            }
          }
          return; // lifecycle 事件处理完毕
        }

        // 2. 子任务反馈流式转发（新功能）
        if (!streamConfig.streamToParent) return;

        // 只处理子任务的事件
        if (!evt.sessionKey || !evt.sessionKey.includes(":subagent:")) return;

        // 节流检查
        const now = Date.now();
        const lastSent = lastSentMap.get(evt.sessionKey) || 0;
        if (now - lastSent < streamConfig.throttle) return;

        // 查找任务链，获取父会话
        const chain = await taskChainManager?.findChainBySessionKey(evt.sessionKey);
        if (!chain) {
          // 可能是直接子任务，尝试从状态管理器获取
          const task = await stateManager?.getTask(evt.runId);
          if (!task?.metadata?.parentSessionKey) return;
        }

        // 格式化事件消息
        const message = formatAgentEvent(evt, streamConfig);
        if (!message) return; // 被过滤的事件

        // 更新节流时间戳
        lastSentMap.set(evt.sessionKey, now);

        // 发送到父会话
        const parentSessionKey = chain?.mainSessionKey;
        if (!parentSessionKey) return;

        try {
          await api.runtime.system.enqueueSystemEvent(
            `[子任务] ${message}`,
            { sessionKey: parentSessionKey }
          );
          await api.runtime.system.requestHeartbeatNow({});
        } catch (e) {
          api.logger.error?.(`[task-monitor] Failed to forward event to parent: ${e}`);
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in onAgentEvent handler: ${e}`);
      }
    });

    // ==================== 监听 Transcript 更新 (v6: 子任务详细进度转发) ====================
    // transcript 节流控制（独立于 agent event）
    const transcriptLastSentMap = new Map<string, number>();
    
    // 主任务追踪（用于检测任务完成）
    const mainTaskTracking = new Map<string, { startTime: number; lastCheck: number }>();
    
    api.runtime.events.onSessionTranscriptUpdate(async (update) => {
      try {
        if (!streamConfig.streamToParent) return;
        
        const sessionFile = update.sessionFile;
        api.logger.info?.(`[task-monitor] Transcript update received: ${sessionFile}`);
        
        // 1. 从 sessions.json 查找 sessionKey
        const sessionKey = await findSessionKeyByFile(sessionFile);
        if (!sessionKey) {
          api.logger.info?.(`[task-monitor] No sessionKey found for file: ${sessionFile}`);
          return;
        }
        
        // 2. 判断是否是主任务会话
        if (!isSubagentSessionKey(sessionKey)) {
          // 主任务处理：检测任务开始和完成
          api.logger.info?.(`[task-monitor] Main task transcript detected: ${sessionKey}`);
          
          // 更新 StateManager heartbeat（防止误判超时）
          await stateManager?.heartbeat(sessionKey);
          
          // 更新任务频道映射
          const channelInfo = getSessionChannelInfo(sessionKey);
          if (channelInfo) {
            taskChannelMap.set(sessionKey, channelInfo);
            api.logger.info?.(`[task-monitor] Task channel updated: ${sessionKey} -> ${channelInfo.channel}:${channelInfo.target}`);
          }
          
          // 读取最后几条消息
          const messages = await readLastMessages(sessionFile, 5);
          if (messages.length === 0) return;
          
          // 检测任务完成：查找包含"任务完成"或类似标记的消息
          const lastUserMsg = messages.filter(m => m.role === 'user').pop();
          const lastAssistantMsg = messages.filter(m => m.role === 'assistant').pop();
          
          // 判断是否是任务完成（基于 assistant 消息内容）
          if (lastAssistantMsg) {
            const content = JSON.stringify(lastAssistantMsg.content || '');
            const isCompletion = content.includes('任务完成') || 
                                 content.includes('✅') ||
                                 content.includes('已完成') ||
                                 content.includes('DONE');
            
            // 获取或创建任务追踪
            let tracking = mainTaskTracking.get(sessionKey);
            if (!tracking) {
              tracking = { startTime: Date.now(), lastCheck: Date.now() };
              mainTaskTracking.set(sessionKey, tracking);
              
              // 创建任务文件
              const taskName = `main-${sessionKey.split(':').pop()}-${new Date().toISOString().slice(0,16).replace(/[:.]/g, '-')}`;
              const taskFilePath = path.join(TASKS_DIR, "running", `${taskName}.md`);
              
              if (!fs.existsSync(taskFilePath)) {
                const taskContent = `# 主任务记录

**任务ID**: ${sessionKey}
**状态**: running
**开始时间**: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
**来源**: transcript 检测（lifecycle 事件不可用）

---
*此文件由 task-monitor 自动创建*
`;
                fs.mkdirSync(path.dirname(taskFilePath), { recursive: true });
                fs.writeFileSync(taskFilePath, taskContent);
                api.logger.info?.(`[task-monitor] Main task file created: ${taskName}`);
              }
            }
            
            // 如果检测到完成
            if (isCompletion && tracking) {
              const elapsed = Date.now() - tracking.startTime;
              // 避免误判：至少 30 秒
              if (elapsed > 30000) {
                api.logger.info?.(`[task-monitor] Main task completion detected: ${sessionKey}`);
                
                // 更新 StateManager
                await stateManager?.updateTask(sessionKey, { 
                  status: 'completed',
                  metadata: { completedAt: Date.now() }
                });
                
                // 发送完成通知
                const taskName = sessionKey.split(':').pop() || 'unknown';
                const alertId = `main_completed_${taskName}`;
                
                if (alertManager?.shouldAlert(alertId, "main_completed")) {
                  const notifyMessage = `✅ 主任务完成\n\n任务: ${taskName}\n时间: ${new Date().toLocaleString("zh-CN")}`;
                  try {
                    execSync(
                      `openclaw message send --channel "${config.notification.channel}" --target "${config.notification.target}" --message "${notifyMessage.replace(/\n/g, '\\n')}"`,
                      { timeout: 15000, stdio: 'pipe' }
                    );
                    alertManager.recordAlert(alertId, "main_completed");
                    api.logger.info?.(`[task-monitor] Main task completion notification sent: ${taskName}`);
                  } catch (e) {
                    api.logger.error?.(`[task-monitor] Failed to send completion notification: ${e}`);
                  }
                }
                
                // 清理追踪
                mainTaskTracking.delete(sessionKey);
              }
            }
            
            tracking.lastCheck = Date.now();
          }
          
          return; // 主任务处理完毕
        }
        
        api.logger.info?.(`[task-monitor] Subagent transcript detected: ${sessionKey}`);
        
        // 3. 节流检查
        const now = Date.now();
        const lastSent = transcriptLastSentMap.get(sessionKey) || 0;
        if (now - lastSent < streamConfig.throttle) {
          return;
        }
        
        // 4. 获取父会话 key
        const parentSessionKey = resolveThreadParentSessionKey(sessionKey);
        api.logger.info?.(`[task-monitor] Parent sessionKey resolved: ${parentSessionKey}`);
        if (!parentSessionKey) {
          api.logger.info?.(`[task-monitor] No parent sessionKey for: ${sessionKey}`);
          return;
        }
        
        // 5. 读取最新消息
        const messages = await readLastMessages(sessionFile, 2);
        api.logger.info?.(`[task-monitor] Read ${messages.length} messages from transcript`);
        if (messages.length === 0) {
          return;
        }
        
        // 6. 格式化消息
        const formattedMessages: string[] = [];
        for (const msgObj of messages) {
          const formatted = formatTranscriptMessage(msgObj, streamConfig);
          if (formatted) {
            formattedMessages.push(formatted);
          }
        }
        
        api.logger.info?.(`[task-monitor] Formatted ${formattedMessages.length} messages`);
        if (formattedMessages.length === 0) {
          return;
        }
        
        // 7. 更新节流时间戳
        transcriptLastSentMap.set(sessionKey, now);
        
        // 8. 发送到父会话
        const depth = getSubagentDepth(sessionKey);
        const indent = depth > 1 ? "  ".repeat(depth - 1) : "";
        const message = formattedMessages.map(m => `${indent}${m}`).join("\n");
        
        try {
          await api.runtime.system.enqueueSystemEvent(
            `[子任务进度] ${message}`,
            { sessionKey: parentSessionKey }
          );
          await api.runtime.system.requestHeartbeatNow({});
          api.logger.debug?.(`[task-monitor] Transcript forwarded to parent: ${sessionKey} -> ${parentSessionKey}`);
        } catch (e) {
          api.logger.error?.(`[task-monitor] Failed to forward transcript: ${e}`);
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in onSessionTranscriptUpdate handler: ${e}`);
      }
    });

    // ==================== 监听 subagent_spawned 事件 ====================
    api.on("subagent_spawned", async (event) => {
      try {
        const data = event as SubagentSpawnedPayload;
        api.logger.info?.(`[task-monitor] Subagent spawned: ${data.runId} - ${data.label || "no label"}`);

        if (!stateManager || !taskChainManager) return;

        // 判断是否是主任务派发（通过 sessionKey 判断）
        const isMainTask = !data.childSessionKey.includes(":subagent:");
        
        if (isMainTask) {
          // 创建任务链
          try {
            await taskChainManager.createTaskChain({
              mainTaskId: data.runId,
              mainSessionKey: data.childSessionKey,
              userId: "main", // 可以从 session 中提取用户 ID
              label: data.label || data.taskDescription,
            });
            api.logger.info?.(`[task-monitor] Task chain created: ${data.runId}`);
          } catch (e: any) {
            if (!e.message?.includes("已存在")) {
              api.logger.error?.(`[task-monitor] Failed to create task chain: ${e}`);
            }
          }
        } else {
          // 查找父任务链并添加子任务
          // childSessionKey 格式: "agent:main:subagent:xxx:subagent:yyy"
          // 需要找到直接父任务的 sessionKey
          const parts = data.childSessionKey.split(":subagent:");
          if (parts.length >= 2) {
            // 父会话 key 是去掉最后一个 :subagent:xxx 的部分
            const parentSessionKey = parts.slice(0, -1).join(":subagent:");
            const parentChain = await taskChainManager.findChainBySessionKey(parentSessionKey);
            
            if (parentChain) {
              await taskChainManager.addSubtask(parentChain.mainTaskId, {
                runId: data.runId,
                sessionKey: data.childSessionKey,
                label: data.label || data.taskDescription || "",
              });
              api.logger.info?.(`[task-monitor] Subtask added to chain ${parentChain.mainTaskId}: ${data.runId}`);
            }
          }
        }

        // 检查任务是否已存在（重试场景）
        const existingTask = await stateManager.getTask(data.runId);
        if (existingTask) {
          // 更新现有任务状态
          await stateManager.updateTask(data.runId, { status: "running" });
          api.logger.info?.(`[task-monitor] Task re-activated for retry: ${data.runId}`);
          return;
        }

        // 注册新任务到状态管理器
        const task = await stateManager.registerTask({
          id: data.runId,
          type: "sub",
          status: "running",
          timeoutMs: config.monitoring.subtaskTimeout,
          parentTaskId: null,
          metadata: {
            label: data.label,
            agentId: data.agentId,
            mode: data.mode,
            childSessionKey: data.childSessionKey,
            taskDescription: data.taskDescription || data.label,
            isMainTask,
          },
        });

        api.logger.info?.(`[task-monitor] Task registered: ${task.id}`);

        // ==================== 启动进度报告定时器 ====================
        if (config.progress.enabled) {
          const taskLabel = data.label || data.taskDescription || data.runId;
          const progressTimer = setInterval(async () => {
            try {
              const currentTask = await stateManager?.getTask(data.runId);
              if (!currentTask) {
                // 任务不存在，停止定时器
                clearInterval(progressTimer);
                progressReporters.delete(data.runId);
                return;
              }

              const runtime = Math.floor((Date.now() - currentTask.startTime) / 60000);
              await alertManager?.sendAlert(
                `progress_${data.runId}`,
                `⏳ 子任务执行中\n\n任务: ${taskLabel}\n运行时间: ${runtime} 分钟\n状态: ${currentTask.status}`,
                "progress"
              );
            } catch (e) {
              api.logger.error?.(`[task-monitor] Progress report error: ${e}`);
            }
          }, config.progress.reportInterval);

          progressReporters.set(data.runId, progressTimer);
          api.logger.info?.(`[task-monitor] Progress reporter started for: ${data.runId}`);
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in subagent_spawned hook: ${e}`);
      }
    });

    // ==================== 监听 subagent_ended 事件 (v3 自动重试) ====================
    api.on("subagent_ended", async (event) => {
      try {
        const data = event as SubagentEndedPayload;
        api.logger.info?.(`[task-monitor] Subagent ended: ${data.runId} - outcome: ${data.outcome}`);

        const runId = data.runId;
        if (!runId || !stateManager) return;

        // ==================== 停止进度报告定时器 ====================
        const progressTimer = progressReporters.get(runId);
        if (progressTimer) {
          clearInterval(progressTimer);
          progressReporters.delete(runId);
          api.logger.info?.(`[task-monitor] Progress reporter stopped for: ${runId}`);
        }

        // 更新任务链中的子任务状态
        if (taskChainManager) {
          const chain = await taskChainManager.findChainBySubtaskRunId(runId);
          if (chain) {
            const status = data.outcome === "ok" ? "completed" : 
                          data.outcome === "timeout" ? "timeout" : "failed";
            await taskChainManager.updateSubtask(chain.mainTaskId, runId, {
              status,
              endedAt: data.endedAt || Date.now(),
            });
            api.logger.info?.(`[task-monitor] Subtask status updated in chain ${chain.mainTaskId}: ${runId} -> ${status}`);
          }
        }

        // 获取任务信息
        const task = await stateManager.getTask(runId);
        if (!task) {
          api.logger.warn?.(`[task-monitor] Task not found: ${runId}`);
          return;
        }

        const label = task.metadata?.label || runId;
        const isKilled = data.outcome === "killed";

        // === 情况 1: 成功完成 ===
        if (data.outcome === "ok") {
          await stateManager.updateTask(runId, { status: "completed" });
          await stateManager.recordRetryOutcome(runId, "ok");
          await sendNotification("task_completed", `✅ 子任务完成\n\n任务: ${label}\n重试次数: ${task.retryCount}`);

          // 通知父会话
          try {
            await api.runtime.system.enqueueSystemEvent(
              `[Task Monitor] Subagent ${runId} completed successfully`,
              { sessionKey: data.targetSessionKey }
            );
            await api.runtime.system.requestHeartbeatNow({});
          } catch (e) {
            api.logger.error?.(`[task-monitor] Failed to notify parent: ${e}`);
          }
          return;
        }

        // === 情况 2: 用户终止 (不可重试) ===
        if (isKilled) {
          await stateManager.updateTask(runId, { status: "killed" });
          await stateManager.cancelScheduledRetry(runId);
          await sendNotification("task_killed", `🛑 子任务已终止\n\n任务: ${label}`);
          return;
        }

        // === 情况 3: 失败或超时 (可重试) ===
        const outcome = data.outcome as "error" | "timeout";
        await stateManager.updateTask(runId, { status: outcome === "timeout" ? "timeout" : "failed" });
        await stateManager.recordRetryOutcome(runId, outcome, data.error);

        // ==================== 实时上报失败 ====================
        // 立即发送失败通知（不等待重试决策）
        const failureMessage = data.error || outcome;
        await sendNotification(
          outcome === "timeout" ? "subtask_timeout_realtime" : "subtask_failed_realtime",
          `🚨 子任务${outcome === "timeout" ? "超时" : "失败"} (实时告警)\n\n` +
          `任务: ${label}\n` +
          `原因: ${failureMessage.slice(0, 200)}`
        );
        api.logger.warn?.(`[task-monitor] Subagent failed (real-time report): ${runId}, outcome: ${outcome}`);

        // 检查是否应该重试
        const shouldRetry = await stateManager.shouldRetry(runId);

        if (shouldRetry) {
          // 安排重试
          const schedule = await stateManager.scheduleRetry(runId);
          api.logger.info?.(`[task-monitor] Retry scheduled: ${runId} at ${new Date(schedule.scheduledTime).toISOString()}`);

          await sendNotification(
            "retry_scheduled",
            `⚠️ 子任务${outcome === "timeout" ? "超时" : "失败"}，已安排重试\n\n` +
            `任务: ${label}\n` +
            `重试次数: ${task.retryCount + 1}/${task.maxRetries}\n` +
            `预计执行: ${new Date(schedule.scheduledTime).toLocaleString("zh-CN")}`
          );
        } else {
          // 重试耗尽，放弃任务
          await stateManager.abandonTask(runId);
          await sendNotification(
            "task_failed",
            `❌ 子任务最终失败\n\n` +
            `任务: ${label}\n` +
            `重试次数: ${task.retryCount}/${task.maxRetries}\n` +
            `原因: ${data.error || outcome}`
          );
        }

        // 通知父会话
        try {
          await api.runtime.system.enqueueSystemEvent(
            `[Task Monitor] Subagent ${runId} ended with outcome: ${data.outcome}, retry: ${shouldRetry}`,
            { sessionKey: data.targetSessionKey }
          );
          await api.runtime.system.requestHeartbeatNow({});
        } catch (e) {
          api.logger.error?.(`[task-monitor] Failed to notify parent: ${e}`);
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in subagent_ended hook: ${e}`);
      }
    });

    // ==================== 监听 exec 进程 (v12: before_tool_call/after_tool_call hooks) ====================
    // 追踪正在执行的 exec 任务
    const execTasks = new Map<string, { startTime: number; command: string; runId?: string; sessionKey?: string }>();

    api.on("before_tool_call", async (event) => {
      try {
        // 只监控 Bash/exec 相关工具
        if (event.toolName !== "Bash" && event.toolName !== "exec") return;

        const params = event.params as { command?: string; timeout?: number };
        const command = params.command || "unknown command";
        const execId = event.toolCallId || `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        api.logger.info?.(`[task-monitor] Exec started: ${execId}, command: ${command.slice(0, 100)}`);

        // 记录到追踪 map
        execTasks.set(execId, {
          startTime: Date.now(),
          command,
          runId: event.runId,
          sessionKey: (event as any).sessionKey,
        });

        // 注册到状态管理器（设置最小 timeout 为 30 秒，避免立即超时）
        if (stateManager) {
          const minTimeout = 30000; // 30 秒最小超时
          const execTimeout = Math.max(params.timeout || 0, minTimeout);
          
          // 获取当前任务的频道信息
          const sessionKey = (event as any).sessionKey;
          const channelInfo = sessionKey ? getSessionChannelInfo(sessionKey) : null;
          
          try {
            await stateManager.registerTask({
              id: execId,
              type: "exec",
              status: "running",
              timeoutMs: execTimeout,
              parentTaskId: event.runId || null,
              metadata: {
                command: command.slice(0, 500),
                toolName: event.toolName,
                sessionKey: sessionKey,
                channel: channelInfo?.channel,
                target: channelInfo?.target,
              },
            });
          } catch (e: any) {
            if (!e.message?.includes("已存在")) {
              api.logger.error?.(`[task-monitor] Failed to register exec task: ${e}`);
            }
          }
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in before_tool_call hook: ${e}`);
      }
    });

    api.on("after_tool_call", async (event) => {
      try {
        // 只监控 Bash/exec 相关工具
        if (event.toolName !== "Bash" && event.toolName !== "exec") return;

        const execId = event.toolCallId || `exec-${Date.now()}`;
        const execTask = execTasks.get(execId);

        if (!execTask) {
          api.logger.debug?.(`[task-monitor] Exec task not found in tracking map: ${execId}`);
          return;
        }

        const duration = Date.now() - execTask.startTime;
        const isError = !!event.error;
        const isTimeout = event.error?.toLowerCase().includes("timeout") || false;

        api.logger.info?.(`[task-monitor] Exec ended: ${execId}, duration: ${duration}ms, error: ${isError}`);

        // 从追踪 map 移除
        execTasks.delete(execId);

        // 更新状态管理器
        if (stateManager) {
          const status = isError ? (isTimeout ? "timeout" : "failed") : "completed";
          await stateManager.updateTask(execId, {
            status,
            metadata: {
              command: execTask.command,
              duration,
              error: event.error,
            },
          });

          // 记录结果
          if (isError) {
            await stateManager.recordRetryOutcome(execId, isTimeout ? "timeout" : "error", event.error);
          } else {
            await stateManager.recordRetryOutcome(execId, "ok");
          }
        }

        // ==================== 实时上报失败 ====================
        if (isError) {
          const errorMessage = event.error || "Unknown error";
          const commandPreview = execTask.command.slice(0, 100);

          // 立即发送失败通知
          await sendNotification(
            isTimeout ? "exec_timeout" : "exec_failed",
            `⚠️ Exec ${isTimeout ? "超时" : "失败"}\n\n` +
            `命令: ${commandPreview}\n` +
            `执行时长: ${Math.floor(duration / 1000)}秒\n` +
            `错误: ${errorMessage.slice(0, 200)}`
          );

          api.logger.warn?.(`[task-monitor] Exec failed (real-time report): ${execId}, error: ${errorMessage.slice(0, 100)}`);
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Error in after_tool_call hook: ${e}`);
      }
    });

    // ==================== 清理定时器 ====================
    const cleanup = async () => {
      clearInterval(timeoutChecker);
      clearInterval(retryChecker);
      clearInterval(cleanupChecker);
      clearInterval(queueFlushTimer);
      // 清理所有进度报告定时器
      for (const [runId, timer] of progressReporters) {
        clearInterval(timer);
        progressReporters.delete(runId);
      }
      // 清理 InterruptHandler
      interruptHandler.shutdown();
      // 清理 MessageQueue 定时器
      messageQueue.stopPeriodicCheck();
      // 清理 MemoryManager
      await memoryManager.destroy();
      api.logger.info?.("[task-monitor] Cleanup complete");
    };

    process.on("SIGTERM", () => { cleanup(); });
    process.on("SIGINT", () => { cleanup(); });
    
    // #17: 异常退出时也清理定时器
    process.on("uncaughtException", (error) => {
      api.logger.error?.("[task-monitor] Uncaught exception:", error);
      cleanup();
    });
    
    process.on("unhandledRejection", (reason) => {
      api.logger.error?.("[task-monitor] Unhandled rejection:", reason);
      cleanup();
    });

    api.logger.info?.("[task-monitor] Plugin registration complete (v12)");
  },
};

export default plugin;
