//! 工作流运行对话框：运行确认 → 执行进度 → 逐步骤结果。
//!
//! 进度来自 store（面板订阅 `workflow-run-progress` 事件推送后写入）；
//! 打开对话框时若该工作流正在执行，直接显示进度。关闭对话框不影响后台执行，
//! 重新打开可回到进度视图（活动运行在 store.refreshActive 中按需查询）。

import { useEffect, useState } from "react";
import { Loader2, Pause, Play, Square } from "lucide-react";
import {
  WORKFLOW_RUN_STATUS_LABELS,
  WORKFLOW_STEP_STATUS_LABELS,
  WORKFLOW_STEP_TYPE_LABELS,
  stepParamsSummary,
} from "./display";
import type { WorkflowDetail, WorkflowRunStepStatus } from "../../lib/bridge";
import { Dialog } from "../ui";
import { useWorkflowsStore, errText } from "../../store/useWorkflowsStore";

const STEP_STATUS_KIND: Record<WorkflowRunStepStatus, string> = {
  pending: "muted",
  running: "running",
  succeeded: "success",
  skipped: "muted",
  failed: "danger",
  cancelled: "muted",
};

export default function WorkflowRunDialog({
  open,
  onClose,
  workflow,
}: {
  open: boolean;
  onClose: () => void;
  workflow: WorkflowDetail | null;
}) {
  const activeRun = useWorkflowsStore((s) => s.activeRun);
  const activeRunDetail = useWorkflowsStore((s) => s.activeRunDetail);
  const runWorkflow = useWorkflowsStore((s) => s.runWorkflow);
  const pauseWorkflow = useWorkflowsStore((s) => s.pauseWorkflow);
  const resumeWorkflow = useWorkflowsStore((s) => s.resumeWorkflow);
  const cancelWorkflow = useWorkflowsStore((s) => s.cancelWorkflow);

  const [startError, setStartError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStartError(null);
      setControlError(null);
    }
  }, [open]);

  if (!workflow) return null;

  const isThisActive = Boolean(activeRun && activeRun.workflow_id === workflow.id);
  const detail = isThisActive ? activeRunDetail : null;
  const running = Boolean(detail && detail.finished_at === null);
  const paused = Boolean(activeRun?.paused && isThisActive);
  const finished = Boolean(detail && detail.finished_at !== null);
  const conflict = Boolean(activeRun && activeRun.workflow_id !== workflow.id);

  const enabledSteps = workflow.steps.filter((s) => s.enabled);
  const total = detail?.total_steps ?? enabledSteps.length;
  const completed = detail?.completed_steps ?? 0;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setStartError(null);
    try {
      await runWorkflow(workflow.id);
    } catch (e) {
      setStartError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const guard = (fn: () => Promise<void>) => () => {
    setControlError(null);
    fn().catch((e) => setControlError(errText(e)));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={running ? `运行：${workflow.name}` : `工作流：${workflow.name}`}
      ariaLabel={running ? `运行：${workflow.name}` : `工作流：${workflow.name}`}
      footer={
        <>
          {running ? (
            <>
              {paused ? (
                <button type="button" className="btn" onClick={guard(() => resumeWorkflow(workflow.id))}>
                  <Play size={13} aria-hidden="true" /> 继续
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={guard(() => pauseWorkflow(workflow.id))}
                  data-tip="当前步骤完成后暂停（运行中的步骤不可中断）"
                >
                  <Pause size={13} aria-hidden="true" /> 暂停
                </button>
              )}
              <button
                type="button"
                className="btn danger"
                onClick={guard(() => cancelWorkflow(workflow.id))}
                data-tip="不再开始后续步骤；已启动的动作不会撤销"
              >
                <Square size={12} aria-hidden="true" /> 取消运行
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={start}
              disabled={busy || conflict}
              data-autofocus
            >
              {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
              <Play size={13} aria-hidden="true" /> 运行
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {running ? "后台执行，关闭" : "关闭"}
          </button>
        </>
      }
    >
      {!isThisActive && !finished ? (
        <div className="wf-run-confirm">
          <p className="wf-run-note">
            将按顺序执行 {enabledSteps.length} 个启用步骤。运行中的单个步骤不可中断；
            已启动的应用与已创建的任务不会因取消或失败而自动撤销。
          </p>
          {conflict ? (
            <p className="wf-error-text" role="alert">
              已有其他工作流正在执行，同一时刻只能运行一个工作流。
            </p>
          ) : null}
          {startError ? (
            <p className="wf-error-text" role="alert">
              {startError}
            </p>
          ) : null}
          <ol className="wf-steps" aria-label="将要执行的步骤">
            {workflow.steps.map((s, i) => (
              <li key={s.id} className={`wf-step ${s.enabled ? "" : "is-disabled"}`}>
                <div className="wf-step-row">
                  <span className="wf-step-index">{i + 1}</span>
                  <span className="wf-step-main">
                    <span className="wf-step-type">{WORKFLOW_STEP_TYPE_LABELS[s.step_type]}</span>
                    <span className="wf-step-summary">{stepParamsSummary(s)}</span>
                  </span>
                  {!s.enabled ? <span className="wf-step-status kind-muted">已停用</span> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {detail ? (
        <div className="wf-run-progress" aria-live="polite">
          <div className="wf-run-meta">
            <span className={`wf-run-state kind-${detail.status}`}>
              {running && !paused ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
              {WORKFLOW_RUN_STATUS_LABELS[detail.status]}
            </span>
            <span className="wf-run-count">
              {completed}/{total} 步
            </span>
            {paused ? <span className="wf-run-paused-hint">已暂停（等待继续）</span> : null}
          </div>
          {detail.error ? (
            <p className="wf-error-text" role="alert">
              {detail.error}
            </p>
          ) : null}
          {controlError ? (
            <p className="wf-error-text" role="alert">
              {controlError}
            </p>
          ) : null}
          <ol className="wf-steps" aria-label="执行结果">
            {detail.steps.map((rs, i) => (
              <li key={rs.id} className={`wf-step kind-${STEP_STATUS_KIND[rs.status]}`}>
                <div className="wf-step-row">
                  <span className="wf-step-index">{i + 1}</span>
                  <span className="wf-step-main">
                    <span className="wf-step-type">{WORKFLOW_STEP_TYPE_LABELS[rs.step_type]}</span>
                    <span className="wf-step-summary">
                      {rs.detail ||
                        (rs.status === "running" ? "执行中…" : rs.status === "pending" ? "待执行" : "")}
                    </span>
                  </span>
                  <span className={`wf-step-status kind-${STEP_STATUS_KIND[rs.status]}`}>
                    {WORKFLOW_STEP_STATUS_LABELS[rs.status]}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          {finished ? <p className="wf-hint-text">运行已结束；详情保留在「历史」中。</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
