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

export type LifeDeferReason =
  | "pending_outbox"
  | "dependency"
  | "name_conflict"
  | "duplicate_link"
  | "invalid";

export type LifeApplyOutcome =
  | { status: "applied" }
  | { status: "deleted" }
  | { status: "stale" }
  | { status: "deferred"; reason: LifeDeferReason }
  | { status: "rejected"; message: string };

function applied(): LifeApplyOutcome {
  return { status: "applied" };
}

function deleted(): LifeApplyOutcome {
  return { status: "deleted" };
}

function stale(): LifeApplyOutcome {
  return { status: "stale" };
}

function deferred(reason: LifeDeferReason): LifeApplyOutcome {
  return { status: "deferred", reason };
}

function rejected(message: string): LifeApplyOutcome {
  return { status: "rejected", message };
}

async function purgeEventLocal(
  db: SQLiteDatabase,
  eventId: string,
  deletedAt: number,
): Promise<void> {
  // 桌面端删除事件时硬删明细并软删关联；本地采用同一语义，避免留下孤儿明细。
  await db.runAsync("DELETE FROM life_event_items WHERE event_id = ?", [eventId]);
  await db.runAsync(
    `UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1
      WHERE owner_type = 'event' AND owner_id = ? AND deleted_at IS NULL`,
    [deletedAt, deletedAt, eventId],
  );
}

async function applyLifeItem(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_item", change.id)) {
    return deferred("pending_outbox");
  }
  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM life_items WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return deleted();
    if (change.rev <= existing.server_rev) return stale();
    const now = Date.now();
    await db.runAsync(
      `UPDATE life_items SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = ?
        WHERE id = ?`,
      [now, now, change.rev, change.id],
    );
    return deleted();
  }

  if (existing && change.rev <= existing.server_rev) return stale();

  const name = asString(change.fields.name).trim();
  const normalized = asString(change.fields.normalizedName).trim();
  if (!name || !normalized) return rejected("商品名称或归一化名称为空");

  // 同一 normalized_name 在桌面端唯一；若本地已有另一条同归一名的活动记录，
  // 不覆盖、不合并，也不静默丢弃，而是持久化延后并交给用户做可恢复关联。
  const clash = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM life_items
      WHERE normalized_name = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`,
    [normalized, change.id],
  );
  if (clash) return deferred("name_conflict");

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
  return applied();
}

async function applyLifeEvent(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_event", change.id)) {
    return deferred("pending_outbox");
  }
  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM life_events WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return deleted();
    if (change.rev <= existing.server_rev) return stale();
    const now = Date.now();
    await purgeEventLocal(db, change.id, now);
    await db.runAsync(
      `UPDATE life_events SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = ?
        WHERE id = ?`,
      [now, now, change.rev, change.id],
    );
    return deleted();
  }

  if (existing && change.rev <= existing.server_rev) return stale();

  const eventType = asString(change.fields.eventType, "purchase");
  if (!["purchase", "maintenance", "general"].includes(eventType)) {
    return rejected(`不支持的事件类型：${eventType}`);
  }
  const occurredAt = asNullableNumber(change.fields.occurredAt);
  if (occurredAt === null) return rejected("实际发生时间缺失");

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
  return applied();
}

async function applyLifeEventItem(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_event_item", change.id)) {
    return deferred("pending_outbox");
  }
  const existing = await db.getFirstAsync<{ server_rev: number }>(
    "SELECT server_rev FROM life_event_items WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return deleted();
    if (change.rev <= existing.server_rev) return stale();
    await db.runAsync("DELETE FROM life_event_items WHERE id = ?", [change.id]);
    return deleted();
  }

  if (existing && change.rev <= existing.server_rev) return stale();

  const eventId = asString(change.fields.eventId);
  const itemName = asString(change.fields.itemNameSnapshot);
  if (!eventId || !itemName) return rejected("购买明细缺少事件或商品名称快照");

  // 外键顺序：事件必须先存在。晚到/乱序时持久化延后，依赖到达后重放，
  // 绝不随游标推进把明细永久丢掉。
  const event = await db.getFirstAsync<{ deleted_at: number | null }>(
    "SELECT deleted_at FROM life_events WHERE id = ?",
    [eventId],
  );
  if (!event) return deferred("dependency");
  if (event.deleted_at != null) return stale();

  let itemId = asNullableString(change.fields.itemId);
  if (itemId) {
    const item = await db.getFirstAsync<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM life_items WHERE id = ?",
      [itemId],
    );
    if (!item) return deferred("dependency");
    // 商品被用户显式删除时才断开关联；保留名称快照、日期与金额，购买历史不丢。
    if (item.deleted_at != null) itemId = null;
  }

  const quantityValue = asNullableString(change.fields.quantityValue);
  const quantityUnit = asString(change.fields.quantityUnit);
  const unitPriceMinor = asNullableNumber(change.fields.unitPriceMinor);
  const totalPriceMinor = asNullableNumber(change.fields.totalPriceMinor);
  const currency = asString(change.fields.currency).toUpperCase();
  const amountScale = asNullableNumber(change.fields.amountScale) ?? 2;
  const note = asString(change.fields.note);
  const createdAt = asNumber(change.fields.createdAt, Date.now());
  const updatedAt = asNumber(change.fields.updatedAt, createdAt);

  if (existing) {
    await db.runAsync(
      `UPDATE life_event_items SET event_id = ?, item_id = ?, item_name_snapshot = ?,
                                  quantity_value = ?, quantity_unit = ?, unit_price_minor = ?,
                                  total_price_minor = ?, currency = ?, amount_scale = ?, note = ?,
                                  created_at = ?, updated_at = ?, rev = rev + 1, server_rev = ?
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
        amountScale,
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
                                     amount_scale, note, created_at, updated_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
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
        amountScale,
        note,
        createdAt,
        updatedAt,
        change.rev,
      ],
    );
  }
  return applied();
}

