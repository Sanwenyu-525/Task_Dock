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

  it("列表刷新后清理已删除条目的选择，保留仍存在项", async () => {
    useClipboardStore.setState({ selectedItems: ["a", "gone"], selectedGroups: ["g1", "g2"] });
    mockedView.mockResolvedValueOnce(viewOf(["a"], ["g1"]));
    await useClipboardStore.getState().load();
    const state = useClipboardStore.getState();
    expect(state.selectedItems).toEqual(["a"]);
    expect(state.selectedGroups).toEqual(["g1"]);
  });
});
