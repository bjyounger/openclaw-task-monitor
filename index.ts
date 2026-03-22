import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import * as path from "path";
import { spawn } from "child_process";
import { StateManager, AlertManager, type TaskState, type ScheduledRetry } from "./lib";

const TASKS_DIR = path.join(process.env.HOME || "/root", ".openclaw/workspace/memory/tasks");
const STATE_DIR = path.join(process.env.HOME || "/root", ".openclaw/extensions/task-monitor/state");

// 初始化管理器
let stateManager: StateManager | null = null;
let alertManager: AlertManager | null = null;

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
 * 发送通知
 */
async function sendNotification(message: string): Promise<void> {
  try {
    const { execSync } = await import("child_process");
    execSync(
      `openclaw message send --channel wecom --target "wecom-agent:YangKe" --message "${message}"`,
      { timeout: 5000 }
    );
  } catch (e) {
    console.error("[task-monitor] Failed to send notification:", e);
  }
}

const plugin = {
  id: "task-monitor",
  name: "Task Monitor",
  description: "监控子任务生命周期并自动重试（v3）",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    console.log("[task-monitor] Plugin registering (v3 with auto-retry)...");
    api.logger.info?.("[task-monitor] Plugin registering (v3 with auto-retry)...");

    // 初始化状态管理器
    stateManager = new StateManager(STATE_DIR);
    alertManager = new AlertManager(
      { channel: "wecom", target: "wecom-agent:YangKe" },
      path.join(STATE_DIR, "alert-records.json")
    );

    // ==================== 定时器 1: 超时检查 (每分钟) ====================
    const timeoutChecker = setInterval(async () => {
      if (!stateManager) return;
      try {
        const timedOutTasks = await stateManager.checkTimeouts();
        for (const task of timedOutTasks) {
          api.logger.warn?.(`[task-monitor] Task timeout: ${task.id}`);
          await alertManager?.sendAlert(
            task.id,
            `任务超时！类型: ${task.type}, 运行时间: ${Math.floor((Date.now() - task.startTime) / 60000)} 分钟`,
            "timeout"
          );
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
          await sendNotification(`🔄 开始重试子任务\n\n任务: ${label}\n重试次数: ${retry.retryCount}/${task.maxRetries}`);

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
              await sendNotification(`❌ 任务最终失败\n\n任务: ${label}\n重试耗尽，已放弃`);
            }
          }
        }
      } catch (e) {
        api.logger.error?.(`[task-monitor] Retry check error: ${e}`);
      }
    }, 10000); // 每 10 秒检查一次

    // ==================== 监听 subagent_spawned 事件 ====================
    api.on("subagent_spawned", async (event) => {
      try {
        const data = event as SubagentSpawnedPayload;
        api.logger.info?.(`[task-monitor] Subagent spawned: ${data.runId} - ${data.label || "no label"}`);

        if (!stateManager) return;

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
          },
        });

        api.logger.info?.(`[task-monitor] Task registered: ${task.id}`);
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
          await sendNotification(`✅ 子任务完成\n\n任务: ${label}\n重试次数: ${task.retryCount}`);

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
          await sendNotification(`🛑 子任务已终止\n\n任务: ${label}`);
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
            `⚠️ 子任务${outcome === "timeout" ? "超时" : "失败"}，已安排重试\n\n` +
            `任务: ${label}\n` +
            `重试次数: ${task.retryCount + 1}/${task.maxRetries}\n` +
            `预计执行: ${new Date(schedule.scheduledTime).toLocaleString("zh-CN")}`
          );
        } else {
          // 重试耗尽，放弃任务
          await stateManager.abandonTask(runId);
          await sendNotification(
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
      api.logger.info?.("[task-monitor] Cleanup complete");
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    console.log("[task-monitor] Plugin registration complete (v3)");
    api.logger.info?.("[task-monitor] Plugin registration complete (v3)");
  },
};

export default plugin;
