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
import { isFullViewVisible } from "../hooks/useMainUiVisible";
import { selectNavigationLayout } from "../lib/navigationLayout";
import { useSettingsStore } from "./useSettingsStore";
import { useUiStore } from "./useUiStore";

const REFRESH_DEBOUNCE_MS = 1200;
const PAGE_SIZE = 40;

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let queued: { silent: boolean; countsOnly: boolean } | null = null;
/** 列表替换代数：分页请求期间若列表被整体替换，旧游标页必须丢弃。 */
let listVersion = 0;

/**
 * 视图身份：跨异步边界（ack 返回）判断是否仍处发起时的筛选。
 * 用语义 key 而非对象引用——A→B→A 会生成新对象但仍是同一个视图。
 */
export function actionViewKey(f: ActionFilter): string {
  return JSON.stringify([
    f.category ?? "",
    f.kind ?? "",
    f.priority ?? "",
    f.source_id ?? "",
    f.task_id ?? "",
    f.include_acked ?? false,
  ]);
}

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
  /** 返回后端实际改动的条数，调用方据此给出真实反馈。 */
  ack: (ids: string[]) => Promise<number>;
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
      // 合并排队请求：只要任一排队请求要求完整列表，就不能降级成 countsOnly，
      // 否则正式的列表刷新会被随后的事件计数刷新吃掉。
      const prev = queued;
      queued = {
        silent: (prev?.silent ?? true) && !!opts?.silent,
        countsOnly: (prev?.countsOnly ?? true) && !!opts?.countsOnly,
      };
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
  /** 标记已处理；返回后端实际改动的条数（0 表示这条已经被处理过了）。 */
  ack: async (ids) => {
    if (!ids.length) return 0;
    // 记录发起时的视图身份：请求在途期间用户可能已切分类/优先级/来源/任务。
    // 旧请求的结果仍会在后端生效；只有仍处原视图（含 A→B→A 切回）才重新同步，
    // 否则旧筛选的列表会被当成新视图数据写回。切筛选本身已触发加载。
    const viewKey = actionViewKey(get().filter);
    const n = await actionsAck(ids);
    if (actionViewKey(get().filter) === viewKey) await get().load({ silent: true });
    return n;
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
    // 执行前重新验证消费者：调度窗口内可能已切到极简/紧凑模式、隐藏入口或进入
    // 停靠胶囊。此时聚合结果没有任何 UI 消费者，发出去只是白跑一次查询；
    // 消费者恢复时由 FullView / ActionCenterPanel 的恢复路径补一次刷新。
    if (!shouldRefreshActions()) return;
    void useActionsStore.getState().load({ silent: true, countsOnly: true });
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * 行动中心聚合数据当前的 UI 消费者判定。
 *
 * `feed` 只有两个消费者：完整面板侧栏徽标（入口可见时渲染）与行动中心页面
 * （tab=actions 时挂载）。入口被隐藏、行动页未打开、或完整面板不可见时，
 * 事件驱动的计数聚合刷新没有任何 UI 消费者 —— 应当暂停（导航显隐 ≠ 停用
 * 行动中心：Agent 事件仍照常入库，重新出现消费者时由恢复路径补一次刷新）。
 *
 * 「完整面板不可见」包含两种：停靠胶囊期（主界面 display:none + inert）与
 * 极简/紧凑模式（主界面仍在，但侧栏与页面整块不渲染）。后者是旧实现的漏判：
 * 只看 tab 与入口可见性，会让非完整模式下继续为不可见的徽标做聚合查询。
 */
export function hasActionsFeedConsumer(): boolean {
  if (!isFullViewVisible()) return false;
  // 行动中心页面挂载中（tab=actions），即使入口隐藏（当前页由「更多」承担）
  if (useUiStore.getState().tab === "actions") return true;
  // 开发工作台（2026-11）：「需要处理」区域消费 intervention 计数与列表
  if (useUiStore.getState().tab === "workbench") return true;
  // 侧栏入口可见：徽标持续消费 counts
  const layout = selectNavigationLayout(useSettingsStore.getState().settings);
  return layout.left.includes("actions");
}

/**
 * 事件处理器统一入口：长期停用、临时暂停或没有 UI 消费者时都不调度自动聚合。
 *
 * 暂停（`actions_paused`）只停自动刷新；页面内手动 `load()` 不受此门控，
 * 历史记录仍可主动查看。
 */
export function shouldRefreshActions(): boolean {
  const settings = useSettingsStore.getState().settings;
  if (settings?.actions_enabled === false) return false;
  if (settings?.actions_paused === true) return false;
  return hasActionsFeedConsumer();
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
