/**
 * PairingRequestStore（P3 契约 §3.1–§3.3）：补齐基线 §6.2 第 4–8 步的
 * `awaiting_pc_approval` 中间状态。
 *
 * 安全不变量（不可降级）：
 *  - Android 提交申请时**不消费邀请、不创建设备、不授予能力、不签发 grant**；
 *  - 只有 PC 本机（邀请的 issuer）签名批准后，才消费邀请并创建设备记录；
 *  - 任何请求都先经过 zod（路由层）→ 新鲜度 → 指纹 → Ed25519 验签 → nonce 防重放
 *    → 限流 → 审计；失败一律 fail-closed；
 *  - 配对能力固定为 ["DEVICE_PAIRED","HUB_DISCOVERY"]，永不含 REMOTE_CONTROL。
 */
import { randomUUID } from 'node:crypto';
import type { ControlPlaneConfig } from '../config.js';
import {
  assertFresh,
  type PairingDecide,
  type PairingRequest,
  type PairingRequestsList,
  type PairingStatusQuery,
} from '../schema/validation.js';
import { signablePayload } from '../schema/canonical.js';
import {
  fingerprintOfPublicKey,
  sha256Hex,
  timingSafeEqualHex,
  verifyEd25519Signature,
} from '../crypto/signatures.js';
import type { Stores } from '../store/interfaces.js';
import type {
  DeviceRecord,
  PairingInvitationRecord,
  PairingRequestRecord,
  PairingRequestStatus,
} from '../types.js';
import { DeviceRegistry } from '../core/DeviceRegistry.js';
import { RateLimiter } from '../core/RateLimiter.js';
import { SecurityError } from '../core/errors.js';
import { appendAudit, auditEvent } from '../core/audit.js';
import { PairingInvitationStore } from './PairingInvitationStore.js';

/** PC 端展示的待批准申请（不含任何 grant / 私钥 / 能力字段）。 */
export interface PendingPairingRequestView {
  requestId: string;
  deviceId: string;
  deviceType: PairingRequestRecord['deviceType'];
  displayName: string;
  identityFingerprint: string;
  identityPublicKey: string;
  requestedAt: string;
  expiresAt: string;
}

export interface SubmittedPairingRequest {
  requestId: string;
  status: Extract<PairingRequestStatus, 'awaiting_pc_approval'>;
  expiresAt: string;
}

export interface PairingDecisionResult {
  status: Extract<PairingRequestStatus, 'approved' | 'rejected'>;
  device?: DeviceRecord;
  pairedCapabilities?: readonly ['DEVICE_PAIRED', 'HUB_DISCOVERY'];
}

export interface PairingRequestStatusView {
  status: PairingRequestStatus;
  /** 仅在 approved 时返回，供手机端与 PC 端人工比对指纹。 */
  peer?: {
    deviceId: string;
    displayName: string;
    deviceType: DeviceRecord['deviceType'];
    identityFingerprint: string;
  };
}

