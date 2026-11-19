// @vitest-environment node
//! 功能生命周期运行时：去重、重试、状态流转与指标口径。
//!
//! 这些断言对应 docs/ON_DEMAND_LOADING.md §3 的契约；改动 runtime 语义必须先改
//! 文档与这里，否则「重复加载/重试失效/资源不释放」会以静默方式回归。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFeatureRuntimeForTests,
  activateFeature,
  deactivateFeature,
  disposeFeature,
  getFeatureRuntimeSummary,
  getFeatureSnapshot,
  isFeatureLoaded,
  listFeatureEvents,
  listFeatureSnapshots,
  loadFeature,
  noteFeatureInstanceReleased,
  peekFeatureModule,
  preloadFeature,
  registerFeature,
  resumeFeature,
  retryFeature,
  suspendFeature,
} from "./featureRuntime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("featureRuntime", () => {
  beforeEach(() => {
    __resetFeatureRuntimeForTests();
  });

  it("注册只登记元数据，不会触发代码加载", () => {
    const load = vi.fn(async () => ({ default: {} }));
    registerFeature({ id: "test:page", label: "测试页", load });
    expect(load).not.toHaveBeenCalled();
    expect(getFeatureSnapshot("test:page")?.state).toBe("registered");
    expect(isFeatureLoaded("test:page")).toBe(false);
  });

  it("非法 ID 与重复注册不同 loader 会被拒绝", () => {
    expect(() => registerFeature({ id: "noPrefix", label: "x" })).toThrow();
    registerFeature({ id: "test:dup", label: "x", load: async () => ({ default: {} }) });
    // 同 loader 幂等
    const loader = async () => ({ default: {} });
    registerFeature({ id: "test:dup2", label: "y", load: loader });
    registerFeature({ id: "test:dup2", label: "y", load: loader });
    // 不同 loader：同一 ID 有两个代码入口 → 直接失败，避免歧义
    expect(() =>
      registerFeature({ id: "test:dup", label: "x", load: async () => ({ default: {} }) }),
    ).toThrow(/重复注册/);
  });

  it("并发加载只执行一次 import，重复请求被合并", async () => {
    const gate = deferred<{ default: unknown }>();
    const load = vi.fn(() => gate.promise);
    registerFeature({ id: "test:a", label: "A", load });

    const first = loadFeature("test:a");
    const second = loadFeature("test:a");
    expect(load).toHaveBeenCalledTimes(1);
    expect(getFeatureSnapshot("test:a")?.state).toBe("loading");

    gate.resolve({ default: { name: "A" } });
    await Promise.all([first, second]);

    const snapshot = getFeatureSnapshot("test:a");
    expect(snapshot?.state).toBe("loaded");
    expect(snapshot?.loads).toBe(1);
    // 两个请求，一次真实执行：差值就是被合并掉的重复加载。
    expect(snapshot?.loadRequests).toBe(2);
    expect(snapshot?.loadExecutions).toBe(1);
    expect(getFeatureRuntimeSummary().loadRequests - getFeatureRuntimeSummary().loadExecutions).toBe(1);
  });

  it("失败不缓存 Promise，重试会真正重新加载", async () => {
    const load = vi
      .fn<() => Promise<{ default: unknown }>>()
      .mockRejectedValueOnce(new Error("chunk 404"))
      .mockResolvedValueOnce({ default: { ok: true } });
    registerFeature({ id: "test:retry", label: "Retry", load });

    await expect(loadFeature("test:retry")).rejects.toThrow("chunk 404");
    expect(getFeatureSnapshot("test:retry")?.state).toBe("failed");
    expect(getFeatureSnapshot("test:retry")?.lastError).toContain("chunk 404");

    await retryFeature("test:retry");
    const snapshot = getFeatureSnapshot("test:retry");
    expect(load).toHaveBeenCalledTimes(2);
    expect(snapshot?.state).toBe("loaded");
    expect(snapshot?.failures).toBe(1);
    expect(snapshot?.retries).toBe(1);
    expect(snapshot?.lastError).toBeNull();
  });

  it("依赖先于被依赖功能加载", async () => {
    const order: string[] = [];
    registerFeature({
      id: "test:dep",
      label: "依赖",
      load: async () => {
        order.push("dep");
        return { default: {} };
      },
    });
    registerFeature({
      id: "test:child",
      label: "子功能",
      dependsOn: ["test:dep"],
      load: async () => {
        order.push("child");
        return { default: {} };
      },
    });
    await loadFeature("test:child");
    expect(order).toEqual(["dep", "child"]);
  });

  it("激活会先确保加载，离开后进入 inactive；暂停/恢复只改状态", async () => {
    registerFeature({
      id: "test:life",
      label: "Life",
      load: async () => ({ default: {} }),
    });

    await activateFeature("test:life");
    let snapshot = getFeatureSnapshot("test:life");
    expect(snapshot?.state).toBe("active");
    expect(snapshot?.loads).toBe(1);
    expect(snapshot?.activations).toBe(1);

    // 重复激活不重复计数（React StrictMode / 重复事件都走这里）
    await activateFeature("test:life");
    expect(getFeatureSnapshot("test:life")?.activations).toBe(1);

    suspendFeature("test:life");
    expect(getFeatureSnapshot("test:life")?.state).toBe("suspended");
    expect(getFeatureRuntimeSummary().suspended).toBe(1);

    resumeFeature("test:life");
    expect(getFeatureSnapshot("test:life")?.state).toBe("active");

    deactivateFeature("test:life");
    snapshot = getFeatureSnapshot("test:life");
    expect(snapshot?.state).toBe("inactive");
    expect(snapshot?.deactivations).toBe(1);
    expect(getFeatureRuntimeSummary().active).toBe(0);
  });

  it("页面实例释放与功能资源释放是两件事", async () => {
    const dispose = vi.fn(() => {});
    registerFeature({
      id: "test:dispose",
      label: "Dispose",
      load: async () => ({ default: {} }),
      dispose,
    });
    await loadFeature("test:dispose");
    noteFeatureInstanceReleased("test:dispose");
    expect(getFeatureSnapshot("test:dispose")?.instanceReleases).toBe(1);
    // 实例释放不触发功能资源释放，也不清代码缓存
    expect(dispose).not.toHaveBeenCalled();
    expect(peekFeatureModule("test:dispose")).toBeTruthy();

    await disposeFeature("test:dispose");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getFeatureSnapshot("test:dispose")?.state).toBe("disposed");
    // 代码仍在缓存：再进入页面不需要重新下载
    expect(isFeatureLoaded("test:dispose")).toBe(true);
  });

  it("预加载严格匹配策略：hover↔hover、idle↔idle、never 全拒", async () => {
    const make = (id: string, preload: "hover" | "idle" | "never") => {
      const load = vi.fn(async () => ({ default: {} }));
      registerFeature({ id, label: id, preload, load });
      return load;
    };
    const hover = make("test:policy-hover", "hover");
    const idle = make("test:policy-idle", "idle");
    const never = make("test:policy-never", "never");

    // hover 策略：接受 hover，拒绝 idle
    expect(preloadFeature("test:policy-hover", "hover")).toBe("started");
    await loadFeature("test:policy-hover");
    expect(hover).toHaveBeenCalledTimes(1);
    expect(preloadFeature("test:policy-hover", "idle")).toBe("loaded");

    // idle 策略：拒绝 hover（不允许降级），接受 idle
    expect(preloadFeature("test:policy-idle", "hover")).toBe("skipped");
    expect(idle).not.toHaveBeenCalled();
    expect(preloadFeature("test:policy-idle", "idle")).toBe("started");
    await loadFeature("test:policy-idle");
    expect(idle).toHaveBeenCalledTimes(1);

    // never：两种原因都拒绝
    expect(preloadFeature("test:policy-never", "hover")).toBe("skipped");
    expect(preloadFeature("test:policy-never", "idle")).toBe("skipped");
    expect(never).not.toHaveBeenCalled();
  });

  it("已加载模块再预加载返回 loaded，不重复 import", async () => {
    const load = vi.fn(async () => ({ default: {} }));
    registerFeature({ id: "test:preload-loaded", label: "Loaded", preload: "hover", load });
    await loadFeature("test:preload-loaded");
    expect(preloadFeature("test:preload-loaded", "hover")).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(1);
    expect(getFeatureSnapshot("test:preload-loaded")?.loads).toBe(1);
  });

  it("预加载进行中用户点击：复用同一个请求，只 import 一次", async () => {
    const gate = deferred<{ default: unknown }>();
    const load = vi.fn(() => gate.promise);
    registerFeature({ id: "test:preload-reuse", label: "Reuse", preload: "hover", load });

    expect(preloadFeature("test:preload-reuse", "hover")).toBe("started");
    const clicked = loadFeature("test:preload-reuse");
    expect(load).toHaveBeenCalledTimes(1);

    gate.resolve({ default: { reused: true } });
    await clicked;
    const snapshot = getFeatureSnapshot("test:preload-reuse");
    expect(load).toHaveBeenCalledTimes(1);
    expect(snapshot?.loads).toBe(1);
    expect(snapshot?.loadExecutions).toBe(1);
    expect(snapshot?.preloads).toBe(1);
  });

  it("预加载失败进入冷却，不会反复重试同一个坏模块", async () => {
    let attempts = 0;
    registerFeature({
      id: "test:preload-bad",
      label: "Bad",
      preload: "hover",
      load: async () => {
        attempts += 1;
        throw new Error("network");
      },
    });
    expect(preloadFeature("test:preload-bad", "hover")).toBe("started");
    await tick();
    await tick();
    const snapshot = getFeatureSnapshot("test:preload-bad");
    expect(snapshot?.preloads).toBe(1);
    expect(snapshot?.preloadFailures).toBe(1);
    // 冷却期内不再反复触发同一个坏模块
    expect(preloadFeature("test:preload-bad", "hover")).toBe("skipped");
    expect(attempts).toBe(1);
  });

  it("有加载在飞行时，预加载让路", async () => {
    const gate = deferred<{ default: unknown }>();
    registerFeature({ id: "test:busy-1", label: "B1", load: () => gate.promise });
    registerFeature({
      id: "test:busy-2",
      label: "B2",
      preload: "hover",
      load: async () => ({ default: {} }),
    });
    void loadFeature("test:busy-1");
    expect(preloadFeature("test:busy-2")).toBe("skipped");
    gate.resolve({ default: {} });
  });

  it("快照对象只在字段变化时替换（useSyncExternalStore 稳定）", async () => {
    registerFeature({ id: "test:snap", label: "Snap", load: async () => ({ default: {} }) });
    const before = getFeatureSnapshot("test:snap");
    // 读取两次不产生新对象
    expect(getFeatureSnapshot("test:snap")).toBe(before);
    await loadFeature("test:snap");
    expect(getFeatureSnapshot("test:snap")).not.toBe(before);
    expect(listFeatureSnapshots().length).toBe(1);
    expect(listFeatureEvents().length).toBeGreaterThan(0);
  });
});
