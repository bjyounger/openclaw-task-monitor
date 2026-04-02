import type { ITaskDependencyManager } from './interfaces';
import type { ITaskDependency } from './types';

/**
 * 任务依赖管理器
 * 
 * 优化项 4.2：任务依赖关系管理
 * 
 * 功能：
 * 1. 管理任务之间的依赖关系
 * 2. 检测循环依赖
 * 3. 拓扑排序
 * 4. 获取可执行任务
 */
export class TaskDependencyManager implements ITaskDependencyManager {
  /** 依赖关系图：taskId -> 依赖列表 */
  private dependencyGraph: Map<string, ITaskDependency[]> = new Map();
  
  /** 反向依赖图：taskId -> 被哪些任务依赖 */
  private reverseDependencyGraph: Map<string, Set<string>> = new Map();
  
  /**
   * 添加依赖关系
   */
  public addDependency(taskId: string, dependency: ITaskDependency): void {
    // 检查循环依赖
    if (this.wouldCreateCircularDependency(taskId, dependency.taskId)) {
      throw new Error(
        `Adding dependency ${dependency.taskId} -> ${taskId} would create a circular dependency`
      );
    }
    
    // 添加到依赖图
    if (!this.dependencyGraph.has(taskId)) {
      this.dependencyGraph.set(taskId, []);
    }
    this.dependencyGraph.get(taskId)!.push(dependency);
    
    // 添加到反向依赖图
    if (!this.reverseDependencyGraph.has(dependency.taskId)) {
      this.reverseDependencyGraph.set(dependency.taskId, new Set());
    }
    this.reverseDependencyGraph.get(dependency.taskId)!.add(taskId);
  }
  
  /**
   * 移除依赖关系
   */
  public removeDependency(taskId: string, dependsOnTaskId: string): void {
    // 从依赖图移除
    const dependencies = this.dependencyGraph.get(taskId);
    if (dependencies) {
      const index = dependencies.findIndex(d => d.taskId === dependsOnTaskId);
      if (index !== -1) {
        dependencies.splice(index, 1);
      }
      if (dependencies.length === 0) {
        this.dependencyGraph.delete(taskId);
      }
    }
    
    // 从反向依赖图移除
    const dependents = this.reverseDependencyGraph.get(dependsOnTaskId);
    if (dependents) {
      dependents.delete(taskId);
      if (dependents.size === 0) {
        this.reverseDependencyGraph.delete(dependsOnTaskId);
      }
    }
  }
  
  /**
   * 获取任务的所有依赖
   */
  public getDependencies(taskId: string): ITaskDependency[] {
    return this.dependencyGraph.get(taskId) ?? [];
  }
  
  /**
   * 获取依赖此任务的所有任务
   */
  public getDependents(taskId: string): string[] {
    return Array.from(this.reverseDependencyGraph.get(taskId) ?? []);
  }
  
  /**
   * 检查依赖是否已满足
   */
  public areDependenciesMet(taskId: string, completedTasks: Set<string>): boolean {
    const dependencies = this.getDependencies(taskId);
    
    for (const dep of dependencies) {
      if (dep.type === 'hard') {
        // 硬依赖：必须完成
        if (!completedTasks.has(dep.taskId)) {
          return false;
        }
      } else if (dep.type === 'soft') {
        // 软依赖：可以跳过
        if (dep.timeoutMs) {
          // 检查是否超时
          const now = Date.now();
          // 假设依赖任务有创建时间，这里简化处理
          // 实际应该传入任务的创建时间
        }
      }
    }
    
    return true;
  }
  
  /**
   * 获取所有依赖已完成的任务（可执行）
   */
  public getReadyTasks(completedTasks: Set<string>): string[] {
    const readyTasks: string[] = [];
    
    // 遍历所有有依赖的任务
    for (const [taskId] of this.dependencyGraph) {
      // 跳过已完成的任务
      if (completedTasks.has(taskId)) {
        continue;
      }
      
      // 检查依赖是否满足
      if (this.areDependenciesMet(taskId, completedTasks)) {
        readyTasks.push(taskId);
      }
    }
    
    return readyTasks;
  }
  
