/**
 * @vitest-environment jsdom
 */
//! 快捷投递目标 store：可用性缓存、请求去重/过期响应、结果保留。
//!
//! 这里只验证 store 的行为契约（什么时候重新探测、旧响应会不会覆盖新结果、
//! 移除目标后异常提示是否还在），真实目录探测由后端 Rust 用例覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dropTargets = vi.fn();
const dropToDirectory = vi.fn();
const commitToDirectory = vi.fn();
const deleteTarget = vi.fn();
const createTarget = vi.fn();
const updateTarget = vi.fn();
const moveTarget = vi.fn();

vi.mock("../lib/bridge", () => ({
  shelfDropTargets: (...a: unknown[]) => dropTargets(...a),
  shelfDropTargetCreate: (...a: unknown[]) => createTarget(...a),
  shelfDropTargetUpdate: (...a: unknown[]) => updateTarget(...a),
  shelfDropTargetDelete: (...a: unknown[]) => deleteTarget(...a),
  shelfDropTargetMove: (...a: unknown[]) => moveTarget(...a),
  shelfDropTargetOpen: vi.fn(),
  shelfDropToDirectory: (...a: unknown[]) => dropToDirectory(...a),
  dragPayloadCommitDirectory: (...a: unknown[]) => commitToDirectory(...a),
  applyMode: async () => undefined,
}));

import {
  AVAILABILITY_TTL_MS,
  __resetDropSubmitGuard,
  useDropTargetsStore,
} from "./useDropTargetsStore";

import type { ShelfDropTarget } from "../lib/bridge";

function target(over: Partial<ShelfDropTarget> = {}): ShelfDropTarget {
  return {
    id: "t1",
    name: "工作资料",
    path: "D:\\Work",
    sort_order: 0,
    show_in_capsule: true,
    op_mode: "copy",
    conflict: "rename",
    available: true,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    batch_id: "b1",
    target_id: "t1",
    target_path: "D:\\Work",
    op: "copy" as const,
    total: 1,
    success: 1,
    skipped: 0,
    failed: 0,
    partial: 0,
    entries: [],
    ...over,
  };
}

function reset() {
  useDropTargetsStore.setState({
    targets: [],
    loading: false,
    loaded: false,
    lastProbeAt: null,
    error: null,
    ops: {},
    reports: {},
    reportNames: {},
    lastTargetId: null,
    manageRequest: 0,
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  dropTargets.mockReset();
  dropToDirectory.mockReset();
  deleteTarget.mockReset();
  createTarget.mockReset();
  updateTarget.mockReset();
  moveTarget.mockReset();
  __resetDropSubmitGuard();
  reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDropTargetsStore 可用性刷新", () => {
  it("TTL 内复用缓存，过期后重新探测", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    dropTargets.mockResolvedValue([target()]);

    await useDropTargetsStore.getState().load();
    await useDropTargetsStore.getState().load();
    expect(dropTargets).toHaveBeenCalledTimes(1);
    expect(useDropTargetsStore.getState().lastProbeAt).toBe(1_000_000);

    now.mockReturnValue(1_000_000 + AVAILABILITY_TTL_MS + 1);
    await useDropTargetsStore.getState().load();
    expect(dropTargets).toHaveBeenCalledTimes(2);
  });

  it("手动刷新（force）无视 TTL 立即生效", async () => {
    dropTargets
      .mockResolvedValueOnce([target({ available: false })])
      .mockResolvedValueOnce([target({ available: true })]);
    await useDropTargetsStore.getState().load();
    expect(useDropTargetsStore.getState().targets[0].available).toBe(false);

    await useDropTargetsStore.getState().load({ force: true });
    expect(dropTargets).toHaveBeenCalledTimes(2);
    expect(useDropTargetsStore.getState().targets[0].available).toBe(true);
  });

  it("并发普通加载只发一次请求", async () => {
    const first = deferred<ReturnType<typeof target>[]>();
    dropTargets.mockReturnValueOnce(first.promise);
    const a = useDropTargetsStore.getState().load();
    const b = useDropTargetsStore.getState().load();
    first.resolve([target()]);
    await Promise.all([a, b]);
    expect(dropTargets).toHaveBeenCalledTimes(1);
  });

  it("慢响应不会覆盖后发起的强制刷新结果", async () => {
    const slow = deferred<ReturnType<typeof target>[]>();
    const fast = deferred<ReturnType<typeof target>[]>();
    dropTargets.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const p1 = useDropTargetsStore.getState().load();
    const p2 = useDropTargetsStore.getState().load({ force: true });
    fast.resolve([target({ id: "new" })]);
    await p2;
    slow.resolve([target({ id: "old" })]);
    await p1;

    expect(useDropTargetsStore.getState().targets.map((t) => t.id)).toEqual(["new"]);
  });

  it("加载失败保留旧列表并置错，不伪装成空", async () => {
    dropTargets.mockResolvedValueOnce([target()]);
    await useDropTargetsStore.getState().load();
    dropTargets.mockRejectedValueOnce(new Error("网络盘不可达"));
    await useDropTargetsStore.getState().load({ force: true });
    const s = useDropTargetsStore.getState();
    expect(s.error).toContain("网络盘不可达");
    expect(s.targets).toHaveLength(1);
  });
});

