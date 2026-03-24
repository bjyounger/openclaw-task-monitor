import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import * as readline from "readline";
import { StateManager, AlertManager, TaskChainManager, type TaskState, type ScheduledRetry } from "./lib";

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

const TASKS_DIR = path.join(process.env.HOME || "/root", ".openclaw/workspace/memory/tasks");
const STATE_DIR = path.join(process.env.HOME || "/root", ".openclaw/extensions/task-monitor/state");
const CONFIG_PATH = path.join(__dirname, "config.json");

// 子任务反馈配置
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

// 默认配置
const defaultConfig: StreamConfig = {
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

// 加载配置
function loadConfig(): StreamConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const configData = fs.readFileSync(CONFIG_PATH, "utf-8");
      const config = JSON.parse(configData);
      return { ...defaultConfig, ...config };
    }
  } catch (e) {
    console.error("[task-monitor] Failed to load config, using defaults:", e);
  }
  return defaultConfig;
}

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
  taskDescription: string
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
      timeout: 300000, // 5 分钟超时
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
 */
async function sendNotification(alertType: string, message: string): Promise<void> {
  if (!alertManager) {
    console.error("[task-monitor] AlertManager not initialized");
    return;
  }
  
  try {
    await alertManager.sendAlert(alertType, message, alertType);
  } catch (e) {
    console.error("[task-monitor] Failed to send notification:", e);
  }
}

