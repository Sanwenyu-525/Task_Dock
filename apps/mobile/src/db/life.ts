// 生活仓储：所有生活 SQL 只出现在这一层；写业务表与写 outbox 同事务。
//
// 与桌面端保持同一数据契约（表名/字段语义/金额最小单位/occurred_at 为实际发生日期），
// 手机端时间统一 INTEGER epoch ms，同步层负责与桌面端 RFC3339 互转。
import type { SQLiteDatabase } from "expo-sqlite";

import {
  currencyDecimals,
  extractLifeQueryKeyword,
  formatLifeDate,
  formatMoneyMinor,
  groupLifeCurrencyTotals,
  normalizeCurrency,
  normalizeLifeName,
  normalizeQuantity,
  parseMoneyMinor,
  type LifeDocumentLink,
  type LifeDocumentLinkInput,
  type LifeEventDetail,
  type LifeEventItem,
  type LifeItem,
  type LifeItemHistory,
  type LifePurchaseInput,
  type LifePurchaseRow,
  type LifeRecentPurchase,
  type LifeSearchHit,
} from "../domain/life";
import { newId } from "../lib/id";

import { getDatabase } from "./database";
import { getSetting, setSetting } from "./kv";

const DEFAULT_CURRENCY_KEY = "life.default_currency";

