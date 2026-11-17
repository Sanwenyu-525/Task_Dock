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
import {
  applyLifeChange,
  buildLifePatch,
  clearDeferredLifeChangeForTarget,
  isLifeEntity,
  isLifeLocalDeleted,
  prepareLifeLocalResolution,
  recordDeferredLifeChange,
  resetLifeSyncState,
  retryDeferredLifeChangesInTx,
  softDeleteLifeLocalCopy,
  type LifeEntity,
} from "./lifeSync";
import { newId } from "../lib/id";

const CURSOR_KEY = "sync.cursor.v1";
const LAST_RESULT_KEY = "sync.last_result.v1";

export interface SyncLastResult {
  at: number;
  pulled: number;
  /** 成功写入的内容变更（新增/更新），不含删除。 */
  applied: number;
  /** 成功应用的删除。 */
  deleted: number;
  /** 旧版本或已被更新数据覆盖，无需应用。 */
  stale: number;
  /** 因依赖未到、本地 outbox、重复关联等原因延后，已持久化等待恢复。 */
  deferred: number;
  /** 数据校验失败，无法自动应用，已进入待处理/诊断。 */
  rejected: number;
  /** 非生活实体且无需应用的变更（保持原有语义）。 */
  skipped: number;
  pushed: number;
  conflicts: number;
  error?: string;
}

export interface PullApplyResult {
  applied: number;
  deleted: number;
  stale: number;
  deferred: number;
  rejected: number;
  /** 非生活实体的无操作变更；不再混入生活延后/拒绝。 */
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
      // 旧版本只存 applied；缺失的新状态按 0 处理，读旧数据不报错也不伪造统计。
      deleted: typeof value.deleted === "number" ? value.deleted : 0,
      stale: typeof value.stale === "number" ? value.stale : 0,
      deferred: typeof value.deferred === "number" ? value.deferred : 0,
      rejected: typeof value.rejected === "number" ? value.rejected : 0,
      skipped: typeof value.skipped === "number" ? value.skipped : 0,
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
        WHERE entity IN ('task', 'note', 'capture', 'life_item', 'life_event',
                         'life_event_item', 'life_document_link') AND base_rev <> 0`,
    );
    await resetLifeSyncState(db);
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
 * pull 方向遇到「同名商品但不同 ID」时写入与 push 冲突同一张表，
 * 让冲突页可以用同一套机制展示，并提供「关联到桌面商品并保留本机购买历史」。
 * 这里不占用 outbox：本地可能有 pending_outbox 的延后同理，等 push 自己产生冲突。
 */
async function recordPullLifeConflict(
  db: SQLiteDatabase,
  change: Change,
): Promise<void> {
  const opId = `pull:${change.entity}:${change.id}:${change.rev}`;
  const now = Date.now();
  await db.runAsync(
    "DELETE FROM sync_conflicts WHERE entity = ? AND target_id = ? AND reason = ?",
    [change.entity, change.id, "life_item_name_conflict"],
  );
  await db.runAsync(
    `INSERT OR REPLACE INTO sync_conflicts
       (op_id, entity, target_id, reason, server_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      opId,
      change.entity,
      change.id,
      "life_item_name_conflict",
      JSON.stringify(change),
      now,
    ],
  );
}

/**
 * 应用一页 pull 变更。
 *
 * 同一记录在日志里可能出现多次（更新数次），按顺序应用即可；服务端游标保证不漏页。
 * 生活实体不再把所有异常都当成无害 skipped：依赖未到、本地未发送修改、同名冲突等
 * 会写入 life_sync_deferred，游标可以推进，但变更不会丢；依赖到达后自动重放。
 */
