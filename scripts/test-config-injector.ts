#!/usr/bin/env tsx

import { ConfigInjector } from '../lib/config-injector';
import * as path from 'path';
import * as fs from 'fs';

// 测试配置
const PLUGIN_DIR = path.join(__dirname, '..');
const WORKSPACE_DIR = path.join(process.env.HOME || '/root', '.openclaw/workspace');

async function runTests() {
  console.log('=== Task Monitor 配置注入功能测试 ===\n');

  // 1. 创建测试环境
  console.log('1. 创建测试环境...');
  const testWorkspaceDir = path.join(__dirname, 'test-workspace');
  if (fs.existsSync(testWorkspaceDir)) {
    fs.rmSync(testWorkspaceDir, { recursive: true });
  }
  fs.mkdirSync(testWorkspaceDir, { recursive: true });

  // 2. 初始化配置注入器
  console.log('2. 初始化配置注入器...');
  const injector = new ConfigInjector(PLUGIN_DIR, testWorkspaceDir);
  console.log('✅ 配置注入器初始化成功\n');

  // 3. 检查当前状态
  console.log('3. 检查当前状态...');
  const status = injector.checkAll();
  console.table(status);
  console.log();

  // 4. 创建测试目标文件
  console.log('4. 创建测试目标文件...');
  const testAgentsPath = path.join(testWorkspaceDir, 'AGENTS.md');
  const testHeartbeatPath = path.join(testWorkspaceDir, 'HEARTBEAT.md');
  
  // 创建简单的 AGENTS.md
  fs.writeFileSync(testAgentsPath, `# AGENTS.md - 测试文件

## 核心规则
- 规则1: 测试规则
- 规则2: 另一个测试规则

## 其他内容
这里是其他内容
`, 'utf-8');

  // 创建简单的 HEARTBEAT.md
  fs.writeFileSync(testHeartbeatPath, `# HEARTBEAT.md - 测试文件

## 心跳流程
- 步骤1: 检查子任务
- 步骤2: 检查运行中任务
- 步骤3: 输出结果

## 其他内容
这里是其他内容
`, 'utf-8');

  console.log('✅ 测试文件创建成功\n');

  // 5. 再次检查状态
  console.log('5. 检查目标文件存在状态...');
  const statusAfterCreate = injector.checkAll();
  console.table(statusAfterCreate);
  console.log();

  // 6. 执行注入测试
  console.log('6. 执行注入测试...');
  const results = injector.injectAll();
  console.table(results);
  console.log();

  // 7. 验证注入结果
  console.log('7. 验证注入结果...');
  
  // 检查 AGENTS.md
  const agentsContent = fs.readFileSync(testAgentsPath, 'utf-8');
  console.log('AGENTS.md 内容验证:');
  console.log('- 包含"验证铁律":', agentsContent.includes('验证铁律') ? '✅' : '❌');
  console.log('- 包含"系统化调试":', agentsContent.includes('系统化调试') ? '✅' : '❌');
  console.log('- 包含"强制规划流程":', agentsContent.includes('强制规划流程') ? '✅' : '❌');
  console.log();

  // 检查 HEARTBEAT.md
  const heartbeatContent = fs.readFileSync(testHeartbeatPath, 'utf-8');
  console.log('HEARTBEAT.md 内容验证:');
  console.log('- 包含"系统化调试流程":', heartbeatContent.includes('系统化调试流程') ? '✅' : '❌');
  console.log();

  // 8. 检查备份文件
  console.log('8. 检查备份文件...');
  const backupDir = path.join(testWorkspaceDir, 'backups');
  if (fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir);
    console.log(`备份文件数量: ${backups.length}`);
    backups.forEach(backup => {
      console.log(`  - ${backup}`);
    });
  } else {
    console.log('❌ 备份目录不存在');
  }
  console.log();

  // 9. 测试重复注入（应该不会重复）
  console.log('9. 测试重复注入...');
  const secondResults = injector.injectAll();
  const repeatedInjects = secondResults.filter(r => r.message.includes('Already injected'));
  console.log(`重复注入检测: ${repeatedInjects.length}/${secondResults.length} 项检测到已注入`);
  console.log();

  // 10. 清理测试环境
  console.log('10. 清理测试环境...');
  fs.rmSync(testWorkspaceDir, { recursive: true });
  console.log('✅ 测试环境清理完成\n');

  // 11. 在实际工作空间测试
  console.log('11. 在实际工作空间测试...');
  const realInjector = new ConfigInjector(PLUGIN_DIR, WORKSPACE_DIR);
  const realStatus = realInjector.checkAll();
  console.table(realStatus);
  console.log();

  // 12. 总结
  console.log('=== 测试总结 ===');
  const totalTests = status.length;
  const alreadyInjected = status.filter(s => s.alreadyInjected).length;
  const targetExists = status.filter(s => s.targetExists).length;
  
  console.log(`总配置项: ${totalTests}`);
  console.log(`已注入项: ${alreadyInjected}`);
  console.log(`目标文件存在: ${targetExists}`);
  console.log();

  if (alreadyInjected === totalTests) {
    console.log('✅ 所有配置项已成功注入！');
  } else if (alreadyInjected > 0) {
    console.log(`⚠️  ${alreadyInjected}/${totalTests} 配置项已注入，${totalTests - alreadyInjected} 项待注入`);
  } else {
    console.log('❌ 没有配置项被注入，请检查配置');
  }

  // 13. 建议
  console.log('\n=== 建议 ===');
  const notInjected = status.filter(s => !s.alreadyInjected && s.targetExists);
  if (notInjected.length > 0) {
    console.log('以下配置项可以注入:');
    notInjected.forEach(item => {
      console.log(`  - ${item.id}: ${item.description}`);
    });
    console.log('\n运行以下命令注入:');
    console.log('  cd /root/.openclaw/extensions/task-monitor');
    console.log('  npx tsx scripts/test-config-injector.ts --inject');
  } else {
    console.log('所有配置项已注入或目标文件不存在');
  }
}

// 命令行参数处理
const args = process.argv.slice(2);
if (args.includes('--inject')) {
  // 执行实际注入
  console.log('执行实际注入...');
  const injector = new ConfigInjector(PLUGIN_DIR, WORKSPACE_DIR);
  const results = injector.injectAll();
  console.table(results);
} else {
  // 运行测试
  runTests().catch(error => {
    console.error('测试失败:', error);
    process.exit(1);
  });
}