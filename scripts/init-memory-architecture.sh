#!/bin/bash
# 初始化三层记忆架构
# 用法: ./init-memory-architecture.sh [workspace-dir]

set -e

WORKSPACE_DIR="${1:-$HOME/.openclaw/workspace}"
TEMPLATES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../workspace-templates" && pwd)"

log() {
    echo "[init-memory] $1"
}

log "=== 初始化三层记忆架构 ==="
log "工作区: $WORKSPACE_DIR"
log "模板目录: $TEMPLATES_DIR"

# 1. 创建目录结构
log "创建目录结构..."
mkdir -p "$WORKSPACE_DIR/memory/episodic/decisions"
mkdir -p "$WORKSPACE_DIR/memory/episodic/preferences"
mkdir -p "$WORKSPACE_DIR/memory/episodic/people"
mkdir -p "$WORKSPACE_DIR/memory/tasks/completed"
mkdir -p "$WORKSPACE_DIR/memory/tasks/running"
mkdir -p "$WORKSPACE_DIR/memory/knowledge-base"

# 2. 创建 MEMORY.md（如果不存在）
if [ ! -f "$WORKSPACE_DIR/MEMORY.md" ]; then
    log "创建 MEMORY.md..."
    cp "$TEMPLATES_DIR/MEMORY.md.template" "$WORKSPACE_DIR/MEMORY.md"
    # 替换日期
    TODAY=$(date +%Y-%m-%d)
    sed -i "s/YYYY-MM-DD/$TODAY/g" "$WORKSPACE_DIR/MEMORY.md"
else
    log "MEMORY.md 已存在，跳过"
fi

# 3. 创建 SESSION-STATE.md（如果不存在）
if [ ! -f "$WORKSPACE_DIR/SESSION-STATE.md" ]; then
    log "创建 SESSION-STATE.md..."
    cp "$TEMPLATES_DIR/SESSION-STATE.md.template" "$WORKSPACE_DIR/SESSION-STATE.md"
    NOW=$(date '+%Y-%m-%d %H:%M')
    sed -i "s/YYYY-MM-DD HH:MM/$NOW/g" "$WORKSPACE_DIR/SESSION-STATE.md"
else
    log "SESSION-STATE.md 已存在，跳过"
fi

# 4. 创建 memory-config.json
if [ ! -f "$WORKSPACE_DIR/memory/memory-config.json" ]; then
    log "创建 memory-config.json..."
    cp "$TEMPLATES_DIR/memory-config.json" "$WORKSPACE_DIR/memory/memory-config.json"
    TODAY=$(date +%Y-%m-%d)
    sed -i "s/YYYY-MM-DD/$TODAY/g" "$WORKSPACE_DIR/memory/memory-config.json"
else
    log "memory-config.json 已存在，跳过"
fi

# 5. 创建示例知识库分类
log "创建知识库分类..."
mkdir -p "$WORKSPACE_DIR/memory/knowledge-base/ai"
mkdir -p "$WORKSPACE_DIR/memory/knowledge-base/tech"
mkdir -p "$WORKSPACE_DIR/memory/knowledge-base/skills"
mkdir -p "$WORKSPACE_DIR/memory/knowledge-base/tools"
mkdir -p "$WORKSPACE_DIR/memory/knowledge-base/tutorial"

# 6. 验证
log "验证目录结构..."
MISSING=0
for dir in "memory/episodic/decisions" "memory/episodic/preferences" "memory/episodic/people" "memory/tasks/completed" "memory/knowledge-base"; do
    if [ -d "$WORKSPACE_DIR/$dir" ]; then
        log "  ✓ $dir"
    else
        log "  ✗ $dir (缺失)"
        MISSING=1
    fi
done

for file in "MEMORY.md" "SESSION-STATE.md" "memory/memory-config.json"; do
    if [ -f "$WORKSPACE_DIR/$file" ]; then
        log "  ✓ $file"
    else
        log "  ✗ $file (缺失)"
        MISSING=1
    fi
done

if [ $MISSING -eq 0 ]; then
    log ""
    log "✅ 三层记忆架构初始化完成！"
    log ""
    log "目录结构："
    log "  第一层（工作记忆）：SESSION-STATE.md"
    log "  第二层（情境记忆）：memory/episodic/"
    log "  第三层（长效记忆）：MEMORY.md"
    log ""
    log "下一步："
    log "  1. 编辑 MEMORY.md 填写用户画像"
    log "  2. 重启 Gateway: openclaw gateway restart"
    log "  3. 验证: 检查 task-monitor 日志确认 Memory 模块加载"
else
    log ""
    log "⚠️ 初始化不完整，请检查错误信息"
    exit 1
fi