describe("useDropTargetsStore 结果保留", () => {
  it("投递时记录目标名，目标被移除后结果仍可读", async () => {
    dropTargets.mockResolvedValue([target()]);
    await useDropTargetsStore.getState().load();
    dropToDirectory.mockResolvedValue(report({ failed: 1, success: 0 }));
    await useDropTargetsStore.getState().drop("t1", ["C:\\a.txt"]);
    expect(useDropTargetsStore.getState().reportNames.t1).toBe("工作资料");

    deleteTarget.mockResolvedValue(undefined);
    await useDropTargetsStore.getState().remove("t1");

    const s = useDropTargetsStore.getState();
    expect(s.targets).toHaveLength(0);
    expect(s.reports.t1).toBeTruthy();
    expect(s.reportNames.t1).toBe("工作资料");
    expect(s.lastTargetId).toBe("t1");
  });

  it("全成功的批次在移除目标时一并清理，不残留提示", async () => {
    useDropTargetsStore.setState({
      reports: { t1: report() },
      reportNames: { t1: "工作资料" },
      lastTargetId: "t1",
    });
    deleteTarget.mockResolvedValue(undefined);
    await useDropTargetsStore.getState().remove("t1");

    const s = useDropTargetsStore.getState();
    expect(s.reports.t1).toBeUndefined();
    expect(s.reportNames.t1).toBeUndefined();
    expect(s.lastTargetId).toBeNull();
  });
});

