/**
 * Task Monitor Configuration Loader
 * 
 * Loads user configuration from config.json with defaults and validation
 */

import * as fs from "fs";
import * as path from "path";

// ==================== 配置接口定义 ====================

export interface TaskMonitorConfig {
  version: string;
  monitoring: {
    subtaskTimeout: number;
    taskChainTimeout: number;
    stalledPendingThreshold: number;
    stalledRunningThreshold: number;
    mainTaskTimeout: number;
  };
  retry: {
    maxRetries: number;
    checkInterval: number;
    spawnTimeout: number;
    backoffMultiplier: number;
    initialDelay: number;
  };
  progress: {
    enabled: boolean;
    reportInterval: number;
    timeoutCheckInterval: number;
  };
  notification: {
    channel: string;
    target: string;
    enabled: boolean;
    throttle: number;
    maxMessageLength: number;
    quietHours: {
      enabled: boolean;
      start: string;
      end: string;
    };
    types: {
      [key: string]: boolean;
    };
  };
  storage: {
    stateDir: string;
    tasksDir: string;
  };
  logging: {
    level: string;
  };
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: TaskMonitorConfig = {
  version: "1.0.0",
  
  monitoring: {
    subtaskTimeout: 600000,           // 10 分钟
    taskChainTimeout: 900000,          // 15 分钟
    stalledPendingThreshold: 1800000,  // 30 分钟
    stalledRunningThreshold: 600000,   // 10 分钟
    mainTaskTimeout: 3600000,          // 60 分钟
  },
  
  retry: {
    maxRetries: 2,
    checkInterval: 10000,              // 10 秒
    spawnTimeout: 300000,              // 5 分钟
    backoffMultiplier: 2,
    initialDelay: 60000,               // 1 分钟
  },
  
  progress: {
    enabled: true,
    reportInterval: 60000,             // 1 分钟
    timeoutCheckInterval: 60000,       // 1 分钟
  },
  
  notification: {
    channel: "wecom",
    target: "wecom-agent:YangKe",
    enabled: true,
    throttle: 3000,
    maxMessageLength: 200,
    quietHours: {
      enabled: false,
      start: "23:00",
      end: "07:00",
    },
    types: {
      subtaskSpawned: true,
      subtaskCompleted: true,
      subtaskFailed: true,
      subtaskTimeout: true,
      mainTaskCompleted: true,
      taskChainTimeout: true,
      stalledTask: true,
      progress: true,
      retry: true,
    },
  },
  
  storage: {
    stateDir: "~/.openclaw/extensions/task-monitor/state",
    tasksDir: "~/.openclaw/workspace/memory/tasks",
  },
  
  logging: {
    level: "info",
  },
};

// ==================== 辅助函数 ====================

/**
 * 展开 ~ 为用户主目录
 */
function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * 深度合并两个对象（用户配置覆盖默认配置）
 */
function deepMerge<T>(defaults: T, user: Partial<T>): T {
  const result = { ...defaults };
  
  for (const key in user) {
    if (user[key] !== undefined) {
      if (
        typeof user[key] === "object" &&
        user[key] !== null &&
        !Array.isArray(user[key]) &&
        typeof defaults[key] === "object" &&
        defaults[key] !== null &&
        !Array.isArray(defaults[key])
      ) {
        // 递归合并嵌套对象
        result[key] = deepMerge(defaults[key], user[key] as Partial<typeof defaults[typeof key]>);
      } else {
        // 直接覆盖
        result[key] = user[key] as typeof defaults[typeof key];
      }
    }
  }
  
  return result;
}

/**
 * 验证配置值范围
 */
function validateConfig(config: TaskMonitorConfig): string[] {
  const warnings: string[] = [];
  
  // 监控参数验证
  if (config.monitoring.subtaskTimeout < 60000) {
    warnings.push(`monitoring.subtaskTimeout (${config.monitoring.subtaskTimeout}) < 60000, using default`);
    config.monitoring.subtaskTimeout = DEFAULT_CONFIG.monitoring.subtaskTimeout;
  }
  
  if (config.monitoring.taskChainTimeout < 60000) {
    warnings.push(`monitoring.taskChainTimeout (${config.monitoring.taskChainTimeout}) < 60000, using default`);
    config.monitoring.taskChainTimeout = DEFAULT_CONFIG.monitoring.taskChainTimeout;
  }
  
  if (config.monitoring.stalledPendingThreshold < 60000) {
    warnings.push(`monitoring.stalledPendingThreshold (${config.monitoring.stalledPendingThreshold}) < 60000, using default`);
    config.monitoring.stalledPendingThreshold = DEFAULT_CONFIG.monitoring.stalledPendingThreshold;
  }
  
  if (config.monitoring.stalledRunningThreshold < 60000) {
    warnings.push(`monitoring.stalledRunningThreshold (${config.monitoring.stalledRunningThreshold}) < 60000, using default`);
    config.monitoring.stalledRunningThreshold = DEFAULT_CONFIG.monitoring.stalledRunningThreshold;
  }
  
  if (config.monitoring.mainTaskTimeout < 60000) {
    warnings.push(`monitoring.mainTaskTimeout (${config.monitoring.mainTaskTimeout}) < 60000, using default`);
    config.monitoring.mainTaskTimeout = DEFAULT_CONFIG.monitoring.mainTaskTimeout;
  }
  
  // 重试参数验证
  if (config.retry.maxRetries < 0 || config.retry.maxRetries > 5) {
    warnings.push(`retry.maxRetries (${config.retry.maxRetries}) out of range [0, 5], using default`);
    config.retry.maxRetries = DEFAULT_CONFIG.retry.maxRetries;
  }
  
  if (config.retry.checkInterval < 1000) {
    warnings.push(`retry.checkInterval (${config.retry.checkInterval}) < 1000, using default`);
    config.retry.checkInterval = DEFAULT_CONFIG.retry.checkInterval;
  }
  
  if (config.retry.spawnTimeout < 60000) {
    warnings.push(`retry.spawnTimeout (${config.retry.spawnTimeout}) < 60000, using default`);
    config.retry.spawnTimeout = DEFAULT_CONFIG.retry.spawnTimeout;
  }
  
  if (config.retry.backoffMultiplier < 1) {
    warnings.push(`retry.backoffMultiplier (${config.retry.backoffMultiplier}) < 1, using default`);
    config.retry.backoffMultiplier = DEFAULT_CONFIG.retry.backoffMultiplier;
  }
  
  if (config.retry.initialDelay < 10000) {
    warnings.push(`retry.initialDelay (${config.retry.initialDelay}) < 10000, using default`);
    config.retry.initialDelay = DEFAULT_CONFIG.retry.initialDelay;
  }
  
  // 进度参数验证
  if (config.progress.reportInterval < 10000) {
    warnings.push(`progress.reportInterval (${config.progress.reportInterval}) < 10000, using default`);
    config.progress.reportInterval = DEFAULT_CONFIG.progress.reportInterval;
  }
  
  if (config.progress.timeoutCheckInterval < 10000) {
    warnings.push(`progress.timeoutCheckInterval (${config.progress.timeoutCheckInterval}) < 10000, using default`);
    config.progress.timeoutCheckInterval = DEFAULT_CONFIG.progress.timeoutCheckInterval;
  }
  
  // 通知参数验证
  if (!["wecom", "telegram", "discord", "none"].includes(config.notification.channel)) {
    warnings.push(`notification.channel (${config.notification.channel}) invalid, using default`);
    config.notification.channel = DEFAULT_CONFIG.notification.channel;
  }
  
  if (config.notification.throttle < 0) {
    warnings.push(`notification.throttle (${config.notification.throttle}) < 0, using default`);
    config.notification.throttle = DEFAULT_CONFIG.notification.throttle;
  }
  
  if (config.notification.maxMessageLength < 50) {
    warnings.push(`notification.maxMessageLength (${config.notification.maxMessageLength}) < 50, using default`);
    config.notification.maxMessageLength = DEFAULT_CONFIG.notification.maxMessageLength;
  }
  
  // 静默时段验证
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (config.notification.quietHours.enabled) {
    if (!timeRegex.test(config.notification.quietHours.start)) {
      warnings.push(`notification.quietHours.start (${config.notification.quietHours.start}) invalid format, using default`);
      config.notification.quietHours.start = DEFAULT_CONFIG.notification.quietHours.start;
    }
    if (!timeRegex.test(config.notification.quietHours.end)) {
      warnings.push(`notification.quietHours.end (${config.notification.quietHours.end}) invalid format, using default`);
      config.notification.quietHours.end = DEFAULT_CONFIG.notification.quietHours.end;
    }
  }
  
  // 日志级别验证
  if (!["debug", "info", "warn", "error"].includes(config.logging.level)) {
    warnings.push(`logging.level (${config.logging.level}) invalid, using default`);
    config.logging.level = DEFAULT_CONFIG.logging.level;
  }
  
  return warnings;
}

// ==================== 导出函数 ====================

/**
 * 获取默认配置
 */
export function getDefaultConfig(): TaskMonitorConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * 加载配置
 * 
 * 1. 从 config.json 加载用户配置
 * 2. 如果不存在，使用默认配置
 * 3. 深度合并默认配置和用户配置
 * 4. 验证配置值范围
 * 5. 展开路径中的 ~ 
 */
export function loadConfig(): TaskMonitorConfig {
  const configPath = path.join(__dirname, "..", "config.json");
  
  try {
    // 检查配置文件是否存在
    if (!fs.existsSync(configPath)) {
      console.log("[task-monitor] Config file not found, using defaults");
      const defaultConfig = getDefaultConfig();
      // 展开路径
      defaultConfig.storage.stateDir = expandPath(defaultConfig.storage.stateDir);
      defaultConfig.storage.tasksDir = expandPath(defaultConfig.storage.tasksDir);
      return defaultConfig;
    }
    
    // 读取用户配置
    const configData = fs.readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(configData) as Partial<TaskMonitorConfig>;
    
    // 深度合并
    const mergedConfig = deepMerge(DEFAULT_CONFIG, userConfig);
    
    // 验证配置
    const warnings = validateConfig(mergedConfig);
    if (warnings.length > 0) {
      console.warn("[task-monitor] Config validation warnings:");
      warnings.forEach(w => console.warn(`  - ${w}`));
    }
    
    // 展开路径
    mergedConfig.storage.stateDir = expandPath(mergedConfig.storage.stateDir);
    mergedConfig.storage.tasksDir = expandPath(mergedConfig.storage.tasksDir);
    
    console.log(`[task-monitor] Config loaded: version=${mergedConfig.version}, ` +
      `subtaskTimeout=${mergedConfig.monitoring.subtaskTimeout}ms, ` +
      `maxRetries=${mergedConfig.retry.maxRetries}`);
    
    return mergedConfig;
  } catch (e) {
    console.error("[task-monitor] Failed to load config, using defaults:", e);
    const defaultConfig = getDefaultConfig();
    defaultConfig.storage.stateDir = expandPath(defaultConfig.storage.stateDir);
    defaultConfig.storage.tasksDir = expandPath(defaultConfig.storage.tasksDir);
    return defaultConfig;
  }
}
