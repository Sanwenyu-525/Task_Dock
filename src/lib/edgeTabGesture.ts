//! Edge Tab 手势判定（纯函数，可单测）。
//!
//! 标签很小，点击与拖动必须在**松手时**一次性判定，避免拖动结束又触发恢复：
//! - 位移小于 `TAB_CLICK_SLOP_CSS` → 点击（恢复胶囊）；
//! - 向屏幕内部（法向）拖动达到 `TAB_RESTORE_DRAG_CSS` 且方向占优 → 恢复胶囊；
//! - 其余位移 → 纯沿边拖动（只改垂直/水平位置，不切形态）。

import {
  TAB_CLICK_SLOP_CSS,
  TAB_RESTORE_DRAG_CSS,
  isVerticalEdge,
} from "./capsuleLayout";
import type { SnapEdge } from "./edgeSnap";

export type TabGestureKind = "click" | "drag" | "restore";

/** 法向位移中「指向屏幕内部」的分量（CSS px；左停靠向右为正，其余镜像）。 */
export function tabInwardDelta(edge: SnapEdge, dx: number, dy: number): number {
  switch (edge) {
    case "left":
      return dx;
    case "right":
      return -dx;
    case "top":
      return dy;
    default:
      return -dy;
  }
}

/**
 * 沿边（与停靠边平行）方向的**带符号**位移（CSS px）。
 * 符号与窗口坐标同向（下/右为正），拖动时直接传给 `dragTabBy`。
 */
export function tabAlongDelta(edge: SnapEdge, dx: number, dy: number): number {
  return isVerticalEdge(edge) ? dy : dx;
}

export function classifyTabGesture(edge: SnapEdge, dx: number, dy: number): TabGestureKind {
  if (Math.hypot(dx, dy) < TAB_CLICK_SLOP_CSS) return "click";
  const inward = tabInwardDelta(edge, dx, dy);
  const along = Math.abs(tabAlongDelta(edge, dx, dy));
  // 方向阈值：必须明显向内，且向内位移不被沿边拖动主导。
  if (inward >= TAB_RESTORE_DRAG_CSS && inward >= along) return "restore";
  return "drag";
}
