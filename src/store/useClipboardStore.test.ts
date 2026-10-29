import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ clipboardView: vi.fn() }));

import { clipboardView } from "../lib/bridge";
import type { ClipboardView } from "../lib/bridge";
import { useClipboardStore } from "./useClipboardStore";

const mockedView = vi.mocked(clipboardView);

function viewOf(itemIds: string[], groupIds: string[] = []): ClipboardView {
  return {
    items: itemIds.map((id) => ({ id })),
    groups: groupIds.map((id) => ({ id })),
    stats: {},
    total_items: itemIds.length,
  } as unknown as ClipboardView;
}

function resetStore() {
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
});
