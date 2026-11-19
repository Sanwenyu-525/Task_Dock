/** PresenceManager（§11.3）：updatePresence / getPresence，均签名校验并审计。 */
import type { ControlPlaneConfig } from '../config.js';
import type { PresenceQuery, PresenceUpdate } from '../schema/validation.js';
import type { Stores } from '../store/interfaces.js';
import type { PresenceRecord } from '../types.js';
import { appendAudit, auditEvent } from './audit.js';
import { DeviceRegistry } from './DeviceRegistry.js';
import { SecurityError } from './errors.js';

export class PresenceManager {
  constructor(
    private readonly stores: Stores,
    private readonly devices: DeviceRegistry,
    private readonly _config: ControlPlaneConfig,
  ) {}

  async updatePresence(input: PresenceUpdate): Promise<PresenceRecord> {
    await this.devices.verifyRequestSignature(
      input.deviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    const now = new Date().toISOString();
    const previous = await this.stores.presence.get(input.deviceId);
    const record = await this.stores.presence.upsert({
      deviceId: input.deviceId,
      status: input.status,
      connectedAt: previous?.connectedAt ?? now,
      lastSeenAt: now,
    });
    await appendAudit(
      this.stores.audit,
      auditEvent('PRESENCE_UPDATE', input.deviceId, 'OK', {
        status: input.status,
      }),
    );
    return record;
  }

  async getPresence(input: PresenceQuery): Promise<PresenceRecord | null> {
    await this.devices.verifyRequestSignature(
      input.deviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    const record = await this.stores.presence.get(input.deviceId);
    await appendAudit(
      this.stores.audit,
      auditEvent('PRESENCE_READ', input.deviceId, record ? 'OK' : 'NOT_FOUND'),
    );
    return record;
  }

  /** 内部：连接建立/断开时更新在线状态（不对外暴露无签名接口）。 */
  async setOnline(deviceId: string, online: boolean): Promise<void> {
    const now = new Date().toISOString();
    const previous = await this.stores.presence.get(deviceId);
    await this.stores.presence.upsert({
      deviceId,
      status: online ? 'online' : 'offline',
      connectedAt: previous?.connectedAt ?? now,
      lastSeenAt: now,
    });
  }
}
