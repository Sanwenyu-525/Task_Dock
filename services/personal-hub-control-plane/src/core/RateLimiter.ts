/** 限流器（§11.3 RateLimiter）：配对尝试、信令速率、签名 nonce 去重。 */
import type { ControlPlaneConfig } from '../config.js';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateCheck {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly pairingBuckets = new Map<string, Bucket>();
  private readonly signalingBuckets = new Map<string, Bucket>();
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly config: ControlPlaneConfig) {}

  private consume(
    buckets: Map<string, Bucket>,
    key: string,
    windowMs: number,
    limit: number,
    nowMs: number,
  ): RateCheck {
    const bucket = buckets.get(key);
    if (!bucket || nowMs >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((bucket.resetAt - nowMs) / 1000),
      };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** 配对尝试限流（按邀请 ID 分桶），默认每分钟 10 次。 */
  checkPairingAttempt(key: string, nowMs = Date.now()): RateCheck {
    return this.consume(
      this.pairingBuckets,
      key,
      60_000,
      this.config.pairingRatePerMinute,
      nowMs,
    );
  }

  /** 信令/TURN 请求限流（按设备分桶），默认每秒 30 次。 */
  checkSignalingRate(key: string, nowMs = Date.now()): RateCheck {
    return this.consume(
      this.signalingBuckets,
      key,
      1_000,
      this.config.signalingRatePerSecond,
      nowMs,
    );
  }

  /** nonce 单次使用（防历史请求重放），返回 false 表示已使用/重放。 */
  checkAndConsumeNonce(
    deviceId: string,
    nonce: string,
    nowMs = Date.now(),
  ): boolean {
    for (const [key, expiresAt] of this.usedNonces) {
      if (expiresAt <= nowMs) this.usedNonces.delete(key);
    }
    const key = `${deviceId}:${nonce}`;
    if (this.usedNonces.has(key)) return false;
    this.usedNonces.set(key, nowMs + this.config.nonceTtlMs);
    return true;
  }
}
