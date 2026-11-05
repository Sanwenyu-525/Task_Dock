//! 文件暂存架 store：列表分页、筛选、多选、分组、统计与增删改动作。
//!
//! 模式对齐 useClipboardStore：请求代际防乱序、错误字符串化、store 承担
//! IPC 生命周期（本模块无外部事件源，只有主动刷新）。

import { create } from "zustand";
import {
  shelfAddFromClipboard,
  shelfAddLink,
  shelfAddPaths,
  shelfAddText,
  shelfCheckExists,
  shelfCleanup,
  shelfClear,
  shelfCopyTo,
  shelfDelete,
  shelfMoveItems,
  shelfRelocateItem,
  shelfGroupCreate,
  shelfGroupDelete,
  shelfGroups,
  shelfGroupRename,
  shelfList,
  shelfStats,
  shelfUnlinkTask,
  shelfUpdate,
  type ShelfCleanupReport,
  type ShelfConflictStrategy,
  type ShelfGroup,
  type ShelfItem,
  type ShelfKind,
  type ShelfOpReport,
  type ShelfStats,
  type ShelfUpdatePatch,
} from "../lib/bridge";

/** 分页大小：与剪贴板面板一致的后端分页节奏。 */
export const SHELF_PAGE_SIZE = 100;

/** 工具面板「最近暂存」条数：只取一页的极小片段，不加载完整历史。 */
export const SHELF_RECENT_LIMIT = 4;

/** 最近暂存的软缓存：重新展开胶囊时 5s 内复用，避免子页来回切换重复 IPC。 */
export const SHELF_RECENT_TTL_MS = 5_000;

export interface ShelfFilter {
  search: string;
  kind: ShelfKind | "all";
  group_id: string; // "all" | 分组 id | "none"
  favorite_only: boolean;
}

interface ShelfState {
  items: ShelfItem[];
  total: number;
  groups: ShelfGroup[];
  stats: ShelfStats | null;
  filter: ShelfFilter;
  loading: boolean;
  error: string | null;
  /** 工具面板「最近暂存」轻量切片（独立于完整列表，避免胶囊加载整页历史） */
  recent: ShelfItem[];
  recentLoading: boolean;
  recentLoaded: boolean;
  recentError: string | null;
  /** 多选（顺序无关；后端批量接口按 id 集合处理） */
  selectedIds: string[];
  detailId: string | null;
  /** 清理预览弹层使用 */
  lastCleanup: ShelfCleanupReport | null;

  load: (opts?: { silent?: boolean }) => Promise<void>;
  /** 最近暂存：limit 固定为 SHELF_RECENT_LIMIT；force 跳过 5s 软缓存 */
  loadRecent: (opts?: { force?: boolean }) => Promise<void>;
  loadMore: () => Promise<void>;
  setFilter: (patch: Partial<ShelfFilter>) => Promise<void>;
  refreshMeta: () => Promise<void>;
  addPaths: (
    paths: string[],
    mode: "reference" | "managed",
    source: "picker" | "drag" | "manual",
    groupId?: string | null,
  ) => Promise<{ added: number; failed: { path: string; reason: string }[] }>;
  addLink: (url: string, groupId?: string | null) => Promise<ShelfItem>;
  addText: (text: string, groupId?: string | null) => Promise<ShelfItem>;
  addFromClipboard: (
    itemIds: string[],
    mode: "reference" | "managed",
    groupId?: string | null,
  ) => Promise<{ added: number; failed: { path: string; reason: string }[] }>;
  updateItem: (id: string, patch: ShelfUpdatePatch) => Promise<ShelfItem>;
  deleteItems: (ids: string[], includeProtected: boolean) => Promise<void>;
  clearShelf: (includeProtected: boolean) => Promise<void>;
  runCleanup: (dryRun: boolean, includeProtected: boolean) => Promise<ShelfCleanupReport>;
  verifyExists: (ids: string[]) => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  renameGroup: (id: string, name: string) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;
  moveToGroup: (ids: string[], groupId: string) => Promise<void>;
  /** 文件操作：move=移动原文件，copy=复制到目录/导出托管副本。 */
  runFileOp: (
    op: "move" | "copy",
    ids: string[],
    targetDir: string,
    strategy: ShelfConflictStrategy,
    removeAfter: boolean,
  ) => Promise<ShelfOpReport>;
  relocateItem: (id: string, path: string) => Promise<ShelfItem>;
  unlinkTask: (itemId: string, taskId: string) => Promise<void>;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setDetail: (id: string | null) => void;
}

/** 模块级请求代际：筛选切换后，旧响应不得覆盖新状态。 */
let reqSeq = 0;
/** 最近暂存独立代际：完整列表的刷新不能改写胶囊里的轻量切片。 */
let recentSeq = 0;
let recentLoadedAt = 0;
/** 数据代次：新增/删除/改名后递增，早于变更的最近响应一律丢弃。 */
let recentVersion = 0;

