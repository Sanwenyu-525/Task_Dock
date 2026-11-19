/**
 * 所有云端接口的 zod schema 校验（§11.3：所有接口必须有 schema 校验）。
 * 选型说明：采用 zod —— 与 TypeScript 类型推断原生契合，且 .strict()
 * 可拒绝任何未声明字段，从而阻断 privateKey / password / grant / 媒体正文
 * 等非契约字段进入云端。
 */
import { z } from 'zod';
import { isBase64OfLength } from '../crypto/signatures.js';

const SIGNED_BASE = {
  timestamp: z.string().datetime({ message: 'timestamp must be UTC ISO-8601' }),
  nonce: z.string().uuid(),
  signature: z
    .string()
    .refine(
      (value) => isBase64OfLength(value, 64),
      'signature must be base64-encoded 64-byte Ed25519 signature',
    ),
};

const PUBLIC_KEY = z
  .string()
  .refine(
    (value) => isBase64OfLength(value, 32),
    'identityPublicKey must be base64-encoded 32-byte Ed25519 raw public key',
  );

const FINGERPRINT = z.string().regex(/^[0-9a-f]{32}$/);

/** 时间戳新鲜度检查（防重放），默认 ±5 分钟。 */
export function assertFresh(
  timestamp: string,
  nowMs = Date.now(),
  maxSkewMs = 5 * 60 * 1000,
): void {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > maxSkewMs) {
    throw new Error('STALE_TIMESTAMP');
  }
}

/** 设备注册（自签名：公钥随请求提交，服务端用该公钥验签）。 */
export const DeviceRegistrationSchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
    deviceType: z.enum(['windows-hub', 'android']),
    displayName: z.string().min(1).max(128),
    identityPublicKey: PUBLIC_KEY,
    identityFingerprint: FINGERPRINT,
  })
  .strict();

/** 创建邀请（由 Hub 发起，签名绑定 issuer + 过期时间）。 */
export const CreateInvitationSchema = z
  .object({
    ...SIGNED_BASE,
    issuerDeviceId: z.string().uuid(),
    ttlSeconds: z.number().int().min(30).max(300).optional(),
  })
  .strict();

/**
 * Android 提交配对申请（P3 契约 §3.2(1)）。
 * 自签名：公钥随请求提交，服务端用该公钥验签；**不消费邀请、不创建设备**。
 */
export const PairingRequestSchema = z
  .object({
    ...SIGNED_BASE,
    invitationId: z.string().uuid(),
    invitationSecret: z
      .string()
      .refine(
        (value) => isBase64OfLength(value, 16),
        'invitationSecret must be base64-encoded 128-bit value',
      ),
    deviceId: z.string().uuid(),
    // 本阶段仅 android；windows-hub 预留，不属于 P3 范围（fail-closed）。
    deviceType: z.literal('android'),
    displayName: z.string().min(1).max(128),
    identityPublicKey: PUBLIC_KEY,
    identityFingerprint: FINGERPRINT,
  })
  .strict();

/** PC 拉取待批准申请（契约 §3.2(2)）。 */
export const PairingRequestsListSchema = z
  .object({
    ...SIGNED_BASE,
    issuerDeviceId: z.string().uuid(),
  })
  .strict();

/** PC 本机批准/拒绝（契约 §3.2(3)）。 */
export const PairingDecideSchema = z
  .object({
    ...SIGNED_BASE,
    requestId: z.string().uuid(),
    issuerDeviceId: z.string().uuid(),
    approved: z.boolean(),
  })
  .strict();

/** Android 轮询配对结果（契约 §3.2(4)）。 */
export const PairingStatusQuerySchema = z
  .object({
    ...SIGNED_BASE,
    requestId: z.string().uuid(),
    deviceId: z.string().uuid(),
  })
  .strict();

/** 撤销设备 / 发布撤销状态。 */
export const RevokeDeviceSchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
    reason: z.string().min(1).max(256),
  })
  .strict();

/** 签发 TURN 短时凭证请求。 */
export const TurnCredentialsRequestSchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
    ttlSeconds: z.number().int().min(30).max(600).optional(),
  })
  .strict();

/** 在线状态更新。 */
export const PresenceUpdateSchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
    status: z.enum(['online', 'offline']),
  })
  .strict();

/** 设备发现查询（签名绑定请求者，返回公钥目录条目）。 */
export const DeviceDiscoverySchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
  })
  .strict();

/** WSS 连接首帧认证。 */
export const WssAuthSchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
  })
  .strict();

/** 设备发现查询（与 WSS 认证同形：deviceId + 签名）。 */
export const DeviceQuerySchema = WssAuthSchema;

/** 撤销状态同步查询。 */
export const RevocationListSchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
    since: z.string().datetime().optional(),
  })
  .strict();

/** 在线状态查询。 */
export const PresenceQuerySchema = z
  .object({
    ...SIGNED_BASE,
    deviceId: z.string().uuid(),
  })
  .strict();

/**
 * 签名绑定的信令信封。ciphertext 是不透明密文（base64），
 * ciphertextHash 绑定其字节；网关只校验签名/哈希并原样转发，不解密、不解析。
 */
export const SignedSignalSchema = z
  .object({
    ...SIGNED_BASE,
    type: z.enum(['offer', 'answer', 'ice-candidate']),
    sessionId: z.string().uuid(),
    fromDeviceId: z.string().uuid(),
    toDeviceId: z.string().uuid(),
    dtlsFingerprint: z.string().regex(/^[0-9a-f]{32,128}$/),
    ciphertext: z
      .string()
      .min(4)
      .max(1024 * 1024)
      .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value), {
        message: 'ciphertext must be base64',
      }),
    ciphertextHash: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>;
export type CreateInvitation = z.infer<typeof CreateInvitationSchema>;
export type PairingRequest = z.infer<typeof PairingRequestSchema>;
export type PairingRequestsList = z.infer<typeof PairingRequestsListSchema>;
export type PairingDecide = z.infer<typeof PairingDecideSchema>;
export type PairingStatusQuery = z.infer<typeof PairingStatusQuerySchema>;
export type RevokeDevice = z.infer<typeof RevokeDeviceSchema>;
export type TurnCredentialsRequest = z.infer<
  typeof TurnCredentialsRequestSchema
>;
export type PresenceUpdate = z.infer<typeof PresenceUpdateSchema>;
export type PresenceQuery = z.infer<typeof PresenceQuerySchema>;
export type DeviceDiscovery = z.infer<typeof DeviceDiscoverySchema>;
export type WssAuth = z.infer<typeof WssAuthSchema>;
export type SignedSignal = z.infer<typeof SignedSignalSchema>;