const plugin = {
  id: "task-monitor",
  name: "Task Monitor",
  description: "监控子任务生命周期、自动重试、任务链追踪、进度报告、主任务监控、停滞检测、超时检测（v9.1）",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    console.log("[task-monitor] Plugin registering (v9 with main task monitoring)...");
    api.logger.info?.("[task-monitor] Plugin registering (v9 with main task monitoring)...");

    // 初始化状态管理器
    stateManager = new StateManager(STATE_DIR);
    alertManager = new AlertManager(
      { channel: "wecom", target: "wecom-agent:YangKe" },
      path.join(STATE_DIR, "alert-records.json")
    );
    taskChainManager = new TaskChainManager(STATE_DIR);

    // ==================== 进度报告定时器存储 ====================
    const progressReporters = new Map<string, NodeJS.Timeout>();

    // ==================== 定时器 1: 超时检查 + 主任务完成检测 (每分钟) ====================
    const timeoutChecker = setInterval(async () => {
      if (!stateManager || !taskChainManager) return;
      try {
        // 任务超时检查
        const timedOutTasks = await stateManager.checkTimeouts();
        for (const task of timedOutTasks) {
          api.logger.warn?.(`[task-monitor] Task timeout: ${task.id}`);
          await alertManager?.sendAlert(
            task.id,
            `任务超时！类型: ${task.type}, 运行时间: ${Math.floor((Date.now() - task.startTime) / 60000)} 分钟`,
            "timeout"
          );
        }

        // 任务链超时检查
        const timedOutChains = await taskChainManager.checkTimeouts();
        for (const chain of timedOutChains) {
          api.logger.warn?.(`[task-monitor] Task chain timeout: ${chain.mainTaskId}`);
          await alertManager?.sendAlert(
            chain.mainTaskId,
            `任务链超时！\n\n主任务: ${chain.label || chain.mainTaskId}\n子任务数: ${chain.subtasks.length}\n运行时间: ${Math.floor((Date.now() - chain.createdAt) / 60000)} 分钟`,
            "chain_timeout"
          );
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
                
                // 发送通知（去重）
                await alertManager?.sendAlert(
                  `main_completed_${taskName}`,
                  `✅ 主任务完成\n\n任务: ${taskName}\n时间: ${new Date().toLocaleString("zh-CN")}`,
                  "main_completed"
                );
                
                // 移动到 completed 目录
                if (fs.existsSync(completedDir)) {
                  const targetPath = path.join(completedDir, file);
                  if (!fs.existsSync(targetPath)) {
                    fs.renameSync(filePath, targetPath);
                    api.logger.info?.(`[task-monitor] Task file moved to completed: ${file}`);
                  }
                }
              }
              // ==================== 停滞任务检测 ====================
              else if ((content.includes("**状态**: pending") || content.includes("状态: pending")) && elapsed > 1800) {
                // pending 状态超过 30 分钟
                const taskName = file.replace(".md", "");
                await alertManager?.sendAlert(
                  `stalled_pending_${taskName}`,
                  `⚠️ 任务停滞\n\n任务: ${taskName}\n状态: pending\n停滞时间: ${Math.floor(elapsed / 60)} 分钟\n原因: 任务创建后未开始执行`,
                  "stalled_pending"
                );
                api.logger.warn?.(`[task-monitor] Stalled task detected (pending): ${file}`);
              }
              // ==================== 任务状态一致性检测 ====================
              else if ((content.includes("**状态**: running") || content.includes("状态: running")) && elapsed > 600) {
                // running 状态超过 10 分钟，检查是否有对应的子任务
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
              // ==================== 主任务超时检测 (v8 新增) ====================
              // pending 状态超过 60 分钟视为超时
              else if ((content.includes("**状态**: pending") || content.includes("状态: pending")) && elapsed > 3600) {
                const taskName = file.replace(".md", "");
                await alertManager?.sendAlert(
                  `main_task_timeout_${taskName}`,
                  `⏰ 主任务超时\n\n任务: ${taskName}\n状态: pending\n运行时间: ${Math.floor(elapsed / 60)} 分钟\n原因: 任务创建后长时间未开始`,
                  "main_task_timeout"
                );
                api.logger.warn?.(`[task-monitor] Main task timeout (pending): ${file}`);
              }
              // running 状态超过 60 分钟视为超时
              else if ((content.includes("**状态**: running") || content.includes("状态: running")) && elapsed > 3600) {
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
    }, 60000);

    // ==================== 定时器 2: 重试调度检查 (每 10 秒) ====================
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

            await executeRetrySafely(retry.runId, agentId, taskDescription);
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
    }, 10000); // 每 10 秒检查一次

    // ==================== 加载配置 ====================
    const streamConfig = loadConfig();
    api.logger.info?.(`[task-monitor] Stream config loaded: ${JSON.stringify(streamConfig)}`);

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
          if (phase === "turn_started") {
            // 排除子任务
            if (evt.sessionKey && !evt.sessionKey.includes(":subagent:")) {
              api.logger.info?.(`[task-monitor] Main task turn started: ${evt.sessionKey}`);
              
              // 5分钟后检查是否有任务记录
              setTimeout(async () => {
                const runningDir = path.join(TASKS_DIR, "running");
                if (fs.existsSync(runningDir)) {
                  const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));
                  // 检查是否有包含当前 sessionKey 的任务记录
                  const hasRecord = taskFiles.some(f => {
                    const content = fs.readFileSync(path.join(runningDir, f), "utf-8");
                    return content.includes(evt.sessionKey) || content.includes(evt.runId || "");
                  });
                  
                  if (!hasRecord && taskFiles.length === 0) {
                    await alertManager?.sendAlert(
                      `no_task_record_${evt.sessionKey?.slice(-8)}`,
                      `⚠️ 主任务未创建任务记录\n\nSession: ${evt.sessionKey}\n提示: 请在 memory/tasks/running/ 目录创建任务记录文件`,
                      "no_task_record"
                    );
                  }
                }
              }, 5 * 60 * 1000); // 5分钟后检查
            }
          }
          
          // 处理 turn_ended 事件（主任务完成检测）
          if (phase === "turn_ended") {
            // 排除子任务
            if (evt.sessionKey && !evt.sessionKey.includes(":subagent:")) {
              api.logger.info?.(`[task-monitor] Main task turn ended: ${evt.sessionKey}`);
              
              // 发送通知
              await alertManager?.sendAlert(
                `main_turn_${evt.runId || Date.now()}`,
                `✅ 主任务对话完成\n\nSession: ${evt.sessionKey}\n时间: ${new Date().toLocaleString("zh-CN")}`,
                "main_turn"
              );
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
    
    api.runtime.events.onSessionTranscriptUpdate(async (update) => {
      try {
        if (!streamConfig.streamToParent) return;
        
        const sessionFile = update.sessionFile;
        api.logger.debug?.(`[task-monitor] Transcript update: ${sessionFile}`);
        
        // 1. 从 sessions.json 查找 sessionKey
        const sessionKey = await findSessionKeyByFile(sessionFile);
        if (!sessionKey) {
          api.logger.debug?.(`[task-monitor] No sessionKey found for file: ${sessionFile}`);
          return;
        }
        
        // 2. 判断是否是子任务会话
        if (!isSubagentSessionKey(sessionKey)) {
          return; // 不是子任务，忽略
        }
        
        // 3. 节流检查
        const now = Date.now();
        const lastSent = transcriptLastSentMap.get(sessionKey) || 0;
        if (now - lastSent < streamConfig.throttle) {
          return;
        }
        
        // 4. 获取父会话 key
        const parentSessionKey = resolveThreadParentSessionKey(sessionKey);
        if (!parentSessionKey) {
          api.logger.debug?.(`[task-monitor] No parent sessionKey for: ${sessionKey}`);
          return;
        }
        
        // 5. 读取最新消息
        const messages = await readLastMessages(sessionFile, 2);
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
          timeoutMs: 600000, // 默认 10 分钟超时
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
        }, 60000); // 每分钟报告

        progressReporters.set(data.runId, progressTimer);
        api.logger.info?.(`[task-monitor] Progress reporter started for: ${data.runId}`);
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

    // ==================== 清理定时器 ====================
    const cleanup = () => {
      clearInterval(timeoutChecker);
      clearInterval(retryChecker);
      // 清理所有进度报告定时器
      for (const [runId, timer] of progressReporters) {
        clearInterval(timer);
        progressReporters.delete(runId);
      }
      api.logger.info?.("[task-monitor] Cleanup complete");
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    api.logger.info?.("[task-monitor] Plugin registration complete (v9.1)");
  },
};

export default plugin;
