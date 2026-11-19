/**
 * PostgreSQL 仓储实现（生产）。字段与 schema/sql/001_init.sql、
 * schema/sql/002_pairing_requests.sql 一致。
 * 仅保存公钥、最小元数据、邀请哈希、配对申请状态、撤销记录与审计元数据；
 * 无私钥列、无密码列、无 LocalAuthGrant 列、无媒体/文件正文列。
 */
import type { Pool } from 'pg';
import type {
  AuditEvent,
  DeviceRecord,
  PairingInvitationRecord,
  PairingRequestRecord,
  PresenceRecord,
  RemoteSessionRecord,
  RevocationRecord,
} from '../../types.js';
import type {
  AuditStore,
  DeviceStore,
  InvitationStore,
  PairingRequestRepo,
  PresenceStore,
  RevocationStore,
  SessionStore,
  Stores,
} from '../interfaces.js';

type Row = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown): string | null =>
  value == null ? null : iso(value);

const toDevice = (r: Row): DeviceRecord => ({
  deviceId: String(r.device_id),
  deviceType: r.device_type as DeviceRecord['deviceType'],
  displayName: String(r.display_name),
  identityPublicKey: String(r.identity_public_key),
  identityFingerprint: String(r.identity_fingerprint),
  createdAt: iso(r.created_at),
  lastSeenAt: iso(r.last_seen_at),
  revokedAt: nullableIso(r.revoked_at),
});

const toInvitation = (r: Row): PairingInvitationRecord => ({
  invitationId: String(r.invitation_id),
  issuerDeviceId: String(r.issuer_device_id),
  invitationSecretHash: String(r.invitation_secret_hash),
  nonce: String(r.nonce),
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  consumedAt: nullableIso(r.consumed_at),
  failedAttempts: Number(r.failed_attempts),
  status: r.status as PairingInvitationRecord['status'],
});

const toPairingRequest = (r: Row): PairingRequestRecord => ({
  requestId: String(r.request_id),
  invitationId: String(r.invitation_id),
  issuerDeviceId: String(r.issuer_device_id),
  deviceId: String(r.device_id),
  deviceType: r.device_type as PairingRequestRecord['deviceType'],
  displayName: String(r.display_name),
  identityPublicKey: String(r.identity_public_key),
  identityFingerprint: String(r.identity_fingerprint),
  status: r.status as PairingRequestRecord['status'],
  requestedAt: iso(r.requested_at),
  decidedAt: nullableIso(r.decided_at),
  decidedBy: r.decided_by == null ? null : String(r.decided_by),
});

const toSession = (r: Row): RemoteSessionRecord => ({
  sessionId: String(r.session_id),
  controllerDeviceId: String(r.controller_device_id),
  targetDeviceId: String(r.target_device_id),
  requestedScopes: (r.requested_scopes as string[]) ?? [],
  grantedScopes: (r.granted_scopes as string[]) ?? [],
  sessionNonce: String(r.session_nonce),
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  status: r.status as RemoteSessionRecord['status'],
});

const toPresence = (r: Row): PresenceRecord => ({
  deviceId: String(r.device_id),
  status: r.status as PresenceRecord['status'],
  connectedAt: iso(r.connected_at),
  lastSeenAt: iso(r.last_seen_at),
});

const toRevocation = (r: Row): RevocationRecord => ({
  deviceId: String(r.device_id),
  reason: String(r.reason),
  revokedAt: iso(r.revoked_at),
});

const toAudit = (r: Row): AuditEvent => ({
  eventType: String(r.event_type),
  deviceId: String(r.device_id),
  resultCode: String(r.result_code),
  ...(r.path_type != null ? { pathType: r.path_type as AuditEvent['pathType'] } : {}),
  timestamp: iso(r.occurred_at),
  ...(r.metadata != null
    ? { metadata: r.metadata as AuditEvent['metadata'] }
    : {}),
});

