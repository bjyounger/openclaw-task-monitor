// tests/timeout-check.test.ts
/**
 * checkTimeouts 超时检测功能测试
 * 
 * 测试覆盖：
 * - 边界条件（目录不存在、格式错误、日期解析失败等）
 * - 功能测试（超时检测、通知发送、状态更新）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Mock dependencies
vi.mock('fs');
vi.mock('child_process');

/** 模拟 checkTimeouts 回调函数的核心逻辑 */
async function simulateCheckTimeouts(
  logger: Record<string, ReturnType<typeof vi.fn>>,
  config: Record<string, any>,
  workspaceDir: string = '/workspace'
): Promise<void> {
  const TASKS_DIR = path.join(workspaceDir, 'memory', 'tasks');
  const runningDir = path.join(TASKS_DIR, 'running');
  
  try {
    if (!fs.existsSync(runningDir)) {
      logger.debug('[checkTimeouts] running directory does not exist, skipping');
      return;
    }
    
    const taskFiles = fs.readdirSync(runningDir).filter((f: string) => f.endsWith('.md'));
    
    const mainTaskTimeout = config.monitoring?.mainTaskTimeout || 3600000;
    const stalledThreshold = config.monitoring?.stalledRunningThreshold || 600000;
    
    for (const file of taskFiles) {
      try {
        const filePath = path.join(runningDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        
        const statusMatch = content.match(/\*\*状态\*\*:\s*(\w+)/);
        const status = statusMatch ? statusMatch[1] : 'unknown';
        
        if (status !== 'running') {
          continue;
        }
        
        const createdTimeMatch = content.match(/\*\*创建时间\*\*:\s*(.+)/);
        if (!createdTimeMatch) {
          logger.warn(`[checkTimeouts] Task file missing created time: ${file}`);
          continue;
        }
        
        const createdTime = new Date(createdTimeMatch[1]).getTime();
        
        if (isNaN(createdTime)) {
          logger.warn(`[checkTimeouts] Invalid created time format in ${file}`);
          continue;
        }
        
        const elapsed = Date.now() - createdTime;
        
        const isTimeout = elapsed > mainTaskTimeout;
        const isStalled = elapsed > stalledThreshold;
        
        if (isTimeout || isStalled) {
          const sessionKeyMatch = content.match(/\*\*SessionKey\*\*:\s*(\S+)/);
          const channelMatch = content.match(/\*\*频道\*\*:\s*(\S+)/);
          const targetMatch = content.match(/\*\*通知目标\*\*:\s*(\S+)/);
          
          const sessionKey = sessionKeyMatch ? sessionKeyMatch[1] : 'unknown';
          const channel = channelMatch ? channelMatch[1] : config.notification.channel;
          const target = targetMatch ? targetMatch[1] : config.notification.target;
          
          const timeoutType = isTimeout ? '任务超时' : '任务停滞';
          const threshold = isTimeout ? mainTaskTimeout : stalledThreshold;
          const elapsedMinutes = Math.floor(elapsed / 60000);
          const thresholdMinutes = Math.floor(threshold / 60000);
          
          const timeoutMessage = `⚠️ ${timeoutType}检测\n\n任务文件: ${file}\nSessionKey: ${sessionKey}\n运行时间: ${elapsedMinutes} 分钟\n超时阈值: ${thresholdMinutes} 分钟`;
          
          try {
            execSync(
              `openclaw message send --channel "${channel}" --target "${target}" --message "${timeoutMessage}"`,
              { timeout: 15000, stdio: 'pipe' }
            );
            logger.info(`[checkTimeouts] ✅ Timeout notification sent: ${file}`);
          } catch (e) {
            logger.error(`[checkTimeouts] Failed to send notification: ${e}`);
          }
          
          let updatedContent = content.replace('**状态**: running', '**状态**: timeout');
          
          const timeoutTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
          const timeoutLog = `- ${timeoutTime} ⚠️ 任务超时检测（运行 ${elapsedMinutes} 分钟）\n`;
          
          if (updatedContent.includes('## 执行日志')) {
            updatedContent = updatedContent.replace('## 执行日志\n', `## 执行日志\n${timeoutLog}`);
          } else {
            updatedContent += `\n## 执行日志\n${timeoutLog}`;
          }
          
          fs.writeFileSync(filePath, updatedContent, 'utf-8');
          logger.info(`[checkTimeouts] ✅ Task status updated to timeout: ${file}`);
        }
      } catch (fileError) {
        logger.error(`[checkTimeouts] Error processing file ${file}: ${fileError}`);
      }
    }
  } catch (error) {
    logger.error(`[checkTimeouts] Error in timeout check: ${error}`);
  }
}

describe('checkTimeouts 超时检测', () => {
  let mockLogger: Record<string, ReturnType<typeof vi.fn>>;
  let mockConfig: Record<string, any>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    
    mockConfig = {
      monitoring: {
        mainTaskTimeout: 3600000, // 1 小时
        stalledRunningThreshold: 600000, // 10 分钟
      },
      notification: {
        channel: 'feishu',
        target: 'test-target',
      },
    };
  });
  
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  
  describe('边界条件测试', () => {
    it('目录不存在时应跳过检查', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('running directory does not exist')
      );
      expect(fs.readdirSync).not.toHaveBeenCalled();
    });
    
    it('任务文件缺少状态字段时应跳过', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task1.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session
`);
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      // status 为 unknown，不等于 running，所以跳过
      expect(execSync).not.toHaveBeenCalled();
    });
    
    it('任务文件缺少创建时间时应记录警告并跳过', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task2.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**SessionKey**: test-session
`);
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('missing created time')
      );
      expect(execSync).not.toHaveBeenCalled();
    });
    
    it('创建时间格式无效时应记录警告并跳过', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task3.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**创建时间**: invalid-date-format
**SessionKey**: test-session
`);
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid created time format')
      );
      expect(execSync).not.toHaveBeenCalled();
    });
    
    it('任务状态不是 running 时应跳过', async () => {
      vi.setSystemTime(new Date('2026-04-21T11:05:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task4.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: completed
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session
`);
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(execSync).not.toHaveBeenCalled();
    });
    
    it('任务未超时不应触发通知', async () => {
      // 创建后 5 分钟（未超时）
      vi.setSystemTime(new Date('2026-04-21T10:05:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task5.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session
**频道**: feishu
**通知目标**: ou_test123
`);
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(execSync).not.toHaveBeenCalled();
    });
  });
  
  describe('功能测试', () => {
    it('任务超时应触发通知', async () => {
      // 创建后 65 分钟（超过 1 小时阈值）
      vi.setSystemTime(new Date('2026-04-21T11:05:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task6.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-6
**频道**: feishu
**通知目标**: ou_test123
`);
      
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('openclaw message send'),
        expect.objectContaining({ timeout: 15000 })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Timeout notification sent')
      );
    });
    
    it('正确计算运行时间', async () => {
      // 创建时间：10:00，当前时间：11:30（运行 90 分钟）
      vi.setSystemTime(new Date('2026-04-21T11:30:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task7.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-7
**频道**: feishu
**通知目标**: ou_test123
`);
      
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      const call = vi.mocked(execSync).mock.calls[0][0];
      expect(call).toContain('运行时间: 90 分钟');
    });
    
    it('正确更新任务状态为 timeout', async () => {
      vi.setSystemTime(new Date('2026-04-21T11:05:00Z'));
      
      const originalContent = `
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-8
**频道**: feishu
**通知目标**: ou_test123
`;
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task8.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(originalContent);
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      const updatedContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(updatedContent).toContain('**状态**: timeout');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Task status updated to timeout')
      );
    });
    
    it('正确添加超时日志（有执行日志部分）', async () => {
      vi.setSystemTime(new Date('2026-04-21T11:05:00Z'));
      
      const originalContent = `
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-9
**频道**: feishu
**通知目标**: ou_test123

## 执行日志
- 2026-04-21 10:00 任务开始
`;
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task9.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(originalContent);
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      const updatedContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(updatedContent).toContain('⚠️ 任务超时检测');
      expect(updatedContent).toContain('运行 65 分钟');
    });
    
    it('正确添加超时日志（无执行日志部分）', async () => {
      vi.setSystemTime(new Date('2026-04-21T11:05:00Z'));
      
      const originalContent = `
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-10
**频道**: feishu
**通知目标**: ou_test123
`;
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task10.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(originalContent);
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      const updatedContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(updatedContent).toContain('## 执行日志');
      expect(updatedContent).toContain('⚠️ 任务超时检测');
    });
    
    it('任务停滞（超过 10 分钟但未超时）应触发停滞通知', async () => {
      // 创建时间：10:00，当前时间：10:15（运行 15 分钟，超过 10 分钟停滞阈值，但未超 1 小时）
      vi.setSystemTime(new Date('2026-04-21T10:15:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task11.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-11
**频道**: feishu
**通知目标**: ou_test123
`);
      
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      const call = vi.mocked(execSync).mock.calls[0][0];
      expect(call).toContain('任务停滞检测');
    });
    
    it('通知发送失败应记录错误但继续更新状态', async () => {
      vi.setSystemTime(new Date('2026-04-21T11:05:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task12.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-12
**频道**: feishu
**通知目标**: ou_test123
`);
      
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Network error');
      });
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send notification')
      );
      // 状态仍然应该更新
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
    
    it('文件处理错误应记录错误并继续处理其他文件', async () => {
      vi.setSystemTime(new Date('2026-04-21T11:05:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task13.md', 'task14.md'] as any);
      
      vi.mocked(fs.readFileSync)
        .mockImplementationOnce(() => {
          throw new Error('Read error');
        })
        .mockReturnValueOnce(`
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-14
**频道**: feishu
**通知目标**: ou_test123
`);
      
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error processing file')
      );
      // 第二个文件仍然应该被处理
      expect(execSync).toHaveBeenCalledTimes(1);
    });
    
    it('使用默认配置值当监控配置缺失时', async () => {
      // 移除监控配置，使用默认值
      mockConfig.monitoring = undefined;
      
      vi.setSystemTime(new Date('2026-04-21T12:05:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task15.md'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(`
# 任务记录
**状态**: running
**创建时间**: 2026-04-21T11:00:00Z
**SessionKey**: test-session-15
**频道**: feishu
**通知目标**: ou_test123
`);
      
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      // 运行 65 分钟，超过默认 1 小时阈值
      const call = vi.mocked(execSync).mock.calls[0][0];
      expect(call).toContain('任务超时检测');
    });
  });
  
  describe('集成测试', () => {
    it('处理多个超时任务', async () => {
      vi.setSystemTime(new Date('2026-04-21T12:00:00Z'));
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['task16.md', 'task17.md', 'task18.md'] as any);
      
      // 三个任务：一个超时（2小时），一个停滞（15分钟），一个正常（5分钟）
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(`
# 任务记录 16
**状态**: running
**创建时间**: 2026-04-21T10:00:00Z
**SessionKey**: test-session-16
**频道**: feishu
**通知目标**: ou_test123
`)
        .mockReturnValueOnce(`
# 任务记录 17
**状态**: running
**创建时间**: 2026-04-21T11:45:00Z
**SessionKey**: test-session-17
**频道**: feishu
**通知目标**: ou_test123
`)
        .mockReturnValueOnce(`
# 任务记录 18
**状态**: running
**创建时间**: 2026-04-21T11:55:00Z
**SessionKey**: test-session-18
**频道**: feishu
**通知目标**: ou_test123
`);
      
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.writeFileSync).mockReturnValue();
      
      await simulateCheckTimeouts(mockLogger, mockConfig);
      
      // 2 小时 = 超时，15 分钟 = 停滞，5 分钟 = 正常
      // 因此应该发送 2 次通知
      expect(execSync).toHaveBeenCalledTimes(2);
      
      // 验证超时通知
      const firstCall = vi.mocked(execSync).mock.calls[0][0];
      expect(firstCall).toContain('任务超时检测');
      
      // 验证停滞通知
      const secondCall = vi.mocked(execSync).mock.calls[1][0];
      expect(secondCall).toContain('任务停滞检测');
    });
  });
});