interface ItemRow {
  id: string;
  name: string;
  normalized_name: string;
  category: string;
  aliases: string | null;
  note: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface EventRow {
  id: string;
  event_type: string;
  title: string;
  description: string;
  occurred_at: number;
  merchant: string;
  source: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  rev: number;
  server_rev: number;
}

interface EventItemRow {
  id: string;
  event_id: string;
  item_id: string | null;
  item_name_snapshot: string;
  quantity_value: string | null;
  quantity_unit: string | null;
  unit_price_minor: number | null;
  total_price_minor: number | null;
  currency: string | null;
  amount_scale: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

interface LinkRow {
  id: string;
  owner_type: "event" | "item";
  owner_id: string;
  document_ref: string;
  document_source: LifeDocumentLink["documentSource"];
  document_name: string;
  mime: string;
  byte_size: number | null;
  remote_ref: string | null;
  remote_source: "shelf_item" | "file" | null;
  transfer_state: LifeDocumentLink["transferState"];
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  server_rev?: number;
  local_path?: string | null;
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function mapItem(row: ItemRow): LifeItem {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    category: row.category ?? "",
    aliases: parseAliases(row.aliases),
    note: row.note ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLink(row: LinkRow): LifeDocumentLink {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    documentRef: row.document_ref,
    documentSource: row.document_source,
    documentName: row.document_name,
    mime: row.mime,
    byteSize: row.byte_size,
    transferState: row.transfer_state,
    remoteRef: row.remote_ref,
    remoteSource: row.remote_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    localUri: row.local_path ?? null,
  };
}

async function enqueue(
  db: SQLiteDatabase,
  entity: string,
  targetId: string,
  baseRev: number,
  type: "create" | "update" | "delete",
  now: number,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId("op"), entity, targetId, baseRev, JSON.stringify({ type }), now],
  );
}

async function findActiveItem(
  db: SQLiteDatabase,
  normalized: string,
): Promise<ItemRow | null> {
  return db.getFirstAsync<ItemRow>(
    `SELECT * FROM life_items WHERE normalized_name = ? AND deleted_at IS NULL LIMIT 1`,
    [normalized],
  );
}

async function ensureItemInTx(
  db: SQLiteDatabase,
  name: string,
  category: string,
  now: number,
): Promise<{ id: string; created: boolean }> {
  const normalized = normalizeLifeName(name);
  const existing = await findActiveItem(db, normalized);
  if (existing) return { id: existing.id, created: false };

  const id = newId("li");
  await db.runAsync(
    `INSERT INTO life_items (id, name, normalized_name, category, aliases, note,
                             created_at, updated_at, deleted_at, rev, server_rev)
     VALUES (?, ?, ?, ?, '[]', '', ?, ?, NULL, 0, 0)`,
    [id, name, normalized, category, now, now],
  );
  await enqueue(db, "life_item", id, 0, "create", now);
  return { id, created: true };
}

function validatePurchase(
  input: LifePurchaseInput,
  amountScaleOverride?: number | null,
): {
  name: string;
  occurredAt: number;
  quantityValue: string | null;
  quantityUnit: string;
  totalMinor: number | null;
  currency: string;
  amountScale: number;
  merchant: string;
  category: string;
  note: string;
} {
  const name = input.name.trim();
  if (!name) throw new Error("请填写商品名称");
  if (!Number.isFinite(input.occurredAt)) throw new Error("请选择有效的购买日期");

  const quantityValue = normalizeQuantity(input.quantityValue);
  const quantityUnit = (input.quantityUnit ?? "").trim();
  if (quantityValue !== null && quantityUnit === "") {
    throw new Error("填写数量时必须填写单位");
  }

  const currency = normalizeCurrency(input.currency);
  const totalMinor = parseMoneyMinor(input.totalPrice, currency, amountScaleOverride);
  const amountScale =
    totalMinor === null
      ? 2
      : amountScaleOverride != null &&
          Number.isInteger(amountScaleOverride) &&
          amountScaleOverride >= 0 &&
          amountScaleOverride <= 3
        ? amountScaleOverride
        : currencyDecimals(currency);
  if (totalMinor !== null && currency === "") {
    throw new Error("填写金额时必须选择货币");
  }
  if (totalMinor === null && currency !== "") {
    // 只选货币不填金额没有意义，但允许保存（用户可能只记了货币）。
  }

  return {
    name,
    occurredAt: input.occurredAt,
    quantityValue,
    quantityUnit,
    totalMinor,
    currency,
    amountScale,
    merchant: (input.merchant ?? "").trim(),
    category: (input.category ?? "").trim(),
    note: (input.note ?? "").trim(),
  };
}

export interface CreatePurchaseResult {
  eventId: string;
  itemId: string;
  itemRowId: string;
}

/** 新增一笔购买。只要求商品名称；金额/数量/商家等为选填。 */
export async function createPurchase(input: LifePurchaseInput): Promise<CreatePurchaseResult> {
  const values = validatePurchase(input);
  const db = getDatabase();
  const now = Date.now();
  const eventId = newId("le");
  const itemRowId = newId("lei");
  let itemId = "";

  await db.withTransactionAsync(async () => {
    const item = await ensureItemInTx(db, values.name, values.category, now);
    itemId = item.id;

    await db.runAsync(
      `INSERT INTO life_events (id, event_type, title, description, occurred_at, merchant,
                                source, created_at, updated_at, deleted_at, rev, server_rev)
       VALUES (?, 'purchase', ?, '', ?, ?, 'manual', ?, ?, NULL, 0, 0)`,
      [eventId, values.name, values.occurredAt, values.merchant, now, now],
    );
    await enqueue(db, "life_event", eventId, 0, "create", now);

    await db.runAsync(
      `INSERT INTO life_event_items (id, event_id, item_id, item_name_snapshot, quantity_value,
                                     quantity_unit, unit_price_minor, total_price_minor, currency,
                                     amount_scale, note, created_at, updated_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [
        itemRowId,
        eventId,
        item.id,
        values.name,
        values.quantityValue,
        values.quantityUnit,
        values.totalMinor,
        values.currency,
        values.amountScale,
        values.note,
        now,
        now,
      ],
    );
    await enqueue(db, "life_event_item", itemRowId, 0, "create", now);
  });

  // 只记住用户显式选中的货币，不凭空假设人民币；空值不写入。
  if (values.currency) await setSetting(DEFAULT_CURRENCY_KEY, values.currency);
  return { eventId, itemId, itemRowId };
}

/** 更新一笔只包含单件商品的购买记录；多件商品事件不允许从移动端单行编辑。 */
export async function updatePurchase(eventId: string, input: LifePurchaseInput): Promise<void> {
  const db = getDatabase();
  // 编辑历史行时按该行已保存的精度解析金额（例如旧 JPY 行按 2 位存储），
  // 避免把「100」按 0 位解析成 100 后仍以 scale=2 存成 ¥1.00。
  const preview = await db.getFirstAsync<EventItemRow>(
    `SELECT ei.* FROM life_event_items ei
      WHERE ei.event_id = ? LIMIT 1`,
    [eventId],
  );
  const sameCurrency =
    preview != null && normalizeCurrency(input.currency) === (preview.currency ?? "");
  const values = validatePurchase(
    input,
    sameCurrency && preview?.amount_scale != null ? preview.amount_scale : null,
  );
  const now = Date.now();

  await db.withTransactionAsync(async () => {
    const event = await db.getFirstAsync<EventRow>(
      "SELECT * FROM life_events WHERE id = ? AND deleted_at IS NULL",
      [eventId],
    );
    if (!event) throw new Error("购买记录不存在或已删除");
    const rows = await db.getAllAsync<EventItemRow>(
      "SELECT * FROM life_event_items WHERE event_id = ?",
      [eventId],
    );
    if (rows.length !== 1) {
      throw new Error("该购买记录包含多件商品，移动端暂不支持整组编辑");
    }
    const row = rows[0];
    const item = await ensureItemInTx(db, values.name, values.category, now);
    const amountScale = values.amountScale;

    await db.runAsync(
      `UPDATE life_events SET title = ?, occurred_at = ?, merchant = ?, updated_at = ?, rev = rev + 1
        WHERE id = ?`,
      [values.name, values.occurredAt, values.merchant, now, eventId],
    );
    await enqueue(db, "life_event", eventId, event.server_rev ?? 0, "update", now);

    await db.runAsync(
      `UPDATE life_event_items
          SET item_id = ?, item_name_snapshot = ?, quantity_value = ?, quantity_unit = ?,
              total_price_minor = ?, currency = ?, amount_scale = ?, note = ?,
              updated_at = ?, rev = rev + 1
        WHERE id = ?`,
      [
        item.id,
        values.name,
        values.quantityValue,
        values.quantityUnit,
        values.totalMinor,
        values.currency,
        amountScale,
        values.note,
        now,
        row.id,
      ],
    );
    const itemServerRev = await db.getFirstAsync<{ server_rev: number }>(
      "SELECT server_rev FROM life_event_items WHERE id = ?",
      [row.id],
    );
    await enqueue(db, "life_event_item", row.id, itemServerRev?.server_rev ?? 0, "update", now);
  });

  if (values.currency) await setSetting(DEFAULT_CURRENCY_KEY, values.currency);
}

/** 删除购买记录：事件软删 + 子行硬删 + 事件级票据关联软删；不改原图。 */
export async function deletePurchase(eventId: string): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    const event = await db.getFirstAsync<EventRow>(
      "SELECT * FROM life_events WHERE id = ? AND deleted_at IS NULL",
      [eventId],
    );
    if (!event) return;

    await db.runAsync(
      `UPDATE life_event_items SET item_id = NULL WHERE event_id = ?`,
      [eventId],
    );
    await db.runAsync("DELETE FROM life_event_items WHERE event_id = ?", [eventId]);
    await db.runAsync(
      `UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1
        WHERE owner_type = 'event' AND owner_id = ? AND deleted_at IS NULL`,
      [now, now, eventId],
    );
    await db.runAsync(
      `UPDATE life_events SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [now, now, eventId],
    );
    // 桌面端在事件墓碑里连带删除子行与关联，手机端只发事件墓碑，避免重复/乱序墓碑。
    await enqueue(db, "life_event", eventId, event.server_rev ?? 0, "delete", now);
  });
}

export async function loadDefaultCurrency(): Promise<string> {
  return ((await getSetting(DEFAULT_CURRENCY_KEY)) ?? "").trim().toUpperCase();
}

export async function listItems(query = "", limit = 60): Promise<LifeItem[]> {
  const db = getDatabase();
  const keyword = extractLifeQueryKeyword(query) || query.trim();
  const normalized = normalizeLifeName(keyword);
  const like = normalized ? `%${normalized}%` : null;
  const rows = await db.getAllAsync<ItemRow>(
    `SELECT * FROM life_items
      WHERE deleted_at IS NULL
        AND (? IS NULL OR normalized_name LIKE ? OR aliases LIKE ?)
      ORDER BY updated_at DESC, id DESC
      LIMIT ?`,
    [like, like, like, limit],
  );
  return rows.map(mapItem);
}

async function loadLinksFor(
  db: SQLiteDatabase,
  eventIds: readonly string[],
  itemId: string,
): Promise<{ eventLinks: Map<string, LifeDocumentLink[]>; itemLinks: LifeDocumentLink[] }> {
  const eventLinks = new Map<string, LifeDocumentLink[]>();
  const itemLinks: LifeDocumentLink[] = [];

  const rows = await db.getAllAsync<LinkRow>(
    `SELECT l.*, a.local_path
       FROM life_document_links l
       LEFT JOIN capture_assets a
         ON l.document_source = 'capture_asset' AND a.id = l.document_ref
      WHERE l.deleted_at IS NULL
        AND ((l.owner_type = 'event' AND l.owner_id IN (${eventIds.map(() => "?").join(",") || "''"}))
          OR (l.owner_type = 'item' AND l.owner_id = ?))
      ORDER BY l.created_at DESC`,
    [...eventIds, itemId],
  );

  for (const row of rows) {
    const link = mapLink(row);
    if (link.ownerType === "item") itemLinks.push(link);
    else {
      const list = eventLinks.get(link.ownerId) ?? [];
      list.push(link);
      eventLinks.set(link.ownerId, list);
    }
  }
  return { eventLinks, itemLinks };
}

/** 商品购买历史：严格按实际购买日期倒序，同日期用 created_at/id 稳定次级排序。 */
export async function getItemHistory(itemId: string, limit = 50): Promise<LifeItemHistory | null> {
  const db = getDatabase();
  const itemRow = await db.getFirstAsync<ItemRow>(
    "SELECT * FROM life_items WHERE id = ? AND deleted_at IS NULL",
    [itemId],
  );
  if (!itemRow) return null;
  const item = mapItem(itemRow);

  const rows = await db.getAllAsync<
    EventItemRow & {
      event_type: string;
      event_occurred_at: number;
      event_created_at: number;
      merchant: string;
      event_title: string;
    }
  >(
    `SELECT ei.*, e.event_type, e.occurred_at AS event_occurred_at,
            e.created_at AS event_created_at, e.merchant, e.title AS event_title
       FROM life_event_items ei
       JOIN life_events e ON e.id = ei.event_id
      WHERE ei.item_id = ? AND e.deleted_at IS NULL
      ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC
      LIMIT ?`,
    [itemId, limit],
  );

  const totalRow = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(DISTINCT e.id) AS n
       FROM life_event_items ei
       JOIN life_events e ON e.id = ei.event_id
      WHERE ei.item_id = ? AND e.deleted_at IS NULL`,
    [itemId],
  );

  const eventIds = [...new Set(rows.map((row) => row.event_id))];
  const { eventLinks, itemLinks } = await loadLinksFor(db, eventIds, itemId);

  const purchases: LifePurchaseRow[] = rows.map((row) => ({
    itemRowId: row.id,
    eventId: row.event_id,
    itemId: row.item_id,
    itemName: row.item_name_snapshot,
    occurredAt: row.event_occurred_at,
    createdAt: row.event_created_at,
    merchant: row.merchant ?? "",
    quantityValue: row.quantity_value,
    quantityUnit: row.quantity_unit ?? "",
    unitPriceMinor: row.unit_price_minor,
    totalPriceMinor: row.total_price_minor,
    currency: row.currency ?? "",
    amountScale: row.amount_scale ?? 2,
    note: row.note ?? "",
    links: [...(eventLinks.get(row.event_id) ?? []), ...itemLinks],
  }));

  let intervalDays: number | null = null;
  if (purchases.length >= 2) {
    const latest = purchases[0].occurredAt;
    const previous = purchases[1].occurredAt;
    intervalDays = Math.max(0, Math.round((latest - previous) / 86_400_000));
  }

  return {
    item,
    purchases,
    totalCount: totalRow?.n ?? purchases.length,
    intervalDays,
  };
}

/** 最近购买事件（默认购买类型），附带商品名与票据数量。 */
export async function listRecentPurchases(limit = 20): Promise<LifeRecentPurchase[]> {
  const db = getDatabase();
  const events = await db.getAllAsync<EventRow>(
    `SELECT * FROM life_events
      WHERE deleted_at IS NULL AND event_type = 'purchase'
      ORDER BY occurred_at DESC, created_at DESC, id DESC
      LIMIT ?`,
    [limit],
  );
  if (events.length === 0) return [];

  const ids = events.map((event) => event.id);
  const itemRows = await db.getAllAsync<
    EventItemRow & { title: string; occurred_at: number }
  >(
    `SELECT ei.*, e.title, e.occurred_at
       FROM life_event_items ei
       JOIN life_events e ON e.id = ei.event_id
      WHERE ei.event_id IN (${ids.map(() => "?").join(",")})
      ORDER BY ei.created_at ASC, ei.id ASC`,
    ids,
  );
  const linkRows = await db.getAllAsync<{ owner_id: string; n: number }>(
    `SELECT owner_id, COUNT(*) AS n FROM life_document_links
      WHERE deleted_at IS NULL AND owner_type = 'event'
        AND owner_id IN (${ids.map(() => "?").join(",")})
      GROUP BY owner_id`,
    ids,
  );

  const itemsByEvent = new Map<string, EventItemRow[]>();
  for (const row of itemRows) {
    const list = itemsByEvent.get(row.event_id) ?? [];
    list.push(row);
    itemsByEvent.set(row.event_id, list);
  }
  const linkCount = new Map(linkRows.map((row) => [row.owner_id, row.n]));

  return events.map((event) => {
    const rows = itemsByEvent.get(event.id) ?? [];
    const totals = groupLifeCurrencyTotals(
      rows.map((row) => ({
        totalPriceMinor: row.total_price_minor ?? null,
        currency: row.currency ?? "",
        amountScale: row.amount_scale ?? 2,
      })),
    );
    // 单一币种继续提供旧的扁平字段，保持既有调用方/历史数据展示兼容；
    // 多币种时不再把不同货币相加，totalPriceMinor 置空，由 totals 分行展示。
    const single = totals.length === 1 ? totals[0] : null;
    return {
      eventId: event.id,
      title: event.title,
      occurredAt: event.occurred_at,
      merchant: event.merchant ?? "",
      totalPriceMinor: single ? single.totalPriceMinor : null,
      currency: single ? single.currency : "",
      amountScale: single ? single.amountScale : 2,
      totals,
      itemNames: rows.map((row) => row.item_name_snapshot),
      linkCount: linkCount.get(event.id) ?? 0,
    };
  });
}

export async function getEventDetail(eventId: string): Promise<LifeEventDetail | null> {
  const db = getDatabase();
  const event = await db.getFirstAsync<EventRow>(
    "SELECT * FROM life_events WHERE id = ? AND deleted_at IS NULL",
    [eventId],
  );
  if (!event) return null;

  const itemRows = await db.getAllAsync<EventItemRow>(
    `SELECT * FROM life_event_items WHERE event_id = ? ORDER BY created_at ASC, id ASC`,
    [eventId],
  );
  const linkRows = await db.getAllAsync<LinkRow>(
    `SELECT l.*, a.local_path FROM life_document_links l
       LEFT JOIN capture_assets a
         ON l.document_source = 'capture_asset' AND a.id = l.document_ref
      WHERE l.deleted_at IS NULL
        AND ((l.owner_type = 'event' AND l.owner_id = ?)
          OR (l.owner_type = 'item' AND l.owner_id IN (
                SELECT item_id FROM life_event_items WHERE event_id = ? AND item_id IS NOT NULL)))
      ORDER BY l.created_at DESC`,
    [eventId, eventId],
  );

  const items: LifeEventItem[] = itemRows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name_snapshot,
    quantityValue: row.quantity_value,
    quantityUnit: row.quantity_unit ?? "",
    unitPriceMinor: row.unit_price_minor,
    totalPriceMinor: row.total_price_minor,
    currency: row.currency ?? "",
    amountScale: row.amount_scale ?? 2,
    note: row.note ?? "",
  }));

  return {
    eventId: event.id,
    eventType: event.event_type,
    title: event.title,
    description: event.description,
    occurredAt: event.occurred_at,
    merchant: event.merchant ?? "",
    source: event.source,
    items,
    links: linkRows.map(mapLink),
  };
}

async function ownerExists(
  db: SQLiteDatabase,
  ownerType: "event" | "item",
  ownerId: string,
): Promise<boolean> {
  if (ownerType === "event") {
    const row = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM life_events WHERE id = ? AND deleted_at IS NULL",
      [ownerId],
    );
    return (row?.n ?? 0) > 0;
  }
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM life_items WHERE id = ? AND deleted_at IS NULL",
    [ownerId],
  );
  return (row?.n ?? 0) > 0;
}

export async function createDocumentLink(input: LifeDocumentLinkInput): Promise<string> {
  const db = getDatabase();
  const now = Date.now();
  let linkId = "";

  await db.withTransactionAsync(async () => {
    if (!(await ownerExists(db, input.ownerType, input.ownerId))) {
      throw new Error("关联的生活记录已不存在，无法添加票据");
    }
    const existing = await db.getFirstAsync<LinkRow>(
      `SELECT l.*, a.local_path FROM life_document_links l
         LEFT JOIN capture_assets a
           ON l.document_source = 'capture_asset' AND a.id = l.document_ref
        WHERE l.deleted_at IS NULL AND l.owner_type = ? AND l.owner_id = ?
          AND l.document_ref = ? AND l.document_source = ?
        LIMIT 1`,
      [input.ownerType, input.ownerId, input.documentRef, input.documentSource],
    );
    if (existing) {
      // 异审：即使已存在，也校验来源文件仍在本机（capture_asset 可能已被清理）。
      if (existing.document_source === "capture_asset" && !existing.local_path) {
        throw new Error("原始票据文件已不在本机，请重新采集或从电脑重新接收");
      }
      linkId = existing.id;
      return;
    }

    if (input.documentSource === "capture_asset") {
      const asset = await db.getFirstAsync<{ local_path: string | null; name: string }>(
        "SELECT local_path, name FROM capture_assets WHERE id = ?",
        [input.documentRef],
      );
      if (!asset) throw new Error("采集素材不存在，无法关联票据");
      if (!asset.local_path) throw new Error("原始票据文件已不在本机，无法关联");
    }

    linkId = newId("ld");
    await db.runAsync(
      `INSERT INTO life_document_links (id, owner_type, owner_id, document_ref, document_source,
                                        document_name, mime, byte_size, transfer_state,
                                        created_at, updated_at, deleted_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
      [
        linkId,
        input.ownerType,
        input.ownerId,
        input.documentRef,
        input.documentSource,
        input.documentName,
        input.mime ?? "",
        input.byteSize ?? null,
        input.transferState ?? "local",
        now,
        now,
      ],
    );
    await enqueue(db, "life_document_link", linkId, 0, "create", now);
  });

  return linkId;
}

