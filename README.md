# OpenClaw Task Monitor Plugin

Task monitoring plugin for OpenClaw with automatic retry mechanism, task chain tracking, and workspace configuration injection.

## Features

### Core Features

- **Task State Management**: Track task lifecycle (pending, running, completed, failed, timeout, etc.)
- **Task Chain Tracking**: Track hierarchical task chains (main task → subtasks)
- **Auto-Retry**: Automatically retry failed/timeout tasks (up to 2 times by default)
- **Message Queue**: Cache failed notifications and retry on connection recovery
- **Persistent Scheduling**: Retry schedules survive plugin restarts
- **Safe Execution**: Uses `spawn` with array parameters to prevent command injection
- **Watchdog**: Cron-based fallback to ensure retries execute even if plugin restarts
- **Notifications**: Send alerts via configured channel (WeCom, Telegram, etc.)

### Notification Configuration (v12.1+)

Add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "task-monitor": {
        "enabled": true,
        "config": {
          "notification": {
            "channel": "wecom",
            "target": "wecom:YangKe",
            "throttle": 3000,
            "maxMessageLength": 4096
          }
        }
      }
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `channel` | Yes | Notification channel (wecom, telegram, etc.) |
| `target` | Yes | Target identifier (e.g., wecom:YangKe) |
| `throttle` | No | Message throttle interval in ms (default: 1000) |
| `maxMessageLength` | No | Max message length (default: 4096) |

### New Features (v12+)

- **Config Injection**: Automatically inject hard constraints into workspace files (AGENTS.md, HEARTBEAT.md)
- **Workspace Templates**: Plugin-provided templates for verification rules, debugging workflow, planning process
- **Backup Support**: Automatic backup before injection
- **Exec Process Monitoring**: Monitor background exec processes
- **Real-time Failure Reporting**: Immediate alerts on task failures

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

---

## Config Injection (v12+)

### Overview

Automatically inject hard constraints (verification rules, debugging workflow, planning process) into workspace files. This ensures consistent behavior across all AI agents.

### Features

- **Template-based injection**: Plugin provides templates in `workspace-templates/`
- **Multiple injection modes**: merge, replace, append
- **Duplicate detection**: Automatically detects already injected content
- **Backup support**: Creates backup before injection
- **Status checking**: Check injection status for all configurable items

### Configuration

Configuration file: `workspace-templates/inject-config.json`

```json
{
  "version": "1.0.0",
  "injectables": [
    {
      "id": "agents-verification",
      "source": "workspace-templates/AGENTS.md.template",
      "target": "AGENTS.md",
      "mode": "merge",
      "section": "验证铁律（Verification Iron Law）",
      "required": true,
      "description": "验证铁律：证据先于断言，防止假完成"
    }
  ],
  "onInstall": "prompt",
  "onUpdate": "prompt",
  "backupEnabled": true
}
```

### Injection Modes

| Mode | Description |
|------|-------------|
| `merge` | Insert content into specified section |
| `replace` | Replace entire target file |
| `append` | Append content to end of file |

### Current Injectables

| ID | Target | Description |
|----|--------|-------------|
| `agents-verification` | AGENTS.md | 验证铁律：证据先于断言 |
| `agents-debugging` | AGENTS.md | 系统化调试：禁止无根因分析就修复 |
| `agents-planning` | AGENTS.md | 强制规划流程：禁止跳过规划直接编码 |
| `heartbeat-debugging` | HEARTBEAT.md | 调试四阶段流程 + 调试记录模板 |

### Usage

#### Check injection status

```bash
cd ~/.openclaw/extensions/task-monitor
npx tsx scripts/test-config-injector.ts
```

#### Perform injection

```bash
npx tsx scripts/test-config-injector.ts --inject
```

### API

```typescript
import { ConfigInjector } from './lib';

// Initialize
const injector = new ConfigInjector(pluginDir, workspaceDir);

// Check status
const status = injector.checkAll();

// Perform injection
const results = injector.injectAll();
```

### Templates

Templates are located in `workspace-templates/`:

- `AGENTS.md.template`: Hard constraints for AI agent behavior
- `HEARTBEAT.md.template`: Debugging workflow for heartbeat checks
- `inject-config.json`: Injection configuration

### Backup

Backups are stored in `<workspace>/backups/` with timestamp:

