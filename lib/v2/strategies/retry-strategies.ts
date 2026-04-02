import type { IRetryStrategy } from '../core/interfaces';
import type { ErrorType } from '../core/types';

/**
 * 错误模式匹配规则
 */
interface ErrorPattern {
  /** 错误类型 */
  type: ErrorType;
  /** 匹配模式（正则或关键词） */
  patterns: (string | RegExp)[];
  /** 是否临时性错误 */
  isTransient: boolean;
}

/**
 * 指数退避重试策略（优化版）
 * 
 * 优化项 3.1：根据错误类型调整重试策略
 * 
 * 算法：
 * delay = initialDelay * (backoffMultiplier ^ retryCount)
 * 
 * 特点：
 * - 重试间隔逐渐增加
 * - 可配置最大延迟
 * - 按错误类型智能判断是否重试
 * - 支持错误模式匹配
 */
export class ExponentialBackoffRetryStrategy implements IRetryStrategy {
  public readonly name = 'ExponentialBackoff';
  
  private readonly initialDelay: number;
  private readonly backoffMultiplier: number;
  private readonly maxDelay: number;
  private readonly maxRetries: number;
  
  /** 错误模式匹配规则 */
  private readonly errorPatterns: ErrorPattern[] = [
    // 临时性错误（可重试）
    {
      type: 'transient',
      patterns: [
        'network', 'timeout', 'connection', 'ECONNREFUSED', 'ECONNRESET',
        'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'socket hang up',
        'service unavailable', 'temporarily unavailable', 'rate limit',
        'too many requests', '503', '502', '429', 'retry',
      ],
      isTransient: true,
    },
    // 永久性错误（不可重试）
    {
      type: 'permanent',
      patterns: [
        'invalid', 'not found', 'unauthorized', 'forbidden', 'permission denied',
        'authentication', 'access denied', 'invalid request', 'bad request',
        'invalid parameter', 'validation error', '400', '401', '403', '404',
      ],
      isTransient: false,
    },
    // 用户取消（不可重试）
    {
      type: 'cancellation',
      patterns: [
        'cancelled', 'canceled', 'abort', 'user abort', 'killed',
        'user terminated', 'manual stop',
      ],
      isTransient: false,
    },
  ];
  
  constructor(config?: {
    initialDelay?: number;
    backoffMultiplier?: number;
    maxDelay?: number;
    maxRetries?: number;
    customErrorPatterns?: ErrorPattern[];
  }) {
    this.initialDelay = config?.initialDelay ?? 30_000; // 30 秒
    this.backoffMultiplier = config?.backoffMultiplier ?? 2;
    this.maxDelay = config?.maxDelay ?? 300_000; // 5 分钟
    this.maxRetries = config?.maxRetries ?? 2;
    
    // 添加自定义错误模式
    if (config?.customErrorPatterns) {
      this.errorPatterns.push(...config.customErrorPatterns);
    }
  }
  
  /**
   * 计算重试延迟
   * 
   * @param retryCount - 当前重试次数
   * @param errorType - 错误类型（用于调整延迟）
   */
  public calculateDelay(retryCount: number, errorType?: ErrorType): number {
    // 基础延迟
    let delay = this.initialDelay * Math.pow(this.backoffMultiplier, retryCount);
    
    // 根据错误类型调整延迟
    if (errorType === 'timeout') {
      // 超时错误：增加 50% 延迟
      delay *= 1.5;
    } else if (errorType === 'transient') {
      // 临时性错误：减少 30% 延迟（快速重试）
      delay *= 0.7;
    }
    
    return Math.min(delay, this.maxDelay);
  }
  
  /**
   * 判断是否应该重试
   * 
   * @param retryCount - 当前重试次数
   * @param maxRetries - 最大重试次数
   * @param errorType - 错误类型
   * 
   * 优化项 3.1：只有临时性错误和超时错误才重试
   */
  public shouldRetry(retryCount: number, maxRetries: number, errorType?: ErrorType): boolean {
    // 检查重试次数
    if (retryCount >= maxRetries) {
      return false;
    }
    
    // 根据错误类型判断
    if (errorType) {
      // 只有临时性错误和超时错误才重试
      return errorType === 'transient' || errorType === 'timeout' || errorType === 'unknown';
    }
    
    // 未知错误类型，默认重试
    return true;
  }
  
  /**
   * 分类错误类型
   * 
   * @param error - 错误信息
   * @returns 错误类型
   * 
   * 优化项 3.1：智能识别错误类型
   */
  public classifyError(error: string): ErrorType {
    if (!error) {
      return 'unknown';
    }
    
    const lowerError = error.toLowerCase();
    
    // 匹配错误模式
    for (const pattern of this.errorPatterns) {
      for (const matchPattern of pattern.patterns) {
        if (matchPattern instanceof RegExp) {
          if (matchPattern.test(lowerError)) {
            return pattern.type;
          }
        } else {
          if (lowerError.includes(matchPattern.toLowerCase())) {
            return pattern.type;
          }
        }
      }
    }
    
    // 默认为临时性错误（保守策略）
    return 'transient';
  }
  
  /**
   * 获取下次重试延迟
   */
  public getNextDelay(currentRetryCount: number, error?: string): number {
    const errorType = error ? this.classifyError(error) : undefined;
    return this.calculateDelay(currentRetryCount, errorType);
  }
  
  /**
   * 获取所有重试延迟列表
   */
  public getAllDelays(): number[] {
    const delays: number[] = [];
    for (let i = 0; i < this.maxRetries; i++) {
      delays.push(this.calculateDelay(i));
    }
    return delays;
  }
  
