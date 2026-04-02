import { IHandler, IHandlerContext, OpenClawPluginApi } from "./interfaces";
import * as AsyncLock from "async-lock";
import * as path from "path";
import * as fs from "fs";

/**
 * Agent 事件处理器
 * 
 * 功能：
 * - 处理 lifecycle 事件（turn_started, turn_ended, error）
 * - 处理 content_block 事件（子任务反馈流）
 * - 主任务自动创建记录
 * - 子任务事件转发到父会话
 * 
 * 对照老代码：index.ts 第 800-1100 行
 */
export class AgentEventHandler implements IHandler {
  private context: IHandlerContext;
  private mapLock: AsyncLock;
  
  // 节流控制
  private lastSentMap: Map<string, number> = new Map();
  
  // 流配置
  private streamConfig: any;

  constructor(context: IHandlerContext) {
    this.context = context;
    this.mapLock = context.mapLock;
    this.streamConfig = {
      streamToParent: true,
      streamFilter: {
        toolCalls: true,
        thinking: false,
        errors: true,
        progress: true,
      },
      throttle: context.config.notification.throttle || 5000,
      maxMessageLength: context.config.notification.maxMessageLength || 4000,
      showTimestamp: false,
    };
  }

  register(api: OpenClawPluginApi): void {
    api.runtime.events.onAgentEvent(async (evt: any) => {
      await this.handleAgentEvent(api, evt);
    });
  }

  /**
   * 处理 Agent 事件
   */
  private async handleAgentEvent(api: OpenClawPluginApi, evt: any): Promise<void> {
    try {
      // 调试日志：检查事件是否触发
      api.logger.debug?.(
        `[AgentEventHandler] Event triggered: stream=${evt.stream}, runId=${evt.runId}, sessionKey=${evt.sessionKey || "empty"}`
      );

      // 1. 处理 lifecycle 事件
      if (evt.stream === "lifecycle") {
        await this.handleLifecycleEvent(api, evt);
        return; // lifecycle 事件处理完毕
      }

      // 2. 子任务反馈流式转发（新功能）
      await this.handleContentBlockEvent(api, evt);
    } catch (e) {
      api.logger.error?.(`[AgentEventHandler] Error in handler: ${e}`);
    }
  }

  /**
   * 处理 Lifecycle 事件
   */
  private async handleLifecycleEvent(api: OpenClawPluginApi, evt: any): Promise<void> {
    const phase = evt.data?.phase;

    // 处理 turn_started 事件（主任务开始 - 检查任务记录）
    // OpenClaw 发送 phase: "start"，不是 "turn_started"
    if (phase === "start" || phase === "turn_started") {
      await this.handleTurnStarted(api, evt);
    }

    // 处理 end 事件（主任务完成检测）
    if (phase === "end") {
      await this.handleTurnEnded(api, evt);
    }

    // 处理 error 事件（原有逻辑）
    if (phase === "error") {
      await this.handleError(api, evt);
    }
  }

  /**
   * 处理 turn_started 事件
   */
  private async handleTurnStarted(api: OpenClawPluginApi, evt: any): Promise<void> {
    // 排除子任务
    if (!evt.sessionKey || evt.sessionKey.includes(":subagent:")) {
      return;
    }

    api.logger.info?.(`[AgentEventHandler] Main task turn started: ${evt.sessionKey}`);

    // v10: 自动创建任务记录
    try {
      const TASKS_DIR = path.join(process.env.HOME || "/root", ".openclaw", "workspace", "memory", "tasks");
      const runningDir = path.join(TASKS_DIR, "running");

      // 确保 running 目录存在
      if (!fs.existsSync(runningDir)) {
        fs.mkdirSync(runningDir, { recursive: true });
      }

      // 检查是否已有该 sessionKey 的任务记录
      const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));
      const hasRecord = taskFiles.some(f => {
        const content = fs.readFileSync(path.join(runningDir, f), "utf-8");
        return content.includes(evt.sessionKey);
      });

