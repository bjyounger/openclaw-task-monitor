# OpenClaw Task Monitor Plugin

Task monitoring plugin for OpenClaw with automatic retry mechanism and task chain tracking.

## Features

- **Task State Management**: Track task lifecycle (pending, running, completed, failed, timeout, etc.)
- **Task Chain Tracking**: Track hierarchical task chains (main task → subtasks)
- **Auto-Retry**: Automatically retry failed/timeout tasks (up to 2 times by default)
- **Message Queue**: Cache failed notifications and retry on connection recovery
- **Persistent Scheduling**: Retry schedules survive plugin restarts
- **Safe Execution**: Uses `spawn` with array parameters to prevent command injection
- **Watchdog**: Cron-based fallback to ensure retries execute even if plugin restarts
- **Notifications**: Send retry alerts and final failure notifications via WeCom

## Message Queue (v12)

### Overview

When Bot WebSocket disconnects, notifications fail to send. The message queue caches failed messages and automatically sends them when connection recovers.

### Configuration

Add to `config.json`:

```json
{
  "messageQueue": {
    "maxQueueSize": 100,      // Maximum queue length
    "maxRetries": 3,          // Maximum retry attempts per message
    "retryInterval": 5000     // Retry interval in milliseconds
  }
}
```

### How It Works

1. **Message Enqueue**: When `sendNotification` fails, message is added to queue
2. **Auto Retry**: Queue is flushed every 30 seconds
3. **Connection Recovery**: When Bot WS reconnects, queue is automatically flushed
4. **Retry Limit**: Messages exceeding max retries are dropped

### Logs

- `[task-monitor] Message queued, queue size: X` - Message added to queue
- `[task-monitor] Flushing message queue, count: X` - Starting to send queued messages
- `[task-monitor] Queued message sent successfully: msg-xxx` - Message sent successfully
- `[task-monitor] Message send failed after X retries, dropped: msg-xxx` - Message dropped

### API

```typescript
import { messageQueue } from './lib';

// Enqueue a message
messageQueue.enqueue(taskId, message, alertType);

// Get queue size
const size = messageQueue.size();

// Get queue status
const status = messageQueue.getStatus();

// Manually flush queue
await messageQueue.flushQueue();

// Set connection status
messageQueue.setConnectionStatus(true);
```

## Task Chain Tracking (v4)

### Overview

Task chains track hierarchical task relationships:
- Main task spawned from user request
- Subtasks spawned from main task
- Nested subtasks (grandchild tasks)

### Data Structures

```typescript
interface TaskChain {
  mainTaskId: string;          // Main task ID
  mainSessionKey: string;      // Main task session key
  userId: string;              // User ID
  status: TaskChainStatus;     // dispatching | waiting | completed | timeout | orphaned
  subtasks: SubtaskInfo[];     // Subtask list
  createdAt: number;           // Creation timestamp
  updatedAt: number;           // Last update timestamp
  timeoutMs: number;           // Timeout (default 15 minutes)
}

interface SubtaskInfo {
  runId: string;               // Subtask run ID
  sessionKey: string;          // Subtask session key
  label: string;               // Label/description
  status: SubtaskStatus;       // pending | running | completed | failed | timeout
  startedAt: number;           // Start timestamp
  endedAt?: number;            // End timestamp (optional)
}
```

### How It Works

1. **Main Task Detection**: When a subagent is spawned, check if `childSessionKey` contains `:subagent:`
   - No `:subagent:` → Main task (create new chain)
   - Has `:subagent:` → Subtask (add to parent chain)

2. **Chain Creation**: Main tasks create a new `TaskChain` record

3. **Subtask Addition**: Subtasks are added to their parent chain

4. **Status Updates**: When subtasks end, their status is updated in the chain

5. **Timeout Detection**: Every minute, check if chains exceed their timeout (default 15 min)

### Storage

- `state/task-chains.json`: Persistent chain storage
- `state/task-chains.lock`: File lock for concurrent access

## Installation

1. Clone to your OpenClaw extensions directory:
   ```bash
   cd ~/.openclaw/extensions
   git clone https://github.com/bjyounger/openclaw-task-monitor.git task-monitor
   ```

2. Install dependencies:
   ```bash
   cd task-monitor
   npm install
   ```

3. Restart OpenClaw Gateway:
   ```bash
   openclaw gateway restart
   ```

## Configuration

The plugin uses the following configuration in `openclaw.plugin.json`:

```json
{
  "name": "task-monitor",
  "version": "2.0.0",
  "hooks": ["subagent_ended"]
}
```

## Auto-Retry Mechanism

### State Machine

```
pending → running → completed (success)
                 → failed → scheduled → running (retry)
                 → timeout → scheduled → running (retry)
                 → killed (user terminated)
                 
failed/timeout → abandoned (retry exhausted)
```

### Key Components

- **TaskState**: Extended with `retryCount`, `maxRetries`, `retryHistory`
- **RetrySchedule**: Persistent storage in `state/scheduled-retries.json`
- **Watchdog**: `scripts/retry-watchdog.sh` - executes scheduled retries

### Safe Execution

Uses `spawn` with array parameters instead of `execSync` to prevent command injection:

```typescript
spawn('claude', ['--agent', agentId, '--print', taskDescription])
```

## Testing

Run the test suite:

```bash
npx ts-node scripts/test-retry.ts
```

Expected output:
```
✅ 任务注册
✅ 失败后自动调度重试
✅ 获取到期重试任务
✅ 标记重试已执行
✅ 重试耗尽后放弃
✅ 重试历史记录
✅ 取消重试调度

7/7 通过
```

## License

MIT

## Author

bjyounger
