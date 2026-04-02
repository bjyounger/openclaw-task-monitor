// ==================== V2 插件集成层 ====================
// 
// 职责：
// 1. 初始化 V2 架构（事件发射器、观察者）
// 2. 提供任务创建和管理接口
// 3. 与 V1 管理器（StateManager、AlertManager）集成

import type {
  IStateManager,
  IAlertManager,
  ITaskEventEmitter,
  IRetryStrategy,
  INotificationStrategy,
  ITaskObserver,
  ILogger,
  ITaskState,
  ITaskDependencies,
} from './core/interfaces';
import type { ITaskEvent, TaskType } from './core/types';

import { TaskEventEmitter } from './core/event-emitter';
import { TaskFactory } from './factory/task-factory';
import { StateObserver } from './observers/state-observer';
import { AlertObserver } from './observers/alert-observer';
import { RetryObserver } from './observers/retry-observer';
import { ExponentialBackoffRetryStrategy } from './strategies/retry-strategies';
import { DefaultNotificationStrategy } from './strategies/notification-strategies';

// 适配器：将 V1 StateManager 适配为 V2 接口
import type { StateManager as V1StateManager } from '../state-manager';
import type { AlertManager as V1AlertManager } from '../alert-manager';
import { StateManagerAdapter } from '../adapters/state-manager-adapter';

/**
 * V2 任务系统配置
 */
export interface ITaskSystemConfig {
  stateManager: V1StateManager;
  alertManager: V1AlertManager;
  logger: ILogger;
  
  // 可选策略
  retryStrategy?: IRetryStrategy;
  notificationStrategy?: INotificationStrategy;
  
  // 观察者配置
  enableStateObserver?: boolean;
  enableAlertObserver?: boolean;
  enableRetryObserver?: boolean;
}

/**
 * V2 任务系统实例
 */
export interface ITaskSystem {
  eventEmitter: ITaskEventEmitter;
  factory: TaskFactory;
  observers: {
    state?: StateObserver;
    alert?: AlertObserver;
    retry?: RetryObserver;
  };
  retryStrategy: IRetryStrategy;
  notificationStrategy: INotificationStrategy;
}

/**
 * V1 AlertManager 适配器
 * 将 V1 AlertManager 适配为 V2 IAlertManager 接口
 */
class AlertManagerAdapter implements IAlertManager {
  constructor(private v1AlertManager: V1AlertManager) {}
  
  async sendAlert(taskId: string, message: string, type: string, channel?: string, target?: string): Promise<boolean> {
    if (channel && target) {
      return this.v1AlertManager.sendAlertToTarget(taskId, message, type, channel, target);
    }
    return this.v1AlertManager.sendAlert(taskId, message, type);
  }
  
  shouldAlert(taskId: string, type: string): boolean {
    return this.v1AlertManager.shouldAlert(taskId, type);
  }
  
  recordAlert(taskId: string, type: string): void {
    this.v1AlertManager.recordAlert(taskId, type);
  }
}

/**
 * V1 重试管理器适配器
 * 使用 StateManager 的重试调度功能
 */
class RetryManagerAdapter {
  constructor(private v1StateManager: V1StateManager) {}
  
  async scheduleRetry(taskId: string, delayMs: number): Promise<void> {
    const task = await this.v1StateManager.getTask(taskId);
    if (!task) return;
    await this.v1StateManager.scheduleRetry(taskId);
  }
  
  async cancelRetry(taskId: string): Promise<void> {
    await this.v1StateManager.cancelScheduledRetry(taskId);
  }
  
  async getDueRetries(limit: number): Promise<string[]> {
    const retries = await this.v1StateManager.getDueScheduledRetries(limit);
    return retries.map(r => r.runId);
  }
  
  async markRetryExecuted(taskId: string): Promise<void> {
    await this.v1StateManager.markRetryExecuted(taskId);
  }
}

/**
 * 初始化 V2 任务系统
 */
export function initializeTaskSystem(config: ITaskSystemConfig): ITaskSystem {
  const {
    stateManager,
    alertManager,
    logger,
    enableStateObserver = true,
    enableAlertObserver = true,
    enableRetryObserver = true,
  } = config;
  
  // 创建适配器
  const stateManagerAdapter = new StateManagerAdapter(stateManager);
  const alertManagerAdapter = new AlertManagerAdapter(alertManager);
  const retryManagerAdapter = new RetryManagerAdapter(stateManager);
  
  // 创建策略
  const retryStrategy = config.retryStrategy ?? new ExponentialBackoffRetryStrategy({
    initialDelay: 30000,
    backoffMultiplier: 2,
    maxDelay: 300000,
    maxRetries: 2,
  });
  
  const notificationStrategy = config.notificationStrategy ?? new DefaultNotificationStrategy({
    enabledEvents: [
      'task_failed',
      'task_retry_scheduled',
      'task_abandoned',
    ],
  });
  
  // 创建事件发射器
  const eventEmitter = new TaskEventEmitter({ logger });
  
  // 创建观察者
  const observers: ITaskSystem['observers'] = {};
  
  if (enableStateObserver) {
    observers.state = new StateObserver(stateManagerAdapter, logger);
    eventEmitter.addListener(observers.state);
  }
  
  if (enableAlertObserver) {
    observers.alert = new AlertObserver(alertManagerAdapter, notificationStrategy, logger);
    eventEmitter.addListener(observers.alert);
  }
  
  if (enableRetryObserver) {
    observers.retry = new RetryObserver(retryManagerAdapter as any, retryStrategy, logger);
    eventEmitter.addListener(observers.retry as any);
  }
  
  // 创建依赖注入对象
  const dependencies: ITaskDependencies = {
    eventEmitter,
    retryStrategy,
    notificationStrategy,
    logger,
  };
  
  // 创建任务工厂
  const factory = new TaskFactory(dependencies, logger);
  
  logger.info?.('[TaskSystem] V2 Task system initialized', {
    observers: Object.keys(observers),
    strategies: {
      retry: retryStrategy.name,
      notification: notificationStrategy.name,
    },
  });
  
  return {
    eventEmitter,
    factory,
    observers,
    retryStrategy,
    notificationStrategy,
  };
}

/**
 * 关闭任务系统
 */
export function shutdownTaskSystem(system: ITaskSystem): void {
  // 清除所有监听器
  const listeners = system.eventEmitter.getListeners();
  for (const listener of listeners) {
    system.eventEmitter.removeListener(listener);
  }
}

/**
 * 发送任务事件
 * 便捷方法
 */
export function emitTaskEvent(system: ITaskSystem, event: ITaskEvent): void {
  system.eventEmitter.emit(event);
}

export {
  TaskEventEmitter,
  TaskFactory,
  StateObserver,
  AlertObserver,
  RetryObserver,
  ExponentialBackoffRetryStrategy,
  DefaultNotificationStrategy,
};
