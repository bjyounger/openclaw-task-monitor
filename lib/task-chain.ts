// task-chain.ts - 任务链追踪数据结构

import * as fs from 'fs';
import * as path from 'path';

/**
 * 任务链状态
 */
export type TaskChainStatus = "dispatching" | "waiting" | "completed" | "failed" | "timeout" | "orphaned";

/**
 * 子任务状态
 */
export type SubtaskStatus = "pending" | "running" | "completed" | "failed" | "timeout";

/**
 * 子任务信息
 */
export interface SubtaskInfo {
  /** 子任务 runId */
  runId: string;
  /** 子任务会话 key */
  sessionKey: string;
  /** 标签/描述 */
  label: string;
  /** 状态 */
  status: SubtaskStatus;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间 (可选) */
  endedAt?: number;
}

/**
 * 任务链
 */
export interface TaskChain {
  /** 主任务 ID */
  mainTaskId: string;
  /** 主任务会话 key */
  mainSessionKey: string;
  /** 用户 ID */
  userId: string;
  /** 任务链状态 */
  status: TaskChainStatus;
  /** 子任务列表 */
  subtasks: SubtaskInfo[];
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 最后活跃时间 (用于超时判断) */
  lastActivityAt: number;
  /** 超时时间 (毫秒) */
  timeoutMs: number;
  /** 主任务标签 */
  label?: string;
}

/**
 * 任务链文件结构
 */
export interface TaskChainFile {
  chains: TaskChain[];
  version: string;
  lastUpdated: number;
}

/**
 * 任务链管理器
 */
export class TaskChainManager {
  /** 任务链文件路径 */
  public readonly filePath: string;
  
  /** 锁文件路径 */
  private readonly lockPath: string;
  
  /** 锁超时时间 (毫秒) */
  private static readonly LOCK_TIMEOUT_MS = 5000;
  
  /** 锁轮询间隔 (毫秒) */
  private static readonly LOCK_POLL_INTERVAL_MS = 50;
  
  /** 状态文件版本 */
  private static readonly VERSION = '1.0.0';
  
  /** 默认超时时间 (15 分钟) */
  public static readonly DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

  /**
   * 创建任务链管理器实例
   * @param basePath 状态文件存储的基础路径
   */
  constructor(basePath: string) {
    this.filePath = path.join(basePath, 'task-chains.json');
    this.lockPath = path.join(basePath, 'task-chains.lock');
    
    // 确保目录存在
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 初始化任务链文件
    if (!fs.existsSync(this.filePath)) {
      this.writeFile({ chains: [], version: TaskChainManager.VERSION, lastUpdated: Date.now() });
    }
  }