/** 暂存数据发生变化：下次打开胶囊必须重新取最近列表，旧响应不得覆盖。 */
function invalidateRecent(): void {
  recentVersion += 1;
  recentLoadedAt = 0;
}

/** 测试辅助：清掉最近切片的模块级软缓存，避免用例之间共享 TTL。 */
export function __resetShelfRecentCache(): void {
  recentSeq += 1;
  recentVersion += 1;
  recentLoadedAt = 0;
}

function sortItems(items: ShelfItem[]): ShelfItem[] {
  // 与后端排序保持一致（置顶优先、新者先），本地插入/更新后直接重排
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

export const useShelfStore = create<ShelfState>((set, get) => ({
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

  load: async (opts) => {
    const seq = ++reqSeq;
    if (!opts?.silent) set({ loading: true });
    try {
      const f = get().filter;
      const page = await shelfList({
        search: f.search || undefined,
        kind: f.kind,
        group_id: f.group_id,
        favorite_only: f.favorite_only,
        limit: SHELF_PAGE_SIZE,
        offset: 0,
      });
      if (seq !== reqSeq) return;
      // 服务端权威收敛：刷新后不再存在于列表中的选中项同步移除
      const ids = new Set(page.items.map((i) => i.id));
      set((s) => ({
        items: page.items,
        total: page.total,
        error: null,
        selectedIds: s.selectedIds.filter((id) => ids.has(id)),
        detailId: s.detailId && ids.has(s.detailId) ? s.detailId : null,
      }));
    } catch (e) {
      if (seq !== reqSeq) return;
      set({ error: String(e) });
    } finally {
      if (seq === reqSeq) set({ loading: false });
    }
  },

  loadRecent: async (opts) => {
    const force = opts?.force ?? false;
    const s = get();
    // 软缓存 + 在途去重：胶囊子页来回切换 / 重复挂载不产生请求风暴。
    if (!force && s.recentLoaded && Date.now() - recentLoadedAt < SHELF_RECENT_TTL_MS) return;
    if (!force && s.recentLoading) return;

    const seq = ++recentSeq;
    const version = recentVersion;
    set({ recentLoading: true, recentError: null });
    try {
      // 只要最近 4 条：按创建时间倒序（不受置顶影响），不读完整历史，
      // 也不动完整列表的筛选/分页状态。
      const page = await shelfList({ sort: "recent", limit: SHELF_RECENT_LIMIT, offset: 0 });
      if (seq !== recentSeq || version !== recentVersion) return;
      set({ recent: page.items, recentLoaded: true });
      recentLoadedAt = Date.now();

      // 引用/托管文件是否仍可访问：一次批量元数据检查。检查失败时保留库内
      // 上次状态（unknown 不等于 missing），不让辅助探测把列表变成错误态。
      const ids = page.items
        .filter((i) => i.kind !== "link" && i.kind !== "text")
        .map((i) => i.id);
      if (ids.length > 0) {
        try {
          const reports = await shelfCheckExists(ids);
          if (seq !== recentSeq || version !== recentVersion) return;
          const map = new Map(reports.map((r) => [r.id, r.exists_state]));
          set((prev) => ({
            recent: prev.recent.map((i) =>
              map.has(i.id) ? { ...i, exists_state: map.get(i.id) as ShelfItem["exists_state"] } : i,
            ),
          }));
        } catch {
          // 存在性探测是展示增强：失败不覆盖列表、不阻塞打开/复制。
        }
      }
    } catch (e) {
      if (seq === recentSeq && version === recentVersion) set({ recentError: String(e) });
    } finally {
      if (seq === recentSeq) set({ recentLoading: false });
    }
  },

  loadMore: async () => {
    const seq = ++reqSeq;
    const s = get();
    if (s.items.length >= s.total) return;
    try {
      const page = await shelfList({
        search: s.filter.search || undefined,
        kind: s.filter.kind,
        group_id: s.filter.group_id,
        favorite_only: s.filter.favorite_only,
        limit: SHELF_PAGE_SIZE,
        offset: s.items.length,
      });
      if (seq !== reqSeq) return;
      set((prev) => {
        const known = new Set(prev.items.map((i) => i.id));
        const merged = sortItems([...prev.items, ...page.items.filter((i) => !known.has(i.id))]);
        return { items: merged, total: page.total };
      });
    } catch (e) {
      if (seq === reqSeq) set({ error: String(e) });
    }
  },

  setFilter: async (patch) => {
    set((s) => ({ filter: { ...s.filter, ...patch } }));
    await get().load();
  },

  refreshMeta: async () => {
    try {
      const [groups, stats] = await Promise.all([shelfGroups(), shelfStats()]);
      set({ groups, stats });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  addPaths: async (paths, mode, source, groupId) => {
    const report = await shelfAddPaths(paths, mode, source, groupId ?? null);
    if (report.added.length > 0) {
      set((s) => ({
        items: sortItems([...report.added, ...s.items]),
        recent: [...report.added, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
      }));
      invalidateRecent();
      void get().refreshMeta();
      await get().load({ silent: true });
    }
    return { added: report.added.length, failed: report.failed };
  },

  addLink: async (url, groupId) => {
    const item = await shelfAddLink(url, groupId ?? null);
    set((s) => ({
      items: sortItems([item, ...s.items]),
      recent: [item, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
    }));
    invalidateRecent();
    void get().refreshMeta();
    return item;
  },

  addText: async (text, groupId) => {
    const item = await shelfAddText(text, groupId ?? null);
    set((s) => ({
      items: sortItems([item, ...s.items]),
      recent: [item, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
    }));
    invalidateRecent();
    void get().refreshMeta();
    return item;
  },

  addFromClipboard: async (itemIds, mode, groupId) => {
    const report = await shelfAddFromClipboard(itemIds, mode, groupId ?? null);
    if (report.added.length > 0) {
      set((s) => ({
        items: sortItems([...report.added, ...s.items]),
        recent: [...report.added, ...s.recent].slice(0, SHELF_RECENT_LIMIT),
      }));
      invalidateRecent();
      void get().refreshMeta();
      await get().load({ silent: true });
    }
    return { added: report.added.length, failed: report.failed };
  },

  updateItem: async (id, patch) => {
    const item = await shelfUpdate(id, patch);
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? item : i)),
      recent: s.recent.map((i) => (i.id === id ? item : i)),
    }));
    invalidateRecent();
    void get().refreshMeta();
    return item;
  },

  deleteItems: async (ids, includeProtected) => {
    await shelfDelete(ids, includeProtected);
    const gone = new Set(ids);
    set((s) => ({
      items: s.items.filter((i) => !gone.has(i.id)),
      recent: s.recent.filter((i) => !gone.has(i.id)),
      selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
      detailId: s.detailId && gone.has(s.detailId) ? null : s.detailId,
    }));
    invalidateRecent();
    void get().refreshMeta();
  },

  clearShelf: async (includeProtected) => {
    await shelfClear(includeProtected);
    set({ items: [], total: 0, selectedIds: [], detailId: null, recent: [] });
    invalidateRecent();
    void get().refreshMeta();
  },

  runCleanup: async (dryRun, includeProtected) => {
    const report = await shelfCleanup(dryRun, includeProtected);
    set({ lastCleanup: report });
    if (!dryRun) {
      invalidateRecent();
      await get().load({ silent: true });
      void get().refreshMeta();
    }
    return report;
  },

  verifyExists: async (ids) => {
    if (ids.length === 0) return;
    const reports = await shelfCheckExists(ids);
    const map = new Map(reports.map((r) => [r.id, r.exists_state]));
    set((s) => ({
      items: s.items.map((i) =>
        map.has(i.id) ? { ...i, exists_state: map.get(i.id) as ShelfItem["exists_state"] } : i,
      ),
    }));
  },

  createGroup: async (name) => {
    await shelfGroupCreate(name);
    await get().refreshMeta();
  },

  renameGroup: async (id, name) => {
    await shelfGroupRename(id, name);
    await get().refreshMeta();
  },

  removeGroup: async (id) => {
    await shelfGroupDelete(id);
    // 分组删除后条目归位默认分组；筛选停在被删分组时回退到全部
    const f = get().filter;
    if (f.group_id === id) {
      await get().setFilter({ group_id: "all" });
    }
    await get().refreshMeta();
    await get().load({ silent: true });
  },

  moveToGroup: async (ids, groupId) => {
    for (const id of ids) {
      await shelfUpdate(id, { group_id: groupId });
    }
    set((s) => ({
      items: s.items.map((i) =>
        ids.includes(i.id)
          ? { ...i, group_id: groupId === "none" ? null : groupId }
          : i,
      ),
      selectedIds: [],
    }));
    void get().refreshMeta();
  },

  runFileOp: async (op, ids, targetDir, strategy, removeAfter) => {
    const report =
      op === "move"
        ? await shelfMoveItems(ids, targetDir, strategy, removeAfter)
        : await shelfCopyTo(ids, targetDir, strategy, removeAfter);
    // 移动会改写路径、移除会删记录，统一以服务端列表为准刷新（保留失败项）。
    invalidateRecent();
    await get().load({ silent: true });
    void get().refreshMeta();
    return report;
  },

  relocateItem: async (id, path) => {
    const item = await shelfRelocateItem(id, path);
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? item : i)),
      recent: s.recent.map((i) => (i.id === id ? item : i)),
    }));
    invalidateRecent();
    return item;
  },

  unlinkTask: async (itemId, taskId) => {
    await shelfUnlinkTask(itemId, taskId);
  },

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),

  selectAll: () => set((s) => ({ selectedIds: s.items.map((i) => i.id) })),

  clearSelection: () => set({ selectedIds: [] }),

  setDetail: (id) => set({ detailId: id }),
}));
