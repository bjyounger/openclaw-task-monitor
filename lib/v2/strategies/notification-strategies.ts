import type { INotificationStrategy } from '../core/interfaces';
import type { ITaskEvent, TaskEventType } from '../core/types';

/**
 * 默认通知策略
 * 
 * 配置哪些事件需要发送通知
 * 构建通知消息内容
 */
export class DefaultNotificationStrategy implements INotificationStrategy {
  public readonly name = 'DefaultNotification';
  
  private readonly enabledEvents: Set<TaskEventType>;
  private readonly maxMessageLength: number;
  
  constructor(config?: { 
    enabledEvents?: TaskEventType[];
    maxMessageLength?: number;
  }) {
    this.enabledEvents = new Set(
      config?.enabledEvents ?? [
        'task_failed',
        'task_timeout',
        'task_retry_scheduled',
        'task_abandoned',
      ]
    );
    this.maxMessageLength = config?.maxMessageLength ?? 1000;
  }
  
  public shouldNotify(event: ITaskEvent): boolean {
    // 必须在启用的事件列表中
    if (!this.enabledEvents.has(event.type)) {
      return false;
    }
    
    // 必须有 channel 和 target
    const channel = this.getChannel(event);
    const target = this.getTarget(event);
    
    return !!channel && !!target;
  }
  
  public buildMessage(event: ITaskEvent): string {
    const taskId = event.taskId;
    const taskType = event.data?.taskType as string;
    const label = event.data?.label as string;
    const retryCount = event.data?.retryCount as number;
    const maxRetries = event.data?.maxRetries as number;
    
    const taskName = label || taskId;
    const retryInfo = retryCount !== undefined && maxRetries !== undefined
      ? `\n重试次数: ${retryCount}/${maxRetries}`
      : '';
    
    let message: string;
    
    switch (event.type) {
      case 'task_failed':
        const error = String(event.data?.error || event.data?.reason || 'Unknown error');
        message = `❌ 任务失败\n\n任务: ${taskName}\n类型: ${taskType}${retryInfo}\n错误: ${this.truncate(error, 200)}`;
        break;
      
      case 'task_timeout':
        const runtime = event.timestamp - ((event.data?.startTime as number) || event.timestamp);
        const runtimeMin = Math.floor(runtime / 60000);
        message = `⏰ 任务超时\n\n任务: ${taskName}\n类型: ${taskType}${retryInfo}\n运行时间: ${runtimeMin} 分钟`;
        break;
      
      case 'task_retry_scheduled':
        const delay = event.data?.delay as number;
        const delaySec = Math.floor((delay || 0) / 1000);
        const scheduledTime = event.data?.scheduledTime as number;
        const scheduledTimeStr = scheduledTime 
          ? new Date(scheduledTime).toLocaleString('zh-CN')
          : '未知';
        message = `⚠️ 任务失败，已安排重试\n\n任务: ${taskName}\n类型: ${taskType}\n重试次数: ${retryCount}/${maxRetries}\n延迟: ${delaySec}秒\n预计执行: ${scheduledTimeStr}`;
        break;
      
      case 'task_abandoned':
        const reason = String(event.data?.reason || 'Unknown');
        message = `❌ 任务最终失败\n\n任务: ${taskName}\n类型: ${taskType}${retryInfo}\n原因: ${this.truncate(reason, 200)}`;
        break;
      
      case 'task_completed':
        message = `✅ 任务完成\n\n任务: ${taskName}\n类型: ${taskType}${retryInfo}`;
        break;
      
      default:
        message = `📋 任务事件\n\n类型: ${event.type}\n任务: ${taskName}`;
    }
    
    return this.truncate(message, this.maxMessageLength);
  }
  
  public getChannel(event: ITaskEvent): string | undefined {
    return event.data?.channel as string;
  }
  
  public getTarget(event: ITaskEvent): string | undefined {
    return event.data?.target as string;
  }
  
  /**
   * 截断文本
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength - 3) + '...';
  }
  
  /**
   * 启用事件类型
   */
  public enableEvent(eventType: TaskEventType): void {
    this.enabledEvents.add(eventType);
  }
  
  /**
   * 禁用事件类型
   */
  public disableEvent(eventType: TaskEventType): void {
    this.enabledEvents.delete(eventType);
  }
  
  /**
   * 检查事件是否启用
   */
  public isEventEnabled(eventType: TaskEventType): boolean {
    return this.enabledEvents.has(eventType);
  }
}

/**
 * 静默通知策略（不发送任何通知）
 */
export class SilentNotificationStrategy implements INotificationStrategy {
  public readonly name = 'Silent';
  
  public shouldNotify(event: ITaskEvent): boolean {
    return false;
  }
  
  public buildMessage(event: ITaskEvent): string {
    return '';
  }
  
  public getChannel(event: ITaskEvent): string | undefined {
    return undefined;
  }
  
  public getTarget(event: ITaskEvent): string | undefined {
    return undefined;
  }
}

/**
 * 详细通知策略（发送所有事件通知）
 */
export class VerboseNotificationStrategy implements INotificationStrategy {
  public readonly name = 'Verbose';
  
  private readonly strategy: DefaultNotificationStrategy;
  
  constructor(config?: { maxMessageLength?: number }) {
    this.strategy = new DefaultNotificationStrategy({
      enabledEvents: [
        'task_created',
        'task_started',
        'task_completed',
        'task_failed',
        'task_timeout',
        'task_retry_scheduled',
        'task_abandoned',
        'task_killed',
      ],
      maxMessageLength: config?.maxMessageLength ?? 1000,
    });
  }
  
  public shouldNotify(event: ITaskEvent): boolean {
    return this.strategy.shouldNotify(event);
  }
  
  public buildMessage(event: ITaskEvent): string {
    return this.strategy.buildMessage(event);
  }
  
  public getChannel(event: ITaskEvent): string | undefined {
    return this.strategy.getChannel(event);
  }
  
  public getTarget(event: ITaskEvent): string | undefined {
    return this.strategy.getTarget(event);
  }
}

export default DefaultNotificationStrategy;
