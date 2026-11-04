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
}));

vi.mock("../lib/navigation", () => ({
  navListTargets: mocks.navListTargets,
  navAllTaskLinks: mocks.navAllTaskLinks,
  navScanApps: mocks.navScanApps,
}));

import { useNavigationStore } from "./useNavigationStore";

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
  useNavigationStore.setState({
    scan: null,
    scanning: false,
    scanError: null,
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
  });
});
