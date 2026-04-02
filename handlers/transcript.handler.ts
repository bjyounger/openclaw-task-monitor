import { IHandler, IHandlerContext, MainTaskTracking, OpenClawPluginApi } from "./interfaces";
import * as AsyncLock from "async-lock";
import * as path from "path";
import * as fs from "fs";

/**
 * Transcript 事件处理器
 * 
 * 功能：
 * - 主任务心跳更新
 * - 主任务完成检测
 * - 子任务进度转发
 * 
 * 对照老代码：index.ts 第 1200-1400 行
 */
export class TranscriptHandler implements IHandler {
  private context: IHandlerContext;
  private mapLock: AsyncLock;
  
  // transcript 节流控制
  private transcriptLastSentMap: Map<string, number> = new Map();
  
  // 主任务追踪
  private mainTaskTracking: Map<string, MainTaskTracking> = new Map();
  
  // 流配置
  private streamConfig: any;

  constructor(context: IHandlerContext) {
    this.context = context;
    this.mapLock = context.mapLock;
    this.streamConfig = {
      streamToParent: true,
      throttle: context.config.notification.throttle || 5000,
      maxMessageLength: context.config.notification.maxMessageLength || 4000,
    };
  }

  register(api: OpenClawPluginApi): void {
    api.runtime.events.onSessionTranscriptUpdate(async (update: any) => {
      await this.handleTranscriptUpdate(api, update);
    });
  }

  /**
   * 处理 Transcript 更新
   */
  private async handleTranscriptUpdate(api: OpenClawPluginApi, update: any): Promise<void> {
    try {
      if (!this.streamConfig.streamToParent) return;

      const sessionFile = update.sessionFile;
      api.logger.info?.(`[TranscriptHandler] Transcript update received: ${sessionFile}`);

      // 1. 从 sessions.json 查找 sessionKey
      const sessionKey = await this.findSessionKeyByFile(api, sessionFile);
      if (!sessionKey) {
        api.logger.info?.(`[TranscriptHandler] No sessionKey found for file: ${sessionFile}`);
        return;
      }

      // 2. 判断是否是主任务会话
      if (!this.isSubagentSessionKey(sessionKey)) {
        await this.handleMainTask(api, sessionKey, sessionFile);
        return;
      }

      // 3. 处理子任务
      await this.handleSubtask(api, sessionKey, sessionFile);
    } catch (e) {
      api.logger.error?.(`[TranscriptHandler] Error in handler: ${e}`);
    }
  }

  /**
   * 处理主任务
   */
  private async handleMainTask(api: OpenClawPluginApi, sessionKey: string, sessionFile: string): Promise<void> {
    api.logger.info?.(`[TranscriptHandler] Main task transcript detected: ${sessionKey}`);

    // 更新 StateManager heartbeat（防止误判超时）
    await this.context.stateManager?.heartbeat(sessionKey);

    // 更新任务频道映射（加锁保护）
    const channelInfo = this.getSessionChannelInfo(sessionKey);
    if (channelInfo) {
      await this.mapLock.acquire('taskChannelMap', () => {
        this.context.taskChannelMap.set(sessionKey, channelInfo);
      });
      api.logger.info?.(
        `[TranscriptHandler] Task channel updated: ${sessionKey} -> ${channelInfo.channel}:${channelInfo.target}`
      );
    }

    // 读取最后几条消息
    const messages = await this.readLastMessages(sessionFile, 5);
    if (messages.length === 0) return;

    // 检测任务完成：查找包含"任务完成"或类似标记的消息
    const lastAssistantMsg = messages.filter(m => m.role === 'assistant').pop();

    if (lastAssistantMsg) {
      const content = JSON.stringify(lastAssistantMsg.content || '');
      const isCompletion = content.includes('任务完成') ||
                           content.includes('✅') ||
                           content.includes('已完成') ||
                           content.includes('DONE');

      // 获取或创建任务追踪
      let tracking = this.mainTaskTracking.get(sessionKey);
      if (!tracking) {
        tracking = { startTime: Date.now(), lastCheck: Date.now() };
        await this.mapLock.acquire('mainTaskTracking', () => {
          this.mainTaskTracking.set(sessionKey, tracking!);
        });

        // 创建任务文件（如果不存在）
        await this.createTaskFile(api, sessionKey);
      }

      // 如果检测到完成
      if (isCompletion && tracking) {
        const elapsed = Date.now() - tracking.startTime;
        // 避免误判：至少 30 秒
        if (elapsed > 30000) {
          api.logger.info?.(`[TranscriptHandler] Main task completion detected: ${sessionKey}`);

          // 更新 StateManager
          await this.context.stateManager?.updateTask(sessionKey, {
            status: 'completed',
            metadata: { completedAt: Date.now() }
          });

          // 发送完成通知
          await this.sendCompletionNotification(api, sessionKey);

          // 清理追踪（加锁保护）
          await this.mapLock.acquire('mainTaskTracking', () => {
            this.mainTaskTracking.delete(sessionKey);
          });
        }
      }

      tracking.lastCheck = Date.now();
    }
  }