  /**
   * 添加错误模式
   */
  public addErrorPattern(pattern: ErrorPattern): void {
    this.errorPatterns.push(pattern);
  }
  
  /**
   * 移除错误模式
   */
  public removeErrorPattern(type: ErrorType): void {
    const index = this.errorPatterns.findIndex(p => p.type === type);
    if (index !== -1) {
      this.errorPatterns.splice(index, 1);
    }
  }
  
  /**
   * 获取所有错误模式
   */
  public getErrorPatterns(): ErrorPattern[] {
    return [...this.errorPatterns];
  }
}

/**
 * 固定延迟重试策略
 */
export class FixedDelayRetryStrategy implements IRetryStrategy {
  public readonly name = 'FixedDelay';
  
  private readonly delay: number;
  private readonly maxRetries: number;
  
  constructor(config?: {
    delay?: number;
    maxRetries?: number;
  }) {
    this.delay = config?.delay ?? 30_000; // 30 秒
    this.maxRetries = config?.maxRetries ?? 2;
  }
  
  public calculateDelay(retryCount: number, errorType?: ErrorType): number {
    return this.delay;
  }
  
  public shouldRetry(retryCount: number, maxRetries: number, errorType?: ErrorType): boolean {
    // 临时性错误才重试
    if (errorType && errorType !== 'transient' && errorType !== 'timeout' && errorType !== 'unknown') {
      return false;
    }
    return retryCount < maxRetries;
  }
  
  public classifyError(error: string): ErrorType {
    // 简单分类
    const lowerError = error.toLowerCase();
    if (lowerError.includes('network') || lowerError.includes('timeout')) {
      return 'transient';
    }
    if (lowerError.includes('invalid') || lowerError.includes('unauthorized')) {
      return 'permanent';
    }
    return 'unknown';
  }
}

/**
 * 线性递增重试策略
 */
export class LinearBackoffRetryStrategy implements IRetryStrategy {
  public readonly name = 'LinearBackoff';
  
  private readonly baseDelay: number;
  private readonly increment: number;
  private readonly maxDelay: number;
  private readonly maxRetries: number;
  
  constructor(config?: {
    baseDelay?: number;
    increment?: number;
    maxDelay?: number;
    maxRetries?: number;
  }) {
    this.baseDelay = config?.baseDelay ?? 10_000; // 10 秒
    this.increment = config?.increment ?? 10_000; // 10 秒
    this.maxDelay = config?.maxDelay ?? 120_000; // 2 分钟
    this.maxRetries = config?.maxRetries ?? 3;
  }
  
  public calculateDelay(retryCount: number, errorType?: ErrorType): number {
    let delay = this.baseDelay + this.increment * retryCount;
    
    // 根据错误类型调整
    if (errorType === 'timeout') {
      delay *= 1.5;
    }
    
    return Math.min(delay, this.maxDelay);
  }
  
  public shouldRetry(retryCount: number, maxRetries: number, errorType?: ErrorType): boolean {
    if (retryCount >= maxRetries) {
      return false;
    }
    
    if (errorType && errorType !== 'transient' && errorType !== 'timeout' && errorType !== 'unknown') {
      return false;
    }
    
    return true;
  }
  
  public classifyError(error: string): ErrorType {
    const lowerError = error.toLowerCase();
    if (lowerError.includes('network') || lowerError.includes('connection')) {
      return 'transient';
    }
    if (lowerError.includes('cancelled') || lowerError.includes('abort')) {
      return 'cancellation';
    }
    return 'unknown';
  }
}

/**
 * 自适应重试策略
 * 
 * 根据历史成功率动态调整重试参数
 */
export class AdaptiveRetryStrategy implements IRetryStrategy {
  public readonly name = 'Adaptive';
  
  private readonly baseStrategy: IRetryStrategy;
  private successCount: number = 0;
  private failureCount: number = 0;
  private lastAdjustTime: number = Date.now();
  
  constructor(baseStrategy?: IRetryStrategy) {
    this.baseStrategy = baseStrategy ?? new ExponentialBackoffRetryStrategy();
  }
  
  public calculateDelay(retryCount: number, errorType?: ErrorType): number {
    // 根据成功率调整延迟
    const successRate = this.getSuccessRate();
    let multiplier = 1.0;
    
    if (successRate < 0.3) {
      // 成功率低，增加延迟
      multiplier = 1.5;
    } else if (successRate > 0.7) {
      // 成功率高，减少延迟
      multiplier = 0.8;
    }
    
    return Math.floor(this.baseStrategy.calculateDelay(retryCount, errorType) * multiplier);
  }
  
  public shouldRetry(retryCount: number, maxRetries: number, errorType?: ErrorType): boolean {
    return this.baseStrategy.shouldRetry(retryCount, maxRetries, errorType);
  }
  
  public classifyError(error: string): ErrorType {
    return this.baseStrategy.classifyError(error);
  }
  
  /**
   * 记录成功
   */
  public recordSuccess(): void {
    this.successCount++;
    this.adjustIfNeeded();
  }
  
  /**
   * 记录失败
   */
  public recordFailure(): void {
    this.failureCount++;
    this.adjustIfNeeded();
  }
  
  /**
   * 获取成功率
   */
  public getSuccessRate(): number {
    const total = this.successCount + this.failureCount;
    if (total === 0) return 0.5;
    return this.successCount / total;
  }
  
  /**
   * 定期重置统计
   */
  private adjustIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastAdjustTime > 3600_000) { // 1小时
      this.successCount = 0;
      this.failureCount = 0;
      this.lastAdjustTime = now;
    }
  }
}

export default ExponentialBackoffRetryStrategy;
