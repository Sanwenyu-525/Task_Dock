// 笔记仓储：与 tasks 同一套事务纪律——业务表写与 outbox 入队同事务，rev 每写 +1。
// 独立模式下 outbox 只记录不消费；同步接入后 entity = "note" 直接进协议（SyncEntity 已含 note）。
import type { SQLiteDatabase } from "expo-sqlite";

import type { NewNoteInput, Note } from "../domain/types";
import { AppError } from "../lib/errors";
import { newId } from "../lib/id";
import { buildPatchPayload } from "../lib/sync/protocol";

import { getDatabase } from "./database";

interface NoteDbRow {
  id: string;
  title: string;
  body: string;
  pinned: number;
  favorited: number;
  created_at: number;
  updated_at: number;
  rev: number;
}

/** 列表与读回共用一份列清单，避免两处 SELECT 漂移 */
const NOTE_COLUMNS = `id, title, body, pinned, favorited, created_at, updated_at, rev`;

function mapNoteRow(row: NoteDbRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    pinned: row.pinned === 1,
    favorited: row.favorited === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rev: row.rev,
  };
}

/** 列表顺序：置顶优先，其余按更新时间倒序（与原型「置顶 / 全部笔记」两组一致） */
export async function listNotes(): Promise<Note[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<NoteDbRow>(
    `SELECT ${NOTE_COLUMNS} FROM notes
     WHERE deleted_at IS NULL
     ORDER BY pinned DESC, updated_at DESC`,
  );
  return rows.map(mapNoteRow);
}

export async function getNote(id: string): Promise<Note | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<NoteDbRow>(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return row ? mapNoteRow(row) : null;
}

/**
 * 在调用方已开启的事务内插入笔记并登记 outbox。
 * 单独暴露与 insertTaskInTx 同理由：让跨实体操作保持单事务。
 */
export async function insertNoteInTx(db: SQLiteDatabase, note: Note, now: number): Promise<void> {
  await db.runAsync(
    `INSERT INTO notes (id, title, body, pinned, favorited, created_at, updated_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      note.id,
      note.title,
      note.body,
      note.pinned ? 1 : 0,
      note.favorited ? 1 : 0,
      note.createdAt,
      note.updatedAt,
      note.rev,
    ],
  );
  await db.runAsync(
    `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId("op"), "note", note.id, 0, JSON.stringify({ type: "create", title: note.title }), now],
  );
}

export async function createNote(input: NewNoteInput): Promise<Note> {
  const db = getDatabase();
  const now = Date.now();
  const note: Note = {
    id: newId("n"),
    title: (input.title ?? "").trim(),
    body: input.body ?? "",
    pinned: input.pinned ?? false,
    favorited: input.favorited ?? false,
    createdAt: now,
    updatedAt: now,
    rev: 0,
  };
  await db.withTransactionAsync(() => insertNoteInTx(db, note, now));
  return note;
}

/**
 * 笔记三态更新补丁：键缺失（undefined）= 不改；null = 恢复默认；有值 = 写入。
 * 与 TaskPatch 同语义（docs/MOBILE_STACK.md §3.3）。
 */
export interface NotePatch {
  title?: string | null;
  body?: string | null;
  pinned?: boolean | null;
  favorited?: boolean | null;
}

type PatchKey = keyof NotePatch;

/** camelCase 补丁键 → 数据库列名（SET 子句与 outbox payload 共用同一映射） */
const PATCH_COLUMNS: Record<PatchKey, string> = {
  title: "title",
  body: "body",
  pinned: "pinned",
  favorited: "favorited",
};

/**
 * 三态更新笔记：业务表修改与 outbox 入队同一事务。
 * 返回更新后的 Note；笔记不存在或已软删除时返回 null（不写 outbox）。
 */
export async function updateNote(id: string, patch: NotePatch): Promise<Note | null> {
  const db = getDatabase();
  const now = Date.now();

  let updated: Note | null = null;

  await db.withTransactionAsync(async () => {
    // 在事务内读取当前行：base_rev 与业务字段必须来自同一快照
    const currentRow = await db.getFirstAsync<NoteDbRow & { deleted_at: number | null }>(
      `SELECT ${NOTE_COLUMNS}, deleted_at FROM notes WHERE id = ?`,
      [id],
    );
    if (!currentRow || currentRow.deleted_at != null) return;

    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    /** 供 outbox 使用的逻辑补丁：保持 camelCase 与三态（null 原样保留） */
    const applied: Partial<Record<PatchKey, unknown>> = {};

    const apply = (key: PatchKey, dbValue: string | number | null, logicalValue: unknown): void => {
      assignments.push(`${PATCH_COLUMNS[key]} = ?`);
      values.push(dbValue);
      applied[key] = logicalValue;
    };

    if (patch.title !== undefined) {
      if (patch.title !== null && typeof patch.title !== "string") {
        throw new AppError("validation", "笔记标题必须是字符串或 null");
      }
      const title = patch.title === null ? "" : patch.title.trim();
      apply("title", title, title);
    }

    if (patch.body !== undefined) {
      if (patch.body !== null && typeof patch.body !== "string") {
        throw new AppError("validation", "笔记正文必须是字符串或 null");
      }
      const body = patch.body === null ? "" : patch.body;
      apply("body", body, body);
    }

    for (const key of ["pinned", "favorited"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "boolean") {
        throw new AppError("validation", `${key} 必须是布尔值或 null`);
      }
      // null 恢复默认（不置顶/不收藏）
      const flag = value === null ? false : value;
      apply(key, flag ? 1 : 0, flag);
    }

    // 空补丁不制造一次无意义的 updated_at 变更，也不污染 outbox
    if (assignments.length === 0) {
      updated = mapNoteRow(currentRow);
      return;
    }

    assignments.push("updated_at = ?");
    values.push(now);
    // rev 自增：版本号是同步的冲突判定依据，任何写操作都必须推进
    assignments.push("rev = rev + 1");

    await db.runAsync(`UPDATE notes SET ${assignments.join(", ")} WHERE id = ?`, [...values, id]);

    const row = await db.getFirstAsync<NoteDbRow>(
      `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    if (!row) throw new AppError("storage", "更新后无法读回笔记记录");

    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        newId("op"),
        "note",
        id,
        currentRow.rev,
        // buildPatchPayload 会丢弃 undefined、保留 null，确保「清空」不会在 JSON 里丢失
        JSON.stringify({ type: "update", patch: buildPatchPayload(applied) }),
        now,
      ],
    );

    updated = mapNoteRow(row);
  });

  return updated;
}

/** 软删除：只置 deleted_at，保留行以便后续生成同步墓碑 */
export async function deleteNote(id: string): Promise<void> {
  const db = getDatabase();
  const current = await getNote(id);
  if (!current) return;

  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE notes SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`,
      [now, now, id],
    );
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId("op"), "note", id, current.rev, JSON.stringify({ type: "delete" }), now],
    );
  });
}
