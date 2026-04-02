// lib/adapters/alert-manager-adapter.ts
/**
 * AlertManager 适配器
 * 
 * 封装 V1 AlertManager，提供 V2 IAlertManager 接口
 * 使 V1 实现可以在 V2 架构中使用
 */

import type { AlertManager } from '../alert-manager';
import type { IAlertManager } from '../v2/core/interfaces';

/**
 * AlertManager 适配器类
 * 
 * 实现 V2 IAlertManager 接口，内部使用 V1 AlertManager
 */
export class AlertManagerAdapter implements IAlertManager {
  constructor(private alertManager: AlertManager) {}

  /**
   * 发送告警
   * @param taskId 任务 ID
   * @param message 告警消息
   * @param type 告警类型
   * @param channel 可选的覆盖频道
   * @param target 可选的覆盖目标
   */
  async sendAlert(
    taskId: string,
    message: string,
    type: string,
    channel?: string,
    target?: string
  ): Promise<boolean> {
    return this.alertManager.sendAlertToTarget(taskId, message, type, channel, target);
  }

  /**
   * 检查是否应该发送告警（去重逻辑）
   * @param taskId 任务 ID
   * @param type 告警类型
   */
  shouldAlert(taskId: string, type: string): boolean {
    return this.alertManager.shouldAlert(taskId, type);
  }

  /**
   * 记录告警
   * @param taskId 任务 ID
   * @param type 告警类型
   */
  recordAlert(taskId: string, type: string): void {
    this.alertManager.recordAlert(taskId, type);
  }

  // ==================== 扩展方法（适配 V1 特有功能） ====================

  /**
   * 清理过期告警记录
   */
  cleanupExpiredRecords(): void {
    this.alertManager.cleanupExpiredRecords();
  }

  /**
   * 清除任务的所有告警记录
   * @param taskId 任务 ID
   */
  clearTaskRecords(taskId: string): void {
    this.alertManager.clearTaskRecords(taskId);
  }

  /**
   * 清除所有告警记录
   */
  clearAllRecords(): void {
    this.alertManager.clearAllRecords();
  }

  /**
   * 获取冷却期设置（毫秒）
   */
  getCooldownMs(): number {
    return this.alertManager.getCooldownMs();
  }

  /**
   * 获取当前配置
   */
  getConfig() {
    return this.alertManager.getConfig();
  }
}

export default AlertManagerAdapter;
