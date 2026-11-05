//! useShelfStore 契约测试（mock bridge，不发真实 IPC）：
//! - 列表加载与筛选代际（旧响应不得覆盖新状态）；
//! - 添加后本地合并 + 元数据刷新；
//! - 删除收敛选中态与详情态；
//! - 分组删除后筛选回退；
//! - 引用存在性核对落回条目。

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Record<string, unknown[]> = {};

vi.mock("../lib/bridge", () => {
  const makeItem = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "file",
    display_name: `条目${id}`,
    source_kind: "picker",
    storage_mode: "reference",
    original_path: `D:\\tmp\\${id}.txt`,
    managed_path: null,
    content: null,
    byte_size: 10,
    file_ext: "txt",
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: "shelf-default",
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: `2026-01-0${id.length}T00:00:00.000Z`,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  /** 模拟服务端状态：添加动作会真实写入，load 返回它（与服务端权威语义一致）。 */
  let server: ReturnType<typeof makeItem>[] = [
    makeItem("a"),
    makeItem("b", { exists_state: "unknown" }),
  ];
  return {
    SHELF_PAGE_SIZE: undefined,
    shelfList: vi.fn(async (opts: { offset?: number }) => {
      calls.shelfList?.push(opts);
      if (opts.offset) return { items: [], total: server.length };
      return { items: server, total: server.length };
    }),
    shelfStats: vi.fn(async () => {
      calls.shelfStats?.push(1);
      return { total: server.length, managed_bytes: 20, quota_mb: 2048 };
    }),
    shelfGroups: vi.fn(async () => [
      { id: "shelf-default", name: "默认暂存", builtin: true, sort_order: 0, item_count: 2 },
    ]),
    shelfAddPaths: vi.fn(async (paths: string[]) => {
      const added = paths.map((p) => makeItem(p, { display_name: p }));
      server = [...added, ...server];
      return { added, failed: [] };
    }),
    shelfAddLink: vi.fn(async (url: string) => {
      const item = makeItem(url, { kind: "link", content: url });
      server = [item, ...server];
      return item;
    }),
    shelfAddText: vi.fn(async () => {
      const item = makeItem("text1", { kind: "text" });
      server = [item, ...server];
      return item;
    }),
    shelfAddFromClipboard: vi.fn(async (ids: string[]) => {
      const added = ids.map((x) => makeItem(x));
      server = [...added, ...server];
      return { added, failed: [{ path: "bad", reason: "已被清理" }] };
    }),
    shelfUpdate: vi.fn(async (id: string, patch: Record<string, unknown>) =>
      makeItem(id, patch),
    ),
    shelfDelete: vi.fn(async () => undefined),
    shelfClear: vi.fn(async () => undefined),
    shelfCleanup: vi.fn(async () => ({
      dry_run: false,
      candidates: 1,
      skipped_protected: 0,
      freed_bytes: 10,
      failed_files: 0,
      orphan_files_removed: 0,
    })),
    shelfCheckExists: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, exists_state: id === "b" ? "missing" : "ok" })),
    ),
    shelfGroupCreate: vi.fn(async (name: string) => ({
      id: `g-${name}`,
      name,
      builtin: false,
      sort_order: 9,
      item_count: 0,
    })),
    shelfGroupRename: vi.fn(async () => undefined),
    shelfGroupDelete: vi.fn(async () => undefined),
    shelfUnlinkTask: vi.fn(async () => undefined),
  };
});