  /**
   * 检测循环依赖
   */
  public hasCircularDependency(taskId: string): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    return this.detectCycle(taskId, visited, recursionStack);
  }
  
  /**
   * 检测添加依赖是否会创建循环
   */
  private wouldCreateCircularDependency(taskId: string, dependsOnTaskId: string): boolean {
    // 如果 taskId 可以到达 dependsOnTaskId，则添加 dependsOnTaskId -> taskId 会形成环
    return this.canReach(dependsOnTaskId, taskId, new Set());
  }
  
  /**
   * DFS 检测是否可以从 from 到达 to
   */
  private canReach(from: string, to: string, visited: Set<string>): boolean {
    if (from === to) {
      return true;
    }
    
    visited.add(from);
    
    const dependencies = this.dependencyGraph.get(from) ?? [];
    for (const dep of dependencies) {
      if (!visited.has(dep.taskId)) {
        if (this.canReach(dep.taskId, to, visited)) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * DFS 检测环
   */
  private detectCycle(
    taskId: string, 
    visited: Set<string>, 
    recursionStack: Set<string>
  ): boolean {
    visited.add(taskId);
    recursionStack.add(taskId);
    
    const dependencies = this.dependencyGraph.get(taskId) ?? [];
    for (const dep of dependencies) {
      if (!visited.has(dep.taskId)) {
        if (this.detectCycle(dep.taskId, visited, recursionStack)) {
          return true;
        }
      } else if (recursionStack.has(dep.taskId)) {
        return true;
      }
    }
    
    recursionStack.delete(taskId);
    return false;
  }
  
  /**
   * 获取依赖图拓扑排序
   */
  public getTopologicalOrder(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();
    
    // 收集所有任务
    const allTasks = new Set<string>();
    for (const [taskId, deps] of this.dependencyGraph) {
      allTasks.add(taskId);
      deps.forEach(d => allTasks.add(d.taskId));
    }
    
    // 拓扑排序
    for (const taskId of allTasks) {
      if (!visited.has(taskId)) {
        if (!this.topologicalSort(taskId, visited, temp, result)) {
          // 存在环
          throw new Error('Circular dependency detected');
        }
      }
    }
    
    return result;
  }
  
  /**
   * 拓扑排序 DFS
   */
  private topologicalSort(
    taskId: string,
    visited: Set<string>,
    temp: Set<string>,
    result: string[]
  ): boolean {
    visited.add(taskId);
    temp.add(taskId);
    
    const dependencies = this.dependencyGraph.get(taskId) ?? [];
    for (const dep of dependencies) {
      if (temp.has(dep.taskId)) {
        // 检测到环
        return false;
      }
      if (!visited.has(dep.taskId)) {
        if (!this.topologicalSort(dep.taskId, visited, temp, result)) {
          return false;
        }
      }
    }
    
    temp.delete(taskId);
    result.unshift(taskId);
    return true;
  }
  
  /**
   * 清除所有依赖关系
   */
  public clear(): void {
    this.dependencyGraph.clear();
    this.reverseDependencyGraph.clear();
  }
  
  /**
   * 获取统计信息
   */
  public getStats(): {
    totalTasks: number;
    totalDependencies: number;
    maxDependencies: number;
  } {
    let totalDependencies = 0;
    let maxDependencies = 0;
    
    for (const [taskId, deps] of this.dependencyGraph) {
      totalDependencies += deps.length;
      maxDependencies = Math.max(maxDependencies, deps.length);
    }
    
    return {
      totalTasks: this.dependencyGraph.size,
      totalDependencies,
      maxDependencies,
    };
  }
  
  /**
   * 导出为 DOT 格式（用于 Graphviz 可视化）
   */
  public exportDot(): string {
    const lines: string[] = ['digraph TaskDependencies {'];
    lines.push('  rankdir=LR;');
    lines.push('');
    
    // 节点
    const allTasks = new Set<string>();
    for (const [taskId, deps] of this.dependencyGraph) {
      allTasks.add(taskId);
      deps.forEach(d => allTasks.add(d.taskId));
    }
    
    for (const taskId of allTasks) {
      lines.push(`  "${taskId}";`);
    }
    
    lines.push('');
    
    // 边
    for (const [taskId, deps] of this.dependencyGraph) {
      for (const dep of deps) {
        const style = dep.type === 'hard' ? 'solid' : 'dashed';
        lines.push(`  "${taskId}" -> "${dep.taskId}" [style=${style}];`);
      }
    }
    
    lines.push('}');
    return lines.join('\n');
  }
}

export default TaskDependencyManager;
