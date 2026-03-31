#!/bin/bash
# task-monitor 启动时维护脚本
# 用法: ./bootstrap.sh [--install-cron | --uninstall-cron]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
LOG_FILE="$OPENCLAW_DIR/logs/task-monitor-bootstrap.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

show_help() {
    cat << EOF
task-monitor 启动维护脚本

用法:
  ./bootstrap.sh [选项]

选项:
  无选项         执行一次启动维护
  --install-cron 安装 cron 任务（每天 6:00 执行）
  --uninstall-cron 移除 cron 任务
  --help         显示帮助信息

环境变量:
  OPENCLAW_DIR   OpenClaw 根目录（默认: ~/.openclaw）

维护内容:
  1. 检查并修复插件权限
  2. 备份 openclaw.json
  3. 清理过期会话（>30天）
  4. 验证插件加载状态

集成方式:
  1. Gateway 启动时执行:
     在 ~/.openclaw/scripts/gateway-start.sh 中添加:
     $PLUGIN_DIR/scripts/bootstrap.sh

  2. 定时执行:
     ./bootstrap.sh --install-cron

EOF
}

install_cron() {
    CRON_JOB="0 6 * * * $PLUGIN_DIR/scripts/bootstrap.sh >> $OPENCLAW_DIR/logs/bootstrap-cron.log 2>&1"
    
    if crontab -l 2>/dev/null | grep -q "bootstrap.sh"; then
        log "⚠️ cron 任务已存在"
        return 0
    fi
    
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
    log "✅ cron 任务已安装（每天 6:00 执行）"
}

uninstall_cron() {
    crontab -l 2>/dev/null | grep -v "bootstrap.sh" | crontab - 2>/dev/null || true
    log "✅ cron 任务已移除"
}

run_bootstrap() {
    log "=== task-monitor 启动维护 ==="
    log "OpenClaw 目录: $OPENCLAW_DIR"
    log "插件目录: $PLUGIN_DIR"

    # 1. 检查并修复插件权限
    log ""
    log "1. 检查插件权限..."
    FIXED_COUNT=0
    for plugin_dir in "$OPENCLAW_DIR/extensions"/*/; do
        if [ -d "$plugin_dir" ]; then
            owner=$(stat -c "%U" "$plugin_dir" 2>/dev/null || echo "unknown")
            if [ "$owner" != "root" ] && [ "$(id -u)" = "0" ]; then
                log "   修复权限: $(basename "$plugin_dir") ($owner → root)"
                chown -R root:root "$plugin_dir"
                FIXED_COUNT=$((FIXED_COUNT + 1))
            fi
        fi
    done
    [ $FIXED_COUNT -eq 0 ] && log "   ✓ 所有插件权限正常"

    # 2. 配置备份
    log ""
    log "2. 备份配置..."
    BACKUP_DIR="$OPENCLAW_DIR/config-backups"
    mkdir -p "$BACKUP_DIR"
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
    
    if [ -f "$CONFIG_FILE" ]; then
        cp "$CONFIG_FILE" "$BACKUP_DIR/openclaw.$TIMESTAMP.json"
        log "   ✓ 配置已备份: openclaw.$TIMESTAMP.json"
        
        # 清理旧备份（保留最近 7 个）
        cd "$BACKUP_DIR" && ls -t openclaw.*.json 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null || true
    else
        log "   ⚠️ 配置文件不存在: $CONFIG_FILE"
    fi

    # 3. 清理过期会话
    log ""
    log "3. 清理过期会话..."
    SESSIONS_DIR="$OPENCLAW_DIR/agents/main/sessions"
    if [ -d "$SESSIONS_DIR" ]; then
        DELETED=$(find "$SESSIONS_DIR" -name "*.jsonl" -mtime +30 -delete -print 2>/dev/null | wc -l)
        log "   ✓ 清理了 $DELETED 个过期会话"
    else
        log "   ✓ 会话目录不存在，跳过"
    fi

    # 4. 验证插件加载
    log ""
    log "4. 验证插件状态..."
    if command -v openclaw &>/dev/null; then
        ISSUES=$(openclaw doctor 2>&1 | grep -E "blocked|suspicious|error" || true)
        if [ -z "$ISSUES" ]; then
            log "   ✓ 插件状态正常"
        else
            log "   ⚠️ 发现问题:"
            echo "$ISSUES" | while read line; do
                log "      $line"
            done
        fi
    else
        log "   ⚠️ openclaw 命令不可用，跳过验证"
    fi

    log ""
    log "=== task-monitor 启动维护完成 ==="
}

# 主入口
case "${1:-}" in
    --help|-h)
        show_help
        ;;
    --install-cron)
        install_cron
        ;;
    --uninstall-cron)
        uninstall_cron
        ;;
    *)
        run_bootstrap
        ;;
esac
