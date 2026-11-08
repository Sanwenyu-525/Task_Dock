//! 工作流展示辅助：步骤参数摘要、状态样式 kind（纯函数，便于测试）。

import {
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStepType,
} from "../../lib/bridge";

export { WORKFLOW_STEP_TYPE_LABELS, WORKFLOW_RUN_STATUS_LABELS, WORKFLOW_STEP_STATUS_LABELS } from "../../lib/bridge";

/** 步骤参数一行摘要（无目标详情时给出可读兜底文案）。 */
export function stepParamsSummary(
  step: Pick<WorkflowStep, "step_type" | "params">,
  targetName?: (id: string) => string | undefined,
): string {
  const p = step.params;
  switch (step.step_type) {
    case "open_app":
    case "open_url":
    case "open_path": {
      if (!p.target_id) return "（待选择目标）";
      const name = targetName?.(p.target_id);
      return name ?? `目标 ${p.target_id}`;
    }
    case "create_task": {
      const title = p.title?.trim() || "（未命名任务）";
      return p.remind_at ? `${title} · 提醒已设置` : title;
    }
    case "restore_workspace": {
      if (!p.snapshot_id) return "（待选择快照）";
      return `快照 ${p.snapshot_id}`;
    }
    case "enter_scene":
      // 运行视图未加载场景列表，直接展示 id；运行回执的 summary 带场景名。
      return p.scene_id ? `场景 ${p.scene_id}` : "（待选择场景）";
  }
}

/** 运行状态 → CSS kind（语义 Token 类名，颜色全部走 var(--status-*)）。 */
export function runStatusKind(status: WorkflowRunStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "completed":
      return "success";
    case "failed":
    case "interrupted":
      return "danger";
    case "cancelled":
      return "muted";
  }
}

/** 步骤类型是否依赖场景工作区。 */
export function isSceneDependent(t: WorkflowStepType): boolean {
  return t === "enter_scene";
}
