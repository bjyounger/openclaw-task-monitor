/**
 * Memory 模块类型定义
 * @module task-monitor/lib/memory/types
 */

/**
 * 记忆管理配置
 */
export interface MemoryConfig {
  /** 是否启用自动巩固（任务完成时生成摘要） */
  enableAutoConsolidation: boolean;
  /** 是否启用定期提炼 */
  enablePeriodicRefinement: boolean;
  /** 情境记忆存储路径 */
  consolidationPath: string;
  /** 知识库路径 */
  knowledgeBasePath: string;
  /** 定期提炼调度配置 */
  refinementSchedule: {
    /** 星期几 (0=周日, 1=周一, ..., 6=周六) */
    dayOfWeek: number;
    /** 小时 (0-23) */
    hour: number;
    /** 分钟 (0-59) */
    minute: number;
  };
  /** 访问阈值（达到此阈值考虑提升到知识库） */
  accessThreshold: number;
}

/**
 * 任务摘要
 */
export interface TaskSummary {
  /** 任务 ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务类型 */
  type: 'coding' | 'research' | 'consulting' | 'ops' | 'other';
  /** 开始时间戳 */
  startTime: number;
  /** 结束时间戳 */
  endTime: number;
  /** 任务状态 */
  status: 'completed' | 'failed';
  /** 提取的目标 */
  goals: string[];
  /** 提取的成果 */
  achievements: string[];
  /** 遇到的问题及解决方案 */
  problems: { problem: string; solution: string }[];
  /** 提取的经验教训 */
  lessons: string[];
  /** 涉及的文件 */
  files: string[];
}

/**
 * Transcript 提取器接口
 */
export interface TranscriptExtractor {
  /** 提取目标 */
  extractGoals(transcript: any[]): string[];
  /** 提取成果 */
  extractAchievements(transcript: any[]): string[];
  /** 提取问题及解决方案 */
  extractProblems(transcript: any[]): { problem: string; solution: string }[];
  /** 提取经验教训 */
  extractLessons(transcript: any[]): string[];
  /** 提取文件路径 */
  extractFiles(transcript: any[]): string[];
}