```
backups/
├── AGENTS.md.2026-03-26T11-49-06-722Z.bak
└── HEARTBEAT.md.2026-03-26T11-49-06-724Z.bak
```

---

## Installation Comparison

### Option A: npm install (Current)

```bash
cd ~/.openclaw/extensions
git clone https://github.com/bjyounger/openclaw-task-monitor.git task-monitor
cd task-monitor
npm install
```

**Pros**:
- Standard Node.js workflow
- Flexible (can choose specific versions)
- Works with any package manager

**Cons**:
- Requires user to run npm install
- Network dependency (npm registry)
- May fail if dependencies have issues

### Option B: Pre-compiled Package (Recommended)

```bash
cd ~/.openclaw/extensions
# Download pre-compiled package
wget https://github.com/bjyounger/openclaw-task-monitor/releases/download/v12.0.0/task-monitor.tgz
tar -xzf task-monitor.tgz
# Done! No npm install needed
```

**Pros**:
- One-step installation
- No network dependency after download
- All dependencies bundled
- Guaranteed to work (tested before release)

**Cons**:
- Larger package size
- Requires build process before release
- Less flexible (can't customize dependencies)

### Recommendation

**Use Option B (Pre-compiled Package)** for production deployments.

Benefits:
1. **Faster installation**: One command vs three
2. **More reliable**: No npm install failures
3. **Better for automation**: CI/CD pipelines can download and extract
4. **Consistent behavior**: Same code for all users

Implementation:
```bash
# Build script (for maintainers)
npm install
npm run build
npm pack
# Upload task-monitor-*.tgz to GitHub Releases
```

### Migration Guide

If currently using Option A:

```bash
# Remove old installation
rm -rf ~/.openclaw/extensions/task-monitor

# Install pre-compiled version
cd ~/.openclaw/extensions
wget https://github.com/bjyounger/openclaw-task-monitor/releases/latest/download/task-monitor.tgz
tar -xzf task-monitor.tgz
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| **v12.0.1** | 2026-03-31 | Bug fixes (P0/P1/P2), main task completion detection |
| v12.0.0 | 2026-03-26 | Config injection, pre-compiled packaging, OpenClaw 3.22 compat |
| v11.0.0 | 2026-03-24 | Auto task record, main task monitoring |
| v10.0.0 | 2026-03-23 | Task chain tracking, timeout detection |
| v9.0.0 | 2026-03-22 | Message queue for notifications |
| v8.0.0 | 2026-03-21 | Auto-retry mechanism v3 |

---

## Changelog

### v12.0.1 (2026-03-31)

**Bug Fixes**:
- P0: Memory leak in `activityTimeoutAlerted` Set
- P0: AlertManager cooldown config was ignored (hardcoded value)
- P1: Tool timeout default value handling (`||` → `??`)
- P2: Scheduled task status was not checked for timeout
- P2: Task chain timeout used `createdAt` instead of `lastActivityAt`
- P2: Task chain status logic error (now distinguishes allSuccess vs hasFailure)
- P2: Message queue could wait infinitely (added 30s periodic check)
- P2: Timer cleanup depended only on process signals (added exception handlers)

**New Features**:
- Main task completion detection via transcript
  - OpenClaw Gateway does not send lifecycle events (`turn_started`/`turn_ended`)
  - Plugin now detects main task completion from assistant message content

**Installation**:
```bash
wget https://github.com/bjyounger/openclaw-task-monitor/releases/download/v12.0.1/task-monitor-12.0.1.tgz
tar -xzf task-monitor-12.0.1.tgz
mv task-monitor-12.0.1 ~/.openclaw/extensions/task-monitor
```

### v12.0.0 (2026-03-26)

**New Features**:
- Config injection for workspace templates
- Pre-compiled packaging support
- Message queue for notifications
- OpenClaw 3.22 compatibility

**Breaking Changes**:
- `openclaw` is now a peerDependency (must be installed in OpenClaw environment)

**Installation**:
```bash
# Pre-compiled (recommended)
wget https://github.com/bjyounger/openclaw-task-monitor/releases/download/v12.0.0/task-monitor-12.0.0.tgz
tar -xzf task-monitor-12.0.0.tgz
mv task-monitor-12.0.0 ~/.openclaw/extensions/task-monitor
```
