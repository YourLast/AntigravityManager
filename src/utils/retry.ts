/**
 * Retry Utilities - Exponential Backoff with Jitter
 * 指数退避重试工具函数
 */
import { RetryConfig } from '@/types/config';

/** 默认重试配置 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.3,
};

/**
 * 计算指数退避延迟时间（带抖动）
 *
 * 公式: delay = min(maxDelay, initialDelay * (2 ^ attempt) * (1 + random * jitterFactor))
 *
 * @param attempt 当前重试次数 (0-indexed)
 * @param config 重试配置
 * @returns 延迟时间 (毫秒)
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): number {
  const { initialDelayMs, maxDelayMs, jitterFactor } = config;

  // 指数增长: initialDelay * 2^attempt
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);

  // 添加随机抖动以避免惊群效应
  const jitter = 1 + Math.random() * jitterFactor;

  // 应用抖动并限制最大值
  const delay = Math.min(maxDelayMs, exponentialDelay * jitter);

  return Math.floor(delay);
}

/**
 * 判断错误是否应该触发重试
 * @param error 错误对象或消息
 * @returns 是否应该重试
 */
export function isRetryableError(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message;
  const lowerMessage = message.toLowerCase();

  // 429 Too Many Requests
  if (lowerMessage.includes('429') || lowerMessage.includes('too many requests')) {
    return true;
  }

  // 5xx Server Errors
  if (
    lowerMessage.includes('500') ||
    lowerMessage.includes('502') ||
    lowerMessage.includes('503') ||
    lowerMessage.includes('504')
  ) {
    return true;
  }

  // Gemini specific errors
  if (
    lowerMessage.includes('resource_exhausted') ||
    lowerMessage.includes('rate_limit') ||
    lowerMessage.includes('quota')
  ) {
    return true;
  }

  return false;
}

/**
 * 等待指定时间
 * @param ms 毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
