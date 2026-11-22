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
//
// 一致性设计（widgets 验收 B1）：
// 1. 按需加载：只有存在订阅者时才查询；模块级状态由所有微件实例共享，
//    React StrictMode 的双挂载/多微件同时打开不会产生重复 IPC。
// 2. 失效：任务 Store 的 `stats` 引用变化视为任务数据发生变化（创建/完成/
//    删除/编辑最终都会走 `refresh()` → `loadStats()`，产生新对象）。只订阅
//    全局 stats，不订阅 `tasks` 列表，避免筛选/翻页这类「仅列表刷新」误触发。
// 3. 合并：一轮连续变化只保留一个 debounce 定时器（模块级，不按微件创建）。
// 4. 代际：每次失效递增 `efficiencyRevision`；响应落地时 revision 或 stats
//    引用已变化则丢弃旧结果，并在结束后强制补查一次，旧响应绝不覆盖新数据。
// 5. 释放：最后一个订阅者释放时清掉待执行定时器并取消 Store 监听；再次打开
//    时用「建立快照时的 stats 引用」判断缓存是否仍有效，失效则重查。
// 6. 失败：保留上一次成功结果并标记 `stale`（微件显示「数据可能已过期」+
//    重试）；从未成功时快照保持 null（等待接入），绝不把未知当成 0。
const EFFICIENCY_DEBOUNCE_MS = 120;

type TaskStatsSnapshot = ReturnType<typeof useTasksStore.getState>["stats"];

let efficiencyData: TaskAnalytics | null = null;
let efficiencySnapshot: EfficiencySnapshot | null = null;
/** 生成 `efficiencyData` 时对应的任务 stats；用于判断缓存是否已失效。 */
let efficiencyStats: TaskStatsSnapshot = null;
let efficiencyStale = false;
/** 任务数据代际：stats 引用每次变化递增。 */
let efficiencyRevision = 0;
let efficiencyInFlight: Promise<void> | null = null;
let efficiencyTimer: ReturnType<typeof setTimeout> | null = null;
let efficiencyStoreUnsub: (() => void) | null = null;
/** 测试重置代际：旧请求在重置后落地时不得写入新状态。 */
let efficiencyEpoch = 0;
const efficiencyListeners = new Set<() => void>();

function publishEfficiency() {
  const stats = useTasksStore.getState().stats;
  // 两个来源缺一不可：任一缺失都保持「等待接入」，不把未知当成 0。
  efficiencySnapshot = !efficiencyData || !stats ? null : {
    // 「完成次数」：含重复任务每一期（与任务统计面板卡片同名同源）。
    completedToday: efficiencyData.summary.completed,
    dueToday: efficiencyData.summary.due,
    overdue: efficiencyData.summary.due_overdue,
    pending: stats.pending,
    completionRate:
      efficiencyData.summary.completion_rate == null
        ? null
        : efficiencyData.summary.completion_rate * 100,
    ...(efficiencyStale ? { stale: true } : {}),
  };
  for (const listener of efficiencyListeners) listener();
}

function clearEfficiencyTimer() {
  if (efficiencyTimer !== null) {
    clearTimeout(efficiencyTimer);
    efficiencyTimer = null;
  }
}

/** 合并刷新：连续变化覆盖同一个定时器；无订阅者时不排队任何工作。 */
function scheduleEfficiencyRefresh(delay = EFFICIENCY_DEBOUNCE_MS) {
  if (efficiencyListeners.size === 0) return;
  clearEfficiencyTimer();
  efficiencyTimer = setTimeout(() => {
    efficiencyTimer = null;
    if (efficiencyListeners.size === 0) return;
    void runEfficiencyQuery();
  }, delay);
}

function attachEfficiencyStoreListener() {
  if (efficiencyStoreUnsub) return;
  efficiencyStoreUnsub = useTasksStore.subscribe((state, prev) => {
    if (state.stats === prev.stats) return;
    // 任务数据实际变化：旧统计立即失效；pending 先用新 stats 展示，
    // 完成/到期/逾期等待下一次查询替换（查询失败时才标记 stale）。
    efficiencyRevision += 1;
    if (efficiencyData) publishEfficiency();
    scheduleEfficiencyRefresh();
  });
}

