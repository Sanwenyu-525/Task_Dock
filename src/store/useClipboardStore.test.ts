import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ clipboardView: vi.fn() }));

import { clipboardView } from "../lib/bridge";
import type { ClipboardView } from "../lib/bridge";
import { resetClipboardRequestState, useClipboardStore } from "./useClipboardStore";

const mockedView = vi.mocked(clipboardView);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function viewOf(itemIds: string[], groupIds: string[] = []): ClipboardView {
  return {
    items: itemIds.map((id) => ({ id })),
    groups: groupIds.map((id) => ({ id })),
    stats: {},
    total_items: itemIds.length,
  } as unknown as ClipboardView;
}

function itemOf(id: string, copyCount = 1) {
  return { id, copy_count: copyCount };
}

function resetStore() {
  resetClipboardRequestState();
  useClipboardStore.setState({
    view: null,
    filters: { kind: "all", search: "", favorite: false },
    loading: false,
    loadingMore: false,
    error: null,
    selectedItems: [],
    selectedGroups: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks 不会清掉 mockImplementation，跨用例必须显式重置。
  mockedView.mockReset();
  resetStore();
});

describe("useClipboardStore", () => {
  it("修改筛选时清空多选", () => {
    useClipboardStore.setState({ selectedItems: ["a"], selectedGroups: ["g"] });
    useClipboardStore.getState().setFilters({ kind: "image", search: " 周报 " });
    const state = useClipboardStore.getState();
    expect(state.filters).toEqual({ kind: "image", search: " 周报 ", favorite: false });
    expect(state.selectedItems).toEqual([]);
    expect(state.selectedGroups).toEqual([]);
  });

  it("加载首页并剔除已不存在于列表中的多选项", async () => {
    useClipboardStore.setState({ selectedItems: ["old"], selectedGroups: ["gone"] });
    mockedView.mockResolvedValueOnce(viewOf(["a", "b"], ["g1"]));
    await useClipboardStore.getState().load();
    const state = useClipboardStore.getState();
    expect(state.view?.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(state.selectedItems).toEqual([]);
    expect(state.selectedGroups).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(mockedView).toHaveBeenCalledWith({
      kind: "all",
      search: undefined,
      favorite: false,
      limit: 80,
      offset: 0,
    });
  });

  it("追加分页时保留已有条目并以 offset 请求下一页", async () => {
    mockedView.mockResolvedValueOnce(viewOf(["a", "b"]));
    await useClipboardStore.getState().load();
    mockedView.mockResolvedValueOnce(viewOf(["c"]));
    await useClipboardStore.getState().load({ append: true });
    const state = useClipboardStore.getState();
    expect(state.view?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(mockedView).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 2, limit: 80 }),
    );
    expect(state.loadingMore).toBe(false);
  });

  it("加载失败时记录错误并结束加载态", async () => {
    mockedView.mockRejectedValueOnce(new Error("db unavailable"));
    await useClipboardStore.getState().load();
    const state = useClipboardStore.getState();
    expect(state.error).toContain("db unavailable");
    expect(state.loading).toBe(false);
    expect(state.loadingMore).toBe(false);
  });

  it("快速切换筛选时，旧请求的迟到响应不得覆盖新结果", async () => {
    const slow = deferred<ClipboardView>();
    mockedView.mockReturnValueOnce(slow.promise);
    const first = useClipboardStore.getState().load();

    useClipboardStore.getState().setFilters({ kind: "text", search: " 周报 " });
    mockedView.mockResolvedValueOnce(viewOf(["fresh"]));
    await useClipboardStore.getState().load();

    slow.resolve(viewOf(["stale"]));
    await first;

    expect(useClipboardStore.getState().view?.items.map((i) => i.id)).toEqual(["fresh"]);
    expect(useClipboardStore.getState().error).toBeNull();
  });

  it("旧筛选请求失败也不会污染新筛选的错误状态", async () => {
    const slow = deferred<ClipboardView>();
    mockedView.mockReturnValueOnce(slow.promise);
    const first = useClipboardStore.getState().load();

    useClipboardStore.getState().setFilters({ kind: "image" });
    mockedView.mockResolvedValueOnce(viewOf(["img"]));
    await useClipboardStore.getState().load();

    slow.reject(new Error("stale failure"));
    await first;

    const state = useClipboardStore.getState();
    expect(state.view?.items.map((i) => i.id)).toEqual(["img"]);
    expect(state.error).toBeNull();
  });

  it("追加分页按 id 去重，重叠页不会产生重复条目", async () => {
    mockedView.mockResolvedValueOnce(viewOf(["a", "b"]));
    await useClipboardStore.getState().load();
    mockedView.mockResolvedValueOnce(viewOf(["b", "c"]));
    await useClipboardStore.getState().load({ append: true });
    expect(useClipboardStore.getState().view?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("加载更多与后台刷新并发时，较早的追加页必须被丢弃", async () => {
    mockedView.mockResolvedValueOnce(viewOf(["a", "b"]));
    await useClipboardStore.getState().load();

    const append = deferred<ClipboardView>();
    mockedView.mockReturnValueOnce(append.promise);
    const appendRun = useClipboardStore.getState().load({ append: true });

    mockedView.mockResolvedValueOnce(viewOf(["a", "b", "c"]));
    await useClipboardStore.getState().load({ silent: true });

    append.resolve(viewOf(["old-page"]));
    await appendRun;

    const state = useClipboardStore.getState();
    expect(state.view?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(state.loadingMore).toBe(false);
  });

  it("筛选切换后迟到的追加响应不得拼接旧页", async () => {
    mockedView.mockResolvedValueOnce(viewOf(["a", "b"]));
    await useClipboardStore.getState().load();

    const append = deferred<ClipboardView>();
    mockedView.mockReturnValueOnce(append.promise);
    const appendRun = useClipboardStore.getState().load({ append: true });

    useClipboardStore.getState().setFilters({ kind: "url" });
    mockedView.mockResolvedValueOnce(viewOf(["u1"]));
    await useClipboardStore.getState().load();

    append.resolve(viewOf(["a", "b", "c"]));
    await appendRun;

    const state = useClipboardStore.getState();
    expect(state.view?.items.map((i) => i.id)).toEqual(["u1"]);
    expect(state.loadingMore).toBe(false);
  });

  it("复制后只就地累加使用次数，不请求整表、不改变顺序", () => {
    useClipboardStore.setState({
      view: {
        ...viewOf(["a", "b", "c"]),
        items: [itemOf("a"), itemOf("b"), itemOf("c")],
      } as unknown as ClipboardView,
    });

    useClipboardStore.getState().bumpItemCopy("b");

    const state = useClipboardStore.getState();
    expect(state.view?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(state.view?.items.map((i) => i.copy_count)).toEqual([1, 2, 1]);
    expect(mockedView).not.toHaveBeenCalled();
  });

  it("静默刷新保留已加载的多页，不退化成第一页", async () => {
    const ids = Array.from({ length: 240 }, (_, i) => `i${i}`);
    useClipboardStore.setState({ view: viewOf(ids) });
    const calls: { limit?: number; offset?: number }[] = [];
    mockedView.mockImplementation(async (filter) => {
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 80;
      calls.push({ limit, offset });
      const page = ids.slice(offset, offset + limit).map((id) => ({
        id,
        copy_count: 1,
      }));
      return { items: page, groups: [], stats: {}, total_items: ids.length } as unknown as ClipboardView;
    });

    await useClipboardStore.getState().load({ silent: true });

    expect(calls).toEqual([
      { limit: 200, offset: 0 },
      { limit: 40, offset: 200 },
    ]);
    const items = useClipboardStore.getState().view?.items ?? [];
    expect(items.length).toBe(240);
    expect(items[0].id).toBe("i0");
    expect(items[239].id).toBe("i239");
    expect(useClipboardStore.getState().view?.total_items).toBe(240);
  });

  it("静默刷新遇到短页即停止，不做多余请求", async () => {
    useClipboardStore.setState({ view: viewOf(["a", "b"]) });
    const calls: { limit?: number; offset?: number }[] = [];
    mockedView.mockImplementation(async (filter) => {
      calls.push({ limit: filter?.limit, offset: filter?.offset });
      return viewOf(["a", "b"]) as ClipboardView;
    });

    await useClipboardStore.getState().load({ silent: true });

    expect(calls).toEqual([{ limit: 80, offset: 0 }]);
  });

  it("列表刷新后清理已删除条目的选择，保留仍存在项", async () => {
    useClipboardStore.setState({ selectedItems: ["a", "gone"], selectedGroups: ["g1", "g2"] });
    mockedView.mockResolvedValueOnce(viewOf(["a"], ["g1"]));
    await useClipboardStore.getState().load();
    const state = useClipboardStore.getState();
    expect(state.selectedItems).toEqual(["a"]);
    expect(state.selectedGroups).toEqual(["g1"]);
  });

  describe("离场中的行", () => {
    it("静默刷新不得提前卸载离场中的条目，且按原位钉回", async () => {
      useClipboardStore.setState({ view: viewOf(["a", "b", "c"]) });
      useClipboardStore.getState().beginExit(["b"], "item");

      mockedView.mockResolvedValueOnce(viewOf(["a", "c"]));
      await useClipboardStore.getState().load({ silent: true });

      expect(useClipboardStore.getState().view?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
      expect(useClipboardStore.getState().exiting.b).toBeTruthy();
    });

    it("后台新采集的条目照常进入列表，不影响离场行", async () => {
      useClipboardStore.setState({ view: viewOf(["a", "b"]) });
      useClipboardStore.getState().beginExit(["b"], "item");

      mockedView.mockResolvedValueOnce(viewOf(["new", "a"]));
      await useClipboardStore.getState().load({ silent: true });

      const ids = useClipboardStore.getState().view?.items.map((i) => i.id) ?? [];
      expect(ids).toContain("new");
      expect(ids).toContain("b");
      expect(ids.filter((id) => id === "b")).toHaveLength(1);
    });

    it("endExit 放手并把这一行从本地视图剔除", async () => {
      useClipboardStore.setState({ view: viewOf(["a", "b", "c"]) });
      useClipboardStore.getState().beginExit(["b"], "item");
      useClipboardStore.getState().endExit(["b"]);

      expect(useClipboardStore.getState().exiting).toEqual({});
      expect(useClipboardStore.getState().view?.items.map((i) => i.id)).toEqual(["a", "c"]);
    });

    it("离场收尾定时器归 store 所有：组件卸载后到点仍会自动收尾", () => {
      vi.useFakeTimers();
      try {
        useClipboardStore.setState({ view: viewOf(["a", "b", "c"]) });
        // 模拟「删除成功 → 动画中途关闭抽屉」：beginExit 之后没有任何组件再调 endExit
        useClipboardStore.getState().beginExit(["b"], "item");
        expect(useClipboardStore.getState().exiting.b).toBeTruthy();

        vi.advanceTimersByTime(190);
        const state = useClipboardStore.getState();
        expect(state.exiting).toEqual({});
        expect(state.view?.items.map((i) => i.id)).toEqual(["a", "c"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("endExit 幂等：重复或多余 id 不影响仍在离场的其他行", () => {
      vi.useFakeTimers();
      try {
        useClipboardStore.setState({ view: viewOf(["a", "b", "c"]) });
        useClipboardStore.getState().beginExit(["b", "c"], "item");
        useClipboardStore.getState().endExit(["b"]);
        // 组件定时器与 store 定时器可能先后各调一次：幂等是硬要求
        useClipboardStore.getState().endExit(["b"]);
        expect(useClipboardStore.getState().exiting.c).toBeTruthy();

        vi.advanceTimersByTime(190);
        expect(useClipboardStore.getState().exiting).toEqual({});
        expect(useClipboardStore.getState().view?.items.map((i) => i.id)).toEqual(["a"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resetClipboardRequestState 回收离场收尾定时器，不产生残留状态", () => {
      vi.useFakeTimers();
      try {
        useClipboardStore.setState({ view: viewOf(["a", "b"]) });
        useClipboardStore.getState().beginExit(["b"], "item");
        resetClipboardRequestState();
        vi.advanceTimersByTime(500);
        expect(useClipboardStore.getState().exiting).toEqual({});
      } finally {
        vi.useRealTimers();
      }
    });

    it("详情页删除后立刻摘除本地行，返回列表不会闪回已删内容", () => {
      useClipboardStore.setState({ view: viewOf(["a", "b"], ["g1"]) });
      useClipboardStore.getState().endExit(["b", "g1"]);

      const state = useClipboardStore.getState();
      expect(state.view?.items.map((i) => i.id)).toEqual(["a"]);
      expect(state.view?.groups.map((g) => g.id)).toEqual([]);
    });

    it("分组卡片同样走离场钉回", async () => {
      useClipboardStore.setState({ view: viewOf([], ["g1", "g2"]) });
      useClipboardStore.getState().beginExit(["g1"], "group");

      mockedView.mockResolvedValueOnce(viewOf([], ["g2"]));
      await useClipboardStore.getState().load({ silent: true });

      expect(useClipboardStore.getState().view?.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    });

    it("删除期间切换筛选：离场快照不再钉进新列表", async () => {
      useClipboardStore.setState({ view: viewOf(["a", "b"]) });
      useClipboardStore.getState().beginExit(["b"], "item");

      useClipboardStore.getState().setFilters({ kind: "image" });
      mockedView.mockResolvedValueOnce(viewOf(["img1"]));
      await useClipboardStore.getState().load();

      const state = useClipboardStore.getState();
      expect(state.view?.items.map((i) => i.id)).toEqual(["img1"]);
      // 代际不符的快照被回收，不会一直占着内存
      expect(state.exiting).toEqual({});
    });

    it("离场不改变服务端统计口径，选择也只按服务端结果清理", async () => {
      useClipboardStore.setState({
        view: viewOf(["a", "b"]),
        selectedItems: ["a", "b"],
      });
      useClipboardStore.getState().beginExit(["b"], "item");

      mockedView.mockResolvedValueOnce({ ...viewOf(["a"]), stats: { items: 1 } } as unknown as ClipboardView);
      await useClipboardStore.getState().load({ silent: true });

      const state = useClipboardStore.getState();
      expect(state.view?.stats).toEqual({ items: 1 });
      expect(state.selectedItems).toEqual(["a"]);
    });

    it("不在列表里的 id 标记离场是空操作", () => {
      useClipboardStore.setState({ view: viewOf(["a"]) });
      useClipboardStore.getState().beginExit(["ghost"], "item");
      expect(useClipboardStore.getState().exiting).toEqual({});
    });

    it("patchItem 就地更新图标状态，不重新请求整表", () => {
      useClipboardStore.setState({ view: viewOf(["a", "b"]) });
      useClipboardStore.getState().patchItem({ id: "a", favorite: true } as never);

      const state = useClipboardStore.getState();
      expect((state.view?.items[0] as { favorite?: boolean }).favorite).toBe(true);
      expect(mockedView).not.toHaveBeenCalled();
    });

    it("patchItem 对不在列表里的 id 不做任何改动", () => {
      useClipboardStore.setState({ view: viewOf(["a"]) });
      useClipboardStore.getState().patchItem({ id: "ghost", favorite: true } as never);
      expect(useClipboardStore.getState().view?.items).toHaveLength(1);
    });
  });
});
