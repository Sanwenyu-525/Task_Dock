//! 工作流运行历史（主内容区页内二级视图，不再使用 Dialog）。
//!
//! 分页、逐步骤展开与失败原因保留；请求用本地代际防止旧响应覆盖新展开目标，
//! 数据只在当前工作流页展示，离开视图即清理，避免上次历史串页。

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  workflowRunDetail,
  WORKFLOW_STEP_STATUS_LABELS,
  WORKFLOW_STEP_TYPE_LABELS,
  type Workflow,
  type WorkflowRunStepStatus,
} from "../../lib/bridge";
import { errText, useWorkflowsStore } from "../../store/useWorkflowsStore";
import { runStatusKind, WORKFLOW_RUN_STATUS_LABELS } from "./display";

const PAGE_SIZE = 20;

const STEP_KIND: Record<WorkflowRunStepStatus, string> = {
  pending: "muted",
  running: "running",
  succeeded: "success",
  skipped: "muted",
  failed: "danger",
  cancelled: "muted",
};

export default function WorkflowHistoryView({
  workflow,
  onBack,
}: {
  workflow: Workflow;
  onBack: () => void;
}) {
  const history = useWorkflowsStore((s) => s.history);
  const loadHistoryPage = useWorkflowsStore((s) => s.loadHistoryPage);
  const clearHistory = useWorkflowsStore((s) => s.clearHistory);

  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandLoading, setExpandLoading] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Awaited<ReturnType<typeof workflowRunDetail>>["steps"]>([]);
  /** 快速连续展开/收起时，旧请求不得覆盖新目标。 */
  const expandSeq = useRef(0);

  useEffect(() => {
    setExpandedRun(null);
    setExpandedSteps([]);
    void loadHistoryPage(workflow.id, 0);
    return () => clearHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.id]);

  // 仅展示本工作流的数据：store 是全局单槽，快速切换工作流时不串页。
  const page = history.workflowId === workflow.id ? history.page : null;
  const offset = page?.offset ?? 0;
  const total = page?.total ?? 0;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  /** 翻页时先收起上一页的逐步骤回执，避免错行展示。 */
  const goPage = (next: number) => {
    expandSeq.current += 1;
    setExpandedRun(null);
    setExpandedSteps([]);
    setExpandLoading(false);
    void loadHistoryPage(workflow.id, next);
  };

  const toggleRun = async (runId: string) => {
    if (expandedRun === runId) {
      expandSeq.current += 1;
      setExpandedRun(null);
      setExpandLoading(false);
      return;
    }
    const seq = ++expandSeq.current;
    setExpandedRun(runId);
    setExpandedSteps([]);
    setExpandLoading(true);
    setExpandError(null);
    try {
      const detail = await workflowRunDetail(runId);
      if (seq !== expandSeq.current) return;
      setExpandedSteps(detail.steps);
    } catch (e) {
      if (seq !== expandSeq.current) return;
      setExpandError(errText(e));
    } finally {
      if (seq === expandSeq.current) setExpandLoading(false);
    }
  };

  return (
    <div className="wf-subpage" role="region" aria-label={`运行历史：${workflow.name}`}>
      <header className="wf-subpage-head">
        <button type="button" className="btn sm" onClick={onBack} aria-label="返回工作流列表">
          <ArrowLeft size={13} aria-hidden="true" /> 返回列表
        </button>
        <h2 className="wf-subpage-title">运行历史：{workflow.name}</h2>
      </header>

      {history.loading && !page ? (
        <p className="wf-empty-steps">
          <Loader2 size={13} className="spin" aria-hidden="true" /> 加载中…
        </p>
      ) : null}
      {history.error ? (
        <p className="wf-error-text" role="alert">
          {history.error}
          <button
            type="button"
            className="btn sm"
            onClick={() => goPage(offset)}
          >
            重试
          </button>
        </p>
      ) : null}
      {page && page.items.length === 0 ? <p className="wf-empty-steps">还没有运行记录。</p> : null}
      {page ? (
        <ul className="wf-history-list">
          {page.items.map((r) => (
            <li key={r.id} className="wf-history-item">
              <button
                type="button"
                className="wf-history-head"
                onClick={() => void toggleRun(r.id)}
                aria-expanded={expandedRun === r.id}
                data-tip="展开逐步骤结果"
              >
                <span className={`wf-run-state kind-${runStatusKind(r.status)}`}>
                  {WORKFLOW_RUN_STATUS_LABELS[r.status]}
                </span>
                <span className="wf-history-time">{r.started_at}</span>
                <span className="wf-run-count">
                  {r.completed_steps}/{r.total_steps} 步
                </span>
                <ChevronDown
                  size={13}
                  aria-hidden="true"
                  className={expandedRun === r.id ? "is-open" : ""}
                />
              </button>
              {r.error ? <p className="wf-history-error">{r.error}</p> : null}
              {expandedRun === r.id ? (
                <div className="wf-history-detail">
                  {expandLoading ? (
                    <p className="wf-empty-steps">
                      <Loader2 size={13} className="spin" aria-hidden="true" /> 加载回执…
                    </p>
                  ) : null}
                  {expandError ? <p className="wf-error-text">{expandError}</p> : null}
                  <ol className="wf-steps">
                    {expandedSteps.map((rs, i) => (
                      <li key={rs.id} className={`wf-step kind-${STEP_KIND[rs.status]}`}>
                        <div className="wf-step-row">
                          <span className="wf-step-index">{i + 1}</span>
                          <span className="wf-step-main">
                            <span className="wf-step-type">{WORKFLOW_STEP_TYPE_LABELS[rs.step_type]}</span>
                            <span className="wf-step-summary">{rs.detail}</span>
                          </span>
                          <span className={`wf-step-status kind-${STEP_KIND[rs.status]}`}>
                            {WORKFLOW_STEP_STATUS_LABELS[rs.status]}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="wf-history-pager">
        <span className="wf-hint-text">
          共 {total} 条（库内每个工作流最多保留 50 条运行记录）
        </span>
        <button
          type="button"
          className="btn"
          disabled={!canPrev || history.loading}
          onClick={() => goPage(Math.max(0, offset - PAGE_SIZE))}
        >
          <ChevronLeft size={13} aria-hidden="true" /> 上一页
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canNext || history.loading}
          onClick={() => goPage(offset + PAGE_SIZE)}
        >
          下一页 <ChevronRight size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
