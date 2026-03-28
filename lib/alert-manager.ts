import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * 告警配置接口
 */
export interface AlertConfig {
  /** 告警渠道 */
  channel: string;
  /** 发送目标 */
  target: string;
}

/**
 * 告警记录接口
 */
export interface AlertRecord {
  /** 任务ID */
  taskId: string;
  /** 告警类型 */
  alertType: string;
  /** 告警时间戳 */
  timestamp: number;
}

/**
 * 告警管理器
 * 负责管理告警的发送、去重和记录
 */
export class AlertManager {
  /** 告警记录存储路径 */
  private alertPath: string;

  /** 冷却期（毫秒），默认5分钟 */
  private readonly COOLDOWN_MS: number = 300000;

  /** 告警配置 */
  private config: AlertConfig;

  /** 内存中的告警记录缓存 */
  private alertRecords: Map<string, AlertRecord> = new Map();

  constructor(config: AlertConfig, alertPath?: string) {
    this.config = config;
    this.alertPath = alertPath || path.join(process.cwd(), '.alert-records.json');
    this.loadRecords();
  }

  /**
   * 从文件加载告警记录
   */
  private loadRecords(): void {
    try {
      if (fs.existsSync(this.alertPath)) {
        const data = fs.readFileSync(this.alertPath, 'utf-8');
        const records: AlertRecord[] = JSON.parse(data);

        // 将记录加载到内存缓存中
        records.forEach((record) => {
          const key = this.getRecordKey(record.taskId, record.alertType);
          this.alertRecords.set(key, record);
        });
      }
    } catch (error) {
      console.error('[AlertManager] 加载告警记录失败:', error);
      // 加载失败时使用空的记录
      this.alertRecords = new Map();
    }
  }

  /**
   * 保存告警记录到文件
   */
  private saveRecords(): void {
    try {
      const records = Array.from(this.alertRecords.values());
      fs.writeFileSync(this.alertPath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (error) {
      console.error('[AlertManager] 保存告警记录失败:', error);
    }
  }

  /**
   * 生成记录的唯一键
   * @param taskId 任务ID
   * @param alertType 告警类型
   * @returns 唯一键
   */
  private getRecordKey(taskId: string, alertType: string): string {
    return `${taskId}:${alertType}`;
  }

  /**
   * 检查是否应该发送告警（去重逻辑）
   * @param taskId 任务ID
   * @param alertType 告警类型
   * @returns true 表示应该发送告警，false 表示在冷却期内不应发送
   */
  public shouldAlert(taskId: string, alertType: string): boolean {
    const key = this.getRecordKey(taskId, alertType);
    const record = this.alertRecords.get(key);

    // 如果没有记录，应该发送告警
    if (!record) {
      return true;
    }

    // 检查是否在冷却期内
    const now = Date.now();
    const timeSinceLastAlert = now - record.timestamp;

    // 如果超过冷却期，应该发送告警
    if (timeSinceLastAlert >= this.COOLDOWN_MS) {
      return true;
    }

    // 在冷却期内，不应发送告警
    console.log(
      `[AlertManager] 任务 ${taskId} 的 ${alertType} 类型告警在冷却期内，跳过发送。` +
      `距离上次告警: ${Math.floor(timeSinceLastAlert / 1000)}秒`
    );
    return false;
  }

  /**
   * 记录告警
   * @param taskId 任务ID
   * @param alertType 告警类型
   */
  public recordAlert(taskId: string, alertType: string): void {
    const key = this.getRecordKey(taskId, alertType);
    const record: AlertRecord = {
      taskId,
      alertType,
      timestamp: Date.now(),
    };

    this.alertRecords.set(key, record);
    this.saveRecords();

    console.log(`[AlertManager] 已记录告警: taskId=${taskId}, alertType=${alertType}`);
  }

  /**
   * 发送告警消息
   * @param taskId 任务ID
   * @param message 告警消息内容
   * @param alertType 告警类型
   * @returns Promise<boolean> 发送是否成功
   */
  public async sendAlert(
    taskId: string,
    message: string,
    alertType: string
  ): Promise<boolean> {
    // 检查是否应该发送告警
    if (!this.shouldAlert(taskId, alertType)) {
      return false;
    }

    try {
      // 构建完整的告警消息
      const fullMessage = `[${alertType}] 任务 ${taskId}: ${message}`;

      // 使用 child_process.exec 调用 openclaw message send
      const command = `openclaw message send --channel "${this.config.channel}" --target "${this.config.target}" --message "${this.escapeMessage(fullMessage)}"`;

      console.log(`[AlertManager] 发送告警命令: ${command}`);

      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        console.error('[AlertManager] 告警发送 stderr:', stderr);
      }

      if (stdout) {
        console.log('[AlertManager] 告警发送 stdout:', stdout);
      }

      // 记录告警
      this.recordAlert(taskId, alertType);

      console.log(`[AlertManager] 告警发送成功: taskId=${taskId}, alertType=${alertType}`);
      return true;
    } catch (error) {
      console.error('[AlertManager] 发送告警失败:', error);
      return false;
    }
  }

  /**
   * 转义消息中的特殊字符，防止命令注入
   * @param message 原始消息
   * @returns 转义后的消息
   */
  private escapeMessage(message: string): string {
    // 转义双引号、反斜杠和美元符号等特殊字符
    return message
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }

  /**
   * 清理过期的告警记录
   * 移除超过冷却期的旧记录，防止记录文件过大
   */
  public cleanupExpiredRecords(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    this.alertRecords.forEach((record, key) => {
      if (now - record.timestamp >= this.COOLDOWN_MS) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => {
      this.alertRecords.delete(key);
    });

    if (keysToDelete.length > 0) {
      this.saveRecords();
      console.log(`[AlertManager] 已清理 ${keysToDelete.length} 条过期告警记录`);
    }
  }

  /**
   * 获取当前配置
   */
  public getConfig(): AlertConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   * @param config 新的告警配置
   */
  public updateConfig(config: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...config };
    console.log('[AlertManager] 配置已更新:', this.config);
  }

  /**
   * 获取冷却期设置（毫秒）
   */
  public getCooldownMs(): number {
    return this.COOLDOWN_MS;
  }

  /**
   * 手动清除某个任务的所有告警记录
   * @param taskId 任务ID
   */
  public clearTaskRecords(taskId: string): void {
    const keysToDelete: string[] = [];

    this.alertRecords.forEach((record, key) => {
      if (record.taskId === taskId) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => {
      this.alertRecords.delete(key);
    });

    if (keysToDelete.length > 0) {
      this.saveRecords();
      console.log(`[AlertManager] 已清除任务 ${taskId} 的 ${keysToDelete.length} 条告警记录`);
    }
  }

  /**
   * 清除所有告警记录
   */
  public clearAllRecords(): void {
    this.alertRecords.clear();
    this.saveRecords();
    console.log('[AlertManager] 已清除所有告警记录');
  }
}

export default AlertManager;