  /**
   * 原子操作方法
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      const result = await fn();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * 获取文件锁
   */
  private async acquireLock(): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < TaskChainManager.LOCK_TIMEOUT_MS) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({
          pid: process.pid,
          timestamp: Date.now()
        }));
        fs.closeSync(fd);
        return;
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          try {
            const lockContent = fs.readFileSync(this.lockPath, 'utf-8');
            const lockData = JSON.parse(lockContent);
            
            if (Date.now() - lockData.timestamp > TaskChainManager.LOCK_TIMEOUT_MS) {
              fs.unlinkSync(this.lockPath);
              continue;
            }
          } catch {
            try {
              fs.unlinkSync(this.lockPath);
            } catch {}
          }
          
          await this.sleep(TaskChainManager.LOCK_POLL_INTERVAL_MS);
        } else {
          throw error;
        }
      }
    }
    
    throw new Error(`获取文件锁超时: ${this.lockPath}`);
  }

  /**
   * 释放文件锁
   */
  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {}
  }

  /**
   * 读取任务链文件
   */
  private readFile(): TaskChainFile {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { chains: [], version: TaskChainManager.VERSION, lastUpdated: Date.now() };
      }
      throw error;
    }
  }

  /**
   * 写入任务链文件
   */
  private writeFile(file: TaskChainFile): void {
    file.lastUpdated = Date.now();
    const content = JSON.stringify(file, null, 2);
    
    const tempPath = this.filePath + '.tmp';
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }

  /**
   * 辅助方法: 睡眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 创建任务链
   */
  public async createTaskChain(params: {
    mainTaskId: string;
    mainSessionKey: string;
    userId: string;
    label?: string;
    timeoutMs?: number;
  }): Promise<TaskChain> {
    return this.withLock(async () => {
      const file = this.readFile();
      
      // 检查是否已存在
      if (file.chains.some(c => c.mainTaskId === params.mainTaskId)) {
        throw new Error(`任务链已存在: ${params.mainTaskId}`);
      }
      
      const now = Date.now();
      const chain: TaskChain = {
        mainTaskId: params.mainTaskId,
        mainSessionKey: params.mainSessionKey,
        userId: params.userId,
        status: "dispatching",
        subtasks: [],
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        timeoutMs: params.timeoutMs ?? TaskChainManager.DEFAULT_TIMEOUT_MS,
        label: params.label,
      };
      
      file.chains.push(chain);
      this.writeFile(file);
      
      return chain;
    });
  }

  /**
   * 添加子任务到任务链
   */
  public async addSubtask(
    mainTaskId: string,
    subtask: Omit<SubtaskInfo, 'status' | 'startedAt'>
  ): Promise<TaskChain | null> {
    return this.withLock(async () => {
      const file = this.readFile();
      const chainIndex = file.chains.findIndex(c => c.mainTaskId === mainTaskId);
      
      if (chainIndex === -1) {
        return null;
      }
      
      const now = Date.now();
      const newSubtask: SubtaskInfo = {
        ...subtask,
        status: "running",
        startedAt: now,
      };
      
      file.chains[chainIndex].subtasks.push(newSubtask);
      file.chains[chainIndex].status = "waiting";
      file.chains[chainIndex].updatedAt = now;
      file.chains[chainIndex].lastActivityAt = now;
      
      this.writeFile(file);
      return file.chains[chainIndex];
    });
  }

  /**
   * 更新子任务状态
   */
  public async updateSubtask(
    mainTaskId: string,
    runId: string,
    updates: Partial<Pick<SubtaskInfo, 'status' | 'endedAt'>>
  ): Promise<TaskChain | null> {
    return this.withLock(async () => {
      const file = this.readFile();
      const chainIndex = file.chains.findIndex(c => c.mainTaskId === mainTaskId);
      
      if (chainIndex === -1) {
        return null;
      }
      
      const subtaskIndex = file.chains[chainIndex].subtasks.findIndex(
        s => s.runId === runId
      );
      
      if (subtaskIndex === -1) {
        return null;
      }
      
      // 更新子任务
      const subtask = file.chains[chainIndex].subtasks[subtaskIndex];
      file.chains[chainIndex].subtasks[subtaskIndex] = {
        ...subtask,
        ...updates,
      };
      
      // 检查是否所有子任务都完成
      const subtasks = file.chains[chainIndex].subtasks;
      const allCompleted = subtasks.every(
        s => s.status === 'completed' || s.status === 'failed' || s.status === 'timeout'
      );
      
      if (allCompleted) {
        // 区分全部成功和有失败的情况
        const hasFailure = subtasks.some(s => s.status === 'failed' || s.status === 'timeout');
        file.chains[chainIndex].status = hasFailure ? "failed" : "completed";
      }
      
      const now = Date.now();
      file.chains[chainIndex].updatedAt = now;
      file.chains[chainIndex].lastActivityAt = now;
      this.writeFile(file);
      
      return file.chains[chainIndex];
    });
  }

  /**
   * 获取任务链
   */
  public async getTaskChain(mainTaskId: string): Promise<TaskChain | null> {
    return this.withLock(async () => {
      const file = this.readFile();
      return file.chains.find(c => c.mainTaskId === mainTaskId) || null;
    });
  }

  /**
   * 根据子任务 runId 查找任务链
   */
  public async findChainBySubtaskRunId(runId: string): Promise<TaskChain | null> {
    return this.withLock(async () => {
      const file = this.readFile();
      return file.chains.find(c => 
        c.subtasks.some(s => s.runId === runId)
      ) || null;
    });
  }

  /**
   * 根据会话 key 查找任务链
   */
  public async findChainBySessionKey(sessionKey: string): Promise<TaskChain | null> {
    return this.withLock(async () => {
      const file = this.readFile();
      
      // 先检查主任务
      const mainChain = file.chains.find(c => c.mainSessionKey === sessionKey);
      if (mainChain) return mainChain;
      
      // 再检查子任务
      return file.chains.find(c => 
        c.subtasks.some(s => s.sessionKey === sessionKey)
      ) || null;
    });
  }

  /**
   * 检查超时的任务链
   */
  public async checkTimeouts(): Promise<TaskChain[]> {
    return this.withLock(async () => {
      const file = this.readFile();
      const now = Date.now();
      const timedOutChains: TaskChain[] = [];
      
      for (const chain of file.chains) {
        // 只检查未完成的任务链
        if (chain.status === 'completed' || chain.status === 'timeout') {
          continue;
        }
        
        // 检查是否超时 (基于最后活跃时间，而非创建时间)
        if (now - chain.lastActivityAt > chain.timeoutMs) {
          chain.status = 'timeout';
          chain.updatedAt = now;
          timedOutChains.push(chain);
        }
      }
      
      if (timedOutChains.length > 0) {
        this.writeFile(file);
      }
      
      return timedOutChains;
    });
  }

  /**
   * 清理已完成的任务链 (超过 24 小时)
   */
  public async cleanup(): Promise<number> {
    return this.withLock(async () => {
      const file = this.readFile();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      
      const before = file.chains.length;
      file.chains = file.chains.filter(
        c => c.status !== 'completed' || c.updatedAt > cutoff
      );
      const removed = before - file.chains.length;
      
      if (removed > 0) {
        this.writeFile(file);
      }
      
      return removed;
    });
  }

  /**
   * 获取所有活跃的任务链 (未完成)
   */
  public async getActiveChains(): Promise<TaskChain[]> {
    return this.withLock(async () => {
      const file = this.readFile();
      return file.chains.filter(
        c => c.status !== 'completed' && c.status !== 'timeout'
      );
    });
  }

  /**
   * 更新任务链状态
   */
  public async updateChainStatus(
    mainTaskId: string,
    status: TaskChainStatus
  ): Promise<TaskChain | null> {
    return this.withLock(async () => {
      const file = this.readFile();
      const chainIndex = file.chains.findIndex(c => c.mainTaskId === mainTaskId);
      
      if (chainIndex === -1) {
        return null;
      }
      
      file.chains[chainIndex].status = status;
      file.chains[chainIndex].updatedAt = Date.now();
      this.writeFile(file);
      
      return file.chains[chainIndex];
    });
  }
}

export default TaskChainManager;
