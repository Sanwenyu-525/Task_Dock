// 生活实体同步落库与载荷生成。由 db/sync.ts 统一编排，不单独发起网络请求。
//
// 实体：life_item / life_event / life_event_item / life_document_link。
// 规则与任务/笔记/收集箱一致：pull 只写业务表；本地有 outbox 时跳过；
// 墓碑按版本比较，旧墓碑不得回退较新记录；push 载荷用 camelCase（线上协议）。
import type { SQLiteDatabase } from "expo-sqlite";

import type { Change, SyncEntity, SyncPatch } from "../lib/sync/protocol";
import { buildPatchPayload } from "../lib/sync/protocol";

import { getDatabase } from "./database";

export type LifeEntity = Extract<
  SyncEntity,
  "life_item" | "life_event" | "life_event_item" | "life_document_link"
>;

export function isLifeEntity(value: string): value is LifeEntity {
  return (
    value === "life_item" ||
    value === "life_event" ||
    value === "life_event_item" ||
    value === "life_document_link"
  );
}

const LOCK_SQL = `SELECT COUNT(*) AS n FROM outbox WHERE entity = ? AND target_id = ?`;

async function hasPendingOutbox(
  db: SQLiteDatabase,
  entity: LifeEntity,
  id: string,
): Promise<boolean> {
  const row = await db.getFirstAsync<{ n: number }>(LOCK_SQL, [entity, id]);
  return (row?.n ?? 0) > 0;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function parseAliases(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export type LifeApplyOutcome = "applied" | "deleted" | "skipped";

async function applyLifeItem(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_item", change.id)) return "skipped";
  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM life_items WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return "skipped";
    if (change.rev <= existing.server_rev) return "skipped";
    const now = Date.now();
    await db.runAsync(
      `UPDATE life_items SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = ?
        WHERE id = ?`,
      [now, now, change.rev, change.id],
    );
    return "deleted";
  }

  if (existing && change.rev <= existing.server_rev) return "skipped";

  const name = asString(change.fields.name).trim();
  const normalized = asString(change.fields.normalizedName).trim();
  if (!name || !normalized) return "skipped";

  // 同一 normalized_name 在桌面端唯一；若本地已有另一条同归一名的活动记录，
  // 不覆盖、不合并，跳过本条，避免破坏本地用户数据或触发唯一索引失败。
  const clash = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM life_items
      WHERE normalized_name = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`,
    [normalized, change.id],
  );
  if (clash) return "skipped";

  const category = asString(change.fields.category);
  const aliases = JSON.stringify(parseAliases(change.fields.aliases));
  const note = asString(change.fields.note);
  const createdAt = asNumber(change.fields.createdAt, Date.now());
  const updatedAt = asNumber(change.fields.updatedAt, createdAt);

  if (existing) {
    await db.runAsync(
      `UPDATE life_items SET name = ?, normalized_name = ?, category = ?, aliases = ?, note = ?,
                            created_at = ?, updated_at = ?, deleted_at = NULL,
                            rev = rev + 1, server_rev = ?
        WHERE id = ?`,
      [name, normalized, category, aliases, note, createdAt, updatedAt, change.rev, change.id],
    );
  } else {
    await db.runAsync(
      `INSERT INTO life_items (id, name, normalized_name, category, aliases, note,
                               created_at, updated_at, deleted_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
      [change.id, name, normalized, category, aliases, note, createdAt, updatedAt, change.rev],
    );
  }
  return "applied";
}

