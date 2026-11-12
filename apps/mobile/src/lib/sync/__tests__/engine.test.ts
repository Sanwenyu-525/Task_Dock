// 同步编排引擎测试：真实 DB（node:sqlite harness）+ 注入 fetch，
// 验证 pull→push→再 pull、游标推进、outbox 结算、pull 后提醒对账。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchLike, HttpResponseLike } from "../client";
import { decryptEnvelope, deriveSyncKey, encryptEnvelope } from "../crypto";
import { AAD_PULL, AAD_PUSH } from "../crypto";
import type { PullResult } from "../protocol";
import { closeDatabase, getDatabase, openDatabase } from "../../../db/database";
import { applyPullChanges } from "../../../db/sync";
import { setSetting } from "../../../db/kv";
import { saveSyncCursor } from "../../../db/sync";

// 连接元数据/令牌与提醒引擎用 mock：引擎对它们的契约在 db/syncConnection 测试中单独验证。
// vi.hoisted 保证 spy 在 vi.mock 工厂被求值前就已存在。
const { reschedule } = vi.hoisted(() => ({
  reschedule: vi.fn(async () => ({ scheduled: 0, skipped: 0 })),
}));

const connectionFixture = {
  baseUrl: "https://192.168.1.10:47822",
  host: "192.168.1.10",
  port: 47822,
  serverName: "台式机",
  deviceId: "device-1",
  platform: "android",
  instanceId: "inst-1",
  fingerprint: "1A2B3C4D",
  tlsFingerprint: "a".repeat(64),
  pairedAt: "2026-11-12T00:00:00Z",
  lastSeenAt: null,
};

vi.mock("../../../db/syncConnection", () => ({
  loadConnection: vi.fn(async () => connectionFixture),
  readToken: vi.fn(async () => "a".repeat(64)),
  touchConnection: vi.fn(async () => undefined),
}));

vi.mock("../../../notifications/reminderEngine", () => ({
  rescheduleAllReminders: reschedule,
}));

import { syncNow } from "../engine";
import type { Change } from "../protocol";

const TOKEN = "a".repeat(64);

