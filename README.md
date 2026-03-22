# OpenClaw Task Monitor Plugin

Task monitoring plugin for OpenClaw with automatic retry mechanism.

## Features

- **Task State Management**: Track task lifecycle (pending, running, completed, failed, timeout, etc.)
- **Auto-Retry**: Automatically retry failed/timeout tasks (up to 2 times by default)
- **Persistent Scheduling**: Retry schedules survive plugin restarts
- **Safe Execution**: Uses `spawn` with array parameters to prevent command injection
- **Watchdog**: Cron-based fallback to ensure retries execute even if plugin restarts
- **Notifications**: Send retry alerts and final failure notifications via WeCom

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
