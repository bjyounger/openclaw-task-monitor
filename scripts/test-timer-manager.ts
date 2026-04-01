/**
 * TimerManager 测试脚本
 */

import { TimerManager, DEFAULT_TICK_STRATEGY } from '../lib/TimerManager';

// 简单日志器
const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
};

async function testTimerManager() {
  console.log('=== TimerManager 测试 ===\n');
  
  // 测试 1: 创建 TimerManager
  console.log('1. 创建 TimerManager...');
  const timerManager = new TimerManager({
    useLegacy: false,
    tickStrategy: {
      ...DEFAULT_TICK_STRATEGY,
      baseInterval: 1000, // 测试用 1 秒
    },
    executionTimeout: 5000,
  }, logger);
  console.log('✓ TimerManager 创建成功\n');
  
  // 测试 2: 注册定时器
  console.log('2. 注册定时器...');
  let tickCount = 0;
  let cleanupCount = 0;
  
  timerManager.registerTimer({
    name: 'testTick',
    tickInterval: 1, // 每次 tick
    callback: async () => {
      tickCount++;
      console.log(`  tick executed: count=${tickCount}`);
    },
  });
  
  timerManager.registerTimer({
    name: 'testCleanup',
    tickInterval: 3, // 每 3 个 tick
    callback: async () => {
      cleanupCount++;
      console.log(`  cleanup executed: count=${cleanupCount}`);
    },
  });
  
  console.log('✓ 定时器注册成功\n');
  
  // 测试 3: 启动定时器
  console.log('3. 启动定时器 (运行 5 秒)...');
  timerManager.start();
  
  // 等待 5 秒
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // 测试 4: 停止定时器
  console.log('\n4. 停止定时器...');
  timerManager.stop();
  console.log('✓ 定时器已停止\n');
  
  // 测试 5: 验证结果
  console.log('5. 验证结果...');
  console.log(`  tickCount: ${tickCount} (预期约 5)`);
  console.log(`  cleanupCount: ${cleanupCount} (预期约 1-2)`);
  
  if (tickCount >= 4 && tickCount <= 6) {
    console.log('✓ tick 计数正常');
  } else {
    console.log('✗ tick 计数异常');
  }
  
  if (cleanupCount >= 1 && cleanupCount <= 2) {
    console.log('✓ cleanup 计数正常');
  } else {
    console.log('✗ cleanup 计数异常');
  }
  
  // 测试 6: 状态检查
  console.log('\n6. 状态检查...');
  const status = timerManager.getStatus();
  console.log(`  isStopped: ${status.isStopped}`);
  console.log(`  isExecuting: ${status.isExecuting}`);
  console.log(`  masterTickCount: ${status.masterTickCount}`);
  console.log(`  timerCount: ${status.timerCount}`);
  console.log(`  useLegacy: ${status.useLegacy}`);
  
  if (status.isStopped && !status.isExecuting) {
    console.log('✓ 状态正常');
  } else {
    console.log('✗ 状态异常');
  }
  
  console.log('\n=== 测试完成 ===');
}

// 运行测试
testTimerManager().catch(console.error);
