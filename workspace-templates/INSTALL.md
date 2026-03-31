# 安装指南

## 快速安装

### 1. 安装 task-monitor 插件

```bash
# 克隆插件
cd ~/.openclaw/extensions
git clone https://github.com/bjyounger/openclaw-task-monitor.git task-monitor

# 安装依赖
cd task-monitor
pnpm install

# 构建
pnpm build
```

### 2. 初始化三层记忆架构

```bash
# 运行初始化脚本
./scripts/init-memory-architecture.sh

# 或指定工作区目录
./scripts/init-memory-architecture.sh /path/to/workspace
```

### 3. 配置插件

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "extensions": {
    "task-monitor": {
      "enabled": true,
      "config": {
        "notification": {
          "channel": "wecom",
          "target": "your-user-id",
          "enabled": true
        },
        "memory": {
          "enableAutoConsolidation": true,
          "enablePeriodicRefinement": true,
          "consolidationPath": "~/.openclaw/workspace/memory",
          "knowledgeBasePath": "~/.openclaw/workspace/memory/knowledge-base"
        }
      }
    }
  }
}
```

### 4. 重启 Gateway

```bash
openclaw gateway restart
```

### 5. 验证

```bash
# 检查插件加载
openclaw doctor

# 检查目录结构
ls -la ~/.openclaw/workspace/memory/

# 检查日志
tail -f ~/.openclaw/logs/gateway.log | grep -i memory
```

---

## 三层记忆架构

安装后会自动创建以下结构：

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

## 功能说明

### 自动沉淀（第一层 → 第二层）

任务完成时自动生成摘要并存储到 `memory/tasks/completed/`

### 定期提炼（第二层 → 第三层）

每周日 22:00 自动检查情境记忆，将高频信息提升到 MEMORY.md

### 访问追踪

记录信息被检索的次数，超过阈值自动提升

---

## 配置选项

```json
{
  "memory": {
    "enableAutoConsolidation": true,    // 启用自动沉淀
    "enablePeriodicRefinement": true,   // 启用定期提炼
    "consolidationPath": "path/to/memory",
    "knowledgeBasePath": "path/to/knowledge-base",
    "refinementSchedule": {
      "dayOfWeek": 0,    // 0=周日, 1=周一, ...
      "hour": 22,
      "minute": 0
    },
    "accessThreshold": 3  // 提炼阈值
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
```

### Memory 模块未初始化

```bash
# 手动运行初始化
./scripts/init-memory-architecture.sh

# 检查目录权限
ls -la ~/.openclaw/workspace/memory/
```

### 日志中无 memory 相关信息

```bash
# 检查配置是否正确
cat ~/.openclaw/openclaw.json | jq '.extensions.task-monitor.config.memory'

# 重启 Gateway
openclaw gateway restart
```

---

## 更新

```bash
cd ~/.openclaw/extensions/task-monitor
git pull
pnpm install
pnpm build
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
