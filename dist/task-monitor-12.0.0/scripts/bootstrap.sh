#!/bin/bash
# task-monitor 内置功能启动脚本
# 负责初始化所有监控和保障机制

set -e

SCRIPTS_DIR="/root/.openclaw/extensions/task-monitor/scripts"
LOG_FILE="/root/.openclaw/logs/task-monitor-bootstrap.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== task-monitor 启动 ==="

# 1. 检查并修复插件权限（仅在启动时）
log "检查插件权限..."
for plugin_dir in /root/.openclaw/extensions/*/; do
    if [ -d "$plugin_dir" ]; then
        owner=$(stat -c "%U" "$plugin_dir")
        if [ "$owner" != "root" ]; then
            log "修复权限: $plugin_dir (owner: $owner → root)"
            chown -R root:root "$plugin_dir"
        fi
    fi
done

# 2. 配置备份（启动时备份一次）
log "备份配置..."
mkdir -p /root/.openclaw/config-backups
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp /root/.openclaw/openclaw.json "/root/.openclaw/config-backups/openclaw.$TIMESTAMP.json" 2>/dev/null || true

# 3. 清理过期会话（启动时清理一次）
log "清理过期会话..."
find /root/.openclaw/agents/main/sessions -name "*.jsonl" -mtime +30 -delete 2>/dev/null || true

# 4. 验证插件加载
log "验证插件..."
openclaw doctor 2>&1 | grep -E "blocked|suspicious|error" && log "⚠️ 发现插件问题" || log "✓ 插件正常"

log "=== task-monitor 启动完成 ==="