export async function listDocumentLinks(
  ownerType?: "event" | "item" | null,
  ownerId?: string | null,
  limit = 200,
): Promise<LifeDocumentLink[]> {
  const db = getDatabase();
  const scoped = ownerType && ownerId;
  const rows = await db.getAllAsync<LinkRow>(
    `SELECT l.*, a.local_path FROM life_document_links l
       LEFT JOIN capture_assets a
         ON l.document_source = 'capture_asset' AND a.id = l.document_ref
      WHERE l.deleted_at IS NULL
        AND (? = 0 OR (l.owner_type = ? AND l.owner_id = ?))
      ORDER BY l.created_at DESC
      LIMIT ?`,
    [scoped ? 1 : 0, ownerType ?? "", ownerId ?? "", limit],
  );
  return rows.map(mapLink);
}

export async function getDocumentLink(linkId: string): Promise<LifeDocumentLink | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<LinkRow>(
    `SELECT l.*, a.local_path FROM life_document_links l
       LEFT JOIN capture_assets a
         ON l.document_source = 'capture_asset' AND a.id = l.document_ref
      WHERE l.deleted_at IS NULL AND l.id = ?`,
    [linkId],
  );
  return row ? mapLink(row) : null;
}

export async function deleteDocumentLink(linkId: string): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<LinkRow>(
      "SELECT * FROM life_document_links WHERE id = ? AND deleted_at IS NULL",
      [linkId],
    );
    if (!row) return;
    // 只解除关联，绝不删除原文件。
    await db.runAsync(
      "UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
      [now, now, linkId],
    );
    await enqueue(db, "life_document_link", linkId, row.server_rev ?? 0, "delete", now);
  });
}

