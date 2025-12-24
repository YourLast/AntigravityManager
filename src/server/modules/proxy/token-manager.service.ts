import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CloudAccountRepo } from '../../../ipc/database/cloudHandler';
import { CloudAccount } from '../../../types/cloudAccount';
import { GoogleAPIService } from '../../../services/GoogleAPIService';

interface TokenData {
  email: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  project_id?: string;
  session_id?: string;
}

/** 滑动窗口计数器 - 用于追踪 RPM */
class SlidingWindowCounter {
  private timestamps: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = 60000) {
    // 默认 60 秒窗口
    this.windowMs = windowMs;
  }

  /** 记录一次请求 */
  record(): void {
    this.timestamps.push(Date.now());
    this.cleanup();
  }

  /** 获取当前窗口内的请求数 */
  getCount(): number {
    this.cleanup();
    return this.timestamps.length;
  }

  /** 清理过期的时间戳 */
  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }
}

/** 配额指标 - 用于前端展示 */
export interface AccountQuotaMetrics {
  accountId: string;
  email: string;
  rpm: number; // 当前 RPM
  isRateLimited: boolean;
  cooldownUntil: number | null; // 冷却结束时间戳
  quotaPercentage: number | null; // 来自 API 的配额百分比
  resetTime: string | null; // 配额重置时间
}

@Injectable()
export class TokenManagerService implements OnModuleInit {
  private readonly logger = new Logger(TokenManagerService.name);
  private currentIndex = 0;
  // In-memory cache of tokens with additional data
  private tokens: Map<string, TokenData> = new Map();
  // Cooldown map for rate-limited accounts
  private cooldowns: Map<string, number> = new Map();
  // RPM counters per account (sliding window)
  private rpmCounters: Map<string, SlidingWindowCounter> = new Map();

  async onModuleInit() {
    // Load accounts on module initialization
    await this.loadAccounts();
  }

  async loadAccounts(): Promise<number> {
    try {
      const accounts = await CloudAccountRepo.getAccounts();
      let count = 0;

      for (const account of accounts) {
        const tokenData = this.convertAccountToToken(account);
        if (tokenData) {
          this.tokens.set(account.id, tokenData);
          count++;
        }
      }

      this.logger.log(`Loaded ${count} accounts`);
      return count;
    } catch (e) {
      this.logger.error('Failed to load accounts', e);
      return 0;
    }
  }

  private convertAccountToToken(account: CloudAccount): TokenData | null {
    if (!account.token) return null;

    return {
      account_id: account.id,
      email: account.email,
      access_token: account.token.access_token,
      refresh_token: account.token.refresh_token,
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      project_id: account.token.project_id || undefined,
      session_id: account.token.session_id || this.generateSessionId(),
    };
  }

  private generateSessionId(): string {
    // Match the Rust implementation's session ID format
    const min = 1_000_000_000_000_000_000n;
    const max = 9_000_000_000_000_000_000n;
    const range = max - min;
    const rand = BigInt(Math.floor(Math.random() * Number(range)));
    return (-(min + rand)).toString();
  }

  async getNextToken(): Promise<CloudAccount | null> {
    try {
      // Reload if empty
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) return null;

      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);

      // Filter out accounts in cooldown
      const validTokens = Array.from(this.tokens.entries()).filter(([email, _]) => {
        const cooldownUntil = this.cooldowns.get(email);
        return !cooldownUntil || cooldownUntil <= now;
      });

      if (validTokens.length === 0) {
        this.logger.warn('All accounts are in cooldown');
        return null;
      }

      // Round robin selection
      const [accountId, tokenData] = validTokens[this.currentIndex % validTokens.length];
      this.currentIndex++;

      // Check if token needs refresh (expires in < 5 minutes)
      if (nowSeconds >= tokenData.expiry_timestamp - 300) {
        this.logger.log(`Token for ${tokenData.email} expiring soon, refreshing...`);
        try {
          const newTokens = await GoogleAPIService.refreshAccessToken(tokenData.refresh_token);

          // Update token data
          tokenData.access_token = newTokens.access_token;
          tokenData.expires_in = newTokens.expires_in;
          tokenData.expiry_timestamp = nowSeconds + newTokens.expires_in;

          // Save to DB
          await this.saveRefreshedToken(accountId, tokenData);
          this.tokens.set(accountId, tokenData);

          this.logger.log(`Token refreshed for ${tokenData.email}`);
        } catch (e) {
          this.logger.error(`Failed to refresh token for ${tokenData.email}`, e);
        }
      }

