// lib/adapters/notification-adapter.ts
/**
 * 通知适配器
 * 
 * 封装通知发送逻辑，提供统一的通知发送接口
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 通知配置接口
 */
export interface NotificationConfig {
  /** 默认通知渠道 */
  defaultChannel?: string;
  /** 默认通知目标 */
  defaultTarget?: string;
  /** 是否启用通知 */
  enabled?: boolean;
}

/**
 * 通知记录接口
 */
export interface NotificationRecord {
  /** 任务 ID */
  taskId: string;
  /** 通知类型 */
  type: string;
  /** 时间戳 */
  timestamp: number;
  /** 渠道 */
  channel: string;
  /** 目标 */
  target: string;
  /** 是否成功 */
  success: boolean;
}

/**
 * 通知适配器类
 * 
 * 封装通知发送逻辑，支持多渠道通知
 */
export class NotificationAdapter {
  private config: NotificationConfig;
  private notificationHistory: Map<string, NotificationRecord[]> = new Map();

  constructor(config: NotificationConfig = {}) {
    this.config = {
      defaultChannel: config.defaultChannel || 'wecom',
      defaultTarget: config.defaultTarget || '',
      enabled: config.enabled !== false, // 默认启用
    };
  }

  /**
   * 发送通知
   * @param channel 通知渠道
   * @param target 通知目标
   * @param message 通知消息
   * @param taskId 关联的任务 ID（可选）
   * @param type 通知类型（可选）
   */
  async send(
    channel: string,
    target: string,
    message: string,
    taskId?: string,
    type?: string
  ): Promise<boolean> {
    if (!this.config.enabled) {
      console.log('[NotificationAdapter] 通知已禁用，跳过发送');
      return false;
    }

    const actualChannel = channel || this.config.defaultChannel || 'wecom';
    const actualTarget = target || this.config.defaultTarget;

    if (!actualTarget) {
      console.warn('[NotificationAdapter] 缺少通知目标，跳过发送');
      return false;
    }

    try {
      const escapedMessage = this.escapeMessage(message);
      const command = `openclaw message send --channel "${actualChannel}" --target "${actualTarget}" --message "${escapedMessage}"`;

      console.log(`[NotificationAdapter] 发送通知: channel=${actualChannel}, target=${actualTarget}`);

      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        console.error('[NotificationAdapter] 通知发送 stderr:', stderr);
      }

      // 记录通知历史
      if (taskId) {
        this.recordNotification({
          taskId,
          type: type || 'general',
          timestamp: Date.now(),
          channel: actualChannel,
          target: actualTarget,
          success: !stderr,
        });
      }

      console.log(`[NotificationAdapter] 通知发送成功`);
      return true;
    } catch (error) {
      console.error('[NotificationAdapter] 发送通知失败:', error);

      // 记录失败通知
      if (taskId) {
        this.recordNotification({
          taskId,
          type: type || 'general',
          timestamp: Date.now(),
          channel: actualChannel,
          target: actualTarget,
          success: false,
        });
      }

      return false;
    }
  }

  /**
   * 发送任务通知（便捷方法）
   * @param taskId 任务 ID
   * @param message 消息
   * @param options 选项
   */
  async sendTaskNotification(
    taskId: string,
    message: string,
    options?: {
      channel?: string;
      target?: string;
      type?: string;
    }
  ): Promise<boolean> {
    return this.send(
      options?.channel || '',
      options?.target || '',
      message,
      taskId,
      options?.type
    );
  }

  /**
   * 发送任务创建通知
   */
  async notifyTaskCreated(
    taskId: string,
    label: string,
    options?: { channel?: string; target?: string }
  ): Promise<boolean> {
    return this.sendTaskNotification(taskId, `任务已创建: ${label}`, {
      ...options,
      type: 'task_created',
    });
  }

  /**
   * 发送任务完成通知
   */
  async notifyTaskCompleted(
    taskId: string,
    label: string,
    duration: number,
    options?: { channel?: string; target?: string }
  ): Promise<boolean> {
    const durationSec = Math.floor(duration / 1000);
    return this.sendTaskNotification(taskId, `任务已完成: ${label} (${durationSec}s)`, {
      ...options,
      type: 'task_completed',
    });
  }

  /**
   * 发送任务失败通知
   */
  async notifyTaskFailed(
    taskId: string,
    label: string,
    error: string,
    options?: { channel?: string; target?: string }
  ): Promise<boolean> {
    return this.sendTaskNotification(taskId, `任务失败: ${label}\n原因: ${error}`, {
      ...options,
      type: 'task_failed',
    });
  }

  /**
   * 发送任务超时通知
   */
  async notifyTaskTimeout(
    taskId: string,
    label: string,
    timeoutMs: number,
    options?: { channel?: string; target?: string }
  ): Promise<boolean> {
    const timeoutMin = Math.floor(timeoutMs / 60000);
    return this.sendTaskNotification(taskId, `任务超时: ${label} (超时: ${timeoutMin}分钟)`, {
      ...options,
      type: 'task_timeout',
    });
  }

  /**
   * 发送任务重试通知
   */
  async notifyTaskRetry(
    taskId: string,
    label: string,
    retryCount: number,
    maxRetries: number,
    options?: { channel?: string; target?: string }
  ): Promise<boolean> {
    return this.sendTaskNotification(
      taskId,
      `任务重试中: ${label} (${retryCount}/${maxRetries})`,
      {
        ...options,
        type: 'task_retry',
      }
    );
  }

  /**
   * 记录通知历史
   */
  private recordNotification(record: NotificationRecord): void {
    if (!this.notificationHistory.has(record.taskId)) {
      this.notificationHistory.set(record.taskId, []);
    }
    this.notificationHistory.get(record.taskId)!.push(record);
  }

  /**
   * 获取任务的通知历史
   * @param taskId 任务 ID
   */
  getNotificationHistory(taskId: string): NotificationRecord[] {
    return this.notificationHistory.get(taskId) || [];
  }

  /**
   * 获取任务最后一条通知
   * @param taskId 任务 ID
   */
  getLastNotification(taskId: string): NotificationRecord | undefined {
    const history = this.notificationHistory.get(taskId);
    return history?.[history.length - 1];
  }

  /**
   * 清除任务的通知历史
   * @param taskId 任务 ID
   */
  clearNotificationHistory(taskId: string): void {
    this.notificationHistory.delete(taskId);
  }

  /**
   * 清除所有通知历史
   */
  clearAllNotificationHistory(): void {
    this.notificationHistory.clear();
  }

  /**
   * 转义消息中的特殊字符
   */
  private escapeMessage(message: string): string {
    return message
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<NotificationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): NotificationConfig {
    return { ...this.config };
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled ?? true;
  }

  /**
   * 启用通知
   */
  enable(): void {
    this.config.enabled = true;
  }

  /**
   * 禁用通知
   */
  disable(): void {
    this.config.enabled = false;
  }
}

export default NotificationAdapter;
