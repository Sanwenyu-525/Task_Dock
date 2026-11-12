// 同步落库层：pull 应用、outbox 合并、push 结果结算与冲突存储。
//
// 原则：
// - pull 只写业务表，绝不写 outbox；
// - 本地有未发送操作（outbox）的记录，pull 不覆盖，交给 push 的 base_rev 冲突判定；
// - push 成功的记录清空 outbox；冲突清空 outbox 并写 sync_conflicts，等用户处理；
// - 服务端版本号存 server_rev，下一次本地编辑的 base_rev 用它，而不是本地 rev。
// - 实体：task / note / capture；三者共用同一套 outbox 与冲突表。
import type { SQLiteDatabase } from "expo-sqlite";

import type { Change, Op, PushResult, SyncEntity, SyncPatch } from "../lib/sync/protocol";
import { buildPatchPayload } from "../lib/sync/protocol";

import { getDatabase } from "./database";
import { getSetting, setSetting } from "./kv";
import { newId } from "../lib/id";

const CURSOR_KEY = "sync.cursor.v1";
const LAST_RESULT_KEY = "sync.last_result.v1";

export interface SyncLastResult {
  at: number;
  pulled: number;
  applied: number;
  pushed: number;
  conflicts: number;
  error?: string;
}

export interface PullApplyResult {
  applied: number;
  deleted: number;
  skipped: number;
}

export interface PendingOp {
  op: Op;
  entity: SyncEntity;
  targetId: string;
  /** 生成本次 op 时 outbox 的最大时间戳：结算只清理这批，不误删同步期间的新编辑 */
  maxCreatedAt: number;
}

export interface SyncConflictRow {
  op_id: string;
  entity: string;
  target_id: string;
  reason: string;
  server_json: string | null;
  created_at: number;
}

export async function loadSyncCursor(): Promise<string> {
  return (await getSetting(CURSOR_KEY)) ?? "";
}

export async function saveSyncCursor(cursor: string): Promise<void> {
  await setSetting(CURSOR_KEY, cursor);
}

export async function loadSyncResult(): Promise<SyncLastResult | null> {
  const raw = await getSetting(LAST_RESULT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SyncLastResult>;
    if (typeof value.at !== "number") return null;
    return {
      at: value.at,
      pulled: typeof value.pulled === "number" ? value.pulled : 0,
      applied: typeof value.applied === "number" ? value.applied : 0,
      pushed: typeof value.pushed === "number" ? value.pushed : 0,
      conflicts: typeof value.conflicts === "number" ? value.conflicts : 0,
      error: typeof value.error === "string" ? value.error : undefined,
    };
  } catch {
    return null;
  }
}

export async function saveSyncResult(result: SyncLastResult): Promise<void> {
  await setSetting(LAST_RESULT_KEY, JSON.stringify(result));
}

/** 解除配对时清空游标、最近结果与待处理冲突（本机不再保留对端同步状态）。 */
export async function resetSyncState(): Promise<void> {
  const db = getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM sync_conflicts");
    // 对端可能换成另一台桌面端：服务端 seq 不保证可比，全部清零后由下一次 pull 重建。
    await db.runAsync("UPDATE tasks SET server_rev = 0 WHERE server_rev <> 0");
    await db.runAsync("UPDATE notes SET server_rev = 0 WHERE server_rev <> 0");
    await db.runAsync("UPDATE captures SET server_rev = 0 WHERE server_rev <> 0");
    await db.runAsync(
      `UPDATE outbox SET base_rev = 0
        WHERE entity IN ('task', 'note', 'capture') AND base_rev <> 0`,
    );
  });
  await setSetting(CURSOR_KEY, "");
  await db.runAsync("DELETE FROM kv WHERE key = ?", [LAST_RESULT_KEY]);
}