/** 文件实际传输状态：与元数据同步分开记录，远端尚无文件时保持 metadata_only。 */
export async function setDocumentLinkTransferState(
  linkId: string,
  state: LifeDocumentLink["transferState"],
): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ server_rev: number } & LinkRow>(
      "SELECT * FROM life_document_links WHERE id = ? AND deleted_at IS NULL",
      [linkId],
    );
    if (!row) throw new Error("票据关联不存在");
    if (row.transfer_state === state) return;
    await db.runAsync(
      `UPDATE life_document_links SET transfer_state = ?, updated_at = ?, rev = rev + 1
        WHERE id = ?`,
      [state, now, linkId],
    );
    await enqueue(db, "life_document_link", linkId, row.server_rev, "update", now);
  });
}

/**
 * 文件已上传到电脑、但尚未导入暂存架：保留远端文件 ID，重试时直接复用，
 * 避免重复上传制造孤立文件。`document_ref`/`document_source` 仍保留本机来源。
 */
export async function markDocumentFileUploaded(
  linkId: string,
  input: { remoteFileId: string; name?: string; mime?: string; byteSize?: number | null },
): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ server_rev: number } & LinkRow>(
      "SELECT * FROM life_document_links WHERE id = ? AND deleted_at IS NULL",
      [linkId],
    );
    if (!row) throw new Error("票据关联不存在");
    const remoteFileId = input.remoteFileId.trim();
    if (!remoteFileId) throw new Error("电脑端未返回文件 ID");
    await db.runAsync(
      `UPDATE life_document_links
          SET remote_ref = ?, remote_source = 'file', document_name = ?, mime = ?,
              byte_size = ?, transfer_state = 'metadata_only', updated_at = ?,
              rev = rev + 1
        WHERE id = ?`,
      [
        remoteFileId,
        (input.name ?? row.document_name).trim(),
        input.mime ?? row.mime,
        input.byteSize ?? row.byte_size,
        now,
        linkId,
      ],
    );
    await enqueue(db, "life_document_link", linkId, row.server_rev ?? 0, "update", now);
  });
}

