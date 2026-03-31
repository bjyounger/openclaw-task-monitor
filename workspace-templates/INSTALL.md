# 安装指南

## 快速安装（推荐）

### 1. 克隆插件

```bash
cd ~/.openclaw/extensions
git clone https://github.com/bjyounger/openclaw-task-monitor.git task-monitor
cd task-monitor
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 运行安装后初始化

```bash
./scripts/post-install.sh
```

这个脚本会自动：
- ✅ 从 config.example.json 创建 config.json
- ✅ 初始化三层记忆架构（MEMORY.md、SESSION-STATE.md、memory/ 目录）
- ✅ 检查 openclaw.json 配置完整性
- ✅ 创建必要的目录结构

### 4. 配置通知渠道

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "extensions": {
    "task-monitor": {
      "enabled": true,
      "config": {
        "notification": {
          "channel": "wecom",
          "target": "your-user-id"
        }
      }
    }
  }
}
```

### 5. 重启 Gateway

```bash
openclaw gateway restart
```

### 6. 验证

```bash
# 检查插件加载
openclaw doctor

# 检查目录结构
ls -la ~/.openclaw/workspace/memory/

# 检查日志
tail -f ~/.openclaw/logs/gateway.log | grep -i task-monitor
```

---

## 手动安装（详细步骤）

如果需要手动控制每一步：

### 1. 克隆并安装依赖

```bash
cd ~/.openclaw/extensions
git clone https://github.com/bjyounger/openclaw-task-monitor.git task-monitor
cd task-monitor
pnpm install
```

### 2. 创建配置文件

```bash
# 从示例创建配置
cp config.example.json config.json
```

### 3. 初始化三层记忆架构

```bash
./scripts/init-memory-architecture.sh
```

### 4. 配置通知

编辑 `~/.openclaw/openclaw.json` 添加 notification 配置。

### 5. 重启 Gateway

```bash
openclaw gateway restart
```

---

## 三层记忆架构

安装后自动创建以下结构：

```
~/.openclaw/workspace/
├── MEMORY.md                    # 第三层：长效记忆
├── SESSION-STATE.md             # 第一层：工作记忆
└── memory/
    ├── memory-config.json       # 记忆配置
    ├── episodic/                # 第二层：情境记忆
    │   ├── decisions/           # 决策记录
    │   ├── preferences/         # 偏好记录
    │   └── people/              # 人物记录
    ├── tasks/                   # 任务摘要
    │   ├── completed/           # 已完成
    │   └── running/             # 进行中
    └── knowledge-base/          # 知识库
        ├── ai/                  # AI 相关
        ├── tech/                # 技术文档
        ├── skills/              # Skills 文档
        ├── tools/               # 工具对比
        └── tutorial/            # 教程
```

---

## 配置注入（可选）

`workspace-templates/inject-config.json` 定义了需要注入到 AGENTS.md 和 HEARTBEAT.md 的内容：

| 注入项 | 目标文件 | 说明 |
|--------|----------|------|
| `agents-verification` | AGENTS.md | 验证铁律：证据先于断言 |
| `agents-debugging` | AGENTS.md | 系统化调试流程 |
| `agents-planning` | AGENTS.md | 强制规划流程 |
| `heartbeat-debugging` | HEARTBEAT.md | 调试四阶段流程 |

**注意**：配置注入需要手动合并或集成到启动流程。可参考 `workspace-templates/AGENTS.md.template` 和 `workspace-templates/HEARTBEAT.md.template`。

---

## 完整配置选项

```json
{
  "extensions": {
    "task-monitor": {
      "enabled": true,
      "config": {
        "notification": {
          "channel": "wecom",
          "target": "your-user-id",
          "enabled": true,
          "throttle": 3000,
          "maxMessageLength": 4096
        },
        "monitoring": {
          "subtaskTimeout": 1800000,
          "mainTaskTimeout": 86400000,
          "stalledThreshold": 1800000
        },
        "retry": {
          "maxRetries": 2,
          "retryDelayMs": 60000
        },
        "memory": {
          "enableAutoConsolidation": true,
          "enablePeriodicRefinement": true,
          "consolidationPath": "~/.openclaw/workspace/memory",
          "knowledgeBasePath": "~/.openclaw/workspace/memory/knowledge-base"
        },
        "maintenance": {
          "sessionRetentionDays": 30,
          "configBackupIntervalHours": 1,
          "healthCheckEnabled": true
        }
      }
    }
  }
}
```

---

## 故障排查

### 插件未加载

```bash
# 检查 openclaw.plugin.json
cat ~/.openclaw/extensions/task-monitor/openclaw.plugin.json

# 检查依赖
cd ~/.openclaw/extensions/task-monitor
pnpm install

# 检查 Gateway 日志
tail -f ~/.openclaw/logs/gateway.log | grep -i error
```

### Memory 模块未初始化

```bash
# 手动运行初始化
./scripts/init-memory-architecture.sh

# 检查目录权限
ls -la ~/.openclaw/workspace/memory/

# 检查配置
cat ~/.openclaw/openclaw.json | jq '.extensions["task-monitor"].config.memory'
```

### 通知未收到

```bash
# 检查 notification 配置
cat ~/.openclaw/openclaw.json | jq '.extensions["task-monitor"].config.notification'

# 测试发送
openclaw message send --channel wecom --target your-user-id --message "测试"
```

---

## 更新

```bash
cd ~/.openclaw/extensions/task-monitor
git pull
pnpm install
openclaw gateway restart
```

---

## 卸载

```bash
# 移除插件
rm -rf ~/.openclaw/extensions/task-monitor

# 保留记忆数据（可选）
# 记忆数据在 ~/.openclaw/workspace/memory/ 不会被删除

# 移除配置
# 编辑 ~/.openclaw/openclaw.json 移除 task-monitor 配置
```

---

## 检查清单

安装完成后，请确认以下项目：

- [ ] `config.json` 存在于插件目录
- [ ] `~/.openclaw/workspace/MEMORY.md` 存在
- [ ] `~/.openclaw/workspace/SESSION-STATE.md` 存在
- [ ] `~/.openclaw/workspace/memory/` 目录结构完整
- [ ] `openclaw.json` 中配置了 notification
- [ ] Gateway 重启后插件加载成功
- [ ] 日志中出现 `[task-monitor] Plugin registered`

---

*更新日期: 2026-04-01*