      // Resolve project ID if missing (mock for now, like original)
      if (!tokenData.project_id) {
        const mockId = `cloud-code-${Math.floor(Math.random() * 100000)}`;
        tokenData.project_id = mockId;
        await this.saveProjectId(accountId, mockId);
      }

      this.logger.log(`Selected account: ${tokenData.email}`);

      // Return in CloudAccount format for compatibility
      return {
        id: accountId,
        email: tokenData.email,
        token: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: tokenData.project_id,
          session_id: tokenData.session_id,
        },
      } as CloudAccount;
    } catch (error) {
      this.logger.error('Failed to get token', error);
      return null;
    }
  }

  markAsRateLimited(email: string) {
    // Cooldown for 5 minutes
    const until = Date.now() + 5 * 60 * 1000;
    this.cooldowns.set(email, until);
    this.logger.warn(
      `Account ${email} marked as rate limited until ${new Date(until).toISOString()}`,
    );
  }

  resetCooldown(email: string) {
    this.cooldowns.delete(email);
  }

  private async saveRefreshedToken(accountId: string, tokenData: TokenData) {
    try {
      const acc = await CloudAccountRepo.getAccount(accountId);
      if (acc && acc.token) {
        const newToken = {
          ...acc.token,
          access_token: tokenData.access_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
        };
        await CloudAccountRepo.updateToken(accountId, newToken);
      }
    } catch (e) {
      this.logger.error('Failed to save refreshed token to DB', e);
    }
  }

  private async saveProjectId(accountId: string, projectId: string) {
    try {
      const acc = await CloudAccountRepo.getAccount(accountId);
      if (acc && acc.token) {
        const newToken = {
          ...acc.token,
          project_id: projectId,
        };
        await CloudAccountRepo.updateToken(accountId, newToken);
      }
    } catch (e) {
      this.logger.error('Failed to save project ID to DB', e);
    }
  }

  /**
   * Get the number of loaded accounts (for status)
   */
  getAccountCount(): number {
    return this.tokens.size;
  }

  /**
   * 记录一次请求 (用于 RPM 追踪)
   * @param accountId 账号 ID
   */
  recordRequest(accountId: string): void {
    if (!this.rpmCounters.has(accountId)) {
      this.rpmCounters.set(accountId, new SlidingWindowCounter());
    }
    this.rpmCounters.get(accountId)!.record();
  }

  /**
   * 获取指定账号的当前 RPM
   * @param accountId 账号 ID
   */
  getRpm(accountId: string): number {
    const counter = this.rpmCounters.get(accountId);
    return counter ? counter.getCount() : 0;
  }

  /**
   * 检查账号是否应被跳过 (配额不足)
   * 阈值: 如果 RPM 已达到估算限制的 80%, 跳过该账号
   * @param accountId 账号 ID
   * @param estimatedRpmLimit 估算的 RPM 限制 (默认 60)
   */
  shouldSkipAccount(accountId: string, estimatedRpmLimit: number = 60): boolean {
    const rpm = this.getRpm(accountId);
    const threshold = estimatedRpmLimit * 0.8;
    return rpm >= threshold;
  }

  /**
   * 获取所有账号的配额指标 (供前端仪表盘使用)
   */
  async getQuotaMetrics(): Promise<AccountQuotaMetrics[]> {
    const metrics: AccountQuotaMetrics[] = [];
    const accounts = await CloudAccountRepo.getAccounts();
    const now = Date.now();

    for (const account of accounts) {
      const cooldownUntil = this.cooldowns.get(account.id) ?? null;
      const isRateLimited = cooldownUntil !== null && cooldownUntil > now;

      // 从 quota 对象获取平均配额百分比
      let quotaPercentage: number | null = null;
      let resetTime: string | null = null;

      if (account.quota && account.quota.models) {
        const modelQuotas = Object.values(account.quota.models);
        if (modelQuotas.length > 0) {
          quotaPercentage =
            modelQuotas.reduce((sum, m) => sum + m.percentage, 0) / modelQuotas.length;
        }
        // 尝试获取第一个模型的 resetTime
        const firstModel = modelQuotas[0];
        if (firstModel && 'resetTime' in firstModel) {
          resetTime = (firstModel as any).resetTime || null;
        }
      }

      metrics.push({
        accountId: account.id,
        email: account.email,
        rpm: this.getRpm(account.id),
        isRateLimited,
        cooldownUntil: isRateLimited ? cooldownUntil : null,
        quotaPercentage,
        resetTime,
      });
    }

    return metrics;
  }
}