/**
 * 原图经「文件互传」进入桌面暂存架后，记录远端稳定引用并标记 transferred。
 * `document_ref`/`document_source` 继续保留本机来源，绝不改成桌面 shelf ID。
 */
export async function markDocumentUploaded(
  linkId: string,
  input: { shelfItemId: string; name?: string; mime?: string; byteSize?: number | null },
): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ server_rev: number } & LinkRow>(
      "SELECT * FROM life_document_links WHERE id = ? AND deleted_at IS NULL",
      [linkId],
    );
    if (!row) throw new Error("票据关联不存在");
    const shelfItemId = input.shelfItemId.trim();
    if (!shelfItemId) throw new Error("桌面端未返回票据文件 ID");
    await db.runAsync(
      `UPDATE life_document_links
          SET remote_ref = ?, remote_source = 'shelf_item', document_name = ?,
              mime = ?, byte_size = ?, transfer_state = 'transferred', updated_at = ?,
              rev = rev + 1
        WHERE id = ?`,
      [
        shelfItemId,
        (input.name ?? row.document_name).trim(),
        input.mime ?? row.mime,
        input.byteSize ?? row.byte_size,
        now,
        linkId,
      ],
    );
    await enqueue(db, "life_document_link", linkId, row.server_rev, "update", now);
  });
}

