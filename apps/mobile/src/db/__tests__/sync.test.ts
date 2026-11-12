// 同步落库层测试：pull 应用 / 墓碑版本比较 / outbox 原子性 / push 结算 / 冲突。
// 全部走真实 SQL（node:sqlite harness），业务代码 db/sync.ts 原样运行。
import { beforeEach, describe, expect, it } from "vitest";

import type { Change, Op } from "../../lib/sync/protocol";
import {
  applyPullChanges,
  buildPendingOps,
  countPendingSyncOps,
  countSyncConflicts,
  listSyncConflicts,
  loadSyncCursor,
  loadSyncResult,
  resetSyncState,
  resolveConflictWithLocal,
  resolveConflictWithServer,
  saveSyncCursor,
  saveSyncResult,
  settlePush,
  type PendingOp,
} from "../sync";
import { closeDatabase, getDatabase, openDatabase } from "../database";

function taskChange(overrides: Partial<Change> = {}): Change {
  return {
    entity: "task",
    id: "t-1",
    rev: 1,
    deleted: false,
    fields: {
      title: "任务一",
      description: "",
      status: "pending",
      priority: 1,
      category: null,
      tags: [],
      dueAt: null,
      remindAt: null,
      advanceMinutes: null,
      recurrenceRule: null,
      createdAt: 100,
      updatedAt: 100,
      completedAt: null,
    },
    updated_at: 100,
    ...overrides,
  };
}

function pushOp(overrides: Partial<Op> = {}): Op {
  return {
    op_id: "op-1",
    entity: "task",
    id: "t-1",
    base_rev: 0,
    patch: { title: "本机标题" },
    ...overrides,
  };
}

async function insertOutbox(rows: Array<{
  opId: string;
  entity: string;
  targetId: string;
  baseRev?: number;
  type: string;
  createdAt: number;
}>): Promise<void> {
  const db = getDatabase();
  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [row.opId, row.entity, row.targetId, row.baseRev ?? 0, JSON.stringify({ type: row.type }), row.createdAt],
    );
  }
}

async function taskRow(id: string): Promise<{
  title: string;
  deleted_at: number | null;
  server_rev: number;
  rev: number;
} | null> {
  return getDatabase().getFirstAsync(
    "SELECT title, deleted_at, server_rev, rev FROM tasks WHERE id = ?",
    [id],
  );
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
});

