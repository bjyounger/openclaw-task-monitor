/**
 * 消息队列测试脚本
 */

// 模拟 AlertManager
class MockAlertManager {
  private isConnected = false;
  
  setConnected(connected: boolean) {
    this.isConnected = connected;
  }
  
  async sendAlert(taskId: string, message: string, alertType: string): Promise<boolean> {
    if (!this.isConnected) {
      console.log(`[MockAlertManager] 发送失败（未连接）: ${taskId}`);
      return false;
    }
    console.log(`[MockAlertManager] 发送成功: ${taskId} - ${message.substring(0, 30)}...`);
    return true;
  }
  
  getConfig() {
    return { channel: 'wecom', target: 'test' };
  }
}

async function testMessageQueue() {
  console.log('=== 测试消息队列 ===\n');
  
  // 动态导入消息队列模块
  const { MessageQueue } = await import('../lib/message-queue');
  
  // 创建消息队列实例
  const queue = new MessageQueue({
    maxQueueSize: 5,
    maxRetries: 2,
    retryInterval: 1000,
  });
  
  const alertManager = new MockAlertManager();
  queue.setAlertManager(alertManager as any);
  
  // 测试 1: 消息入队
  console.log('\n测试 1: 消息入队');
  queue.enqueue('task-1', '测试消息 1', 'test');
  queue.enqueue('task-2', '测试消息 2', 'test');
  console.log(`队列大小: ${queue.size()}`);
  
  // 测试 2: 队列状态
  console.log('\n测试 2: 队列状态');
  const status = queue.getStatus();
  console.log(`状态: ${JSON.stringify(status, null, 2)}`);
  
  // 测试 3: 连接恢复后自动发送
  console.log('\n测试 3: 连接恢复后自动发送');
  alertManager.setConnected(true);
  queue.setConnectionStatus(true);
  
  // 等待队列处理
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log(`队列大小: ${queue.size()}`);
  
  console.log('\n=== 测试完成 ===');
}

testMessageQueue().catch(console.error);