describe("useDropTargetsStore 写操作与在途加载的竞态", () => {
  /** 发起一次 load 并保持 pending，便于在响应前插入写操作。 */
  function startLoad(list: ReturnType<typeof deferred<ReturnType<typeof target>[]>>) {
    dropTargets.mockReturnValueOnce(list.promise);
    return useDropTargetsStore.getState().load();
  }

  it("load 期间新增：旧快照不得覆盖新目标", async () => {
    const first = deferred<ReturnType<typeof target>[]>();
    const p = startLoad(first);
    // 列表还没回来时新增成功
    createTarget.mockResolvedValue(target({ id: "new", name: "新目标" }));
    await useDropTargetsStore.getState().create({ path: "D:\\New" });

    // 第二次（重试）返回后端权威列表
    dropTargets.mockResolvedValueOnce([target(), target({ id: "new", name: "新目标" })]);
    first.resolve([target()]); // 旧快照：没有 new
    await p;

    expect(useDropTargetsStore.getState().targets.map((t) => t.id)).toEqual(["t1", "new"]);
  });

  it("load 期间编辑：旧快照不得回滚新名称", async () => {
    const first = deferred<ReturnType<typeof target>[]>();
    const p = startLoad(first);
    updateTarget.mockResolvedValue(target({ name: "改过的名字" }));
    await useDropTargetsStore.getState().update("t1", { name: "改过的名字" });

    dropTargets.mockResolvedValueOnce([target({ name: "改过的名字" })]);
    first.resolve([target()]);
    await p;

    expect(useDropTargetsStore.getState().targets[0].name).toBe("改过的名字");
  });

  it("load 期间删除：旧快照不得让目标复活", async () => {
    useDropTargetsStore.setState({ targets: [target()], loaded: true });
    const first = deferred<ReturnType<typeof target>[]>();
    const p = startLoad(first);
    deleteTarget.mockResolvedValue(undefined);
    await useDropTargetsStore.getState().remove("t1");

    dropTargets.mockResolvedValueOnce([]);
    first.resolve([target()]); // 旧快照里还有 t1
    await p;

    expect(useDropTargetsStore.getState().targets).toEqual([]);
  });

  it("load 期间排序：旧快照不得恢复旧顺序", async () => {
    useDropTargetsStore.setState({
      targets: [target(), target({ id: "t2", name: "B", sort_order: 1 })],
      loaded: true,
    });
    const first = deferred<ReturnType<typeof target>[]>();
    const p = startLoad(first);
    const reordered = [
      target({ id: "t2", name: "B", sort_order: 0 }),
      target({ sort_order: 1 }),
    ];
    moveTarget.mockResolvedValue(reordered);
    await useDropTargetsStore.getState().move("t2", "up");

    dropTargets.mockResolvedValueOnce(reordered);
    first.resolve([target(), target({ id: "t2", name: "B", sort_order: 1 })]);
    await p;

    expect(useDropTargetsStore.getState().targets.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("连续两次新增都保留，且有界重试不产生请求风暴", async () => {
    const first = deferred<ReturnType<typeof target>[]>();
    const p = startLoad(first);
    createTarget
      .mockResolvedValueOnce(target({ id: "n1", name: "一" }))
      .mockResolvedValueOnce(target({ id: "n2", name: "二" }));
    await useDropTargetsStore.getState().create({ path: "D:\\1" });
    await useDropTargetsStore.getState().create({ path: "D:\\2" });

    const authoritative = [
      target(),
      target({ id: "n1", name: "一" }),
      target({ id: "n2", name: "二" }),
    ];
    dropTargets.mockResolvedValueOnce(authoritative);
    first.resolve([target()]);
    await p;

    expect(useDropTargetsStore.getState().targets.map((t) => t.id)).toEqual(["t1", "n1", "n2"]);
    // 首次 + 至多一次重试
    expect(dropTargets.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("写操作失败不提升代次、不改本地状态，在途加载正常应用", async () => {
    useDropTargetsStore.setState({ targets: [target()], loaded: true });
    const first = deferred<ReturnType<typeof target>[]>();
    const p = startLoad(first);
    createTarget.mockRejectedValue(new Error("目录已存在"));
    await expect(useDropTargetsStore.getState().create({ path: "D:\\Dup" })).rejects.toThrow(
      "目录已存在",
    );
    expect(useDropTargetsStore.getState().targets).toHaveLength(1);

    first.resolve([target(), target({ id: "t9", name: "后端新增" })]);
    await p;
    // 写失败没有提升代次，所以这份列表正常应用
    expect(useDropTargetsStore.getState().targets.map((t) => t.id)).toEqual(["t1", "t9"]);
    expect(dropTargets).toHaveBeenCalledTimes(1);
  });

  it("强制刷新与普通刷新并发：只应用最新一次响应", async () => {
    const normal = deferred<ReturnType<typeof target>[]>();
    const forced = deferred<ReturnType<typeof target>[]>();
    dropTargets.mockReturnValueOnce(normal.promise).mockReturnValueOnce(forced.promise);
    const p1 = useDropTargetsStore.getState().load();
    const p2 = useDropTargetsStore.getState().load({ force: true });
    forced.resolve([target({ id: "forced" })]);
    await p2;
    normal.resolve([target({ id: "normal" })]);
    await p1;
    expect(useDropTargetsStore.getState().targets.map((t) => t.id)).toEqual(["forced"]);
    expect(dropTargets).toHaveBeenCalledTimes(2);
  });
});

describe("useDropTargetsStore 提交拖入会话（commit）", () => {
  it("只传 operationId：在途状态、结果条与最近目标都按路径通道同一套口径更新", async () => {
    useDropTargetsStore.setState({ targets: [target()], loaded: true });
    const pending = deferred<ReturnType<typeof report>>();
    commitToDirectory.mockReturnValueOnce(pending.promise);

    const p = useDropTargetsStore.getState().commit("t1", "op-1", 2);

    // 在途：目标卡片据此显示「正在复制 2 项」，且不接受第二批
    expect(useDropTargetsStore.getState().ops["t1"]).toMatchObject({ targetId: "t1", total: 2 });
    expect(commitToDirectory).toHaveBeenCalledWith("t1", "op-1");
    expect(await useDropTargetsStore.getState().commit("t1", "op-2", 1)).toBeNull();

    pending.resolve(report() as never);
    const result = await p;
    expect(result?.success).toBe(1);
    const state = useDropTargetsStore.getState();
    expect(state.ops["t1"]).toBeUndefined();
    expect(state.reports["t1"]).toMatchObject({ batch_id: "b1" });
    expect(state.lastTargetId).toBe("t1");
    expect(state.reportNames["t1"]).toBe("工作资料");
  });

  it("同一 operationId 在 700ms 内重复提交被吞掉（一次拖放只写一次）", async () => {
    useDropTargetsStore.setState({ targets: [target()], loaded: true });
    commitToDirectory.mockResolvedValue(report());
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await useDropTargetsStore.getState().commit("t1", "op-dup");
    expect(await useDropTargetsStore.getState().commit("t1", "op-dup")).toBeNull();
    expect(commitToDirectory).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 701);
    await useDropTargetsStore.getState().commit("t1", "op-dup");
    expect(commitToDirectory).toHaveBeenCalledTimes(2);
  });

  it("提交失败：清掉在途状态、如实记录错误并抛给调用方（不伪装成功）", async () => {
    useDropTargetsStore.setState({ targets: [target()], loaded: true });
    commitToDirectory.mockRejectedValueOnce(new Error("目录不可写"));

    await expect(useDropTargetsStore.getState().commit("t1", "op-bad")).rejects.toThrow(
      "目录不可写",
    );
    const state = useDropTargetsStore.getState();
    expect(state.ops["t1"]).toBeUndefined();
    expect(state.error).toBe("目录不可写");
    expect(state.reports["t1"]).toBeUndefined();
  });

  it("空 operationId 直接忽略（不产生空提交）", async () => {
    useDropTargetsStore.setState({ targets: [target()], loaded: true });
    expect(await useDropTargetsStore.getState().commit("t1", "")).toBeNull();
    expect(commitToDirectory).not.toHaveBeenCalled();
  });
});
