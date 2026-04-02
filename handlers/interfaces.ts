// handlers/interfaces.ts
/**
 * Handler 接口定义
 * 
 * 统一的 Handler 注册接口，用于事件处理器、状态处理器等
 */

// 使用 any 避免 SDK 依赖问题
export type OpenClawPluginApi = any;

/**
 * Handler 接口
 * 
 * 所有处理器都应实现此接口，提供统一的注册方法
 */
export interface IHandler {
  /**
   * 注册处理器到插件 API
   * @param api OpenClaw 插件 API 实例
   */
  register(api: OpenClawPluginApi): void;
}

/**
 * 异步 Handler 接口
 * 
 * 支持异步注册的 Handler
 */
export interface IAsyncHandler {
  /**
   * 异步注册处理器到插件 API
   * @param api OpenClaw 插件 API 实例
   */
  register(api: OpenClawPluginApi): Promise<void>;
}

/**
 * Handler 基础配置
 */
export interface HandlerConfig {
  /** Handler 名称 */
  name: string;
  /** 是否启用 */
  enabled?: boolean;
  /** 优先级（数字越小优先级越高） */
  priority?: number;
}

/**
 * 带 Handler 名称的接口
 */
export interface INamedHandler extends IHandler {
  /** Handler 名称 */
  readonly name: string;
}

/**
 * SubagentSpawned 事件数据
 */
export interface SubagentSpawnedPayload {
  /** 运行 ID */
  runId: string;
  /** 子会话 key */
  childSessionKey: string;
  /** 目标会话 key */
  targetSessionKey?: string;
  /** 标签 */
  label: string;
  /** Agent ID */
  agentId?: string;
  /** 模式 */
  mode?: string;
  /** 任务描述 */
  taskDescription?: string;
  /** 父任务 ID（主任务派发时） */
  parentTaskId?: string;
}

/**
 * SubagentEnded 事件数据
 */
export interface SubagentEndedPayload {
  /** 运行 ID */
  runId: string;
  /** 结果状态 */
  outcome: 'ok' | 'error' | 'timeout' | 'killed';
  /** 结束时间 */
  endedAt?: number;
  /** 错误信息 */
  error?: string;
  /** 子会话 key */
  childSessionKey?: string;
  /** 目标会话 key */
  targetSessionKey?: string;
}

/**
 * Handler 上下文接口
 * 
 * 共享的上下文信息，通过 register 时的闭包传递
 */
export interface IHandlerContext {
  /** 状态管理器 */
  stateManager?: any;
  /** 告警管理器 */
  alertManager?: any;
  /** 任务链管理器 */
  taskChainManager?: any;
  /** 配置 */
  config: any;
  /** 并发锁 */
  mapLock: any;
  /** 任务频道映射 */
  taskChannelMap: Map<string, { channel: string; target: string }>;
  /** 日志器 */
  logger?: any;
}

/**
 * Exec 任务追踪信息
 */
export interface ExecTaskInfo {
  /** 开始时间 */
  startTime: number;
  /** 执行命令 */
  command: string;
  /** 任务 RunId */
  runId?: string;
  /** 会话 Key */
  sessionKey?: string;
  /** 频道 */
  channel?: string;
  /** 目标 */
  target?: string;
}

/**
 * 主任务追踪信息
 */
export interface MainTaskTracking {
  /** 开始时间 */
  startTime: number;
  /** 最后检查时间 */
  lastCheck: number;
}
