/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChangedEvent, AgentHistorySession, AgentHistorySessionsQuery } from "../lib/bridge";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  useAgentHistoryGroups,
  useAgentRunHistory,
  useAgentSessionHistory,
} from "./useAgentHistory";

const ipc = vi.hoisted(() => ({ sessions: vi.fn(), groups: vi.fn(), runs: vi.fn(), listen: vi.fn() }));
vi.mock("../lib/bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/bridge")>(),
  agentHistorySessions: ipc.sessions,
  agentHistoryGroups: ipc.groups,
  agentHistoryRuns: ipc.runs,
  onAgentChanged: ipc.listen,
}));

const item = (id = "head", source = "codex"): AgentHistorySession => ({
  id, source_id: source, external_id: id, title: id, status: "completed",
  first_seen_at: "2026-11-05T00:00:00Z", last_seen_at: "2026-11-05T01:00:00Z",
  last_run_id: null, instance_id: null, run_count: 1,
});
const page = (id = "head", source = "codex") => ({
  items: [item(id, source)], total: 1, next_cursor: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let handlers = new Set<(event: AgentChangedEvent) => void>();
let unlisten = vi.fn();
const flush = () => act(async () => {});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function emit(source = "codex") {
  act(() => {
    for (const handler of handlers) handler({
      source_id: source, sources: [source], session_id: "changed", states: {},
      changed: true, deduplicated: false, late: false, batch: 1,
    });
  });
}
const probes = () => ipc.sessions.mock.calls.filter(([query]) => query.limit === 1);

beforeEach(() => {
  vi.useFakeTimers();
  ipc.sessions.mockReset();
  ipc.groups.mockReset();
  ipc.runs.mockReset();
  ipc.listen.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  useEdgeSnapStore.setState({ phase: "free", dockedEdge: null });
  useSettingsStore.setState({ settings: null });
  handlers = new Set();
  unlisten = vi.fn();
  ipc.listen.mockImplementation(async (handler) => {
    handlers.add(handler);
    return () => { handlers.delete(handler); unlisten(); };
  });
  ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) => page("head", query.sourceId));
  ipc.groups.mockResolvedValue({ items: [], truncated: false });
  ipc.runs.mockResolvedValue({ items: [], total: 0, next_cursor: null });
});
afterEach(async () => {
  cleanup();
  await flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Agent 历史共享监听与生命周期", () => {
  it("共享筛选中一个分区卸载后，监听仍服务于其余分区", async () => {
    ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) =>
      page(query.limit === 1 ? "new-head" : "head", query.sourceId),
    );
    const first = renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    const second = renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    await flush();
    expect(ipc.listen).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(unlisten).not.toHaveBeenCalled();
    emit();
    await advance(800);

    expect(probes()).toHaveLength(1);
    expect(second.result.current.hasNewer).toBe(true);
    second.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it.each([1, 5, 20])("%i 个相同筛选消费者、100 条事件只建一条监听并探测一次", async (count) => {
    const mounted = Array.from({ length: count }, () => renderHook(() =>
      useAgentSessionHistory({ sourceId: "codex", enabled: true })));
    await flush();
    expect(ipc.listen).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 100; n += 1) emit();
    await advance(799);
    expect(probes()).toHaveLength(0);
    await advance(1);
    expect(probes()).toHaveLength(1);
    mounted.forEach(({ unmount }) => unmount());
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(handlers.size).toBe(0);
  });

  it("20 个不同实例过滤各自探测，IPC 并发最多 3，不重复、不混合实例", async () => {
    const pending: ReturnType<typeof deferred<ReturnType<typeof page>>>[] = [];
    let concurrent = 0;
    let peak = 0;
    ipc.sessions.mockImplementation((query: AgentHistorySessionsQuery) => {
      if (query.limit !== 1) return Promise.resolve(page());
      const request = deferred<ReturnType<typeof page>>();
      pending.push(request);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      return request.promise.finally(() => { concurrent -= 1; });
    });
    Array.from({ length: 20 }, (_, n) => renderHook(() =>
      useAgentSessionHistory({ sourceId: "codex", instanceId: `instance-${n}`, enabled: true })));
    await flush();
    emit("trae");
    await advance(800);
    expect(probes()).toHaveLength(0);
    for (let n = 0; n < 100; n += 1) emit();
    await advance(800);
    expect(probes()).toHaveLength(3);
    let completed = 0;
    while (pending.length > 0) {
      const request = pending.shift()!;
      await act(async () => { request.resolve(page()); });
      completed += 1;
    }
    expect(completed).toBe(20);
    expect(new Set(probes().map(([query]) => query.instanceId)).size).toBe(20);
    expect(peak).toBe(3);
  });

  it("注册失败只有一条固定诊断且保留分页，手动刷新可恢复监听", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ipc.listen.mockRejectedValueOnce(new Error("native listen failed"));
    const { result } = renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    await flush();
    expect(result.current.liveError).toContain("可手动刷新");
    expect(result.current.items[0].id).toBe("head");
    expect(result.current.error).toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith("[agent-history] event-listen-failed");
    act(() => result.current.reload());
    await flush();
    expect(ipc.listen).toHaveBeenCalledTimes(2);
    expect(result.current.liveError).toBeNull();
    expect(handlers.size).toBe(1);
  });

  it("监听注册尚未完成时卸载，注册兑现后立即退订", async () => {
    const registration = deferred<() => void>();
    ipc.listen.mockReturnValueOnce(registration.promise);
    const { unmount } = renderHook(() => useAgentSessionHistory({ enabled: true }));
    await flush();
    unmount();
    await act(async () => registration.resolve(unlisten));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("最后分区关闭取消待执行探测，重复挂载/卸载 100 次不留监听", async () => {
    for (let n = 0; n < 100; n += 1) {
      const { unmount } = renderHook(() => useAgentSessionHistory({ enabled: true }));
      await flush();
      emit();
      unmount();
    }
    await advance(1000);
    expect(ipc.listen).toHaveBeenCalledTimes(100);
    expect(unlisten).toHaveBeenCalledTimes(100);
    expect(handlers.size).toBe(0);
    expect(probes()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("文档隐藏时不查询，恢复可见后只补一次探测", async () => {
    const { result } = renderHook(() => useAgentSessionHistory({ enabled: true }));
    await flush();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    for (let n = 0; n < 100; n += 1) emit();
    await advance(1000);
    expect(probes()).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(800);
    expect(probes()).toHaveLength(1);
    expect(result.current.hasNewer).toBe(false);
  });

  it("胶囊模式释放监听并保留分页，恢复只补探测不重复全量加载", async () => {
    const { result } = renderHook(() => useAgentSessionHistory({ enabled: true }));
    await flush();
    act(() => useEdgeSnapStore.setState({ phase: "docked-visible" }));
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(result.current.items[0].id).toBe("head");
    for (let n = 0; n < 100; n += 1) emit();
    await advance(1000);
    expect(probes()).toHaveLength(0);
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
    await flush();
    await advance(800);
    expect(ipc.listen).toHaveBeenCalledTimes(2);
    expect(probes()).toHaveLength(1);
    expect(ipc.sessions.mock.calls.filter(([query]) => query.limit === 10)).toHaveLength(1);
  });

  it("胶囊期间不加载历史分组或轮次，恢复后各补一次请求", async () => {
    const groups = renderHook(() => useAgentHistoryGroups("codex", true, "live"));
    const runs = renderHook(() => useAgentRunHistory("session-1", true));
    await advance(150);
    await flush();
    expect(ipc.groups).toHaveBeenCalledTimes(1);
    expect(ipc.runs).toHaveBeenCalledTimes(1);

    act(() => useEdgeSnapStore.setState({ phase: "docked-visible" }));
    await flush();
    expect(groups.result.current.loading).toBe(false);
    expect(runs.result.current.loading).toBe(false);
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
    await advance(150);
    await flush();

    expect(ipc.groups).toHaveBeenCalledTimes(2);
    // 已加载轮次页保留缓存并重新显示；避免恢复时重复查询同一页。
    expect(ipc.runs).toHaveBeenCalledTimes(1);
    expect(runs.result.current.loaded).toBe(true);
    groups.unmount();
    runs.unmount();
  });

  it("来源切换后旧探测响应失效，新来源事件仍可更新", async () => {
    const old = deferred<ReturnType<typeof page>>();
    ipc.sessions.mockImplementation((query: AgentHistorySessionsQuery) => {
      if (query.limit === 1 && query.sourceId === "codex") return old.promise;
      return Promise.resolve(page(query.limit === 1 ? "new" : "head", query.sourceId));
    });
    const { result, rerender } = renderHook(({ sourceId }) =>
      useAgentSessionHistory({ sourceId, enabled: true }), { initialProps: { sourceId: "codex" } });
    await flush();
    emit();
    await advance(800);
    rerender({ sourceId: "trae" });
    await flush();
    await act(async () => old.resolve(page("old-new")));
    expect(result.current.hasNewer).toBe(false);
    emit("trae");
    await advance(800);
    expect(result.current.hasNewer).toBe(true);
  });

  it("实时轮次翻页仅保留当前页，历史模式仍可累积分页", async () => {
    const run = (id: string) => ({
      id, session_id: "session-1", source_id: "codex", external_run_id: id,
      task_title: id, status: "running", started_at: "2026-11-06T00:00:00Z",
      updated_at: "2026-11-06T00:00:00Z", ended_at: null, pending_items: [], instance_id: null,
    });
    ipc.runs
      .mockResolvedValueOnce({ items: [run("live-1")], total: 2, next_cursor: "next" })
      .mockResolvedValueOnce({ items: [run("live-2")], total: 2, next_cursor: null });

    const { result, unmount } = renderHook(() => useAgentRunHistory("session-1", true, 1, true));
    await flush();
    expect(result.current.items.map(({ id }) => id)).toEqual(["live-1"]);
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.items.map(({ id }) => id)).toEqual(["live-2"]);
    expect(ipc.runs.mock.calls.map(([sessionId, cursor, limit, includeLive, liveOnly]) =>
      [sessionId, cursor, limit, includeLive, liveOnly])).toEqual([
      ["session-1", null, 1, false, true],
      ["session-1", "next", 1, false, true],
    ]);
    unmount();
  });

  // ── P1-01 agent-changed 事件契约（stale 统一载荷 + 运行时校验）──
  it("stale 单来源事件按来源精准探测，不串台", async () => {
    const codex = renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    const trae = renderHook(() => useAgentSessionHistory({ sourceId: "trae", enabled: true }));
    await flush();
    ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) =>
      query.limit === 1 ? page("new-head", query.sourceId) : page("head", query.sourceId),
    );
    act(() => {
      for (const handler of handlers) handler({
        source_id: "codex", sources: ["codex"], session_id: "sess-1", run_id: "run-1",
        state: "disconnected", states: { disconnected: 1 }, batch: 1,
        changed: true, deduplicated: false, late: false, stale_cleanup: 1,
      } as AgentChangedEvent);
    });
    await advance(800);
    expect(probes().map(([q]) => q.sourceId)).toEqual(["codex"]);
    expect(codex.result.current.hasNewer).toBe(true);
    expect(trae.result.current.hasNewer).toBe(false);
    codex.unmount(); trae.unmount();
  });

  it("stale 多来源事件触发所有受影响来源，不遗漏", async () => {
    const codex = renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    const trae = renderHook(() => useAgentSessionHistory({ sourceId: "trae", enabled: true }));
    const other = renderHook(() => useAgentSessionHistory({ sourceId: "other", enabled: true }));
    await flush();
    ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) =>
      query.limit === 1 ? page("new-head", query.sourceId) : page("head", query.sourceId),
    );
    act(() => {
      for (const handler of handlers) handler({
        source_id: "trae", sources: ["codex", "trae"], session_id: "", run_id: "run-3",
        state: "disconnected", states: { disconnected: 3 }, batch: 3,
        changed: true, deduplicated: false, late: false, stale_cleanup: 3,
      } as AgentChangedEvent);
    });
    await advance(800);
    expect(new Set(probes().map(([q]) => q.sourceId))).toEqual(new Set(["codex", "trae"]));
    expect(codex.result.current.hasNewer).toBe(true);
    expect(trae.result.current.hasNewer).toBe(true);
    expect(other.result.current.hasNewer).toBe(false);
    codex.unmount(); trae.unmount(); other.unmount();
  });

  it("旧 stale 载荷（仅 stale_cleanup）不抛 TypeError 并触发全局探测", async () => {
    renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    renderHook(() => useAgentSessionHistory({ sourceId: "trae", enabled: true }));
    await flush();
    ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) =>
      query.limit === 1 ? page("new-head", query.sourceId) : page("head", query.sourceId),
    );
    expect(() => {
      act(() => {
        for (const handler of handlers) handler({ stale_cleanup: 2 } as unknown as AgentChangedEvent);
      });
    }).not.toThrow();
    await advance(800);
    expect(probes()).toHaveLength(2);
  });

  it("缺少可选字段的合法事件仍按来源探测", async () => {
    renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    await flush();
    ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) =>
      query.limit === 1 ? page("new-head", query.sourceId) : page("head", query.sourceId),
    );
    act(() => {
      for (const handler of handlers) handler({
        source_id: "codex", sources: ["codex"],
      } as unknown as AgentChangedEvent);
    });
    await advance(800);
    expect(probes()).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["空对象", {}],
    ["字符串载荷", "codex"],
    ["数字载荷", 123],
    ["sources 类型错误", { sources: "codex", changed: true }],
  ])("不合法载荷（%s）安全降级，不抛错且不探测", async (_label, raw) => {
    const { result } = renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    await flush();
    expect(() => {
      act(() => {
        for (const handler of handlers) handler(raw as unknown as AgentChangedEvent);
      });
    }).not.toThrow();
    await advance(1000);
    expect(probes()).toHaveLength(0);
    expect(result.current.hasNewer).toBe(false);
  });

  it("changed=false 时保持去重，不探测", async () => {
    renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    await flush();
    act(() => {
      for (const handler of handlers) handler({
        source_id: "codex", sources: ["codex"], session_id: "s", states: {},
        changed: false, deduplicated: true, late: false, batch: 1,
      } as AgentChangedEvent);
    });
    await advance(1000);
    expect(probes()).toHaveLength(0);
  });

  it("事件顺序变化（先 unrelated 后 relevant）仍只探测一次相关来源", async () => {
    renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    await flush();
    ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) =>
      query.limit === 1 ? page("new-head", query.sourceId) : page("head", query.sourceId),
    );
    act(() => {
      for (const h of handlers) h({
        source_id: "trae", sources: ["trae"], session_id: "s", states: {},
        changed: true, deduplicated: false, late: false, batch: 1,
      } as AgentChangedEvent);
      for (const h of handlers) h({
        source_id: "codex", sources: ["codex"], session_id: "s", states: {},
        changed: true, deduplicated: false, late: false, batch: 1,
      } as AgentChangedEvent);
    });
    await advance(800);
    expect(probes()).toHaveLength(1);
    expect(probes()[0][0].sourceId).toBe("codex");
  });

  it("订阅卸载后事件到达不探测、不抛错", async () => {
    const { unmount } = renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    await flush();
    unmount();
    expect(handlers.size).toBe(0);
    expect(() => {
      act(() => { for (const handler of handlers) handler({ stale_cleanup: 1 } as unknown as AgentChangedEvent); });
    }).not.toThrow();
    await advance(1000);
    expect(probes()).toHaveLength(0);
  });

  it("全局事件触发实时摘要探测刷新（多分区均收到）", async () => {
    renderHook(() => useAgentSessionHistory({ sourceId: "codex", enabled: true }));
    renderHook(() => useAgentSessionHistory({ sourceId: "trae", enabled: true }));
    await flush();
    ipc.sessions.mockImplementation(async (query: AgentHistorySessionsQuery) =>
      query.limit === 1 ? page("new-head", query.sourceId) : page("head", query.sourceId),
    );
    act(() => {
      for (const handler of handlers) handler({
        source_id: "", sources: [], session_id: "", states: { disconnected: 5 },
        batch: 5, changed: true, deduplicated: false, late: false, stale_cleanup: 5,
      } as AgentChangedEvent);
    });
    await advance(800);
    expect(probes()).toHaveLength(2);
  });
});
