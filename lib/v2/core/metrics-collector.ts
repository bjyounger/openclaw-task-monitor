import type {
  IMetricsCollector,
  ITaskMetrics,
  TaskType,
  TaskPriority,
  ErrorType,
} from './interfaces';

/**
 * 任务指标收集器
 * 
 * 优化项 6：可观测性增强
 * 
 * 功能：
 * 1. 记录任务创建、完成、失败等事件
 * 2. 按类型、优先级统计
 * 3. 计算平均执行时长
 * 4. 维护最近 1 小时统计
 */
export class TaskMetricsCollector implements IMetricsCollector {
  /** 指标数据 */
  private metrics: ITaskMetrics;
  
  /** 最近事件时间戳列表（用于计算最近 1 小时统计） */
  private recentEvents: Array<{
    timestamp: number;
    type: 'created' | 'completed' | 'failed';
    duration?: number;
  }> = [];
  
  /** 当前活跃任务数 */
  private activeCount: number = 0;
  
  constructor() {
    this.metrics = this.initializeMetrics();
  }
  
  /**
   * 初始化指标结构
   */
  private initializeMetrics(): ITaskMetrics {
    return {
      totalCreated: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalTimeout: 0,
      averageDuration: 0,
      byType: {
        main: { created: 0, completed: 0, failed: 0, averageDuration: 0 },
        sub: { created: 0, completed: 0, failed: 0, averageDuration: 0 },
        exec: { created: 0, completed: 0, failed: 0, averageDuration: 0 },
        embedded: { created: 0, completed: 0, failed: 0, averageDuration: 0 },
      },
      byPriority: {
        low: { created: 0, completed: 0, failed: 0 },
        medium: { created: 0, completed: 0, failed: 0 },
        high: { created: 0, completed: 0, failed: 0 },
      },
      activeCount: 0,
      lastHour: {
        created: 0,
        completed: 0,
        failed: 0,
        averageDuration: 0,
      },
    };
  }
  
  /**
   * 记录任务创建
   */
  public recordTaskCreated(type: TaskType, priority: TaskPriority): void {
    this.metrics.totalCreated++;
    this.metrics.byType[type].created++;
    this.metrics.byPriority[priority].created++;
    this.activeCount++;
    this.metrics.activeCount = this.activeCount;
    
    this.addRecentEvent('created');
    this.updateLastHourStats();
  }
  
  /**
   * 记录任务完成
   */
  public recordTaskCompleted(type: TaskType, priority: TaskPriority, duration: number): void {
    this.metrics.totalCompleted++;
    this.metrics.byType[type].completed++;
    this.metrics.byPriority[priority].completed++;
    this.activeCount--;
    this.metrics.activeCount = Math.max(0, this.activeCount);
    
    // 更新平均执行时长
    this.updateAverageDuration(duration);
    this.updateTypeAverageDuration(type, duration);
    
    this.addRecentEvent('completed', duration);
    this.updateLastHourStats();
  }
  
  /**
   * 记录任务失败
   */
  public recordTaskFailed(type: TaskType, priority: TaskPriority, errorType: ErrorType): void {
    this.metrics.totalFailed++;
    this.metrics.byType[type].failed++;
    this.metrics.byPriority[priority].failed++;
    this.activeCount--;
    this.metrics.activeCount = Math.max(0, this.activeCount);
    
    this.addRecentEvent('failed');
    this.updateLastHourStats();
  }
  
  /**
   * 记录任务超时
   */
  public recordTaskTimeout(type: TaskType, priority: TaskPriority): void {
    this.metrics.totalTimeout++;
    this.metrics.byType[type].failed++;
    this.metrics.byPriority[priority].failed++;
    this.activeCount--;
    this.metrics.activeCount = Math.max(0, this.activeCount);
    
    this.addRecentEvent('failed');
    this.updateLastHourStats();
  }
  
  /**
   * 记录重试
   */
  public recordRetry(type: TaskType): void {
    // 可以扩展为更详细的重试统计
    this.metrics.byType[type].failed++;
  }
  
  /**
   * 更新活跃任务数
   */
  public updateActiveCount(count: number): void {
    this.activeCount = count;
    this.metrics.activeCount = Math.max(0, count);
  }
  
  /**
   * 获取指标快照
   */
  public getMetrics(): ITaskMetrics {
    this.updateLastHourStats();
    return { ...this.metrics };
  }
  
  /**
   * 重置指标
   */
  public reset(): void {
    this.metrics = this.initializeMetrics();
    this.recentEvents = [];
    this.activeCount = 0;
  }
  
  /**
   * 添加最近事件
   */
  private addRecentEvent(type: 'created' | 'completed' | 'failed', duration?: number): void {
    this.recentEvents.push({
      timestamp: Date.now(),
      type,
      duration,
    });
    
    // 清理超过 1 小时的事件
    this.cleanupRecentEvents();
  }
  
