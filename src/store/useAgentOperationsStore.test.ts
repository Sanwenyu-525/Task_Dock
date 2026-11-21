//! useAgentOperationsStore：合并、去重、乱序、资源索引与短暂停留。
//! bridge 全 mock，测试直接驱动 store 的 ingest/sync 路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentOperation } from "../lib/bridge";

const bridge = vi.hoisted(() => ({
  agentOperationsSync: vi.fn(),
  onAgentOperationChanged: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../lib/bridge", () => bridge);

import {
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
    requestId: "",
    startedAt: now,
    updatedAt: now,
    errorCode: "",
    detail: "",
    ...overrides,
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
    state().ingest(op({ updatedAt: "2026-11-21T01:00:00.000Z" }));
    expect(state().active).toHaveLength(1);
    expect(state().recent).toHaveLength(0);
  });

  it("乱序旧事件不得把终态改回运行中", () => {
    state().ingest(op({ status: "committed", updatedAt: "2026-11-21T01:00:05.000Z" }));
    state().ingest(op({ status: "running", updatedAt: "2026-11-21T01:00:01.000Z" }));
    expect(state().active).toHaveLength(0);
    expect(state().recent[0]?.status).toBe("committed");
  });

  it("committed 短暂高亮后从资源索引消除，但保留在最近记录", () => {
    state().ingest(op());
    state().ingest(op({ status: "committed", updatedAt: "2026-11-21T01:00:03.000Z" }));
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
        resourceId: "f-9",
        resourceKind: "feature",
        updatedAt: "2026-11-21T01:00:04.000Z",
      }),
    );
    expect(selectResourceOperations(state(), "feature:f-9")).toHaveLength(1);
    expect(selectResourceOperations(state(), "project:p-1")).toHaveLength(0);
  });

  it("游标同步合并数据库结果并推进游标", async () => {
    bridge.agentOperationsSync.mockResolvedValueOnce({
      operations: [op({ id: "op-sync" })],
      cursor: { updatedAt: "2026-11-21T01:00:00.000Z", id: "op-sync" },
      activeCount: 1,
      hasMore: false,
    });
    await state().syncNow();
    expect(state().active).toHaveLength(1);
    expect(state().cursor?.id).toBe("op-sync");
    expect(bridge.agentOperationsSync).toHaveBeenCalledWith(null, 50);

    bridge.agentOperationsSync.mockResolvedValueOnce({
      operations: [],
      cursor: { updatedAt: "2026-11-21T01:00:00.000Z", id: "op-sync" },
      activeCount: 1,
      hasMore: false,
    });
    await state().syncNow();
    expect(bridge.agentOperationsSync).toHaveBeenLastCalledWith(
      { updatedAt: "2026-11-21T01:00:00.000Z", id: "op-sync" },
      50,
    );
  });

  it("同步失败保留旧状态并记录错误", async () => {
    state().ingest(op());
    bridge.agentOperationsSync.mockRejectedValueOnce(new Error("db locked"));
    await state().syncNow();
    expect(state().active).toHaveLength(1);
    expect(state().error).toContain("db locked");
    expect(state().syncing).toBe(false);
  });

  it("启动恢复不闪烁历史终态，但增量同步会闪烁", async () => {
    bridge.agentOperationsSync.mockResolvedValueOnce({
      operations: [
        op({ id: "old-done", status: "committed", updatedAt: "2026-11-20T01:00:00.000Z" }),
      ],
      cursor: { updatedAt: "2026-11-20T01:00:00.000Z", id: "old-done" },
      activeCount: 0,
      hasMore: false,
    });
    await state().syncNow();
    expect(selectResourceOperations(state(), "task:t-1")).toHaveLength(0);
    expect(state().recent[0]?.id).toBe("old-done");

    bridge.agentOperationsSync.mockResolvedValueOnce({
      operations: [
        op({ id: "new-done", status: "committed", updatedAt: "2026-11-21T01:00:06.000Z" }),
      ],
      cursor: { updatedAt: "2026-11-21T01:00:06.000Z", id: "new-done" },
      activeCount: 0,
      hasMore: false,
    });
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