function taskChange(overrides: Partial<Change> = {}): Change {
  return {
    entity: "task",
    id: "t-1",
    rev: 1,
    deleted: false,
    fields: {
      title: "桌面任务",
      description: "",
      status: "pending",
      priority: 0,
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

/** 服务端模拟：内存变更日志 + ops 幂等。 */
function makeServer() {
  const log: Change[] = [];
  const appliedOpIds = new Set<string>();
  let seq = 0;
  return {
    push(title: string): Change {
      seq += 1;
      log.push(taskChange({ id: "t-1", rev: seq, fields: { ...taskChange().fields, title } }));
      return log[log.length - 1];
    },
    handle: async (url: string, init: { method?: string; body?: string }): Promise<HttpResponseLike> => {
      const key = await deriveSyncKey(TOKEN);
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (path === "/v1/changes") {
        const page: PullResult = { cursor: String(seq), changes: seq > 0 ? log : [] };
        return {
          ok: true,
          status: 200,
          json: async () => encryptEnvelope(key, AAD_PULL, page),
        };
      }
      if (path === "/v1/ops") {
        const data = decryptEnvelope(key, AAD_PUSH, JSON.parse(init.body ?? "{}")) as {
          device_id: string;
          ops: Array<{ op_id: string; entity: string; id: string; base_rev: number; patch: Record<string, unknown> }>;
        };
        const ack: string[] = [];
        const conflicts: Array<{ op_id: string; reason: string; server_record: Change | null }> = [];
        for (const op of data.ops) {
          if (appliedOpIds.has(op.op_id)) {
            ack.push(op.op_id);
            continue;
          }
          const server = seq > 0 ? log[log.length - 1] : null;
          if (!server) {
            seq += 1;
            log.push(
              taskChange({
                id: op.id,
                rev: seq,
                fields: { ...taskChange().fields, ...op.patch },
              }),
            );
          } else if (server.rev !== op.base_rev) {
            conflicts.push({ op_id: op.op_id, reason: "revision_mismatch", server_record: server });
            continue;
          } else {
            seq += 1;
            log.push(
              taskChange({
                id: op.id,
                rev: seq,
                fields: { ...taskChange().fields, ...op.patch },
              }),
            );
          }
          ack.push(op.op_id);
          appliedOpIds.add(op.op_id);
        }
        return {
          ok: true,
          status: 200,
          json: async () => encryptEnvelope(key, AAD_PUSH, { ack, conflicts }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
  reschedule.mockClear();
  await setSetting("sync.connection.v1", JSON.stringify(connectionFixture));
});

describe("syncNow（端到端，真实落库）", () => {
  it("pull 落地桌面任务并推进游标；无 outbox 时不触发 push", async () => {
    const server = makeServer();
    server.push("第一次");
    const fetchImpl: FetchLike = (url, init) => server.handle(url, init as { method?: string; body?: string });

    const result = await syncNow({ fetchImpl });
    expect(result.pulled).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.pushed).toBe(0);

    const row = await getDatabase().getFirstAsync<{ title: string; server_rev: number }>(
      "SELECT title, server_rev FROM tasks WHERE id = 't-1'",
    );
    expect(row).toEqual({ title: "第一次", server_rev: 1 });
    expect(await getDatabase().getFirstAsync<{ value: string }>(
      "SELECT value FROM kv WHERE key = 'sync.cursor.v1'",
    )).toEqual({ value: "1" });
  });

  it("本机编辑 push 上去后，再 pull 取回新 rev（避免自冲突）", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 1 })]);
    await getDatabase().runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at, state)
       VALUES ('op-1', 'task', 't-1', 1, '{"type":"update"}', 1, 'pending')`,
    );
    await getDatabase().runAsync("UPDATE tasks SET title = '手机编辑' WHERE id = 't-1'");

    const server = makeServer();
    server.push("桌面任务"); // 服务端基线 rev1，与本机 server_rev=1 对齐。
    const fetchImpl: FetchLike = (url, init) => server.handle(url, init as { method?: string; body?: string });

    const result = await syncNow({ fetchImpl });
    expect(result.pushed).toBe(1);
    expect(result.conflicts).toBe(0);
    // push 落地后服务端 seq=2；再 pull 把 server_rev 推到 2，outbox 清空。
    const row = await getDatabase().getFirstAsync<{ server_rev: number }>(
      "SELECT server_rev FROM tasks WHERE id = 't-1'",
    );
    expect(row?.server_rev).toBe(2);
    expect(await getDatabase().getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"))
      .toEqual({ n: 0 });
  });

  it("服务端 rev 变化时本机 push 产生冲突并落 sync_conflicts，不静默覆盖", async () => {
    await applyPullChanges([taskChange({ id: "t-1", rev: 1 })]);
    await getDatabase().runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at, state)
       VALUES ('op-1', 'task', 't-1', 1, '{"type":"update"}', 1, 'pending')`,
    );
    await getDatabase().runAsync("UPDATE tasks SET title = '手机编辑' WHERE id = 't-1'");

    const server = makeServer();
    server.push("桌面任务");
    server.push("桌面抢先改");
    const fetchImpl: FetchLike = (url, init) => server.handle(url, init as { method?: string; body?: string });

    const result = await syncNow({ fetchImpl });
    expect(result.conflicts).toBe(1);
    const conflicts = await getDatabase().getAllAsync("SELECT op_id, reason FROM sync_conflicts");
    expect(conflicts).toEqual([{ op_id: "op-1", reason: "revision_mismatch" }]);
    // 本地标题不被覆盖（等用户在冲突页决定）；带 outbox 的记录 pull 也不覆盖。
    const row = await getDatabase().getFirstAsync<{ title: string }>(
      "SELECT title FROM tasks WHERE id = 't-1'",
    );
    expect(row?.title).toBe("手机编辑");
  });

  it("pull 应用后触发一次提醒对账；无变更不触发", async () => {
    const server = makeServer();
    server.push("带提醒的任务");
    const fetchImpl: FetchLike = (url, init) => server.handle(url, init as { method?: string; body?: string });

    const dbg = await syncNow({ fetchImpl });
    expect(dbg.applied).toBe(1);
    const mod = await import("../../../notifications/reminderEngine");
    console.log("DBG-KV", await getDatabase().getFirstAsync("SELECT value FROM kv WHERE key = 'dbg.reconcile'"), typeof mod.rescheduleAllReminders);
    expect(mod.rescheduleAllReminders).toBe(reschedule);
    expect(reschedule).toHaveBeenCalledTimes(1);

    // 第二次同步：服务端无新变更 → 不重复对账。
    await syncNow({ fetchImpl });
    expect(reschedule).toHaveBeenCalledTimes(1);
  });

  it("连接缺失/令牌缺失给出可操作错误", async () => {
    const { loadConnection, readToken } = await import("../../../db/syncConnection");
    vi.mocked(loadConnection).mockResolvedValueOnce(null);
    await expect(syncNow({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }))
      .rejects.toMatchObject({ kind: "validation" });

    vi.mocked(readToken).mockResolvedValueOnce(null);
    await expect(syncNow({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }))
      .rejects.toMatchObject({ kind: "validation" });
  });

  it("同步失败写入最近结果（含错误信息），不丢游标", async () => {
    // 401 不可重试：立即失败，不触发退避（网络类错误会重试 6 次，不适合单测等待）。
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized", message: "设备令牌无效或已被撤销" }),
    });
    await applyPullChanges([taskChange({ id: "t-1", rev: 1 })]);
    await saveSyncCursor("1");
    await expect(syncNow({ fetchImpl })).rejects.toThrow();
    const last = await getDatabase().getFirstAsync<{ value: string }>(
      "SELECT value FROM kv WHERE key = 'sync.last_result.v1'",
    );
    expect(last?.value).toContain("401");
    // 失败不推进/不回退游标。
    expect(await getDatabase().getFirstAsync<{ value: string }>(
      "SELECT value FROM kv WHERE key = 'sync.cursor.v1'",
    )).toEqual({ value: "1" });
  });
});
