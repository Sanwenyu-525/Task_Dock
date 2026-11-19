/**
 * SignalingGateway（§11.3）：connectDevice / forwardSignedSignal。
 *
 * 安全不变量（§3.A / §13 / §16）：
 *  - 只转发「签名绑定」的 signaling 密文：签名覆盖 sessionId、双方设备、
 *    dtls_fingerprint、ciphertextHash、过期时间；验签失败一律拒绝。
 *  - 网关把 ciphertext 当作不透明字节（base64）原样转发：不解析 SDP/ICE、
 *    不解密、不重写、不落库保存密文正文（§7.5）。
 *  - 无私钥、无 LocalAuthGrant 签发能力、不读取媒体/DataChannel 内容。
 */
import type { ControlPlaneConfig } from '../config.js';
import {
  assertFresh,
  type SignedSignal,
  type WssAuth,
} from '../schema/validation.js';
import { sha256Hex, timingSafeEqualHex } from '../crypto/signatures.js';
import type { Stores } from '../store/interfaces.js';
import { DeviceRegistry } from '../core/DeviceRegistry.js';
import { SecurityError } from '../core/errors.js';
import { RateLimiter } from '../core/RateLimiter.js';
import { appendAudit, auditEvent } from '../core/audit.js';

/** 转发给目标设备的信封：字段与来源签名完整保留，ciphertext 原样透传。 */
export interface ForwardedSignal {
  type: SignedSignal['type'];
  sessionId: string;
  fromDeviceId: string;
  toDeviceId: string;
  dtlsFingerprint: string;
  ciphertext: string;
  ciphertextHash: string;
  expiresAt: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export class SignalingGateway {
  constructor(
    private readonly stores: Stores,
    private readonly config: ControlPlaneConfig,
    private readonly devices: DeviceRegistry,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /** WSS 连接时验证设备身份签名（fail-closed），供上层标记连接已认证。 */
  async connectDevice(input: WssAuth): Promise<{ deviceId: string }> {
    await this.devices.verifyRequestSignature(
      input.deviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    if (!this.rateLimiter.checkAndConsumeNonce(input.deviceId, input.nonce)) {
      throw new SecurityError('REPLAY_DETECTED');
    }
    await appendAudit(
      this.stores.audit,
      auditEvent('SIGNALING_CONNECTED', input.deviceId, 'OK'),
    );
    return { deviceId: input.deviceId };
  }

  /**
   * 转发签名绑定的信令密文。返回的对象中 ciphertext 与签名与输入逐字节一致。
   */
  async forwardSignedSignal(input: SignedSignal): Promise<ForwardedSignal> {
    assertFresh(input.timestamp, Date.now(), this.config.maxClockSkewMs);

    if (!this.rateLimiter.checkAndConsumeNonce(input.fromDeviceId, input.nonce)) {
      await appendAudit(
        this.stores.audit,
        auditEvent('SIGNAL_FORWARD', input.fromDeviceId, 'REPLAY_DETECTED'),
      );
      throw new SecurityError('REPLAY_DETECTED');
    }
    const rate = this.rateLimiter.checkSignalingRate(
      `signal:${input.fromDeviceId}`,
    );
    if (!rate.allowed) {
      await appendAudit(
        this.stores.audit,
        auditEvent('SIGNAL_FORWARD', input.fromDeviceId, 'RATE_LIMITED', {
          retryAfterSeconds: rate.retryAfterSeconds,
        }),
      );
      throw new SecurityError('RATE_LIMITED');
    }

    await this.devices.verifyRequestSignature(
      input.fromDeviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    await this.devices.requireActiveDevice(input.toDeviceId);

    if (Date.parse(input.expiresAt) <= Date.now()) {
      await appendAudit(
        this.stores.audit,
        auditEvent('SIGNAL_FORWARD', input.fromDeviceId, 'SIGNAL_EXPIRED'),
      );
      throw new SecurityError('SIGNAL_EXPIRED');
    }

    // 密文完整性：签名已绑定 ciphertextHash，再校验哈希与密文字节一致。
    const actualHash = sha256Hex(Buffer.from(input.ciphertext, 'base64'));
    if (!timingSafeEqualHex(actualHash, input.ciphertextHash)) {
      await appendAudit(
        this.stores.audit,
        auditEvent('SIGNAL_FORWARD', input.fromDeviceId, 'CIPHERTEXT_HASH_MISMATCH'),
      );
      throw new SecurityError('CIPHERTEXT_HASH_MISMATCH');
    }

    // 仅登记最小会话元数据（§12），不保存 SDP/ICE 或密文正文。
    const now = new Date().toISOString();
    const existing = await this.stores.sessions.get(input.sessionId);
    if (!existing) {
      await this.stores.sessions.create({
        sessionId: input.sessionId,
        controllerDeviceId: input.fromDeviceId,
        targetDeviceId: input.toDeviceId,
        requestedScopes: [],
        grantedScopes: [],
        sessionNonce: input.nonce,
        createdAt: now,
        expiresAt: input.expiresAt,
        status: 'establishing',
      });
    }

    await appendAudit(
      this.stores.audit,
      auditEvent('SIGNAL_FORWARD', input.fromDeviceId, 'OK', {
        signalType: input.type,
        sessionId: input.sessionId,
      }),
    );

    // 关键：不透明密文与签名原样透传；网关从不解析或解密。
    return {
      type: input.type,
      sessionId: input.sessionId,
      fromDeviceId: input.fromDeviceId,
      toDeviceId: input.toDeviceId,
      dtlsFingerprint: input.dtlsFingerprint,
      ciphertext: input.ciphertext,
      ciphertextHash: input.ciphertextHash,
      expiresAt: input.expiresAt,
      timestamp: input.timestamp,
      nonce: input.nonce,
      signature: input.signature,
    };
  }
}
