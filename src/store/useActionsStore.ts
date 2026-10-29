//! 行动中心状态：单一数据源 + 去抖单飞刷新。
//!
//! 事件批量到达时只调度一次刷新（≤1 次/1.2s），组件卸载不会遗留订阅；
//! 所有计数来自后端真实事件，前端不自行推断 Agent 状态。

import { create } from "zustand";
import {
  actionsAck,
  actionsFeed,
  actionsOpenSession,
  actionsUnack,
  type ActionFeed,
  type ActionFilter,
  type ActionKind,
} from "../lib/bridge";
import type { NavigationResult } from "../lib/navigation";

const REFRESH_DEBOUNCE_MS = 1200;

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let queued = false;

interface ActionsState {
  feed: ActionFeed | null;
  loading: boolean;
  error: string | null;
  filter: ActionFilter;
  lastLoadedAt: number;
  setFilter: (patch: Partial<ActionFilter>) => void;
  load: (opts?: { silent?: boolean }) => Promise<void>;
  ack: (eventIds: string[]) => Promise<void>;
  unack: (eventIds: string[]) => Promise<void>;
  openSession: (sourceId: string, sessionId: string) => Promise<NavigationResult>;
}

export const useActionsStore = create<ActionsState>((set, get) => ({
  feed: null,
  loading: false,
  error: null,
  filter: { include_acked: false, limit: 120 },
  lastLoadedAt: 0,
  setFilter: (patch) => {
    set((s) => ({ filter: { ...s.filter, ...patch } }));
    void get().load();
  },
  load: async (opts) => {
    if (inflight) {
      queued = true;
      return inflight;
    }
    if (!opts?.silent) set({ loading: true });
    inflight = (async () => {
      try {
        const feed = await actionsFeed(get().filter);
        set({ feed, error: null, lastLoadedAt: Date.now() });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        set({ loading: false });
        inflight = null;
      }
    })();
    await inflight;
    if (queued) {
      queued = false;
      return get().load({ silent: true });
    }
  },
  ack: async (eventIds) => {
    if (!eventIds.length) return;
    await actionsAck(eventIds);
    await get().load({ silent: true });
  },
  unack: async (eventIds) => {
    if (!eventIds.length) return;
    await actionsUnack(eventIds);
    await get().load({ silent: true });
  },
  openSession: (sourceId, sessionId) => actionsOpenSession(sourceId, sessionId),
}));

/** 事件驱动的去抖刷新：无数新事件时不会唤醒 UI。 */
export function scheduleActionsRefresh() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void useActionsStore.getState().load({ silent: true });
  }, REFRESH_DEBOUNCE_MS);
}

/** 卸载时清理待执行调度（测试/热更新安全）。 */
export function cancelActionsRefresh() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 需要人处理的动作数（P0/P1 + 提醒），用于标签徽标。 */
export function attentionCount(feed: ActionFeed | null): number {
  if (!feed) return 0;
  const c = feed.counts;
  return c.failed + c.authorization + c.waiting_input + c.reminder;
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
