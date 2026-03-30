#!/bin/bash
# cleanup-state.sh - 清理 state.json 中的已完成任务
# 保留最近 7 天的已完成任务，删除更早的

set -e

STATE_FILE="/root/.openclaw/extensions/task-monitor/state/state.json"
BACKUP_DIR="/root/.openclaw/extensions/task-monitor/state/backups"
RETENTION_DAYS=7
RETENTION_MS=$((RETENTION_DAYS * 24 * 60 * 60 * 1000))

# 确保备份目录存在
mkdir -p "$BACKUP_DIR"

# 备份当前状态
TIMESTAMP=$(date +%Y%m%d%H%M%S)
BACKUP_FILE="$BACKUP_DIR/state-$TIMESTAMP.json"
cp "$STATE_FILE" "$BACKUP_FILE"
echo "✓ 已备份到: $BACKUP_FILE"

# 计算截止时间
CUTOFF_TIME=$(($(date +%s%3N) - RETENTION_MS))

# 清理已完成的旧任务（优先清理已通知的）
CLEANED=$(python3 << EOF
import json
from datetime import datetime

with open("$STATE_FILE", "r") as f:
    data = json.load(f)

original_count = len(data["tasks"])
cutoff = $CUTOFF_TIME

# 分类处理：
# 1. 已通知的已完成任务 → 直接清理（不管时间）
# 2. 未通知的已完成任务 → 保留 3 天
# 3. 其他状态 → 保留 7 天
data["tasks"] = [
    t for t in data["tasks"]
    if not (
        # 已通知的已完成任务，直接清理
        (t.get("status") in ("completed", "abandoned", "killed") and t.get("notified")) or
        # 未通知的已完成任务超过 3 天，清理
        (t.get("status") in ("completed", "abandoned", "killed") and not t.get("notified") and 
         t.get("lastHeartbeat", t.get("startTime", 0)) < (cutoff + 4 * 24 * 60 * 60 * 1000)) or
        # 其他已完成任务超过 7 天，清理
        (t.get("status") in ("completed", "abandoned", "killed") and 
         t.get("lastHeartbeat", t.get("startTime", 0)) < cutoff)
    )
]

cleaned_count = original_count - len(data["tasks"])

with open("$STATE_FILE", "w") as f:
    json.dump(data, f, indent=2)

print(cleaned_count)
EOF
)

echo "✓ 已清理 $CLEANED 个过期任务"

# 清理旧备份（保留最近 10 个）
cd "$BACKUP_DIR"
ls -t state-*.json | tail -n +11 | xargs -r rm -f
echo "✓ 已清理旧备份"

# 显示清理后的状态
AFTER_COUNT=$(jq '.tasks | length' "$STATE_FILE")
echo ""
echo "清理后任务数: $AFTER_COUNT"
echo "备份目录: $BACKUP_DIR"