interface TaskFields {
  title: string;
  description: string;
  status: string;
  priority: number;
  category: string | null;
  tags: string;
  dueAt: number | null;
  remindAt: number | null;
  advanceMinutes: number | null;
  recurrenceRule: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function parseTaskFields(fields: Record<string, unknown>): TaskFields {
  const rawTags = fields.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const priority = Math.min(Math.max(asNumber(fields.priority, 0), 0), 3);
  return {
    title: asString(fields.title),
    description: asString(fields.description),
    status: fields.status === "completed" ? "completed" : "pending",
    priority,
    category: asNullableString(fields.category),
    tags: JSON.stringify(tags),
    dueAt: asNullableNumber(fields.dueAt),
    remindAt: asNullableNumber(fields.remindAt),
    advanceMinutes: asNullableNumber(fields.advanceMinutes),
    recurrenceRule: asNullableString(fields.recurrenceRule),
    createdAt: asNumber(fields.createdAt, Date.now()),
    updatedAt: asNumber(fields.updatedAt, Date.now()),
    completedAt: asNullableNumber(fields.completedAt),
  };
}

type ApplyOutcome = "applied" | "deleted" | "skipped";

async function hasPendingOutbox(
  db: SQLiteDatabase,
  entity: SyncEntity,
  id: string,
): Promise<boolean> {
  const pending = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM outbox WHERE entity = ? AND target_id = ?",
    [entity, id],
  );
  return (pending?.n ?? 0) > 0;
}

async function applyTaskChange(db: SQLiteDatabase, change: Change): Promise<ApplyOutcome> {
  if (await hasPendingOutbox(db, "task", change.id)) return "skipped";

  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM tasks WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return "skipped";
    // 旧墓碑（rev <= server_rev）不得覆盖更新版本的记录：与内容更新的
    // 版本比较对称。否则重放/游标重置后，晚到的旧墓碑会把较新的本地
    // 内容删掉并把 server_rev 拨回去（2026-11-12 修复）。
    if (change.rev <= existing.server_rev) return "skipped";
    const now = Date.now();
    await db.runAsync(
      "UPDATE tasks SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = ? WHERE id = ?",
      [now, now, change.rev, change.id],
    );
    return "deleted";
  }

  // 旧变更晚到（分页重放）时不回退已应用的版本。
  if (existing && change.rev <= existing.server_rev) return "skipped";

  const fields = parseTaskFields(change.fields);
  if (existing) {
    await db.runAsync(
      `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, category = ?,
                        tags = ?, due_at = ?, remind_at = ?, advance_minutes = ?,
                        recurrence_rule = ?, created_at = ?, updated_at = ?, completed_at = ?,
                        rev = rev + 1, server_rev = ?, deleted_at = NULL
         WHERE id = ?`,
      [
        fields.title,
        fields.description,
        fields.status,
        fields.priority,
        fields.category,
        fields.tags,
        fields.dueAt,
        fields.remindAt,
        fields.advanceMinutes,
        fields.recurrenceRule,
        fields.createdAt,
        fields.updatedAt,
        fields.completedAt,
        change.rev,
        change.id,
      ],
    );
  } else {
    await db.runAsync(
      `INSERT INTO tasks (id, title, description, status, priority, category, tags,
                          due_at, remind_at, advance_minutes, recurrence_rule,
                          created_at, updated_at, completed_at, rev, server_rev, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
      [
        change.id,
        fields.title,
        fields.description,
        fields.status,
        fields.priority,
        fields.category,
        fields.tags,
        fields.dueAt,
        fields.remindAt,
        fields.advanceMinutes,
        fields.recurrenceRule,
        fields.createdAt,
        fields.updatedAt,
        fields.completedAt,
        change.rev,
      ],
    );
  }
  return "applied";
}

interface NoteFields {
  title: string;
  body: string;
  pinned: number;
  favorited: number;
  createdAt: number;
  updatedAt: number;
}

function parseNoteFields(fields: Record<string, unknown>): NoteFields {
  return {
    title: asString(fields.title),
    body: asString(fields.body),
    pinned: fields.pinned === true ? 1 : 0,
    favorited: fields.favorited === true ? 1 : 0,
    createdAt: asNumber(fields.createdAt, Date.now()),
    updatedAt: asNumber(fields.updatedAt, Date.now()),
  };
}

async function applyNoteChange(db: SQLiteDatabase, change: Change): Promise<ApplyOutcome> {
  if (await hasPendingOutbox(db, "note", change.id)) return "skipped";

  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM notes WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return "skipped";
    // 同 applyTaskChange：旧墓碑不得回退较新记录（2026-11-12 修复）。
    if (change.rev <= existing.server_rev) return "skipped";
    const now = Date.now();
    await db.runAsync(
      "UPDATE notes SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = ? WHERE id = ?",
      [now, now, change.rev, change.id],
    );
    return "deleted";
  }

  if (existing && change.rev <= existing.server_rev) return "skipped";

  const fields = parseNoteFields(change.fields);
  if (existing) {
    await db.runAsync(
      `UPDATE notes SET title = ?, body = ?, pinned = ?, favorited = ?, created_at = ?,
                        updated_at = ?, rev = rev + 1, server_rev = ?, deleted_at = NULL
         WHERE id = ?`,
      [
        fields.title,
        fields.body,
        fields.pinned,
        fields.favorited,
        fields.createdAt,
        fields.updatedAt,
        change.rev,
        change.id,
      ],
    );
  } else {
    await db.runAsync(
      `INSERT INTO notes (id, title, body, pinned, favorited, created_at, updated_at,
                          rev, server_rev, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
      [
        change.id,
        fields.title,
        fields.body,
        fields.pinned,
        fields.favorited,
        fields.createdAt,
        fields.updatedAt,
        change.rev,
      ],
    );
  }
  return "applied";
}

