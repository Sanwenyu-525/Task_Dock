// API 调试请求仓储：收藏（saved）与历史（history）共用一张表。
//
// 安全纪律（与 domain/tools/apiRequest.ts 的脱敏规则配套）：
// - 写入前一律 redactDraftForHistory：敏感 header 只留末 4 位，疑似密钥的 JSON body 整体省略；
// - 历史最多保留 50 条（按更新时间），自动裁剪，临时数据不会无限堆积；
// - 本表不参与同步、不写 outbox：API 调试请求不混入设备同步链路。
import { getDatabase } from "./database";

import {
  type KeyValueRow,
  type HttpMethod,
  type RequestDraft,
  cloneDraft,
  redactDraftForHistory,
} from "../domain/tools/apiRequest";
import { newId } from "../lib/id";

export type RequestRecordKind = "saved" | "history";

export interface RequestRecord {
  id: string;
  kind: RequestRecordKind;
  name: string;
  draft: RequestDraft;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  deletedAt: number | null;
}

interface RequestRow {
  id: string;
  kind: RequestRecordKind;
  name: string;
  method: HttpMethod;
  url: string;
  query_json: string;
  headers_json: string;
  body: string;
  body_kind: RequestDraft["bodyKind"];
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  deleted_at: number | null;
}

const COLUMNS = `id, kind, name, method, url, query_json, headers_json, body, body_kind, created_at, updated_at, last_used_at, deleted_at`;
const HISTORY_LIMIT = 50;

function parseRows(value: string | null): KeyValueRow[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item != null)
      .map((item, index) => ({
        id: typeof item.id === "string" ? item.id : `row_${index}`,
        name: typeof item.name === "string" ? item.name : "",
        value: typeof item.value === "string" ? item.value : "",
        enabled: item.enabled === undefined ? true : item.enabled === true,
      }));
  } catch {
    return [];
  }
}

function mapRow(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    draft: {
      method: row.method,
      url: row.url,
      query: parseRows(row.query_json),
      headers: parseRows(row.headers_json),
      body: row.body,
      bodyKind: row.body_kind,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    deletedAt: row.deleted_at,
  };
}

export async function listRequests(kind: RequestRecordKind): Promise<RequestRecord[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<RequestRow>(
    `SELECT ${COLUMNS} FROM tool_requests
      WHERE kind = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC`,
    [kind],
  );
  return rows.map(mapRow);
}

export async function getRequest(id: string): Promise<RequestRecord | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<RequestRow>(`SELECT ${COLUMNS} FROM tool_requests WHERE id = ?`, [id]);
  return row ? mapRow(row) : null;
}

/** 保存请求定义（收藏）或追加一条历史。返回写入后的记录（已脱敏）。 */
export async function saveRequest(
  kind: RequestRecordKind,
  draft: RequestDraft,
  options: { name?: string; id?: string } = {},
): Promise<RequestRecord> {
  const db = getDatabase();
  const safe = redactDraftForHistory(cloneDraft(draft));
  const now = Date.now();
  const id = options.id ?? newId("req");
  const name = (options.name ?? "").trim();

  await db.runAsync(
    `INSERT INTO tool_requests (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, method = excluded.method, url = excluded.url,
       query_json = excluded.query_json, headers_json = excluded.headers_json,
       body = excluded.body, body_kind = excluded.body_kind, updated_at = excluded.updated_at`,
    [
      id,
      kind,
      name,
      safe.method,
      safe.url,
      JSON.stringify(safe.query),
      JSON.stringify(safe.headers),
      safe.body,
      safe.bodyKind,
      now,
      now,
      null,
      null,
    ],
  );

  if (kind === "history") {
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM tool_requests WHERE kind = 'history' AND deleted_at IS NULL ORDER BY updated_at DESC`,
    );
    const extra = rows.slice(HISTORY_LIMIT);
    for (const row of extra) {
      await db.runAsync(`DELETE FROM tool_requests WHERE id = ?`, [row.id]);
    }
  }

  const record = await getRequest(id);
  if (!record) throw new Error("请求记录写入失败");
  return record;
}

export async function renameRequest(id: string, name: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE tool_requests SET name = ?, updated_at = ? WHERE id = ?`, [
    name.trim(),
    Date.now(),
    id,
  ]);
}

export async function deleteRequest(id: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE tool_requests SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
    Date.now(),
    Date.now(),
    id,
  ]);
}

export async function touchRequestUse(id: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE tool_requests SET last_used_at = ? WHERE id = ? AND deleted_at IS NULL`, [
    Date.now(),
    id,
  ]);
}

/** 清空历史（用户明确操作）。 */
export async function clearHistory(): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`DELETE FROM tool_requests WHERE kind = 'history'`);
}
