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
  shelfDelete,
  shelfGroupCreate,
  shelfGroupDelete,
  shelfGroups,
  shelfGroupRename,
  shelfList,
  shelfStats,
  shelfUnlinkTask,
  shelfUpdate,
  type ShelfCleanupReport,
  type ShelfGroup,
  type ShelfItem,
  type ShelfKind,
  type ShelfStats,
  type ShelfUpdatePatch,
} from "../lib/bridge";

/** 分页大小：与剪贴板面板一致的后端分页节奏。 */
export const SHELF_PAGE_SIZE = 100;

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
  /** 多选（顺序无关；后端批量接口按 id 集合处理） */
  selectedIds: string[];
  detailId: string | null;
  /** 清理预览弹层使用 */
  lastCleanup: ShelfCleanupReport | null;

  load: (opts?: { silent?: boolean }) => Promise<void>;
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
  unlinkTask: (itemId: string, taskId: string) => Promise<void>;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setDetail: (id: string | null) => void;
}

/** 模块级请求代际：筛选切换后，旧响应不得覆盖新状态。 */
let reqSeq = 0;

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
      set((s) => ({ items: sortItems([...report.added, ...s.items]) }));
      void get().refreshMeta();
      await get().load({ silent: true });
    }
    return { added: report.added.length, failed: report.failed };
  },

  addLink: async (url, groupId) => {
    const item = await shelfAddLink(url, groupId ?? null);
    set((s) => ({ items: sortItems([item, ...s.items]) }));
    void get().refreshMeta();
    return item;
  },

  addText: async (text, groupId) => {
    const item = await shelfAddText(text, groupId ?? null);
    set((s) => ({ items: sortItems([item, ...s.items]) }));
    void get().refreshMeta();
    return item;
  },

  addFromClipboard: async (itemIds, mode, groupId) => {
    const report = await shelfAddFromClipboard(itemIds, mode, groupId ?? null);
    if (report.added.length > 0) {
      set((s) => ({ items: sortItems([...report.added, ...s.items]) }));
      void get().refreshMeta();
      await get().load({ silent: true });
    }
    return { added: report.added.length, failed: report.failed };
  },

  updateItem: async (id, patch) => {
    const item = await shelfUpdate(id, patch);
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? item : i)),
    }));
    void get().refreshMeta();
    return item;
  },

  deleteItems: async (ids, includeProtected) => {
    await shelfDelete(ids, includeProtected);
    const gone = new Set(ids);
    set((s) => ({
      items: s.items.filter((i) => !gone.has(i.id)),
      selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
      detailId: s.detailId && gone.has(s.detailId) ? null : s.detailId,
    }));
    void get().refreshMeta();
  },

  clearShelf: async (includeProtected) => {
    await shelfClear(includeProtected);
    set({ items: [], total: 0, selectedIds: [], detailId: null });
    void get().refreshMeta();
  },

  runCleanup: async (dryRun, includeProtected) => {
    const report = await shelfCleanup(dryRun, includeProtected);
    set({ lastCleanup: report });
    if (!dryRun) {
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