describe("applyPullChanges", () => {
  it("应用任务/笔记/收集箱变更并推进 server_rev", async () => {
    const result = await applyPullChanges([
      taskChange({ id: "t-1", rev: 3 }),
      {
        entity: "note",
        id: "n-1",
        rev: 2,
        deleted: false,
        fields: { title: "笔记", body: "正文", pinned: true, favorited: false, createdAt: 1, updatedAt: 2 },
        updated_at: 2,
      },
      {
        entity: "capture",
        id: "c-1",
        rev: 1,
        deleted: false,
        fields: { clientId: "cid-1", content: "草稿", kind: "text", createdAt: 5 },
        updated_at: 5,
      },
    ]);
    expect(result).toEqual({ applied: 3, deleted: 0, skipped: 0 });

    const task = await taskRow("t-1");
    expect(task?.server_rev).toBe(3);
    const note = await getDatabase().getFirstAsync<{ server_rev: number; pinned: number }>(
      "SELECT server_rev, pinned FROM notes WHERE id = 'n-1'",
    );
    expect(note?.server_rev).toBe(2);
    expect(note?.pinned).toBe(1);
    const capture = await getDatabase().getFirstAsync<{ server_rev: number }>(
      "SELECT server_rev FROM captures WHERE id = 'c-1'",
    );
    expect(capture?.server_rev).toBe(1);
  });

  it("旧变更（rev <= server_rev）不回退已应用版本", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 10, updated_at: 200 })]);
    await applyPullChanges([taskChange({ id: "t-1", rev: 5, fields: { ...taskChange().fields, title: "旧标题" } })]);
    const row = await taskRow("t-1");
    expect(row?.title).toBe("任务一");
    expect(row?.server_rev).toBe(10);
  });

  it("删除墓碑：软删除并记录服务端版本", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 4 })]);
    const result = await applyPullChanges([
      taskChange({ id: "t-1", rev: 5, deleted: true, fields: {}, updated_at: 0 }),
    ]);
    expect(result).toEqual({ applied: 0, deleted: 1, skipped: 0 });
    const row = await taskRow("t-1");
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.server_rev).toBe(5);
  });

  it("旧墓碑不得覆盖更新版本的记录（复现：rev 5 的墓碑晚于 rev 10 的更新）", async () => {
    // 先收到桌面端 rev 10 的内容更新（记录存在且较新）。
    await applyPullChanges([taskChange({ id: "t-1", rev: 10, updated_at: 900 })]);
    // 重新全量拉取/游标重置等场景下，rev 5 的旧墓碑晚到。
    const result = await applyPullChanges([
      taskChange({ id: "t-1", rev: 5, deleted: true, fields: {}, updated_at: 0 }),
    ]);
    // 期望：旧墓碑跳过，记录保持 rev 10 的内容且未被删除。
    const row = await taskRow("t-1");
    expect(row?.deleted_at).toBeNull();
    expect(row?.title).toBe("任务一");
    expect(row?.server_rev).toBe(10);
    expect(result.deleted).toBe(0);
  });

  it("本地有未发送 outbox 的记录：pull 跳过不覆盖，交给 push 冲突判定", async () => {
    await insertOutbox([{ opId: "op-local", entity: "task", targetId: "t-1", type: "update", createdAt: 10 }]);
    const result = await applyPullChanges([taskChange({ id: "t-1", rev: 9 })]);
    expect(result).toEqual({ applied: 0, deleted: 0, skipped: 1 });
    expect(await taskRow("t-1")).toBeNull();
  });

  it("空字段与大笔记：description 空串、null 类别按全量记录应用", async () => {
    const result = await applyPullChanges([
      taskChange({
        id: "t-big",
        rev: 1,
        fields: {
          ...taskChange().fields,
          title: `长标题${"字".repeat(10_000)}`,
          description: "字".repeat(200_000),
          category: null,
        },
      }),
    ]);
    expect(result.applied).toBe(1);
    const row = await getDatabase().getFirstAsync<{ description: string; category: string | null }>(
      "SELECT description, category FROM tasks WHERE id = 't-big'",
    );
    expect(row?.description).toHaveLength(200_000);
    expect(row?.category).toBeNull();
  });

  it("收集箱 client_id 冲突时跳过，不覆盖另一条本地记录", async () => {
    await applyPullChanges([
      { entity: "capture", id: "c-a", rev: 1, deleted: false, fields: { clientId: "cid-x", content: "A", kind: "text", createdAt: 1 }, updated_at: 1 },
    ]);
    const result = await applyPullChanges([
      { entity: "capture", id: "c-b", rev: 2, deleted: false, fields: { clientId: "cid-x", content: "B", kind: "text", createdAt: 2 }, updated_at: 2 },
    ]);
    expect(result.skipped).toBe(1);
    const rows = await getDatabase().getAllAsync<{ id: string; content: string }>(
      "SELECT id, content FROM captures ORDER BY id",
    );
    expect(rows).toEqual([{ id: "c-a", content: "A" }]);
  });
});

