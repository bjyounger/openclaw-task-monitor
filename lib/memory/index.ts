/**
 * Memory 模块入口
 * 提供记忆管理功能：任务摘要生成、情境记忆存储、定期提炼
 * @module task-monitor/lib/memory
 */

import { MemoryConfig, TaskSummary } from './types';
import { TaskSummaryGenerator } from './TaskSummaryGenerator';
import { EpisodicMemoryStorage } from './EpisodicMemoryStorage';
import { AccessTracker } from './AccessTracker';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { StateManager } from '../state-manager';

// 导出所有类型和模块
export { MemoryConfig, TaskSummary, TranscriptExtractor } from './types';
export { TaskSummaryGenerator, KeywordExtractor } from './TaskSummaryGenerator';
export { EpisodicMemoryStorage } from './EpisodicMemoryStorage';
export { AccessTracker } from './AccessTracker';

/**
 * OpenClaw Api 接口（简化定义）
 */
interface Api {
  logger: {
    info?: (message: string, ...args: any[]) => void;
    error?: (message: string, ...args: any[]) => void;
    warn?: (message: string, ...args: any[]) => void;
    debug?: (message: string, ...args: any[]) => void;
  };
  runtime: {
    events: {
      onAgentEvent: (handler: (event: any) => void | Promise<void>) => void;
    };
  };
  onShutdown: (handler: () => void | Promise<void>) => void;
  config?: {
    workspaceDir?: string;
  };
}

/**
 * 记忆管理器（入口）
 * 组合各模块，提供统一接口
 */
export class MemoryManager {
  private config: MemoryConfig;
  private summaryGenerator: TaskSummaryGenerator;
  private storage: EpisodicMemoryStorage;
  private accessTracker: AccessTracker;
  private refinementTimer?: NodeJS.Timeout;
  private api: Api;
  private stateManager: StateManager;
  private destroyed: boolean = false;

  constructor(
    config: MemoryConfig,
    stateManager: StateManager,
    api: Api
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.api = api;

    // 初始化模块
    this.summaryGenerator = new TaskSummaryGenerator();
    this.storage = new EpisodicMemoryStorage(api, config.consolidationPath);
    this.accessTracker = new AccessTracker(api as any, config.consolidationPath);

    this.api.logger.info?.('[memory-manager] Initialized');
  }

  /**
   * 启动定期提炼任务
   */
  public startPeriodicRefinement(): void {
    if (!this.config.enablePeriodicRefinement) {
      this.api.logger.info?.('[memory-manager] Periodic refinement disabled');
      return;
    }

    if (this.destroyed) {
      this.api.logger.warn?.('[memory-manager] Cannot start refinement: manager destroyed');
      return;
    }

    const nextRun = this.calculateNextRun();
    const delay = nextRun.getTime() - Date.now();

    this.refinementTimer = setTimeout(async () => {
      if (this.destroyed) return;
      
      try {
        await this.runRefinement();
      } catch (error) {
        this.api.logger.error?.('[memory-manager] Refinement failed:', error);
      }
      
      // 递归调度下一次
      if (!this.destroyed) {
        this.startPeriodicRefinement();
      }
    }, delay);

    this.api.logger.info?.(
      `[memory-manager] Next refinement scheduled at ${nextRun.toISOString()}`
    );
  }

  /**
   * 处理任务完成事件
   * @param runId 任务运行 ID
   */
  public async handleTaskCompletion(runId: string): Promise<void> {
    if (!this.config.enableAutoConsolidation) {
      return;
    }

    if (this.destroyed) {
      this.api.logger.warn?.('[memory-manager] Cannot handle completion: manager destroyed');
      return;
    }

    try {
      // 获取任务状态
      const task = await this.stateManager.getTask(runId);
      if (!task) {
        this.api.logger.debug?.(`[memory-manager] Task not found: ${runId}`);
        return;
      }

      // 生成摘要（暂不使用 transcript，因为 StateManager 未提供该方法）
      const summary = this.summaryGenerator.generateSummary(
        {
          id: task.id,
          name: task.metadata?.label || task.metadata?.taskDescription || 'Unnamed Task',
          startTime: task.startTime,
          endTime: Date.now(),
          status: task.status === 'completed' ? 'completed' : 'failed'
        },
        [] // transcript 暂时传空数组，待后续扩展
      );

      // 保存摘要
      await this.storage.saveTaskSummary(summary);

      // 记录访问
      this.accessTracker.recordAccess(runId);

      this.api.logger.info?.(`[memory-manager] Task summary saved: ${runId}`);
    } catch (error) {
      this.api.logger.error?.(
        `[memory-manager] Failed to handle task completion: ${runId}`,
        error
      );
    }
  }

  /**
   * 清理资源
   */
  public async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    // 清理定时器
    if (this.refinementTimer) {
      clearTimeout(this.refinementTimer);
      this.refinementTimer = undefined;
    }

