//! 收集箱状态（v0.7）：只通过 bridge 的快速捕获命令读写，不直接访问 Tauri。
//! 列表口径由后端保证（未处理 / 全部，created_at DESC）；这里维护加载/错误态、
//! 未处理计数与各操作的本地就地更新，避免每次操作后整页闪烁。

import { create } from "zustand";
import {
  quickCaptureConvertToTask,
  quickCaptureDelete,
  quickCaptureList,
  quickCaptureMarkHandled,
  quickCaptureState,
  type CaptureItem,
} from "../lib/bridge";
import { formatError } from "../capture/captureUtils";

export type CaptureFilter = "inbox" | "all";

/** 一次拉取的条数：收集箱是轻量收件箱，首屏 50 条足够，翻页暂不做。 */
export const CAPTURE_PAGE_SIZE = 50;

interface CaptureStore {
  items: CaptureItem[];
  filter: CaptureFilter;
  loading: boolean;
  error: string | null;
  /** 未处理条数：侧边栏徽标与筛选共用同一口径（以后端 inbox_count 为准） */
  inboxCount: number;
  /** 是否从后端读到过未处理数（false 时徽标显示中性，不伪装成 0） */
  inboxCountLoaded: boolean;
  /**
   * 收集箱胶囊面板的轻量切片：未处理前 8 条。
   * null = 面板未打开。与完整页的 items/filter/loading 互不读写。
   */
  lite: CaptureItem[] | null;
  liteLoading: boolean;
  /** 轻量切片最近一次查询的错误；失败时旧 lite 原样保留 */
  liteError: string | null;
  setFilter: (filter: CaptureFilter) => void;
  /** 按当前筛选拉取列表 + 刷新未处理计数 */
  load: () => Promise<void>;
  /** 手动刷新（保留当前筛选） */
  refresh: () => Promise<void>;
  /** 只刷新未处理计数（App 收到 quick-capture-created 时调用） */
  refreshInboxCount: () => Promise<void>;
  /** 读一次轻量切片（收集箱胶囊面板挂载时调用；失败不清除已成功数据） */
  loadInboxLite: () => Promise<void>;
  /** 面板卸载：作废在途请求并释放轻量切片 */
  releaseLite: () => void;
  markHandled: (id: string) => Promise<CaptureItem>;
  convertToTask: (id: string) => Promise<CaptureItem>;
  remove: (id: string) => Promise<void>;
}

/** 列表请求序号：筛选快速切换时丢弃过期响应。 */
let loadSeq = 0;
/** 轻量切片请求序号：与完整页 loadSeq 互不干扰，旧响应不覆盖新切片。 */
let liteSeq = 0;

function isInbox(item: CaptureItem): boolean {
  return item.status === "inbox";
}

export const useCaptureStore = create<CaptureStore>((set, get) => ({
  items: [],
  filter: "inbox",
  loading: false,
  error: null,
  inboxCount: 0,
  inboxCountLoaded: false,
  lite: null,
  liteLoading: false,
  liteError: null,

  setFilter: (filter) => {
    if (get().filter === filter) return;
    set({ filter });
    void get().load();
  },

  load: async () => {
    const seq = ++loadSeq;
    set({ loading: true, error: null });
    const status = get().filter === "inbox" ? "inbox" : "all";
    try {
      // 计数直接取后端快照；列表与计数并行，避免串行等待
      const [items, state] = await Promise.all([
        quickCaptureList(status, CAPTURE_PAGE_SIZE, 0),
        quickCaptureState().catch(() => null),
      ]);
      if (seq !== loadSeq) return;
      const fallbackCount = items.filter(isInbox).length;
      set({
        items,
        loading: false,
        inboxCount: state ? state.inbox_count : fallbackCount,
        inboxCountLoaded: true,
      });
      // 收集箱胶囊面板开着就顺带刷新轻量切片：全应用只有 App.tsx 的一条
      // quick-capture-created 监听驱动这里，lite 不自建第二条监听。
      if (get().lite !== null) void get().loadInboxLite();
    } catch (error) {
      if (seq !== loadSeq) return;
      set({ loading: false, error: formatError(error) });
    }
  },

  refresh: () => get().load(),

  refreshInboxCount: async () => {
    try {
      const state = await quickCaptureState();
      set({ inboxCount: state.inbox_count, inboxCountLoaded: true });
    } catch {
      // 计数刷新失败不影响列表；徽标保留上一次的已知值
    }
  },

  loadInboxLite: async () => {
    const seq = ++liteSeq;
    set({ liteLoading: true });
    try {
      const [items, state] = await Promise.all([
        quickCaptureList("inbox", 8, 0),
        quickCaptureState().catch(() => null),
      ]);
      if (seq !== liteSeq) return; // 已有更新的请求，丢弃这次响应
      set((s) => ({
        lite: items,
        liteLoading: false,
        liteError: null,
        inboxCount: state ? state.inbox_count : s.inboxCount,
        inboxCountLoaded: state ? true : s.inboxCountLoaded,
      }));
    } catch (e) {
      if (seq !== liteSeq) return;
      // 失败不清除已成功数据：旧切片保留展示并由面板叠加错误提示；
      // 从未成功过（lite === null）时面板显示错误空态。两者都可重试。
      set({ liteLoading: false, liteError: String(e) });
    }
  },

  releaseLite: () => {
    liteSeq += 1; // 卸载后回来的响应一律作废
    set({ lite: null, liteLoading: false, liteError: null });
  },

  markHandled: async (id) => {
    const updated = await quickCaptureMarkHandled(id);
    const wasInbox = get().items.some((item) => item.id === id && isInbox(item));
    set((state) => {
      const items =
        state.filter === "inbox"
          ? state.items.filter((item) => item.id !== id)
          : state.items.map((item) => (item.id === id ? updated : item));
      return {
        items,
        inboxCount: wasInbox ? Math.max(0, state.inboxCount - 1) : state.inboxCount,
      };
    });
    return updated;
  },

  convertToTask: async (id) => {
    const updated = await quickCaptureConvertToTask(id);
    const wasInbox = get().items.some((item) => item.id === id && isInbox(item));
    set((state) => {
      const items =
        state.filter === "inbox"
          ? state.items.filter((item) => item.id !== id)
          : state.items.map((item) => (item.id === id ? updated : item));
      return {
        items,
        inboxCount: wasInbox ? Math.max(0, state.inboxCount - 1) : state.inboxCount,
      };
    });
    return updated;
  },

  remove: async (id) => {
    const wasInbox = get().items.some((item) => item.id === id && isInbox(item));
    await quickCaptureDelete(id);
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      inboxCount: wasInbox ? Math.max(0, state.inboxCount - 1) : state.inboxCount,
    }));
  },
}));
