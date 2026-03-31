export { StateManager } from './state-manager';
export type { 
  TaskState, 
  TaskType, 
  TaskStatus, 
  StateFile,
  RetryRecord,
  ScheduledRetry,
  RetryScheduleFile,
  WatchdogConfig,
} from './state-manager';

export { AlertManager } from './alert-manager';
export type { AlertConfig, AlertRecord } from './alert-manager';

export { TaskChainManager } from './task-chain';
export type {
  TaskChain,
  TaskChainStatus,
  SubtaskInfo,
  SubtaskStatus,
  TaskChainFile,
} from './task-chain';

export { loadConfig, getDefaultConfig } from './config-loader';
export type { TaskMonitorConfig } from './config-loader';

export { MessageQueue, messageQueue } from './message-queue';
export type { QueuedMessage, MessageQueueConfig } from './message-queue';

export { ConfigInjector } from './config-injector';
export type { InjectableConfig, InjectConfig } from './config-injector';

// 新增：活跃追踪模块
export { 
  ActivityTracker, 
  getActivityTracker, 
  resetActivityTracker,
  DEFAULT_ACTIVITY_TRACKER_CONFIG,
  DEFAULT_TOOL_TIMEOUTS,
} from './activity-tracker';
export type {
  ActivityState,
  SessionType,
  WaitState,
  WaitStateType,
  ToolCallInfo,
  ActivityTrackerConfig,
  HookRegistrationStatus,
} from './activity-tracker';

// 新增：中断处理模块
export { 
  InterruptHandler, 
  getInterruptHandler, 
  resetInterruptHandler,
  DEFAULT_INTERRUPT_HANDLER_CONFIG,
} from './interrupt-handler';
export type {
  InterruptReason,
  InterruptContext,
  InterruptRecord,
  InterruptHandlerConfig,
} from './interrupt-handler';

// 新增：健康检查模块
export { 
  HealthChecker, 
  getHealthChecker, 
  resetHealthChecker,
  DEFAULT_HEALTH_CHECKER_CONFIG,
} from './health-checker';
export type {
  HealthStatus,
  HealthCheckerConfig,
} from './health-checker';

// 新增：记忆管理模块
export {
  MemoryManager,
  TaskSummaryGenerator,
  KeywordExtractor,
  EpisodicMemoryStorage,
  AccessTracker,
} from './memory';
export type {
  MemoryConfig,
  TaskSummary,
  TranscriptExtractor,
} from './memory';
