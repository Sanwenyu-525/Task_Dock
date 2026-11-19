/** 仓储接口：核心类只依赖此抽象，PostgreSQL 与内存实现可互换（测试无需数据库）。 */
import type {
  AuditEvent,
  DeviceRecord,
  PairingInvitationRecord,
  PairingRequestRecord,
  PresenceRecord,
  RemoteSessionRecord,
  RevocationRecord,
} from '../types.js';

export interface DeviceStore {
  create(device: DeviceRecord): Promise<DeviceRecord>;
  get(deviceId: string): Promise<DeviceRecord | null>;
  touch(deviceId: string, at: string): Promise<void>;
  revoke(deviceId: string, at: string): Promise<DeviceRecord | null>;
  list(): Promise<DeviceRecord[]>;
}

export interface InvitationStore {
  create(invitation: PairingInvitationRecord): Promise<PairingInvitationRecord>;
  get(invitationId: string): Promise<PairingInvitationRecord | null>;
  update(invitation: PairingInvitationRecord): Promise<void>;
}

/**
 * 配对申请仓储（`ph_pairing_requests`）。命名避免与 gateway/PairingRequestStore
 * 业务类混淆：这里只做持久化，不做任何批准判定。
 */
export interface PairingRequestRepo {
  create(request: PairingRequestRecord): Promise<PairingRequestRecord>;
  get(requestId: string): Promise<PairingRequestRecord | null>;
  update(request: PairingRequestRecord): Promise<void>;
  /** 某台 Hub 发出的邀请对应的全部申请（由业务层过滤状态与过期）。 */
  listByIssuer(issuerDeviceId: string): Promise<PairingRequestRecord[]>;
  /** 某设备在某邀请下的申请（用于提交幂等）。 */
  findByDeviceAndInvitation(
    invitationId: string,
    deviceId: string,
  ): Promise<PairingRequestRecord | null>;
  /** 全部仍处于 awaiting 的申请（惰性过期扫描用）。 */
  listAwaiting(): Promise<PairingRequestRecord[]>;
}

export interface SessionStore {
  create(session: RemoteSessionRecord): Promise<RemoteSessionRecord>;
  get(sessionId: string): Promise<RemoteSessionRecord | null>;
  update(session: RemoteSessionRecord): Promise<void>;
}

export interface PresenceStore {
  upsert(presence: PresenceRecord): Promise<PresenceRecord>;
  get(deviceId: string): Promise<PresenceRecord | null>;
  list(): Promise<PresenceRecord[]>;
}

export interface RevocationStore {
  create(record: RevocationRecord): Promise<RevocationRecord>;
  list(since?: string): Promise<RevocationRecord[]>;
}

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
  list(): Promise<AuditEvent[]>;
}

/** 所有仓储的集合，便于注入。 */
export interface Stores {
  devices: DeviceStore;
  invitations: InvitationStore;
  pairingRequests: PairingRequestRepo;
  sessions: SessionStore;
  presence: PresenceStore;
  revocations: RevocationStore;
  audit: AuditStore;
}
