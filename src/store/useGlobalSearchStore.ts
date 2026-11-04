//! 全局搜索状态：查询、防抖、乱序防护、分类筛选、最近搜索与统一跳转。
//!
//! 设计要点：
//! - 输入防抖 220ms（任务书建议 180–250ms）；请求代际 `seq` 保证旧响应不覆盖新结果。
//! - 弹窗关闭时清理防抖定时器；最近搜索持久化在 localStorage（见 globalSearchBridge）。
//! - 跳转集中在本 store 的 `openResult`：每个分类一条确定路径；不支持伪装成功。
//! - 「精确定位」经 `pendingLocate`（一次性意图 + token 自增）交给目标模块消费，
//!   消费后必须 `consumeLocate()` 清除（先例：useUiStore.agentFocus/appConfig）。

import { create } from "zustand";

import {
  globalSearch,
  loadRecentSearches,
  persistRecentSearches,
  clearRecentSearches as clearRecentPersisted,
  saveRecentSearch,
  type GlobalSearchCategoryFilter,
  type GlobalSearchResult,
} from "../lib/globalSearchBridge";
import { navNavigate } from "../lib/navigation";
import { useUiStore } from "./useUiStore";

/** 目标模块消费的一次性定位意图。token 自增支持重复定位同一对象。 */
export interface GlobalSearchLocateIntent {
  category: string;
  /** 结果 id（通常即目标条目 id）。 */
  id: string;
  /** 结果子类型（task/session/run/snapshot/project/feature/milestone…）。 */
  kind: string;
  /** 父级 id（run→session、snapshot→task、feature/milestone→project）。 */
  parentId: string | null;
  /** 搜索词（目标模块可用来设置过滤，确保目标可见）。 */
  keyword: string;
  token: number;
}

const SEARCH_DEBOUNCE_MS = 220;

interface GlobalSearchState {
  open: boolean;
  query: string;
  /** 仅筛选维度；"all" = 全部分类。 */
  activeCategory: GlobalSearchCategoryFilter;
  results: Awaited<ReturnType<typeof globalSearch>> | null;
  loading: boolean;
  error: string | null;
  activeIndex: number;
  recent: string[];
  pendingLocate: GlobalSearchLocateIntent | null;
  /** 交互提示（如应用启动失败原因），弹窗底部展示。 */
  notice: string | null;

  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setQuery: (q: string) => void;
  setActiveCategory: (c: GlobalSearchCategoryFilter) => void;
  retry: () => void;
  moveActive: (delta: number) => void;
  setActiveIndex: (i: number) => void;
  /** 执行结果跳转（记录最近搜索 → 分类分发）。 */
  openResult: (item: GlobalSearchResult) => void;
  /** 目标模块消费定位意图后调用（清除意图）。 */
  consumeLocate: () => void;
  clearRecent: () => void;
  setNotice: (n: string | null) => void;
}

let debounceTimer: number | undefined;
let searchSeq = 0;
let locateSeq = 0;

function clearDebounce() {
  if (debounceTimer !== undefined) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}

