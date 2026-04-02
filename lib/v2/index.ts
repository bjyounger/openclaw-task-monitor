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
} from './plugin-integration';
export type { ITaskSystemConfig, ITaskSystem } from './plugin-integration';
