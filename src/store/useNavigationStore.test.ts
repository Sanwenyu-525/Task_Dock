//! 导航刷新契约测试：
//! - 失败返回 `error` 且保留旧数据；
//! - 并发请求只接受最新代际（旧响应返回 `stale`，不覆盖新数据）；
//! - 关联读取失败 → 重试成功后自动清除错误；
//! - 扫描在途时重复调用返回 `stale`，不叠加请求。

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navListTargets: vi.fn(),
  navAllTaskLinks: vi.fn(),
  navScanApps: vi.fn(),
  unlistenScanBatch: vi.fn(),
  scanBatchHandler: null as ((batch: unknown) => void) | null,
  onNavScanBatch: vi.fn(async (handler: (batch: unknown) => void) => {
    mocks.scanBatchHandler = handler;
    return mocks.unlistenScanBatch;
  }),
}));

vi.mock("../lib/navigation", () => ({
  navListTargets: mocks.navListTargets,
  navAllTaskLinks: mocks.navAllTaskLinks,
  navScanApps: mocks.navScanApps,
  onNavScanBatch: mocks.onNavScanBatch,
}));

const discovered = (key: string, name = key) => ({
  app_key: key,
  display_name: name,
  exe_path: `C:\\Apps\\${key}.exe`,
  source: "startmenu",
  category: "other",
});

import { deriveScanState, useNavigationStore } from "./useNavigationStore";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const target = (id: string) => ({ id, app_key: id, display_name: id }) as never;
const link = (taskId: string, id: string, order = 0) =>
  ({ id, task_id: taskId, display_order: order }) as never;

beforeEach(() => {
  mocks.navListTargets.mockReset();
  mocks.navAllTaskLinks.mockReset();
  mocks.navScanApps.mockReset();
  mocks.onNavScanBatch.mockClear();
  mocks.unlistenScanBatch.mockClear();
  mocks.scanBatchHandler = null;
  useNavigationStore.setState({
    scan: null,
    scanning: false,
    scanError: null,
    scanProgress: null,
    scanPartial: false,
    targets: [],
    targetsLoaded: false,
    targetsError: null,
    linksByTask: {},
    linksError: null,
  });
});

describe("loadTargets · 刷新结果契约", () => {
  it("成功返回 ok 并清除旧错误", async () => {
    useNavigationStore.setState({ targetsError: "旧错误" });
    mocks.navListTargets.mockResolvedValueOnce([target("a")]);
    await expect(useNavigationStore.getState().loadTargets(true)).resolves.toBe("ok");
    expect(useNavigationStore.getState().targets).toHaveLength(1);
    expect(useNavigationStore.getState().targetsError).toBeNull();
  });

  it("失败返回 error，保留旧数据并记录原因（保存成功+刷新失败不能算整体成功）", async () => {
    useNavigationStore.setState({ targets: [target("a")], targetsLoaded: true });
    mocks.navListTargets.mockRejectedValueOnce(new Error("读取超时"));
    await expect(useNavigationStore.getState().loadTargets(true)).resolves.toBe("error");
    expect(useNavigationStore.getState().targets).toHaveLength(1);
    expect(useNavigationStore.getState().targetsError).toContain("读取超时");
  });

  it("连续快速刷新：旧响应返回 stale，不覆盖新请求结果", async () => {
    const first = deferred<never[]>();
    const second = deferred<never[]>();
    mocks.navListTargets
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const p1 = useNavigationStore.getState().loadTargets(true);
    const p2 = useNavigationStore.getState().loadTargets(true);
    second.resolve([target("new")]);
    await expect(p2).resolves.toBe("ok");
    first.resolve([target("old")]);
    await expect(p1).resolves.toBe("stale");
    expect(useNavigationStore.getState().targets).toEqual([target("new")]);
  });
});

