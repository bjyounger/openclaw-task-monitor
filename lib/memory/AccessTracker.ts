import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Api 接口（简化定义）
 */
interface Api {
  logger: {
    info?: (message: string, ...args: any[]) => void;
    error?: (message: string, ...args: any[]) => void;
    warn?: (message: string, ...args: any[]) => void;
  };
}

/**
 * 访问计数器
 * 职责单一：追踪访问频率，支持持久化
 */
export class AccessTracker {
  private counter: Map<string, number> = new Map();
  private stateFile: string;
  private dirty: boolean = false;

  constructor(
    private api: Api,
    consolidationPath: string
  ) {
    this.stateFile = join(consolidationPath, '.access-counter.json');
    this.loadState();
  }

  /**
   * 记录访问
   */
  public recordAccess(key: string): void {
    const count = this.counter.get(key) || 0;
    this.counter.set(key, count + 1);
    this.dirty = true;
  }

  /**
   * 获取高频访问项
   */
  public getHighAccessItems(threshold: number): string[] {
    const items: string[] = [];
    const entries = Array.from(this.counter.entries());
    for (const [key, count] of entries) {
      if (count >= threshold) {
        items.push(key);
      }
    }
    return items;
  }

  /**
   * 持久化状态
   */
  public async persist(): Promise<void> {
    if (!this.dirty) return;
    
    try {
      const state = Object.fromEntries(this.counter);
      await writeFile(this.stateFile, JSON.stringify(state), 'utf-8');
      this.dirty = false;
    } catch (error) {
      this.api.logger.error?.(`[access-tracker] Failed to persist state:`, error);
    }
  }

  /**
   * 加载状态（私有方法）
   */
  private async loadState(): Promise<void> {
    try {
      const content = await readFile(this.stateFile, 'utf-8');
      const state = JSON.parse(content);
      for (const [key, value] of Object.entries(state)) {
        this.counter.set(key, value as number);
      }
    } catch {
      // 文件不存在或格式错误，忽略
    }
  }

  /**
   * 清理资源（先持久化，再清空 Map）
   */
  public async destroy(): Promise<void> {
    await this.persist();
    this.counter.clear();
  }
}