interface CaptureFields {
  clientId: string;
  content: string;
  kind: string;
  createdAt: number;
}

function parseCaptureFields(fields: Record<string, unknown>): CaptureFields {
  return {
    clientId: asString(fields.clientId),
    content: asString(fields.content),
    kind: asString(fields.kind, "text") || "text",
    createdAt: asNumber(fields.createdAt, Date.now()),
  };
}

async function applyCaptureChange(db: SQLiteDatabase, change: Change): Promise<ApplyOutcome> {
  if (await hasPendingOutbox(db, "capture", change.id)) return "skipped";

  const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
    "SELECT server_rev, deleted_at FROM captures WHERE id = ?",
    [change.id],
  );

  if (change.deleted) {
    if (!existing) return "skipped";
    // 同 applyTaskChange：旧墓碑不得回退较新记录（2026-11-12 修复）。
    if (change.rev <= existing.server_rev) return "skipped";
    const now = Date.now();
    await db.runAsync(
      "UPDATE captures SET deleted_at = ?, rev = rev + 1, server_rev = ? WHERE id = ?",
      [now, change.rev, change.id],
    );
    return "deleted";
  }

  if (existing && change.rev <= existing.server_rev) return "skipped";

  const fields = parseCaptureFields(change.fields);
  if (!fields.clientId) return "skipped";

  // client_id 唯一索引：同一条目换 id 下发时不能静默覆盖另一条本地记录。
  const clash = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM captures WHERE client_id = ? AND id <> ?",
    [fields.clientId, change.id],
  );
  if (clash) return "skipped";

  if (existing) {
    await db.runAsync(
      `UPDATE captures SET client_id = ?, content = ?, kind = ?, created_at = ?,
                           rev = rev + 1, server_rev = ?, deleted_at = NULL
         WHERE id = ?`,
      [fields.clientId, fields.content, fields.kind, fields.createdAt, change.rev, change.id],
    );
  } else {
    await db.runAsync(
      `INSERT INTO captures (id, client_id, content, kind, created_at, deleted_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?)`,
      [change.id, fields.clientId, fields.content, fields.kind, fields.createdAt, change.rev],
    );
  }
  return "applied";
}

/**
 * 应用一页 pull 变更。
 *
 * 同一记录在日志里可能出现多次（更新数次），按顺序应用即可；服务端游标保证不漏页。
 * 本地存在未发送 outbox 时跳过该记录：push 会带着旧 base_rev 得到冲突，由用户决定。
 */
export async function applyPullChanges(changes: readonly Change[]): Promise<PullApplyResult> {
  const db = getDatabase();
  let applied = 0;
  let deleted = 0;
  let skipped = 0;

  await db.withTransactionAsync(async () => {
    for (const change of changes) {
      let outcome: ApplyOutcome;
      switch (change.entity) {
        case "task":
          outcome = await applyTaskChange(db, change);
          break;
        case "note":
          outcome = await applyNoteChange(db, change);
          break;
        case "capture":
          outcome = await applyCaptureChange(db, change);
          break;
        default:
          outcome = "skipped";
      }
      if (outcome === "applied") applied += 1;
      else if (outcome === "deleted") deleted += 1;
      else skipped += 1;
    }
  });

  return { applied, deleted, skipped };
}