async function applyLifeEvent(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_event", change.id)) return "skipped";
  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM life_events WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return "skipped";
    if (change.rev <= existing.server_rev) return "skipped";
    const now = Date.now();
    await db.runAsync(
      `UPDATE life_events SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = ?
        WHERE id = ?`,
      [now, now, change.rev, change.id],
    );
    return "deleted";
  }

  if (existing && change.rev <= existing.server_rev) return "skipped";

  const eventType = asString(change.fields.eventType, "purchase");
  if (!["purchase", "maintenance", "general"].includes(eventType)) return "skipped";
  const occurredAt = asNullableNumber(change.fields.occurredAt);
  if (occurredAt === null) return "skipped";

  const title = asString(change.fields.title);
  const description = asString(change.fields.description);
  const merchant = asString(change.fields.merchant);
  const source = asString(change.fields.source, "manual") === "capture" ? "capture" : "manual";
  const createdAt = asNumber(change.fields.createdAt, occurredAt);
  const updatedAt = asNumber(change.fields.updatedAt, createdAt);

  if (existing) {
    await db.runAsync(
      `UPDATE life_events SET event_type = ?, title = ?, description = ?, occurred_at = ?,
                             merchant = ?, source = ?, created_at = ?, updated_at = ?,
                             deleted_at = NULL, rev = rev + 1, server_rev = ?
        WHERE id = ?`,
      [
        eventType,
        title,
        description,
        occurredAt,
        merchant,
        source,
        createdAt,
        updatedAt,
        change.rev,
        change.id,
      ],
    );
  } else {
    await db.runAsync(
      `INSERT INTO life_events (id, event_type, title, description, occurred_at, merchant,
                                source, created_at, updated_at, deleted_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
      [
        change.id,
        eventType,
        title,
        description,
        occurredAt,
        merchant,
        source,
        createdAt,
        updatedAt,
        change.rev,
      ],
    );
  }
  return "applied";
}

async function applyLifeEventItem(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_event_item", change.id)) return "skipped";
  const existing = await db.getFirstAsync<{ server_rev: number }>(
    "SELECT server_rev FROM life_event_items WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return "skipped";
    if (change.rev <= existing.server_rev) return "skipped";
    await db.runAsync("DELETE FROM life_event_items WHERE id = ?", [change.id]);
    return "deleted";
  }

  if (existing && change.rev <= existing.server_rev) return "skipped";

  const eventId = asString(change.fields.eventId);
  const itemName = asString(change.fields.itemNameSnapshot);
  if (!eventId || !itemName) return "skipped";

  // 外键顺序：事件必须先存在且未删除。晚到/乱序时跳过，下一次游标重放会再给。
  const event = await db.getFirstAsync<{ deleted_at: number | null }>(
    "SELECT deleted_at FROM life_events WHERE id = ?",
    [eventId],
  );
  if (!event || event.deleted_at != null) return "skipped";

  let itemId = asNullableString(change.fields.itemId);
  if (itemId) {
    const item = await db.getFirstAsync<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM life_items WHERE id = ?",
      [itemId],
    );
    if (!item || item.deleted_at != null) itemId = null;
  }

  const quantityValue = asNullableString(change.fields.quantityValue);
  const quantityUnit = asString(change.fields.quantityUnit);
  const unitPriceMinor = asNullableNumber(change.fields.unitPriceMinor);
  const totalPriceMinor = asNullableNumber(change.fields.totalPriceMinor);
  const currency = asString(change.fields.currency).toUpperCase();
  const note = asString(change.fields.note);
  const createdAt = asNumber(change.fields.createdAt, Date.now());
  const updatedAt = asNumber(change.fields.updatedAt, createdAt);

  if (existing) {
    await db.runAsync(
      `UPDATE life_event_items SET event_id = ?, item_id = ?, item_name_snapshot = ?,
                                  quantity_value = ?, quantity_unit = ?, unit_price_minor = ?,
                                  total_price_minor = ?, currency = ?, note = ?, created_at = ?,
                                  updated_at = ?, rev = rev + 1, server_rev = ?
        WHERE id = ?`,
      [
        eventId,
        itemId,
        itemName,
        quantityValue,
        quantityUnit,
        unitPriceMinor,
        totalPriceMinor,
        currency,
        note,
        createdAt,
        updatedAt,
        change.rev,
        change.id,
      ],
    );
  } else {
    await db.runAsync(
      `INSERT INTO life_event_items (id, event_id, item_id, item_name_snapshot, quantity_value,
                                     quantity_unit, unit_price_minor, total_price_minor, currency,
                                     note, created_at, updated_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        change.id,
        eventId,
        itemId,
        itemName,
        quantityValue,
        quantityUnit,
        unitPriceMinor,
        totalPriceMinor,
        currency,
        note,
        createdAt,
        updatedAt,
        change.rev,
      ],
    );
  }
  return "applied";
}

async function ownerActive(
  db: SQLiteDatabase,
  ownerType: string,
  ownerId: string,
): Promise<boolean> {
  if (ownerType === "event") {
    const row = await db.getFirstAsync<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM life_events WHERE id = ?",
      [ownerId],
    );
    return Boolean(row && row.deleted_at == null);
  }
  if (ownerType === "item") {
    const row = await db.getFirstAsync<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM life_items WHERE id = ?",
      [ownerId],
    );
    return Boolean(row && row.deleted_at == null);
  }
  return false;
}