  /**
   * 处理子任务
   */
  private async handleSubtask(api: OpenClawPluginApi, sessionKey: string, sessionFile: string): Promise<void> {
    api.logger.info?.(`[TranscriptHandler] Subagent transcript detected: ${sessionKey}`);

    // 节流检查
    const now = Date.now();
    const lastSent = this.transcriptLastSentMap.get(sessionKey) || 0;
    if (now - lastSent < this.streamConfig.throttle) {
      return;
    }

    // 获取父会话 key
    const parentSessionKey = this.resolveThreadParentSessionKey(sessionKey);
    api.logger.info?.(`[TranscriptHandler] Parent sessionKey resolved: ${parentSessionKey}`);
    if (!parentSessionKey) {
      api.logger.info?.(`[TranscriptHandler] No parent sessionKey for: ${sessionKey}`);
      return;
    }

    // 读取最新消息
    const messages = await this.readLastMessages(sessionFile, 2);
    api.logger.info?.(`[TranscriptHandler] Read ${messages.length} messages from transcript`);
    if (messages.length === 0) {
      return;
    }

    // 格式化消息
    const formattedMessages: string[] = [];
    for (const msgObj of messages) {
      const formatted = this.formatTranscriptMessage(msgObj);
      if (formatted) {
        formattedMessages.push(formatted);
      }
    }

    api.logger.info?.(`[TranscriptHandler] Formatted ${formattedMessages.length} messages`);
    if (formattedMessages.length === 0) {
      return;
    }

    // 更新节流时间戳（加锁保护）
    await this.mapLock.acquire('transcriptLastSentMap', () => {
      this.transcriptLastSentMap.set(sessionKey, now);
    });

    // 发送到父会话
    const depth = this.getSubagentDepth(sessionKey);
    const indent = depth > 1 ? "  ".repeat(depth - 1) : "";
    const message = formattedMessages.map(m => `${indent}${m}`).join("\n");

    try {
      await api.runtime.system.enqueueSystemEvent(
        `[子任务进度] ${message}`,
        { sessionKey: parentSessionKey }
      );
      await api.runtime.system.requestHeartbeatNow({});
      api.logger.debug?.(
        `[TranscriptHandler] Transcript forwarded to parent: ${sessionKey} -> ${parentSessionKey}`
      );
    } catch (e) {
      api.logger.error?.(`[TranscriptHandler] Failed to forward transcript: ${e}`);
    }
  }

  /**
   * 查找 SessionKey
   */
  private async findSessionKeyByFile(api: OpenClawPluginApi, sessionFile: string): Promise<string | null> {
    try {
      // 从文件路径提取 sessionKey
      const fileName = path.basename(sessionFile, '.json');
      return fileName;
    } catch (e) {
      api.logger.error?.(`[TranscriptHandler] Failed to find sessionKey: ${e}`);
      return null;
    }
  }

  /**
   * 判断是否是子任务会话 key
   */
  private isSubagentSessionKey(sessionKey: string): boolean {
    return sessionKey.includes(":subagent:");
  }

