/**
 * @vitest-environment jsdom
 */
//! 刷新调度：100 条事件只产生 1 次在途快照 + 至多 1 次追赶；隐藏窗口只置脏。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ agentSnapshot: vi.fn() }));
vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return { ...actual, agentSnapshot: bridge.agentSnapshot };
});

const SNAPSHOT = { sources: [], instances: [], sessions: [], runs: [] };

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("useAgentsStore 刷新调度", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    bridge.agentSnapshot.mockReset();
    bridge.agentSnapshot.mockResolvedValue(SNAPSHOT);
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("100 条事件在途期间只发 1 次快照，结束后至多补 1 次", async () => {
    let release!: (v: typeof SNAPSHOT) => void;
    bridge.agentSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { scheduleAgentRefresh, getAgentRefreshMetrics } = await import("./useAgentsStore");

    for (let i = 0; i < 100; i += 1) scheduleAgentRefresh("normal");
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.agentSnapshot).toHaveBeenCalledTimes(1);

    // 在途期间到达的事件只置脏，不并发再发请求
    for (let i = 0; i < 10; i += 1) scheduleAgentRefresh("normal");
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.agentSnapshot).toHaveBeenCalledTimes(1);

    release(SNAPSHOT);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.agentSnapshot).toHaveBeenCalledTimes(2);

    const metrics = getAgentRefreshMetrics();
    expect(metrics.snapshotRequests).toBe(2);
    expect(metrics.snapshotApplied).toBe(2);
    expect(metrics.maxConcurrent).toBe(1);
    expect(metrics.coalesced).toBe(109);
  });

  it("窗口隐藏时只置脏，恢复可见后补一次快照", async () => {
    setVisibility("hidden");
    const { scheduleAgentRefresh, getAgentRefreshMetrics } = await import("./useAgentsStore");

    for (let i = 0; i < 100; i += 1) scheduleAgentRefresh("normal");
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.agentSnapshot).not.toHaveBeenCalled();
    expect(getAgentRefreshMetrics().skippedHidden).toBe(100);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(100);
    expect(bridge.agentSnapshot).toHaveBeenCalledTimes(1);
    expect(getAgentRefreshMetrics().snapshotApplied).toBe(1);
  });
});
