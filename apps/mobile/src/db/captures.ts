// 收集箱仓储：client_id 唯一索引提供幂等写入（重复提交只落一条）。
import type { Capture } from "../domain/types";
import { newId } from "../lib/id";

import { getDatabase } from "./database";
import { buildTask, insertTaskInTx } from "./tasks";

interface CaptureDbRow {
  id: string;
  client_id: string;
  content: string;
  kind: string;
  created_at: number;
  rev: number;
}

const COLUMNS = `id, client_id, content, kind, created_at, rev`;

function mapRow(row: CaptureDbRow): Capture {
  return {
    id: row.id,
    clientId: row.client_id,
    content: row.content,
    kind: "text",
    createdAt: row.created_at,
    rev: row.rev,
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

  const now = Date.now();
  const row: CaptureDbRow = {
    id: newId("c"),
    client_id: clientId,
    content: text,
    kind: "text",
    created_at: now,
    rev: 0,
  };

  // withTransactionAsync 只接受 void 回调，插入结果用外层变量带出
  let changes = 0;
  await db.withTransactionAsync(async () => {
    const inserted = await db.runAsync(
      `INSERT OR IGNORE INTO captures (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.client_id, row.content, row.kind, row.created_at, row.rev],
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
    await db.runAsync(`UPDATE captures SET deleted_at = ? WHERE id = ?`, [now, id]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "capture", id, 0, JSON.stringify({ type: "delete" }), now],
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
    await db.runAsync(`UPDATE captures SET deleted_at = ? WHERE id = ?`, [now, id]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "capture", id, row.rev, JSON.stringify({ type: "promote" }), now],
    );
  });

  return task.id;
}
