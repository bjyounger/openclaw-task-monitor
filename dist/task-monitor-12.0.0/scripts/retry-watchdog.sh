#!/bin/bash
# retry-watchdog.sh - Watchdog 重试执行脚本
# v3: spawn 安全执行 + 文件锁 + 30 秒超时
#
# 用法: ./retry-watchdog.sh <runId> <agentId> <taskDescription>
#
# 环境变量:
#   STATE_DIR - 状态文件目录 (默认 ~/.openclaw/extensions/task-monitor/state)
#   LOCK_TIMEOUT_MS - 锁超时时间 (默认 30000)
#   SPAWN_TIMEOUT_MS - spawn 超时时间 (默认 300000)

set -euo pipefail

# ==================== 配置 ====================
STATE_DIR="${STATE_DIR:-$HOME/.openclaw/extensions/task-monitor/state}"
LOCK_TIMEOUT_MS="${LOCK_TIMEOUT_MS:-30000}"
SPAWN_TIMEOUT_MS="${SPAWN_TIMEOUT_MS:-300000}"

LOCK_FILE="$STATE_DIR/.watchdog.lock"
SCHEDULE_FILE="$STATE_DIR/scheduled-retries.json"
STATE_FILE="$STATE_DIR/state.json"

# ==================== 参数检查 ====================
if [[ $# -lt 3 ]]; then
    echo "Usage: $0 <runId> <agentId> <taskDescription>" >&2
    exit 1
fi

RUN_ID="$1"
AGENT_ID="$2"
TASK_DESC="$3"

# ==================== 函数定义 ====================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] $*"
}

# 获取锁 (防止并发执行)
acquire_lock() {
    local start_time=$(date +%s%3N)
    local lock_timeout_sec=$((LOCK_TIMEOUT_MS / 1000))

    while true; do
        # 尝试创建锁文件 (原子操作)
        if (set -o noclobber; echo "$$:$(date +%s%3N)" > "$LOCK_FILE") 2>/dev/null; then
            trap 'release_lock' EXIT
            return 0
        fi

        # 检查锁是否过期
        if [[ -f "$LOCK_FILE" ]]; then
            local lock_content=$(cat "$LOCK_FILE" 2>/dev/null || echo "0:0")
            local lock_pid=$(echo "$lock_content" | cut -d: -f1)
            local lock_time=$(echo "$lock_content" | cut -d: -f2)
            local now=$(date +%s%3N)

            if (( now - lock_time > LOCK_TIMEOUT_MS )); then
                log "Lock expired, removing stale lock (pid: $lock_pid)"
                rm -f "$LOCK_FILE"
                continue
            fi
        fi

        # 检查超时
        local elapsed=$(($(date +%s%3N) - start_time))
        if (( elapsed > LOCK_TIMEOUT_MS )); then
            log "ERROR: Failed to acquire lock after ${LOCK_TIMEOUT_MS}ms"
            return 1
        fi

        sleep 0.1
    done
}

# 释放锁
release_lock() {
    rm -f "$LOCK_FILE" 2>/dev/null || true
}

# 安全执行重试 (使用数组避免命令注入)
execute_retry_safe() {
    local run_id="$1"
    local agent_id="$2"
    local task_desc="$3"

    log "Executing retry: runId=$run_id agentId=$agent_id"

    # 使用数组传递参数，每个参数独立
    local args=(
        "--agent" "$agent_id"
        "--print" "$task_desc"
    )

    # 后台执行，设置超时
    local timeout_sec=$((SPAWN_TIMEOUT_MS / 1000))
    
    # 使用 timeout 命令设置超时
    if command -v timeout &>/dev/null; then
        timeout "$timeout_sec" claude "${args[@]}" &
    else
        claude "${args[@]}" &
    fi

    local pid=$!
    log "Spawned process: pid=$pid"

    # 等待进程完成 (最多等待 5 秒确认启动)
    sleep 1

    if kill -0 "$pid" 2>/dev/null; then
        log "Process running successfully: pid=$pid"
        echo "$pid"
        return 0
    else
        log "ERROR: Process exited immediately"
        return 1
    fi
}

# 更新调度状态
mark_executed() {
    local run_id="$1"

    if [[ ! -f "$SCHEDULE_FILE" ]]; then
        log "WARN: Schedule file not found"
        return 1
    fi

    # 使用 jq 更新状态 (如果可用)
    if command -v jq &>/dev/null; then
        local temp_file=$(mktemp)
        jq --arg runId "$run_id" \
           '(.tasks[] | select(.runId == $runId and .status == "pending")).status = "executed"' \
           "$SCHEDULE_FILE" > "$temp_file" && mv "$temp_file" "$SCHEDULE_FILE"
        log "Marked $run_id as executed in schedule"
    else
        log "WARN: jq not available, skipping schedule update"
    fi
}

# 更新任务状态
update_task_status() {
    local run_id="$1"
    local status="$2"

    if [[ ! -f "$STATE_FILE" ]]; then
        log "WARN: State file not found"
        return 1
    fi

    if command -v jq &>/dev/null; then
        local temp_file=$(mktemp)
        jq --arg runId "$run_id" --arg status "$status" \
           '(.tasks[] | select(.id == $runId)).status = $status' \
           "$STATE_FILE" > "$temp_file" && mv "$temp_file" "$STATE_FILE"
        log "Updated task $run_id status to $status"
    else
        log "WARN: jq not available, skipping state update"
    fi
}

# ==================== 主逻辑 ====================

main() {
    log "Starting retry watchdog for: $RUN_ID"

    # 获取锁
    if ! acquire_lock; then
        log "ERROR: Failed to acquire lock, exiting"
        exit 1
    fi

    # 更新任务状态为 running
    update_task_status "$RUN_ID" "running"

    # 标记调度为已执行
    mark_executed "$RUN_ID"

    # 执行重试
    if pid=$(execute_retry_safe "$RUN_ID" "$AGENT_ID" "$TASK_DESC"); then
        log "Retry spawned successfully: pid=$pid"
        exit 0
    else
        log "ERROR: Failed to spawn retry"
        update_task_status "$RUN_ID" "failed"
        exit 1
    fi
}

main "$@"