export async function applyPullChanges(changes: readonly Change[]): Promise<PullApplyResult> {
  const db = getDatabase();
  const result: PullApplyResult = {
    applied: 0,
    deleted: 0,
    stale: 0,
    deferred: 0,
    rejected: 0,
    skipped: 0,
  };
  // 本页出现的记录即使此前被延后，也不能在重放阶段再次计数：
  // 否则「旧延后行 + 同一记录的新版本」会被算成两次（applied + stale）。
  const pulledLifeKeys = new Set(
    changes
      .filter((change) => isLifeEntity(change.entity))
      .map((change) => `${change.entity}:${change.id}`),
  );

  // 外键顺序：生活实体必须 item → event → event_item → link 应用；
  // 其他实体保持原有 seq 顺序。Array#sort 是稳定的，同实体内部不会打乱。
  const lifeRank: Record<string, number> = {
    life_item: 0,
    life_event: 1,
    life_event_item: 2,
    life_document_link: 3,
  };
  const ordered = [...changes].sort((left, right) => {
    const leftRank = lifeRank[left.entity] ?? 4;
    const rightRank = lifeRank[right.entity] ?? 4;
    return leftRank - rightRank;
  });

  await db.withTransactionAsync(async () => {
    for (const change of ordered) {
      if (isLifeEntity(change.entity)) {
        const outcome = await applyLifeChange(db, change);
        if (outcome.status === "applied") {
          result.applied += 1;
        } else if (outcome.status === "deleted") {
          result.deleted += 1;
        } else if (outcome.status === "stale") {
          result.stale += 1;
        } else if (outcome.status === "deferred") {
          result.deferred += 1;
          await recordDeferredLifeChange(db, change, outcome.reason);
          if (outcome.reason === "name_conflict") {
            await recordPullLifeConflict(db, change);
          }
        } else {
          result.rejected += 1;
          await recordDeferredLifeChange(db, change, "invalid");
        }
        continue;
      }

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
      if (outcome === "applied") result.applied += 1;
      else if (outcome === "deleted") result.deleted += 1;
      else result.skipped += 1;
    }

    // 无新变更也要重放旧延后项：手动同步可在依赖已到达后自愈。
    // 本页已覆盖的记录由上面的正常应用负责，重放只清理旧行、不重复计数。
    const retried = await retryDeferredLifeChangesInTx(db, pulledLifeKeys);
    result.applied += retried.applied;
    result.deleted += retried.deleted;
    result.stale += retried.stale;
  });

  return result;
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
  return (
    value === "task" ||
    value === "note" ||
    value === "capture" ||
    isLifeEntity(value)
  );
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
      WHERE entity IN ('task', 'note', 'capture', 'life_item', 'life_event',
                       'life_event_item', 'life_document_link')
        AND state IN ('pending', 'failed')
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

    if (isLifeEntity(group.entity)) {
      const patch = await buildLifePatch(db, group.entity, group.targetId);
      if (!patch) continue;
      push(patch);
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

/** 统计本轮可发送的操作（任务 / 笔记 / 收集箱 / 生活记录）。 */
export async function countPendingSyncOps(): Promise<number> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox
      WHERE entity IN ('task', 'note', 'capture', 'life_item', 'life_event',
                       'life_event_item', 'life_document_link')
        AND state IN ('pending', 'failed')`,
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
  if (
    value === "task" ||
    value === "note" ||
    value === "capture" ||
    isLifeEntity(value)
  ) {
    return value;
  }
  return null;
}

/** 桌面端没有该记录时，「采用桌面端」等价于软删除本地副本。 */
async function softDeleteLocalCopy(entity: SyncEntity, id: string): Promise<void> {
  if (isLifeEntity(entity)) {
    await softDeleteLifeLocalCopy(entity, id);
    return;
  }
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

/** 同名商品冲突：UI 用这个判断是否展示「关联到已有商品」。 */
export function isLifeNameConflict(conflict: SyncConflictRow): boolean {
  return conflict.reason === "life_item_name_conflict";
}

interface LifeItemRowForMerge {
  id: string;
  name: string;
  normalized_name: string;
  category: string;
  aliases: string;
  note: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  server_rev: number;
}

interface LifeEventItemRowForMerge {
  id: string;
  item_id: string | null;
  server_rev: number;
}

interface LifeLinkRowForMerge {
  id: string;
  document_ref: string;
  document_source: string;
  server_rev: number;
}

async function enqueueLifeUpdate(
  db: SQLiteDatabase,
  entity: LifeEntity,
  targetId: string,
  baseRev: number,
  now: number,
): Promise<void> {
  await db.runAsync(
    "DELETE FROM outbox WHERE entity = ? AND target_id = ? AND state IN ('pending','failed','conflict')",
    [entity, targetId],
  );
  await db.runAsync(
    `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      newId("op"),
      entity,
      targetId,
      baseRev,
      JSON.stringify({ type: baseRev > 0 ? "update" : "create" }),
      now,
    ],
  );
}

