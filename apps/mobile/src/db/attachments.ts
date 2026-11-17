// 附件仓储：收集箱 / 笔记 / 任务共享同一张 attachments 表。
//
// 为什么不做同步实体：同步协议（v1）只承载 task / note / capture 的字段补丁，
// 收集箱在桌面端也没有附件列。附件只在本机持久化，需要送到桌面端时走既有的
// 「文件互传」通道（/v1/files），因此这里不写 outbox、不改协议。
import type { SQLiteDatabase } from "expo-sqlite";

import type {
  Attachment,
  AttachmentKind,
  AttachmentOwner,
  AttachmentTransferState,
} from "../domain/types";
import { deleteStoredFileQuietly, storedFileSize } from "../lib/capture/storage";
import { newId } from "../lib/id";

import { getDatabase } from "./database";

interface AttachmentDbRow {
  id: string;
  owner_entity: string;
  owner_id: string;
  kind: string;
  mime: string;
  name: string;
  local_uri: string;
  size: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  transcript: string | null;
  transfer_state: string;
  transfer_error: string | null;
  remote_file_id: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, owner_entity, owner_id, kind, mime, name, local_uri, size, sha256,
  width, height, duration_ms, transcript, transfer_state, transfer_error, remote_file_id,
  created_at, updated_at`;

const TRANSFER_STATES: readonly AttachmentTransferState[] = [
  "pending",
  "uploading",
  "sent",
  "failed",
  "skipped",
];

function asOwner(value: string): AttachmentOwner {
  return value === "note" || value === "task" ? value : "capture";
}

function asKind(value: string): AttachmentKind {
  return value === "image" || value === "audio" ? value : "file";
}

function asTransferState(value: string): AttachmentTransferState {
  return (TRANSFER_STATES as readonly string[]).includes(value)
    ? (value as AttachmentTransferState)
    : "pending";
}

function mapRow(row: AttachmentDbRow): Attachment {
  return {
    id: row.id,
    ownerEntity: asOwner(row.owner_entity),
    ownerId: row.owner_id,
    kind: asKind(row.kind),
    mime: row.mime,
    name: row.name,
    localUri: row.local_uri,
    size: row.size,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    transcript: row.transcript,
    transferState: asTransferState(row.transfer_state),
    transferError: row.transfer_error,
    remoteFileId: row.remote_file_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewAttachmentInput {
  kind: AttachmentKind;
  mime: string;
  name: string;
  localUri: string;
  size: number;
  sha256?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  transcript?: string | null;
}

/**
 * 在调用方已开启的事务内插入附件行。
 * 单独暴露是为了让「采集转正」保持单事务：业务表 + 附件 + 清暂存要么都成功要么都回滚。
 */
export async function insertAttachmentInTx(
  db: SQLiteDatabase,
  ownerEntity: AttachmentOwner,
  ownerId: string,
  input: NewAttachmentInput,
  now: number,
): Promise<Attachment> {
  const id = newId("att");
  await db.runAsync(
    `INSERT INTO attachments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerEntity,
      ownerId,
      input.kind,
      input.mime,
      input.name,
      input.localUri,
      input.size,
      input.sha256 ?? null,
      input.width ?? null,
      input.height ?? null,
      input.durationMs ?? null,
      input.transcript ?? null,
      "pending",
      null,
      null,
      now,
      now,
    ],
  );
  const row = await db.getFirstAsync<AttachmentDbRow>(
    `SELECT ${COLUMNS} FROM attachments WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error("附件写入后读回失败");
  return mapRow(row);
}

export async function listAttachments(
  ownerEntity: AttachmentOwner,
  ownerId: string,
): Promise<Attachment[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<AttachmentDbRow>(
    `SELECT ${COLUMNS} FROM attachments
      WHERE owner_entity = ? AND owner_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [ownerEntity, ownerId],
  );
  return rows.map(mapRow);
}

/** 列表页用的附件计数（按归属批量读，避免逐条查库）。 */
export async function listAttachmentCounts(
  ownerEntity: AttachmentOwner,
): Promise<Record<string, number>> {
  const db = getDatabase();
  const rows = await db.getAllAsync<{ owner_id: string; n: number }>(
    `SELECT owner_id, COUNT(*) AS n FROM attachments
      WHERE owner_entity = ? AND deleted_at IS NULL
      GROUP BY owner_id`,
    [ownerEntity],
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.owner_id] = row.n;
  return counts;
}

/**
 * 归属实体仍然存在（未被软删除）。
 *
 * 为什么必须参与「待传」查询：任务 / 笔记 / 收集箱被删除后，它们的附件行不会被删
 * （用户的原始素材不能因为删业务记录而被销毁）。如果待传队列不校验归属，用户删掉
 * 一条任务后，前台自动传送仍会把它的照片上传到桌面端——本机已删除的内容被外发，
 * 同时「待传 N」数字永远降不下去。
 *
 * 这里只隐藏、不删行也不删字节；孤儿行与字节的回收属于「本地数据清理」，
 * 不在读取路径里做破坏性操作。
 */
const OWNER_ALIVE_SQL = `(
    (owner_entity = 'task' AND EXISTS (
      SELECT 1 FROM tasks t WHERE t.id = attachments.owner_id AND t.deleted_at IS NULL))
    OR (owner_entity = 'note' AND EXISTS (
      SELECT 1 FROM notes n WHERE n.id = attachments.owner_id AND n.deleted_at IS NULL))
    OR (owner_entity = 'capture' AND EXISTS (
      SELECT 1 FROM captures c WHERE c.id = attachments.owner_id AND c.deleted_at IS NULL))
  )`;