interface OutboxRow {
  op_id: string;
  entity: string;
  target_id: string;
  base_rev: number;
  payload: string;
  created_at: number;
}

interface PendingGroup {
  opId: string;
  entity: SyncEntity;
  targetId: string;
  baseRev: number;
  deleted: boolean;
  maxCreatedAt: number;
}

function isSyncEntity(value: string): value is SyncEntity {
  return value === "task" || value === "note" || value === "capture";
}

/**
 * 把 outbox 按「实体 + 记录」合并成 push 操作：同一条记录的多次编辑只发一次，
 * base_rev 取最早一次本地编辑时的服务端版本（冲突判定更保守）。
 * 删除/转任务（promote）统一映射为墓碑。
 */
export async function buildPendingOps(): Promise<PendingOp[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<OutboxRow>(
    `SELECT op_id, entity, target_id, base_rev, payload, created_at
       FROM outbox
      WHERE entity IN ('task', 'note', 'capture') AND state IN ('pending', 'failed')
      ORDER BY created_at ASC, rowid ASC`,
  );

  const groups = new Map<string, PendingGroup>();
  for (const row of rows) {
    if (!isSyncEntity(row.entity)) continue;
    const key = `${row.entity}:${row.target_id}`;
    const type = payloadType(row.payload);
    const deleted = type === "delete" || type === "promote";
    const existing = groups.get(key);
    if (existing) {
      if (deleted) existing.deleted = true;
      existing.maxCreatedAt = Math.max(existing.maxCreatedAt, row.created_at);
      continue;
    }
    groups.set(key, {
      opId: row.op_id,
      entity: row.entity,
      targetId: row.target_id,
      baseRev: row.base_rev,
      deleted,
      maxCreatedAt: row.created_at,
    });
  }

  const ops: PendingOp[] = [];
  for (const group of groups.values()) {
    const push = (patch: SyncPatch, deleted = false): void => {
      ops.push({
        entity: group.entity,
        targetId: group.targetId,
        maxCreatedAt: group.maxCreatedAt,
        op: {
          op_id: group.opId,
          entity: group.entity,
          id: group.targetId,
          base_rev: group.baseRev,
          patch,
          ...(deleted ? { deleted: true } : {}),
        },
      });
    };

    if (group.deleted) {
      // 本地已删除：即使行已被软删除也要把墓碑发出去。
      push({}, true);
      continue;
    }

    if (group.entity === "task") {
      const task = await db.getFirstAsync<{
        title: string;
        description: string;
        status: string;
        priority: number;
        category: string | null;
        tags: string | null;
        due_at: number | null;
        remind_at: number | null;
        advance_minutes: number | null;
        recurrence_rule: string | null;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        deleted_at: number | null;
      }>("SELECT * FROM tasks WHERE id = ?", [group.targetId]);

      if (!task || task.deleted_at != null) {
        // 本地删了但没有删除操作（异常状态）：跳过，避免把半截数据推上去。
        continue;
      }

      push(
        buildPatchPayload({
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          category: task.category,
          tags: parseTags(task.tags),
          dueAt: task.due_at,
          remindAt: task.remind_at,
          advanceMinutes: task.advance_minutes,
          recurrenceRule: task.recurrence_rule,
          createdAt: task.created_at,
          completedAt: task.completed_at,
        }),
      );
      continue;
    }

    if (group.entity === "note") {
      const note = await db.getFirstAsync<{
        title: string;
        body: string;
        pinned: number;
        favorited: number;
        created_at: number;
        deleted_at: number | null;
      }>("SELECT * FROM notes WHERE id = ?", [group.targetId]);

      if (!note || note.deleted_at != null) continue;
      push(
        buildPatchPayload({
          title: note.title,
          body: note.body,
          pinned: note.pinned === 1,
          favorited: note.favorited === 1,
          createdAt: note.created_at,
        }),
      );
      continue;
    }

    const capture = await db.getFirstAsync<{
      client_id: string;
      content: string;
      kind: string;
      created_at: number;
      deleted_at: number | null;
    }>("SELECT * FROM captures WHERE id = ?", [group.targetId]);

    if (!capture || capture.deleted_at != null) continue;
    push(
      buildPatchPayload({
        clientId: capture.client_id,
        content: capture.content,
        kind: capture.kind,
        createdAt: capture.created_at,
      }),
    );
  }

  return ops;
}

