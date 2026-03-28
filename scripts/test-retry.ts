#!/usr/bin/env node
/**
 * 自动重试机制测试脚本
 * 
 * 测试场景:
 * 1. 任务注册
 * 2. 任务失败后自动调度重试
 * 3. 重试成功
 * 4. 重试耗尽后放弃
 * 5. Watchdog 锁机制
 */

import * as path from "path";
import * as fs from "fs";
import { StateManager, type TaskState, type ScheduledRetry } from "../lib";

const STATE_DIR = path.join(process.env.HOME || "/root", ".openclaw/extensions/task-monitor/state-test");

// 清理测试目录
function cleanup() {
  if (fs.existsSync(STATE_DIR)) {
    fs.rmSync(STATE_DIR, { recursive: true });
  }
}

// 测试结果
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

async function runTests() {
  console.log("=== 自动重试机制测试 ===\n");

  cleanup();

  const stateManager = new StateManager(STATE_DIR);
  const results: TestResult[] = [];

  // ==================== 测试 1: 任务注册 ====================
  try {
    const task = await stateManager.registerTask({
      id: "test-run-001",
      type: "sub",
      status: "running",
      timeoutMs: 60000,
      parentTaskId: null,
      metadata: { label: "Test Task 1" },
    });

    if (task.id !== "test-run-001") throw new Error("Task ID mismatch");
    if (task.retryCount !== 0) throw new Error("Initial retryCount should be 0");
    if (task.maxRetries !== 2) throw new Error("Default maxRetries should be 2");
    if (!Array.isArray(task.retryHistory)) throw new Error("retryHistory should be an array");

    console.log("✅ 1. 任务注册");
    results.push({ name: "1. 任务注册", passed: true });
  } catch (e: any) {
    console.log(`❌ 1. 任务注册: ${e.message}`);
    results.push({ name: "1. 任务注册", passed: false, error: e.message });
  }

  // ==================== 测试 2: 任务失败后自动调度重试 ====================
  try {
    // 更新任务状态为失败
    await stateManager.updateTask("test-run-001", { status: "failed" });

    // 检查是否应该重试
    const shouldRetry = await stateManager.shouldRetry("test-run-001");
    if (!shouldRetry) throw new Error("Should retry when retryCount < maxRetries");

    // 安排重试
    const schedule = await stateManager.scheduleRetry("test-run-001", 1000); // 1 秒后
    if (schedule.runId !== "test-run-001") throw new Error("Schedule runId mismatch");
    if (schedule.retryCount !== 1) throw new Error("First retry should have retryCount = 1");
    if (schedule.status !== "pending") throw new Error("Schedule status should be pending");

    // 验证任务状态已更新
    const task = await stateManager.getTask("test-run-001");
    if (task?.status !== "scheduled") throw new Error("Task status should be scheduled");
    if (task?.retryCount !== 1) throw new Error("Task retryCount should be 1");

    console.log("✅ 2. 任务失败后自动调度重试");
    results.push({ name: "2. 任务失败后自动调度重试", passed: true });
  } catch (e: any) {
    console.log(`❌ 2. 任务失败后自动调度重试: ${e.message}`);
    results.push({ name: "2. 任务失败后自动调度重试", passed: false, error: e.message });
  }

  // ==================== 测试 3: 获取到期的重试任务 ====================
  try {
    // 等待 1.1 秒让调度到期
    await new Promise(resolve => setTimeout(resolve, 1100));

    const dueRetries = await stateManager.getDueScheduledRetries(5);
    if (dueRetries.length === 0) throw new Error("Should have due retries");
    if (dueRetries[0].runId !== "test-run-001") throw new Error("Due retry runId mismatch");

    console.log("✅ 3. 获取到期的重试任务");
    results.push({ name: "3. 获取到期的重试任务", passed: true });
  } catch (e: any) {
    console.log(`❌ 3. 获取到期的重试任务: ${e.message}`);
    results.push({ name: "3. 获取到期的重试任务", passed: false, error: e.message });
  }

  // ==================== 测试 4: 标记重试已执行 ====================
  try {
    const success = await stateManager.markRetryExecuted("test-run-001");
    if (!success) throw new Error("Should mark retry as executed");

    // 验证任务状态已更新为 running
    const task = await stateManager.getTask("test-run-001");
    if (task?.status !== "running") throw new Error("Task status should be running after markRetryExecuted");

    console.log("✅ 4. 标记重试已执行");
    results.push({ name: "4. 标记重试已执行", passed: true });
  } catch (e: any) {
    console.log(`❌ 4. 标记重试已执行: ${e.message}`);
    results.push({ name: "4. 标记重试已执行", passed: false, error: e.message });
  }

  // ==================== 测试 5: 重试耗尽后放弃 ====================
  try {
    // 模拟第二次失败
    await stateManager.updateTask("test-run-001", { status: "failed" });
    await stateManager.recordRetryOutcome("test-run-001", "error", "Test error");

    // 安排第二次重试
    await stateManager.scheduleRetry("test-run-001", 100);
    const task1 = await stateManager.getTask("test-run-001");
    if (task1?.retryCount !== 2) throw new Error("retryCount should be 2 after second retry");

    // 再次失败
    await stateManager.updateTask("test-run-001", { status: "failed" });

    // 检查是否还能重试
    const shouldRetry = await stateManager.shouldRetry("test-run-001");
    if (shouldRetry) throw new Error("Should NOT retry when retryCount >= maxRetries");

    // 放弃任务
    const abandoned = await stateManager.abandonTask("test-run-001");
    if (abandoned?.status !== "abandoned") throw new Error("Task should be abandoned");

    console.log("✅ 5. 重试耗尽后放弃");
    results.push({ name: "5. 重试耗尽后放弃", passed: true });
  } catch (e: any) {
    console.log(`❌ 5. 重试耗尽后放弃: ${e.message}`);
    results.push({ name: "5. 重试耗尽后放弃", passed: false, error: e.message });
  }

  // ==================== 测试 6: 重试历史记录 ====================
  try {
    const task = await stateManager.getTask("test-run-001");
    if (!task) throw new Error("Task not found");
    if (task.retryHistory.length < 1) throw new Error("Should have retry history");

    console.log("✅ 6. 重试历史记录");
    results.push({ name: "6. 重试历史记录", passed: true });
  } catch (e: any) {
    console.log(`❌ 6. 重试历史记录: ${e.message}`);
    results.push({ name: "6. 重试历史记录", passed: false, error: e.message });
  }

  // ==================== 测试 7: 取消重试调度 ====================
  try {
    // 注册新任务
    await stateManager.registerTask({
      id: "test-run-002",
      type: "sub",
      status: "running",
      timeoutMs: 60000,
      parentTaskId: null,
      metadata: { label: "Test Task 2" },
    });

    // 失败并安排重试
    await stateManager.updateTask("test-run-002", { status: "failed" });
    await stateManager.scheduleRetry("test-run-002", 60000); // 1 分钟后

    // 取消重试
    const cancelled = await stateManager.cancelScheduledRetry("test-run-002");
    if (!cancelled) throw new Error("Should cancel scheduled retry");

    console.log("✅ 7. 取消重试调度");
    results.push({ name: "7. 取消重试调度", passed: true });
  } catch (e: any) {
    console.log(`❌ 7. 取消重试调度: ${e.message}`);
    results.push({ name: "7. 取消重试调度", passed: false, error: e.message });
  }

  // ==================== 输出测试结果 ====================
  console.log("\n=== 测试结果 ===");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`总计: ${results.length} 个测试`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${failed}`);

  if (failed > 0) {
    console.log("\n失败的测试:");
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    
    // 清理
    cleanup();
    process.exit(1);
  }

  // 清理
  cleanup();
  console.log("\n✅ 所有测试通过！");
}

runTests().catch(console.error);
