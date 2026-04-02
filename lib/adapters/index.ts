// lib/adapters/index.ts
/**
 * 适配器模块入口
 * 
 * 导出所有适配器，用于 V1 和 V2 之间的桥接
 */

export { StateManagerAdapter } from './state-manager-adapter';
export { AlertManagerAdapter } from './alert-manager-adapter';
export { NotificationAdapter } from './notification-adapter';
export type { NotificationConfig, NotificationRecord } from './notification-adapter';
