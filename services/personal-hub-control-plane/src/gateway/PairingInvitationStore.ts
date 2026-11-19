/**
 * PairingInvitationStore（§11.3）：createInvitation / consumeInvitation。
 * 安全约束（§6.2 / §12 / §13）：
 *  - secret 仅以 SHA-256 哈希存储，明文只随 create 返回值交给 Hub 生成二维码；
 *  - 一次性、默认 5 分钟、最多 5 次错误尝试（secret 比对已前移到
 *    PairingRequestStore.submitRequest，失败计数与吊销语义不变）；
 *  - 配对成功只授予 DEVICE_PAIRED / HUB_DISCOVERY，绝不授予 REMOTE_CONTROL，
 *    也不产生任何 LocalAuthGrant。
 *
 * P3 关键收紧（基线 §6.2 第 4–8 步 / 契约 §0）：
 *  `consumeInvitation` **只能由 PC 本机批准路径**（PairingRequestStore.decideRequest
 *  且 approved=true）调用。它不接受外部 HTTP 请求体，也不再有任何公开路由；
 *  Android 单方面调用不再能创建设备。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { ControlPlaneConfig } from '../config.js';
import type { CreateInvitation } from '../schema/validation.js';
import { fingerprintOfPublicKey, sha256Hex } from '../crypto/signatures.js';
import type { Stores } from '../store/interfaces.js';
import type {
  DeviceRecord,
  PairingInvitationRecord,
  PairingRequestRecord,
} from '../types.js';
import { appendAudit, auditEvent } from '../core/audit.js';
import { DeviceRegistry } from '../core/DeviceRegistry.js';
import { SecurityError } from '../core/errors.js';

export interface CreatedInvitation {
  invitation: PairingInvitationRecord;
  /** 一次性明文 secret，仅返回给 Hub，云端不持久化。 */
  invitationSecret: string;
}

export interface ConsumptionResult {
  device: DeviceRecord;
  invitation: PairingInvitationRecord;
  /** 仅代表可信设备关系，不含 REMOTE_CONTROL、不含任何 grant。 */
  pairedCapabilities: readonly ['DEVICE_PAIRED', 'HUB_DISCOVERY'];
}

export class PairingInvitationStore {
  constructor(
    private readonly stores: Stores,
    private readonly config: ControlPlaneConfig,
    private readonly devices: DeviceRegistry,
  ) {}

  async createInvitation(input: CreateInvitation): Promise<CreatedInvitation> {
    await this.devices.verifyRequestSignature(
      input.issuerDeviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );

    const ttl = input.ttlSeconds ?? this.config.invitationTtlSeconds;
    const now = new Date();
    const invitationSecret = randomBytes(16).toString('base64');
    const invitation: PairingInvitationRecord = {
      invitationId: randomUUID(),
      issuerDeviceId: input.issuerDeviceId,
      invitationSecretHash: sha256Hex(Buffer.from(invitationSecret, 'base64')),
      nonce: randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      consumedAt: null,
      failedAttempts: 0,
      status: 'pending',
    };
    await this.stores.invitations.create(invitation);
    await appendAudit(
      this.stores.audit,
      auditEvent('INVITATION_CREATED', input.issuerDeviceId, 'OK', {
        ttlSeconds: ttl,
      }),
    );
    return { invitation, invitationSecret };
  }

  /**
   * 内部方法：消费邀请并创建设备记录。
   *
   * **唯一合法调用方**是 `PairingRequestStore.decideRequest({ approved: true })`，
   * 即「PC 本机批准」之后。禁止在路由层或任何 Android 可达路径中直接调用；
   * 路由层已移除 `/v1/invitations/consume`（见契约 §0 与 P3 安全修复）。
   *
   * 入参是已经验签并落库的 PairingRequestRecord，不是外部请求体。
   */
  async consumeInvitation(
    request: PairingRequestRecord,
  ): Promise<ConsumptionResult> {
    // 纵深防御：落库公钥与指纹必须自洽（提交时已校验，防止存储被篡改）。
    if (
      fingerprintOfPublicKey(request.identityPublicKey) !==
      request.identityFingerprint
    ) {
      throw new SecurityError('FINGERPRINT_MISMATCH');
    }

    const invitation = await this.stores.invitations.get(request.invitationId);
    if (!invitation) throw new SecurityError('INVALID_INVITATION');
    if (invitation.issuerDeviceId !== request.issuerDeviceId) {
      throw new SecurityError('IDENTITY_MISMATCH');
    }
    if (invitation.status !== 'pending') {
      throw new SecurityError('INVITATION_NOT_PENDING');
    }
    if (Date.parse(invitation.expiresAt) <= Date.now()) {
      invitation.status = 'expired';
      await this.stores.invitations.update(invitation);
      await appendAudit(
        this.stores.audit,
        auditEvent('PAIRING_ATTEMPT', request.deviceId, 'INVITATION_EXPIRED'),
      );
      throw new SecurityError('INVITATION_EXPIRED');
    }

    // 先做设备冲突预检，避免「已消费邀请但设备创建失败」的中间态。
    const existing = await this.stores.devices.get(request.deviceId);
    if (existing && existing.identityPublicKey !== request.identityPublicKey) {
      throw new SecurityError('IDENTITY_MISMATCH');
    }

    // 一次性消费。
    const now = new Date().toISOString();
    invitation.status = 'consumed';
    invitation.consumedAt = now;
    await this.stores.invitations.update(invitation);

    const device =
      existing ??
      (await this.stores.devices.create({
        deviceId: request.deviceId,
        deviceType: request.deviceType,
        displayName: request.displayName,
        identityPublicKey: request.identityPublicKey,
        identityFingerprint: request.identityFingerprint,
        createdAt: now,
        lastSeenAt: now,
        revokedAt: null,
      }));

    await appendAudit(
      this.stores.audit,
      auditEvent('PAIRING_CONSUMED', request.deviceId, 'OK'),
    );
    return {
      device,
      invitation,
      pairedCapabilities: ['DEVICE_PAIRED', 'HUB_DISCOVERY'],
    };
  }
}
