/**
 * TurnCredentialIssuer（§11.3）：issueEphemeralCredentials。
 * 只签发短时 TURN 凭证，客户端不持有长期密码；签发请求同样签名校验 + 限流 + 审计。
 */
import type { ControlPlaneConfig } from '../config.js';
import {
  issueTurnCredentials,
  type TurnCredentials,
} from '../crypto/turn.js';
import type { TurnCredentialsRequest } from '../schema/validation.js';
import type { Stores } from '../store/interfaces.js';
import { appendAudit, auditEvent } from '../core/audit.js';
import { DeviceRegistry } from '../core/DeviceRegistry.js';
import { SecurityError } from '../core/errors.js';
import { RateLimiter } from '../core/RateLimiter.js';

export class TurnCredentialIssuer {
  constructor(
    private readonly stores: Stores,
    private readonly config: ControlPlaneConfig,
    private readonly devices: DeviceRegistry,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async issueEphemeralCredentials(
    input: TurnCredentialsRequest,
  ): Promise<TurnCredentials> {
    await this.devices.verifyRequestSignature(
      input.deviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    const rate = this.rateLimiter.checkSignalingRate(`turn:${input.deviceId}`);
    if (!rate.allowed) {
      await appendAudit(
        this.stores.audit,
        auditEvent('TURN_CREDENTIALS', input.deviceId, 'RATE_LIMITED', {
          retryAfterSeconds: rate.retryAfterSeconds,
        }),
      );
      throw new SecurityError('RATE_LIMITED');
    }
    const credentials = issueTurnCredentials({
      deviceId: input.deviceId,
      turnSecret: this.config.turnSecret,
      ttlSeconds: input.ttlSeconds,
      uris: this.config.turnUris,
    });
    // 审计不记录 credential / username，只记录 TTL 与结果码。
    await appendAudit(
      this.stores.audit,
      auditEvent('TURN_CREDENTIALS', input.deviceId, 'OK', {
        ttlSeconds: credentials.ttlSeconds,
      }),
    );
    return credentials;
  }
}
