/** DeviceRegistry（§11.3）：设备公钥注册、查询、撤销。 */
import type { ControlPlaneConfig } from '../config.js';
import { assertFresh, type DeviceRegistration } from '../schema/validation.js';
import { signablePayload } from '../schema/canonical.js';
import {
  fingerprintOfPublicKey,
  verifyEd25519Signature,
} from '../crypto/signatures.js';
import type { Stores } from '../store/interfaces.js';
import type { DeviceRecord } from '../types.js';
import { appendAudit, auditEvent } from './audit.js';
import { SecurityError } from './errors.js';

export class DeviceRegistry {
  constructor(
    private readonly stores: Stores,
    private readonly config: ControlPlaneConfig,
  ) {}

  /** 自签名校验：fingerprint 必须由提交的公钥推导，且签名验过。 */
  private verifySelfSigned(input: DeviceRegistration): void {
    assertFresh(input.timestamp, Date.now(), this.config.maxClockSkewMs);
    if (fingerprintOfPublicKey(input.identityPublicKey) !== input.identityFingerprint) {
      throw new SecurityError('FINGERPRINT_MISMATCH');
    }
    const ok = verifyEd25519Signature(
      input.identityPublicKey,
      signablePayload(input as unknown as Record<string, unknown>),
      input.signature,
    );
    if (!ok) throw new SecurityError('INVALID_SIGNATURE');
  }

  async registerDevice(input: DeviceRegistration): Promise<DeviceRecord> {
    this.verifySelfSigned(input);
    if (await this.stores.devices.get(input.deviceId)) {
      throw new SecurityError('DEVICE_ALREADY_EXISTS');
    }
    const now = new Date().toISOString();
    const device = await this.stores.devices.create({
      deviceId: input.deviceId,
      deviceType: input.deviceType,
      displayName: input.displayName,
      identityPublicKey: input.identityPublicKey,
      identityFingerprint: input.identityFingerprint,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    await appendAudit(
      this.stores.audit,
      auditEvent('DEVICE_REGISTERED', input.deviceId, 'OK'),
    );
    return device;
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | null> {
    const device = await this.stores.devices.get(deviceId);
    await appendAudit(
      this.stores.audit,
      auditEvent('DEVICE_READ', deviceId, device ? 'OK' : 'NOT_FOUND'),
    );
    return device;
  }

  async revokeDevice(
    deviceId: string,
    reason = 'unspecified',
  ): Promise<DeviceRecord | null> {
    const revoked = await this.stores.devices.revoke(
      deviceId,
      new Date().toISOString(),
    );
    // 审计只记录理由类别，不记录可能含敏感信息的自由文本正文。
    const reasonClass = /policy|admin|user/i.test(reason) ? 'policy' : 'other';
    await appendAudit(
      this.stores.audit,
      auditEvent('DEVICE_REVOKED', deviceId, revoked ? 'OK' : 'NOT_FOUND', {
        reasonClass,
      }),
    );
    return revoked;
  }

  /** 内部使用：取活跃设备公钥用于验签；撤销/不存在即拒绝（fail-closed）。 */
  async requireActiveDevice(deviceId: string): Promise<DeviceRecord> {
    const device = await this.stores.devices.get(deviceId);
    if (!device) throw new SecurityError('DEVICE_NOT_FOUND');
    if (device.revokedAt) throw new SecurityError('DEVICE_REVOKED');
    return device;
  }

  /** 通用验签入口：用已注册公钥验证任意签名请求体。 */
  async verifyRequestSignature(
    deviceId: string,
    body: Record<string, unknown>,
    signature: string,
    timestamp: string,
  ): Promise<DeviceRecord> {
    assertFresh(timestamp, Date.now(), this.config.maxClockSkewMs);
    const device = await this.requireActiveDevice(deviceId);
    if (
      !verifyEd25519Signature(
        device.identityPublicKey,
        signablePayload(body),
        signature,
      )
    ) {
      await appendAudit(
        this.stores.audit,
        auditEvent('SIGNATURE_VERIFY', deviceId, 'INVALID'),
      );
      throw new SecurityError('INVALID_SIGNATURE');
    }
    return device;
  }
}