    // 持久化访问计数
    try {
      await this.accessTracker.destroy();
    } catch (error) {
      this.api.logger.error?.('[memory-manager] Failed to destroy access tracker:', error);
    }

    this.api.logger.info?.('[memory-manager] Destroyed');
  }

  /**
   * 定期提炼执行
   * 扫描高频访问的任务摘要，考虑提升到知识库
   */
  private async runRefinement(): Promise<void> {
    this.api.logger.info?.('[memory-manager] Starting refinement...');

    try {
      if (this.destroyed) {
        this.api.logger.warn?.('[memory-manager] Cannot run refinement: manager destroyed');
        return;
      }

      // 获取高频访问项
      const highAccessItems = this.accessTracker.getHighAccessItems(
        this.config.accessThreshold
      );

      if (highAccessItems.length === 0) {
        this.api.logger.info?.('[memory-manager] No high-access items to promote');
        return;
      }

      this.api.logger.info?.(
        `[memory-manager] Found ${highAccessItems.length} high-access items: ${highAccessItems.join(', ')}`
      );

      // 提升高频访问项到知识库
      const fs = await import('fs');
      const path = await import('path');

      const knowledgeBaseDir = this.config.knowledgeBasePath || path.join(this.config.consolidationPath, 'knowledge-base');
      const knowledgeTaskDir = path.join(knowledgeBaseDir, 'tasks');
      
      // 确保知识库目录存在
      if (!fs.existsSync(knowledgeTaskDir)) {
        fs.mkdirSync(knowledgeTaskDir, { recursive: true });
        this.api.logger.info?.(`[memory-manager] Created knowledge base directory: ${knowledgeTaskDir}`);
      }

      let promotedCount = 0;
      const promotedIds: string[] = [];

      for (const runId of highAccessItems) {
        try {
          // 获取任务状态
          const task = await this.stateManager.getTask(runId);
          if (!task) {
            this.api.logger.debug?.(`[memory-manager] Task not found in state: ${runId}`);
            continue;
          }

          // 构造源文件路径（情境记忆中的摘要）
          const summariesDir = path.join(this.config.consolidationPath, 'summaries');
          const sourceFile = path.join(summariesDir, `${runId}.md`);
          
          if (!fs.existsSync(sourceFile)) {
            this.api.logger.debug?.(`[memory-manager] Summary file not found: ${sourceFile}`);
            continue;
          }

          // 读取摘要内容
          const summaryContent = fs.readFileSync(sourceFile, 'utf-8');
          
          // 检查是否已提升
          if (summaryContent.includes('<!-- promoted: true -->')) {
            this.api.logger.debug?.(`[memory-manager] Task already promoted: ${runId}`);
            continue;
          }

          // 构造目标文件名（时间+任务名称）
          const taskName = task.label || (task.metadata?.taskDescription as string) || (task.metadata?.label as string) || 'unnamed';
          const safeName = taskName.replace(/[^\w\u4e00-\u9fa5-]/g, '_').substring(0, 50);
          const timestamp = new Date(task.startTime).toISOString().split('T')[0];
          const targetFile = path.join(knowledgeTaskDir, `${timestamp}-${safeName}.md`);

          // 添加提升标记
          const promotedContent = summaryContent + '\n\n<!-- promoted: true -->\n<!-- promoted_from: episodic -->\n<!-- promoted_at: ' + new Date().toISOString() + ' -->';

          // 写入知识库
          fs.writeFileSync(targetFile, promotedContent, 'utf-8');
          this.api.logger.info?.(`[memory-manager] ✅ Promoted task summary to knowledge base: ${runId} -> ${targetFile}`);

          // 更新原始摘要文件标记为已提升
          const updatedOriginal = summaryContent + '\n\n<!-- promoted: true -->\n<!-- knowledge_file: ' + targetFile + ' -->';
          fs.writeFileSync(sourceFile, updatedOriginal, 'utf-8');

          promotedCount++;
          promotedIds.push(runId);
        } catch (promoteError) {
          this.api.logger.error?.(
            `[memory-manager] Failed to promote task ${runId}:`,
            promoteError
          );
        }
      }

      // 持久化访问计数
      await this.accessTracker.persist();

      this.api.logger.info?.(
        `[memory-manager] Refinement complete: promoted ${promotedCount}/${highAccessItems.length} items (${promotedIds.join(', ')})`
      );
    } catch (error) {
      this.api.logger.error?.('[memory-manager] Refinement failed:', error);
    }
  }

  /**
   * 计算下次执行时间
   */
  private calculateNextRun(): Date {
    const now = new Date();
    const { dayOfWeek, hour, minute } = this.config.refinementSchedule;

    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);

    const currentDay = next.getDay();
    const daysUntilTarget = (dayOfWeek - currentDay + 7) % 7;
    next.setDate(next.getDate() + daysUntilTarget);

    // 如果目标时间已过，推到下一周
    if (next <= now) {
      next.setDate(next.getDate() + 7);
    }

    return next;
  }
}
