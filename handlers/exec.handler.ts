import { IHandler, IHandlerContext, ExecTaskInfo, OpenClawPluginApi } from "./interfaces";
import * as AsyncLock from "async-lock";

/**
 * Exec 事件处理器
 * 
 * 功能：
 * - 追踪 exec 进程执行状态
 * - 发送失败告警
 * 
 * 对照老代码：index.ts 第 1605-1770 行
 */
export class ExecHandler implements IHandler {
  private context: IHandlerContext;
  private execTasks: Map<string, ExecTaskInfo> = new Map();
  private mapLock: AsyncLock;

  constructor(context: IHandlerContext) {
    this.context = context;
    this.mapLock = context.mapLock;
  }

  register(api: OpenClawPluginApi): void {
    // 监听 before_tool_call 事件
    api.on("before_tool_call", async (event: any) => {
      await this.handleBeforeToolCall(api, event);
    });

    // 监听 after_tool_call 事件
    api.on("after_tool_call", async (event: any) => {
      await this.handleAfterToolCall(api, event);
    });
  }

  /**
   * 处理 before_tool_call 事件
   */
  private async handleBeforeToolCall(api: OpenClawPluginApi, event: any): Promise<void> {
    try {
      // 只监控 Bash/exec 相关工具
      if (event.toolName !== "Bash" && event.toolName !== "exec") return;

      const params = event.params as { command?: string; timeout?: number };
      const command = params.command || "unknown command";
      const execId = event.toolCallId || `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      api.logger.info?.(`[ExecHandler] Exec started: ${execId}, command: ${command.slice(0, 100)}`);

      // 获取当前任务的频道信息
      const sessionKey = (event as any).sessionKey;
      const channelInfo = sessionKey ? this.getSessionChannelInfo(sessionKey) : null;

      // 记录到追踪 map（加锁保护）
      await this.mapLock.acquire('execTasks', () => {
        this.execTasks.set(execId, {
          startTime: Date.now(),
          command,
          runId: event.runId,
          sessionKey: sessionKey,
          channel: channelInfo?.channel,
          target: channelInfo?.target,
        });
      });

      // 注册到状态管理器（设置最小 timeout 为 30 秒，避免立即超时）
      if (this.context.stateManager) {
        const minTimeout = 30000; // 30 秒最小超时
        const execTimeout = Math.max(params.timeout || 0, minTimeout);
        
        try {
          await this.context.stateManager.registerTask({
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
            api.logger.error?.(`[ExecHandler] Failed to register exec task: ${e}`);
          }
        }
      }
    } catch (e) {
      api.logger.error?.(`[ExecHandler] Error in before_tool_call hook: ${e}`);
    }
  }

  /**
   * 处理 after_tool_call 事件
   */
  private async handleAfterToolCall(api: OpenClawPluginApi, event: any): Promise<void> {
    try {
      // 只监控 Bash/exec 相关工具
      if (event.toolName !== "Bash" && event.toolName !== "exec") return;

      const execId = event.toolCallId || `exec-${Date.now()}`;
      const execTask = this.execTasks.get(execId);

      if (!execTask) {
        api.logger.debug?.(`[ExecHandler] Exec task not found in tracking map: ${execId}`);
        return;
      }

      const duration = Date.now() - execTask.startTime;
      const isError = !!event.error;
      const isTimeout = event.error?.toLowerCase().includes("timeout") || false;

      api.logger.info?.(`[ExecHandler] Exec ended: ${execId}, duration: ${duration}ms, error: ${isError}`);

      // 从追踪 map 移除（加锁保护）
      await this.mapLock.acquire('execTasks', () => {
        this.execTasks.delete(execId);
      });

      // 更新状态管理器
      if (this.context.stateManager) {
        const status = isError ? (isTimeout ? "timeout" : "failed") : "completed";
        await this.context.stateManager.updateTask(execId, {
          status,
          metadata: {
            command: execTask.command,
            duration,
            error: event.error,
          },
        });

        // 记录结果
        if (isError) {
          await this.context.stateManager.recordRetryOutcome(execId, isTimeout ? "timeout" : "error", event.error);
        } else {
          await this.context.stateManager.recordRetryOutcome(execId, "ok");
        }
      }

      // ==================== 实时上报失败 ====================
      if (isError) {
        const errorMessage = event.error || "Unknown error";
        const commandPreview = execTask.command.slice(0, 100);

        // 立即发送失败通知
        await this.sendNotification(
          api,
          isTimeout ? "exec_timeout" : "exec_failed",
          `⚠️ Exec ${isTimeout ? "超时" : "失败"}\n\n` +
          `命令: ${commandPreview}\n` +
          `执行时长: ${Math.floor(duration / 1000)}秒\n` +
          `错误: ${errorMessage.slice(0, 200)}`,
          execTask.channel,
          execTask.target
        );
      }
    } catch (e) {
      api.logger.error?.(`[ExecHandler] Error in after_tool_call hook: ${e}`);
    }
  }

  /**
   * 发送通知
   */
  private async sendNotification(
    api: OpenClawPluginApi,
    type: string,
    message: string,
    channel?: string,
    target?: string
  ): Promise<void> {
    try {
      const notifyChannel = channel || this.context.config.notification.channel;
      const notifyTarget = target || this.context.config.notification.target;

      const { execSync } = require("child_process");
      execSync(
        `openclaw message send --channel "${notifyChannel}" --target "${notifyTarget}" --message "${message.replace(/\n/g, '\\n')}"`,
        { timeout: 15000, stdio: 'pipe' }
      );
      api.logger.info?.(`[ExecHandler] Notification sent: ${type}`);
    } catch (e) {
      api.logger.error?.(`[ExecHandler] Failed to send notification: ${e}`);
    }
  }

  /**
   * 获取会话频道信息
   */
  private getSessionChannelInfo(sessionKey: string): { channel: string; target: string } | null {
    // 从 taskChannelMap 获取
    const info = this.context.taskChannelMap.get(sessionKey);
    if (info) return info;

    // 从 sessionKey 提取
    const parts = sessionKey.split(":");
    if (parts.length >= 4) {
      const channel = parts[2]; // 例如 "telegram", "wecom"
      const target = parts[4] || parts[3]; // 例如用户 ID
      return { channel, target };
    }

    return null;
  }
}
