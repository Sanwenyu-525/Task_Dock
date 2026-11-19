/** RevocationRegistry（§11.3）：publishRevocation + 撤销状态查询，供离线设备重连先同步（§6.3）。 */
import type { RevokeDevice } from '../schema/validation.js';
import type { Stores } from '../store/interfaces.js';
import type { RevocationRecord } from '../types.js';
import { appendAudit, auditEvent } from './audit.js';
import { DeviceRegistry } from './DeviceRegistry.js';

export interface PublishedRevocation {
  deviceId: string;
  revokedAt: string;
}

export class RevocationRegistry {
  constructor(
    private readonly stores: Stores,
    private readonly devices: DeviceRegistry,
  ) {}

  async publishRevocation(input: RevokeDevice): Promise<PublishedRevocation> {
    await this.devices.verifyRequestSignature(
      input.deviceId,
      input as unknown as Record<string, unknown>,
      input.signature,
      input.timestamp,
    );
    const revokedAt = new Date().toISOString();
    await this.devices.revokeDevice(input.deviceId, input.reason);
    await this.stores.revocations.create({
      deviceId: input.deviceId,
      reason: input.reason,
      revokedAt,
    });
    await appendAudit(
      this.stores.audit,
      auditEvent('REVOCATION_PUBLISHED', input.deviceId, 'OK'),
    );
    return { deviceId: input.deviceId, revokedAt };
  }

  async isRevoked(deviceId: string): Promise<boolean> {
    const device = await this.stores.devices.get(deviceId);
    return Boolean(device?.revokedAt);
  }

  async listRevocations(since?: string): Promise<RevocationRecord[]> {
    return this.stores.revocations.list(since);
  }
}
