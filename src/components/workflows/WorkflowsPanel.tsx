//! 一键工作流面板：工作流卡片列表 + 新建/模板入口 + 页内编辑/运行/历史。
//!
//! 编辑、运行详情与历史都是同一内容区的子视图（不叠 Dialog）；返回列表恢复滚动位置。
//! 事件订阅：面板挂载期间订阅 `workflow-run-progress`（订阅引用计数遵循
//! createSubscriptionScope 模式，卸载即释放）；面板隐藏时运行照常进行，
//! 重新挂载用 refreshActive() 按需查询，不做轮询；子视图不重复订阅。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  History,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  workflowGet,
  WORKFLOW_STEP_TYPE_LABELS,
  WORKFLOW_RUN_STATUS_LABELS,
  type Workflow,
  type WorkflowDetail,
  type WorkflowLastRunSummary,
} from "../../lib/bridge";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { onWorkflowRunProgress } from "../../lib/bridge";
import { useWorkflowsStore } from "../../store/useWorkflowsStore";
import { errorMessage } from "../../lib/errors";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import { ConfirmDialog, DropdownMenu, EmptyState } from "../ui";
import { runStatusKind, stepParamsSummary } from "./display";
import { WORKFLOW_TEMPLATES } from "./templates";
import WorkflowEditorView from "./WorkflowEditorView";
import WorkflowRunView from "./WorkflowRunView";
import WorkflowHistoryView from "./WorkflowHistoryView";
import ScenarioWorkspaceView from "./ScenarioWorkspaceView";
import { useLocale } from "../../hooks/useLocale";
import "./workflows-page.css";

