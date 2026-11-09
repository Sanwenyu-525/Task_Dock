// 同步落库层：pull 应用、outbox 合并、push 结果结算与冲突存储。
//
// 原则：
// - pull 只写业务表，绝不写 outbox；
// - 本地有未发送操作（outbox）的记录，pull 不覆盖，交给 push 的 base_rev 冲突判定；
// - push 成功的记录清空 outbox；冲突清空 outbox 并写 sync_conflicts，等用户处理；
// - 服务端版本号存 server_rev，下一次本地编辑的 base_rev 用它，而不是本地 rev。
import type { Change, Op, PushResult, SyncPatch } from "../lib/sync/protocol";
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

export interface PendingTaskOp {
  op: Op;
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
  await db.runAsync("DELETE FROM sync_conflicts");
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
      if (change.entity !== "task") {
        skipped += 1;
        continue;
      }

      const pending = await db.getFirstAsync<{ n: number }>(
        "SELECT COUNT(*) AS n FROM outbox WHERE entity = 'task' AND target_id = ?",
        [change.id],
      );
      if ((pending?.n ?? 0) > 0) {
        skipped += 1;
        continue;
      }

      const existing = await db.getFirstAsync<{ server_rev: number; deleted_at: number | null }>(
        "SELECT server_rev, deleted_at FROM tasks WHERE id = ?",
        [change.id],
      );

      if (change.deleted) {
        if (!existing) {
          skipped += 1;
          continue;
        }
        await db.runAsync(
          "UPDATE tasks SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = ? WHERE id = ?",
          [Date.now(), Date.now(), change.rev, change.id],
        );
        deleted += 1;
        continue;
      }

      // 旧变更晚到（分页重放）时不回退已应用的版本。
      if (existing && change.rev <= existing.server_rev) {
        skipped += 1;
        continue;
      }

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
      applied += 1;
    }
  });

  return { applied, deleted, skipped };
}

interface OutboxRow {
  op_id: string;
  target_id: string;
  base_rev: number;
  payload: string;
  created_at: number;
}

interface PendingGroup {
  opId: string;
  targetId: string;
  baseRev: number;
  deleted: boolean;
  maxCreatedAt: number;
}

/**
 * 把 outbox 按记录合并成 push 操作：同一条任务的多次编辑只发一次，
 * base_rev 取最早一次本地编辑时的服务端版本（冲突判定更保守）。
 */
