// ==================== 类型定义 ====================

/**
 * 任务类型
 */
export type TaskType = 'main' | 'sub' | 'exec' | 'embedded';

/**
 * 任务状态
 */
export type TaskStatus = 
  | 'pending'    // 等待执行
  | 'running'    // 执行中
  | 'completed'  // 已完成
  | 'failed'     // 失败
  | 'timeout'    // 超时
  | 'scheduled'  // 已安排重试
  | 'abandoned'  // 放弃（重试耗尽）
  | 'killed'     // 用户终止
  | 'interrupted'; // 被中断

/**
 * 任务事件类型
 */
export type TaskEventType =
  | 'task_created'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_timeout'
  | 'task_retry_scheduled'
  | 'task_retry_executed'
  | 'task_abandoned'
  | 'task_killed'
  | 'task_heartbeat'
  | 'task_status_changed'
  | 'task_cancelled'; // 新增：任务取消事件

/**
 * 任务优先级
 * 
 * 优化项 4.1：新增优先级支持
 */
export type TaskPriority = 'low' | 'medium' | 'high';

/**
 * 错误类型分类
 * 
 * 优化项 3.1：错误类型区分，用于智能重试策略
 */
export type ErrorType = 
  | 'transient'    // 临时性错误（网络抖动、服务暂时不可用）→ 可重试
  | 'permanent'    // 永久性错误（参数错误、权限不足）→ 不可重试
  | 'timeout'      // 超时错误 → 可重试
  | 'cancellation' // 用户取消 → 不可重试
  | 'unknown';     // 未知错误 → 根据配置决定

/**
 * 任务事件
 */
export interface ITaskEvent {
  /** 事件类型 */
  type: TaskEventType;
  /** 任务 ID */
  taskId: string;
  /** 时间戳 */
  timestamp: number;
  /** 事件数据 */
  data?: Record<string, unknown>;
}

/**
 * 重试记录
 */
export interface IRetryRecord {
  /** 第几次尝试 (1, 2, 3) */
  attemptNumber: number;
  /** 尝试时间戳 */
  timestamp: number;
  /** 结果 */
  outcome: 'error' | 'timeout' | 'ok';
  /** 失败原因 */
  reason?: string;
  /** 执行时长 (毫秒) */
  duration: number;
  /** 错误类型 */
  errorType?: ErrorType;
}

/**
 * 通知记录
 */
export interface INotificationRecord {
  /** 通知类型 */
  type: string;
  /** 时间戳 */
  timestamp: number;
  /** 渠道 */
  channel: string;
  /** 目标 */
  target: string;
}

/**
 * 任务依赖关系
 * 
 * 优化项 4.2：任务依赖图支持
 */
export interface ITaskDependency {
  /** 依赖的任务 ID */
  taskId: string;
  /** 依赖类型 */
  type: 'hard' | 'soft'; // hard: 必须完成, soft: 尝试等待但不强制
  /** 超时时间（可选） */
  timeoutMs?: number;
}

/**
 * 任务指标
 * 
 * 优化项 6：可观测性增强
 */
export interface ITaskMetrics {
  /** 任务创建总数 */
  totalCreated: number;
  /** 任务完成总数 */
  totalCompleted: number;
  /** 任务失败总数 */
  totalFailed: number;
  /** 任务超时总数 */
  totalTimeout: number;
  /** 平均执行时长（毫秒） */
  averageDuration: number;
  /** 按类型统计 */
  byType: Record<TaskType, {
    created: number;
    completed: number;
    failed: number;
    averageDuration: number;
  }>;
  /** 按优先级统计 */
  byPriority: Record<TaskPriority, {
    created: number;
    completed: number;
    failed: number;
  }>;
  /** 当前活跃任务数 */
  activeCount: number;
  /** 最近 1 小时统计 */
  lastHour: {
    created: number;
    completed: number;
    failed: number;
    averageDuration: number;
  };
}

// 类型已通过 export type 定义，无需重复导出