export class PairingRequestStore {
  constructor(
    private readonly stores: Stores,
    private readonly config: ControlPlaneConfig,
    private readonly devices: DeviceRegistry,
    private readonly invitations: PairingInvitationStore,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /** assertFresh 抛出的是普通 Error；统一转成 SecurityError 以得到稳定错误码。 */
  private assertFreshOrThrow(timestamp: string): void {
    try {
      assertFresh(timestamp, Date.now(), this.config.maxClockSkewMs);
    } catch {
      throw new SecurityError('STALE_TIMESTAMP');
    }
  }

  /** 契约 §1：nonce 按 (deviceId, nonce) 去重，重复即重放。 */
  private consumeNonceOrThrow(deviceId: string, nonce: string): void {
    if (!this.rateLimiter.checkAndConsumeNonce(deviceId, nonce)) {
      throw new SecurityError('REPLAY_DETECTED');
    }
  }

  /**
   * Android 提交配对申请（契约 §3.2(1)）。
   * 11 步行为顺序与契约一致；成功只产生一条 awaiting_pc_approval 记录。
   */
  async submitRequest(input: PairingRequest): Promise<SubmittedPairingRequest> {
    // 8) 限流先于 secret 比对（按邀请分桶）。
    const rate = this.rateLimiter.checkPairingAttempt(
      `invitation:${input.invitationId}`,
    );
    if (!rate.allowed) {
      await appendAudit(
        this.stores.audit,
        auditEvent('PAIRING_ATTEMPT', input.deviceId, 'RATE_LIMITED', {
          retryAfterSeconds: rate.retryAfterSeconds,
        }),
      );
      throw new SecurityError('RATE_LIMITED');
    }

    // 2) 新鲜度；3) 指纹必须由公钥推导；4) 自签名校验。
    this.assertFreshOrThrow(input.timestamp);
    if (
      fingerprintOfPublicKey(input.identityPublicKey) !==
      input.identityFingerprint
    ) {
      throw new SecurityError('FINGERPRINT_MISMATCH');
    }
    if (
      !verifyEd25519Signature(
        input.identityPublicKey,
        signablePayload(input as unknown as Record<string, unknown>),
        input.signature,
      )
    ) {
      await appendAudit(
        this.stores.audit,
        auditEvent('SIGNATURE_VERIFY', input.deviceId, 'INVALID'),
      );
      throw new SecurityError('INVALID_SIGNATURE');
    }
    // 重放：同一 nonce 不得二次提交（契约 §1）。
    this.consumeNonceOrThrow(input.deviceId, input.nonce);

    // 5) 邀请存在且 pending；6) 过期处理。
    const invitation = await this.stores.invitations.get(input.invitationId);
    if (!invitation) throw new SecurityError('INVALID_INVITATION');
    if (invitation.status !== 'pending') {
      throw new SecurityError('INVITATION_NOT_PENDING');
    }
    if (Date.parse(invitation.expiresAt) <= Date.now()) {
      invitation.status = 'expired';
      await this.stores.invitations.update(invitation);
      await appendAudit(
        this.stores.audit,
        auditEvent('PAIRING_ATTEMPT', input.deviceId, 'INVITATION_EXPIRED'),
      );
      throw new SecurityError('INVITATION_EXPIRED');
    }

    // 公钥替换防护：同一 deviceId 已注册时必须使用同一身份公钥。
    const registered = await this.stores.devices.get(input.deviceId);
    if (
      registered &&
      registered.identityPublicKey !== input.identityPublicKey
    ) {
      throw new SecurityError('IDENTITY_MISMATCH');
    }

    // 7) secret 哈希定时安全比对；失败累计，达上限吊销邀请。
    const providedHash = sha256Hex(
      Buffer.from(input.invitationSecret, 'base64'),
    );
    if (!timingSafeEqualHex(providedHash, invitation.invitationSecretHash)) {
      invitation.failedAttempts += 1;
      if (invitation.failedAttempts >= this.config.maxInvitationAttempts) {
        invitation.status = 'revoked';
      }
      await this.stores.invitations.update(invitation);
      await appendAudit(
        this.stores.audit,
        auditEvent('PAIRING_ATTEMPT', input.deviceId, 'INVALID_SECRET', {
          failedAttempts: invitation.failedAttempts,
        }),
      );
      throw new SecurityError('INVALID_INVITATION');
    }

    // 9) 同设备同邀请已有 pending 申请 → 幂等返回原 requestId。
    const existing =
      await this.stores.pairingRequests.findByDeviceAndInvitation(
        input.invitationId,
        input.deviceId,
      );
    if (existing) {
      return {
        requestId: existing.requestId,
        status: 'awaiting_pc_approval',
        expiresAt: invitation.expiresAt,
      };
    }

    // 10) 创建申请记录。11) 不消费邀请 / 不建设备 / 不授予能力 / 无 grant。
    const request: PairingRequestRecord = {
      requestId: randomUUID(),
      invitationId: input.invitationId,
      issuerDeviceId: invitation.issuerDeviceId,
      deviceId: input.deviceId,
      deviceType: input.deviceType,
      displayName: input.displayName,
      identityPublicKey: input.identityPublicKey,
      identityFingerprint: input.identityFingerprint,
      status: 'awaiting_pc_approval',
      requestedAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    await this.stores.pairingRequests.create(request);
    await appendAudit(
      this.stores.audit,
      auditEvent('PAIRING_REQUESTED', input.deviceId, 'AWAITING_PC_APPROVAL', {
        result: 'awaiting_pc_approval',
      }),
    );
    return {
      requestId: request.requestId,
      status: 'awaiting_pc_approval',
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * PC 拉取待批准申请（契约 §3.2(2)）。
   * 只返回**属于该 issuer 的邀请**、状态 awaiting 且未过期的申请。
   */
  async listPendingRequests(
    input: PairingRequestsList,
  ): Promise<PendingPairingRequestView[]> {
    this.assertFreshOrThrow(input.timestamp);
    await this.devices.verifyRequestSignature(
      input.issuerDeviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    this.consumeNonceOrThrow(input.issuerDeviceId, input.nonce);

    await this.expireStaleRequests();

    const rows = await this.stores.pairingRequests.listByIssuer(
      input.issuerDeviceId,
    );
    const pending: PendingPairingRequestView[] = [];
    for (const row of rows) {
      if (row.status !== 'awaiting_pc_approval') continue;
      const invitation = await this.stores.invitations.get(row.invitationId);
      // 邀请已消费/吊销/不存在时不应继续展示（fail-closed，不可批准）。
      if (!invitation || invitation.status !== 'pending') continue;
      if (Date.parse(invitation.expiresAt) <= Date.now()) continue;
      pending.push({
        requestId: row.requestId,
        deviceId: row.deviceId,
        deviceType: row.deviceType,
        displayName: row.displayName,
        identityFingerprint: row.identityFingerprint,
        identityPublicKey: row.identityPublicKey,
        requestedAt: row.requestedAt,
        expiresAt: invitation.expiresAt,
      });
    }
    await appendAudit(
      this.stores.audit,
      auditEvent('PAIRING_LIST', input.issuerDeviceId, 'OK', {
        count: pending.length,
      }),
    );
    return pending;
  }

  /**
   * PC 本机批准/拒绝（契约 §3.2(3)）。这是唯一能消费邀请、创建设备的路径。
   */
  async decideRequest(input: PairingDecide): Promise<PairingDecisionResult> {
    this.assertFreshOrThrow(input.timestamp);
    await this.devices.verifyRequestSignature(
      input.issuerDeviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    this.consumeNonceOrThrow(input.issuerDeviceId, input.nonce);

    const request = await this.stores.pairingRequests.get(input.requestId);
    if (!request) throw new SecurityError('REQUEST_NOT_FOUND');
    // 只有生成该邀请的 PC 才能决定，其他设备一律越权。
    if (request.issuerDeviceId !== input.issuerDeviceId) {
      await appendAudit(
        this.stores.audit,
        auditEvent('PAIRING_DECIDE', input.issuerDeviceId, 'IDENTITY_MISMATCH'),
      );
      throw new SecurityError('IDENTITY_MISMATCH');
    }
    if (request.status !== 'awaiting_pc_approval') {
      throw new SecurityError('INVITATION_NOT_PENDING');
    }

    const invitation = await this.stores.invitations.get(request.invitationId);
    if (!invitation) throw new SecurityError('INVALID_INVITATION');
    if (invitation.issuerDeviceId !== input.issuerDeviceId) {
      throw new SecurityError('IDENTITY_MISMATCH');
    }
    if (invitation.status !== 'pending') {
      throw new SecurityError('INVITATION_NOT_PENDING');
    }
    if (Date.parse(invitation.expiresAt) <= Date.now()) {
      await this.markRequestExpired(request, invitation);
      throw new SecurityError('INVITATION_EXPIRED');
    }

    const now = new Date().toISOString();

    if (!input.approved) {
      request.status = 'rejected';
      request.decidedAt = now;
      request.decidedBy = input.issuerDeviceId;
      await this.stores.pairingRequests.update(request);
      invitation.status = 'revoked';
      await this.stores.invitations.update(invitation);
      await appendAudit(
        this.stores.audit,
        auditEvent('PAIRING_REJECTED', request.deviceId, 'OK', {
          result: 'rejected',
        }),
      );
      return { status: 'rejected' };
    }

    // 批准：消费邀请 + 创建设备记录（consumeInvitation 是内部方法）。
    const consumed = await this.invitations.consumeInvitation(request);
    request.status = 'approved';
    request.decidedAt = now;
    request.decidedBy = input.issuerDeviceId;
    await this.stores.pairingRequests.update(request);
    // 审计只记 deviceId 与结果，不记公钥正文。
    await appendAudit(
      this.stores.audit,
      auditEvent('PAIRING_APPROVED', request.deviceId, 'OK', {
        result: 'approved',
      }),
    );
    return {
      status: 'approved',
      device: consumed.device,
      pairedCapabilities: consumed.pairedCapabilities,
    };
  }

  /**
   * Android 轮询配对结果（契约 §3.2(4)）。只能查自己的申请。
   *
   * 注意：申请期间该设备尚未进入设备公钥目录（未批准不建设备），
   * 因此签名用**申请记录内已验签存下的公钥**校验，证明轮询方持有对应私钥；
   * 同时 request.deviceId 必须等于请求 deviceId，越权一律 IDENTITY_MISMATCH。
   * 批准后仍可用同一身份继续轮询（公钥与设备记录一致）。
   */
  async getRequestStatus(
    input: PairingStatusQuery,
  ): Promise<PairingRequestStatusView> {
    this.assertFreshOrThrow(input.timestamp);

    const request = await this.stores.pairingRequests.get(input.requestId);
    if (!request) throw new SecurityError('REQUEST_NOT_FOUND');
    if (request.deviceId !== input.deviceId) {
      await appendAudit(
        this.stores.audit,
        auditEvent('PAIRING_STATUS', input.deviceId, 'IDENTITY_MISMATCH'),
      );
      throw new SecurityError('IDENTITY_MISMATCH');
    }
    if (
      !verifyEd25519Signature(
        request.identityPublicKey,
        signablePayload(input as unknown as Record<string, unknown>),
        input.signature,
      )
    ) {
      await appendAudit(
        this.stores.audit,
        auditEvent('SIGNATURE_VERIFY', input.deviceId, 'INVALID'),
      );
      throw new SecurityError('INVALID_SIGNATURE');
    }
    this.consumeNonceOrThrow(input.deviceId, input.nonce);

    if (request.status === 'awaiting_pc_approval') {
      const invitation = await this.stores.invitations.get(
        request.invitationId,
      );
      if (invitation && Date.parse(invitation.expiresAt) <= Date.now()) {
        await this.markRequestExpired(request, invitation);
      }
    }

    if (request.status !== 'approved') {
      await this.auditStatus(input.deviceId, request.status);
      return { status: request.status };
    }

    const peer = await this.stores.devices.get(request.issuerDeviceId);
    if (!peer) throw new SecurityError('DEVICE_NOT_FOUND');
    await this.auditStatus(input.deviceId, request.status);
    return {
      status: request.status,
      peer: {
        deviceId: peer.deviceId,
        displayName: peer.displayName,
        deviceType: peer.deviceType,
        identityFingerprint: peer.identityFingerprint,
      },
    };
  }

  /**
   * 惰性过期：把邀请已过期的 awaiting 申请置为 expired。
   * 返回本次过期的记录数（供测试与监控使用）。
   */
  async expireStaleRequests(nowMs = Date.now()): Promise<number> {
    const rows = await this.stores.pairingRequests.listAwaiting();
    let expired = 0;
    for (const row of rows) {
      const invitation = await this.stores.invitations.get(row.invitationId);
      if (!invitation || Date.parse(invitation.expiresAt) <= nowMs) {
        if (invitation && invitation.status === 'pending') {
          invitation.status = 'expired';
          await this.stores.invitations.update(invitation);
        }
        row.status = 'expired';
        row.decidedAt = new Date(nowMs).toISOString();
        row.decidedBy = null;
        await this.stores.pairingRequests.update(row);
        expired += 1;
      }
    }
    return expired;
  }

  private async markRequestExpired(
    request: PairingRequestRecord,
    invitation: PairingInvitationRecord,
  ): Promise<void> {
    if (invitation.status === 'pending') {
      invitation.status = 'expired';
      await this.stores.invitations.update(invitation);
    }
    request.status = 'expired';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = null;
    await this.stores.pairingRequests.update(request);
    await appendAudit(
      this.stores.audit,
      auditEvent('PAIRING_ATTEMPT', request.deviceId, 'INVITATION_EXPIRED'),
    );
  }

  /** 轮询结果审计：只记结果码，不记公钥/指纹正文。 */
  private auditStatus(deviceId: string, status: PairingRequestStatus): Promise<void> {
    return appendAudit(
      this.stores.audit,
      auditEvent('PAIRING_STATUS', deviceId, status.toUpperCase(), {
        result: status,
      }),
    );
  }
}