export const useGlobalSearchStore = create<GlobalSearchState>((set, get) => ({
  open: false,
  query: "",
  activeCategory: "all",
  results: null,
  loading: false,
  error: null,
  activeIndex: 0,
  recent: loadRecentSearches(),
  pendingLocate: null,
  notice: null,

  openSearch: () => {
    clearDebounce();
    set({ open: true, notice: null, error: null });
  },

  closeSearch: () => {
    clearDebounce();
    set({ open: false });
  },

  toggleSearch: () => {
    if (get().open) get().closeSearch();
    else get().openSearch();
  },

  setQuery: (q) => {
    set({ query: q, error: null, notice: null });
    clearDebounce();
    const trimmed = q.trim();
    if (!trimmed) {
      searchSeq += 1;
      set({ results: null, loading: false });
      return;
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      void get().retry();
    }, SEARCH_DEBOUNCE_MS);
  },

  setActiveCategory: (c) => {
    set({ activeCategory: c, activeIndex: 0 });
    // 分类切换立即重查（选择分类后只查询该类别，避免无用请求）。
    if (get().query.trim()) void get().retry();
  },

  retry: async () => {
    const { query, activeCategory } = get();
    const trimmed = query.trim();
    if (!trimmed) return;
    const seq = ++searchSeq;
    set({ loading: true, error: null });
    try {
      const categories =
        activeCategory === "all" ? null : ([activeCategory] as string[]);
      const res = await globalSearch(trimmed, categories, null);
      if (seq !== searchSeq) return; // 旧响应丢弃
      set({ results: res, loading: false, activeIndex: 0 });
    } catch (e) {
      if (seq !== searchSeq) return;
      // 失败不清空已有结果：显示错误 + 允许重试。
      set({ loading: false, error: String(e).slice(0, 200) });
    }
  },

  moveActive: (delta) => {
    const { results, activeIndex } = get();
    const total = results?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;
    if (total === 0) return;
    const next = (activeIndex + delta + total) % total;
    set({ activeIndex: next });
  },

  setActiveIndex: (i) => set({ activeIndex: i }),

  openResult: (item) => {
    const { query } = get();
    // 记录最近搜索（本地，去重，最新在前）。
    const recent = saveRecentSearch(query, get().recent);
    persistRecentSearches(recent);
    set({ recent });
    get().closeSearch();

    const ui = useUiStore.getState();
    const intent: GlobalSearchLocateIntent = {
      category: item.category,
      id: item.target_id ?? item.id,
      kind: item.kind,
      parentId: item.parent_id,
      keyword: query.trim(),
      token: ++locateSeq,
    };

    switch (item.category) {
      case "tasks": {
        ui.setTab("tasks");
        set({ pendingLocate: intent });
        break;
      }
      case "clipboard": {
        ui.setTab("clipboard");
        set({ pendingLocate: intent });
        break;
      }
      case "capture": {
        ui.setTab("inbox");
        set({ pendingLocate: intent });
        break;
      }
      case "shelf": {
        ui.setTab("shelf");
        set({ pendingLocate: intent });
        break;
      }
      case "apps": {
        // 已保存导航目标：走既有 navNavigate（不绕过目标可信配置）；
        // focus_or_launch 语义 = 已有运行窗口优先聚焦，否则启动。
        const targetId = item.target_id ?? item.id;
        void navNavigate(targetId, { action: "focus_or_launch" })
          .then(() => set({ notice: null }))
          .catch((e) => {
            // 启动失败如实回显，不伪装成功。
            set({
              open: true,
              notice: `启动失败：${String(e).slice(0, 140)}`,
            });
          });
        break;
      }
      case "agents": {
        // 会话/轮次 → focusAgent 全链路（sourceId/sessionId/refId）。
        if (item.parent_id && (item.target_id || item.id)) {
          ui.setTab("agents");
          ui.focusAgent({
            sourceId: item.parent_id,
            sessionId: item.target_id ?? item.id,
            refId: item.kind === "run" ? item.id : null,
          });
        } else {
          ui.setTab("agents");
        }
        break;
      }
      case "workspace": {
        ui.setTab("tasks");
        set({ pendingLocate: intent });
        break;
      }
      case "planning": {
        ui.setTab("roadmap");
        set({ pendingLocate: intent });
        break;
      }
      default:
        // 未知分类不伪装跳转。
        set({ open: true, notice: "该结果类型暂不支持跳转" });
        break;
    }
  },

  consumeLocate: () => set({ pendingLocate: null }),

  clearRecent: () => {
    clearRecentPersisted();
    set({ recent: [] });
  },

  setNotice: (n) => set({ notice: n }),
}));

/** 测试用：重置请求代际与防抖定时器（避免跨用例污染）。 */
export function resetGlobalSearchTimers() {
  clearDebounce();
  searchSeq += 1;
}
