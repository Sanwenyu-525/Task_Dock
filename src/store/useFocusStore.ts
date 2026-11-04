//! 专注与休息 store。
//!
//! 权威状态在 Rust：前端只保存后端快照与快照获取时刻。共享时钟每秒触发渲染，
//! 倒计时 = 快照里的 `remaining_ms` − 快照之后经过的毫秒数；**从不把本地递减值当作权威**。

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invokeCommand, normalizeError } from "../lib/errors";
import type { MessageKey } from "../i18n";
import { t } from "../i18n";
import { localizedErrorMessage } from "../i18n/errors";

export type FocusSessionKind = "focus" | "short_break" | "long_break";
export type FocusSessionState =
  | "focusing"
  | "paused"
  | "break"
  | "completed"
  | "cancelled";

export interface FocusPrefs {
  focus_minutes: number;
  short_break_minutes: number;
  long_break_minutes: number;
  long_break_every: number;
  auto_start_break: boolean;
  auto_start_next: boolean;
  sedentary_enabled: boolean;
  sedentary_interval_minutes: number;
}

export type FocusPrefsPatch = Partial<FocusPrefs>;

export interface FocusSessionView {
  id: string;
  kind: FocusSessionKind;
  state: FocusSessionState;
  task_id: string | null;
  task_title: string;
  task_deleted: boolean;
  planned_seconds: number;
  extension_seconds: number;
  accumulated_ms: number;
  remaining_ms: number;
  started_at: string;
  running_since: string | null;
  paused_at: string | null;
  pause_reason: string | null;
  round_index: number;
  clock_jumps: number;
}

export interface FocusTodayStats {
  day: string;
  focus_ms: number;
  break_ms: number;
  completed_focus: number;
}

export interface FocusSedentaryView {
  enabled: boolean;
  interval_minutes: number;
  next_at: string | null;
}

export interface FocusSnapshot {
  active: FocusSessionView | null;
  prefs: FocusPrefs;
  today: FocusTodayStats;
  rounds_since_long: number;
  sedentary: FocusSedentaryView;
  server_now: string;
}

export interface FocusHistoryItem {
  id: string;
  kind: FocusSessionKind;
  state: FocusSessionState;
  task_id: string | null;
  task_title: string;
  task_deleted: boolean;
  planned_seconds: number;
  accumulated_ms: number;
  started_at: string;
  ended_at: string | null;
  round_index: number;
}

interface FocusStoreState {
  snapshot: FocusSnapshot | null;
  /** 快照获取时刻（epoch ms），倒计时在此基础上做展示级推算。 */
  snapshotAt: number;
  history: FocusHistoryItem[];
  loading: boolean;
  error: string | null;
  busyAction: string | null;
  load: () => Promise<void>;
  loadHistory: (limit?: number) => Promise<void>;
  start: (taskId?: string | null) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  finish: () => Promise<void>;
  cancel: () => Promise<void>;
  startBreak: () => Promise<void>;
  extendBreak: (minutes: number) => Promise<void>;
  skipBreak: () => Promise<void>;
  updatePrefs: (patch: FocusPrefsPatch) => Promise<void>;
  snoozeSedentary: (minutes: number) => Promise<void>;
}

let loadGeneration = 0;

function running(active: FocusSessionView | null): boolean {
  return (
    !!active &&
    (active.state === "focusing" || active.state === "break")
  );
}

/**
 * 展示用剩余毫秒：以后端快照为基准，叠加快照后的经过时间。
 * 暂停/结束不递减；到 0 后停住，等后端事件把状态切到 completed。
 */
export function remainingFromSnapshot(
  active: FocusSessionView | null,
  snapshotAt: number,
  now: number,
): number | null {
  if (!active) return null;
  if (!running(active)) return Math.max(0, active.remaining_ms);
  const elapsed = Math.max(0, now - snapshotAt);
  return Math.max(0, active.remaining_ms - elapsed);
}

