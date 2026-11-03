//! 规划中心四视图共用的小型展示件：项目选择器、进度条、功能状态徽标。
//! 颜色只做辅助，所有状态徽标同时带文本，不作为唯一识别依据。

import { Select } from "../ui";
import {
  PLANNING_FEATURE_STATUS_LABELS,
  type PlanningFeatureStatus,
  type PlanningProject,
} from "../../lib/bridge";

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

export function PlanningFeatureStatusBadge({ status }: { status: PlanningFeatureStatus }) {
  return (
    <span className={`planning-status-badge st-${status}`}>
      {PLANNING_FEATURE_STATUS_LABELS[status]}
    </span>
  );
}

export function PlanningProjectPicker({
  projects,
  activeProjectId,
  onChange,
}: {
  projects: PlanningProject[];
  activeProjectId: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div className="planning-project-picker">
      <Select
        value={activeProjectId ?? ""}
        ariaLabel="选择项目"
        block
        menuMinWidth={220}
        options={projects.map((p) => ({
          value: p.id,
          label: p.archived ? `${p.name}（已归档）` : p.name,
        }))}
        onChange={onChange}
      />
    </div>
  );
}
