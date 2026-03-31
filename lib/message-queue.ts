/**
 * 消息队列模块
 * 
 * 功能：当 Bot WebSocket 断开时，缓存未能发送的消息，
 *       在连接恢复后自动重试发送。
 */

import type { AlertManager } from './alert-manager';

/**
 * 队列消息项
 */
export interface QueuedMessage {
  /** 消息唯一ID */
  id: string;
  /** 任务ID */
  taskId: string;
  /** 消息内容 */
  message: string;
  /** 告警类型 */
  alertType: string;
  /** 入队时间戳 */
  timestamp: number;
  /** 重试次数 */
  retryCount: number;
  /** 最后一次错误信息 */
  lastError?: string;
}

/**
 * 消息队列配置
 */
export interface MessageQueueConfig {
  /** 最大队列长度，默认 100 */
  maxQueueSize: number;
  /** 最大重试次数，默认 3 */
  maxRetries: number;
  /** 重试间隔（毫秒），默认 5000 */
  retryInterval: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: MessageQueueConfig = {
  maxQueueSize: 100,
  maxRetries: 3,
  retryInterval: 5000,
};

/**
 * 消息队列类
 * 
 * 功能：
 * - 消息入队（当发送失败时）
 * - 消息出队并发送（当连接恢复时）
 * - 队列大小限制
 * - 重试次数限制
 * - 定时检查机制（避免无限等待）
 */
export class MessageQueue {
  /** 队列存储 */
  private queue: QueuedMessage[] = [];

  /** 配置 */
  private config: MessageQueueConfig;

  /** 告警管理器引用 */
  private alertManager: AlertManager | null = null;

  /** 是否正在处理队列 */
  private isProcessing: boolean = false;

  /** 是否已连接 */
  private isConnected: boolean = true;

  /** 消息ID计数器 */
  private messageIdCounter: number = 0;

  /** 定时检查定时器 */
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<MessageQueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 从环境变量或默认值初始化
    const maxQueueSize = parseInt(process.env.TASK_MONITOR_QUEUE_SIZE || '100', 10);
    const maxRetries = parseInt(process.env.TASK_MONITOR_QUEUE_RETRIES || '3', 10);
    const retryInterval = parseInt(process.env.TASK_MONITOR_QUEUE_INTERVAL || '5000', 10);
    
    this.config = {
      maxQueueSize: config.maxQueueSize ?? maxQueueSize,
      maxRetries: config.maxRetries ?? maxRetries,
      retryInterval: config.retryInterval ?? retryInterval,
    };
    
    console.log(`[task-monitor] MessageQueue initialized, maxQueueSize=${this.config.maxQueueSize}, maxRetries=${this.config.maxRetries}`);
    
    // 启动定时检查（每 30 秒检查一次队列）
    this.startPeriodicCheck();
  }

  /**
   * 启动定时检查
   */
  private startPeriodicCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
    