async function ownerStatus(
  db: SQLiteDatabase,
  ownerType: string,
  ownerId: string,
): Promise<"active" | "missing" | "deleted"> {
  if (ownerType === "event") {
    const row = await db.getFirstAsync<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM life_events WHERE id = ?",
      [ownerId],
    );
    if (!row) return "missing";
    return row.deleted_at == null ? "active" : "deleted";
  }
  if (ownerType === "item") {
    const row = await db.getFirstAsync<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM life_items WHERE id = ?",
      [ownerId],
    );
    if (!row) return "missing";
    return row.deleted_at == null ? "active" : "deleted";
  }
  return "missing";
}

async function applyLifeDocumentLink(
  db: SQLiteDatabase,
  change: Change,
): Promise<LifeApplyOutcome> {
  if (await hasPendingOutbox(db, "life_document_link", change.id)) {
    return deferred("pending_outbox");
  }
  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM life_document_links WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return deleted();
    if (change.rev <= existing.server_rev) return stale();
    const now = Date.now();
    await db.runAsync(
      `UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1,
                                     server_rev = ?
        WHERE id = ?`,
      [now, now, change.rev, change.id],
    );
    return deleted();
  }

  if (existing && change.rev <= existing.server_rev) return stale();

  const ownerType = asString(change.fields.ownerType);
  const ownerId = asString(change.fields.ownerId);
  const documentRef = asString(change.fields.documentRef);
  const documentSource = asString(change.fields.documentSource);
  if (!["event", "item"].includes(ownerType)) {
    return rejected("票据关联的 owner 类型非法");
  }
  if (!ownerId || !documentRef) return rejected("票据关联缺少 owner 或文件引用");
  if (!["capture_asset", "shelf_item", "attachment", "file"].includes(documentSource)) {
    return rejected("票据关联的来源类型非法");
  }
  // 关联不得悬空：owner 尚未到达时延后（父记录可能在后一页）；已删除则无需保留。
  const owner = await ownerStatus(db, ownerType, ownerId);
  if (owner === "missing") return deferred("dependency");
  if (owner === "deleted") return stale();

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

  // 同一 owner 下同一文件不得重复：本地已有等价活动行时不覆盖，保留待处理状态。
  const duplicate = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM life_document_links
      WHERE deleted_at IS NULL AND owner_type = ? AND owner_id = ?
        AND document_ref = ? AND document_source = ? AND id <> ? LIMIT 1`,
    [ownerType, ownerId, documentRef, documentSource, change.id],
  );
  if (duplicate) return deferred("duplicate_link");

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
  return applied();
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
      return rejected(`未知生活实体：${change.entity}`);
  }
}

// ── 延后变更持久化 ─────────────────────────────────────────

interface DeferredRow {
  id: number;
  entity: LifeEntity;
  target_id: string;
  server_rev: number;
  deleted: number;
  fields_json: string;
  updated_at: number;
  reason: LifeDeferReason;
  first_seen_at: number;
  retry_count: number;
  last_attempt_at: number | null;
}

export interface DeferredLifeChange {
  id: number;
  entity: LifeEntity;
  targetId: string;
  serverRev: number;
  deleted: boolean;
  fields: Record<string, unknown>;
  updatedAt: number;
  reason: LifeDeferReason;
  firstSeenAt: number;
  retryCount: number;
  lastAttemptAt: number | null;
}

export interface DeferredRetryResult {
  applied: number;
  deleted: number;
  stale: number;
}

function parseFields(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapDeferred(row: DeferredRow): DeferredLifeChange {
  return {
    id: row.id,
    entity: row.entity,
    targetId: row.target_id,
    serverRev: row.server_rev,
    deleted: row.deleted === 1,
    fields: parseFields(row.fields_json),
    updatedAt: row.updated_at,
    reason: row.reason,
    firstSeenAt: row.first_seen_at,
    retryCount: row.retry_count,
    lastAttemptAt: row.last_attempt_at,
  };
}

/** 把暂时无法应用的 pull 变更写入 SQLite；同一变更多次遇到只累加重试次数。 */
export async function recordDeferredLifeChange(
  db: SQLiteDatabase,
  change: Change,
  reason: LifeDeferReason,
): Promise<void> {
  if (!isLifeEntity(change.entity)) return;
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO life_sync_deferred
       (entity, target_id, server_rev, deleted, fields_json, updated_at, reason,
        first_seen_at, retry_count, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(entity, target_id, server_rev, deleted) DO UPDATE SET
       fields_json = excluded.fields_json,
       updated_at = excluded.updated_at,
       reason = excluded.reason,
       retry_count = life_sync_deferred.retry_count + 1,
       last_attempt_at = excluded.first_seen_at`,
    [
      change.entity,
      change.id,
      change.rev,
      change.deleted ? 1 : 0,
      JSON.stringify(change.fields ?? {}),
      change.updated_at,
      reason,
      now,
    ],
  );
}

