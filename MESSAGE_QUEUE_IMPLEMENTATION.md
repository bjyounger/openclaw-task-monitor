# 消息队列实现总结

## 完成的工作

### 1. 创建消息队列模块
- 文件：`lib/message-queue.ts`
- 功能：
  - 消息入队（当发送失败时）
  - 消息出队并发送（当连接恢复时）
  - 队列大小限制（默认 100 条）
  - 重试次数限制（默认 3 次）
  - 定期自动清空队列（每 30 秒）

### 2. 集成到主文件
- 文件：`index.ts`
- 修改：
  - 导入 `messageQueue` 单例
  - 在 `sendNotification` 函数中捕获异常并加入队列
  - 初始化时设置 AlertManager
  - 添加定时器定期清空队列

### 3. 配置支持
- 文件：`config.json`、`lib/config-loader.ts`
- 新增配置项：
  ```json
  {
    "messageQueue": {
      "maxQueueSize": 100,
      "maxRetries": 3,
      "retryInterval": 5000
    }
  }
  ```

### 4. 文档更新
- 文件：`README.md`
- 添加了消息队列功能说明

## 技术实现

### 消息队列类（MessageQueue）

```typescript
class MessageQueue {
  // 消息入队
  enqueue(taskId, message, alertType): boolean
  
  // 清空队列并发送
  async flushQueue(): Promise<void>
  
  // 设置连接状态
  setConnectionStatus(connected: boolean): void
  
  // 获取队列状态
  getStatus(): { queueSize, maxSize, maxRetries, isConnected, isProcessing }
}
```

### 集成点

1. **发送失败时入队**
   ```typescript
   try {
     const sent = await alertManager.sendAlert(...);
     if (!sent) {
       messageQueue.enqueue(...);
     }
   } catch (e) {
     messageQueue.enqueue(...);
   }
   ```

2. **定期自动清空**
   ```typescript
   setInterval(async () => {
     if (messageQueue.size() > 0) {
       await messageQueue.flushQueue();
     }
   }, 30000);
   ```

### 日志格式

- `[task-monitor] Message queued, queue size: X`
- `[task-monitor] Flushing message queue, count: X`
- `[task-monitor] Queued message sent successfully: msg-xxx`
- `[task-monitor] Message send failed after X retries, dropped: msg-xxx`

## 注意事项

### 为什么不监听 WS 连接状态？

1. **避免循环依赖**：task-monitor 插件不应直接依赖 wecom 扩展
2. **简化实现**：定期重试比监听事件更可靠
3. **容错性更强**：即使连接恢复事件丢失，定时器也能保证消息最终发送

### 为什么使用单例模式？

1. **全局唯一队列**：确保所有模块共享同一个队列
2. **状态一致性**：避免多个队列实例导致状态混乱
3. **简化使用**：无需传递队列实例

## 测试建议

### 手动测试步骤

1. 重启 Gateway 加载新代码：
   ```bash
   openclaw gateway restart
   ```

2. 断开企业微信 Bot 连接（关闭企业微信应用）

3. 触发一个会发送通知的事件（如子任务完成）

4. 检查日志：
   ```
   [task-monitor] Message queued, queue size: 1
   ```

5. 恢复企业微信 Bot 连接

6. 检查日志：
   ```
   [task-monitor] Flushing message queue, count: 1
   [task-monitor] Queued message sent successfully: msg-xxx
   ```

### 验证语法

```bash
cd ~/.openclaw/extensions/task-monitor
node -c lib/message-queue.ts
node -c index.ts
```

## 未来改进

1. **持久化存储**：将队列保存到文件，防止重启丢失
2. **优先级队列**：紧急消息优先发送
3. **监控指标**：队列大小、发送成功率等
4. **Web UI**：可视化队列状态

## 相关文件

```
~/.openclaw/extensions/task-monitor/
├── index.ts                    # 主文件（已修改）
├── lib/
│   ├── index.ts               # 导出文件（已修改）
│   ├── message-queue.ts       # 新建：消息队列实现
│   └── config-loader.ts       # 配置加载器（已修改）
├── config.json                # 配置文件（已修改）
├── README.md                  # 文档（已修改）
└── scripts/
    └── test-message-queue.ts  # 测试脚本（新建）
```
