//! 一键工作流面板：工作流卡片列表 + 新建/模板入口 + 编辑/运行/历史对话框。
//!
//! 事件订阅：面板挂载期间订阅 `workflow-run-progress`（订阅引用计数遵循
//! createSubscriptionScope 模式，卸载即释放）；面板隐藏时运行照常进行，
//! 重新挂载用 refreshActive() 按需查询，不做轮询。

import { useEffect, useRef, useState } from "react";
import {
  Copy,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  workflowGet,
  WORKFLOW_RUN_STATUS_LABELS,
  type Workflow,
  type WorkflowDetail,
} from "../../lib/bridge";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { onWorkflowRunProgress } from "../../lib/bridge";
import { useWorkflowsStore } from "../../store/useWorkflowsStore";
import { errorMessage } from "../../lib/errors";
import { ConfirmDialog } from "../ui";
import { runStatusKind } from "./display";
import { WORKFLOW_TEMPLATES } from "./templates";
import WorkflowEditorView from "./WorkflowEditorView";
import WorkflowRunDialog from "./WorkflowRunDialog";
import WorkflowHistoryDialog from "./WorkflowHistoryDialog";

/** 内容区的滚动容器（页面级单一滚动）：向上找第一个 overflow-y 可滚动的祖先。 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return null;
}

export default function WorkflowsPanel() {
  const workflows = useWorkflowsStore((s) => s.workflows);
  const workflowsLoading = useWorkflowsStore((s) => s.workflowsLoading);
  const workflowsError = useWorkflowsStore((s) => s.workflowsError);
  const loadWorkflows = useWorkflowsStore((s) => s.loadWorkflows);
  const refreshActive = useWorkflowsStore((s) => s.refreshActive);
  const activeRun = useWorkflowsStore((s) => s.activeRun);
  const activeRunDetail = useWorkflowsStore((s) => s.activeRunDetail);
  const activeError = useWorkflowsStore((s) => s.activeError);
  const lastRuns = useWorkflowsStore((s) => s.lastRuns);
  const loadLastRun = useWorkflowsStore((s) => s.loadLastRun);
  const applyProgress = useWorkflowsStore((s) => s.applyProgress);
  const deleteWorkflow = useWorkflowsStore((s) => s.deleteWorkflow);
  const duplicateWorkflow = useWorkflowsStore((s) => s.duplicateWorkflow);
  const updateWorkflow = useWorkflowsStore((s) => s.updateWorkflow);
  const reorderWorkflows = useWorkflowsStore((s) => s.reorderWorkflows);

  /** null = 列表态；非空 = 页面内编辑态（不再使用 Dialog）。 */
  const [editing, setEditing] = useState<{
    workflow: WorkflowDetail | null;
    template: (typeof WORKFLOW_TEMPLATES)[number] | null;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 进入编辑前列表的滚动位置：返回时恢复，避免用户回到列表顶部。 */
  const listScrollTop = useRef(0);
  const [runTarget, setRunTarget] = useState<WorkflowDetail | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Workflow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // 挂载：拉取列表 + 活动运行概览；订阅进度事件（卸载即释放）
  useEffect(() => {
    const scope = createSubscriptionScope();
    scope.add(
      onWorkflowRunProgress((detail) => {
        applyProgress(detail);
        if (detail.finished_at) void loadLastRun(detail.workflow_id);
      }),
    );
    void loadWorkflows();
    void refreshActive();
    return () => scope.dispose();
  }, [applyProgress, loadLastRun, loadWorkflows, refreshActive]);

  // 列表加载后补齐各卡片的最近运行摘要
  useEffect(() => {
    if (!workflows) return;
    workflows.forEach((w) => void loadLastRun(w.id));
  }, [workflows, loadLastRun]);

  /** 进入编辑态前记住列表滚动位置；返回时一次性恢复（页面级单一滚动容器）。 */
  const rememberListScroll = () => {
    const sc = findScrollParent(rootRef.current);
    if (sc) listScrollTop.current = sc.scrollTop;
  };

  const closeEditor = () => {
    setEditing(null);
    requestAnimationFrame(() => {
      const sc = findScrollParent(rootRef.current);
      if (sc) sc.scrollTop = listScrollTop.current;
    });
  };

  const openEditor = async (wf: Workflow | null, template: (typeof WORKFLOW_TEMPLATES)[number] | null) => {
    setActionError(null);
    if (!wf) {
      rememberListScroll();
      setEditing({ workflow: null, template });
      return;
    }
    setBusyId(wf.id);
    try {
      const detail = await workflowGet(wf.id);
      rememberListScroll();
      setEditing({ workflow: detail, template: null });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  /** 保存成功：刷新列表并回到列表态（列表滚动位置由 closeEditor 恢复）。 */
  const handleSaved = () => {
    void loadWorkflows();
    closeEditor();
  };

  const openRun = async (wf: Workflow) => {
    setActionError(null);
    setBusyId(wf.id);
    try {
      setRunTarget(await workflowGet(wf.id));
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const guard = (id: string, fn: () => Promise<unknown>) => async () => {
    setActionError(null);
    setBusyId(id);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const move = (wf: Workflow, dir: -1 | 1) => {
    if (!workflows) return;
    const ids = workflows.map((w) => w.id);
    const idx = ids.indexOf(wf.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    void guard(wf.id, () => reorderWorkflows(ids))();
  };

  const activeWorkflowName = activeRun
    ? (workflows?.find((w) => w.id === activeRun.workflow_id)?.name ??
      activeRunDetail?.workflow_name ??
      "工作流")
    : null;

  return (
    <div ref={rootRef} className={`workflows-panel${editing ? " wf-editor-page" : ""}`}>
      {editing ? (
        <WorkflowEditorView
          workflow={editing.workflow}
          template={editing.template}
          onCancel={closeEditor}
          onSaved={handleSaved}
        />
      ) : (
        <>
      <header className="wf-head-row">
        <div>
          <h2 className="wf-title">工作流</h2>
          <p className="wf-subtitle">把常用操作编排为一次点击的固定顺序流程（白名单动作，无可执行脚本）。</p>
        </div>
        <div className="wf-head-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void openEditor(null, null)}
            data-tip="从空白创建工作流"
          >
            <Plus size={14} aria-hidden="true" /> 新建
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void openEditor(null, WORKFLOW_TEMPLATES[0])}
            data-tip="套用示例：打开 IDE / 项目 / 文档 / 建任务（目标需自行选择）"
          >
            <Sparkles size={14} aria-hidden="true" /> 开发模板
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void openEditor(null, WORKFLOW_TEMPLATES[1])}
            data-tip="套用示例：打开办公软件 / 文件 / 网页 / 建提醒（目标需自行选择）"
          >
            <Sparkles size={14} aria-hidden="true" /> 办公模板
          </button>
        </div>
      </header>

      {activeRun ? (
        <div className="wf-active-banner" role="status">
          <Loader2 size={13} className="spin" aria-hidden="true" />
          <span>
            正在执行「{activeWorkflowName}」
            {activeRun.paused ? "（已暂停）" : ""}
            {activeRun.cancel_requested ? "（取消中）" : ""}
            {activeRunDetail ? ` · ${activeRunDetail.completed_steps}/${activeRunDetail.total_steps} 步` : ""}
          </span>
        </div>
      ) : null}

      {activeError ? (
        // 状态查询失败 ≠ 已结束：保留旧进度并标记可能过期，给重试入口
        <p className="wf-error-text" role="status">
          运行状态同步失败，当前进度可能不是最新：{activeError}
          <button type="button" className="btn sm" onClick={() => void refreshActive()}>
            重试
          </button>
        </p>
      ) : null}

      {workflowsError ? (
        <div className="wf-error-block" role="alert">
          <p>{workflowsError}</p>
          <button type="button" className="btn" onClick={() => void loadWorkflows()}>
            重试
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p className="wf-error-text" role="alert">
          {actionError}
        </p>
      ) : null}

      {workflowsLoading && !workflows ? (
        <p className="wf-empty-steps">
          <Loader2 size={13} className="spin" aria-hidden="true" /> 加载中…
        </p>
      ) : null}

      {workflows && workflows.length === 0 ? (
        <div className="wf-empty">
          <p>还没有工作流。用「新建」从空白开始，或从开发 / 办公示例模板套用一份再修改。</p>
          <p className="wf-hint-text">模板里的应用、目录、网页目标必须由你选择，Task Dock 不会假设安装了特定软件。</p>
        </div>
      ) : null}

      {workflows && workflows.length > 0 ? (
        <div className="planning-cards wf-cards">
          {workflows.map((w, idx) => {
            const last = lastRuns[w.id];
            return (
              <article key={w.id} className={`task-card planning-card wf-card ${w.enabled ? "" : "is-disabled"}`}>
                <div className="wf-card-head">
                  <div className="wf-card-title-wrap">
                    <h3 className="planning-card-title">{w.name}</h3>
                    <p className="wf-card-desc">{w.description || "（无描述）"}</p>
                  </div>
                  <label className="wf-card-enabled" aria-label={w.enabled ? "停用工作流" : "启用工作流"}>
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      onChange={() =>
                        void guard(w.id, () => updateWorkflow(w.id, { enabled: !w.enabled }))()
                      }
                    />
                    <span aria-hidden="true">{w.enabled ? "已启用" : "已停用"}</span>
                  </label>
                </div>
                <div className="wf-card-meta">
                  <span data-tip="步骤总数">{w.step_count} 步</span>
                  {last ? (
                    <span className={`wf-run-state kind-${runStatusKind(last.status)}`}>
                      上次：{WORKFLOW_RUN_STATUS_LABELS[last.status]} · {last.started_at_local}
                    </span>
                  ) : (
                    <span>从未运行</span>
                  )}
                </div>
                <div className="wf-card-actions">
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={!w.enabled || Boolean(activeRun)}
                    onClick={() => void openRun(w)}
                    data-tip={
                      !w.enabled
                        ? "工作流已停用"
                        : activeRun
                          ? "已有工作流正在执行"
                          : "按顺序执行全部启用步骤"
                    }
                  >
                    <Play size={13} aria-hidden="true" /> 运行
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={`编辑 ${w.name}`}
                    data-tip="编辑名称与步骤"
                    onClick={() => void openEditor(w, null)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={`${w.name} 运行历史`}
                    data-tip="运行历史"
                    onClick={() => setHistoryTarget(w)}
                  >
                    <History size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={`复制 ${w.name}`}
                    data-tip="创建副本"
                    onClick={() =>
                      void guard(w.id, async () => {
                        await duplicateWorkflow(w.id);
                      })()
                    }
                  >
                    <Copy size={14} aria-hidden="true" />
                  </button>
                  <span className="wf-card-spacer" />
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={`上移 ${w.name}`}
                    data-tip="上移"
                    disabled={idx === 0}
                    onClick={() => move(w, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={`下移 ${w.name}`}
                    data-tip="下移"
                    disabled={idx === workflows.length - 1}
                    onClick={() => move(w, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={`删除 ${w.name}`}
                    data-tip="删除工作流及其运行记录"
                    onClick={() => setDeleteTarget(w)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {busyId === w.id ? (
                  <span className="wf-card-busy" aria-hidden="true">
                    <Loader2 size={12} className="spin" />
                  </span>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

        </>
      )}
      <WorkflowRunDialog
        open={runTarget !== null}
        onClose={() => setRunTarget(null)}
        workflow={runTarget}
      />
      <WorkflowHistoryDialog
        open={historyTarget !== null}
        onClose={() => setHistoryTarget(null)}
        workflow={historyTarget}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除工作流？"
        detail={`「${deleteTarget?.name ?? ""}」的定义、步骤与运行历史将被删除，且不可恢复。`}
        confirmLabel="删除"
        danger
        busy={false}
        onConfirm={() => {
          const t = deleteTarget;
          setDeleteTarget(null);
          if (t) void guard(t.id, () => deleteWorkflow(t.id))();
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