describe("settlePush", () => {
  it("ack 清空对应 outbox（含更早的多行）", async () => {
    await insertOutbox([
      { opId: "op-1", entity: "task", targetId: "t-1", type: "update", createdAt: 10 },
      { opId: "op-2", entity: "task", targetId: "t-1", type: "update", createdAt: 20 },
    ]);
    const pending: PendingOp[] = [
      {
        op: pushOp({ op_id: "op-1" }),
        entity: "task",
        targetId: "t-1",
        maxCreatedAt: 20,
      },
    ];
    await settlePush({ ack: ["op-1"], conflicts: [] }, pending);
    expect(await countPendingSyncOps()).toBe(0);
  });

  it("同步期间的新编辑（created_at > maxCreatedAt）不被误删", async () => {
    await insertOutbox([
      { opId: "op-1", entity: "task", targetId: "t-1", type: "update", createdAt: 10 },
    ]);
    // push 在途时用户又改了一次（新的 outbox 行）。
    await insertOutbox([
      { opId: "op-2", entity: "task", targetId: "t-1", type: "update", createdAt: 99 },
    ]);
    await settlePush(
      { ack: ["op-1"], conflicts: [] },
      [{ op: pushOp({ op_id: "op-1" }), entity: "task", targetId: "t-1", maxCreatedAt: 10 }],
    );
    const remaining = await getDatabase().getFirstAsync<{ op_id: string; created_at: number }>(
      "SELECT op_id, created_at FROM outbox",
    );
    expect(remaining).toEqual({ op_id: "op-2", created_at: 99 });
  });

  it("冲突写入 sync_conflicts 并清空本批 outbox", async () => {
    await insertOutbox([{ opId: "op-c", entity: "task", targetId: "t-1", type: "update", createdAt: 5 }]);
    await settlePush(
      {
        ack: [],
        conflicts: [
          {
            op_id: "op-c",
            reason: "revision_mismatch",
            server_record: taskChange({ id: "t-1", rev: 7 }),
          },
        ],
      },
      [{ op: pushOp({ op_id: "op-c", base_rev: 3 }), entity: "task", targetId: "t-1", maxCreatedAt: 5 }],
    );
    expect(await countSyncConflicts()).toBe(1);
    expect(await countPendingSyncOps()).toBe(0);
    const conflict = (await listSyncConflicts())[0];
    expect(conflict.reason).toBe("revision_mismatch");
    expect(JSON.parse(conflict.server_json ?? "{}").rev).toBe(7);
  });
});

describe("buildPendingOps", () => {
  it("同记录多行 outbox 合并为一次 push，取最早 op_id 与 base_rev", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 4 })]);
    await insertOutbox([
      { opId: "op-first", entity: "task", targetId: "t-1", baseRev: 4, type: "update", createdAt: 10 },
      { opId: "op-second", entity: "task", targetId: "t-1", baseRev: 4, type: "update", createdAt: 20 },
    ]);
    const pending = await buildPendingOps();
    expect(pending).toHaveLength(1);
    expect(pending[0].op.op_id).toBe("op-first");
    expect(pending[0].op.base_rev).toBe(4);
    expect(pending[0].maxCreatedAt).toBe(20);
    // 补丁取当前完整行（本地最终状态）。
    expect(pending[0].op.patch.title).toBe("任务一");
  });

  it("删除/转任务映射为墓碑，即使本地行已软删除", async () => {
    await insertOutbox([{ opId: "op-del", entity: "task", targetId: "t-gone", type: "delete", createdAt: 3 }]);
    const pending = await buildPendingOps();
    expect(pending).toHaveLength(1);
    expect(pending[0].op.deleted).toBe(true);
  });

  it("本地行已删但无删除操作（异常状态）时跳过，不发半截数据", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 2 })]);
    await getDatabase().runAsync("UPDATE tasks SET deleted_at = 1 WHERE id = 't-1'");
    await insertOutbox([{ opId: "op-x", entity: "task", targetId: "t-1", baseRev: 2, type: "update", createdAt: 3 }]);
    expect(await buildPendingOps()).toEqual([]);
  });

  it("push 失败后重试复用同一 op_id（服务端幂等依赖）", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 4 })]);
    await insertOutbox([{ opId: "op-stable", entity: "task", targetId: "t-1", baseRev: 4, type: "update", createdAt: 10 }]);
    const first = await buildPendingOps();
    // 模拟 push 未收到响应：不结算，直接重建待发列表。
    const second = await buildPendingOps();
    expect(second[0].op.op_id).toBe(first[0].op.op_id);
    expect(second[0].op.base_rev).toBe(first[0].op.base_rev);
  });
});