describe("loadTaskLinks · 关联读取失败与恢复", () => {
  it("失败返回 error、保留旧映射并标记可重试", async () => {
    useNavigationStore.setState({ linksByTask: { t1: [link("t1", "old")] } });
    mocks.navAllTaskLinks.mockRejectedValueOnce(new Error("关联读取失败"));
    await expect(useNavigationStore.getState().loadTaskLinks()).resolves.toBe("error");
    expect(useNavigationStore.getState().linksByTask.t1).toHaveLength(1);
    expect(useNavigationStore.getState().linksError).toContain("关联读取失败");
  });

  it("重试成功后写入新映射并清除错误", async () => {
    useNavigationStore.setState({ linksError: "关联读取失败" });
    mocks.navAllTaskLinks.mockResolvedValueOnce([
      link("t1", "b", 2),
      link("t1", "a", 1),
    ]);
    await expect(useNavigationStore.getState().loadTaskLinks()).resolves.toBe("ok");
    expect(useNavigationStore.getState().linksByTask.t1.map((l) => l.id)).toEqual(["a", "b"]);
    expect(useNavigationStore.getState().linksError).toBeNull();
  });
});

describe("loadApps · 扫描去重", () => {
  it("扫描在途时重复调用返回 stale，不叠加请求", async () => {
    const first = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(first.promise);

    const p1 = useNavigationStore.getState().loadApps(true);
    await expect(useNavigationStore.getState().loadApps(true)).resolves.toBe("stale");
    expect(mocks.navScanApps).toHaveBeenCalledTimes(1);

    first.resolve({ apps: [] } as never);
    await expect(p1).resolves.toBe("ok");
    expect(useNavigationStore.getState().scanning).toBe(false);
  });

  it("扫描失败返回 error 并保留上次结果", async () => {
    useNavigationStore.setState({ scan: { apps: [] } as never });
    mocks.navScanApps.mockRejectedValueOnce(new Error("扫描失败"));
    await expect(useNavigationStore.getState().loadApps(true)).resolves.toBe("error");
    expect(useNavigationStore.getState().scan).toEqual({ apps: [] });
    expect(useNavigationStore.getState().scanError).toContain("扫描失败");
    expect(useNavigationStore.getState().scanPartial).toBe(false);
  });
});

