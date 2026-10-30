//! 剪贴板抽屉视图状态：筛选、分页与多选。
//! 列表项由后端压实（正文→预览），完整内容在详情面板按需读取。
//!
//! 一致性约定：
//! - 每次筛选变化推进 `filterGen`，旧筛选的响应一律丢弃；
//! - 每次请求推进 `reqSeq`，只有最新请求可以写入视图（防异步乱序覆盖）；
//! - 追加分页按 id 去重，并与当前代际绑定，筛选切换后不再拼接旧页；
//! - 任何一次落库后都清理已不存在于列表中的选择。

import { create } from "zustand";
import { clipboardView, onClipboardChanged, type ClipboardView } from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";

const PAGE_SIZE = 80;

export interface ClipboardFilters {
  kind: string;
  search: string;
  favorite: boolean;
}

let filterGen = 0;
let reqSeq = 0;

function mergeItems(current: ClipboardView["items"], next: ClipboardView["items"]) {
  const seen = new Set(current.map((i) => i.id));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export const useClipboardStore = create<{
  view: ClipboardView | null;
  filters: ClipboardFilters;
  /** 历史 / 分组 二级视图 */
  section: "items" | "groups";
  /** 搜索框原始文本（与 filters.search 分离，搜索框内容即时回显） */
  searchText: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  selectedItems: string[];
  selectedGroups: string[];
  setFilters: (patch: Partial<ClipboardFilters>) => void;
  setSection: (section: "items" | "groups") => void;
  setSearchText: (text: string) => void;
  load: (opts?: { append?: boolean; silent?: boolean }) => Promise<void>;
  toggleItemSelection: (id: string) => void;
  toggleGroupSelection: (id: string) => void;
  clearSelection: () => void;
  /** 订阅后端变更；**全局只建一个** Tauri 监听，页面与抽屉共享 */
  setLive: (active: boolean) => void;
}>((set, get) => ({
  view: null,
  filters: { kind: "all", search: "", favorite: false },
  section: "items",
  searchText: "",
  loading: false,
  loadingMore: false,
  error: null,
  selectedItems: [],
  selectedGroups: [],

  setFilters: (patch) => {
    filterGen += 1;
    set((s) => ({
      filters: { ...s.filters, ...patch },
      selectedItems: [],
      selectedGroups: [],
    }));
  },

  setSection: (section) => set({ section }),
  setSearchText: (searchText) => set({ searchText }),

  load: async (opts) => {
    const append = opts?.append === true;
    if (append && get().loadingMore) return;
    const gen = filterGen;
    const seq = ++reqSeq;
    const f = get().filters;
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
      // 旧筛选或旧请求的响应不得覆盖新状态
      if (seq !== reqSeq || gen !== filterGen) return;
      set((s) => {
        const merged =
          append && s.view
            ? { ...view, items: mergeItems(s.view.items, view.items) }
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
      if (seq !== reqSeq || gen !== filterGen) return;
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

  setLive: (active) => {
    if (active) acquireLive();
    else releaseLive();
  },
}));

/**
 * 实时监听：**整个应用只有一个** `onClipboardChanged` 监听。
 *
 * 剪贴板既可能是侧边栏页面、又可能是任务关联抽屉；若两处各自注册监听，
 * 一次采集事件会被处理两遍（重复刷新、重复去抖），这里用引用计数保证唯一性。
 */
let liveScope: ReturnType<typeof createSubscriptionScope> | null = null;
let liveRefs = 0;
let liveTimer: number | undefined;

function acquireLive() {
  liveRefs += 1;
  if (liveScope) return;
  liveScope = createSubscriptionScope();
  liveScope.add(
    onClipboardChanged(() => {
      if (liveTimer !== undefined) window.clearTimeout(liveTimer);
      liveTimer = window.setTimeout(() => {
        liveTimer = undefined;
        void useClipboardStore.getState().load({ silent: true });
      }, 300);
    }),
  );
}

function releaseLive() {
  liveRefs = Math.max(0, liveRefs - 1);
  if (liveRefs > 0) return;
  if (liveTimer !== undefined) {
    window.clearTimeout(liveTimer);
    liveTimer = undefined;
  }
  liveScope?.dispose();
  liveScope = null;
}

/** 测试/热更新用：重置请求代际，避免跨代响应污染新实例。 */
export function resetClipboardRequestState() {
  filterGen += 1;
  reqSeq += 1;
}