import { useShelfStore, __resetShelfRecentCache, SHELF_RECENT_LIMIT } from "./useShelfStore";
import {
  shelfList,
  shelfStats,
  shelfGroups,
  shelfCheckExists,
} from "../lib/bridge";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useShelfStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetShelfRecentCache();
    useShelfStore.setState({
      items: [],
      total: 0,
      groups: [],
      stats: null,
      filter: { search: "", kind: "all", group_id: "all", favorite_only: false },
      loading: false,
      error: null,
      recent: [],
      recentLoading: false,
      recentLoaded: false,
      recentError: null,
      selectedIds: [],
      detailId: null,
      lastCleanup: null,
    });
  });

  it("load 拉取列表并按服务端结果收敛选中/详情", async () => {
    useShelfStore.setState({ selectedIds: ["a", "ghost"], detailId: "ghost" });
    await useShelfStore.getState().load();
    expect(shelfList).toHaveBeenCalled();
    const s = useShelfStore.getState();
    expect(s.items).toHaveLength(2);
    expect(s.total).toBe(2);
    expect(s.selectedIds).toEqual(["a"]);
    expect(s.detailId).toBeNull();
    expect(s.error).toBeNull();
  });

  it("请求代际：慢的旧响应不覆盖新筛选结果", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    (shelfList as ReturnType<typeof vi.fn>).mockImplementationOnce(() => gate.then(() => ({
      items: [{ id: "old" }],
      total: 1,
    })));
    const p1 = useShelfStore.getState().load();
    await flush();
    await useShelfStore.getState().setFilter({ kind: "image" });
    releaseFirst();
    await p1;
    const s = useShelfStore.getState();
    expect(s.filter.kind).toBe("image");
    // 旧响应（无 image 筛选）不得写入
    expect(s.items.find((i) => i.id === "old")).toBeUndefined();
  });

  it("addPaths 本地合并并刷新统计", async () => {
    await useShelfStore.getState().addPaths(["D:\\a.txt"], "reference", "drag");
    const s = useShelfStore.getState();
    expect(s.items.some((i) => i.display_name === "D:\\a.txt")).toBe(true);
    expect(shelfStats).toHaveBeenCalled();
    expect(shelfGroups).toHaveBeenCalled();
  });

  it("addFromClipboard 上报逐条失败原因", async () => {
    const r = await useShelfStore.getState().addFromClipboard(["x"], "reference");
    expect(r.added).toBe(1);
    expect(r.failed).toEqual([{ path: "bad", reason: "已被清理" }]);
  });

  it("deleteItems 移除条目并收敛选中/详情", async () => {
    useShelfStore.setState({
      items: [
        { id: "a" } as never,
        { id: "b" } as never,
      ],
      selectedIds: ["a", "b"],
      detailId: "a",
      total: 2,
    });
    await useShelfStore.getState().deleteItems(["a"], false);
    const s = useShelfStore.getState();
    expect(s.items.map((i) => i.id)).toEqual(["b"]);
    expect(s.selectedIds).toEqual(["b"]);
    expect(s.detailId).toBeNull();
  });

  it("verifyExists 把存在性写回条目", async () => {
    useShelfStore.setState({
      items: [
        { id: "a", exists_state: "unknown" } as never,
        { id: "b", exists_state: "unknown" } as never,
      ],
    });
    await useShelfStore.getState().verifyExists(["a", "b"]);
    const s = useShelfStore.getState();
    expect(s.items.find((i) => i.id === "a")?.exists_state).toBe("ok");
    expect(s.items.find((i) => i.id === "b")?.exists_state).toBe("missing");
    expect(shelfCheckExists).toHaveBeenCalledWith(["a", "b"]);
  });

  it("removeGroup 后筛选停在被删分组时回退全部", async () => {
    useShelfStore.setState({
      filter: { search: "", kind: "all", group_id: "g-x", favorite_only: false },
      items: [],
    });
    await useShelfStore.getState().removeGroup("g-x");
    expect(useShelfStore.getState().filter.group_id).toBe("all");
  });

  it("toggleSelect 与 clearSelection", () => {
    const store = useShelfStore.getState();
    store.toggleSelect("a");
    store.toggleSelect("b");
    expect(useShelfStore.getState().selectedIds).toEqual(["a", "b"]);
    store.toggleSelect("a");
    expect(useShelfStore.getState().selectedIds).toEqual(["b"]);
    useShelfStore.getState().clearSelection();
    expect(useShelfStore.getState().selectedIds).toEqual([]);
  });

  it("loadRecent 只取轻量片段并回填存在性，不加载完整历史", async () => {
    await useShelfStore.getState().loadRecent();
    const s = useShelfStore.getState();
    expect(shelfList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: SHELF_RECENT_LIMIT, offset: 0 }),
    );
    expect(s.recent.length).toBeLessThanOrEqual(SHELF_RECENT_LIMIT);
    expect(s.recent.length).toBeGreaterThan(0);
    expect(s.recent.find((i) => i.id === "b")?.exists_state).toBe("missing");
    expect(s.recentLoaded).toBe(true);
    expect(s.items).toEqual([]); // 完整列表不受影响
  });

  it("loadRecent 在 TTL 内复用缓存，force 才重新请求", async () => {
    await useShelfStore.getState().loadRecent();
    await useShelfStore.getState().loadRecent();
    expect(shelfList).toHaveBeenCalledTimes(1);
    await useShelfStore.getState().loadRecent({ force: true });
    expect(shelfList).toHaveBeenCalledTimes(2);
  });

  it("loadRecent 在途去重：并发调用只发一次请求", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (shelfList as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      gate.then(() => ({ items: [], total: 0 })),
    );
    const a = useShelfStore.getState().loadRecent();
    const b = useShelfStore.getState().loadRecent();
    release();
    await Promise.all([a, b]);
    expect(shelfList).toHaveBeenCalledTimes(1);
  });

  it("loadRecent 失败保留上次结果并给出错误，不伪装成空列表", async () => {
    await useShelfStore.getState().loadRecent();
    const before = useShelfStore.getState().recent.length;
    (shelfList as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db locked"));
    await useShelfStore.getState().loadRecent({ force: true });
    const s = useShelfStore.getState();
    expect(s.recent).toHaveLength(before);
    expect(s.recentError).toContain("db locked");
    expect(s.recentLoading).toBe(false);
  });
});
