//! 微件的真实数据源装配（集成层）。
//!
//! 只做「读取既有 Store / 既有统计查询 → 映射到 `lib/widgets/sources.ts` 契约」：
//! - 专注：只读 `useFocusStore.snapshot`，不新建轮询或 IPC；
//! - 效率：复用任务统计面板的 `task_analytics` 日查询，挂载时取一次，不轮询；
//!   统计模块尚未返回时保持 null（微件显示「等待模块接入」，不显示假 0）。
//!
//! 模块级缓存保证 `getSnapshot` 返回稳定引用（useSyncExternalStore 要求）。

import { acquireFocusEvents, useFocusStore, SESSION_KIND_LABEL } from "../../store/useFocusStore";
import { useTasksStore } from "../../store/useTasksStore";
import {
  createMappedWidgetSource,
  type EfficiencySnapshot,
  type EfficiencySource,
  type FocusPhase,
  type FocusSource,
  type WidgetSources,
} from "../../lib/widgets/sources";
import { fetchTaskAnalytics, type TaskAnalytics } from "../tasks/analytics/api";

/** 专注快照 → 微件契约。暂停时不给 endsAt，微件不显示倒计时。 */
function mapFocus(raw: ReturnType<typeof useFocusStore.getState>["snapshot"]) {
  if (!raw) return null;
  const active = raw.active;
  if (!active || active.state === "completed" || active.state === "cancelled") {
    return { phase: "idle" as FocusPhase, label: "", endsAt: null };
  }
  const phase: FocusPhase =
    active.state === "focusing" ? "focus" : active.state === "break" ? "break" : "paused";
  const running = phase === "focus" || phase === "break";
  const serverNow = Date.parse(raw.server_now);
  return {
    phase,
    label: SESSION_KIND_LABEL[active.kind],
    endsAt:
      running && Number.isFinite(serverNow)
        ? new Date(serverNow + Math.max(0, active.remaining_ms)).toISOString()
        : null,
    cycle: {
      index: active.round_index,
      total: Math.max(1, raw.prefs.long_break_every),
    },
  };
}

const focusSource: FocusSource = createMappedWidgetSource(
  () => useFocusStore.getState().snapshot,
  (onChange) => {
    // 微件页可能在从未打开过专注工作台时被打开：先取一次真实快照，
    // 再通过引用计数复用全应用唯一的一组 focus 事件监听（不新增轮询）。
    if (!useFocusStore.getState().snapshot) void useFocusStore.getState().load();
    let disposed = false;
    let releaseEvents: (() => void) | null = null;
    void acquireFocusEvents().then((release) => {
      if (disposed) release();
      else releaseEvents = release;
    });
    const unsubscribe = useFocusStore.subscribe(onChange);
    return () => {
      disposed = true;
      unsubscribe();
      releaseEvents?.();
    };
  },
  mapFocus,
);

// —— 效率：日统计（与任务统计面板同一 IPC、同一口径） ——
let efficiencyData: TaskAnalytics | null = null;
let efficiencySnapshot: EfficiencySnapshot | null = null;
let efficiencyInFlight: Promise<void> | null = null;
const efficiencyListeners = new Set<() => void>();

function publishEfficiency() {
  const stats = useTasksStore.getState().stats;
  // 两个来源缺一不可：任一缺失都保持「等待接入」，不把未知当成 0。
  if (!efficiencyData || !stats) return;
  efficiencySnapshot = {
    // 「完成次数」：含重复任务每一期（与任务统计面板卡片同名同源）。
    completedToday: efficiencyData.summary.completed,
    dueToday: efficiencyData.summary.due,
    overdue: efficiencyData.summary.due_overdue,
    pending: stats.pending,
    completionRate:
      efficiencyData.summary.completion_rate == null
        ? null
        : efficiencyData.summary.completion_rate * 100,
  };
  for (const listener of efficiencyListeners) listener();
}

function refreshEfficiency(): Promise<void> {
  if (efficiencyInFlight) return efficiencyInFlight;
  efficiencyInFlight = fetchTaskAnalytics("day")
    .then((data) => {
      efficiencyData = data;
      publishEfficiency();
    })
    .catch(() => {
      // 保留上一次成功结果；从未成功时微件保持「等待统计模块数据」，
      // 不伪造 0，也不在每次渲染时重试。
    })
    .finally(() => {
      efficiencyInFlight = null;
    });
  return efficiencyInFlight;
}

const efficiencySource: EfficiencySource = {
  getSnapshot: () => efficiencySnapshot,
  subscribe: (onChange) => {
    efficiencyListeners.add(onChange);
    void refreshEfficiency();
    // 任务概览变化（新建/完成/删除）时重算展示；不触发统计查询。
    const unsubscribeStats = useTasksStore.subscribe((state, prev) => {
      if (state.stats !== prev.stats) publishEfficiency();
    });
    return () => {
      efficiencyListeners.delete(onChange);
      unsubscribeStats();
    };
  },
};

/** 微件面板的数据源（模块级常量：引用稳定，避免重复订阅）。 */
export const WIDGET_SOURCES: WidgetSources = {
  focus: focusSource,
  efficiency: efficiencySource,
};