function detachEfficiencyStoreListener() {
  efficiencyStoreUnsub?.();
  efficiencyStoreUnsub = null;
}

/** 同一时刻只允许一个在途查询；期间的新变化由调用结束后的补查覆盖。 */
function runEfficiencyQuery(): Promise<void> {
  if (efficiencyInFlight) return efficiencyInFlight;
  const epoch = efficiencyEpoch;
  const startRevision = efficiencyRevision;
  const startStats = useTasksStore.getState().stats;
  const request = fetchTaskAnalytics("day")
    .then((data) => {
      if (epoch !== efficiencyEpoch) return;
      const currentStats = useTasksStore.getState().stats;
      if (startRevision !== efficiencyRevision || startStats !== currentStats) {
        // 查询期间任务又变了：结果已过期，不写入缓存；finally 中补查。
        return;
      }
      efficiencyData = data;
      efficiencyStats = startStats;
      efficiencyStale = false;
      publishEfficiency();
    })
    .catch(() => {
      if (epoch !== efficiencyEpoch) return;
      if (efficiencyData) {
        // 保留旧数据（不清零、不伪造），只叠加过期标记；重试入口由微件提供。
        efficiencyStale = true;
        publishEfficiency();
      }
      // 从未成功：保持 null → 微件显示「等待统计模块数据」，不显示假 0。
    })
    .finally(() => {
      if (efficiencyInFlight === request) efficiencyInFlight = null;
      if (epoch !== efficiencyEpoch) return;
      const currentStats = useTasksStore.getState().stats;
      const changedDuringFlight =
        startRevision !== efficiencyRevision || startStats !== currentStats;
      if (changedDuringFlight && efficiencyListeners.size > 0 && efficiencyTimer === null) {
        // 在途期间有新变化：本次结束（成功但已过期或失败）后必须再查一次。
        scheduleEfficiencyRefresh(0);
      }
    });
  efficiencyInFlight = request;
  return request;
}

const efficiencySource: EfficiencySource = {
  getSnapshot: () => efficiencySnapshot,
  subscribe: (onChange) => {
    efficiencyListeners.add(onChange);
    if (efficiencyListeners.size === 1) attachEfficiencyStoreListener();

    const stats = useTasksStore.getState().stats;
    // 缓存有效 = 统计已成功过，且生成它时的 stats 引用仍是当前引用（没有任务写入），
    // 也没有处于失败待重试状态。StrictMode 的「卸载-重挂载」会命中有效缓存，不重复查询。
    const cacheValid = efficiencyData !== null && efficiencyStats === stats && !efficiencyStale;
    if (!cacheValid) {
      // 有旧数据时先用「旧统计 + 最新 pending」渲染，随后刷新替换；
      // 无旧数据时保持等待接入。
      if (efficiencyData) publishEfficiency();
      scheduleEfficiencyRefresh(efficiencyData ? EFFICIENCY_DEBOUNCE_MS : 0);
    }

    return () => {
      efficiencyListeners.delete(onChange);
      if (efficiencyListeners.size === 0) {
        clearEfficiencyTimer();
        detachEfficiencyStoreListener();
      }
    };
  },
  retry: () => {
    if (efficiencyListeners.size === 0) return;
    clearEfficiencyTimer();
    void runEfficiencyQuery();
  },
};

/** 仅供测试：清空模块级缓存、订阅、定时器与在途代际。 */
export function __resetEfficiencySourceForTests() {
  efficiencyEpoch += 1;
  efficiencyListeners.clear();
  clearEfficiencyTimer();
  detachEfficiencyStoreListener();
  efficiencyData = null;
  efficiencySnapshot = null;
  efficiencyStats = null;
  efficiencyStale = false;
  efficiencyRevision = 0;
  efficiencyInFlight = null;
}

/** 微件面板的数据源（模块级常量：引用稳定，避免重复订阅）。 */
export const WIDGET_SOURCES: WidgetSources = {
  focus: focusSource,
  efficiency: efficiencySource,
};