/** 运行步骤状态徽标；只用于当前执行卡的只读展示，不参与执行控制。 */
const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "待开始",
  running: "执行中",
  succeeded: "已完成",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已取消",
};

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
  const { t: tr } = useLocale();
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

  /** null = 列表态；非空 = 同一内容区的子视图（编辑 / 运行详情 / 历史）。 */
  type PanelPage =
    | { kind: "edit"; workflow: WorkflowDetail | null; template: (typeof WORKFLOW_TEMPLATES)[number] | null }
    | { kind: "run"; workflow: WorkflowDetail; runId: string | null }
    | { kind: "history"; workflow: Workflow }
    | { kind: "scenarios" };
  const [page, setPage] = useState<PanelPage | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 进入子视图前列表的滚动位置：返回时恢复，避免用户回到列表顶部。 */
  const listScrollTop = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 三栏工作区：左栏只负责选择，中栏负责真实步骤与操作，右栏负责执行与最近记录。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<WorkflowDetail | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const selectedRequest = useRef(0);

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

  const closePage = () => {
    setPage(null);
    requestAnimationFrame(() => {
      const sc = findScrollParent(rootRef.current);
      if (sc) sc.scrollTop = listScrollTop.current;
    });
  };

  const openEditor = async (wf: Workflow | null, template: (typeof WORKFLOW_TEMPLATES)[number] | null) => {
    setActionError(null);
    if (!wf) {
      rememberListScroll();
      setPage({ kind: "edit", workflow: null, template });
      return;
    }
    setBusyId(wf.id);
    try {
      const detail = await workflowGet(wf.id);
      rememberListScroll();
      setPage({ kind: "edit", workflow: detail, template: null });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  /** 保存成功：刷新列表并回到列表态（列表滚动位置由 closePage 恢复）。 */
  const handleSaved = () => {
    void loadWorkflows();
    closePage();
  };

  const openRun = async (wf: Workflow) => {
    setActionError(null);
    setBusyId(wf.id);
    try {
      const detail = await workflowGet(wf.id);
      rememberListScroll();
      const runId = activeRun?.workflow_id === wf.id ? activeRun.run_id : null;
      setPage({ kind: "run", workflow: detail, runId });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  /** 列表横幅「查看进度」：重新进入正在后台执行的工作流详情。 */
  const openActiveRun = async () => {
    if (!activeRun) return;
    setActionError(null);
    try {
      const detail = await workflowGet(activeRun.workflow_id);
      rememberListScroll();
      setPage({ kind: "run", workflow: detail, runId: activeRun.run_id });
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const openHistory = (wf: Workflow) => {
    setActionError(null);
    rememberListScroll();
    setPage({ kind: "history", workflow: wf });
  };

  const openScenarios = () => {
    setActionError(null);
    rememberListScroll();
    setPage({ kind: "scenarios" });
  };

  /**
   * 选择工作流只读取一次详情；不复制编辑器的步骤表单，也不在左栏塞操作按钮。
   * 请求序号用于防止快速点选时旧响应覆盖新选中项。
   */
  const selectWorkflow = useCallback(async (wf: Workflow) => {
    const seq = ++selectedRequest.current;
    setSelectedId(wf.id);
    setSelectedDetail(null);
    setSelectedLoading(true);
    setSelectedError(null);
    try {
      const detail = await workflowGet(wf.id);
      if (seq !== selectedRequest.current) return;
      setSelectedDetail(detail);
    } catch (e) {
      if (seq !== selectedRequest.current) return;
      setSelectedError(errorMessage(e));
    } finally {
      if (seq === selectedRequest.current) setSelectedLoading(false);
    }
  }, []);

  // 列表首次到达 / 删除当前项后自动选中第一项；选中项仍存在时不重复请求详情。
  useEffect(() => {
    if (!workflows?.length) {
      selectedRequest.current += 1;
      setSelectedId(null);
      setSelectedDetail(null);
      setSelectedError(null);
      return;
    }
    if (!selectedId || !workflows.some((w) => w.id === selectedId)) {
      void selectWorkflow(workflows[0]);
    }
  }, [workflows, selectedId, selectWorkflow]);

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

  // 统计行只用真实数据源：列表长度 / 启用数 / 全局活动运行槽；
  // 「今日完成」「等待处理」无后端聚合数据源，不显示该卡（不伪造数字）。
  const enabledCount = useMemo(
    () => workflows?.filter((w) => w.enabled).length ?? 0,
    [workflows],
  );

  /** 最近运行（lastRuns 真实摘要，按开始时间倒序取前 4 条）。 */
  const recentRuns = useMemo(() => {
    if (!workflows) return [];
    return workflows
      .map((wf) => {
        const run = lastRuns[wf.id];
        return run ? { wf, run } : null;
      })
      .filter((x): x is { wf: Workflow; run: WorkflowLastRunSummary } => x !== null)
      .sort((a, b) => b.run.started_at.localeCompare(a.run.started_at))
      .slice(0, 4);
  }, [workflows, lastRuns]);

  const activeTotal = activeRunDetail?.total_steps ?? 0;
  const activePct =
    activeTotal > 0 ? Math.round(((activeRunDetail?.completed_steps ?? 0) / activeTotal) * 100) : 0;

  const selectedSummary = workflows?.find((w) => w.id === selectedId) ?? null;
  const selectedIndex = selectedSummary
    ? (workflows?.findIndex((w) => w.id === selectedSummary.id) ?? -1)
    : -1;
  const selectedLast = selectedId ? lastRuns[selectedId] : undefined;
  const selectedDetailReady = Boolean(selectedSummary && selectedDetail?.id === selectedSummary.id);
  const selectedSteps = selectedDetailReady ? (selectedDetail?.steps ?? []) : [];
  const selectedBusy = selectedId ? busyId === selectedId : false;

  return (
    <div ref={rootRef} className={`workflows-panel page-fill ui-page-frame${page ? " wf-editor-page" : ""}`}>
      {page?.kind === "edit" ? (
        <WorkflowEditorView
          workflow={page.workflow}
          template={page.template}
          onCancel={closePage}
          onSaved={handleSaved}
        />
      ) : page?.kind === "run" ? (
        <WorkflowRunView
          workflow={page.workflow}
          runId={page.runId}
          onStarted={(runId) =>
            setPage((p) => (p?.kind === "run" ? { ...p, runId } : p))
          }
          onBack={closePage}
        />
      ) : page?.kind === "history" ? (
        <WorkflowHistoryView workflow={page.workflow} onBack={closePage} />
      ) : page?.kind === "scenarios" ? (
        <ScenarioWorkspaceView onBack={closePage} />
      ) : (
        <>
      {/* 页面级页头（2026-11-15 统一）：图标 + 标题 + 副标题，四个创建入口收进右侧动作区。 */}
      <WorkbenchPageHeader
        icon={WorkflowIcon}
        title={tr("workflows.title")}
        subtitle={tr("workflows.subtitle")}
        actions={
          <>
            <button type="button" className="btn" onClick={openScenarios} data-tip="管理可重复进入的场景">
              <Layers size={14} aria-hidden="true" /> 场景工作区
            </button>
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
          </>
        }
      />

      <div className="page-scroll wf-body">
        {/* 统计行（2026-11-14，对照效果图「4 统计卡一行」）：只用真实数据源——
            列表长度 / 启用数 / 全局单槽活动运行 / 最近运行条数；无来源的
            「今日完成」类数字不渲染。 */}
        {workflows ? (
          <div className="wf-stat-row">
            <span className="wf-stat-chip">
              工作流 <strong>{workflows.length}</strong>
            </span>
            <span className="wf-stat-chip">
              启用 <strong>{enabledCount}</strong>
            </span>
            <span className="wf-stat-chip">
              运行中 <strong>{activeRun ? 1 : 0}</strong>
            </span>
            <span className="wf-stat-chip">
              最近运行 <strong>{recentRuns.length}</strong>
            </span>
            {activeRun && activeTotal > 0 && (
              <span className="wf-stat-chip wf-stat-progress">
                进度 <strong>{activePct}%</strong>
                <span className="wf-wf-bar" aria-hidden="true">
                  <i style={{ width: `${activePct}%` }} />
                </span>
              </span>
            )}
          </div>
        ) : null}
        {activeRun ? (
          <div className="wf-active-banner" role="status">
            <Loader2 size={13} className="spin" aria-hidden="true" />
            <span>
              正在执行「{activeWorkflowName}」
              {activeRun.paused ? "（已暂停）" : ""}
              {activeRun.cancel_requested ? "（取消中）" : ""}
              {activeRunDetail ? ` · ${activeRunDetail.completed_steps}/${activeRunDetail.total_steps} 步` : ""}
            </span>
            <span className="flex-spacer" />
            <button type="button" className="btn sm" onClick={() => void openActiveRun()}>
              查看进度
            </button>
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

        <div className="wf-main">
          <aside className="wf-list-col" aria-label="工作流列表">
            <div className="wf-rail-head">
              <span>工作流</span>
              <strong>{workflows?.length ?? 0}</strong>
            </div>
            {workflows && workflows.length === 0 ? (
              <p className="wf-rail-empty">还没有工作流。从页头新建或套用模板开始。</p>
            ) : null}
            {workflows && workflows.length > 0 ? (
              <div className="wf-rail-list" role="list">
                {workflows.map((w) => {
                  const last = lastRuns[w.id];
                  const selected = selectedId === w.id;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      className={`wf-rail-item${selected ? " is-selected" : ""}${w.enabled ? "" : " is-disabled"}`}
                      aria-pressed={selected}
                      onClick={() => void selectWorkflow(w)}
                      data-workflow-id={w.id}
                    >
                      <span className="wf-rail-main">
                        <span className="wf-rail-name">{w.name}</span>
                        <span className="wf-rail-meta">
                          {w.step_count} 步
                          {last
                            ? ` · ${WORKFLOW_RUN_STATUS_LABELS[last.status]}`
                            : ` · ${tr("workflows.neverRun")}`}
                        </span>
                      </span>
                      <span className="wf-rail-side">
                        {!w.enabled ? (
                          <span className="wf-rail-badge is-muted">停用</span>
                        ) : activeRun?.workflow_id === w.id ? (
                          <span className="wf-rail-badge is-running">
                            <Loader2 size={10} className="spin" aria-hidden="true" /> 执行中
                          </span>
                        ) : last ? (
                          <span className={`wf-rail-badge kind-${runStatusKind(last.status)}`}>
                            {WORKFLOW_RUN_STATUS_LABELS[last.status]}
                          </span>
                        ) : (
                          <span className="wf-rail-badge">就绪</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </aside>

          <section className="wf-detail-col" aria-label="工作流详情">
            {!selectedSummary ? (
              <div className="wf-detail-empty">
                {workflowsLoading && !workflows ? (
                  <p className="wf-empty-steps">
                    <Loader2 size={13} className="spin" aria-hidden="true" /> 加载中…
                  </p>
                ) : (
                  <EmptyState
                    framed
                    icon={<WorkflowIcon size={22} aria-hidden="true" />}
                    hint={
                      <>
                        <p>{tr("workflows.empty")}</p>
                        <p className="wf-hint-text">{tr("workflows.emptyHint")}</p>
                      </>
                    }
                    action={
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => void openEditor(null, null)}
                      >
                        <Plus size={13} aria-hidden="true" /> 新建工作流
                      </button>
                    }
                  />
                )}
              </div>
            ) : (
              <article className="wf-detail-card" data-workflow-id={selectedSummary.id}>
                <header className="wf-detail-head">
                  <div className="wf-detail-title-wrap">
                    <h3 className="wf-detail-title">{selectedSummary.name}</h3>
                    <p className="wf-detail-desc">{selectedSummary.description || "（无描述）"}</p>
                  </div>
                  <label className="wf-card-enabled" aria-label={selectedSummary.enabled ? "停用工作流" : "启用工作流"}>
                    <input
                      type="checkbox"
                      checked={selectedSummary.enabled}
                      disabled={selectedBusy}
                      onChange={() =>
                        void guard(selectedSummary.id, () =>
                          updateWorkflow(selectedSummary.id, { enabled: !selectedSummary.enabled }),
                        )()
                      }
                    />
                    <span aria-hidden="true">{selectedSummary.enabled ? "已启用" : "已停用"}</span>
                  </label>
                </header>

                <div className="wf-detail-actions" role="group" aria-label="工作流操作">
                  {activeRun?.workflow_id === selectedSummary.id ? (
                    <button type="button" className="btn primary sm" onClick={() => void openActiveRun()} data-tip="查看本次执行进度">
                      <Loader2 size={13} className="spin" aria-hidden="true" /> 查看执行
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn primary sm"
                      disabled={!selectedSummary.enabled || Boolean(activeRun)}
                      onClick={() => void openRun(selectedSummary)}
                      data-tip={
                        !selectedSummary.enabled
                          ? "工作流已停用"
                          : activeRun
                            ? "已有工作流正在执行"
                            : "按顺序执行全部启用步骤"
                      }
                    >
                      <Play size={13} aria-hidden="true" /> 运行
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void openEditor(selectedDetail ?? selectedSummary, null)}
                  >
                    <Pencil size={13} aria-hidden="true" /> 编辑步骤
                  </button>
                  <button type="button" className="btn sm" onClick={() => openHistory(selectedSummary)}>
                    <History size={13} aria-hidden="true" /> 运行历史
                  </button>
                  <span className="flex-spacer" />
                  <DropdownMenu
                    trigger={({ ref, expanded, onClick, onKeyDown }) => (
                      <button
                        ref={ref}
                        type="button"
                        className="icon-btn sm"
                        aria-label={`更多操作 ${selectedSummary.name}`}
                        aria-haspopup="menu"
                        aria-expanded={expanded}
                        data-tip="更多操作"
                        onClick={onClick}
                        onKeyDown={onKeyDown}
                      >
                        <MoreHorizontal size={13} aria-hidden="true" />
                      </button>
                    )}
                    items={[
                      {
                        key: "duplicate",
                        icon: <Copy size={13} aria-hidden="true" />,
                        label: "创建副本",
                        disabled: selectedBusy,
                        onSelect: () =>
                          void guard(selectedSummary.id, async () => {
                            await duplicateWorkflow(selectedSummary.id);
                          })(),
                      },
                      {
                        key: "move-up",
                        icon: <ArrowUp size={13} aria-hidden="true" />,
                        label: "上移",
                        disabled: selectedBusy || selectedIndex <= 0,
                        onSelect: () => move(selectedSummary, -1),
                      },
                      {
                        key: "move-down",
                        icon: <ArrowDown size={13} aria-hidden="true" />,
                        label: "下移",
                        disabled: selectedBusy || selectedIndex >= (workflows?.length ?? 1) - 1,
                        onSelect: () => move(selectedSummary, 1),
                      },
                      { key: "sep", separator: true },
                      {
                        key: "delete",
                        icon: <Trash2 size={13} aria-hidden="true" />,
                        label: "删除工作流",
                        danger: true,
                        disabled: selectedBusy,
                        onSelect: () => setDeleteTarget(selectedSummary),
                      },
                    ]}
                    menuLabel={`更多操作 ${selectedSummary.name}`}
                    placement="bottom-end"
                  />
                  {selectedBusy ? <Loader2 size={12} className="spin wf-detail-busy" aria-hidden="true" /> : null}
                </div>

                <div className="wf-detail-stats">
                  <span>
                    <strong>{selectedSummary.step_count}</strong> 步骤
                  </span>
                  <span>
                    <strong>{selectedSummary.enabled ? "启用" : "停用"}</strong> 状态
                  </span>
                  <span>
                    <strong>{selectedLast ? WORKFLOW_RUN_STATUS_LABELS[selectedLast.status] : "未运行"}</strong> 最近
                  </span>
                </div>

                <section className="wf-detail-section" aria-label="步骤定义">
                  <div className="wf-detail-section-head">
                    <h4>步骤定义</h4>
                    {selectedDetail && selectedDetail.id === selectedSummary.id ? (
                      <span className="wf-detail-count">{selectedSteps.length} 步</span>
                    ) : null}
                  </div>
                  {selectedLoading ? (
                    <p className="wf-empty-steps">
                      <Loader2 size={13} className="spin" aria-hidden="true" /> 读取步骤…
                    </p>
                  ) : selectedError ? (
                    <p className="wf-error-text" role="alert">
                      读取步骤失败：{selectedError}
                      <button type="button" className="btn sm" onClick={() => void selectWorkflow(selectedSummary)}>
                        重试
                      </button>
                    </p>
                  ) : selectedDetailReady ? (
                    selectedSteps.length > 0 ? (
                      <ol className="wf-step-list">
                        {selectedSteps.map((step, index) => (
                          <li key={step.id} className={`wf-step-row${step.enabled ? "" : " is-disabled"}`}>
                            <span className="wf-step-index">{index + 1}</span>
                            <span className="wf-step-main">
                              <span className="wf-step-type">{WORKFLOW_STEP_TYPE_LABELS[step.step_type]}</span>
                              <span className="wf-step-summary">{stepParamsSummary(step)}</span>
                            </span>
                            {!step.enabled ? <span className="wf-step-badge is-muted">停用</span> : null}
                            {step.on_error === "continue" ? <span className="wf-step-badge">失败继续</span> : null}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="wf-detail-empty-hint">该工作流还没有步骤。进入「编辑步骤」添加第一项操作。</p>
                    )
                  ) : (
                    <p className="wf-detail-empty-hint">未读取到步骤定义，请重试或打开编辑页确认。</p>
                  )}
                </section>

                {selectedLast ? (
                  <section className="wf-detail-last" aria-label="最近一次运行">
                    <div className="wf-detail-section-head">
                      <h4>最近一次运行</h4>
                      <button type="button" className="btn sm" onClick={() => openHistory(selectedSummary)}>
                        查看全部
                      </button>
                    </div>
                    <div className="wf-last-run-line">
                      <span className={`wf-run-state kind-${runStatusKind(selectedLast.status)}`}>
                        {WORKFLOW_RUN_STATUS_LABELS[selectedLast.status]}
                      </span>
                      <span>
                        {selectedLast.completed_steps}/{selectedLast.total_steps} 步
                      </span>
                      <span className="wf-last-run-time">{selectedLast.started_at_local}</span>
                    </div>
                    {selectedLast.error ? (
                      <p className="wf-error-text" role="status">
                        {selectedLast.error}
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </article>
            )}
          </section>

        {/* 右侧信息带（2026-11-15 R2）：当前执行 / 空态 + 最近运行。
            对齐效果图「左列表、右当前执行、下方最近运行」的层级；没有活动运行
            时显示真实空态与创建入口，不伪造运行步骤。 */}
        <div className="wf-side-col">
          <section className="wf-current" aria-label="当前执行">
            <h3 className="wf-recent-title">当前执行</h3>
            {activeRun ? (
              <>
                <div className="wf-current-head">
                  <strong>{activeWorkflowName}</strong>
                  <span className={`wf-run-state kind-${activeRun.paused ? "waiting" : "running"}`}>
                    {activeRun.paused ? "已暂停" : activeRun.cancel_requested ? "取消中" : "运行中"}
                  </span>
                </div>
                <p className="wf-current-meta">
                  {activeTotal > 0
                    ? `已完成 ${activeRunDetail?.completed_steps ?? 0}/${activeTotal} 步`
                    : "正在准备步骤…"}
                </p>
                {activeRunDetail?.steps?.length ? (
                  <ol className="wf-current-steps">
                    {activeRunDetail.steps.map((step, index) => (
                      <li key={step.id} className={`wf-current-step is-${step.status}`}>
                        <span className="wf-current-step-index">{index + 1}</span>
                        <span className="wf-current-step-name" data-tip={step.detail || undefined}>
                          {step.detail || step.step_type}
                        </span>
                        <span className={`wf-current-step-state is-${step.status}`}>
                          {STEP_STATUS_LABELS[step.status] ?? step.status}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {activeTotal > 0 ? (
                  <div className="wf-current-progress">
                    <span className="wf-wf-bar" aria-hidden="true">
                      <i style={{ width: `${activePct}%` }} />
                    </span>
                    <strong>{activePct}%</strong>
                  </div>
                ) : null}
                <div className="wf-current-actions">
                  <button type="button" className="btn sm primary" onClick={() => void openActiveRun()}>
                    查看进度
                  </button>
                </div>
              </>
            ) : (
              <div className="wf-current-empty">
                <p>当前没有运行中的工作流。</p>
                <p className="wf-hint-text">选择左侧工作流点击「运行」，或从模板创建第一条固定顺序流程。</p>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void openEditor(null, WORKFLOW_TEMPLATES[0])}
                >
                  <Sparkles size={13} aria-hidden="true" /> 从模板创建
                </button>
              </div>
            )}
          </section>

          {/* 最近运行（2026-11-14，对照效果图）：lastRuns 真实摘要，含失败原因。 */}
          {recentRuns.length > 0 ? (
            <section className="wf-recent" aria-label="最近运行">
              <h3 className="wf-recent-title">最近运行</h3>
              <ul className="wf-rowlist">
                {recentRuns.map(({ wf, run }) => (
                  <li key={run.run_id}>
                    <button
                      type="button"
                      className="wf-recent-row"
                      onClick={() => openHistory(wf)}
                      data-tip="查看该工作流的运行历史"
                    >
                      <span className="wf-recent-name">{wf.name}</span>
                      <span className={`wf-run-state kind-${runStatusKind(run.status)}`}>
                        {WORKFLOW_RUN_STATUS_LABELS[run.status]}
                      </span>
                      <span className="wf-recent-meta">{run.started_at_local}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        </div>

        <section className="wf-timeline" aria-label="运行时间线">
          <div className="wf-detail-section-head">
            <h4>运行时间线</h4>
            <span className="wf-detail-count">
              {recentRuns.length > 0 ? `最近 ${recentRuns.length} 条` : "暂无记录"}
            </span>
          </div>
          {recentRuns.length > 0 ? (
            <ol className="wf-timeline-list">
              {recentRuns.map(({ wf, run }) => (
                <li key={run.run_id} className="wf-timeline-item">
                  <span className="wf-timeline-dot" aria-hidden="true" />
                  <span className="wf-timeline-main">
                    <span className="wf-timeline-name">{wf.name}</span>
                    <span className="wf-timeline-meta">
                      {run.completed_steps}/{run.total_steps} 步 · {run.started_at_local}
                    </span>
                  </span>
                  <span className={`wf-run-state kind-${runStatusKind(run.status)}`}>
                    {WORKFLOW_RUN_STATUS_LABELS[run.status]}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="wf-detail-empty-hint">还没有运行记录。运行工作流后，真实步骤结果会出现在这里。</p>
          )}
        </section>
      </div>

        </>
      )}
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
