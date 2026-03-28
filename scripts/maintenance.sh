#!/bin/bash
# task-monitor 维护脚本
# 统一管理所有维护任务

set -e

ACTION="${1:-}"
LOG_FILE="/root/.openclaw/logs/task-monitor-maintenance.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ACTION] $1" | tee -a "$LOG_FILE"
}

case "$ACTION" in
    backup-config)
        log "备份配置..."
        BACKUP_DIR="/root/.openclaw/config-backups"
        mkdir -p "$BACKUP_DIR"
        TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        cp /root/.openclaw/openclaw.json "$BACKUP_DIR/openclaw.$TIMESTAMP.json" 2>/dev/null
        
        # 保留最近 20 个备份
        ls -t "$BACKUP_DIR"/openclaw.*.json 2>/dev/null | tail -n +21 | xargs rm -f 2>/dev/null || true
        log "✓ 配置已备份"
        ;;
        
    cleanup-sessions)
        log "清理过期会话..."
        SESSIONS_DIR="/root/.openclaw/agents/main/sessions"
        DAYS=30
        
        BEFORE=$(find "$SESSIONS_DIR" -name "*.jsonl" 2>/dev/null | wc -l)
        DELETED=$(find "$SESSIONS_DIR" -name "*.jsonl" -mtime +$DAYS -delete -print 2>/dev/null | wc -l)
        AFTER=$(find "$SESSIONS_DIR" -name "*.jsonl" 2>/dev/null | wc -l)
        
        log "✓ 会话清理: $BEFORE → $AFTER (删除 $DELETED 个)"
        ;;
        
    health-check)
        log "系统健康检查..."
        
        # 1. Gateway 状态
        if curl -s http://localhost:26368/health 2>/dev/null | grep -q "ok"; then
            log "✓ Gateway 正常"
        else
            log "❌ Gateway 异常"
        fi
        
        # 2. 插件状态
        SUSPICIOUS=$(openclaw doctor 2>&1 | grep -c "blocked\|suspicious" || echo "0")
        if [ "$SUSPICIOUS" -eq 0 ]; then
            log "✓ 插件正常"
        else
            log "❌ 发现 $SUSPICIOUS 个插件问题"
            openclaw doctor 2>&1 | grep -E "blocked|suspicious" | tee -a "$LOG_FILE"
        fi
        
        # 3. 插件权限
        WRONG_OWNER=$(find /root/.openclaw/extensions -maxdepth 1 -type d ! -user root 2>/dev/null | wc -l)
        if [ "$WRONG_OWNER" -eq 0 ]; then
            log "✓ 插件权限正确"
        else
            log "⚠️ 有 $WRONG_OWNER 个插件权限异常"
            find /root/.openclaw/extensions -maxdepth 1 -type d ! -user root 2>/dev/null | tee -a "$LOG_FILE"
        fi
        
        # 4. 磁盘空间
        USAGE=$(df -h /root/.openclaw/ | tail -1 | awk '{print $5}' | sed 's/%//')
        if [ "$USAGE" -gt 80 ]; then
            log "⚠️ 磁盘使用率: ${USAGE}%"
        else
            log "✓ 磁盘空间充足: ${USAGE}%"
        fi
        
        log "✓ 健康检查完成"
        ;;
        
    *)
        echo "用法: $0 {backup-config|cleanup-sessions|health-check}"
        exit 1
        ;;
esac