describe("loadApps · 渐进扫描", () => {
  /** 等监听注册完成，再模拟后端推送批次。 */
  async function waitForListener() {
    await vi.waitFor(() => expect(mocks.scanBatchHandler).not.toBeNull());
    return mocks.scanBatchHandler!;
  }
  async function currentScanId(): Promise<string> {
    await vi.waitFor(() => expect(mocks.navScanApps).toHaveBeenCalled());
    const call = mocks.navScanApps.mock.calls.at(-1);
    return call?.[1] as string;
  }

  it("首批到达立即显示，按 app_key 去重且顺序稳定；完成后收敛权威结果", async () => {
    const finalScan = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(finalScan.promise);
    const load = useNavigationStore.getState().loadApps(true);
    const handler = await waitForListener();
    const scanId = await currentScanId();

    handler({
      scan_id: scanId,
      source: "startmenu",
      apps: [
        discovered("b", "Beta"),
        discovered("a", "Alpha"),
        discovered("b", "Beta"), // 同批重复：按 app_key 去重
      ],
      discovered: 2,
      sources_done: 1,
      sources_total: 5,
    });
    await vi.waitFor(() => expect(useNavigationStore.getState().scan).not.toBeNull());
    expect(useNavigationStore.getState().scan?.apps.map((a) => a.app_key)).toEqual(["a", "b"]);
    expect(useNavigationStore.getState().scanPartial).toBe(true);
    expect(useNavigationStore.getState().scanProgress).toMatchObject({
      discovered: 2,
      sourcesDone: 1,
      sourcesTotal: 5,
      batches: 1,
    });

    // 第二批追加后仍按名称稳定排序
    handler({
      scan_id: scanId,
      source: "registry",
      apps: [discovered("c", "Charlie")],
      discovered: 3,
      sources_done: 2,
      sources_total: 5,
    });
    expect(useNavigationStore.getState().scan?.apps.map((a) => a.app_key)).toEqual(["a", "b", "c"]);

    finalScan.resolve({ apps: [discovered("a", "Alpha")], scanned_at: "2026-11-05T10:00:00Z" } as never);
    await expect(load).resolves.toBe("ok");
    const state = useNavigationStore.getState();
    expect(state.scan?.apps.map((a) => a.app_key)).toEqual(["a"]);
    expect(state.scan?.scanned_at).toBe("2026-11-05T10:00:00Z");
    expect(state.scanPartial).toBe(false);
    expect(state.scanProgress).toBeNull();
    expect(state.scanning).toBe(false);
    expect(mocks.unlistenScanBatch).toHaveBeenCalledTimes(1);
  });

  it("过期扫描的批次事件被忽略，不会覆盖当前结果", async () => {
    const first = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(first.promise);
    const load = useNavigationStore.getState().loadApps(true);
    const handler = await waitForListener();
    const staleId = await currentScanId();
    first.resolve({ apps: [discovered("a", "Alpha")] } as never);
    await load;

    // 新一次扫描期间，旧 scan_id 的迟到批次必须被丢弃
    const second = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(second.promise);
    void useNavigationStore.getState().loadApps(true);
    await vi.waitFor(() =>
      expect(mocks.navScanApps.mock.calls.at(-1)?.[1]).not.toBe(staleId),
    );
    handler({
      scan_id: staleId,
      source: "startmenu",
      apps: [discovered("stale", "过期应用")],
      discovered: 1,
      sources_done: 1,
      sources_total: 5,
    });
    expect(useNavigationStore.getState().scan?.apps.map((a) => a.app_key)).toEqual(["a"]);
    expect(useNavigationStore.getState().scanProgress?.discovered).toBe(0);

    second.resolve({ apps: [] } as never);
    await vi.waitFor(() => expect(useNavigationStore.getState().scanning).toBe(false));
  });

  it("已有结果时重扫不清空列表：批次只更新进度，失败保留上次结果", async () => {
    const previous = { apps: [discovered("old", "旧应用")], scanned_at: "2026-11-04T10:00:00Z" };
    useNavigationStore.setState({ scan: previous as never, scanPartial: false });
    const scan = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(scan.promise);
    const load = useNavigationStore.getState().loadApps(true);
    const handler = await waitForListener();
    const scanId = await currentScanId();

    handler({
      scan_id: scanId,
      source: "startmenu",
      apps: [discovered("new", "新应用")],
      discovered: 1,
      sources_done: 1,
      sources_total: 5,
    });
    await vi.waitFor(() => expect(useNavigationStore.getState().scanProgress?.discovered).toBe(1));
    expect(useNavigationStore.getState().scan).toEqual(previous);
    expect(useNavigationStore.getState().scanPartial).toBe(false);

    scan.reject(new Error("重扫失败"));
    await expect(load).resolves.toBe("error");
    expect(useNavigationStore.getState().scan).toEqual(previous);
    expect(useNavigationStore.getState().scanError).toContain("重扫失败");
    expect(useNavigationStore.getState().scanPartial).toBe(false);
  });

  it("首次扫描中途失败：保留部分结果并标记为不完整", async () => {
    const scan = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(scan.promise);
    const load = useNavigationStore.getState().loadApps(true);
    const handler = await waitForListener();
    const scanId = await currentScanId();

    handler({
      scan_id: scanId,
      source: "startmenu",
      apps: [discovered("a", "Alpha")],
      discovered: 1,
      sources_done: 1,
      sources_total: 5,
    });
    scan.reject(new Error("来源读取失败"));
    await expect(load).resolves.toBe("error");
    const state = useNavigationStore.getState();
    expect(state.scan?.apps.map((a) => a.app_key)).toEqual(["a"]);
    expect(state.scanPartial).toBe(true);
    expect(state.scanProgress).toBeNull();
    expect(state.scanError).toContain("来源读取失败");
    expect(mocks.unlistenScanBatch).toHaveBeenCalledTimes(1);
  });

  it("首个空批次只推进进度，不创建 scan（避免界面误判为「扫描完成」）", async () => {
    const scan = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(scan.promise);
    const load = useNavigationStore.getState().loadApps(true);
    const handler = await waitForListener();
    const scanId = await currentScanId();

    handler({
      scan_id: scanId,
      source: "startmenu",
      apps: [],
      discovered: 0,
      sources_done: 1,
      sources_total: 5,
    });
    const state = useNavigationStore.getState();
    expect(state.scan).toBeNull();
    expect(state.scanning).toBe(true);
    expect(state.scanProgress).toMatchObject({
      discovered: 0,
      sourcesDone: 1,
      sourcesTotal: 5,
      batches: 1,
    });

    scan.resolve({ apps: [], scanned_at: "2026-11-05T10:00:00Z" } as never);
    await expect(load).resolves.toBe("ok");
    const done = useNavigationStore.getState();
    expect(done.scan?.apps).toEqual([]);
    expect(done.scanning).toBe(false);
    expect(done.scanProgress).toBeNull();
    expect(done.scanPartial).toBe(false);
  });

  it("连续多个空批次后首批有效应用到达：此时才建立列表，进度连续累加", async () => {
    const scan = deferred<never>();
    mocks.navScanApps.mockReturnValueOnce(scan.promise);
    const load = useNavigationStore.getState().loadApps(true);
    const handler = await waitForListener();
    const scanId = await currentScanId();

    for (let i = 1; i <= 2; i += 1) {
      handler({
        scan_id: scanId,
        source: i === 1 ? "known" : "app_paths",
        apps: [],
        discovered: 0,
        sources_done: i,
        sources_total: 5,
      });
      expect(useNavigationStore.getState().scan).toBeNull();
      expect(useNavigationStore.getState().scanProgress?.batches).toBe(i);
    }

    handler({
      scan_id: scanId,
      source: "registry",
      apps: [discovered("a", "Alpha")],
      discovered: 1,
      sources_done: 3,
      sources_total: 5,
    });
    expect(useNavigationStore.getState().scan?.apps.map((a) => a.app_key)).toEqual(["a"]);
    expect(useNavigationStore.getState().scanProgress?.sourcesDone).toBe(3);

    scan.resolve({ apps: [discovered("a", "Alpha")], scanned_at: "2026-11-05T10:00:00Z" } as never);
    await expect(load).resolves.toBe("ok");
  });
});

