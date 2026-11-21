//! useAgentOperationsStore：合并、去重、乱序、状态转换、资源索引与分页同步。
//! bridge 全 mock，测试直接驱动 store 的 ingest/sync 路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentOperation } from "../lib/bridge";

const bridge = vi.hoisted(() => ({
  agentOperationsSync: vi.fn(),
  onAgentOperationChanged: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../lib/bridge", () => bridge);

import {
  decideMerge,
  resetAgentOperationSync,
  selectResourceOperations,
  useAgentOperationsStore,
  operationResourceKey,
} from "./useAgentOperationsStore";

function op(overrides: Partial<AgentOperation> = {}): AgentOperation {
  const now = "2026-11-21T01:00:00.000Z";
  return {
    id: "op-1",
    agentId: "codex",
    actorKind: "agent",
    interface: "mcp",
    action: "task.update",
    resourceKind: "task",
    resourceId: "t-1",
    projectId: "p-1",
    status: "running",
    phase: "started",
    stateRevision: 1,
    requestId: "",
    startedAt: now,
    updatedAt: now,
    errorCode: "",
    detail: "",
    ...overrides,
  };
}

function page(
  operations: AgentOperation[],
  options: { hasMore?: boolean; cursor?: { updatedAt: string; id: string } | null } = {},
) {
  const last = operations[operations.length - 1];
  return {
    operations,
    cursor:
      options.cursor !== undefined
        ? options.cursor
        : last
          ? { updatedAt: last.updatedAt, id: last.id }
          : null,
    activeCount: operations.filter((item) => item.status === "running").length,
    hasMore: options.hasMore ?? false,
  };
}

function state() {
  return useAgentOperationsStore.getState();
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.agentOperationsSync.mockReset();
  resetAgentOperationSync();
});

afterEach(() => {
  resetAgentOperationSync();
  vi.useRealTimers();
});

describe("agent operations store", () => {
  it("运行中的操作进入资源索引与活动列表", () => {
    state().ingest(op());
    expect(state().active).toHaveLength(1);
    expect(state().activeCount).toBe(1);
    expect(selectResourceOperations(state(), "task:t-1")).toHaveLength(1);
  });

  it("重复事件按 operationId 合并且不重复计数", () => {
    state().ingest(op());
    state().ingest(op());
    expect(state().active).toHaveLength(1);
    expect(state().recent).toHaveLength(0);
    expect(state().mergeRejections).toBe(0);
  });

  it("乱序旧事件不得把终态改回运行中", () => {
    state().ingest(op({ status: "committed", stateRevision: 4, updatedAt: "2026-11-21T01:00:05.000Z" }));
    state().ingest(op({ status: "running", stateRevision: 3, updatedAt: "2026-11-21T01:00:01.000Z" }));
    expect(state().active).toHaveLength(0);
    expect(state().recent[0]?.status).toBe("committed");
    expect(state().mergeRejections).toBe(1);
  });

  it("同一时间戳 running → committed 按状态版本接受", () => {
    const ts = "2026-11-21T01:00:00.000Z";
    state().ingest(op({ status: "running", stateRevision: 2, updatedAt: ts }));
    state().ingest(op({ status: "committed", stateRevision: 3, updatedAt: ts }));
    expect(state().active).toHaveLength(0);
    expect(state().recent[0]?.status).toBe("committed");
    expect(state().mergeRejections).toBe(0);
  });

  it("committed 之后收到 running：即使版本更高也拒绝（终态不回退）", () => {
    state().ingest(op({ status: "committed", stateRevision: 5 }));
    state().ingest(op({ status: "running", stateRevision: 9, updatedAt: "2026-11-21T01:00:09.000Z" }));
    expect(state().active).toHaveLength(0);
    expect(state().recent[0]?.status).toBe("committed");
    expect(state().lastMergeIssue).toBe("illegal-transition@op-1");
  });

  it("interrupted → committed 只允许真实恢复", () => {
    state().ingest(op({ status: "interrupted", stateRevision: 3, errorCode: "INTERRUPTED" }));
    state().ingest(
      op({ status: "committed", stateRevision: 4, detail: "业务提交后恢复", updatedAt: "2026-11-21T01:00:09.000Z" }),
    );
    expect(state().recent[0]?.status).toBe("committed");
    expect(state().active).toHaveLength(0);
  });

  it("同一 stateRevision 不同内容：拒绝覆盖并记录诊断", () => {
    state().ingest(op({ status: "running", phase: "started", stateRevision: 2 }));
    state().ingest(op({ status: "running", phase: "writing", stateRevision: 2 }));
    expect(state().byId["op-1"]?.phase).toBe("started");
    expect(state().mergeRejections).toBe(1);
    expect(state().lastMergeIssue).toBe("same-revision-conflict@op-1");
  });

  it("旧数据没有 stateRevision 时退回时间戳比较", () => {
    expect(
      decideMerge(
        op({ status: "committed", stateRevision: undefined, updatedAt: "2026-11-21T01:00:05.000Z" }),
        op({ status: "running", stateRevision: undefined, updatedAt: "2026-11-21T01:00:01.000Z" }),
      ),
    ).toBe("stale");
    expect(
      decideMerge(
        op({ status: "running", stateRevision: undefined }),
        op({ status: "running", stateRevision: undefined }),
      ),
    ).toBe("duplicate");
  });

  it("committed 短暂高亮后从资源索引消除，但保留在最近记录", () => {
    state().ingest(op());
    state().ingest(op({ status: "committed", stateRevision: 2, updatedAt: "2026-11-21T01:00:03.000Z" }));
    expect(state().active).toHaveLength(0);
    expect(selectResourceOperations(state(), "task:t-1")).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(selectResourceOperations(state(), "task:t-1")).toHaveLength(0);
    expect(state().recent[0]?.status).toBe("committed");
  });

  it("同一资源上的两个 Agent 同时可见", () => {
    state().ingest(op({ id: "op-a", agentId: "codex" }));
    state().ingest(op({ id: "op-b", agentId: "claude" }));
    const ops = selectResourceOperations(state(), "task:t-1");
    expect(ops.map((o) => o.agentId).sort()).toEqual(["claude", "codex"]);
  });

  it("不同资源互不高亮", () => {
    state().ingest(op({ id: "op-a", resourceId: "t-1" }));
    state().ingest(op({ id: "op-b", resourceId: "t-2" }));
    expect(selectResourceOperations(state(), "task:t-1")).toHaveLength(1);
    expect(selectResourceOperations(state(), "task:t-2")).toHaveLength(1);
  });

  it("未受影响的资源保持数组引用（不整列表重建）", () => {
    state().ingest(op({ id: "op-a", resourceId: "t-1" }));
    const before = selectResourceOperations(state(), "task:t-1");
    state().ingest(op({ id: "op-b", resourceId: "t-2" }));
    expect(selectResourceOperations(state(), "task:t-1")).toBe(before);
  });

  it("新建资源先用项目列表作为临时目标，提交后绑定真实 ID", () => {
    state().ingest(op({ id: "op-new", status: "running", resourceId: "" }));
    expect(selectResourceOperations(state(), "project:p-1")).toHaveLength(1);
    state().ingest(
      op({
        id: "op-new",
        status: "committed",
        stateRevision: 2,
        resourceId: "f-9",
        resourceKind: "feature",
        updatedAt: "2026-11-21T01:00:04.000Z",
      }),
    );
    expect(selectResourceOperations(state(), "feature:f-9")).toHaveLength(1);
    expect(selectResourceOperations(state(), "project:p-1")).toHaveLength(0);
  });

  it("游标同步合并数据库结果并推进游标", async () => {
    bridge.agentOperationsSync.mockResolvedValueOnce(page([op({ id: "op-sync" })]));
    await state().syncNow();
    expect(state().active).toHaveLength(1);
    expect(state().cursor?.id).toBe("op-sync");
    expect(bridge.agentOperationsSync).toHaveBeenCalledWith(null, 100);

    bridge.agentOperationsSync.mockResolvedValueOnce(page([], { cursor: null }));
    await state().syncNow();
    expect(bridge.agentOperationsSync).toHaveBeenLastCalledWith(
      { updatedAt: "2026-11-21T01:00:00.000Z", id: "op-sync" },
      100,
    );
  });

  it("hasMore 连续分页直到读完，并记录页数", async () => {
    bridge.agentOperationsSync
      .mockResolvedValueOnce(
        page([op({ id: "op-1" })], {
          hasMore: true,
          cursor: { updatedAt: "2026-11-21T01:00:01.000Z", id: "op-1" },
        }),
      )
      .mockResolvedValueOnce(
        page([op({ id: "op-2" })], {
          hasMore: true,
          cursor: { updatedAt: "2026-11-21T01:00:02.000Z", id: "op-2" },
        }),
      )
      .mockResolvedValueOnce(
        page([op({ id: "op-3" })], {
          hasMore: false,
          cursor: { updatedAt: "2026-11-21T01:00:03.000Z", id: "op-3" },
        }),
      );
    await state().syncNow();
    expect(bridge.agentOperationsSync).toHaveBeenCalledTimes(3);
    expect(state().active).toHaveLength(3);
    expect(state().lastSyncPages).toBe(3);
    expect(state().cursor?.id).toBe("op-3");
  });

  it("hasMore 始终为真时单轮最多 5 页，剩余留给下一轮", async () => {
    for (let i = 1; i <= 8; i += 1) {
      bridge.agentOperationsSync.mockResolvedValueOnce(
        page([op({ id: `op-${i}` })], {
          hasMore: true,
          cursor: { updatedAt: `2026-11-21T01:00:0${i}.000Z`, id: `op-${i}` },
        }),
      );
    }
    await state().syncNow();
    expect(bridge.agentOperationsSync).toHaveBeenCalledTimes(5);
    expect(state().lastSyncPages).toBe(5);
    expect(state().cursor?.id).toBe("op-5");
    expect(state().syncing).toBe(false);
  });

  it("游标不再推进时立即停止，避免无限同步", async () => {
    const stuck = { updatedAt: "2026-11-21T01:00:01.000Z", id: "op-1" };
    bridge.agentOperationsSync
      .mockResolvedValueOnce(page([op({ id: "op-1" })], { hasMore: true, cursor: stuck }))
      .mockResolvedValueOnce(page([], { hasMore: true, cursor: stuck }));
    await state().syncNow();
    expect(bridge.agentOperationsSync).toHaveBeenCalledTimes(2);
  });

  it("同步失败保留已合并状态与上一页游标", async () => {
    state().ingest(op({ id: "op-live" }));
    bridge.agentOperationsSync.mockResolvedValueOnce(page([op({ id: "op-live" })], { hasMore: true }));
    bridge.agentOperationsSync.mockRejectedValueOnce(new Error("db locked"));
    await state().syncNow();
    expect(state().active.length).toBe(1);
    expect(state().error).toContain("db locked");
    expect(state().syncing).toBe(false);
    expect(state().cursor?.id).toBe("op-live");
  });

  it("同步失败后重试可从游标继续", async () => {
    bridge.agentOperationsSync.mockRejectedValueOnce(new Error("busy"));
    await state().syncNow();
    expect(state().cursor).toBeNull();
    bridge.agentOperationsSync.mockResolvedValueOnce(page([op({ id: "op-retry" })]));
    await state().syncNow();
    expect(state().active.map((o) => o.id)).toEqual(["op-retry"]);
    expect(state().error).toBeNull();
  });

  it("启动恢复不闪烁历史终态，但增量同步会闪烁", async () => {
    bridge.agentOperationsSync.mockResolvedValueOnce(
      page([op({ id: "old-done", status: "committed", updatedAt: "2026-11-20T01:00:00.000Z" })]),
    );
    await state().syncNow();
    expect(selectResourceOperations(state(), "task:t-1")).toHaveLength(0);
    expect(state().recent[0]?.id).toBe("old-done");

    bridge.agentOperationsSync.mockResolvedValueOnce(
      page([op({ id: "new-done", status: "committed", stateRevision: 2 })]),
    );
    await state().syncNow();
    expect(selectResourceOperations(state(), "task:t-1")).toHaveLength(1);
  });

  it("失败/冲突保留在最近记录并带错误码", () => {
    state().ingest(
      op({ status: "conflict", errorCode: "CONFLICT", detail: "版本已变化" }),
    );
    expect(state().recent[0]?.errorCode).toBe("CONFLICT");
    expect(state().active).toHaveLength(0);
  });

  it("资源 key 对空 ID 回退到项目", () => {
    expect(operationResourceKey(op({ resourceId: "" }))).toBe("project:p-1");
    expect(operationResourceKey(op({ resourceId: "", projectId: "" }))).toBe("");
  });
});
