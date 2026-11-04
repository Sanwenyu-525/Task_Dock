//! A（专注计时）/ C（效率统计）尚未落地的依赖契约。
//!
//! 只定义数据结构与订阅接口：模块未接入时微件显示「等待接入」，
//! 绝不伪造倒计时或统计数字，也不在本模块复制 A/C 的查询与 SQL 逻辑。
//! 接入方式见 tmp/acceptance/desktop-widgets/integration.md。

export interface WidgetSource<T> {
  /** 必须返回稳定引用（缓存快照），供 useSyncExternalStore 比较；无数据可为 null。 */
  getSnapshot: () => T | null;
  subscribe: (onChange: () => void) => () => void;
}

/**
 * 把「原始快照 + 派生映射」包装成契约数据源。
 *
 * `getSnapshot` 只在原始引用变化时重新执行 `map` 并缓存结果，因此映射函数里
 * **可以**创建新对象而不会触发 useSyncExternalStore 的无限重渲染；前提是
 * `getRaw` 在数据未变时返回稳定引用（zustand store 的快照字段天然满足）。
 *
 * 典型用法（专注计时）：
 * ```ts
 * const focusSource = createMappedWidgetSource(
 *   () => useFocusStore.getState().snapshot,
 *   (onChange) => useFocusStore.subscribe(onChange),
 *   (raw) => mapFocusSnapshot(raw, useFocusStore.getState().snapshotAt),
 * );
 * ```
 */
export function createMappedWidgetSource<Raw, T>(
  getRaw: () => Raw | null,
  subscribe: (onChange: () => void) => () => void,
  map: (raw: Raw | null) => T | null,
): WidgetSource<T> {
  let seeded = false;
  let lastRaw: Raw | null = null;
  let lastValue: T | null = null;

  return {
    subscribe,
    getSnapshot() {
      const raw = getRaw();
      if (!seeded || raw !== lastRaw) {
        seeded = true;
        lastRaw = raw;
        lastValue = map(raw);
      }
      return lastValue;
    },
  };
}

export type FocusPhase = "idle" | "focus" | "break" | "paused";

export interface FocusSnapshot {
  phase: FocusPhase;
  /** 当前阶段文案（如「专注」「休息」），由专注模块提供。 */
  label: string;
  /**
   * 本轮结束的绝对时间（ISO 8601）。进行中必须提供；
   * idle / paused / 无结束时间时为 null，此时微件不显示倒计时。
   */
  endsAt: string | null;
  cycle?: { index: number; total: number };
}

export type FocusSource = WidgetSource<FocusSnapshot>;

export interface EfficiencySnapshot {
  completedToday: number;
  dueToday: number;
  overdue: number;
  pending: number;
  /** 完成率 0~100，无法计算时为 null。 */
  completionRate: number | null;
}

export type EfficiencySource = WidgetSource<EfficiencySnapshot>;

export interface WidgetSources {
  focus?: FocusSource;
  efficiency?: EfficiencySource;
}
