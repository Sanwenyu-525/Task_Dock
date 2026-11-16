// 项目资料 / GitHub 快捷入口仓储。
//
// 设计取舍：
// - 在线链接与本地文件用 storage 字段区分，UI 必须明确标注「本地文件」而不是都显示成「已同步」；
// - 只存标题、链接、分类、备注与关联 id，不缓存网页正文（离线时不能假装能读到内容）；
// - 「最近查阅」用 last_opened_at + open_count 记录，按时间倒序展示；
// - 本机数据，不参与同步、不写 outbox。
import { getDatabase } from "./database";

import { newId } from "../lib/id";

export type ResourceKind = "doc" | "github";
export type ResourceStorage = "online" | "local";

export interface ToolResource {
  id: string;
  kind: ResourceKind;
  title: string;
  url: string;
  category: string;
  note: string;
  storage: ResourceStorage;
  linkedKind: string | null;
  linkedId: string | null;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  openCount: number;
  deletedAt: number | null;
}

export interface ResourceInput {
  kind: ResourceKind;
  title: string;
  url: string;
  category?: string;
  note?: string;
  storage?: ResourceStorage;
  linkedKind?: string | null;
  linkedId?: string | null;
}

interface ResourceRow {
  id: string;
  kind: ResourceKind;
  title: string;
  url: string;
  category: string;
  note: string;
  storage: ResourceStorage;
  linked_kind: string | null;
  linked_id: string | null;
  favorite: number;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  open_count: number;
  deleted_at: number | null;
}

const COLUMNS = `id, kind, title, url, category, note, storage, linked_kind, linked_id, favorite, created_at, updated_at, last_opened_at, open_count, deleted_at`;

function mapRow(row: ResourceRow): ToolResource {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    category: row.category,
    note: row.note,
    storage: row.storage,
    linkedKind: row.linked_kind,
    linkedId: row.linked_id,
    favorite: row.favorite !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    openCount: row.open_count,
    deletedAt: row.deleted_at,
  };
}

export async function listResources(kind: ResourceKind): Promise<ToolResource[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<ResourceRow>(
    `SELECT ${COLUMNS} FROM tool_resources
      WHERE kind = ? AND deleted_at IS NULL
      ORDER BY favorite DESC, COALESCE(last_opened_at, updated_at) DESC`,
    [kind],
  );
  return rows.map(mapRow);
}

export async function getResource(id: string): Promise<ToolResource | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<ResourceRow>(`SELECT ${COLUMNS} FROM tool_resources WHERE id = ?`, [id]);
  return row ? mapRow(row) : null;
}

export async function createResource(input: ResourceInput): Promise<ToolResource> {
  const db = getDatabase();
  const now = Date.now();
  const id = newId(input.kind === "github" ? "gh" : "doc");
  await db.runAsync(
    `INSERT INTO tool_resources (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 0, NULL)`,
    [
      id,
      input.kind,
      input.title.trim() || input.url.trim(),
      input.url.trim(),
      (input.category ?? "").trim(),
      (input.note ?? "").trim(),
      input.storage ?? "online",
      input.linkedKind ?? null,
      input.linkedId ?? null,
      now,
      now,
    ],
  );
  const resource = await getResource(id);
  if (!resource) throw new Error("资料记录写入失败");
  return resource;
}

export interface ResourcePatch {
  title?: string;
  url?: string;
  category?: string | null;
  note?: string | null;
  storage?: ResourceStorage;
  favorite?: boolean;
  linkedKind?: string | null;
  linkedId?: string | null;
}

export async function updateResource(id: string, patch: ResourcePatch): Promise<ToolResource | null> {
  const db = getDatabase();
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.title !== undefined) set("title", patch.title.trim());
  if (patch.url !== undefined) set("url", patch.url.trim());
  if (patch.category !== undefined) set("category", (patch.category ?? "").trim());
  if (patch.note !== undefined) set("note", (patch.note ?? "").trim());
  if (patch.storage !== undefined) set("storage", patch.storage);
  if (patch.favorite !== undefined) set("favorite", patch.favorite ? 1 : 0);
  if (patch.linkedKind !== undefined) set("linked_kind", patch.linkedKind);
  if (patch.linkedId !== undefined) set("linked_id", patch.linkedId);
  if (assignments.length === 0) return getResource(id);
  assignments.push("updated_at = ?");
  values.push(Date.now());
  await db.runAsync(`UPDATE tool_resources SET ${assignments.join(", ")} WHERE id = ?`, [...values, id]);
  return getResource(id);
}

export async function deleteResource(id: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE tool_resources SET deleted_at = ? WHERE id = ?`, [Date.now(), id]);
}

/** 打开一次：记录最近查阅时间与次数（打开动作本身由 UI 调用系统浏览器/应用）。 */
export async function touchResourceOpen(id: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(
    `UPDATE tool_resources SET last_opened_at = ?, open_count = open_count + 1 WHERE id = ? AND deleted_at IS NULL`,
    [Date.now(), id],
  );
}

/** 分类清单（只统计未删除记录，空分类不显示）。 */
export async function listResourceCategories(kind: ResourceKind): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<{ category: string }>(
    `SELECT DISTINCT category FROM tool_resources
      WHERE kind = ? AND deleted_at IS NULL AND category <> ''
      ORDER BY category ASC`,
    [kind],
  );
  return rows.map((row) => row.category);
}