  /**
   * 解析父会话 Key
   */
  private resolveThreadParentSessionKey(sessionKey: string): string | null {
    // childSessionKey 格式: "agent:main:subagent:xxx:subagent:yyy"
    const parts = sessionKey.split(":subagent:");
    if (parts.length >= 2) {
      return parts[0]; // 返回主会话 key
    }
    return null;
  }

  /**
   * 获取子任务深度
   */
  private getSubagentDepth(sessionKey: string): number {
    const matches = sessionKey.match(/:subagent:/g);
    return matches ? matches.length : 0;
  }

  /**
   * 读取最后几条消息
   */
  private async readLastMessages(sessionFile: string, count: number): Promise<any[]> {
    try {
      if (!fs.existsSync(sessionFile)) return [];
      
      const content = fs.readFileSync(sessionFile, "utf-8");
      const data = JSON.parse(content);
      const messages = data.messages || data.transcript || [];
      
      return messages.slice(-count);
    } catch (e) {
      return [];
    }
  }

  /**
   * 格式化消息
   */
  private formatTranscriptMessage(msgObj: any): string | null {
    try {
      const role = msgObj.role || "unknown";
      const content = typeof msgObj.content === 'string' 
        ? msgObj.content 
        : JSON.stringify(msgObj.content || '');
      
      // 截断过长内容
      const truncated = content.length > 200 
        ? content.slice(0, 200) + "..." 
        : content;
      
      return `[${role}] ${truncated}`;
    } catch (e) {
      return null;
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
      const channel = parts[2];
      const target = parts[4] || parts[3];
      return { channel, target };
    }

    return null;
  }

  /**
   * 创建任务文件
   */
  private async createTaskFile(api: OpenClawPluginApi, sessionKey: string): Promise<void> {
    try {
      const TASKS_DIR = path.join(process.env.HOME || "/root", ".openclaw", "workspace", "memory", "tasks");
      const runningDir = path.join(TASKS_DIR, "running");
      
      if (!fs.existsSync(runningDir)) {
        fs.mkdirSync(runningDir, { recursive: true });
      }

      const taskName = `main-${sessionKey.split(':').pop()}-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}`;
      const taskFilePath = path.join(runningDir, `${taskName}.md`);

      if (!fs.existsSync(taskFilePath)) {
        const taskContent = `# 主任务记录

**任务ID**: ${sessionKey}
**状态**: running
**开始时间**: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
**来源**: transcript 检测（lifecycle 事件不可用）

---
*此文件由 task-monitor 自动创建*
`;
        fs.writeFileSync(taskFilePath, taskContent);
        api.logger.info?.(`[TranscriptHandler] Main task file created: ${taskName}`);
      }
    } catch (error) {
      api.logger.error?.(`[TranscriptHandler] Failed to create task file: ${error}`);
    }
  }

  /**
   * 发送完成通知
   */
  private async sendCompletionNotification(api: OpenClawPluginApi, sessionKey: string): Promise<void> {
    try {
      const taskName = sessionKey.split(':').pop() || 'unknown';
      const alertId = `main_completed_${taskName}`;

      if (this.context.alertManager?.shouldAlert(alertId, "main_completed")) {
        const channelInfo = this.getSessionChannelInfo(sessionKey);
        const notifyChannel = channelInfo?.channel || this.context.config.notification.channel;
        const notifyTarget = channelInfo?.target || this.context.config.notification.target;
        
        const notifyMessage = `✅ 主任务完成\n\n任务: ${taskName}\n时间: ${new Date().toLocaleString("zh-CN")}`;
        
        const { execSync } = require("child_process");
        execSync(
          `openclaw message send --channel "${notifyChannel}" --target "${notifyTarget}" --message "${notifyMessage.replace(/\n/g, '\\n')}"`,
          { timeout: 15000, stdio: 'pipe' }
        );
        
        this.context.alertManager.recordAlert(alertId, "main_completed");
        api.logger.info?.(`[TranscriptHandler] Main task completion notification sent: ${taskName}`);
      }
    } catch (e) {
      api.logger.error?.(`[TranscriptHandler] Failed to send completion notification: ${e}`);
    }
  }
}
