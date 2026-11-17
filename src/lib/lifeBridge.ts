//! 生活效率系统 v1 的前端桥接（与 `commands::life` 的 serde 结构逐字段一致）。
//!
//! 约定：
//! - 金额一律是最小货币单位整数（`*_minor`），前端只做展示格式化，不用浮点累计；
//! - 数量是规范十进制**字符串**（最多 3 位小数），跨端逐字一致；
//! - 时间在桌面端是 RFC3339 字符串，展示时按本地时区格式化；
//! - 生活待办不在这里：继续走 `createTask` / `TaskEditorView`，分类预选「生活」。

import { invokeCommand as invoke } from "./errors";

export interface LifeItemSummary {
  id: string;
  name: string;
  normalized_name: string;
  category: string;
  note: string;
  aliases: string[];
  purchase_count: number;
  last_purchase_at: string | null;
  last_quantity_value: string | null;
  last_quantity_unit: string;
  last_unit_price_minor: number | null;
  last_total_price_minor: number | null;
  last_currency: string;
  last_amount_scale: number;
  interval_days: number | null;
  updated_at: string;
}

export interface LifeDocumentLink {
  id: string;
  owner_type: "event" | "item";
  owner_id: string;
  document_ref: string;
  document_source: "capture_asset" | "shelf_item" | "attachment" | "file";
  document_name: string;
  mime: string;
  byte_size: number | null;
  /** 原图实际传输到桌面后的稳定引用；未传输时为 null。 */
  remote_ref: string | null;
  remote_source: "shelf_item" | "file" | null;
  transfer_state: "local" | "metadata_only" | "transferred" | "missing";
  created_at: string;
  updated_at: string;
}

export interface LifePurchase {
  event_id: string;
  item_row_id: string;
  occurred_at: string;
  item_name: string;
  quantity_value: string | null;
  quantity_unit: string;
  unit_price_minor: number | null;
  total_price_minor: number | null;
  currency: string;
  amount_scale: number;
  merchant: string;
  note: string;
  event_note: string;
  created_at: string;
  links: LifeDocumentLink[];
}

export interface LifeItemHistory {
  item: LifeItemSummary;
  purchases: LifePurchase[];
  total_count: number;
}

export interface LifeEvent {
  id: string;
  event_type: "purchase" | "maintenance" | "general";
  title: string;
  description: string;
  occurred_at: string;
  merchant: string;
  source: "manual" | "capture";
  created_at: string;
  updated_at: string;
}

export interface LifeEventItem {
  id: string;
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
}

export interface LifeEventDetail {
  event: LifeEvent;
  items: LifeEventItem[];
  links: LifeDocumentLink[];
}

export interface LifeCurrencyTotal {
  currency: string;
  amount_scale: number;
  total_price_minor: number;
  item_count: number;
}

export interface LifeEventSummary {
  id: string;
  event_type: "purchase" | "maintenance" | "general";
  title: string;
  description: string;
  occurred_at: string;
  merchant: string;
  item_names: string[];
  total_price_minor: number | null;
  currency: string;
  amount_scale: number;
  /** 按币种分组的真实汇总；不同货币绝不直接相加。旧响应可能缺省。 */
  totals?: LifeCurrencyTotal[];
  link_count: number;
}

export interface LifeOverview {
  item_count: number;
  purchase_count: number;
  receipt_count: number;
  purchases_last_30_days: number;
}

export interface LifeQuickQueryResult {
  intent: "purchase_history" | "none";
  keyword: string;
  matched_by: "name" | "alias" | "partial" | "none" | "empty";
  item: LifeItemSummary | null;
  purchases: LifePurchase[];
  total_count: number;
  last_purchase_at: string | null;
  interval_days: number | null;
  message: string;
}