async function applyLifeDocumentLink(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_document_link", change.id)) return "skipped";
  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM life_document_links WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return "skipped";
    if (change.rev <= existing.server_rev) return "skipped";
    const now = Date.now();
    await db.runAsync(
      `UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1,
                                     server_rev = ?
        WHERE id = ?`,
      [now, now, change.rev, change.id],
    );
    return "deleted";
  }

  if (existing && change.rev <= existing.server_rev) return "skipped";

  const ownerType = asString(change.fields.ownerType);
  const ownerId = asString(change.fields.ownerId);
  const documentRef = asString(change.fields.documentRef);
  const documentSource = asString(change.fields.documentSource);
  if (!["event", "item"].includes(ownerType)) return "skipped";
  if (!ownerId || !documentRef) return "skipped";
  if (!["capture_asset", "shelf_item", "attachment", "file"].includes(documentSource)) {
    return "skipped";
  }
  // 关联不得悬空：owner 不存在或已删除时跳过本条，不落半条关联。
  if (!(await ownerActive(db, ownerType, ownerId))) return "skipped";

  const documentName = asString(change.fields.documentName);
  const mime = asString(change.fields.mime);
  const byteSize = asNullableNumber(change.fields.byteSize);
  const remoteRef = asNullableString(change.fields.remoteRef);
  const remoteSourceRaw = asString(change.fields.remoteSource);
  const remoteSource =
    remoteSourceRaw && ["shelf_item", "file"].includes(remoteSourceRaw)
      ? (remoteSourceRaw as "shelf_item" | "file")
      : null;
  const transferStateRaw = asString(change.fields.transferState, "local");
  const transferState = ["local", "metadata_only", "transferred", "missing"].includes(
    transferStateRaw,
  )
    ? (transferStateRaw as "local" | "metadata_only" | "transferred" | "missing")
    : "metadata_only";
  const createdAt = asNumber(change.fields.createdAt, Date.now());
  const updatedAt = asNumber(change.fields.updatedAt, createdAt);

  // 同一 owner 下同一文件不得重复：桌面端有唯一索引；本地已有等价活动行时跳过。
  const duplicate = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM life_document_links
      WHERE deleted_at IS NULL AND owner_type = ? AND owner_id = ?
        AND document_ref = ? AND document_source = ? AND id <> ? LIMIT 1`,
    [ownerType, ownerId, documentRef, documentSource, change.id],
  );
  if (duplicate) return "skipped";

  if (existing) {
    await db.runAsync(
      `UPDATE life_document_links SET owner_type = ?, owner_id = ?, document_ref = ?,
                                      document_source = ?, document_name = ?, mime = ?,
                                      byte_size = ?, remote_ref = ?, remote_source = ?,
                                      transfer_state = ?, created_at = ?,
                                      updated_at = ?, deleted_at = NULL, rev = rev + 1,
                                      server_rev = ?
        WHERE id = ?`,
      [
        ownerType,
        ownerId,
        documentRef,
        documentSource,
        documentName,
        mime,
        byteSize,
        remoteRef,
        remoteSource,
        transferState,
        createdAt,
        updatedAt,
        change.rev,
        change.id,
      ],
    );
  } else {
    await db.runAsync(
      `INSERT INTO life_document_links (id, owner_type, owner_id, document_ref, document_source,
                                        document_name, mime, byte_size, remote_ref, remote_source,
                                        transfer_state, created_at, updated_at, deleted_at, rev,
                                        server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
      [
        change.id,
        ownerType,
        ownerId,
        documentRef,
        documentSource,
        documentName,
        mime,
        byteSize,
        remoteRef,
        remoteSource,
        transferState,
        createdAt,
        updatedAt,
        change.rev,
      ],
    );
  }
  return "applied";
}

export async function applyLifeChange(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  switch (change.entity) {
    case "life_item":
      return applyLifeItem(db, change);
    case "life_event":
      return applyLifeEvent(db, change);
    case "life_event_item":
      return applyLifeEventItem(db, change);
    case "life_document_link":
      return applyLifeDocumentLink(db, change);
    default:
      return "skipped";
  }
}

