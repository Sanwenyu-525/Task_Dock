//! 导航排序的几何计算：拖拽落点、让位位移、边缘自动滚动速度。
//!
//! 本文件只做纯计算（输入测量快照，输出数值），不访问 DOM、不持状态：
//! - 组件在拖拽开始时测量一次行矩形，之后每帧只做算术，避免边拖边读布局；
//! - 顺序变更本身仍由 `navVisibility.ts` 的 `moveEntryToIndex` 决定，
//!   这里只回答「拖到哪个索引」与「其它行让开多少像素」。
//!
//! 坐标系约定：所有 `top` 均为**列表内容坐标**（相对滚动容器内容顶部，
//! 已包含 scrollTop），因此拖拽中自动滚动不会让计算失准。

/** 一行在拖拽开始时的测量快照（内容坐标，单位 px）。 */
export interface NavReorderSlot {
  id: string;
  top: number;
  height: number;
}

/** 没有可推导间隙时的兜底行距（与 `.nav-visibility-list` 的 gap 一致）。 */
export const NAV_REORDER_DEFAULT_GAP = 2;

/** 边缘自动滚动触发带宽度（px）。 */
export const NAV_AUTOSCROLL_EDGE = 36;

/** 边缘自动滚动最大速度（px/帧）。 */
export const NAV_AUTOSCROLL_MAX = 14;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 相邻行的平均间隙：用真实测量推导，兼容主题行高与 WebView 缩放。 */
export function slotGap(slots: readonly NavReorderSlot[]): number {
  if (slots.length < 2) return NAV_REORDER_DEFAULT_GAP;
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < slots.length; i += 1) {
    const previous = slots[i - 1];
    const distance = slots[i].top - (previous.top + previous.height);
    if (distance < gap) gap = distance;
  }
  return Number.isFinite(gap) && gap >= 0 ? gap : NAV_REORDER_DEFAULT_GAP;
}

/**
 * 指针落点 → 目标插入索引（**已去掉被拖行**的数组下标）。
 *
 * 逐行比较中心线：指针越过某行中心即排到它之后。行按 top 升序，
 * 因此可以在第一行未越过时提前结束。返回值可直接交给
 * `moveEntryToIndex`，由它处理固定入口的钳制。
 */
export function dropIndexForPoint(
  slots: readonly NavReorderSlot[],
  movingId: string,
  pointerContentY: number,
): number {
  let index = 0;
  for (const slot of slots) {
    if (slot.id === movingId) continue;
    if (pointerContentY >= slot.top + slot.height / 2) index += 1;
    else break;
  }
  return index;
}

/**
 * 其它行的让位位移（id → translateY 像素）。
 *
 * - 被拖行自身不产生位移（由组件直接跟随指针）；
 * - 固定入口（锁定设置 / 胶囊 Agent 状态球）不参与让位，避免视觉上暗示可移动；
 * - 位移量取被拖行的高度 + 行距：与真实占位一致，松手后落位不跳动。
 */
export function reorderShifts(
  slots: readonly NavReorderSlot[],
  movingId: string,
  finalIndex: number,
  isFixed: (id: string) => boolean = () => false,
): Map<string, number> {
  const shifts = new Map<string, number>();
  const from = slots.findIndex((slot) => slot.id === movingId);
  if (from < 0 || finalIndex === from) return shifts;
  const step = slots[from].height + slotGap(slots);
  if (step <= 0) return shifts;
  const down = finalIndex > from;
  slots.forEach((slot, index) => {
    if (index === from || isFixed(slot.id)) return;
    if (down && index > from && index <= finalIndex) shifts.set(slot.id, -step);
    else if (!down && index >= finalIndex && index < from) shifts.set(slot.id, step);
  });
  return shifts;
}

/**
 * 边缘自动滚动速度（px/帧，正数向下）。
 *
 * 指针进入上/下 `edge` 像素区域后线性加速，离开即归零；
 * 超出容器时取最大速度，保证拖到面板外也不会「卡住不动」。
 */
export function autoScrollStep(
  pointerY: number,
  top: number,
  bottom: number,
  edge: number = NAV_AUTOSCROLL_EDGE,
  maxSpeed: number = NAV_AUTOSCROLL_MAX,
): number {
  if (!(bottom > top) || edge <= 0 || maxSpeed <= 0) return 0;
  if (pointerY < top + edge) {
    const ratio = clamp((top + edge - pointerY) / edge, 0, 1);
    return -Math.round(maxSpeed * ratio);
  }
  if (pointerY > bottom - edge) {
    const ratio = clamp((pointerY - (bottom - edge)) / edge, 0, 1);
    return Math.round(maxSpeed * ratio);
  }
  return 0;
}