function payloadType(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : "";
  } catch {
    return "";
  }
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 结算 push：ack 清空 outbox；冲突清空 outbox 并落库等待处理。
 * 不做自动重试：冲突必须由用户决定保留哪一端。
 */
export async function settlePush(
  result: PushResult,
  pending: readonly PendingOp[],
): Promise<void> {
  const db = getDatabase();
  const byOpId = new Map(pending.map((item) => [item.op.op_id, item]));

  interface AckKey {
    entity: SyncEntity;
    targetId: string;
    maxCreatedAt: number;
  }
  const acked = new Map<string, AckKey>();
  for (const opId of result.ack) {
    const item = byOpId.get(opId);
    if (!item) continue;
    const key = `${item.entity}:${item.targetId}`;
    const existing = acked.get(key);
    acked.set(key, {
      entity: item.entity,
      targetId: item.targetId,
      maxCreatedAt: Math.max(existing?.maxCreatedAt ?? 0, item.maxCreatedAt),
    });
  }

  const conflictRows: Array<SyncConflictRow & { maxCreatedAt: number }> = [];
  for (const conflict of result.conflicts) {
    const item = byOpId.get(conflict.op_id);
    if (!item) continue;
    conflictRows.push({
      op_id: conflict.op_id,
      entity: item.entity,
      target_id: item.targetId,
      reason: conflict.reason,
      server_json: conflict.server_record ? JSON.stringify(conflict.server_record) : null,
      created_at: Date.now(),
      maxCreatedAt: item.maxCreatedAt,
    });
  }

  await db.withTransactionAsync(async () => {
    // 只删本批快照里的 outbox：同步请求期间用户继续编辑产生的新行必须保留。
    for (const item of acked.values()) {
      await db.runAsync(
        "DELETE FROM outbox WHERE entity = ? AND target_id = ? AND created_at <= ?",
        [item.entity, item.targetId, item.maxCreatedAt],
      );
    }
    for (const row of conflictRows) {
      // 冲突不删 outbox，改置 state='conflict' 守卫：
      // - pull 继续跳过该记录，本地未决版本不被服务端版本覆盖（等用户决定）；
      // - buildPendingOps 只取 pending/failed，不会把冲突记录反复重发；
      // - 用户在冲突页「采用桌面端 / 保留本机」时再清理守卫行（见 resolve*）。
      // 2026-11-12 修复：原先冲突即删 outbox，随后引擎的再 pull 会用服务端
      // 版本静默覆盖本地未决修改，「保留本机」实际无本机可保留。
      await db.runAsync(
        "UPDATE outbox SET state = 'conflict' WHERE entity = ? AND target_id = ? AND created_at <= ?",
        [row.entity, row.target_id, row.maxCreatedAt],
      );
      await db.runAsync(
        `INSERT OR REPLACE INTO sync_conflicts
           (op_id, entity, target_id, reason, server_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.op_id, row.entity, row.target_id, row.reason, row.server_json, row.created_at],
      );
    }
  });
}

export async function listSyncConflicts(): Promise<SyncConflictRow[]> {
  const db = getDatabase();
  return db.getAllAsync<SyncConflictRow>(
    "SELECT op_id, entity, target_id, reason, server_json, created_at FROM sync_conflicts ORDER BY created_at DESC",
  );
}

export async function countSyncConflicts(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sync_conflicts",
  );
  return row?.n ?? 0;
}

/** 统计本轮可发送的操作（任务 / 笔记 / 收集箱）。 */
export async function countPendingSyncOps(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox
      WHERE entity IN ('task', 'note', 'capture') AND state IN ('pending', 'failed')`,
  );
  return row?.n ?? 0;
}

function parseServerRecord(raw: string | null): Change | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Change;
    return typeof value.rev === "number" && typeof value.id === "string" ? value : null;
  } catch {
    return null;
  }
}

function conflictEntity(value: string): SyncEntity | null {
  return value === "task" || value === "note" || value === "capture" ? value : null;
}

/** 桌面端没有该记录时，「采用桌面端」等价于软删除本地副本。 */
async function softDeleteLocalCopy(entity: SyncEntity, id: string): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  switch (entity) {
    case "task":
      await db.runAsync(
        "UPDATE tasks SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = 0 WHERE id = ?",
        [now, now, id],
      );
      break;
    case "note":
      await db.runAsync(
        "UPDATE notes SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = 0 WHERE id = ?",
        [now, now, id],
      );
      break;
    case "capture":
      await db.runAsync(
        "UPDATE captures SET deleted_at = ?, rev = rev + 1, server_rev = 0 WHERE id = ?",
        [now, id],
      );
      break;
  }
}

