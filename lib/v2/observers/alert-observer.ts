import type {
  IAlertObserver,
  ITaskEvent,
  IAlertManager,
  INotificationStrategy,
} from '../core/interfaces';

/**
 * 告警观察者
 * 
 * 职责：
 * - 监听任务事件
 * - 根据策略发送通知
 */
export class AlertObserver implements IAlertObserver {
  public readonly name = 'AlertObserver';
  
  private alertManager: IAlertManager;
  private notificationStrategy: INotificationStrategy;
  private logger: any;
  
  constructor(
    alertManager: IAlertManager,
    notificationStrategy: INotificationStrategy,
    logger?: any
  ) {
    this.alertManager = alertManager;
    this.notificationStrategy = notificationStrategy;
    this.logger = logger;
  }
  
  public async onTaskEvent(event: ITaskEvent): Promise<void> {
    // 判断是否应该发送通知
    if (!this.notificationStrategy.shouldNotify(event)) {
      return;
    }
    
    try {
      const message = this.notificationStrategy.buildMessage(event);
      const channel = this.notificationStrategy.getChannel(event);
      const target = this.notificationStrategy.getTarget(event);
      
      if (!channel || !target) {
        this.logger?.debug?.(
          `[AlertObserver] No channel/target for event: ${event.type}, task: ${event.taskId}`
        );
        return;
      }
      
      const sent = await this.sendAlert(event.taskId, message, event.type, channel, target);
      
      if (sent) {
        this.logger?.info?.(
          `[AlertObserver] Alert sent: ${event.type} for ${event.taskId} via ${channel}:${target}`
        );
      }
    } catch (e) {
      this.logger?.error?.(`[AlertObserver] Error sending alert: ${e}`);
    }
  }
  
  public async sendAlert(
    taskId: string,
    message: string,
    type: string,
    channel?: string,
    target?: string
  ): Promise<boolean> {
    // 检查是否应该发送（去重）
    if (!this.alertManager.shouldAlert(taskId, type)) {
      this.logger?.debug?.(
        `[AlertObserver] Alert skipped (cooldown): ${type} for ${taskId}`
      );
      return false;
    }
    
    const sent = await this.alertManager.sendAlert(taskId, message, type, channel, target);
    
    if (sent) {
      this.alertManager.recordAlert(taskId, type);
    }
    
    return sent;
  }
  
  /**
   * 更新通知策略
   */
  public setNotificationStrategy(strategy: INotificationStrategy): void {
    this.notificationStrategy = strategy;
    this.logger?.info?.(`[AlertObserver] Notification strategy updated: ${strategy.name}`);
  }
}

export default AlertObserver;
