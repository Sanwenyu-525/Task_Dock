//! 行动中心状态：单一数据源 + 去抖单飞刷新 + keyset 分页追加。
//!
//! - 计数来自后端显式 SQL，与筛选/分页无关；徽标只用 `counts.total`；
//! - 事件批量到达时只调度一次计数刷新（≤1 次/1.2s），不覆盖已加载的旧页；
//! - 加载更多使用后端 `next_cursor`，新事件不会导致旧页重复/丢失；
//! - 组件卸载不会遗留订阅或定时器。

import { create } from "zustand";
import {
  actionsAck,
  actionsFeed,
  actionsOpenSession,
  actionsUnack,
  type ActionCategory,
  type ActionFeed,
  type ActionFilter,
  type ActionKind,
} from "../lib/bridge";
import type { NavigationResult } from "../lib/navigation";

const REFRESH_DEBOUNCE_MS = 1200;
const PAGE_SIZE = 40;

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let queued: { silent: boolean; countsOnly: boolean } | null = null;
/** 列表替换代数：分页请求期间若列表被整体替换，旧游标页必须丢弃。 */
let listVersion = 0;

interface LoadOpts {
  silent?: boolean;
  /** 只刷新计数/覆盖度，不替换已加载的列表（后台事件刷新用） */
  countsOnly?: boolean;
}

interface ActionsState {
  feed: ActionFeed | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  filter: ActionFilter;
  lastLoadedAt: number;
  setFilter: (patch: Partial<ActionFilter>) => void;
  load: (opts?: LoadOpts) => Promise<void>;
  loadMore: () => Promise<void>;
  ack: (ids: string[]) => Promise<void>;
  unack: (ids: string[]) => Promise<void>;
  openSession: (sourceId: string, sessionId: string) => Promise<NavigationResult>;
}

const INITIAL_FILTER: ActionFilter = {
  category: "intervention",
  include_acked: false,
  limit: PAGE_SIZE,
};

export const useActionsStore = create<ActionsState>((set, get) => ({
  feed: null,
  loading: false,
  loadingMore: false,
  error: null,
  filter: INITIAL_FILTER,
  lastLoadedAt: 0,
  setFilter: (patch) => {
    set((s) => ({ filter: { ...s.filter, ...patch } }));
    void get().load();
  },
  load: async (opts) => {
    if (inflight) {
      queued = { silent: !!opts?.silent, countsOnly: !!opts?.countsOnly };
      return inflight;
    }
    if (!opts?.silent) set({ loading: true });
    inflight = (async () => {
      try {
        const feed = await actionsFeed(get().filter);
        if (opts?.countsOnly) {
          set((s) => {
            const cur = s.feed;
            // 分类切换中：旧分类列表不能挂上新分类计数，交给正式 load
            if (!cur || cur.category !== feed.category) {
              return { error: null, lastLoadedAt: Date.now() };
            }
            return {
              feed: {
                ...cur,
                counts: feed.counts,
                db_total: feed.db_total,
                coverage: feed.coverage,
                generated_at: feed.generated_at,
                enabled: feed.enabled,
              },
              error: null,
              lastLoadedAt: Date.now(),
            };
          });
        } else {
          listVersion += 1;
          set({ feed, error: null, lastLoadedAt: Date.now() });
        }
      } catch (e) {
        set({ error: String(e) });
      } finally {
        set({ loading: false });
        inflight = null;
      }
    })();
    await inflight;
    if (queued) {
      const next = queued;
      queued = null;
      return get().load(next);
    }
  },
  loadMore: async () => {
    const { feed, filter, loading, loadingMore } = get();
    if (!feed || loading || loadingMore || !feed.has_more || !feed.next_cursor) return;
    set({ loadingMore: true });
    const version = listVersion;
    try {
      const page = await actionsFeed({ ...filter, cursor: feed.next_cursor });
      // 请求期间筛选已变化或列表已被整体替换：放弃追加，避免把旧游标页混进新列表
      if (get().filter !== filter || listVersion !== version) {
        set({ loadingMore: false });
        return;
      }
      set((s) => {
        const cur = s.feed;
        if (!cur || cur.category !== page.category) {
          return { loadingMore: false };
        }
        const seen = new Set(cur.items.map((i) => i.id));
        const merged = [...cur.items, ...page.items.filter((i) => !seen.has(i.id))];
        return {
          feed: { ...page, items: merged, loaded: merged.length },
          loadingMore: false,
          error: null,
          lastLoadedAt: Date.now(),
        };
      });
    } catch (e) {
      set({ loadingMore: false, error: String(e) });
    }
  },
  ack: async (ids) => {
    if (!ids.length) return;
    await actionsAck(ids);
    await get().load({ silent: true });
  },
  unack: async (ids) => {
    if (!ids.length) return;
    await actionsUnack(ids);
    await get().load({ silent: true });
  },
  openSession: (sourceId, sessionId) => actionsOpenSession(sourceId, sessionId),
}));

/** 事件驱动的去抖刷新：只更新计数，不打断用户正在翻的页。 */
export function scheduleActionsRefresh() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void useActionsStore.getState().load({ silent: true, countsOnly: true });
  }, REFRESH_DEBOUNCE_MS);
}

/** 卸载时清理待执行调度（测试/热更新安全）。 */
export function cancelActionsRefresh() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 真正需要关注的数量：需介入 + 未被代表的通知（互不重叠）。 */
export function attentionCount(feed: ActionFeed | null): number {
  if (!feed) return 0;
  return feed.counts.total;
}

export function categoryCount(feed: ActionFeed | null, category: ActionCategory): number {
  if (!feed) return 0;
  const c = feed.counts;
  switch (category) {
    case "intervention":
      return c.intervention;
    case "notification":
      return c.notification;
    case "history":
      return c.history;
  }
}

export function kindLabel(kind: ActionKind): string {
  switch (kind) {
    case "failed":
      return "执行失败";
    case "authorization":
      return "需授权（推断）";
    case "waiting_input":
      return "等待输入";
    case "running":
      return "正在执行";
    case "completed":
      return "本轮完成";
    case "disconnected":
      return "连接中断";
    case "reminder":
      return "任务提醒";
  }
}