/** 把票据从一个 owner 移到另一个 owner：新建关联再软删旧关联，原文件不动。 */
export async function relinkDocument(
  linkId: string,
  ownerType: "event" | "item",
  ownerId: string,
): Promise<string> {
  const db = getDatabase();
  const now = Date.now();
  let resultId = linkId;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<LinkRow>(
      "SELECT * FROM life_document_links WHERE id = ? AND deleted_at IS NULL",
      [linkId],
    );
    if (!row) throw new Error("票据关联不存在");
    if (!(await ownerExists(db, ownerType, ownerId))) {
      throw new Error("目标生活记录不存在，无法关联");
    }
    if (row.owner_type === ownerType && row.owner_id === ownerId) {
      resultId = row.id;
      return;
    }

    const duplicate = await db.getFirstAsync<LinkRow>(
      `SELECT * FROM life_document_links
        WHERE deleted_at IS NULL AND owner_type = ? AND owner_id = ?
          AND document_ref = ? AND document_source = ? LIMIT 1`,
      [ownerType, ownerId, row.document_ref, row.document_source],
    );
    if (duplicate) {
      // 目标已存在同一张票据：只删除旧关联，不重复建行；远端引用以当前关联为准补全。
      await db.runAsync(
        `UPDATE life_document_links
            SET remote_ref = ?, remote_source = ?, transfer_state = ?, updated_at = ?,
                rev = rev + 1
          WHERE id = ?`,
        [row.remote_ref, row.remote_source, row.transfer_state, now, duplicate.id],
      );
      await enqueue(
        db,
        "life_document_link",
        duplicate.id,
        duplicate.server_rev ?? 0,
        "update",
        now,
      );
      await db.runAsync(
        "UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
        [now, now, linkId],
      );
      await enqueue(db, "life_document_link", linkId, row.server_rev ?? 0, "delete", now);
      resultId = duplicate.id;
      return;
    }

    const newLinkId = newId("ld");
    await db.runAsync(
      `INSERT INTO life_document_links (id, owner_type, owner_id, document_ref, document_source,
                                        document_name, mime, byte_size, remote_ref, remote_source,
                                        transfer_state, created_at, updated_at, deleted_at, rev,
                                        server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
      [
        newLinkId,
        ownerType,
        ownerId,
        row.document_ref,
        row.document_source,
        row.document_name,
        row.mime,
        row.byte_size,
        row.remote_ref,
        row.remote_source,
        row.transfer_state,
        now,
        now,
      ],
    );
    await enqueue(db, "life_document_link", newLinkId, 0, "create", now);
    await db.runAsync(
      "UPDATE life_document_links SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
      [now, now, linkId],
    );
    await enqueue(db, "life_document_link", linkId, row.server_rev ?? 0, "delete", now);
    resultId = newLinkId;
  });
  return resultId;
}

/** 本地生活搜索：商品名称、事件标题/备注/商家、票据名称。全部参数化 LIKE。 */
export async function searchLife(raw: string, limit = 30): Promise<LifeSearchHit[]> {
  const keyword = extractLifeQueryKeyword(raw) || raw.trim();
  if (!keyword) return [];
  const db = getDatabase();
  const normalized = normalizeLifeName(keyword);
  const like = `%${normalized}%`;
  const hits: LifeSearchHit[] = [];

  const items = await db.getAllAsync<ItemRow>(
    `SELECT * FROM life_items
      WHERE deleted_at IS NULL AND (normalized_name LIKE ? OR aliases LIKE ?)
      ORDER BY updated_at DESC LIMIT ?`,
    [like, like, limit],
  );
  for (const row of items) {
    const last = await db.getFirstAsync<{
      occurred_at: number;
      total: number | null;
      currency: string;
      amount_scale: number;
    }>(
      `SELECT e.occurred_at, ei.total_price_minor AS total, ei.currency,
              ei.amount_scale
         FROM life_event_items ei JOIN life_events e ON e.id = ei.event_id
        WHERE ei.item_id = ? AND e.deleted_at IS NULL AND e.event_type = 'purchase'
        ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC LIMIT 1`,
      [row.id],
    );
    hits.push({
      kind: "item",
      id: row.id,
      title: row.name,
      subtitle: last
        ? `${formatLifeDate(last.occurred_at)} · ${
            formatMoneyMinor(last.total, last.currency, last.amount_scale) || "未记录金额"
          }`
        : "尚无购买记录",
      occurredAt: last?.occurred_at ?? null,
    });
  }

  const events = await db.getAllAsync<EventRow>(
    `SELECT * FROM life_events
      WHERE deleted_at IS NULL
        AND (title LIKE ? OR description LIKE ? OR merchant LIKE ?)
      ORDER BY occurred_at DESC, created_at DESC LIMIT ?`,
    [like, like, like, limit],
  );
  for (const row of events) {
    hits.push({
      kind: "event",
      id: row.id,
      title: row.title || (row.event_type === "purchase" ? "购买记录" : "生活记录"),
      subtitle: `${formatLifeDate(row.occurred_at)}${row.merchant ? ` · ${row.merchant}` : ""}`,
      occurredAt: row.occurred_at,
    });
  }

  const links = await db.getAllAsync<LinkRow>(
    `SELECT l.*, a.local_path FROM life_document_links l
       LEFT JOIN capture_assets a
         ON l.document_source = 'capture_asset' AND a.id = l.document_ref
      WHERE l.deleted_at IS NULL AND l.document_name LIKE ?
      ORDER BY l.created_at DESC LIMIT ?`,
    [`%${keyword}%`, limit],
  );
  for (const row of links) {
    hits.push({
      kind: "receipt",
      id: row.owner_id,
      ownerType: row.owner_type,
      title: row.document_name || "生活票据",
      subtitle: row.transfer_state === "missing" ? "原文件缺失" : "已关联票据",
      occurredAt: row.created_at,
    });
  }

  return hits.slice(0, limit);
}

/** 生活页概览计数：全部来自本地真实数据，不做推算。 */
export async function lifeOverview(): Promise<{
  itemCount: number;
  purchaseCount: number;
  receiptCount: number;
}> {  const db = getDatabase();
  const items = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM life_items WHERE deleted_at IS NULL",
  );
  const purchases = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM life_events WHERE deleted_at IS NULL AND event_type = 'purchase'",
  );
  const receipts = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM life_document_links WHERE deleted_at IS NULL",
  );
  return {
    itemCount: items?.n ?? 0,
    purchaseCount: purchases?.n ?? 0,
    receiptCount: receipts?.n ?? 0,
  };
}

/**
 * 采集素材「保存为生活票据」：生成一条 general 生活事件并关联素材引用。
 * 只存引用，不复制图片；用户之后可把关联改到具体商品/购买记录。
 */
export async function createReceiptEvent(input: {
  name: string;
  assetId: string;
  mime: string;
  byteSize: number;
  occurredAt?: number;
  note?: string;
}): Promise<{ eventId: string; linkId: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("票据名称不能为空");
  const db = getDatabase();
  const now = Date.now();
  const occurredAt = input.occurredAt ?? now;
  const eventId = newId("le");
  const linkId = newId("ld");

  await db.withTransactionAsync(async () => {
    const asset = await db.getFirstAsync<{ local_path: string | null; name: string }>(
      "SELECT local_path, name FROM capture_assets WHERE id = ?",
      [input.assetId],
    );
    if (!asset) throw new Error("采集素材不存在，无法保存为生活票据");
    if (!asset.local_path) throw new Error("原始票据文件已不在本机，无法保存为生活票据");

    await db.runAsync(
      `INSERT INTO life_events (id, event_type, title, description, occurred_at, merchant,
                                source, created_at, updated_at, deleted_at, rev, server_rev)
       VALUES (?, 'general', ?, ?, ?, '', 'capture', ?, ?, NULL, 0, 0)`,
      [eventId, name, input.note ?? "", occurredAt, now, now],
    );
    await enqueue(db, "life_event", eventId, 0, "create", now);

    await db.runAsync(
      `INSERT INTO life_document_links (id, owner_type, owner_id, document_ref, document_source,
                                        document_name, mime, byte_size, transfer_state,
                                        created_at, updated_at, deleted_at, rev, server_rev)
       VALUES (?, 'event', ?, ?, 'capture_asset', ?, ?, ?, 'local', ?, ?, NULL, 0, 0)`,
      [linkId, eventId, input.assetId, name, input.mime, input.byteSize, now, now],
    );
    await enqueue(db, "life_document_link", linkId, 0, "create", now);
  });

  return { eventId, linkId };
}
