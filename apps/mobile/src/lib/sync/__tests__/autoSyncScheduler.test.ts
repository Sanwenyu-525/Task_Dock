// 前台自动同步调度器的定时器生命周期（fake timer）。
//
// 覆盖用户明确要求的 7 个行为：
// 1. 失败后创建重试计时；
// 2. 退避时间到期真正触发一次请求（不是只写 next_attempt_at）；
// 3. 退后台取消待执行计时；
// 4. 回到前台按持久化的 next_attempt_at 重新排；
// 5. 关闭自动同步后取消；
// 6. 成功后清除失败计数与 next_attempt_at；
// 7. 多次前台/后台切换不产生多个计时器（到期只触发一次）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kv = new Map<string, string>();
/** 依次决定每次 syncNow 成功/失败；用队列而不是 mockResolvedValueOnce，避免残留实现干扰。 */
let syncSteps: Array<"ok" | "fail"> = [];
const syncCalls: number[] = [];

vi.mock("../../../db/kv", () => ({
  getSetting: vi.fn(async (key: string) => kv.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    kv.set(key, value);
  }),
}));

vi.mock("../../../db/syncConnection", () => ({
  loadConnection: vi.fn(async () => ({ host: "192.168.5.7", port: 47899, version: 2 })),
  readToken: vi.fn(async () => "token"),
}));

vi.mock("../../../db/attachments", () => ({
  countAttachmentsForTransfer: vi.fn(async () => 0),
}));

vi.mock("../../../db/sync", () => ({
  countPendingSyncOps: vi.fn(async () => 0),
  countSyncConflicts: vi.fn(async () => 0),
  loadSyncResult: vi.fn(async () => null),
}));

vi.mock("../engine", () => ({
  isSyncing: vi.fn(() => false),
  syncNow: vi.fn(async () => {
    syncCalls.push(Date.now());
    const step = syncSteps.shift() ?? "ok";
    if (step === "fail") throw new Error("网络中断");
    return { applied: 1, pushed: 0 };
  }),
}));

vi.mock("../connectionState", () => ({
  isLegacyConnection: vi.fn(() => false),
}));

vi.mock("../../net/network", () => ({
  probeNetworkMetering: vi.fn(() => "unmetered"),
}));

vi.mock("../localChange", () => ({
  subscribeLocalChange: vi.fn(() => () => undefined),
}));

async function loadModule() {
  return import("../autoSync");
}

describe("autoSync 前台重试定时器", () => {
  beforeEach(() => {
    kv.clear();
    syncSteps = [];
    syncCalls.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("失败后按 30s 退避创建计时，到期真正再发一次请求", async () => {
    const mod = await loadModule();
    mod.setAutoSyncForeground(true);
    syncSteps = ["fail", "fail"];

    await mod.runAutoSync("foreground");
    expect(syncCalls.length).toBe(1);
    expect(kv.get("sync.auto.failures")).toBe("1");
    const next = Number(kv.get("sync.auto.next_attempt_at"));
    expect(next).toBeGreaterThan(Date.now());

    // 到期前不触发
    await vi.advanceTimersByTimeAsync(29_000);
    expect(syncCalls.length).toBe(1);

    // 到期后触发第二次请求，并进入第二档退避
    await vi.advanceTimersByTimeAsync(1_500);
    expect(syncCalls.length).toBe(2);
    expect(kv.get("sync.auto.failures")).toBe("2");

    mod.cancelAutoSync();
  });

  it("退后台取消待执行计时，回前台按 next_attempt_at 重新排", async () => {
    const mod = await loadModule();
    mod.setAutoSyncForeground(true);
    syncSteps = ["fail"];
    await mod.runAutoSync("foreground");
    expect(syncCalls.length).toBe(1);

    // 退后台：计时被取消，到期也不会发请求
    mod.setAutoSyncForeground(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(syncCalls.length).toBe(1);

    // 回前台：退避已过期 → 立即请求；请求本身仍受 8s 防抖约束
    syncSteps = ["ok"];
    mod.setAutoSyncForeground(true);
    await vi.advanceTimersByTimeAsync(8_100);
    expect(syncCalls.length).toBe(2);
  });

  it("关闭自动同步后取消计时", async () => {
    const mod = await loadModule();
    mod.setAutoSyncForeground(true);
    syncSteps = ["fail"];
    await mod.runAutoSync("foreground");
    expect(syncCalls.length).toBe(1);

    await mod.saveAutoSyncSettings({ enabled: false });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(syncCalls.length).toBe(1);
  });

  it("成功后清除失败计数与下次尝试时间，不再重试", async () => {
    const mod = await loadModule();
    mod.setAutoSyncForeground(true);
    syncSteps = ["fail", "ok"];
    await mod.runAutoSync("foreground");
    expect(kv.get("sync.auto.failures")).toBe("1");

    await vi.advanceTimersByTimeAsync(31_000);
    expect(syncCalls.length).toBe(2);
    expect(kv.get("sync.auto.failures")).toBe("0");
    expect(kv.get("sync.auto.next_attempt_at")).toBe("0");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncCalls.length).toBe(2);
  });

  it("多次前台/后台切换不会叠加计时器（到期只触发一次）", async () => {
    const mod = await loadModule();
    syncSteps = ["fail", "ok"];
    await mod.runAutoSync("foreground");

    for (let index = 0; index < 3; index += 1) {
      mod.setAutoSyncForeground(false);
      mod.setAutoSyncForeground(true);
    }
    await vi.advanceTimersByTimeAsync(31_000);
    // 首次失败 1 次 + 到期重试 1 次 = 2；若计时器叠加会多于 2
    expect(syncCalls.length).toBe(2);
  });
});