/** 需要发送到桌面端的附件：pending（从未尝试）与 failed（可重试）。 */
export async function listAttachmentsForTransfer(
  limit = 20,
  states: readonly AttachmentTransferState[] = ["pending", "failed"],
): Promise<Attachment[]> {
  const db = getDatabase();
  const placeholders = states.map(() => "?").join(", ");
  const rows = await db.getAllAsync<AttachmentDbRow>(
    `SELECT ${COLUMNS} FROM attachments
      WHERE deleted_at IS NULL AND transfer_state IN (${placeholders})
        AND ${OWNER_ALIVE_SQL}
      ORDER BY created_at ASC
      LIMIT ?`,
    [...states, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map(mapRow);
}

/**
 * 附件与本机文件对账：文件已缺失的待发送附件标记为 failed，理由写清。
 *
 * 为什么需要：附件元数据与字节是两条生命周期。用户清缓存、系统回收、外部工具删除
 * 都会让 `local_uri` 指向不存在的文件；如果不校正，同步页会一直显示「待传附件」，
 * 用户点发送才拿到一个笼统失败，属于对用户撒谎。sent 的不动（桌面端已有副本）。
 */
export async function markAttachmentsMissingFiles(): Promise<number> {
  const db = getDatabase();
  const rows = await db.getAllAsync<{ id: string; local_uri: string }>(
    `SELECT id, local_uri FROM attachments
      WHERE deleted_at IS NULL AND transfer_state IN ('pending', 'uploading')`,
  );
  const missing = rows.filter((row) => storedFileSize(row.local_uri) <= 0).map((row) => row.id);
  if (missing.length === 0) return 0;
  for (const id of missing) {
    await db.runAsync(
      `UPDATE attachments
          SET transfer_state = 'failed', transfer_error = '本机文件已缺失，请重新采集', updated_at = ?
        WHERE id = ?`,
      [Date.now(), id],
    );
  }
  return missing.length;
}

/** 按 id 精确读取附件（显式「发送本次附件」用它，避免按全局时间队列误取历史文件）。 */
export async function getAttachmentsByIds(ids: readonly string[]): Promise<Attachment[]> {
  if (ids.length === 0) return [];
  const db = getDatabase();
  const out: Attachment[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db.getAllAsync<AttachmentDbRow>(
      `SELECT ${COLUMNS} FROM attachments
        WHERE deleted_at IS NULL AND id IN (${placeholders})
        ORDER BY created_at ASC`,
      chunk,
    );
    out.push(...rows.map(mapRow));
  }
  return out;
}

/**
 * 启动对账：上次进程在 uploading 状态被杀，重启后不能永远卡在「正在传输」。
 *
 * 不直接回到 pending：远端可能已收到一份，自动重传会制造重复文件；标成 failed +
 * 明确原因，让同步页显示「可重试」，由用户或显式发送再决定。
 */
export async function resetInterruptedUploads(): Promise<number> {
  const db = getDatabase();
  const result = await db.runAsync(
    `UPDATE attachments
        SET transfer_state = 'failed', transfer_error = '上次传输中断，可重试', updated_at = ?
      WHERE deleted_at IS NULL AND transfer_state = 'uploading'`,
    [Date.now()],
  );
  return result.changes;
}

export async function countAttachmentsForTransfer(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attachments
      WHERE deleted_at IS NULL AND transfer_state IN ('pending', 'failed')
        AND ${OWNER_ALIVE_SQL}`,
  );
  return row?.n ?? 0;
}

export async function setAttachmentTransferState(
  id: string,
  state: AttachmentTransferState,
  extra: { error?: string | null; remoteFileId?: string | null } = {},
): Promise<void> {
  const db = getDatabase();
  await db.runAsync(
    `UPDATE attachments
        SET transfer_state = ?, transfer_error = ?, remote_file_id = COALESCE(?, remote_file_id),
            updated_at = ?
      WHERE id = ?`,
    [state, extra.error ?? null, extra.remoteFileId ?? null, Date.now(), id],
  );
}

/** 语音转写结果：用户手写或系统识别，三态（undefined 不改，null 清空）。 */
export async function updateAttachmentTranscript(
  id: string,
  transcript: string | null,
): Promise<void> {
  const db = getDatabase();
  await db.runAsync("UPDATE attachments SET transcript = ?, updated_at = ? WHERE id = ?", [
    transcript,
    Date.now(),
    id,
  ]);
}

/** 解除配对/清理时用：软删除附件并删除本机字节（用户显式删除才走这里）。 */
export async function deleteAttachment(id: string): Promise<void> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ local_uri: string }>(
    "SELECT local_uri FROM attachments WHERE id = ?",
    [id],
  );
  await db.runAsync("UPDATE attachments SET deleted_at = ?, updated_at = ? WHERE id = ?", [
    Date.now(),
    Date.now(),
    id,
  ]);
  deleteStoredFileQuietly(row?.local_uri);
}

/** 收集箱转任务：把附件归属改到新任务，文件不复制、不重建。 */
export async function moveAttachmentsOwnerInTx(
  db: SQLiteDatabase,
  from: { entity: AttachmentOwner; id: string },
  to: { entity: AttachmentOwner; id: string },
): Promise<number> {
  const result = await db.runAsync(
    `UPDATE attachments SET owner_entity = ?, owner_id = ?, updated_at = ?
      WHERE owner_entity = ? AND owner_id = ? AND deleted_at IS NULL`,
    [to.entity, to.id, Date.now(), from.entity, from.id],
  );
  return result.changes;
}
