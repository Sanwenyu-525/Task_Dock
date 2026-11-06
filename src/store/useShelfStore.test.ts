//! useShelfStore 契约测试（mock bridge，不发真实 IPC）：
//! - 列表加载与筛选代际（旧响应不得覆盖新状态）；
//! - 添加后本地合并 + 元数据刷新；
//! - 删除收敛选中态与详情态；
//! - 分组删除后筛选回退；
//! - 引用存在性核对落回条目。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, mockShelf, makeItem } = vi.hoisted(() => {
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
  } as ShelfItem);
  return {
    calls: {} as Record<string, unknown[]>,
    mockShelf: { server: [] as ReturnType<typeof makeItem>[] },
    makeItem,
  };
});

vi.mock("../lib/bridge", () => {
  /** 模拟服务端状态：添加动作会真实写入，load 返回它（与服务端权威语义一致）。 */
  mockShelf.server = [
    makeItem("a"),
    makeItem("b", { exists_state: "unknown" }),
  ];
  const reportDelete = (ids: string[], includeProtected: boolean) => {
    const requested = new Set(ids);
    const selected = mockShelf.server.filter((item) => requested.has(item.id));
    const skipped = includeProtected
      ? []
      : selected.filter((item) => item.favorite || item.pinned);
    const deleted = selected.filter((item) => !skipped.includes(item));
    mockShelf.server = mockShelf.server.filter((item) => !deleted.includes(item));
    return { deleted: deleted.length, skipped: skipped.length, freed_bytes: 0, failed_files: 0 };
  };
  return {
    SHELF_PAGE_SIZE: undefined,
    shelfList: vi.fn(async (opts: {
      offset?: number;
      limit?: number;
      sort?: "default" | "recent";
      search?: string;
      kind?: string;
      group_id?: string;
      favorite_only?: boolean;
    }) => {
      calls.shelfList?.push(opts);
      let filtered = [...mockShelf.server];
      if (opts.search) filtered = filtered.filter((item) => item.display_name.includes(opts.search!));
      if (opts.kind && opts.kind !== "all") filtered = filtered.filter((item) => item.kind === opts.kind);
      if (opts.group_id && opts.group_id !== "all") {
        filtered = filtered.filter((item) => item.group_id === opts.group_id);
      }
      if (opts.favorite_only) filtered = filtered.filter((item) => item.favorite);
      if (opts.sort === "recent") {
        filtered.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      } else {
        filtered.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      }
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 100;
      return { items: filtered.slice(offset, offset + limit), total: filtered.length };
    }),
    shelfStats: vi.fn(async () => {
      calls.shelfStats?.push(1);
      return { total: mockShelf.server.length, managed_bytes: 20, quota_mb: 2048 };
    }),
    shelfGroups: vi.fn(async () => [
      {
        id: "shelf-default",
        name: "默认暂存",
        builtin: true,
        sort_order: 0,
        item_count: mockShelf.server.length,
      },
    ]),
    shelfAddPaths: vi.fn(async (paths: string[]) => {
      const added = paths.map((p) => makeItem(p, { display_name: p }));
      mockShelf.server = [...added, ...mockShelf.server];
      return { added, failed: [] };
    }),
    shelfAddLink: vi.fn(async (url: string) => {
      const item = makeItem(url, { kind: "link", content: url });
      mockShelf.server = [item, ...mockShelf.server];
      return item;
    }),
    shelfAddText: vi.fn(async () => {
      const item = makeItem("text1", { kind: "text" });
      mockShelf.server = [item, ...mockShelf.server];
      return item;
    }),
    shelfAddFromClipboard: vi.fn(async (ids: string[]) => {
      const added = ids.map((x) => makeItem(x));
      mockShelf.server = [...added, ...mockShelf.server];
      return { added, failed: [{ path: "bad", reason: "已被清理" }] };
    }),
    shelfUpdate: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const previous = mockShelf.server.find((item) => item.id === id) ?? makeItem(id);
      const updated = makeItem(id, { ...previous, ...patch });
      mockShelf.server = mockShelf.server.map((item) => item.id === id ? updated : item);
      return updated;
    }),
    shelfDelete: vi.fn(async (ids: string[], includeProtected: boolean) =>
      reportDelete(ids, includeProtected),
    ),
    shelfClear: vi.fn(async (includeProtected: boolean) =>
      reportDelete(mockShelf.server.map((item) => item.id), includeProtected),
    ),
    shelfCleanup: vi.fn(async (dryRun: boolean) => {
      calls.shelfCleanup?.push(dryRun);
      return {
        dry_run: dryRun,
        candidates: 1,
        skipped_protected: 0,
        temporary_files_skipped: 0,
        freed_bytes: 10,
        failed_files: 0,
        orphan_files_removed: 0,
      };
    }),
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
  clientDiagnosticsStats,
  flushDiagnostics,
  setDiagnosticTransport,
  type DiagnosticInput,
} from "../lib/diagnostics";
import {
  shelfList,
  shelfStats,
  shelfGroups,
  shelfCheckExists,
  shelfDelete,
  shelfCleanup,
  type ShelfItem,
} from "../lib/bridge";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useShelfStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(calls)) calls[key] = [];
    mockShelf.server = [makeItem("a"), makeItem("b", { exists_state: "unknown" })];
    __resetShelfRecentCache();
    useShelfStore.setState({
      items: [],
      total: 0,
      groups: [],
      stats: null,
      filter: { search: "", kind: "all", group_id: "all", favorite_only: false },
      loading: false,
      error: null,
      mutationSyncError: null,
      deletionBusy: false,
      cleanupBusy: false,
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

  it("addPaths 只记录数量/来源，不把文件路径写进诊断日志", async () => {
    // 先清空此前用例留下的诊断队列，避免旧事件混入本次断言。
    setDiagnosticTransport(async () => {});
    while (clientDiagnosticsStats().queued > 0) await flushDiagnostics();

    const events: DiagnosticInput[] = [];
    setDiagnosticTransport(async (batch) => {
      events.push(...batch);
    });
    try {
      await useShelfStore.getState().addPaths(["D:\\secret\\note.txt"], "reference", "drag");
      while (clientDiagnosticsStats().queued > 0) await flushDiagnostics();

      const opEvents = events.filter((event) => event.action === "shelf_add_paths");
      expect(opEvents.filter((event) => event.status === "started")).toHaveLength(1);
      expect(opEvents.filter((event) => event.status === "success")).toHaveLength(1);
      expect(opEvents.find((event) => event.status === "success")?.metadata).toMatchObject({
        count: 1,
        added: 1,
        failed: 0,
      });
      // 隐私红线：路径与文件名不得进入诊断事件。
      const payload = JSON.stringify(opEvents);
      expect(payload).not.toContain("secret");
      expect(payload).not.toContain("note.txt");
    } finally {
      setDiagnosticTransport(null);
    }
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

  it("混合批量删除按后端报告刷新，保留收藏/置顶条目的选择与详情", async () => {
    const rows = [
      makeItem("a"),
      makeItem("b", { favorite: true }),
      makeItem("c", { pinned: true }),
      makeItem("d"),
      makeItem("e", { favorite: true, pinned: true }),
    ];
    mockShelf.server = rows;
    await useShelfStore.getState().load();
    await useShelfStore.getState().loadRecent({ force: true });
    useShelfStore.setState({ selectedIds: rows.map((item) => item.id), detailId: "b" });

    const result = await useShelfStore.getState().deleteItems(rows.map((item) => item.id), false);
    const state = useShelfStore.getState();

    expect(result.report).toMatchObject({ deleted: 2, skipped: 3, failed_files: 0 });
    expect(state.items.map((item) => item.id).sort()).toEqual(["b", "c", "e"]);
    expect(state.recent.map((item) => item.id).sort()).toEqual(["b", "c", "e"]);
    expect(state.total).toBe(3);
    expect(state.stats?.total).toBe(3);
    expect(state.groups[0]?.item_count).toBe(3);
    expect(state.selectedIds.sort()).toEqual(["b", "c", "e"]);
    expect(state.detailId).toBe("b");
    expect(result.synced).toBe(true);

    const explicit = await useShelfStore.getState().deleteItems(["b", "c", "e"], true);
    expect(explicit.report).toMatchObject({ deleted: 3, skipped: 0 });
    expect(useShelfStore.getState().stats?.total).toBe(0);
  });

  it("删除后旧列表响应不能把已删除条目写回", async () => {
    const rows = [makeItem("a"), makeItem("b")];
    mockShelf.server = rows;
    useShelfStore.setState({ selectedIds: ["a", "b"], detailId: "a" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (shelfList as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return { items: rows, total: rows.length };
    });

    const staleLoad = useShelfStore.getState().load();
    await flush();
    const result = await useShelfStore.getState().deleteItems(["a"], false);
    expect(result.synced).toBe(true);
    expect(useShelfStore.getState().items.map((item) => item.id)).toEqual(["b"]);

    release();
    await staleLoad;
    const state = useShelfStore.getState();
    expect(state.items.map((item) => item.id)).toEqual(["b"]);
    expect(state.selectedIds).toEqual(["b"]);
    expect(state.detailId).toBeNull();
  });

  it("清空在收藏筛选下保留受保护条目，并同步最近列表与统计", async () => {
    mockShelf.server = [
      makeItem("a"),
      makeItem("b", { favorite: true }),
      makeItem("c", { pinned: true }),
      makeItem("d", { favorite: true, pinned: true }),
    ];
    await useShelfStore.getState().loadRecent({ force: true });
    await useShelfStore.getState().setFilter({ favorite_only: true });
    useShelfStore.setState({ selectedIds: ["b", "d"], detailId: "b" });

    const result = await useShelfStore.getState().clearShelf(false);
    const state = useShelfStore.getState();

    expect(result.report).toMatchObject({ deleted: 1, skipped: 3 });
    expect(result.remainingTotal).toBe(3);
    expect(state.items.map((item) => item.id).sort()).toEqual(["b", "d"]);
    expect(state.total).toBe(2);
    expect(state.recent.map((item) => item.id).sort()).toEqual(["b", "c", "d"]);
    expect(state.stats?.total).toBe(3);
    expect(state.selectedIds.sort()).toEqual(["b", "d"]);
    expect(state.detailId).toBe("b");
  });

  it("删除成功但权威列表刷新失败时保留现状并提供完整重试", async () => {
    useShelfStore.setState({
      items: [makeItem("a"), makeItem("b")],
      total: 2,
      selectedIds: ["a", "b"],
      detailId: "a",
    });
    (shelfList as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("列表不可用"));

    const result = await useShelfStore.getState().deleteItems(["a"], false);
    expect(result.report.deleted).toBe(1);
    expect(result.synced).toBe(false);
    expect(useShelfStore.getState().items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(useShelfStore.getState().mutationSyncError).toContain("刷新失败");

    expect(await useShelfStore.getState().retryShelfSync()).toBe(true);
    expect(useShelfStore.getState().items.map((item) => item.id)).toEqual(["b"]);
    expect(useShelfStore.getState().mutationSyncError).toBeNull();
  });

  it("后端删除请求失败时保留列表、选择、详情和既有同步告警", async () => {
    const existingWarning = "上一轮状态刷新失败";
    useShelfStore.setState({
      items: [makeItem("a"), makeItem("b")],
      total: 2,
      selectedIds: ["a"],
      detailId: "a",
      mutationSyncError: existingWarning,
    });
    (shelfDelete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db locked"));

    await expect(useShelfStore.getState().deleteItems(["a"], false)).rejects.toThrow("db locked");
    const state = useShelfStore.getState();
    expect(state.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(state.total).toBe(2);
    expect(state.selectedIds).toEqual(["a"]);
    expect(state.detailId).toBe("a");
    expect(state.mutationSyncError).toBe(existingWarning);
    expect(state.deletionBusy).toBe(false);
  });

  it("删除操作在途时拒绝第二次提交", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (shelfDelete as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      mockShelf.server = mockShelf.server.filter((item) => item.id !== "a");
      return { deleted: 1, skipped: 0, freed_bytes: 0, failed_files: 0 };
    });

    const first = useShelfStore.getState().deleteItems(["a"], false);
    await expect(useShelfStore.getState().deleteItems(["a"], false)).rejects.toThrow("正在处理");
    release();
    await first;
    expect(shelfDelete).toHaveBeenCalledTimes(1);
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
    expect(shelfList).toHaveBeenCalledWith({
      sort: "recent",
      limit: SHELF_RECENT_LIMIT,
      offset: 0,
    });
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

  it("新增暂存后缓存失效，最近列表立即反映新条目", async () => {
    await useShelfStore.getState().loadRecent();
    expect(useShelfStore.getState().recentLoaded).toBe(true);
    await useShelfStore.getState().addPaths(["D:\\new.txt"], "reference", "drag");
    expect(useShelfStore.getState().recent[0]?.display_name).toBe("D:\\new.txt");
    // 不等待 TTL：下一次访问必须重新取权威结果
    await useShelfStore.getState().loadRecent();
    const last = (shelfList as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(last).toEqual({ sort: "recent", limit: SHELF_RECENT_LIMIT, offset: 0 });
  });

  it("删除/改名后最近切片同步，不继续展示旧条目", async () => {
    await useShelfStore.getState().loadRecent();
    const first = useShelfStore.getState().recent[0];
    expect(first).toBeTruthy();
    await useShelfStore.getState().deleteItems([first.id], false);
    expect(useShelfStore.getState().recent.some((i) => i.id === first.id)).toBe(false);
  });

  it("慢的旧最近响应不能覆盖变更后的结果", async () => {
    await useShelfStore.getState().loadRecent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (shelfList as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      gate.then(() => ({
        items: [
          {
            id: "stale",
            kind: "file",
            display_name: "过期结果",
            exists_state: "ok",
            storage_mode: "reference",
          },
        ],
        total: 1,
      })),
    );
    const pending = useShelfStore.getState().loadRecent({ force: true });
    // 数据发生变化：旧响应返回时必须被丢弃
    await useShelfStore.getState().deleteItems(["other"], false);
    release();
    await pending;
    expect(useShelfStore.getState().recent.some((i) => i.id === "stale")).toBe(false);
    expect(useShelfStore.getState().recentLoading).toBe(false);
  });

  it("runCleanup 的 dry-run 只读：不改列表/统计，也不失效最近缓存", async () => {
    await useShelfStore.getState().loadRecent({ force: true });
    const listCalls = (shelfList as ReturnType<typeof vi.fn>).mock.calls.length;
    const statsCalls = (shelfStats as ReturnType<typeof vi.fn>).mock.calls.length;

    const result = await useShelfStore.getState().runCleanup(true, false);

    expect(shelfCleanup).toHaveBeenCalledWith(true, false);
    expect(result.synced).toBe(true);
    expect(result.report.dry_run).toBe(true);
    expect(useShelfStore.getState().lastCleanup?.dry_run).toBe(true);
    expect((shelfList as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCalls);
    expect((shelfStats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(statsCalls);
    expect(useShelfStore.getState().recentLoaded).toBe(true);
  });

  it("runCleanup 真实执行后同步列表、统计、分组与最近暂存，并保留当前筛选", async () => {
    mockShelf.server = [makeItem("a"), makeItem("b")];
    await useShelfStore.getState().setFilter({ kind: "file" });
    await useShelfStore.getState().loadRecent({ force: true });
    useShelfStore.setState({ selectedIds: ["a", "b"], detailId: "a" });

    (shelfCleanup as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      mockShelf.server = [makeItem("b")];
      return {
        dry_run: false,
        candidates: 1,
        skipped_protected: 0,
        temporary_files_skipped: 0,
        freed_bytes: 10,
        failed_files: 0,
        orphan_files_removed: 0,
      };
    });

    const result = await useShelfStore.getState().runCleanup(false, false);
    const state = useShelfStore.getState();

    expect(result.synced).toBe(true);
    expect(result.report.candidates).toBe(1);
    expect(state.items.map((item) => item.id)).toEqual(["b"]);
    expect(state.total).toBe(1);
    expect(state.stats?.total).toBe(1);
    expect(state.groups[0]?.item_count).toBe(1);
    expect(state.recent.map((item) => item.id)).toEqual(["b"]);
    expect(state.selectedIds).toEqual(["b"]);
    expect(state.detailId).toBeNull();
    expect(state.filter.kind).toBe("file");
    // 清理沿用当前筛选加载权威列表，而不是清空筛选重载。
    const lastFilteredList = (shelfList as ReturnType<typeof vi.fn>).mock.calls
      .filter(([opts]) => (opts as { sort?: string } | undefined)?.sort !== "recent")
      .at(-1)?.[0];
    expect(lastFilteredList).toMatchObject({ kind: "file" });

    // 最近暂存没有被 TTL 复用：清理后强制重新取权威切片。
    const recentLists = (shelfList as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([opts]) => (opts as { sort?: string } | undefined)?.sort === "recent",
    );
    expect(recentLists.length).toBeGreaterThanOrEqual(2);
  });

  it("清理后旧的最近响应不能覆盖新的最近切片", async () => {
    mockShelf.server = [makeItem("a"), makeItem("b")];
    await useShelfStore.getState().loadRecent({ force: true });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (shelfList as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      gate.then(() => ({
        items: [makeItem("stale")],
        total: 1,
      })),
    );
    const stale = useShelfStore.getState().loadRecent({ force: true });

    (shelfCleanup as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      mockShelf.server = [makeItem("b")];
      return {
        dry_run: false,
        candidates: 1,
        skipped_protected: 0,
        temporary_files_skipped: 0,
        freed_bytes: 10,
        failed_files: 0,
        orphan_files_removed: 0,
      };
    });
    await useShelfStore.getState().runCleanup(false, false);

    release();
    await stale;
    expect(useShelfStore.getState().recent.some((item) => item.id === "stale")).toBe(false);
    expect(useShelfStore.getState().recent.map((item) => item.id)).toEqual(["b"]);
  });

  it("runCleanup 成功但同步失败时返回 synced=false，重试只同步不重复清理", async () => {
    useShelfStore.setState({ items: [makeItem("a"), makeItem("b")], total: 2 });
    (shelfCleanup as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      dry_run: false,
      candidates: 1,
      skipped_protected: 0,
      temporary_files_skipped: 0,
      freed_bytes: 10,
      failed_files: 0,
      orphan_files_removed: 0,
    }));
    (shelfList as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("列表不可用"));

    const result = await useShelfStore.getState().runCleanup(false, false);
    expect(result.synced).toBe(false);
    expect(useShelfStore.getState().mutationSyncError).toContain("刷新失败");
    expect(shelfCleanup).toHaveBeenCalledTimes(1);

    await useShelfStore.getState().retryShelfSync();
    expect(shelfCleanup).toHaveBeenCalledTimes(1);
    expect(useShelfStore.getState().mutationSyncError).toBeNull();
  });

  it("清理在途时拒绝第二次执行，预览与执行共用同一闸", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (shelfCleanup as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return {
        dry_run: false,
        candidates: 1,
        skipped_protected: 0,
        temporary_files_skipped: 0,
        freed_bytes: 10,
        failed_files: 0,
        orphan_files_removed: 0,
      };
    });

    const first = useShelfStore.getState().runCleanup(false, false);
    await flush();
    await expect(useShelfStore.getState().runCleanup(false, false)).rejects.toThrow("正在清理");
    await expect(useShelfStore.getState().runCleanup(true, false)).rejects.toThrow("正在清理");
    release();
    await first;
    expect(shelfCleanup).toHaveBeenCalledTimes(1);
    expect(useShelfStore.getState().cleanupBusy).toBe(false);
  });
});
