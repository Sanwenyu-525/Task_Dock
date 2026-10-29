//! 剪贴板抽屉视图状态：筛选、分页与多选。
//! 列表项由后端压实（正文→预览），完整内容在详情面板按需读取。

import { create } from "zustand";
import { clipboardView, type ClipboardView } from "../lib/bridge";

const PAGE_SIZE = 80;

export interface ClipboardFilters {
  kind: string;
  search: string;
  favorite: boolean;
}

export const useClipboardStore = create<{
  view: ClipboardView | null;
  filters: ClipboardFilters;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  selectedItems: string[];
  selectedGroups: string[];
  setFilters: (patch: Partial<ClipboardFilters>) => void;
  load: (opts?: { append?: boolean; silent?: boolean }) => Promise<void>;
  toggleItemSelection: (id: string) => void;
  toggleGroupSelection: (id: string) => void;
  clearSelection: () => void;
}>((set, get) => ({
  view: null,
  filters: { kind: "all", search: "", favorite: false },
  loading: false,
  loadingMore: false,
  error: null,
  selectedItems: [],
  selectedGroups: [],

  setFilters: (patch) => {
    set((s) => ({
      filters: { ...s.filters, ...patch },
      selectedItems: [],
      selectedGroups: [],
    }));
  },

  load: async (opts) => {
    const f = get().filters;
    const append = opts?.append === true;
    const offset = append ? get().view?.items.length ?? 0 : 0;
    if (append) set({ loadingMore: true });
    else if (!opts?.silent) set({ loading: true });
    try {
      const view = await clipboardView({
        kind: f.kind,
        search: f.search.trim() || undefined,
        favorite: f.favorite,
        limit: PAGE_SIZE,
        offset,
      });
      set((s) => {
        const merged = append && s.view
          ? { ...view, items: [...s.view.items, ...view.items] }
          : view;
        // 刷新后剔除已被清理/删除的选中项
        const ids = new Set(merged.items.map((i) => i.id));
        const gids = new Set(merged.groups.map((g) => g.id));
        return {
          view: merged,
          loading: false,
          loadingMore: false,
          error: null,
          selectedItems: s.selectedItems.filter((id) => ids.has(id)),
          selectedGroups: s.selectedGroups.filter((id) => gids.has(id)),
        };
      });
    } catch (e) {
      set({ loading: false, loadingMore: false, error: String(e) });
    }
  },

  toggleItemSelection: (id) =>
    set((s) => ({
      selectedItems: s.selectedItems.includes(id)
        ? s.selectedItems.filter((x) => x !== id)
        : [...s.selectedItems, id],
    })),

  toggleGroupSelection: (id) =>
    set((s) => ({
      selectedGroups: s.selectedGroups.includes(id)
        ? s.selectedGroups.filter((x) => x !== id)
        : [...s.selectedGroups, id],
    })),

  clearSelection: () => set({ selectedItems: [], selectedGroups: [] }),
}));