export class PostgresDeviceStore implements DeviceStore {
  constructor(private readonly pool: Pool) {}
  async create(device: DeviceRecord): Promise<DeviceRecord> {
    await this.pool.query(
      `INSERT INTO devices (device_id, device_type, display_name, identity_public_key,
        identity_fingerprint, created_at, last_seen_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        device.deviceId,
        device.deviceType,
        device.displayName,
        device.identityPublicKey,
        device.identityFingerprint,
        device.createdAt,
        device.lastSeenAt,
        device.revokedAt,
      ],
    );
    return device;
  }
  async get(deviceId: string): Promise<DeviceRecord | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM devices WHERE device_id = $1',
      [deviceId],
    );
    return rows[0] ? toDevice(rows[0]) : null;
  }
  async touch(deviceId: string, at: string): Promise<void> {
    await this.pool.query(
      'UPDATE devices SET last_seen_at = $2 WHERE device_id = $1',
      [deviceId, at],
    );
  }
  async revoke(deviceId: string, at: string): Promise<DeviceRecord | null> {
    const { rows } = await this.pool.query<Row>(
      'UPDATE devices SET revoked_at = $2 WHERE device_id = $1 AND revoked_at IS NULL RETURNING *',
      [deviceId, at],
    );
    return rows[0] ? toDevice(rows[0]) : null;
  }
  async list(): Promise<DeviceRecord[]> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM devices');
    return rows.map(toDevice);
  }
}

export class PostgresInvitationStore implements InvitationStore {
  constructor(private readonly pool: Pool) {}
  async create(inv: PairingInvitationRecord): Promise<PairingInvitationRecord> {
    await this.pool.query(
      `INSERT INTO pairing_invitations (invitation_id, issuer_device_id,
        invitation_secret_hash, nonce, created_at, expires_at, consumed_at,
        failed_attempts, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        inv.invitationId,
        inv.issuerDeviceId,
        inv.invitationSecretHash,
        inv.nonce,
        inv.createdAt,
        inv.expiresAt,
        inv.consumedAt,
        inv.failedAttempts,
        inv.status,
      ],
    );
    return inv;
  }
  async get(id: string): Promise<PairingInvitationRecord | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM pairing_invitations WHERE invitation_id = $1',
      [id],
    );
    return rows[0] ? toInvitation(rows[0]) : null;
  }
  async update(inv: PairingInvitationRecord): Promise<void> {
    await this.pool.query(
      `UPDATE pairing_invitations SET consumed_at=$2, failed_attempts=$3, status=$4
       WHERE invitation_id=$1`,
      [inv.invitationId, inv.consumedAt, inv.failedAttempts, inv.status],
    );
  }
}

export class PostgresPairingRequestStore implements PairingRequestRepo {
  constructor(private readonly pool: Pool) {}
  async create(request: PairingRequestRecord): Promise<PairingRequestRecord> {
    await this.pool.query(
      `INSERT INTO ph_pairing_requests (request_id, invitation_id, issuer_device_id,
        device_id, device_type, display_name, identity_public_key,
        identity_fingerprint, status, requested_at, decided_at, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        request.requestId,
        request.invitationId,
        request.issuerDeviceId,
        request.deviceId,
        request.deviceType,
        request.displayName,
        request.identityPublicKey,
        request.identityFingerprint,
        request.status,
        request.requestedAt,
        request.decidedAt,
        request.decidedBy,
      ],
    );
    return request;
  }
  async get(requestId: string): Promise<PairingRequestRecord | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM ph_pairing_requests WHERE request_id = $1',
      [requestId],
    );
    return rows[0] ? toPairingRequest(rows[0]) : null;
  }
  async update(request: PairingRequestRecord): Promise<void> {
    await this.pool.query(
      `UPDATE ph_pairing_requests SET status=$2, decided_at=$3, decided_by=$4
       WHERE request_id=$1`,
      [request.requestId, request.status, request.decidedAt, request.decidedBy],
    );
  }
  async listByIssuer(issuerDeviceId: string): Promise<PairingRequestRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM ph_pairing_requests WHERE issuer_device_id = $1
       ORDER BY requested_at`,
      [issuerDeviceId],
    );
    return rows.map(toPairingRequest);
  }
  async findByDeviceAndInvitation(
    invitationId: string,
    deviceId: string,
  ): Promise<PairingRequestRecord | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM ph_pairing_requests
       WHERE invitation_id = $1 AND device_id = $2 AND status = 'awaiting_pc_approval'
       ORDER BY requested_at LIMIT 1`,
      [invitationId, deviceId],
    );
    return rows[0] ? toPairingRequest(rows[0]) : null;
  }
  async listAwaiting(): Promise<PairingRequestRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM ph_pairing_requests WHERE status = 'awaiting_pc_approval'
       ORDER BY requested_at`,
    );
    return rows.map(toPairingRequest);
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}
  async create(session: RemoteSessionRecord): Promise<RemoteSessionRecord> {
    await this.pool.query(
      `INSERT INTO remote_sessions (session_id, controller_device_id, target_device_id,
        requested_scopes, granted_scopes, session_nonce, created_at, expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (session_id) DO NOTHING`,
      [
        session.sessionId,
        session.controllerDeviceId,
        session.targetDeviceId,
        session.requestedScopes,
        session.grantedScopes,
        session.sessionNonce,
        session.createdAt,
        session.expiresAt,
        session.status,
      ],
    );
    return session;
  }
  async get(id: string): Promise<RemoteSessionRecord | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM remote_sessions WHERE session_id = $1',
      [id],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }
  async update(session: RemoteSessionRecord): Promise<void> {
    await this.pool.query(
      'UPDATE remote_sessions SET status=$2, granted_scopes=$3, expires_at=$4 WHERE session_id=$1',
      [session.sessionId, session.status, session.grantedScopes, session.expiresAt],
    );
  }
}

