// Personal Hub 本地安全事件（基线 §11.1 AuditLogger 的移动端子集）。
//
// 只记录「事件类型 / 时间 / 结果 / 稳定原因码」，**不记录**：公钥正文、指纹、
// invitation secret、签名、payload、设备名或其他可能被拼进日志的敏感内容。
// 原因码经过白名单清洗，调用方即使误传长文本也只会落一个安全占位符。
//
// 存储：应用私有目录 `document/hub/audit-v1.json`，最多保留 200 条。
// 写失败不影响配对主流程（审计是旁路），但调用方仍可 await 以读取最新列表。
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { decodeUTF8, encodeUTF8 } from "tweetnacl-util";

export type HubAuditType =
  | "pairing_scan"
  | "identity_created"
  | "pairing_request"
  | "pairing_status";

export type HubAuditResult = "ok" | "rejected" | "error" | "cancelled" | "approved" | "expired";

export interface HubAuditEventInput {
  type: HubAuditType;
  result: HubAuditResult;
  /** 稳定原因码（如 QR_SIGNATURE_INVALID）；不得放任何密钥/载荷正文。 */
  reason?: string;
}

export interface HubAuditEvent extends HubAuditEventInput {
  /** UTC ISO-8601 */
  at: string;
}

const MAX_EVENTS = 200;
const RECORD_VERSION = 1;
const REASON_PATTERN = /^[A-Z0-9_]{1,64}$/;

function auditFile(): File {
  const directory = new Directory(Paths.document, "hub");
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  return new File(directory, "audit-v1.json");
}

function sanitizeReason(reason: string | undefined): string | undefined {
  if (typeof reason !== "string") return undefined;
  const normalized = reason.toUpperCase();
  return REASON_PATTERN.test(normalized) ? normalized : "REDACTED";
}

async function readEvents(file: File): Promise<HubAuditEvent[]> {
  if (!file.exists) return [];
  let handle: ReturnType<File["open"]> | null = null;
  try {
    handle = file.open(FileMode.ReadOnly);
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 256 * 1024) {
      const chunk = await handle.readBytes(16 * 1024);
      if (chunk.length === 0) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    if (chunks.length === 0) return [];
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = JSON.parse(encodeUTF8(merged)) as {
      version?: number;
      events?: unknown;
    };
    if (parsed.version !== RECORD_VERSION || !Array.isArray(parsed.events)) return [];
    return parsed.events.filter((event): event is HubAuditEvent => {
      if (typeof event !== "object" || event === null) return false;
      const record = event as Record<string, unknown>;
      return (
        typeof record.at === "string" &&
        typeof record.type === "string" &&
        typeof record.result === "string"
      );
    });
  } catch {
    // 审计文件损坏时按空历史处理，下一次写入会重建；不阻塞安全流程。
    return [];
  } finally {
    try {
      handle?.close();
    } catch {
      // 句柄可能已关闭
    }
  }
}

async function writeEvents(file: File, events: HubAuditEvent[]): Promise<void> {
  if (!file.exists) file.create({ intermediates: true });
  const payload = decodeUTF8(JSON.stringify({ version: RECORD_VERSION, events }));
  const handle = file.open(FileMode.WriteOnly);
  try {
    await handle.writeBytes(payload);
  } finally {
    handle.close();
  }
}

let queue: Promise<void> = Promise.resolve();

async function append(event: HubAuditEventInput): Promise<void> {
  const file = auditFile();
  const events = await readEvents(file);
  const reason = sanitizeReason(event.reason);
  const next: HubAuditEvent = {
    type: event.type,
    result: event.result,
    ...(reason ? { reason } : {}),
    at: new Date().toISOString(),
  };
  const trimmed = [...events, next].slice(-MAX_EVENTS);
  await writeEvents(file, trimmed);
}

/** 串行写入，避免并发读改写丢事件；任何失败都吞掉（审计旁路不得阻断配对）。 */
export function recordHubAudit(event: HubAuditEventInput): Promise<void> {
  queue = queue.then(() => append(event)).catch(() => undefined);
  return queue;
}

export async function listHubAudit(): Promise<HubAuditEvent[]> {
  await queue;
  return readEvents(auditFile());
}