export interface LifeItemInput {
  item_id?: string | null;
  name?: string | null;
  category?: string | null;
  aliases?: string[] | null;
  quantity_value?: string | null;
  quantity_unit?: string | null;
  /** 十进制文本（最多 2 位小数）；不接受浮点数。 */
  unit_price?: string | null;
  total_price?: string | null;
  currency?: string | null;
  /** 编辑历史记录时沿用原行金额小数位；新建不填。 */
  amount_scale?: number | null;
  note?: string | null;
}

export interface LifeEventInput {
  event_type?: "purchase" | "maintenance" | "general" | null;
  title?: string | null;
  description?: string | null;
  /** `YYYY-MM-DD`（本地零点）或 RFC3339；缺省为当前时间。 */
  occurred_at?: string | null;
  merchant?: string | null;
  source?: "manual" | "capture" | null;
  /** 完整列表语义：更新时提交全部商品行，多余旧行按删除处理。 */
  items?: LifeItemInput[] | null;
}

export interface LifeDocumentLinkInput {
  owner_type: "event" | "item";
  owner_id: string;
  document_ref: string;
  document_source: "capture_asset" | "shelf_item" | "attachment" | "file";
  document_name?: string;
  mime?: string;
  byte_size?: number | null;
  transfer_state?: "local" | "metadata_only" | "transferred" | "missing";
}

export const lifeItemsList = (filter?: { query?: string | null; limit?: number }) =>
  invoke<LifeItemSummary[]>("life_items_list", { filter: filter ?? null });

export const lifeItemHistory = (itemId: string, limit?: number) =>
  invoke<LifeItemHistory>("life_item_history", { itemId, limit: limit ?? null });

export const lifeEventsRecent = (limit?: number, eventType?: string | null) =>
  invoke<LifeEventSummary[]>("life_events_recent", {
    limit: limit ?? null,
    eventType: eventType ?? null,
  });

export const lifeEventDetail = (eventId: string) =>
  invoke<LifeEventDetail>("life_event_detail", { eventId });

export const lifeEventCreate = (input: LifeEventInput) =>
  invoke<LifeEventDetail>("life_event_create", { input });

export const lifeEventUpdate = (eventId: string, input: LifeEventInput) =>
  invoke<LifeEventDetail>("life_event_update", { eventId, input });

export const lifeEventDelete = (eventId: string) =>
  invoke<void>("life_event_delete", { eventId });

export const lifeOverview = () => invoke<LifeOverview>("life_overview");

export const lifeQuickQuery = (text: string) =>
  invoke<LifeQuickQueryResult>("life_quick_query", { text });

export const lifeDocumentLinkCreate = (input: LifeDocumentLinkInput) =>
  invoke<LifeDocumentLink>("life_document_link_create", { input });

export const lifeDocumentLinkDelete = (linkId: string) =>
  invoke<void>("life_document_link_delete", { linkId });

export const lifeDocumentLinksList = (ownerType?: string | null, ownerId?: string | null) =>
  invoke<LifeDocumentLink[]>("life_document_links_list", {
    ownerType: ownerType ?? null,
    ownerId: ownerId ?? null,
  });

/**
 * 金额格式化：整数最小货币单位 → 展示文本（不做浮点累计）。
 * `amountScale` 必须与数据库行一致：JPY=0、KWD=3、旧行=2；缺省按 2 位保持历史兼容。
 */
export function formatMoneyMinor(
  minor: number | null | undefined,
  currency: string | null | undefined,
  amountScale?: number | null,
) {
  if (minor === null || minor === undefined) return "";
  const scale =
    typeof amountScale === "number" && Number.isInteger(amountScale) && amountScale >= 0 && amountScale <= 3
      ? amountScale
      : 2;
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const factor = 10 ** scale;
  const whole = Math.floor(abs / factor);
  const code = (currency ?? "").trim().toUpperCase();
  if (scale === 0) return `${sign}${whole}${code ? ` ${code}` : ""}`;
  const fraction = String(abs % factor).padStart(scale, "0");
  return `${sign}${whole}.${fraction}${code ? ` ${code}` : ""}`;
}

/** 本地日期（YYYY-MM-DD），用于购买记录展示与日期输入。 */
export function formatLifeDate(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