export async function buildPendingTaskOps(): Promise<PendingTaskOp[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<OutboxRow>(
    `SELECT op_id, target_id, base_rev, payload, created_at
       FROM outbox
      WHERE entity = 'task' AND state IN ('pending', 'failed')
      ORDER BY created_at ASC, rowid ASC`,
  );

  const groups = new Map<string, PendingGroup>();
  for (const row of rows) {
    const existing = groups.get(row.target_id);
    if (existing) {
      if (payloadType(row.payload) === "delete") existing.deleted = true;
      existing.maxCreatedAt = Math.max(existing.maxCreatedAt, row.created_at);
      continue;
    }
    groups.set(row.target_id, {
      opId: row.op_id,
      targetId: row.target_id,
      baseRev: row.base_rev,
      deleted: payloadType(row.payload) === "delete",
      maxCreatedAt: row.created_at,
    });
  }

  const ops: PendingTaskOp[] = [];
  for (const group of groups.values()) {
    const task = await db.getFirstAsync<{
      id: string;
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

    if (group.deleted) {
      // 本地已删除：即使行已被软删除也要把墓碑发出去。
      ops.push({
        targetId: group.targetId,
        maxCreatedAt: group.maxCreatedAt,
        op: {
          op_id: group.opId,
          entity: "task",
          id: group.targetId,
          base_rev: group.baseRev,
          patch: {},
          deleted: true,
        },
      });
      continue;
    }

    if (!task || task.deleted_at != null) {
      // 本地删了但没有删除操作（异常状态）：跳过，避免把半截数据推上去。
      continue;
    }

    const patch: SyncPatch = buildPatchPayload({
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
    });

    ops.push({
      targetId: group.targetId,
      maxCreatedAt: group.maxCreatedAt,
      op: {
        op_id: group.opId,
        entity: "task",
        id: group.targetId,
        base_rev: group.baseRev,
        patch,
      },
    });
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
  pending: readonly PendingTaskOp[],
): Promise<void> {
  const db = getDatabase();
  const byOpId = new Map(pending.map((item) => [item.op.op_id, item]));

  const acked = new Map<string, number>();
  for (const opId of result.ack) {
    const item = byOpId.get(opId);
    if (!item) continue;
    acked.set(item.targetId, Math.max(acked.get(item.targetId) ?? 0, item.maxCreatedAt));
  }

  const conflictRows: Array<SyncConflictRow & { maxCreatedAt: number }> = [];
  for (const conflict of result.conflicts) {
    const item = byOpId.get(conflict.op_id);
    if (!item) continue;
    conflictRows.push({
      op_id: conflict.op_id,
      entity: "task",
      target_id: item.targetId,
      reason: conflict.reason,
      server_json: conflict.server_record ? JSON.stringify(conflict.server_record) : null,
      created_at: Date.now(),
      maxCreatedAt: item.maxCreatedAt,
    });
  }

  await db.withTransactionAsync(async () => {
    // 只删本批快照里的 outbox：同步请求期间用户继续编辑产生的新行必须保留。
    for (const [targetId, maxCreatedAt] of acked) {
      await db.runAsync(
        "DELETE FROM outbox WHERE entity = 'task' AND target_id = ? AND created_at <= ?",
        [targetId, maxCreatedAt],
      );
    }
    for (const row of conflictRows) {
      await db.runAsync(
        "DELETE FROM outbox WHERE entity = 'task' AND target_id = ? AND created_at <= ?",
        [row.target_id, row.maxCreatedAt],
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

/** 只统计本轮可发送的任务操作；收集箱/笔记的 outbox 仍留在本机。 */
export async function countPendingTaskOutbox(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM outbox WHERE entity = 'task' AND state IN ('pending', 'failed')",
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

/** 采用桌面端版本：把冲突里记录的服务端版本应用到本地，再删除冲突记录。 */
export async function resolveConflictWithServer(conflict: SyncConflictRow): Promise<void> {
  const db = getDatabase();
  const change = parseServerRecord(conflict.server_json);
  if (change) {
    // 冲突结算时已经清掉该记录的 outbox，这里不会再被「本地未发送」跳过。
    await applyPullChanges([change]);
  } else {
    // 桌面端没有该记录：采用桌面端等价于删除本地副本。
    await db.runAsync(
      "UPDATE tasks SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = 0 WHERE id = ?",
      [Date.now(), Date.now(), conflict.target_id],
    );
  }
  await db.runAsync("DELETE FROM sync_conflicts WHERE op_id = ?", [conflict.op_id]);
}

/**
 * 保留本机版本：把本地 server_rev 对齐到冲突里的服务端版本，并重新入队一次更新。
 * 之后再同步即可覆盖桌面端；若期间桌面端又改过，会再次产生冲突而不是静默覆盖。
 */
export async function resolveConflictWithLocal(conflict: SyncConflictRow): Promise<void> {
  const db = getDatabase();
  const change = parseServerRecord(conflict.server_json);
  const baseRev = Math.max(change?.rev ?? 0, 0);
  const now = Date.now();

  await db.withTransactionAsync(async () => {
    await db.runAsync("UPDATE tasks SET server_rev = ? WHERE id = ?", [baseRev, conflict.target_id]);
    await db.runAsync("DELETE FROM sync_conflicts WHERE op_id = ?", [conflict.op_id]);
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
       VALUES (?, 'task', ?, ?, ?, ?)`,
      [newId("op"), conflict.target_id, baseRev, JSON.stringify({ type: "update" }), now],
    );
  });
}
