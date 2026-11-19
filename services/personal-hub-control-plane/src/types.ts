/**
 * 云端控制平面领域类型。
 * 严格对齐 ARCHITECTURE_BASELINE_v1.0 §12 数据模型与 §7.4/§7.5 数据保留约束。
 * 所有时间均为 UTC ISO-8601 字符串。
 *
 * 安全红线（§12 / §16.7）：
 *  - 不存私钥、系统密码、生物特征。
 *  - 不存明文 invitation secret，只存 SHA-256 哈希。
 *  - 云端不持久化 LocalAuthGrant 正文（grant_id / local_signature / 可复用 grant）。
 */

export type DeviceType = 'windows-hub' | 'android';
export type InvitationStatus = 'pending' | 'consumed' | 'expired' | 'revoked';
/**
 * 配对申请状态（P3 共享契约 §3.1）：
 * awaiting_pc_approval --PC approved--> approved
 * awaiting_pc_approval --PC rejected--> rejected（同时邀请置 revoked）
 * awaiting_pc_approval --超过邀请 exp--> expired
 * 只有 approved 才把邀请置 consumed。
 */
export type PairingRequestStatus =
  | 'awaiting_pc_approval'
  | 'approved'
  | 'rejected'
  | 'expired';
export type SessionStatus =
  | 'requested'
  | 'establishing'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'failed';
export type PresenceStatus = 'online' | 'offline';

/** 设备公钥目录中的一条记录（云端只持有公钥与最小元数据）。 */
export interface DeviceRecord {
  deviceId: string;
  deviceType: DeviceType;
  displayName: string;
  /** base64 编码的 32 字节 Ed25519 原始公钥。 */
  identityPublicKey: string;
  /** SHA-256(publicKey) 十六进制前 32 字符（16 字节）。 */
  identityFingerprint: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

/**
 * 配对邀请。secret 仅以哈希形式存在；failed_attempts 与 status 用于
 * 基线 §6.2「5 分钟 / 一次性 / 最多 5 次错误尝试」。
 */
export interface PairingInvitationRecord {
  invitationId: string;
  issuerDeviceId: string;
  invitationSecretHash: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  failedAttempts: number;
  status: InvitationStatus;
}

/**
 * 配对申请（契约 §3.3 `ph_pairing_requests`）。
 * 这是 Android 提交、PC 本机批准的中间状态；此记录存在**不代表**已配对，
 * 也不代表已创建设备、已授予能力或已签发任何 grant（§6.2 第 4–8 步）。
 * 只保存公钥与最小元数据，不存私钥/密码/屏幕内容。
 */
export interface PairingRequestRecord {
  requestId: string;
  invitationId: string;
  /** 生成邀请的 PC Hub 设备 ID（批准权只属于该设备）。 */
  issuerDeviceId: string;
  /** 申请配对的 Android 设备 ID（首次运行时本机生成）。 */
  deviceId: string;
  deviceType: DeviceType;
  displayName: string;
  /** base64 编码的 32 字节 Ed25519 原始公钥（仅公钥）。 */
  identityPublicKey: string;
  identityFingerprint: string;
  status: PairingRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  /** 批准/拒绝的 PC 设备 ID（必须等于 issuerDeviceId）。 */
  decidedBy: string | null;
}

/**
 * 最小会话元数据。
 * 注意：云端绝不保存 LocalAuthGrant 正文（grant_id / local_signature /
 * session_nonce 的授权语义 / 权限授予凭证）。grantedScopes 仅记录端侧上报的
 * 结果码，不构成任何可复用授权，也不参与任何授权判定。
 */
export interface RemoteSessionRecord {
  sessionId: string;
  controllerDeviceId: string;
  targetDeviceId: string;
  requestedScopes: string[];
  grantedScopes: string[];
  sessionNonce: string;
  createdAt: string;
  expiresAt: string;
  status: SessionStatus;
}

/** 设备在线状态。 */
export interface PresenceRecord {
  deviceId: string;
  status: PresenceStatus;
  connectedAt: string;
  lastSeenAt: string;
}

/** 撤销记录，可审计（§12）。 */
export interface RevocationRecord {
  deviceId: string;
  reason: string;
  revokedAt: string;
}

/**
 * 审计元数据事件。
 * metadata 只允许原始类型元数据（结果码、路径类型、计数、耗时），
 * 严禁写入系统密码、私钥、完整 token、LocalAuthGrant 或屏幕/文件正文。
 */
export interface AuditEvent {
  eventType: string;
  /** 脱敏后的设备 ID（截断或哈希）。 */
  deviceId: string;
  resultCode: string;
  pathType?: 'LAN' | 'P2P' | 'TURN' | 'UNKNOWN';
  timestamp: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/** 转发用的签名信令信封：payload 为不透明密文，网关不解析、不解密。 */
export interface SignedSignalEnvelope {
  type: 'offer' | 'answer' | 'ice-candidate';
  sessionId: string;
  fromDeviceId: string;
  toDeviceId: string;
  /** DTLS 证书指纹（由端侧签名绑定，网关只透传校验值）。 */
  dtlsFingerprint: string;
  /** base64 不透明密文（SDP/ICE 端到端加密后的字节）。 */
  ciphertext: string;
  /** SHA-256(ciphertext bytes) 十六进制，用于密文完整性绑定。 */
  ciphertextHash: string;
  expiresAt: string;
  timestamp: string;
  nonce: string;
  signature: string;
}
