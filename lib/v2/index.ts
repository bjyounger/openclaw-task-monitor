// ==================== V2 架构入口 ====================

// 核心类型和接口
export * from './core/types';
export * from './core/interfaces';

// 核心实现
export { TaskEventEmitter } from './core/event-emitter';
export { Task } from './core/task';
export { MainTask } from './core/main-task';
export { SubTask } from './core/sub-task';
export { ExecTask } from './core/exec-task';
export { EmbeddedTask } from './core/embedded-task';

// 观察者
export { StateObserver } from './observers/state-observer';
export { AlertObserver } from './observers/alert-observer';
export { RetryObserver } from './observers/retry-observer';
export { TimerObserver } from './observers/timer-observer';

// 策略
export {
  ExponentialBackoffRetryStrategy,
  FixedDelayRetryStrategy,
  LinearBackoffRetryStrategy,
} from './strategies/retry-strategies';

export {
  DefaultNotificationStrategy,
  SilentNotificationStrategy,
  VerboseNotificationStrategy,
} from './strategies/notification-strategies';

// 工厂
export { TaskFactory } from './factory/task-factory';

// 模板
export {
  TaskTemplateManager,
  CodeReviewTemplate,
  DocGenTemplate,
  DataProcessingTemplate,
} from './templates/task-templates';

// 插件集成层
export {
  initializeTaskSystem,
  shutdownTaskSystem,
  emitTaskEvent,
  type ITaskSystemConfig,
  type ITaskSystem,
} from './plugin-integration';

// ==================== 快速初始化函数 ====================

import type {
  IStateManager,
  IAlertManager,
  IRetryManager,
  ITaskEventEmitter,
  IRetryStrategy,
  INotificationStrategy,
  ITaskObserver,
} from './core/interfaces';

import { Task } from './core/task';
import { TaskEventEmitter } from './core/event-emitter';
import { TaskFactory } from './factory/task-factory';
import { StateObserver } from './observers/state-observer';
import { AlertObserver } from './observers/alert-observer';
import { RetryObserver } from './observers/retry-observer';
import { TimerObserver } from './observers/timer-observer';
import { ExponentialBackoffRetryStrategy } from './strategies/retry-strategies';
import { DefaultNotificationStrategy } from './strategies/notification-strategies';

/**
 * 任务系统初始化配置
 */
export interface ITaskSystemConfig {
  stateManager: IStateManager;
  alertManager: IAlertManager;
  retryManager: IRetryManager;
  logger?: any;
  
  retryStrategy?: IRetryStrategy;
  notificationStrategy?: INotificationStrategy;
  
  // 观察者配置
  enableStateObserver?: boolean;
  enableAlertObserver?: boolean;
  enableRetryObserver?: boolean;
  enableTimerObserver?: boolean;
}

/**
 * 任务系统实例
 */
export interface ITaskSystem {
  eventEmitter: ITaskEventEmitter;
  factory: TaskFactory;
  observers: {
    state?: StateObserver;
    alert?: AlertObserver;
    retry?: RetryObserver;
    timer?: TimerObserver;
  };
  retryStrategy: IRetryStrategy;
  notificationStrategy: INotificationStrategy;
}

/**
 * 初始化任务系统
 */
export function initializeTaskSystem(config: ITaskSystemConfig): ITaskSystem {
  const {
    stateManager,
    alertManager,
    retryManager,
    logger,
    enableStateObserver = true,
    enableAlertObserver = true,
    enableRetryObserver = true,
    enableTimerObserver = true,
  } = config;
  
  // 创建策略
  const retryStrategy = config.retryStrategy ?? new ExponentialBackoffRetryStrategy();
  const notificationStrategy = config.notificationStrategy ?? new DefaultNotificationStrategy();
  
  // 创建事件发射器
  const eventEmitter = new TaskEventEmitter(logger);
  
  // 创建观察者
  const observers: ITaskSystem['observers'] = {};
  
  if (enableStateObserver) {
    observers.state = new StateObserver(stateManager, logger);
    eventEmitter.addListener(observers.state);
  }
  
  if (enableAlertObserver) {
    observers.alert = new AlertObserver(alertManager, notificationStrategy, logger);
    eventEmitter.addListener(observers.alert);
  }
  
  if (enableRetryObserver) {
    observers.retry = new RetryObserver(retryManager, retryStrategy, logger);
    eventEmitter.addListener(observers.retry);
  }
  
  if (enableTimerObserver) {
    observers.timer = new TimerObserver(stateManager, logger);
    eventEmitter.addListener(observers.timer);
  }
  
  // 初始化 Task 基类
  Task.initialize({
    eventEmitter,
    retryStrategy,
    notificationStrategy,
    logger,
  });
  
  // 创建任务工厂
  const factory = new TaskFactory(logger);
  
  logger?.info?.('[TaskSystem] Task system initialized', {
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
  // 清除所有观察者
  system.eventEmitter.clear();
  
  system.retryStrategy?.constructor?.name && 
    system.eventEmitter.removeListener(system.observers.retry as any);
  system.notificationStrategy?.constructor?.name && 
    system.eventEmitter.removeListener(system.observers.alert as any);
}