describe("deriveScanState · 显式扫描状态机", () => {
  const scan = { apps: [discovered("a")], scanned_at: "2026-11-05T10:00:00Z" } as never;

  it("未扫描：没有结果、不在扫描、没有错误", () => {
    expect(
      deriveScanState({ scan: null, scanning: false, scanError: null, scanPartial: false }),
    ).toBe("unscanned");
  });

  it("扫描中·尚无结果：空批次只推进进度，不得翻成完成", () => {
    expect(
      deriveScanState({ scan: null, scanning: true, scanError: null, scanPartial: true }),
    ).toBe("scanning-empty");
  });

  it("扫描中·已有结果：首批到达后立即展示，后续来源未完成前不算完成", () => {
    expect(
      deriveScanState({ scan, scanning: true, scanError: null, scanPartial: true }),
    ).toBe("scanning-partial");
  });

  it("完成：结果与诊断都完整", () => {
    expect(
      deriveScanState({ scan, scanning: false, scanError: null, scanPartial: false }),
    ).toBe("complete");
    // 刷新失败但上次结果完整：仍按完成（另有「显示上次结果」提示，不降级为部分失败）。
    expect(
      deriveScanState({ scan, scanning: false, scanError: "刷新失败", scanPartial: false }),
    ).toBe("complete");
  });

  it("部分失败：有结果但明确不完整（中途失败或诊断报告部分来源失败）", () => {
    expect(
      deriveScanState({ scan, scanning: false, scanError: "来源读取失败", scanPartial: true }),
    ).toBe("partial");
    expect(
      deriveScanState({ scan, scanning: false, scanError: null, scanPartial: false, incomplete: true }),
    ).toBe("partial");
  });

  it("完全失败：没有任何可用结果", () => {
    expect(
      deriveScanState({ scan: null, scanning: false, scanError: "扫描服务不可用", scanPartial: false }),
    ).toBe("failed");
  });
});
