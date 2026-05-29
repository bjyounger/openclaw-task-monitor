/**
 * Token Budget Checker - Token 预算检查器
 * 
 * 检查 workspace 核心配置文件的 token 预算
 * 超预算时发送告警
 */

import type { AlertManager } from "./alert-manager";
import * as fs from "fs";
import * as path from "path";

// ==================== 类型定义 ====================

export interface TokenBudgetConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 检查间隔（毫秒），默认 24 小时 */
  checkIntervalMs: number;
  /** workspace 路径 */
  workspacePath: string;
  /** 各文件预算 */
  budgets: {
    [filename: string]: number;
  };
}

export interface BudgetCheckResult {
  /** 检查时间 */
  checkTime: number;
  /** 各文件结果 */
  files: {
    filename: string;
    budget: number;
    actual: number;
    status: 'ok' | 'over';
    overBy: number;
  }[];
  /** 总计 */
  total: {
    budget: number;
    actual: number;
    status: 'ok' | 'over';
  };
  /** 是否有问题 */
  hasIssues: boolean;
  /** 问题列表 */
  issues: string[];
}

// ==================== 默认配置 ====================

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
  enabled: true,
  checkIntervalMs: 24 * 60 * 60 * 1000, // 24 小时
  workspacePath: process.env.OPENCLAW_WORKSPACE || "/home/younger/.openclaw/workspace",
  budgets: {
    "AGENTS.md": 1200,
    "MEMORY.md": 1000,
    "TOOLS.md": 500,
    "HEARTBEAT.md": 300,
    "USER.md": 200,
  },
};

// ==================== 检查器 ====================

export class TokenBudgetChecker {
  private config: TokenBudgetConfig;
  private alertManager: AlertManager | null;
  private logger: any;
  private lastCheckTime: number = 0;
  private lastResult: BudgetCheckResult | null = null;

  constructor(
    config: Partial<TokenBudgetConfig>,
    alertManager: AlertManager | null,
    logger: any
  ) {
    this.config = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
    this.alertManager = alertManager;
    this.logger = logger;
  }

  /**
   * 计算文件 token 数（字符数 / 3）
   */
  private countTokens(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) {
        return 0;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return Math.ceil(content.length / 3);
    } catch (error) {
      this.logger.error?.(`[TokenBudgetChecker] Failed to read ${filePath}: ${error}`);
      return 0;
    }
  }

  /**
   * 执行预算检查
   */
  public check(): BudgetCheckResult {
    const checkTime = Date.now();
    const files: BudgetCheckResult["files"] = [];
    const issues: string[] = [];
    let totalBudget = 0;
    let totalActual = 0;

    for (const [filename, budget] of Object.entries(this.config.budgets)) {
      const filePath = path.join(this.config.workspacePath, filename);
      const actual = this.countTokens(filePath);
      const overBy = Math.max(0, actual - budget);
      const status = actual > budget ? "over" : "ok";

      totalBudget += budget;
      totalActual += actual;

      files.push({
        filename,
        budget,
        actual,
        status,
        overBy,
      });

      if (status === "over") {
        issues.push(`${filename}: ${actual}t > ${budget}t (超 ${overBy}t)`);
      }
    }

    const result: BudgetCheckResult = {
      checkTime,
      files,
      total: {
        budget: totalBudget,
        actual: totalActual,
        status: totalActual > 5000 ? "over" : "ok", // 总预算 5k
      },
      hasIssues: issues.length > 0,
      issues,
    };

    this.lastCheckTime = checkTime;
    this.lastResult = result;

    // 告警
    if (result.hasIssues && this.alertManager) {
      this.alertManager.sendAlert(
        "token-budget-over",
        `⚠️ Token 预算超限\n\n${issues.join("\n")}\n\n总计: ${totalActual}t / 5000t`,
        "warning"
      ).catch((err: Error) => {
        this.logger.error?.(`[TokenBudgetChecker] Failed to send alert: ${err}`);
      });
    }

    this.logger.info?.(
      `[TokenBudgetChecker] Check complete: ${totalActual}t / ${totalBudget}t, ${issues.length} issue(s)`
    );

    return result;
  }

  /**
   * 定时检查（由 TimerManager 调用）
   */
  public async periodicCheck(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const now = Date.now();
    if (now - this.lastCheckTime < this.config.checkIntervalMs) {
      return;
    }

    this.check();
  }

  /**
   * 获取上次检查结果
   */
  public getLastResult(): BudgetCheckResult | null {
    return this.lastResult;
  }
}

// ==================== 导出 ====================

export function createTokenBudgetChecker(
  config: Partial<TokenBudgetConfig>,
  alertManager: AlertManager | null,
  logger: any
): TokenBudgetChecker {
  return new TokenBudgetChecker(config, alertManager, logger);
}