export async function listDeferredLifeChanges(): Promise<DeferredLifeChange[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<DeferredRow>(
    `SELECT id, entity, target_id, server_rev, deleted, fields_json, updated_at, reason,
            first_seen_at, retry_count, last_attempt_at
       FROM life_sync_deferred
      ORDER BY first_seen_at ASC, id ASC`,
  );
  return rows.map(mapDeferred);
}

export async function countDeferredLifeChanges(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM life_sync_deferred",
  );
  return row?.n ?? 0;
}

/** 冲突/删除解决后清掉对应记录的延后项；target 与 source 都清，避免旧 ID 残留。 */
export async function clearDeferredLifeChangeForTarget(
  db: SQLiteDatabase,
  targetId: string,
): Promise<void> {
  await db.runAsync("DELETE FROM life_sync_deferred WHERE target_id = ?", [targetId]);
}

async function clearDeferredRow(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync("DELETE FROM life_sync_deferred WHERE id = ?", [id]);
}

async function retryUpdateFailure(
  db: SQLiteDatabase,
  row: DeferredRow,
  reason: LifeDeferReason,
): Promise<void> {
  await db.runAsync(
    `UPDATE life_sync_deferred
        SET reason = ?, retry_count = retry_count + 1, last_attempt_at = ?
      WHERE id = ?`,
    [reason, Date.now(), row.id],
  );
}

/**
 * 重放已持久化的延后变更。必须在事务内调用（applyPullChanges 已开启事务）。
 * - 依赖/outbox 类：依赖满足后再应用，成功即删除延后行；
 * - 名称冲突/重复关联/非法数据：不自动重放，保留在诊断与冲突界面，等用户处理；
 * - 旧版本：直接清理。
 * 最多三轮，覆盖 item → event → event_item → link 的级联依赖。
 */
export async function retryDeferredLifeChangesInTx(
  db: SQLiteDatabase,
): Promise<DeferredRetryResult> {
  const result: DeferredRetryResult = { applied: 0, deleted: 0, stale: 0 };
  for (let pass = 0; pass < 3; pass += 1) {
    const rows = await db.getAllAsync<DeferredRow>(
      `SELECT id, entity, target_id, server_rev, deleted, fields_json, updated_at, reason,
              first_seen_at, retry_count, last_attempt_at
         FROM life_sync_deferred
        ORDER BY first_seen_at ASC, id ASC`,
    );
    if (rows.length === 0) break;
    let progressed = false;
    for (const row of rows) {
      if (
        row.reason === "name_conflict" ||
        row.reason === "duplicate_link" ||
        row.reason === "invalid"
      ) {
        continue;
      }
      const change: Change = {
        entity: row.entity,
        id: row.target_id,
        rev: row.server_rev,
        deleted: row.deleted === 1,
        fields: parseFields(row.fields_json),
        updated_at: row.updated_at,
      };
      const outcome = await applyLifeChange(db, change);
      if (outcome.status === "applied") {
        result.applied += 1;
        await clearDeferredRow(db, row.id);
        progressed = true;
      } else if (outcome.status === "deleted") {
        result.deleted += 1;
        await clearDeferredRow(db, row.id);
        progressed = true;
      } else if (outcome.status === "stale") {
        result.stale += 1;
        await clearDeferredRow(db, row.id);
        progressed = true;
      } else if (outcome.status === "deferred") {
        if (outcome.reason !== row.reason) {
          await retryUpdateFailure(db, row, outcome.reason);
        } else {
          await db.runAsync(
            "UPDATE life_sync_deferred SET retry_count = retry_count + 1, last_attempt_at = ? WHERE id = ?",
            [Date.now(), row.id],
          );
        }
      } else {
        await retryUpdateFailure(db, row, "invalid");
      }
    }
    if (!progressed) break;
  }
  return result;
}

/** 独立重试入口（供同步流程在无新变更时也能消化旧延后项）。 */
export async function retryDeferredLifeChanges(): Promise<DeferredRetryResult> {
  const db = getDatabase();
  let result: DeferredRetryResult = { applied: 0, deleted: 0, stale: 0 };
  await db.withTransactionAsync(async () => {
    result = await retryDeferredLifeChangesInTx(db);
  });
  return result;
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
        amount_scale: number;
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
        amountScale: row.amount_scale,
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
  await db.runAsync("DELETE FROM life_sync_deferred");
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
      await purgeEventLocal(db, id, now);
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
