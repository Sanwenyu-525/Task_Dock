//! 规划中心四视图共用的小型展示件：进度条、功能状态徽标。
//! 颜色只做辅助，所有状态徽标同时带文本，不作为唯一识别依据。
//! （ADR-0010：原 PlanningProjectPicker 已移除——计划列表不得冒充项目选择器。）

import { StatusBadge, type StatusTone } from "../ui";
import {
  PLANNING_FEATURE_STATUS_LABELS,
  type PlanningFeatureStatus,
} from "../../lib/bridge";

/** 内容区的滚动容器（页面级单一滚动）：向上找第一个 overflow-y 可滚动的祖先。 */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return null;
}

export function PlanningProgressBar({
  value,
  large = false,
}: {
  value: number;
  large?: boolean;
}) {
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className={`planning-meter ${large ? "is-large" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={safe}
    >
      <span className="planning-meter-fill" style={{ width: `${safe}%` }} />
    </div>
  );
}

/** 规划功能状态 → 语义色；文案映射仍由 PLANNING_FEATURE_STATUS_LABELS 负责。 */
export const PLANNING_STATUS_TONE: Record<PlanningFeatureStatus, StatusTone> = {
  planned: "neutral",
  in_progress: "warning",
  review: "info",
  completed: "success",
  blocked: "danger",
  paused: "neutral",
};

export function PlanningFeatureStatusBadge({ status }: { status: PlanningFeatureStatus }) {
  return (
    <StatusBadge tone={PLANNING_STATUS_TONE[status]} size="sm">
      {PLANNING_FEATURE_STATUS_LABELS[status]}
    </StatusBadge>
  );
}