  /**
   * 清理超过 1 小时的事件
   */
  private cleanupRecentEvents(): void {
    const oneHourAgo = Date.now() - 3600_000;
    this.recentEvents = this.recentEvents.filter(e => e.timestamp >= oneHourAgo);
  }
  
  /**
   * 更新最近 1 小时统计
   */
  private updateLastHourStats(): void {
    this.cleanupRecentEvents();
    
    const oneHourEvents = this.recentEvents;
    
    const created = oneHourEvents.filter(e => e.type === 'created').length;
    const completed = oneHourEvents.filter(e => e.type === 'completed').length;
    const failed = oneHourEvents.filter(e => e.type === 'failed').length;
    
    const completedWithDuration = oneHourEvents.filter(
      e => e.type === 'completed' && e.duration !== undefined
    );
    const averageDuration = completedWithDuration.length > 0
      ? completedWithDuration.reduce((sum, e) => sum + (e.duration || 0), 0) / completedWithDuration.length
      : 0;
    
    this.metrics.lastHour = {
      created,
      completed,
      failed,
      averageDuration,
    };
  }
  
  /**
   * 更新总体平均执行时长
   */
  private updateAverageDuration(duration: number): void {
    const totalCompleted = this.metrics.totalCompleted;
    if (totalCompleted === 1) {
      this.metrics.averageDuration = duration;
    } else {
      this.metrics.averageDuration = 
        (this.metrics.averageDuration * (totalCompleted - 1) + duration) / totalCompleted;
    }
  }
  
  /**
   * 更新按类型的平均执行时长
   */
  private updateTypeAverageDuration(type: TaskType, duration: number): void {
    const typeMetrics = this.metrics.byType[type];
    const totalCompleted = typeMetrics.completed;
    
    if (totalCompleted === 1) {
      typeMetrics.averageDuration = duration;
    } else {
      typeMetrics.averageDuration = 
        (typeMetrics.averageDuration * (totalCompleted - 1) + duration) / totalCompleted;
    }
  }
  
  /**
   * 导出指标为 Prometheus 格式
   */
  public exportPrometheus(): string {
    const lines: string[] = [];
    const m = this.metrics;
    
    // 总体指标
    lines.push(`# HELP task_total_created Total tasks created`);
    lines.push(`# TYPE task_total_created counter`);
    lines.push(`task_total_created ${m.totalCreated}`);
    
    lines.push(`# HELP task_total_completed Total tasks completed`);
    lines.push(`# TYPE task_total_completed counter`);
    lines.push(`task_total_completed ${m.totalCompleted}`);
    
    lines.push(`# HELP task_total_failed Total tasks failed`);
    lines.push(`# TYPE task_total_failed counter`);
    lines.push(`task_total_failed ${m.totalFailed}`);
    
    lines.push(`# HELP task_active_count Current active tasks`);
    lines.push(`# TYPE task_active_count gauge`);
    lines.push(`task_active_count ${m.activeCount}`);
    
    lines.push(`# HELP task_average_duration Average task duration in milliseconds`);
    lines.push(`# TYPE task_average_duration gauge`);
    lines.push(`task_average_duration ${m.averageDuration}`);
    
    // 按类型统计
    lines.push(`# HELP task_by_type_created Tasks created by type`);
    lines.push(`# TYPE task_by_type_created counter`);
    for (const [type, stats] of Object.entries(m.byType)) {
      lines.push(`task_by_type_created{type="${type}"} ${stats.created}`);
    }
    
    lines.push(`# HELP task_by_type_completed Tasks completed by type`);
    lines.push(`# TYPE task_by_type_completed counter`);
    for (const [type, stats] of Object.entries(m.byType)) {
      lines.push(`task_by_type_completed{type="${type}"} ${stats.completed}`);
    }
    
    lines.push(`# HELP task_by_type_failed Tasks failed by type`);
    lines.push(`# TYPE task_by_type_failed counter`);
    for (const [type, stats] of Object.entries(m.byType)) {
      lines.push(`task_by_type_failed{type="${type}"} ${stats.failed}`);
    }
    
    // 按优先级统计
    lines.push(`# HELP task_by_priority_created Tasks created by priority`);
    lines.push(`# TYPE task_by_priority_created counter`);
    for (const [priority, stats] of Object.entries(m.byPriority)) {
      lines.push(`task_by_priority_created{priority="${priority}"} ${stats.created}`);
    }
    
    lines.push(`# HELP task_by_priority_completed Tasks completed by priority`);
    lines.push(`# TYPE task_by_priority_completed counter`);
    for (const [priority, stats] of Object.entries(m.byPriority)) {
      lines.push(`task_by_priority_completed{priority="${priority}"} ${stats.completed}`);
    }
    
    lines.push(`# HELP task_by_priority_failed Tasks failed by priority`);
    lines.push(`# TYPE task_by_priority_failed counter`);
    for (const [priority, stats] of Object.entries(m.byPriority)) {
      lines.push(`task_by_priority_failed{priority="${priority}"} ${stats.failed}`);
    }
    
    return lines.join('\n');
  }
}

export default TaskMetricsCollector;