/** mm:ss（超过 1 小时显示 h:mm:ss）。 */
export function formatRemaining(ms: number | null): string {
  if (ms == null) return "--:--";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 会话状态 → i18n 键。组件用 `useLocale().t` 渲染，切换语言时才会重新渲染。 */
export const SESSION_STATE_KEYS: Record<FocusSessionState, MessageKey> = {
  focusing: "focus.state.focusing",
  paused: "focus.state.paused",
  break: "focus.state.break",
  completed: "focus.state.completed",
  cancelled: "focus.state.cancelled",
};

/** 会话类型 → i18n 键。 */
export const SESSION_KIND_KEYS: Record<FocusSessionKind, MessageKey> = {
  focus: "focus.kind.focus",
  short_break: "focus.kind.shortBreak",
  long_break: "focus.kind.longBreak",
};

/**
 * 兼容旧调用方的本地化投影：`components/widgets/liveSources.ts` 仍按对象取值。
 * 每次访问都按当前语言求值，不再缓存中文常量；React 组件请直接用 KEYS +
 * `useLocale()`，这样语言切换时组件会重新渲染。
 */
export const SESSION_STATE_LABEL: Record<FocusSessionState, string> = {
  get focusing() {
    return t(SESSION_STATE_KEYS.focusing);
  },
  get paused() {
    return t(SESSION_STATE_KEYS.paused);
  },
  get break() {
    return t(SESSION_STATE_KEYS.break);
  },
  get completed() {
    return t(SESSION_STATE_KEYS.completed);
  },
  get cancelled() {
    return t(SESSION_STATE_KEYS.cancelled);
  },
};

/** 兼容旧调用方的本地化投影（同上）。 */
export const SESSION_KIND_LABEL: Record<FocusSessionKind, string> = {
  get focus() {
    return t(SESSION_KIND_KEYS.focus);
  },
  get short_break() {
    return t(SESSION_KIND_KEYS.short_break);
  },
  get long_break() {
    return t(SESSION_KIND_KEYS.long_break);
  },
};

/**
 * 专注操作的错误文案。
 *
 * 后端 `Validation` / `Conflict` 的 message 就是具体原因（「所选任务不存在或已被删除」
 * 「当前会话不是休息」），与 `src-tauri/src/error.rs` 的既定契约一致；若一律换成通用
 * code 文案会丢掉用户可操作的事实。其余错误（IO/DB/IPC/超时等）按错误码本地化。
 */
function focusErrorMessage(raw: unknown): string {
  const error = normalizeError(raw);
  if (
    !error.legacy &&
    (error.code === "VALIDATION_ERROR" || error.code === "CONFLICT")
  ) {
    return error.message;
  }
  return localizedErrorMessage(error);
}

async function invokeSnapshot(
  command: string,
  args?: Record<string, unknown>,
): Promise<FocusSnapshot> {
  return invokeCommand<FocusSnapshot>(command, args);
}

export const useFocusStore = create<FocusStoreState>()((set, get) => {
  const applySnapshot = (snapshot: FocusSnapshot) =>
    set({ snapshot, snapshotAt: Date.now(), error: null });

  const run = async (
    action: string,
    command: string,
    args: Record<string, unknown> | undefined,
    after?: (snapshot: FocusSnapshot) => void,
  ) => {
    if (get().busyAction) return; // 单飞：重复点击不会发出第二个 IPC
    set({ busyAction: action, error: null });
    try {
      const snapshot = await invokeSnapshot(command, args);
      applySnapshot(snapshot);
      after?.(snapshot);
    } catch (raw) {
      set({ error: focusErrorMessage(raw) });
    } finally {
      set({ busyAction: null });
    }
  };

  return {
    snapshot: null,
    snapshotAt: 0,
    history: [],
    loading: false,
    error: null,
    busyAction: null,

    load: async () => {
      const generation = ++loadGeneration;
      set({ loading: true });
      try {
        const snapshot = await invokeSnapshot("focus_snapshot");
        // 快照时刻必须在拿到快照后立即记录，不能等历史请求返回：
        // 否则倒计时会多算一段历史 IPC 的时延（先偏大，下一次事件又突然跳回）。
        const snapshotAt = Date.now();
        const history = await invokeCommand<FocusHistoryItem[]>(
          "focus_history",
          { limit: 12 },
        );
        if (generation !== loadGeneration) return;
        set({
          snapshot,
          snapshotAt,
          history,
          loading: false,
          error: null,
        });
      } catch (raw) {
        if (generation !== loadGeneration) return;
        set({ loading: false, error: focusErrorMessage(raw) });
      }
    },

    loadHistory: async (limit = 12) => {
      try {
        const history = await invokeCommand<FocusHistoryItem[]>(
          "focus_history",
          { limit },
        );
        set({ history });
      } catch (raw) {
        set({ error: focusErrorMessage(raw) });
      }
    },

    start: async (taskId = null) => {
      if (get().snapshot?.active) return; // 已有会话：不重复开始
      await run("start", "focus_start", { taskId });
    },

    pause: async () => {
      const active = get().snapshot?.active;
      if (!active || !running(active)) return;
      await run("pause", "focus_pause", undefined);
    },

    resume: async () => {
      const active = get().snapshot?.active;
      if (!active || active.state !== "paused") return;
      await run("resume", "focus_resume", undefined);
    },

    finish: async () => {
      if (!get().snapshot?.active) return;
      await run("finish", "focus_finish", undefined, () => {
        void get().loadHistory();
      });
    },

    cancel: async () => {
      if (!get().snapshot?.active) return;
      await run("cancel", "focus_cancel", undefined, () => {
        void get().loadHistory();
      });
    },

    startBreak: async () => {
      if (get().snapshot?.active) return;
      await run("break", "focus_start_break", undefined);
    },

    extendBreak: async (minutes) => {
      const active = get().snapshot?.active;
      if (!active || !active.kind.endsWith("break")) return;
      await run("extend", "focus_extend_break", { minutes });
    },

    skipBreak: async () => {
      const active = get().snapshot?.active;
      if (!active || !active.kind.endsWith("break")) return;
      await run("skip", "focus_skip_break", undefined, () => {
        void get().loadHistory();
      });
    },

    updatePrefs: async (patch) => {
      if (get().busyAction) return;
      set({ busyAction: "prefs", error: null });
      try {
        await invokeCommand<FocusPrefs>("focus_update_prefs", { patch });
        await get().load();
      } catch (raw) {
        set({ error: focusErrorMessage(raw) });
      } finally {
        set({ busyAction: null });
      }
    },

    snoozeSedentary: async (minutes) => {
      set({ busyAction: "snooze", error: null });
      try {
        const snapshot = await invokeSnapshot("focus_snooze_sedentary", {
          minutes,
        });
        applySnapshot(snapshot);
      } catch (raw) {
        set({ error: focusErrorMessage(raw) });
      } finally {
        set({ busyAction: null });
      }
    },
  };
});

// ---------------------------------------------------------------------------
// 事件订阅：全应用只保留一组 focus-changed / completed / sedentary 监听。
// ---------------------------------------------------------------------------

let listenerRefs = 0;
let listenerReady: Promise<UnlistenFn[]> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReload() {
  if (reloadTimer !== null) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void useFocusStore.getState().load();
  }, 50);
}

async function ensureListeners(): Promise<UnlistenFn[]> {
  if (!listenerReady) {
    listenerReady = Promise.all([
      listen("focus-changed", scheduleReload),
      listen("focus-completed", scheduleReload),
      listen("focus-sedentary", scheduleReload),
    ]);
  }
  return listenerReady;
}

/** 组件挂载时获取订阅；返回的清理函数在最后一个订阅者卸载时释放监听。 */
export async function acquireFocusEvents(): Promise<() => void> {
  listenerRefs += 1;
  await ensureListeners();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listenerRefs -= 1;
    if (listenerRefs <= 0) {
      listenerRefs = 0;
      const ready = listenerReady;
      listenerReady = null;
      void ready?.then((offs) => offs.forEach((off) => off()));
      if (reloadTimer !== null) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
    }
  };
}

/** 仅供测试重置模块级订阅状态。 */
export function resetFocusEventsForTest(): void {
  listenerRefs = 0;
  listenerReady = null;
  if (reloadTimer !== null) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  loadGeneration = 0;
}
