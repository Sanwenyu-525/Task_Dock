// 收集箱仓储：client_id 唯一索引提供幂等写入（重复提交只落一条）。
import type { Capture } from "../domain/types";
import { AppError } from "../lib/errors";
import { newId } from "../lib/id";

import { getDatabase } from "./database";
import { buildTask, insertTaskInTx } from "./tasks";

/** 与桌面端 quick_capture::store::MAX_CONTENT 一致（按 Unicode 码点计数）。 */
const MAX_CONTENT = 4000;

interface CaptureDbRow {
  id: string;
  client_id: string;
  content: string;
  kind: string;
  created_at: number;
  rev: number;
  server_rev: number;
}

const COLUMNS = `id, client_id, content, kind, created_at, rev, server_rev`;

function mapRow(row: CaptureDbRow): Capture {
  return {
    id: row.id,
    clientId: row.client_id,
    content: row.content,
    kind: row.kind,
    createdAt: row.created_at,
    rev: row.rev,
    serverRev: row.server_rev,
  };
}

export async function listCaptures(): Promise<Capture[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<CaptureDbRow>(
    `SELECT ${COLUMNS} FROM captures WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  return rows.map(mapRow);
}

export interface AddCaptureResult {
  capture: Capture | null;
  /** true 表示 client_id 已存在，本次未新增（幂等拒绝） */
  duplicated: boolean;
}

export async function addCapture(
  content: string,
  clientId: string = newId("cap"),
): Promise<AddCaptureResult> {
  const db = getDatabase();
  const text = content.trim();
  if (!text) return { capture: null, duplicated: false };
  if ([...text].length > MAX_CONTENT) {
    // 桌面端收集箱上限 4000 字符；超限在本地拦下，避免推上去变成 invalid_patch。
    throw new AppError("validation", `收集箱内容不能超过 ${MAX_CONTENT} 字`);
  }

  const now = Date.now();
  const row: CaptureDbRow = {
    id: newId("c"),
    client_id: clientId,
    content: text,
    kind: "text",
    created_at: now,
    rev: 0,
    server_rev: 0,
  };

  // withTransactionAsync 只接受 void 回调，插入结果用外层变量带出
  let changes = 0;
  await db.withTransactionAsync(async () => {
    const inserted = await db.runAsync(
      `INSERT OR IGNORE INTO captures (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.client_id,
        row.content,
        row.kind,
        row.created_at,
        row.rev,
        row.server_rev,
      ],
    );
    changes = inserted.changes;
    if (changes === 0) return;

    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "capture", row.id, 0, JSON.stringify({ type: "create" }), now],
    );
  });

  if (changes === 0) {
    const existing = await db.getFirstAsync<CaptureDbRow>(
      `SELECT ${COLUMNS} FROM captures WHERE client_id = ?`,
      [clientId],
    );
    return { capture: existing ? mapRow(existing) : null, duplicated: true };
  }

  return { capture: mapRow(row), duplicated: false };
}

export async function deleteCapture(id: string): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    // 在事务内读取 server_rev：base_rev 必须与本次软删除来自同一快照
    const current = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
      "SELECT server_rev, deleted_at FROM captures WHERE id = ?",
      [id],
    );
    if (!current || current.deleted_at != null) return;

    await db.runAsync(`UPDATE captures SET deleted_at = ?, rev = rev + 1 WHERE id = ?`, [now, id]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "capture", id, current.server_rev, JSON.stringify({ type: "delete" }), now],
    );
  });
}

/** 收集箱 → 任务：建任务与删条目在同一事务内，不会出现「两边都在」的中间态 */
export async function promoteCapture(id: string): Promise<string | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<CaptureDbRow>(
    `SELECT ${COLUMNS} FROM captures WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) return null;

  const now = Date.now();
  const firstLine = row.content.split("\n")[0].trim();
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  const task = buildTask({ title: title || "未命名任务", description: row.content }, now);

  await db.withTransactionAsync(async () => {
    await insertTaskInTx(db, task, now);
    await db.runAsync(`UPDATE captures SET deleted_at = ?, rev = rev + 1 WHERE id = ?`, [now, id]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "capture", id, row.server_rev, JSON.stringify({ type: "promote" }), now],
    );
  });

  return task.id;
}
