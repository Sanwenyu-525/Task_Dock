// 收集箱仓储：client_id 唯一索引提供幂等写入（重复提交只落一条）。
//
// 附件不在这里插入（见 db/attachments.ts）：需要「文本 + 附件 + 清暂存」原子落库的场景
// 走 db/captureSave.ts，它复用本文件的 insertCaptureInTx，保持同一事务。
import type { SQLiteDatabase } from "expo-sqlite";

import type { Capture } from "../domain/types";
import { AppError } from "../lib/errors";
import { newId } from "../lib/id";

import { moveAttachmentsOwnerInTx } from "./attachments";
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

/** 校验收集箱正文：空白拒绝，超过 4000 码点拒绝（桌面端同口径）。 */
export function assertCaptureContent(content: string): string {
  const text = content.trim();
  if (!text) throw new AppError("validation", "收集箱内容不能为空");
  if ([...text].length > MAX_CONTENT) {
    throw new AppError("validation", `收集箱内容不能超过 ${MAX_CONTENT} 字`);
  }
  return text;
}

/**
 * 在调用方已开启的事务内插入收集箱条目并登记 outbox。
 *
 * 幂等：client_id 唯一索引命中时不写第二行也不写 outbox，返回 existing 并标记 duplicated。
 * `kind` 固定 text：桌面端 quick_capture 的 kind 白名单只有 task/idea/text/todo/link，
 * 手机端照片/语音靠 attachments 表达，不把自定义类型推给桌面端。
 */
export async function insertCaptureInTx(
  db: SQLiteDatabase,
  input: { content: string; clientId: string; createdAt?: number },
  now: number,
): Promise<{ capture: Capture; duplicated: boolean }> {
  const text = assertCaptureContent(input.content);
  const row: CaptureDbRow = {
    id: newId("c"),
    client_id: input.clientId,
    content: text,
    kind: "text",
    created_at: input.createdAt ?? now,
    rev: 0,
    server_rev: 0,
  };

  const inserted = await db.runAsync(
    `INSERT OR IGNORE INTO captures (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.client_id, row.content, row.kind, row.created_at, row.rev, row.server_rev],
  );
  if (inserted.changes === 0) {
    const existing = await db.getFirstAsync<CaptureDbRow>(
      `SELECT ${COLUMNS} FROM captures WHERE client_id = ?`,
      [row.client_id],
    );
    return { capture: existing ? mapRow(existing) : mapRow(row), duplicated: true };
  }

  await db.runAsync(
    `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId("op"), "capture", row.id, 0, JSON.stringify({ type: "create" }), now],
  );
  return { capture: mapRow(row), duplicated: false };
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
  let outcome: { capture: Capture; duplicated: boolean } | null = null;
  await db.withTransactionAsync(async () => {
    outcome = await insertCaptureInTx(db, { content, clientId }, Date.now());
  });
  if (!outcome) return { capture: null, duplicated: false };
  const result: { capture: Capture; duplicated: boolean } = outcome;
  return { capture: result.capture, duplicated: result.duplicated };
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
    // 附件跟着条目走：只改归属，不复制文件、不重建记录（转任务后原图仍可打开/发送）
    await moveAttachmentsOwnerInTx(db, { entity: "capture", id }, { entity: "task", id: task.id });
    await db.runAsync(`UPDATE captures SET deleted_at = ?, rev = rev + 1 WHERE id = ?`, [now, id]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "capture", id, row.server_rev, JSON.stringify({ type: "promote" }), now],
    );
  });

  return task.id;
}
