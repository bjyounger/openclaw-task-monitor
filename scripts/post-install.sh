#!/bin/bash
# task-monitor 安装后初始化脚本
# 处理所有可能遗漏的配置项

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
WORKSPACE_DIR="${1:-$HOME/.openclaw/workspace}"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

log() {
    echo "[post-install] $1"
}

error() {
    echo "[post-install] ❌ ERROR: $1" >&2
    exit 1
}

log "=== task-monitor 安装后初始化 ==="
log "插件目录: $PLUGIN_DIR"
log "工作区: $WORKSPACE_DIR"

# ==================== 1. 创建 config.json ====================
log ""
log "1. 检查 config.json..."
if [ ! -f "$PLUGIN_DIR/config.json" ]; then
    if [ -f "$PLUGIN_DIR/config.example.json" ]; then
        log "   从 config.example.json 创建 config.json..."
        cp "$PLUGIN_DIR/config.example.json" "$PLUGIN_DIR/config.json"
        log "   ✅ config.json 已创建"
    else
        error "config.example.json 不存在，无法创建 config.json"
    fi
else
    log "   ✓ config.json 已存在"
fi

# ==================== 2. 初始化三层记忆架构 ====================
log ""
log "2. 初始化三层记忆架构..."
if [ -x "$SCRIPT_DIR/init-memory-architecture.sh" ]; then
    "$SCRIPT_DIR/init-memory-architecture.sh" "$WORKSPACE_DIR"
else
    error "init-memory-architecture.sh 不存在或不可执行"
fi

# ==================== 3. 配置注入 ====================
log ""
log "3. 检查配置注入..."
INJECT_CONFIG="$PLUGIN_DIR/workspace-templates/inject-config.json"

if [ -f "$INJECT_CONFIG" ]; then
    log "   发现 inject-config.json，配置注入功能可用"
    log "   注入项："
    cat "$INJECT_CONFIG" | jq -r '.injectables[] | "     - \(.id): \(.description)"' 2>/dev/null || true
    log ""
    log "   ⚠️ 配置注入需要手动触发或集成到 Gateway 启动流程"
    log "   当前状态：AGENTS.md/HEARTBEAT.md 需要手动合并模板内容"
else
    log "   ⚠️ inject-config.json 不存在"
fi

# ==================== 4. 检查 openclaw.json 配置 ====================
log ""
log "4. 检查 openclaw.json 配置..."

if [ -f "$OPENCLAW_CONFIG" ]; then
    # 检查 notification 配置
    NOTIFICATION_CONFIG=$(jq '.extensions["task-monitor"].config.notification // empty' "$OPENCLAW_CONFIG" 2>/dev/null)
    if [ -z "$NOTIFICATION_CONFIG" ] || [ "$NOTIFICATION_CONFIG" = "null" ]; then
        log "   ⚠️ notification 配置缺失"
        log "   请在 openclaw.json 中添加："
        cat << 'NOTIFY_EOF'
   {
     "extensions": {
       "task-monitor": {
         "config": {
           "notification": {
             "channel": "wecom",
             "target": "your-user-id"
           }
         }
       }
     }
   }
NOTIFY_EOF
    else
        CHANNEL=$(jq -r '.channel // "未配置"' <<< "$NOTIFICATION_CONFIG" 2>/dev/null)
        TARGET=$(jq -r '.target // "未配置"' <<< "$NOTIFICATION_CONFIG" 2>/dev/null)
        log "   ✓ notification 配置存在"
        log "     channel: $CHANNEL"
        log "     target: $TARGET"
    fi
else
    log "   ⚠️ openclaw.json 不存在，需要手动创建"
fi

# ==================== 5. 验证依赖 ====================
log ""
log "5. 验证依赖..."
if [ -d "$PLUGIN_DIR/node_modules" ]; then
    log "   ✓ node_modules 存在"
else
    log "   ⚠️ node_modules 不存在，请运行: cd $PLUGIN_DIR && pnpm install"
fi

# ==================== 6. 创建必要目录 ====================
log ""
log "6. 创建必要目录..."
mkdir -p "$HOME/.openclaw/logs"
mkdir -p "$HOME/.openclaw/config-backups"
mkdir -p "$WORKSPACE_DIR/memory/tasks/running"
mkdir -p "$WORKSPACE_DIR/memory/tasks/completed"
log "   ✓ 目录已创建"

# ==================== 7. 下一步提示 ====================
log ""
log "=========================================="
log "✅ 安装后初始化完成"
log "=========================================="
log ""
log "下一步操作："
log ""
log "1. 编辑 openclaw.json 添加 notification 配置："
log "   vim ~/.openclaw/openclaw.json"
log ""
log "2. 重启 Gateway："
log "   openclaw gateway restart"
log ""
log "3. 验证插件加载："
log "   openclaw doctor"
log ""
log "4. 检查日志："
log "   tail -f ~/.openclaw/logs/gateway.log | grep task-monitor"
log ""
log "可选操作："
log "- 运行 bootstrap.sh 进行启动时检查："
log "  ./scripts/bootstrap.sh"
log ""
log "- 手动合并 AGENTS.md/HEARTBEAT.md 模板："
log "  参考 workspace-templates/inject-config.json"
