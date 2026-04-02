// tests/integration.test.ts
/**
 * 集成测试
 * 
 * 端到端测试：任务创建 → 执行 → 完成 → 告警的完整流程
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateManager } from '../lib/state-manager';
import { AlertManager } from '../lib/alert-manager';
import { StateManagerAdapter } from '../lib/adapters/state-manager-adapter';
import { AlertManagerAdapter } from '../lib/adapters/alert-manager-adapter';
import { NotificationAdapter } from '../lib/adapters/notification-adapter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 创建临时测试目录
const testDir = path.join(os.tmpdir(), `task-monitor-test-${Date.now()}`);

describe('Task Monitor Integration', () => {
  let stateManager: StateManager;
  let alertManager: AlertManager;
  let stateAdapter: StateManagerAdapter;
  let alertAdapter: AlertManagerAdapter;
  let notificationAdapter: NotificationAdapter;

  beforeEach(() => {
    // 确保测试目录存在
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // 初始化 V1 实例
    stateManager = new StateManager(testDir);
    alertManager = new AlertManager(
      {
        channel: 'wecom',
        target: 'test-target',
        cooldownPeriod: 1000, // 1 秒冷却期（测试用）
      },
      path.join(testDir, 'alert-records.json')
    );

    // 初始化适配器
    stateAdapter = new StateManagerAdapter(stateManager);
    alertAdapter = new AlertManagerAdapter(alertManager);
    notificationAdapter = new NotificationAdapter({
      defaultChannel: 'wecom',
      defaultTarget: 'test-target',
      enabled: false, // 测试时禁用实际发送
    });
  });

  afterEach(() => {
    // 清理测试目录
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  describe('任务生命周期', () => {
    it('应该完成完整的任务生命周期：创建 → 运行 → 完成', async () => {
      const taskId = 'test-task-1';

      // 1. 创建任务
      const task = await stateAdapter.registerTask({
        id: taskId,
        type: 'sub',
        status: 'pending',
        parentTaskId: 'main-1',
        metadata: { label: '测试任务' },
      });

      expect(task.id).toBe(taskId);
      expect(task.status).toBe('pending');
      expect(task.type).toBe('sub');

      // 2. 启动任务（更新状态为 running）
      await stateAdapter.updateTask(taskId, { status: 'running' });
      const runningTask = await stateAdapter.getTask(taskId);
      expect(runningTask?.status).toBe('running');

      // 3. 完成任务
      await stateAdapter.updateTask(taskId, {
        status: 'completed',
        completedAt: Date.now(),
      });
      const completedTask = await stateAdapter.getTask(taskId);
      expect(completedTask?.status).toBe('completed');
    });

    it('应该正确处理任务失败和重试', async () => {
      const taskId = 'test-task-retry';

      // 1. 创建任务
      await stateAdapter.registerTask({
        id: taskId,
        type: 'sub',
        status: 'pending',
        metadata: { label: '重试测试' },
      });

      // 2. 启动并失败
      await stateAdapter.updateTask(taskId, { status: 'running' });
      await stateAdapter.updateTask(taskId, { status: 'failed' });

      // 3. 检查是否应该重试
      const shouldRetry = await stateAdapter.shouldRetry(taskId);
      expect(shouldRetry).toBe(true);

      // 4. 安排重试
      await stateAdapter.scheduleRetry(taskId, 100);
      const scheduledTask = await stateAdapter.getTask(taskId);
      expect(scheduledTask?.status).toBe('scheduled');
      expect(scheduledTask?.retryCount).toBe(1);

      // 5. 执行重试
      await stateAdapter.markRetryExecuted(taskId);
      const retryTask = await stateAdapter.getTask(taskId);
      expect(retryTask?.status).toBe('running');
    });

    it('应该正确处理超时任务', async () => {
      const taskId = 'test-task-timeout';

      // 1. 创建任务（设置非常短的超时）
      await stateAdapter.registerTask({
        id: taskId,
        type: 'sub',
        status: 'pending',
        timeoutMs: 100, // 100ms 超时
        metadata: {},
      });

      // 2. 启动任务
      await stateAdapter.updateTask(taskId, { status: 'running' });

      // 3. 等待超时
      await new Promise(resolve => setTimeout(resolve, 150));

      // 4. 检查超时
      const timedOutTasks = await stateAdapter.getTimedOutTasks();
      expect(timedOutTasks.length).toBeGreaterThan(0);
      expect(timedOutTasks.some(t => t.id === taskId)).toBe(true);
    });
  });

  describe('告警管理', () => {
    it('应该正确发送和去重告警', async () => {
      const taskId = 'test-alert-1';

      // 1. 第一次告警应该成功
      const firstAlert = alertAdapter.shouldAlert(taskId, 'timeout');
      expect(firstAlert).toBe(true);

      // 2. 记录告警
      alertAdapter.recordAlert(taskId, 'timeout');

      // 3. 冷却期内第二次告警应该被阻止
      const secondAlert = alertAdapter.shouldAlert(taskId, 'timeout');
      expect(secondAlert).toBe(false);

      // 4. 不同类型的告警应该不受影响
      const differentTypeAlert = alertAdapter.shouldAlert(taskId, 'failed');
      expect(differentTypeAlert).toBe(true);
    });

    it('应该正确清理过期告警记录', async () => {
      const taskId = 'test-alert-cleanup';

      // 1. 记录告警
      alertAdapter.recordAlert(taskId, 'timeout');

      // 2. 清理过期记录
      alertAdapter.cleanupExpiredRecords();

      // 3. 记录应该被清理
      const shouldAlert = alertAdapter.shouldAlert(taskId, 'timeout');
      expect(shouldAlert).toBe(true);
    });
  });

  describe('通知发送', () => {
    it('应该记录通知历史', async () => {
      const taskId = 'test-notification-1';

      // 1. 发送通知（已禁用，只记录历史）
      await notificationAdapter.sendTaskNotification(taskId, '测试通知', {
        type: 'test',
        channel: 'wecom',
        target: 'test-target',
      });

      // 2. 检查通知历史
      const history = notificationAdapter.getNotificationHistory(taskId);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].taskId).toBe(taskId);
      expect(history[0].type).toBe('test');
    });

    it('应该提供便捷的通知方法', async () => {
      const taskId = 'test-notification-convenient';

      // 测试各种通知类型
      await notificationAdapter.notifyTaskCreated(taskId, '测试任务');
      await notificationAdapter.notifyTaskCompleted(taskId, '测试任务', 5000);
      await notificationAdapter.notifyTaskFailed(taskId, '测试任务', '测试错误');
      await notificationAdapter.notifyTaskTimeout(taskId, '测试任务', 60000);
      await notificationAdapter.notifyTaskRetry(taskId, '测试任务', 1, 3);

      const history = notificationAdapter.getNotificationHistory(taskId);
      expect(history.length).toBe(5);
      expect(history.map(h => h.type)).toEqual([
        'task_created',
        'task_completed',
        'task_failed',
        'task_timeout',
        'task_retry',
      ]);
    });

    it('应该支持启用/禁用通知', () => {
      expect(notificationAdapter.isEnabled()).toBe(false);

      notificationAdapter.enable();
      expect(notificationAdapter.isEnabled()).toBe(true);

      notificationAdapter.disable();
      expect(notificationAdapter.isEnabled()).toBe(false);
    });
  });

  describe('完整工作流', () => {
    it('应该完成完整的工作流：任务创建 → 超时 → 告警 → 重试 → 完成', async () => {
      const taskId = 'workflow-test-1';

      // 1. 创建任务
      const task = await stateAdapter.registerTask({
        id: taskId,
        type: 'sub',
        status: 'pending',
        timeoutMs: 100,
        metadata: { label: '工作流测试' },
      });

      // 2. 启动任务
      await stateAdapter.updateTask(taskId, { status: 'running' });

      // 3. 模拟超时
      await new Promise(resolve => setTimeout(resolve, 150));
      const timedOutTasks = await stateAdapter.getTimedOutTasks();
      expect(timedOutTasks.some(t => t.id === taskId)).toBe(true);

      // 4. 发送超时告警
      const shouldAlert = alertAdapter.shouldAlert(taskId, 'timeout');
      expect(shouldAlert).toBe(true);
      alertAdapter.recordAlert(taskId, 'timeout');

      // 5. 发送通知
      await notificationAdapter.notifyTaskTimeout(taskId, '工作流测试', 100);

      // 6. 安排重试
      await stateAdapter.scheduleRetry(taskId, 100);

      // 7. 执行重试
      await stateAdapter.markRetryExecuted(taskId);
      const retryTask = await stateAdapter.getTask(taskId);
      expect(retryTask?.status).toBe('running');

      // 8. 完成任务
      await stateAdapter.updateTask(taskId, { status: 'completed' });
      const finalTask = await stateAdapter.getTask(taskId);
      expect(finalTask?.status).toBe('completed');

      // 9. 发送完成通知
      await notificationAdapter.notifyTaskCompleted(taskId, '工作流测试', 5000);

      // 10. 验证通知历史
      const notificationHistory = notificationAdapter.getNotificationHistory(taskId);
      expect(notificationHistory.length).toBe(2);
      expect(notificationHistory[0].type).toBe('task_timeout');
      expect(notificationHistory[1].type).toBe('task_completed');
    });

    it('应该处理重试耗尽的情况', async () => {
      const taskId = 'workflow-retry-exhausted';

      // 1. 创建任务
      await stateAdapter.registerTask({
        id: taskId,
        type: 'sub',
        status: 'pending',
        maxRetries: 2,
        metadata: { label: '重试耗尽测试' },
      });

      // 2. 第一次失败和重试
      await stateAdapter.updateTask(taskId, { status: 'running' });
      await stateAdapter.updateTask(taskId, { status: 'failed' });
      await stateAdapter.scheduleRetry(taskId, 50);

      // 3. 第二次失败和重试
      await stateAdapter.markRetryExecuted(taskId);
      await stateAdapter.updateTask(taskId, { status: 'failed' });
      await stateAdapter.scheduleRetry(taskId, 50);

      // 4. 第三次失败后无法再重试
      await stateAdapter.markRetryExecuted(taskId);
      await stateAdapter.updateTask(taskId, { status: 'failed' });

      const shouldRetry = await stateAdapter.shouldRetry(taskId);
      expect(shouldRetry).toBe(false);

      // 5. 放弃任务
      const abandonedTask = await stateAdapter.abandonTask(taskId);
      expect(abandonedTask?.status).toBe('abandoned');
    });
  });

  describe('适配器兼容性', () => {
    it('StateManagerAdapter 应该正确转换 V1 和 V2 格式', async () => {
      const taskId = 'adapter-test-1';

      // 创建任务（使用 V2 接口）
      const v2Task = await stateAdapter.registerTask({
        id: taskId,
        type: 'sub',
        status: 'pending',
        priority: 'high',
        metadata: {
          customField: 'test',
          label: '适配器测试',
        },
      });

      // 验证 V2 格式
      expect(v2Task.id).toBe(taskId);
      expect(v2Task.type).toBe('sub');
      expect(v2Task.priority).toBe('high');
      expect(v2Task.metadata?.customField).toBe('test');

      // 获取任务（应该返回 V2 格式）
      const retrievedTask = await stateAdapter.getTask(taskId);
      expect(retrievedTask).toEqual(v2Task);
    });

    it('AlertManagerAdapter 应该正确封装 V1 AlertManager', () => {
      const taskId = 'alert-adapter-test';

      // V1 和 V2 接口应该行为一致
      const v1ShouldAlert = alertManager.shouldAlert(taskId, 'test');
      const v2ShouldAlert = alertAdapter.shouldAlert(taskId, 'test');
      expect(v1ShouldAlert).toBe(v2ShouldAlert);

      alertAdapter.recordAlert(taskId, 'test');
      alertManager.recordAlert(taskId, 'test');

      // 两者应该共享状态
      const v1ShouldAlertAfter = alertManager.shouldAlert(taskId, 'test');
      const v2ShouldAlertAfter = alertAdapter.shouldAlert(taskId, 'test');
      expect(v1ShouldAlertAfter).toBe(v2ShouldAlertAfter);
    });
  });
});