/**
 * 解决「同名商品不同 ID」：
 * - 目标 = 服务端已有的商品（冲突 server_json 的 id）；
 * - 源 = 本机同归一名的活动商品；
 * - 保留两端购买事件与名称/日期/金额快照，把本机明细 item_id 重映射到目标商品；
 * - 商品级票据关联改挂目标；源商品软删并清掉其待发送写操作；
 * - 明细/关联重新入队 update，待下一次同步让桌面端也完成关联。
 * 不自动合并规格不同的商品：只有 normalized_name 完全相同才会走到这里。
 */
export async function resolveLifeNameConflict(conflict: SyncConflictRow): Promise<void> {
  if (!isLifeNameConflict(conflict)) {
    throw new Error("不是同名商品冲突");
  }
  const change = parseServerRecord(conflict.server_json);
  if (!change || change.entity !== "life_item") {
    throw new Error("冲突缺少桌面端商品记录，无法关联");
  }
  const targetId = change.id;
  const normalized = asString(change.fields.normalizedName);
  const db = getDatabase();
  const now = Date.now();

  await db.withTransactionAsync(async () => {
    let source = await db.getFirstAsync<LifeItemRowForMerge>(
      "SELECT * FROM life_items WHERE id = ?",
      [conflict.target_id],
    );
    if (!source || source.deleted_at != null || source.id === targetId) {
      source =
        (await db.getFirstAsync<LifeItemRowForMerge>(
          `SELECT * FROM life_items
            WHERE deleted_at IS NULL AND normalized_name = ? AND id <> ?
            LIMIT 1`,
          [normalized, targetId],
        )) ?? null;
    }

    let links: LifeLinkRowForMerge[] = [];
    let rows: LifeEventItemRowForMerge[] = [];
    if (source && source.id !== targetId) {
      links = await db.getAllAsync<LifeLinkRowForMerge>(
        `SELECT id, document_ref, document_source, server_rev
           FROM life_document_links
          WHERE owner_type = 'item' AND owner_id = ? AND deleted_at IS NULL`,
        [source.id],
      );
      rows = await db.getAllAsync<LifeEventItemRowForMerge>(
        "SELECT id, item_id, server_rev FROM life_event_items WHERE item_id = ?",
        [source.id],
      );

      // 先软删源商品释放唯一索引，再落目标商品；明细的 item_id 有外键，
      // 必须在目标商品存在后才能重映射，否则会 FOREIGN KEY constraint failed。
      await db.runAsync(
        `UPDATE life_items SET deleted_at = ?, updated_at = ?, rev = rev + 1, server_rev = 0
          WHERE id = ?`,
        [now, now, source.id],
      );
      await db.runAsync(
        "DELETE FROM outbox WHERE entity = 'life_item' AND target_id = ?",
        [source.id],
      );
      await db.runAsync(
        "DELETE FROM sync_conflicts WHERE entity = 'life_item' AND target_id = ?",
        [source.id],
      );
      await clearDeferredLifeChangeForTarget(db, source.id);
      // 源商品如果已经同步到桌面，必须发删除墓碑，否则下次 pull 仍会把它拉回来。
      if ((source.server_rev ?? 0) > 0) {
        await db.runAsync(
          `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
           VALUES (?, 'life_item', ?, ?, '{"type":"delete"}', ?)`,
          [newId("op"), source.id, source.server_rev, now],
        );
      }
    }

    // 把桌面端商品记录落到本机（可能是新 ID；随后把本地明细/关联重映射到它）。
    const name = asString(change.fields.name, normalized);
    const category = asString(change.fields.category);
    const aliases = JSON.stringify(
      Array.isArray(change.fields.aliases)
        ? change.fields.aliases.filter((value): value is string => typeof value === "string")
        : [],
    );
    const note = asString(change.fields.note);
    const createdAt = asNumber(change.fields.createdAt, now);
    const updatedAt = asNumber(change.fields.updatedAt, createdAt);
    await db.runAsync(
      `INSERT INTO life_items (id, name, normalized_name, category, aliases, note,
                               created_at, updated_at, deleted_at, rev, server_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         normalized_name = excluded.normalized_name,
         category = excluded.category,
         aliases = excluded.aliases,
         note = excluded.note,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         rev = life_items.rev + 1,
         server_rev = excluded.server_rev`,
      [
        targetId,
        name,
        normalized,
        category,
        aliases,
        note,
        createdAt,
        updatedAt,
        change.rev,
      ],
    );

    // 商品级票据关联：目标已有同一文件时只保留目标那条并给源关联发删除墓碑，
    // 否则改挂到目标；两种情况都不复制或删除原图。
    for (const link of links) {
      const duplicate = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM life_document_links
          WHERE deleted_at IS NULL AND owner_type = 'item' AND owner_id = ?
            AND document_ref = ? AND document_source = ? AND id <> ? LIMIT 1`,
        [targetId, link.document_ref, link.document_source, link.id],
      );
      if (duplicate) {
        await db.runAsync(
          `UPDATE life_document_links
              SET deleted_at = ?, updated_at = ?, rev = rev + 1
            WHERE id = ?`,
          [now, now, link.id],
        );
        await db.runAsync(
          "DELETE FROM outbox WHERE entity = 'life_document_link' AND target_id = ?",
          [link.id],
        );
        await db.runAsync(
          `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at)
           VALUES (?, 'life_document_link', ?, ?, '{"type":"delete"}', ?)`,
          [newId("op"), link.id, link.server_rev ?? 0, now],
        );
      } else {
        await db.runAsync(
          `UPDATE life_document_links
              SET owner_id = ?, updated_at = ?, rev = rev + 1
            WHERE id = ?`,
          [targetId, now, link.id],
        );
        await enqueueLifeUpdate(db, "life_document_link", link.id, link.server_rev ?? 0, now);
      }
    }

    // 购买明细指到目标商品；名称快照、日期、金额与单位保持原样。
    for (const row of rows) {
      await db.runAsync(
        "UPDATE life_event_items SET item_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
        [targetId, now, row.id],
      );
      await enqueueLifeUpdate(db, "life_event_item", row.id, row.server_rev ?? 0, now);
      await db.runAsync(
        "DELETE FROM sync_conflicts WHERE entity = 'life_event_item' AND target_id = ?",
        [row.id],
      );
    }

    await db.runAsync(
      "DELETE FROM outbox WHERE entity = 'life_item' AND target_id = ? AND state = 'conflict'",
      [targetId],
    );
    await clearDeferredLifeChangeForTarget(db, targetId);
    await db.runAsync("DELETE FROM sync_conflicts WHERE op_id = ?", [conflict.op_id]);
    await db.runAsync(
      "DELETE FROM sync_conflicts WHERE entity = 'life_item' AND target_id = ? AND reason = ?",
      [targetId, "life_item_name_conflict"],
    );
  });
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
    if (entity && isLifeEntity(entity)) {
      await clearDeferredLifeChangeForTarget(db, conflict.target_id);
    }
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
  if (isLifeEntity(entity)) return isLifeLocalDeleted(entity, id);
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

  await db.withTransactionAsync(async () => {
    if (isLifeEntity(entity)) {
      await prepareLifeLocalResolution(db, entity, conflict.target_id, baseRev);
    } else {
      const table = entity === "task" ? "tasks" : entity === "note" ? "notes" : "captures";
      await db.runAsync(`UPDATE ${table} SET server_rev = ? WHERE id = ?`, [
        baseRev,
        conflict.target_id,
      ]);
    }
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
