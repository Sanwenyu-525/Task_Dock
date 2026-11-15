// 采集暂存仓储：拍照 / 录音 / 分享得到的内容在「保存到收集箱 / 任务 / 笔记」之前
// 先落这张表，应用被杀或用户临时退出采集中心后还能恢复。
//
// 与业务表的边界：
// - 暂存项不是业务数据，不进 outbox、不参与同步、不显示在收集箱；
// - 保存时由 db/captureSave.ts 在同一事务里转正（写 attachments）并删除暂存行；
// - 删除暂存行必须同时删除私有存储里的字节，避免留下孤儿文件。
import type { CaptureSource, StashedItem } from "../domain/types";
import { deleteStoredFileQuietly } from "../lib/capture/storage";
import { newId } from "../lib/id";

import { getDatabase } from "./database";

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

/** 暂存合计字节：UI 与上限判定共用，避免两处各算一遍。 */
export function stashTotalBytes(items: readonly StashedItem[]): number {
  return items.reduce((sum, item) => sum + (Number.isFinite(item.size) ? item.size : 0), 0);
}