      // 如果没有记录，自动创建
      if (!hasRecord) {
        const sessionShort = evt.sessionKey.split(":").pop() || evt.sessionKey.slice(-8);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const taskFileName = `main-${sessionShort}-${timestamp}.md`;
        const taskFilePath = path.join(runningDir, taskFileName);

        // 从事件数据中提取频道信息
        const eventData = evt.data;
        const channel = eventData?.inboundMeta?.channel || eventData?.channel || this.context.config.notification.channel;
        const senderId = eventData?.inboundMeta?.sender_id || eventData?.senderId || "unknown";

        // 确定通知目标（cron 任务使用默认配置）
        const notifyTarget = (senderId === "unknown" || !senderId)
          ? this.context.config.notification.target
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

        // 更新任务频道映射（加锁保护）
        await this.mapLock.acquire('taskChannelMap', () => {
          this.context.taskChannelMap.set(evt.sessionKey, { channel, target: notifyTarget });
        });

        api.logger.info?.(
          `[AgentEventHandler] Auto-created task record: ${taskFileName} (channel: ${channel}, notifyTarget: ${notifyTarget})`
        );
      }
    } catch (error) {
      api.logger.error?.(`[AgentEventHandler] Failed to create task record: ${error}`);
    }
  }

  /**
   * 处理 turn_ended 事件
   */
  private async handleTurnEnded(api: OpenClawPluginApi, evt: any): Promise<void> {
    // 排除子任务
    if (!evt.sessionKey || evt.sessionKey.includes(":subagent:")) {
      return;
    }

    api.logger.info?.(`[AgentEventHandler] Main task turn ended: ${evt.sessionKey}`);

    // v10: 自动更新任务状态为 completed
    try {
      const TASKS_DIR = path.join(process.env.HOME || "/root", ".openclaw", "workspace", "memory", "tasks");
      const runningDir = path.join(TASKS_DIR, "running");
      
      if (fs.existsSync(runningDir)) {
        const taskFiles = fs.readdirSync(runningDir).filter(f => f.endsWith(".md"));

        // 查找包含该 sessionKey 的任务记录
        for (const file of taskFiles) {
          const filePath = path.join(runningDir, file);
          let content = fs.readFileSync(filePath, "utf-8");

          if (content.includes(evt.sessionKey) && content.includes("**状态**: running")) {
            // 更新状态为 completed
            content = content.replace("**状态**: running", "**状态**: completed");

            // 添加完成日志
            const completedTime = new Date().toLocaleTimeString(
              "zh-CN",
              { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }
            );
            const logLine = `- ${completedTime} 任务完成\n`;

            // 在执行日志部分添加完成记录
            if (content.includes("## 执行日志")) {
              content = content.replace("## 执行日志\n", `## 执行日志\n${logLine}`);
            } else {
              content += `\n## 执行日志\n${logLine}`;
            }

            fs.writeFileSync(filePath, content, "utf-8");
            api.logger.info?.(`[AgentEventHandler] Updated task status to completed: ${file}`);

            // 从任务记录中直接读取频道和通知目标
            const channelMatch = content.match(/\*\*频道\*\*:\s*(\S+)/);
            const notifyTargetMatch = content.match(/\*\*通知目标\*\*:\s*(\S+)/);
            const taskChannel = channelMatch ? channelMatch[1] : this.context.config.notification.channel;
            const notifyTarget = notifyTargetMatch ? notifyTargetMatch[1] : this.context.config.notification.target;

            api.logger.info?.(
              `[AgentEventHandler] Sending completion notification to ${taskChannel}: ${notifyTarget}`
            );

            // 直接调用 message 命令发送通知
            const notifyMessage = `✅ 主任务对话完成\n\n任务: ${file.replace('.md', '')}\n时间: ${new Date().toLocaleString("zh-CN")}`;
            try {
              const { execSync } = require("child_process");
              execSync(
                `openclaw message send --channel "${taskChannel}" --target "${notifyTarget}" --message "${notifyMessage.replace(/\n/g, '\\n')}"`,
                { timeout: 15000, stdio: 'pipe' }
              );
              api.logger.info?.(
                `[AgentEventHandler] ✅ Notification sent to ${taskChannel}: ${notifyTarget}`
              );
            } catch (e) {
              api.logger.error?.(`[AgentEventHandler] Failed to send completion notification: ${e}`);
            }

            break;
          }
        }
      }
    } catch (error) {
      api.logger.error?.(`[AgentEventHandler] Failed to update task status: ${error}`);
    }
  }

  /**
   * 处理 error 事件
   */
  private async handleError(api: OpenClawPluginApi, evt: any): Promise<void> {
    const errorText = String(evt.data?.error || "");
    const isTimeout = /timed?out/i.test(errorText);

    if (isTimeout) {
      api.logger.warn?.(`[AgentEventHandler] Embedded run timeout detected: ${evt.runId}`);
      await this.context.alertManager?.sendAlert(
        evt.runId,
        `Embedded run 超时！\n\nrunId: ${evt.runId}\n错误: ${errorText}`,
        "embedded_timeout"
      );

      if (this.context.stateManager) {
        let task = await this.context.stateManager.getTask(evt.runId);
        if (!task) {
          task = await this.context.stateManager.registerTask({
            id: evt.runId,
            type: "embedded",
            status: "timeout",
            timeoutMs: 0,
            parentTaskId: null,
            metadata: { label: `Embedded run ${evt.runId}` },
          });
        }
        await this.context.stateManager.recordRetryOutcome(evt.runId, "timeout", errorText);
      }
    }
  }

  /**
   * 处理 ContentBlock 事件（子任务反馈流）
   */
  private async handleContentBlockEvent(api: OpenClawPluginApi, evt: any): Promise<void> {
    if (!this.streamConfig.streamToParent) return;

    // 只处理子任务的事件
    if (!evt.sessionKey || !evt.sessionKey.includes(":subagent:")) return;

    // 节流检查
    const now = Date.now();
    const lastSent = this.lastSentMap.get(evt.sessionKey) || 0;
    if (now - lastSent < this.streamConfig.throttle) return;

    // 查找任务链，获取父会话
    const chain = await this.context.taskChainManager?.findChainBySessionKey(evt.sessionKey);
    if (!chain) {
      // 可能是直接子任务，尝试从状态管理器获取
      const task = await this.context.stateManager?.getTask(evt.runId);
      if (!task?.metadata?.parentSessionKey) return;
    }

    // 格式化事件消息
    const message = this.formatAgentEvent(evt);
    if (!message) return; // 被过滤的事件

    // 更新节流时间戳（加锁保护）
    await this.mapLock.acquire('lastSentMap', () => {
      this.lastSentMap.set(evt.sessionKey, now);
    });

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
      api.logger.error?.(`[AgentEventHandler] Failed to forward event to parent: ${e}`);
    }
  }

  /**
   * 格式化 Agent 事件
   */
  private formatAgentEvent(evt: any): string | null {
    try {
      // 过滤不需要的事件
      if (!this.streamConfig.streamFilter.toolCalls && evt.stream === "tool_calls") {
        return null;
      }
      if (!this.streamConfig.streamFilter.thinking && evt.stream === "thinking") {
        return null;
      }
      if (!this.streamConfig.streamFilter.errors && evt.stream === "error") {
        return null;
      }
      if (!this.streamConfig.streamFilter.progress && evt.stream === "progress") {
        return null;
      }

      // 格式化消息
      const streamType = evt.stream || "unknown";
      const data = evt.data;

      if (typeof data === "string") {
        const truncated = data.length > this.streamConfig.maxMessageLength
          ? data.slice(0, this.streamConfig.maxMessageLength) + "..."
          : data;
        return `[${streamType}] ${truncated}`;
      }

      if (typeof data === "object") {
        const content = JSON.stringify(data);
        const truncated = content.length > this.streamConfig.maxMessageLength
          ? content.slice(0, this.streamConfig.maxMessageLength) + "..."
          : content;
        return `[${streamType}] ${truncated}`;
      }

      return `[${streamType}] ${String(data)}`;
    } catch (e) {
      return null;
    }
  }
}