/** 采用桌面端版本：清掉该记录的冲突守卫行，应用服务端版本，删除冲突记录。 */
export async function resolveConflictWithServer(conflict: SyncConflictRow): Promise<void> {
  const db = getDatabase();
  const entity = conflictEntity(conflict.entity);
  const change = parseServerRecord(conflict.server_json);
  if (change) {
    // 先清 state='conflict' 的守卫行，否则 applyPullChanges 会按「本地未发送」跳过。
    await db.runAsync(
      "DELETE FROM outbox WHERE entity = ? AND target_id = ? AND state = 'conflict'",
      [entity ?? "", conflict.target_id],
    );
    await applyPullChanges([change]);
  } else {
    if (entity) {
      await db.runAsync(
        "DELETE FROM outbox WHERE entity = ? AND target_id = ? AND state = 'conflict'",
        [entity, conflict.target_id],
      );
      await softDeleteLocalCopy(entity, conflict.target_id);
    }
  }
  await db.runAsync("DELETE FROM sync_conflicts WHERE op_id = ?", [conflict.op_id]);
}

async function isLocalDeleted(entity: SyncEntity, id: string): Promise<boolean> {
  const db = getDatabase();
  const table = entity === "task" ? "tasks" : entity === "note" ? "notes" : "captures";
  const row = await db.getFirstAsync<{ deleted_at: number | null }>(
    `SELECT deleted_at FROM ${table} WHERE id = ?`,
    [id],
  );
  return !row || row.deleted_at != null;
}

/**
 * 保留本机版本：把本地 server_rev 对齐到冲突里的服务端版本，并重新入队一次写操作。
 * 本地已删除则重新入队删除，否则入队更新；之后再同步即可覆盖桌面端。
 * 若期间桌面端又改过，会再次产生冲突而不是静默覆盖。
 */
export async function resolveConflictWithLocal(conflict: SyncConflictRow): Promise<void> {
  const entity = conflictEntity(conflict.entity);
  if (!entity) {
    // 未知实体（旧版本遗留）：没有可重建的本地写路径，只清掉冲突记录。
    await getDatabase().runAsync("DELETE FROM sync_conflicts WHERE op_id = ?", [conflict.op_id]);
    return;
  }

  const db = getDatabase();
  const change = parseServerRecord(conflict.server_json);
  const baseRev = Math.max(change?.rev ?? 0, 0);
  const now = Date.now();
  const deleted = await isLocalDeleted(entity, conflict.target_id);
  const table = entity === "task" ? "tasks" : entity === "note" ? "notes" : "captures";

  await db.withTransactionAsync(async () => {
    await db.runAsync(`UPDATE ${table} SET server_rev = ? WHERE id = ?`, [
      baseRev,
      conflict.target_id,
    ]);
    // 清掉冲突守卫行：本机版本重新入队后，由下一次 push 正常判定。
    await db.runAsync(
      "DELETE FROM outbox WHERE entity = ? AND target_id = ? AND state = 'conflict'",
      [entity, conflict.target_id],
    );
    await db.runAsync("DELETE FROM sync_conflicts WHERE op_id = ?", [conflict.op_id]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        newId("op"),
        entity,
        conflict.target_id,
        baseRev,
        JSON.stringify({ type: deleted ? "delete" : "update" }),
        now,
      ],
    );
  });
}