export class PostgresPresenceStore implements PresenceStore {
  constructor(private readonly pool: Pool) {}
  async upsert(presence: PresenceRecord): Promise<PresenceRecord> {
    await this.pool.query(
      `INSERT INTO presence (device_id, status, connected_at, last_seen_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (device_id) DO UPDATE SET status=EXCLUDED.status, last_seen_at=EXCLUDED.last_seen_at`,
      [presence.deviceId, presence.status, presence.connectedAt, presence.lastSeenAt],
    );
    return presence;
  }
  async get(deviceId: string): Promise<PresenceRecord | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM presence WHERE device_id = $1',
      [deviceId],
    );
    return rows[0] ? toPresence(rows[0]) : null;
  }
  async list(): Promise<PresenceRecord[]> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM presence');
    return rows.map(toPresence);
  }
}

export class PostgresRevocationStore implements RevocationStore {
  constructor(private readonly pool: Pool) {}
  async create(record: RevocationRecord): Promise<RevocationRecord> {
    await this.pool.query(
      `INSERT INTO revocations (device_id, reason, revoked_at) VALUES ($1,$2,$3)
       ON CONFLICT (device_id, revoked_at) DO NOTHING`,
      [record.deviceId, record.reason, record.revokedAt],
    );
    return record;
  }
  async list(since?: string): Promise<RevocationRecord[]> {
    const { rows } = since
      ? await this.pool.query<Row>(
          'SELECT * FROM revocations WHERE revoked_at > $1 ORDER BY revoked_at',
          [since],
        )
      : await this.pool.query<Row>(
          'SELECT * FROM revocations ORDER BY revoked_at',
        );
    return rows.map(toRevocation);
  }
}

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly pool: Pool) {}
  async append(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_metadata (event_type, device_id, result_code, path_type, occurred_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        event.eventType,
        event.deviceId,
        event.resultCode,
        event.pathType ?? null,
        event.timestamp,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
  }
  async list(): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM audit_metadata ORDER BY occurred_at',
    );
    return rows.map(toAudit);
  }
}

export function createPostgresStores(pool: Pool): Stores {
  return {
    devices: new PostgresDeviceStore(pool),
    invitations: new PostgresInvitationStore(pool),
    pairingRequests: new PostgresPairingRequestStore(pool),
    sessions: new PostgresSessionStore(pool),
    presence: new PostgresPresenceStore(pool),
    revocations: new PostgresRevocationStore(pool),
    audit: new PostgresAuditStore(pool),
  };
}
