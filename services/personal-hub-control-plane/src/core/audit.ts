/** 审计辅助：设备 ID 脱敏，事件只含可复核元数据，禁止凭据/正文进入审计。 */
import { sha256Hex } from '../crypto/signatures.js';
import type { AuditEvent } from '../types.js';

export function redactDeviceId(deviceId: string): string {
  return `dev_${sha256Hex(deviceId).slice(0, 12)}`;
}

export function auditEvent(
  eventType: string,
  deviceId: string,
  resultCode: string,
  metadata?: AuditEvent['metadata'],
  pathType?: AuditEvent['pathType'],
): AuditEvent {
  return {
    eventType,
    deviceId: redactDeviceId(deviceId),
    resultCode,
    ...(pathType ? { pathType } : {}),
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

export function appendAudit(
  store: { append(event: AuditEvent): Promise<void> },
  event: AuditEvent,
): Promise<void> {
  return store.append(event);
}
