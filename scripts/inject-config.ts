#!/usr/bin/env ts-node
/**
 * 配置注入 CLI
 * 用法: ts-node inject-config.ts [--check | --inject | --status]
 */

import { ConfigInjector } from '../lib/config-injector';
import * as path from 'path';

const PLUGIN_DIR = path.resolve(__dirname, '..');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(process.env.HOME || '/root', '.openclaw/workspace');

function printHelp() {
  console.log(`
配置注入 CLI

用法:
  ts-node inject-config.ts <command>

命令:
  --check    检查注入状态（不执行注入）
  --inject   执行配置注入
  --status   显示详细状态（默认）
  --help     显示帮助信息

环境变量:
  WORKSPACE_DIR   工作区目录（默认: ~/.openclaw/workspace）

示例:
  # 检查注入状态
  ts-node scripts/inject-config.ts --check

  # 执行注入
  ts-node scripts/inject-config.ts --inject

  # 指定工作区
  WORKSPACE_DIR=/path/to/workspace ts-node scripts/inject-config.ts --inject
`);
}

function printStatusTable(status: Array<{ id: string; targetExists: boolean; alreadyInjected: boolean; description: string }>) {
  console.log('\n| 注入项 | 目标文件 | 已注入 | 说明 |');
  console.log('|--------|----------|--------|------|');
  for (const item of status) {
    const targetIcon = item.targetExists ? '✅' : '❌';
    const injectedIcon = item.alreadyInjected ? '✅' : '❌';
    console.log(`| ${item.id} | ${targetIcon} | ${injectedIcon} | ${item.description} |`);
  }
  console.log('');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const command = args[0] || '--status';

  try {
    const injector = new ConfigInjector(PLUGIN_DIR, WORKSPACE_DIR);

    switch (command) {
      case '--check':
        console.log('=== 检查注入状态 ===\n');
        console.log(`工作区: ${WORKSPACE_DIR}`);
        const status = injector.checkAll();
        printStatusTable(status);

        const allInjected = status.every(s => s.alreadyInjected);
        if (allInjected) {
          console.log('✅ 所有配置项已注入\n');
          process.exit(0);
        } else {
          console.log('⚠️ 部分配置项未注入，请运行: ts-node scripts/inject-config.ts --inject\n');
          process.exit(1);
        }
        break;

      case '--inject':
        console.log('=== 执行配置注入 ===\n');
        console.log(`工作区: ${WORKSPACE_DIR}\n`);

        // 先检查状态
        const preStatus = injector.checkAll();
        printStatusTable(preStatus);

        // 执行注入
        console.log('开始注入...\n');
        const results = injector.injectAll();

        console.log('\n| 注入项 | 结果 | 消息 |');
        console.log('|--------|------|------|');
        for (const result of results) {
          const icon = result.success ? '✅' : '❌';
          console.log(`| ${result.id} | ${icon} | ${result.message} |`);
          if (result.backupPath) {
            console.log(`|        | 备份 | ${result.backupPath} |`);
          }
        }
        console.log('');

        const allSuccess = results.every(r => r.success);
        if (allSuccess) {
          console.log('✅ 所有配置项注入成功\n');
          process.exit(0);
        } else {
          console.log('⚠️ 部分配置项注入失败，请检查日志\n');
          process.exit(1);
        }
        break;

      case '--status':
      default:
        console.log('=== 配置注入状态 ===\n');
        console.log(`工作区: ${WORKSPACE_DIR}`);
        console.log(`插件目录: ${PLUGIN_DIR}\n`);

        const currentStatus = injector.checkAll();
        printStatusTable(currentStatus);

        const injectedCount = currentStatus.filter(s => s.alreadyInjected).length;
        const totalCount = currentStatus.length;

        console.log(`进度: ${injectedCount}/${totalCount} 已注入\n`);

        if (injectedCount < totalCount) {
          console.log('执行注入: ts-node scripts/inject-config.ts --inject\n');
        } else {
          console.log('✅ 所有配置项已注入完成\n');
        }
        break;
    }
  } catch (error) {
    console.error('❌ 错误:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
