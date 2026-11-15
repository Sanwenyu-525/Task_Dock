// 采集暂存仓储：拍照 / 录音 / 分享得到的内容在「保存到收集箱 / 任务 / 笔记」之前
// 先落这张表，应用被杀或用户临时退出采集中心后还能恢复。
//
// 与业务表的边界：
// - 暂存项不是业务数据，不进 outbox、不参与同步、不显示在收集箱；
// - 保存时由 db/captureSave.ts 在同一事务里转正（写 attachments）并删除暂存行；
// - 删除暂存行必须同时删除私有存储里的字节，避免留下孤儿文件。
import type { SQLiteDatabase } from "expo-sqlite";

import type { CaptureSource, StashedItem } from "../domain/types";
import {
  MAX_CAPTURE_ITEM_BYTES,
  MAX_CAPTURE_ITEMS,
  MAX_CAPTURE_TOTAL_BYTES,
  stashTotalBytes,
} from "../lib/capture/limits";
import { deleteStoredFileQuietly } from "../lib/capture/storage";
import { AppError } from "../lib/errors";
import { newId } from "../lib/id";

import { getDatabase } from "./database";

export { stashTotalBytes };

interface StashDbRow {
  id: string;
  kind: string;
  mime: string;
  name: string;
  local_uri: string;
  size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  transcript: string | null;
  note: string;
  source: string;
  created_at: number;
}

const COLUMNS = `id, kind, mime, name, local_uri, size, width, height, duration_ms, transcript, note, source, created_at`;

function mapRow(row: StashDbRow): StashedItem {
  return {
    id: row.id,
    kind: row.kind === "image" || row.kind === "audio" ? row.kind : "file",
    mime: row.mime,
    name: row.name,
    localUri: row.local_uri,
    size: row.size,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    transcript: row.transcript,
    note: row.note,
    source: row.source as CaptureSource,
    createdAt: row.created_at,
  };
}

export async function listStash(): Promise<StashedItem[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<StashDbRow>(
    `SELECT ${COLUMNS} FROM capture_stash ORDER BY created_at ASC, rowid ASC`,
  );
  return rows.map(mapRow);
}

export interface NewStashItem {
  kind: StashedItem["kind"];
  mime: string;
  name: string;
  localUri: string;
  size: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  transcript?: string | null;
  note?: string;
  source: CaptureSource;
}

/** 写入一条暂存项；返回落库后的对象（id 与时间由本层生成）。 */
export async function addStashItem(input: NewStashItem): Promise<StashedItem> {
  const db = getDatabase();
  // 数据库层守卫：即使 UI 预检漏算或两次并发导入同时通过预检，也不能写入超限数据。
  // 上限与 lib/capture/limits.ts、原生分享 Kotlin 三处同源。
  const usage = await db.getFirstAsync<{ n: number; bytes: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM capture_stash",
  );
  const count = usage?.n ?? 0;
  const bytes = usage?.bytes ?? 0;
  if (count >= MAX_CAPTURE_ITEMS) {
    throw new AppError("validation", `一次最多 ${MAX_CAPTURE_ITEMS} 项，请先保存或删除部分内容`);
  }
  if (input.size > MAX_CAPTURE_ITEM_BYTES) {
    throw new AppError(
      "validation",
      `单个附件不能超过 ${Math.round(MAX_CAPTURE_ITEM_BYTES / (1024 * 1024))}MB`,
    );
  }
  if (bytes + input.size > MAX_CAPTURE_TOTAL_BYTES) {
    throw new AppError(
      "validation",
      `本次采集附件合计不能超过 ${Math.round(MAX_CAPTURE_TOTAL_BYTES / (1024 * 1024))}MB，请先保存或移除部分内容`,
    );
  }
  const now = Date.now();
  const item: StashedItem = {
    id: newId("st"),
    kind: input.kind,
    mime: input.mime,
    name: input.name,
    localUri: input.localUri,
    size: input.size,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    transcript: input.transcript ?? null,
    note: input.note ?? "",
    source: input.source,
    createdAt: now,
  };
  await db.runAsync(
    `INSERT INTO capture_stash (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.kind,
      item.mime,
      item.name,
      item.localUri,
      item.size,
      item.width,
      item.height,
      item.durationMs,
      item.transcript,
      item.note,
      item.source,
      item.createdAt,
    ],
  );
  return item;
}

/** 就地更新暂存项的说明/转写文本（三态：undefined 不改，null 清空）。 */
export async function updateStashItem(
  id: string,
  patch: { note?: string | null; transcript?: string | null },
): Promise<void> {
  const db = getDatabase();
  const current = await db.getFirstAsync<StashDbRow>(`SELECT ${COLUMNS} FROM capture_stash WHERE id = ?`, [
    id,
  ]);
  if (!current) return;
  const note = patch.note === undefined ? current.note : patch.note ?? "";
  const transcript = patch.transcript === undefined ? current.transcript : patch.transcript;
  await db.runAsync("UPDATE capture_stash SET note = ?, transcript = ? WHERE id = ?", [
    note,
    transcript,
    id,
  ]);
}

/** 移除一条暂存项：先删行再删文件，文件删除失败不影响用户继续操作。 */
export async function removeStashItem(id: string): Promise<void> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ local_uri: string }>(
    "SELECT local_uri FROM capture_stash WHERE id = ?",
    [id],
  );
  await db.runAsync("DELETE FROM capture_stash WHERE id = ?", [id]);
  deleteStoredFileQuietly(row?.local_uri);
}

/** 清空暂存（用户取消 / 保存完成后调用）。 */
export async function clearStash(): Promise<void> {
  const db = getDatabase();
  const rows = await db.getAllAsync<{ local_uri: string }>("SELECT local_uri FROM capture_stash");
  await db.runAsync("DELETE FROM capture_stash");
  for (const row of rows) deleteStoredFileQuietly(row.local_uri);
}

/**
 * 只删除本次成功保存的暂存行（调用方已在事务内）。
 *
 * 绝不能用 `DELETE FROM capture_stash`：暂存表是全局的，另一个采集会话（或系统分享
 * 中途接入的内容）可能同时存在，整表清空会直接丢用户内容。这里按 id 精确删除，
 * 且文件字节已被附件行持有，不删文件。
 */
export async function deleteStashItemsInTx(
  db: SQLiteDatabase,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  let changes = 0;
  // SQLite 单条语句参数有上限，按 50 个一组删除（采集上限 9，正常只有一批）
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db.runAsync(
      `DELETE FROM capture_stash WHERE id IN (${placeholders})`,
      chunk,
    );
    changes += result.changes;
  }
  return changes;
}

/** 当前暂存项数量（UI 预检/并发导入时读取真实值，不依赖 React state）。 */
export async function countStashItems(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM capture_stash");
  return row?.n ?? 0;
}
