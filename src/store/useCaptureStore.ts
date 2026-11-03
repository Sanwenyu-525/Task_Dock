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
  setFilter: (filter: CaptureFilter) => void;
  /** 按当前筛选拉取列表 + 刷新未处理计数 */
  load: () => Promise<void>;
  /** 手动刷新（保留当前筛选） */
  refresh: () => Promise<void>;
  /** 只刷新未处理计数（App 收到 quick-capture-created 时调用） */
  refreshInboxCount: () => Promise<void>;
  markHandled: (id: string) => Promise<CaptureItem>;
  convertToTask: (id: string) => Promise<CaptureItem>;
  remove: (id: string) => Promise<void>;
}

/** 列表请求序号：筛选快速切换时丢弃过期响应。 */
let loadSeq = 0;

function isInbox(item: CaptureItem): boolean {
  return item.status === "inbox";
}

export const useCaptureStore = create<CaptureStore>((set, get) => ({
  items: [],
  filter: "inbox",
  loading: false,
  error: null,
  inboxCount: 0,

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
      });
    } catch (error) {
      if (seq !== loadSeq) return;
      set({ loading: false, error: formatError(error) });
    }
  },

  refresh: () => get().load(),

  refreshInboxCount: async () => {
    try {
      const state = await quickCaptureState();
      set({ inboxCount: state.inbox_count });
    } catch {
      // 计数刷新失败不影响列表；徽标保留上一次的已知值
    }
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