    this.checkTimer = setInterval(() => {
      if (this.queue.length > 0 && this.isConnected && !this.isProcessing) {
        console.log(`[task-monitor] Periodic check: flushing queue (${this.queue.length} messages)`);
        this.flushQueue();
      }
    }, 30000); // 30 秒检查一次
  }

  /**
   * 停止定时检查
   */
  public stopPeriodicCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * 设置告警管理器
   */
  public setAlertManager(manager: AlertManager): void {
    this.alertManager = manager;
  }

  /**
   * 设置连接状态
   * @param connected 是否已连接
   */
  public setConnectionStatus(connected: boolean): void {
    const wasDisconnected = !this.isConnected;
    this.isConnected = connected;

    if (wasDisconnected && connected && this.queue.length > 0) {
      console.log(`[task-monitor] Connection recovered, flushing message queue, count: ${this.queue.length}`);
      this.flushQueue();
    }
  }

  /**
   * 消息入队
   * @param taskId 任务ID
   * @param message 消息内容
   * @param alertType 告警类型
   * @returns 是否成功入队
   */
  public enqueue(
    taskId: string,
    message: string,
    alertType: string
  ): boolean {
    // 检查队列是否已满
    if (this.queue.length >= this.config.maxQueueSize) {
      console.warn(`[task-monitor] Message queue is full (${this.queue.length}/${this.config.maxQueueSize}), dropping oldest message`);
      // 移除最旧的消息
      this.queue.shift();
    }

    const queuedMessage: QueuedMessage = {
      id: `msg-${Date.now()}-${++this.messageIdCounter}`,
      taskId,
      message,
      alertType,
      timestamp: Date.now(),
      retryCount: 0,
    };

    this.queue.push(queuedMessage);
    console.log(`[task-monitor] Message queued, queue size: ${this.queue.length}`);

    return true;
  }

  /**
   * 清空并发送队列中的所有消息
   */
  public async flushQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    if (!this.alertManager) {
      console.error('[task-monitor] AlertManager not set, cannot flush queue');
      return;
    }

    if (!this.isConnected) {
      console.log('[task-monitor] Not connected, skipping queue flush');
      return;
    }

    this.isProcessing = true;
    console.log(`[task-monitor] Flushing message queue, count: ${this.queue.length}`);

    const messagesToSend = [...this.queue];
    this.queue = [];

    for (const msg of messagesToSend) {
      try {
        // 尝试直接发送（绕过去重检查）
        const sent = await this.sendDirectly(msg);
        if (sent) {
          console.log(`[task-monitor] Queued message sent successfully: ${msg.id}`);
        } else {
          // 发送失败，检查是否还能重试
          await this.handleSendFailure(msg, 'Send returned false');
        }
      } catch (error) {
        await this.handleSendFailure(msg, String(error));
      }
    }

    this.isProcessing = false;
  }

  /**
   * 直接发送消息（绕过去重检查）
   */
  private async sendDirectly(msg: QueuedMessage): Promise<boolean> {
    if (!this.alertManager) {
      return false;
    }

    try {
      // 使用 AlertManager 发送，但先清除该消息的告警记录
      // 这样可以绕过冷却期检查
      const fullMessage = msg.message;
      
      // 直接调用底层发送方法
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const config = this.alertManager.getConfig();
      const escapedMessage = this.escapeMessage(fullMessage);
      const command = `openclaw message send --channel "${config.channel}" --target "${config.target}" --message "${escapedMessage}"`;

      await execAsync(command);
      
      return true;
    } catch (error) {
      console.error(`[task-monitor] Direct send failed for ${msg.id}:`, error);
      return false;
    }
  }

  /**
   * 处理发送失败
   */
  private async handleSendFailure(msg: QueuedMessage, error: string): Promise<void> {
    msg.retryCount++;
    msg.lastError = error;

    if (msg.retryCount < this.config.maxRetries) {
      // 还可以重试，重新加入队列
      console.warn(`[task-monitor] Message send failed, will retry (${msg.retryCount}/${this.config.maxRetries}): ${msg.id}`);
      
      // 延迟后重新入队
      setTimeout(() => {
        if (this.queue.length < this.config.maxQueueSize) {
          this.queue.push(msg);
        } else {
          console.error(`[task-monitor] Queue full, message dropped: ${msg.id}`);
        }
      }, this.config.retryInterval);
    } else {
      // 重试次数耗尽
      console.error(`[task-monitor] Message send failed after ${msg.retryCount} retries, dropped: ${msg.id}, error: ${error}`);
    }
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
   * 获取队列大小
   */
  public size(): number {
    return this.queue.length;
  }

  /**
   * 获取队列状态
   */
  public getStatus(): {
    queueSize: number;
    maxSize: number;
    maxRetries: number;
    isConnected: boolean;
    isProcessing: boolean;
  } {
    return {
      queueSize: this.queue.length,
      maxSize: this.config.maxQueueSize,
      maxRetries: this.config.maxRetries,
      isConnected: this.isConnected,
      isProcessing: this.isProcessing,
    };
  }

  /**
   * 清空队列
   */
  public clear(): void {
    const count = this.queue.length;
    this.queue = [];
    console.log(`[task-monitor] Message queue cleared, removed ${count} messages`);
  }
}

// 导出单例
export const messageQueue = new MessageQueue();