describe("冲突处理", () => {
  it("采用桌面端：应用服务端版本并删除冲突记录", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 2 })]);
    await insertOutbox([{ opId: "op-c", entity: "task", targetId: "t-1", type: "update", createdAt: 5 }]);
    await settlePush(
      { ack: [], conflicts: [{ op_id: "op-c", reason: "revision_mismatch", server_record: taskChange({ id: "t-1", rev: 7, fields: { ...taskChange().fields, title: "桌面版" } }) }] },
      [{ op: pushOp({ op_id: "op-c" }), entity: "task", targetId: "t-1", maxCreatedAt: 5 }],
    );
    const conflicts = await listSyncConflicts();
    await resolveConflictWithServer(conflicts[0]);
    expect(await countSyncConflicts()).toBe(0);
    const row = await taskRow("t-1");
    expect(row?.title).toBe("桌面版");
    expect(row?.server_rev).toBe(7);
    expect(row?.deleted_at).toBeNull();
  });

  it("采用桌面端但服务端记录缺失：等价软删除本地副本", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 2 })]);
    await insertOutbox([{ opId: "op-c", entity: "task", targetId: "t-1", type: "update", createdAt: 5 }]);
    await settlePush(
      { ack: [], conflicts: [{ op_id: "op-c", reason: "record_missing", server_record: null }] },
      [{ op: pushOp({ op_id: "op-c" }), entity: "task", targetId: "t-1", maxCreatedAt: 5 }],
    );
    const conflicts = await listSyncConflicts();
    await resolveConflictWithServer(conflicts[0]);
    const row = await taskRow("t-1");
    expect(row?.deleted_at).not.toBeNull();
    expect(await countSyncConflicts()).toBe(0);
  });

  it("保留本机：以服务端 rev 为 base 重新入队，之后同步可覆盖桌面端", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 2 })]);
    await insertOutbox([{ opId: "op-c", entity: "task", targetId: "t-1", type: "update", createdAt: 5 }]);
    await settlePush(
      { ack: [], conflicts: [{ op_id: "op-c", reason: "revision_mismatch", server_record: taskChange({ id: "t-1", rev: 7 }) }] },
      [{ op: pushOp({ op_id: "op-c" }), entity: "task", targetId: "t-1", maxCreatedAt: 5 }],
    );
    const conflicts = await listSyncConflicts();
    await resolveConflictWithLocal(conflicts[0]);
    expect(await countSyncConflicts()).toBe(0);
    const pending = await buildPendingOps();
    expect(pending).toHaveLength(1);
    expect(pending[0].op.base_rev).toBe(7);
    expect(pending[0].op.deleted).toBeUndefined();
  });

  it("保留本机且本地已删除：重新入队删除墓碑", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 2 })]);
    await getDatabase().runAsync("UPDATE tasks SET deleted_at = 55 WHERE id = 't-1'");
    await insertOutbox([{ opId: "op-c", entity: "task", targetId: "t-1", type: "update", createdAt: 5 }]);
    await settlePush(
      { ack: [], conflicts: [{ op_id: "op-c", reason: "revision_mismatch", server_record: taskChange({ id: "t-1", rev: 7 }) }] },
      [{ op: pushOp({ op_id: "op-c" }), entity: "task", targetId: "t-1", maxCreatedAt: 5 }],
    );
    const conflicts = await listSyncConflicts();
    await resolveConflictWithLocal(conflicts[0]);
    const pending = await buildPendingOps();
    expect(pending).toHaveLength(1);
    expect(pending[0].op.deleted).toBe(true);
  });
});

describe("游标与状态", () => {
  it("cursor / last_result 读写与损坏恢复", async () => {
    await saveSyncCursor("42");
    expect(await loadSyncCursor()).toBe("42");
    await saveSyncResult({ at: 1, pulled: 2, applied: 2, pushed: 0, conflicts: 0 });
    expect((await loadSyncResult())?.pulled).toBe(2);
    await getDatabase().runAsync("UPDATE kv SET value = '{broken' WHERE key = 'sync.last_result.v1'");
    expect(await loadSyncResult()).toBeNull();
  });

  it("resetSyncState 清游标、冲突、server_rev 与 outbox base_rev（解除配对/换桌面端）", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 9 })]);
    await saveSyncCursor("77");
    await insertOutbox([{ opId: "op-1", entity: "task", targetId: "t-1", baseRev: 9, type: "update", createdAt: 1 }]);
    await getDatabase().runAsync(
      `INSERT INTO sync_conflicts (op_id, entity, target_id, reason, server_json, created_at)
       VALUES ('op-x', 'task', 't-1', 'revision_mismatch', NULL, 1)`,
    );

    await resetSyncState();

    expect(await loadSyncCursor()).toBe("");
    expect(await countSyncConflicts()).toBe(0);
    const row = await taskRow("t-1");
    expect(row?.server_rev).toBe(0);
    expect(row?.deleted_at).toBeNull();
    const outbox = await getDatabase().getFirstAsync<{ base_rev: number }>(
      "SELECT base_rev FROM outbox WHERE op_id = 'op-1'",
    );
    expect(outbox?.base_rev).toBe(0);
  });
});
