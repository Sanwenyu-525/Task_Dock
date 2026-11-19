/** 内存仓储：用于单元测试与集成测试，接口与 PostgreSQL 实现完全一致。 */
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

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryDeviceStore implements DeviceStore {
  private readonly map = new Map<string, DeviceRecord>();
  async create(device: DeviceRecord): Promise<DeviceRecord> {
    if (this.map.has(device.deviceId)) {
      throw new Error('DEVICE_ALREADY_EXISTS');
    }
    this.map.set(device.deviceId, clone(device));
    return clone(device);
  }
  async get(deviceId: string): Promise<DeviceRecord | null> {
    const value = this.map.get(deviceId);
    return value ? clone(value) : null;
  }
  async touch(deviceId: string, at: string): Promise<void> {
    const value = this.map.get(deviceId);
    if (value) this.map.set(deviceId, { ...clone(value), lastSeenAt: at });
  }
  async revoke(deviceId: string, at: string): Promise<DeviceRecord | null> {
    const value = this.map.get(deviceId);
    if (!value) return null;
    const updated: DeviceRecord = { ...clone(value), revokedAt: at };
    this.map.set(deviceId, updated);
    return clone(updated);
  }
  async list(): Promise<DeviceRecord[]> {
    return Array.from(this.map.values()).map(clone);
  }
}

export class MemoryInvitationStore implements InvitationStore {
  private readonly map = new Map<string, PairingInvitationRecord>();
  async create(inv: PairingInvitationRecord): Promise<PairingInvitationRecord> {
    this.map.set(inv.invitationId, clone(inv));
    return clone(inv);
  }
  async get(id: string): Promise<PairingInvitationRecord | null> {
    const value = this.map.get(id);
    return value ? clone(value) : null;
  }
  async update(inv: PairingInvitationRecord): Promise<void> {
    this.map.set(inv.invitationId, clone(inv));
  }
}

export class MemoryPairingRequestStore implements PairingRequestRepo {
  private readonly map = new Map<string, PairingRequestRecord>();
  async create(request: PairingRequestRecord): Promise<PairingRequestRecord> {
    this.map.set(request.requestId, clone(request));
    return clone(request);
  }
  async get(requestId: string): Promise<PairingRequestRecord | null> {
    const value = this.map.get(requestId);
    return value ? clone(value) : null;
  }
  async update(request: PairingRequestRecord): Promise<void> {
    this.map.set(request.requestId, clone(request));
  }
  async listByIssuer(issuerDeviceId: string): Promise<PairingRequestRecord[]> {
    return Array.from(this.map.values())
      .filter((request) => request.issuerDeviceId === issuerDeviceId)
      .map(clone);
  }
  async findByDeviceAndInvitation(
    invitationId: string,
    deviceId: string,
  ): Promise<PairingRequestRecord | null> {
    const value = Array.from(this.map.values()).find(
      (request) =>
        request.invitationId === invitationId && request.deviceId === deviceId,
    );
    return value ? clone(value) : null;
  }
  async listAwaiting(): Promise<PairingRequestRecord[]> {
    return Array.from(this.map.values())
      .filter((request) => request.status === 'awaiting_pc_approval')
      .map(clone);
  }
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, RemoteSessionRecord>();
  async create(session: RemoteSessionRecord): Promise<RemoteSessionRecord> {
    this.map.set(session.sessionId, clone(session));
    return clone(session);
  }
  async get(id: string): Promise<RemoteSessionRecord | null> {
    const value = this.map.get(id);
    return value ? clone(value) : null;
  }
  async update(session: RemoteSessionRecord): Promise<void> {
    this.map.set(session.sessionId, clone(session));
  }
}

export class MemoryPresenceStore implements PresenceStore {
  private readonly map = new Map<string, PresenceRecord>();
  async upsert(presence: PresenceRecord): Promise<PresenceRecord> {
    this.map.set(presence.deviceId, clone(presence));
    return clone(presence);
  }
  async get(deviceId: string): Promise<PresenceRecord | null> {
    const value = this.map.get(deviceId);
    return value ? clone(value) : null;
  }
  async list(): Promise<PresenceRecord[]> {
    return Array.from(this.map.values()).map(clone);
  }
}

export class MemoryRevocationStore implements RevocationStore {
  private readonly rows: RevocationRecord[] = [];
  async create(record: RevocationRecord): Promise<RevocationRecord> {
    this.rows.push(clone(record));
    return clone(record);
  }
  async list(since?: string): Promise<RevocationRecord[]> {
    return this.rows
      .filter((row) => !since || row.revokedAt > since)
      .map(clone);
  }
}

export class MemoryAuditStore implements AuditStore {
  private readonly rows: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.rows.push(clone(event));
  }
  async list(): Promise<AuditEvent[]> {
    return this.rows.map(clone);
  }
}

export function createMemoryStores(): Stores {
  return {
    devices: new MemoryDeviceStore(),
    invitations: new MemoryInvitationStore(),
    pairingRequests: new MemoryPairingRequestStore(),
    sessions: new MemorySessionStore(),
    presence: new MemoryPresenceStore(),
    revocations: new MemoryRevocationStore(),
    audit: new MemoryAuditStore(),
  };
}