/** 从本地行构造线上补丁（camelCase）；行不存在或已删除时返回 null。 */
export async function buildLifePatch(
  db: SQLiteDatabase,
  entity: LifeEntity,
  id: string,
): Promise<SyncPatch | null> {
  switch (entity) {
    case "life_item": {
      const row = await db.getFirstAsync<{
        name: string;
        normalized_name: string;
        category: string;
        aliases: string;
        note: string;
        created_at: number;
        updated_at: number;
        deleted_at: number | null;
      }>("SELECT * FROM life_items WHERE id = ?", [id]);
      if (!row || row.deleted_at != null) return null;
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(row.aliases) as unknown;
        aliases = parseAliases(parsed);
      } catch {
        aliases = [];
      }
      return buildPatchPayload({
        name: row.name,
        normalizedName: row.normalized_name,
        category: row.category,
        aliases,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    case "life_event": {
      const row = await db.getFirstAsync<{
        event_type: string;
        title: string;
        description: string;
        occurred_at: number;
        merchant: string;
        source: string;
        created_at: number;
        updated_at: number;
        deleted_at: number | null;
      }>("SELECT * FROM life_events WHERE id = ?", [id]);
      if (!row || row.deleted_at != null) return null;
      return buildPatchPayload({
        eventType: row.event_type,
        title: row.title,
        description: row.description,
        occurredAt: row.occurred_at,
        merchant: row.merchant,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    case "life_event_item": {
      const row = await db.getFirstAsync<{
        event_id: string;
        item_id: string | null;
        item_name_snapshot: string;
        quantity_value: string | null;
        quantity_unit: string;
        unit_price_minor: number | null;
        total_price_minor: number | null;
        currency: string;
        note: string;
        created_at: number;
        updated_at: number;
      }>("SELECT * FROM life_event_items WHERE id = ?", [id]);
      if (!row) return null;
      return buildPatchPayload({
        eventId: row.event_id,
        itemId: row.item_id,
        itemNameSnapshot: row.item_name_snapshot,
        quantityValue: row.quantity_value,
        quantityUnit: row.quantity_unit,
        unitPriceMinor: row.unit_price_minor,
        totalPriceMinor: row.total_price_minor,
        currency: row.currency,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    case "life_document_link": {
      const row = await db.getFirstAsync<{
        owner_type: string;
        owner_id: string;
        document_ref: string;
        document_source: string;
        document_name: string;
        mime: string;
        byte_size: number | null;
        remote_ref: string | null;
        remote_source: string | null;
        transfer_state: string;
        created_at: number;
        updated_at: number;
        deleted_at: number | null;
      }>("SELECT * FROM life_document_links WHERE id = ?", [id]);
      if (!row || row.deleted_at != null) return null;
      return buildPatchPayload({
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        documentRef: row.document_ref,
        documentSource: row.document_source,
        documentName: row.document_name,
        mime: row.mime,
        byteSize: row.byte_size,
        remoteRef: row.remote_ref,
        remoteSource: row.remote_source,
        transferState: row.transfer_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    default:
      return null;
  }
}

export async function countPendingLifeOps(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox
      WHERE entity IN ('life_item','life_event','life_event_item','life_document_link')
        AND state IN ('pending','failed')`,
  );
  return row?.n ?? 0;
}

/** 解除配对时清零生活实体服务端版本，避免换机后 seq 不可比。 */
export async function resetLifeSyncState(db: SQLiteDatabase): Promise<void> {
  await db.runAsync("UPDATE life_items SET server_rev = 0 WHERE server_rev <> 0");
  await db.runAsync("UPDATE life_events SET server_rev = 0 WHERE server_rev <> 0");
  await db.runAsync("UPDATE life_event_items SET server_rev = 0 WHERE server_rev <> 0");
  await db.runAsync("UPDATE life_document_links SET server_rev = 0 WHERE server_rev <> 0");
  await db.runAsync(
    `UPDATE outbox SET base_rev = 0
      WHERE entity IN ('life_item','life_event','life_event_item','life_document_link')
        AND base_rev <> 0`,
  );
}

/** 桌面端没有该记录时，「采用桌面端」= 删除本地副本（事件/关联为软删，明细硬删）。 */
export async function softDeleteLifeLocalCopy(entity: LifeEntity, id: string): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  switch (entity) {
    case "life_item":
      await db.runAsync(
        `UPDATE life_items SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = 0
          WHERE id = ?`,
        [now, now, id],
      );
      break;
    case "life_event":
      await db.runAsync(
        `UPDATE life_events SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = 0
          WHERE id = ?`,
        [now, now, id],
      );
      break;
    case "life_event_item":
      await db.runAsync("DELETE FROM life_event_items WHERE id = ?", [id]);
      break;
    case "life_document_link":
      await db.runAsync(
        `UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1,
                                       server_rev = 0
          WHERE id = ?`,
        [now, now, id],
      );
      break;
    default:
      break;
  }
}

export async function isLifeLocalDeleted(entity: LifeEntity, id: string): Promise<boolean> {
  const db = getDatabase();
  if (entity === "life_event_item") {
    const row = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM life_event_items WHERE id = ?",
      [id],
    );
    return !row;
  }
  const table =
    entity === "life_item"
      ? "life_items"
      : entity === "life_event"
        ? "life_events"
        : "life_document_links";
  const row = await db.getFirstAsync<{ deleted_at: number | null }>(
    `SELECT deleted_at FROM ${table} WHERE id = ?`,
    [id],
  );
  return !row || row.deleted_at != null;
}

/** 冲突「保留本机」：先把 server_rev 对齐到冲突里的服务端版本，再重新入队。 */
export async function prepareLifeLocalResolution(
  db: SQLiteDatabase,
  entity: LifeEntity,
  id: string,
  baseRev: number,
): Promise<void> {
  if (entity === "life_event_item") {
    await db.runAsync("UPDATE life_event_items SET server_rev = ? WHERE id = ?", [baseRev, id]);
    return;
  }
  const table =
    entity === "life_item"
      ? "life_items"
      : entity === "life_event"
        ? "life_events"
        : "life_document_links";
  await db.runAsync(`UPDATE ${table} SET server_rev = ? WHERE id = ?`, [baseRev, id]);
}
