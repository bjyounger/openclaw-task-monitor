/**
 * 任务摘要生成器
 * @module task-monitor/lib/memory/TaskSummaryGenerator
 */

import type { TaskSummary, TranscriptExtractor } from './types';

/**
 * 摘要生成器
 * 职责单一：从 transcript 生成任务摘要
 */
export class TaskSummaryGenerator {
  private extractor: TranscriptExtractor;

  constructor(extractor?: TranscriptExtractor) {
    // 默认使用关键词提取器
    this.extractor = extractor || new KeywordExtractor();
  }

  /**
   * 生成任务摘要
   * @param task - 任务对象
   * @param transcript - 会话记录
   */
  public generateSummary(task: any, transcript: any[] | null | undefined): TaskSummary {
    // 防御性检查
    const safeTranscript = Array.isArray(transcript) ? transcript : [];

    return {
      id: task.id || 'unknown',
      name: task.name || 'Unnamed Task',
      type: this.inferTaskType(task),
      startTime: task.startTime || Date.now(),
      endTime: task.endTime || Date.now(),
      status: task.status || 'completed',
      goals: this.extractor.extractGoals(safeTranscript),
      achievements: this.extractor.extractAchievements(safeTranscript),
      problems: this.extractor.extractProblems(safeTranscript),
      lessons: this.extractor.extractLessons(safeTranscript),
      files: this.extractor.extractFiles(safeTranscript)
    };
  }

  /**
   * 推断任务类型
   */
  private inferTaskType(task: any): TaskSummary['type'] {
    const name = (task.name || '').toLowerCase();

    if (name.includes('coding') || name.includes('编码') || name.includes('开发')) {
      return 'coding';
    }
    if (name.includes('research') || name.includes('调研') || name.includes('分析')) {
      return 'research';
    }
    if (name.includes('consulting') || name.includes('咨询')) {
      return 'consulting';
    }
    if (name.includes('ops') || name.includes('运维') || name.includes('部署')) {
      return 'ops';
    }
    return 'other';
  }
}

/**
 * 关键词提取器（默认实现）
 * 基于简单关键词匹配提取信息
 */
export class KeywordExtractor implements TranscriptExtractor {
  /**
   * 提取目标
   * 识别 "目标是"、"要做"、"需要完成" 等关键词
   */
  extractGoals(transcript: any[]): string[] {
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return [];
    }

    const goals: string[] = [];
    const keywords = ['目标是', '要做', '需要完成', '任务'];

    try {
      for (const msg of transcript) {
        if (!msg || msg.role !== 'user') continue;

        const text = msg.content || '';
        if (typeof text !== 'string') continue;

        for (const kw of keywords) {
          const idx = text.indexOf(kw);
          if (idx !== -1) {
            // 提取关键词后的句子（最多 100 字符）
            const sentence = text.slice(idx, idx + 100).trim();
            if (sentence) {
              goals.push(sentence);
            }
            break; // 每条消息只匹配一个关键词
          }
        }

        if (goals.length >= 5) break; // 最多 5 条
      }
    } catch (error) {
      console.error('[KeywordExtractor] extractGoals error:', error);
    }

    return goals.slice(0, 5);
  }

  /**
   * 提取成果
   * 识别 "完成"、"成功"、"已实现"、"搞定" 等关键词
   */
  extractAchievements(transcript: any[]): string[] {
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return [];
    }

    const achievements: string[] = [];
    const keywords = ['完成', '成功', '已实现', '搞定', '解决了'];

    try {
      for (const msg of transcript) {
        if (!msg || msg.role !== 'assistant') continue;

        const text = msg.content || '';
        if (typeof text !== 'string') continue;

        for (const kw of keywords) {
          if (text.includes(kw)) {
            // 提取包含关键词的句子（最多 100 字符）
            achievements.push(text.slice(0, 100).trim());
            break;
          }
        }

        if (achievements.length >= 5) break; // 最多 5 条
      }
    } catch (error) {
      console.error('[KeywordExtractor] extractAchievements error:', error);
    }

    return achievements.slice(0, 5);
  }

  /**
   * 提取问题及解决方案
   * 简化实现：识别错误和后续解决
   */
  extractProblems(transcript: any[]): { problem: string; solution: string }[] {
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return [];
    }

    const problems: { problem: string; solution: string }[] = [];
    const problemKeywords = ['错误', '失败', '报错', '问题', '异常', 'error', 'failed'];
    const solutionKeywords = ['解决', '修复', '改了', '换成', 'fixed', 'resolved'];

    try {
      let lastProblem: string | null = null;

      for (const msg of transcript) {
        const text = msg?.content || '';
        if (typeof text !== 'string') continue;

        // 检测问题
        if (msg.role === 'assistant' || msg.role === 'user') {
          for (const kw of problemKeywords) {
            if (text.toLowerCase().includes(kw)) {
              lastProblem = text.slice(0, 80).trim();
              break;
            }
          }
        }

        // 检测解决方案
        if (lastProblem && msg.role === 'assistant') {
          for (const kw of solutionKeywords) {
            if (text.includes(kw)) {
              problems.push({
                problem: lastProblem,
                solution: text.slice(0, 80).trim()
              });
              lastProblem = null;
              break;
            }
          }
        }

        if (problems.length >= 5) break; // 最多 5 条
      }
    } catch (error) {
      console.error('[KeywordExtractor] extractProblems error:', error);
    }

    return problems.slice(0, 5);
  }

  /**
   * 提取经验教训
   * 识别 "学到"、"发现"、"注意"、"经验" 等关键词
   */
  extractLessons(transcript: any[]): string[] {
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return [];
    }

    const lessons: string[] = [];
    const keywords = ['学到', '发现', '注意', '经验', '记住', '教训'];

    try {
      for (const msg of transcript) {
        if (!msg || msg.role !== 'assistant') continue;

        const text = msg.content || '';
        if (typeof text !== 'string') continue;

        for (const kw of keywords) {
          if (text.includes(kw)) {
            lessons.push(text.slice(0, 100).trim());
            break;
          }
        }

        if (lessons.length >= 5) break; // 最多 5 条
      }
    } catch (error) {
      console.error('[KeywordExtractor] extractLessons error:', error);
    }

    return lessons.slice(0, 5);
  }

  /**
   * 提取文件路径
   * 使用正则匹配文件路径
   */
  extractFiles(transcript: any[]): string[] {
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return [];
    }

    const files: string[] = [];
    // 匹配被引号包裹的文件路径，或常见的路径模式
    const filePattern = /['"`]([\/\w\-\.]+\.(ts|js|md|json|yaml|yml|py|go|rs|java))['"`]/g;
    // 也匹配没有被引号包裹的路径
    const bareFilePattern = /(?:^|\s)([\/\w\-\.]+\.(ts|js|md|json|yaml|yml|py|go|rs|java))(?:\s|$)/gm;

    try {
      for (const msg of transcript) {
        const text = msg?.content || '';
        if (typeof text !== 'string') continue;

        // 匹配引号包裹的路径
        let match;
        while ((match = filePattern.exec(text)) !== null) {
          const file = match[1];
          if (!files.includes(file)) {
            files.push(file);
          }
        }

        // 匹配裸路径
        while ((match = bareFilePattern.exec(text)) !== null) {
          const file = match[1];
          // 过滤掉太短的假阳性
          if (file.length > 5 && !files.includes(file)) {
            files.push(file);
          }
        }

        if (files.length >= 10) break; // 最多 10 条文件
      }
    } catch (error) {
      console.error('[KeywordExtractor] extractFiles error:', error);
    }

    return files.slice(0, 10);
  }
}
