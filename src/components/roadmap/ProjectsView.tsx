//! 规划「项目总览」视图（ADR-0010）：只展示**当前全局项目**的计划与统计。
//!
//! - 全局项目来自 ProjectContext；本视图不跨项目切换、不提供第二套选择器，
//!   也不在规划页内创建新项目（创建统一走顶栏/项目中枢）；
//! - 计划列表按 `workspace_project_id` 归属过滤：planning_list_projects 返回的是
//!   每个项目的当前激活计划，未关联到当前项目的记录（孤儿/其他项目）不展示；
//! - 无计划 → 「当前项目尚无可用计划」空态；无项目 → 由 PlanningWorkspace 兜底；
//! - 统计来自后端权威计划实体，功能变更后由 Store 同步；加载失败显示重试入口；
//!   删除计划必须经 ConfirmDialog 明确影响面（最后一个计划的保护在后端）。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Flag,
  LayoutDashboard,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { ConfirmDialog, EmptyState } from "../ui";
import {
  PLANNING_PROJECT_STATUS_LABELS,
  type PlanningPlan,
} from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";
import { useProjectContext } from "../../workbench/ProjectContext";
import { WorkbenchPageDetail, WorkbenchDetailFacts } from "../../workbench/pageDetail";
import { ProjectEditorView } from "./PlanningEditors";
import { PlanningActivityRow } from "./PlanningFeatureCard";
import { PlanningProgressBar, findScrollParent } from "./PlanningBits";

export interface ProjectsViewProps {
  onOpenFeatures: () => void;
  onOpenMilestones: () => void;
}

function planProgressText(p: PlanningPlan): string {
  if (!p.stats.has_features) return "尚未添加功能";
  return `${p.stats.feature_completed}/${p.stats.feature_total} 完成 · ${p.stats.progress_percent}%`;
}

export default function ProjectsView({ onOpenFeatures, onOpenMilestones }: ProjectsViewProps) {
  // 全局项目上下文（ADR-0010）：只读消费，计划范围由项目根决定。
  const { projectId, selectedProject } = useProjectContext();
  const plans = usePlanningStore((s) => s.plans);
  const plansLoading = usePlanningStore((s) => s.plansLoading);
  const plansError = usePlanningStore((s) => s.plansError);
  const loadPlans = usePlanningStore((s) => s.loadPlans);
  const activePlanId = usePlanningStore((s) => s.activePlanId);
  const loadedForPlan = usePlanningStore((s) => s.loadedForPlan);
  const selectPlan = usePlanningStore((s) => s.selectPlan);
  const archivePlan = usePlanningStore((s) => s.archivePlan);
  const deletePlan = usePlanningStore((s) => s.deletePlan);
  const milestones = usePlanningStore((s) => s.milestones);
  const milestonesLoading = usePlanningStore((s) => s.milestonesLoading);
  const activity = usePlanningStore((s) => s.activity);
  const activityHasMore = usePlanningStore((s) => s.activityHasMore);
  const activityLoading = usePlanningStore((s) => s.activityLoading);
  const activityError = usePlanningStore((s) => s.activityError);
  const loadActivity = usePlanningStore((s) => s.loadActivity);
  const loadMoreActivity = usePlanningStore((s) => s.loadMoreActivity);
  const showToast = useUiStore((s) => s.showToast);

  /** null = 列表态；非空 = 页面内编辑态（只编辑当前项目范围内的计划）。 */
  const [editor, setEditor] = useState<{ plan: PlanningPlan } | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<PlanningPlan | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 进入编辑前列表的滚动位置：返回时恢复，避免用户回到列表顶部。 */
  const listScrollTop = useRef(0);
  // 计划级 recent activity 只在本计划数据就绪后请求一次；Store 内按作用域防护乱序
  const activityRequestedFor = useRef<string | null>(null);

  // 当前项目范围内的计划：planning_list_projects 返回各项目当前激活计划（含孤儿），
  // 按 workspace_project_id 归属过滤后只剩本项目的计划（多计划版本 UI 待后续 API）。
  const projectPlans = useMemo(
    () => plans.filter((p) => p.workspace_project_id === projectId),
    [plans, projectId],
  );
  // 数据已加载的计划（可来自计划版本之外的同项目计划，显示层以 Store 为准）。
  const activePlan = useMemo(
    () => plans.find((p) => p.id === activePlanId) ?? null,
    [plans, activePlanId],
  );

  /**
   * 左侧里程碑只展示当前计划的真实记录；不补占位里程碑，也不从功能数量反推。
   * 宽窗点击后进入里程碑视图；窄窗仍可从工具行的「里程碑」按钮进入。
   */
  const activeMilestones = useMemo(
    () =>
      milestones
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .slice(0, 4),
    [milestones],
  );

  useEffect(() => {
    if (!activePlanId || loadedForPlan !== activePlanId) return;
    if (activityRequestedFor.current === activePlanId) return;
    activityRequestedFor.current = activePlanId;
    void loadActivity(null);
  }, [activePlanId, loadedForPlan, loadActivity]);

  const stats = activePlan?.stats;

  /** 进入编辑态前记住列表滚动位置；返回时一次性恢复（页面级单一滚动容器）。 */
  const openEditor = (plan: PlanningPlan) => {
    const sc = findScrollParent(rootRef.current);
    if (sc) listScrollTop.current = sc.scrollTop;
    setEditor({ plan });
    window.requestAnimationFrame(() => {
      const container = findScrollParent(rootRef.current);
      if (container) container.scrollTop = 0;
    });
  };

  const closeEditor = () => {
    setEditor(null);
    window.requestAnimationFrame(() => {
      const container = findScrollParent(rootRef.current);
      if (container) container.scrollTop = listScrollTop.current;
    });
  };

  const handleArchive = () => {
    if (!activePlan) return;
    const next = !activePlan.archived;
    archivePlan(activePlan.id, next)
      .then(() =>
        showToast(next ? "计划已归档" : "计划已恢复", { kind: "success" }),
      )
      .catch((e) => showToast(`操作失败：${String(e)}`, { kind: "error" }));
  };

  // ── 页面内编辑态：整块内容区切换为表单，不叠遮罩 ──
  if (editor) {
    return (
      <div className="planning-projects planning-editor-page" ref={rootRef}>
        <ProjectEditorView plan={editor.plan} onClose={closeEditor} />
      </div>
    );
  }

  // ── 无计划：明确空态（不自动创建、不静默挑别的计划）──
  if (!projectId) {
    return (
      <div className="planning-projects" ref={rootRef}>
        <EmptyState
          framed
          titleAs="h3"
          title="尚未选择项目"
          icon={<LayoutDashboard size={22} aria-hidden="true" />}
          hint={<p>使用顶栏的项目选择器选择项目，或到项目中枢创建。</p>}
        />
      </div>
    );
  }

  if (!plansLoading && projectPlans.length === 0 && !activePlan && !plansError) {
    return (
      <div className="planning-projects" ref={rootRef}>
        <EmptyState
          framed
          titleAs="h3"
          title="当前项目尚无可用计划"
          icon={<LayoutDashboard size={22} aria-hidden="true" />}
          hint={
            <>
              <p>当前项目「{selectedProject?.name ?? projectId}」还没有激活的计划。</p>
              <p className="planning-empty-sub">
                可以在项目中枢为项目创建计划；创建后回到这里开始规划功能与里程碑。
              </p>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="planning-projects planning-overview-page" ref={rootRef}>
      {plansError && (
        <div className="planning-error" role="alert">
          <span>计划列表加载失败：{plansError}</span>
          <button className="btn sm" onClick={() => void loadPlans()}>
            重试
          </button>
        </div>
      )}

      {plansLoading && plans.length === 0 ? (
        <div className="planning-loading" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 加载计划…
        </div>
      ) : (
        <div className="planning-overview-layout">
          {/* 宽窗：当前项目的计划卡；窄窗由 CSS 收起。 */}
          <aside className="planning-project-list" aria-label="当前项目计划">
            <div className="planning-project-list-head">
              <span>当前项目</span>
              <span className="planning-project-list-count">{projectPlans.length}</span>
            </div>
            {projectPlans.map((p) => (
              <button
                key={p.id}
                className={`task-card planning-project-item ${p.id === activePlanId ? "is-active" : ""}`}
                onClick={() => {
                  activityRequestedFor.current = null;
                  void selectPlan(p.id);
                }}
                aria-pressed={p.id === activePlanId}
              >
                <span className="planning-project-item-top">
                  <span className="planning-project-item-name">{p.name}</span>
                  <em className={`planning-project-state s-${p.status}`}>
                    {PLANNING_PROJECT_STATUS_LABELS[p.status]}
                  </em>
                </span>
                <span className="planning-project-item-progress">{planProgressText(p)}</span>
                {p.stats.has_features && <PlanningProgressBar value={p.stats.progress_percent} />}
              </button>
            ))}

            {/* 左侧在本期计划下直接列出里程碑，避免「项目总览」与「里程碑」
                两个视图之间来回切换才能看到时间节点。数据缺失时只给入口。 */}
            <section className="planning-side-milestones" aria-label="当前计划里程碑">
              <div className="planning-project-list-head">
                <span>里程碑</span>
                <span className="planning-project-list-count">
                  {activePlan ? milestones.length : 0}
                </span>
              </div>
              {!activePlan ? (
                <p className="planning-side-empty">当前项目还没有可用计划。</p>
              ) : milestonesLoading && activeMilestones.length === 0 ? (
                <p className="planning-side-empty">
                  <Loader2 size={12} className="spin" aria-hidden="true" /> 加载里程碑…
                </p>
              ) : activeMilestones.length === 0 ? (
                <button className="planning-side-add" onClick={onOpenMilestones}>
                  <Flag size={12} aria-hidden="true" /> 新建首个里程碑
                </button>
              ) : (
                <ul className="planning-side-milestone-list">
                  {activeMilestones.map((m) => {
                    const percent =
                      m.feature_total > 0
                        ? Math.round((m.feature_completed / m.feature_total) * 100)
                        : 0;
                    return (
                      <li key={m.id}>
                        <button
                          className="planning-side-milestone"
                          onClick={onOpenMilestones}
                          aria-label={`查看里程碑 ${m.name}`}
                        >
                          <span className="planning-side-milestone-top">
                            <span className="planning-side-milestone-name">{m.name}</span>
                            <span className="planning-side-milestone-date">
                              {m.target_date ?? "未设日期"}
                            </span>
                          </span>
                          <span className="planning-side-milestone-meta">
                            {m.feature_total > 0
                              ? `${m.feature_completed}/${m.feature_total} 功能 · ${percent}%`
                              : "尚未关联功能"}
                          </span>
                          {m.feature_total > 0 && <PlanningProgressBar value={percent} />}
                        </button>
                      </li>
                    );
                  })}
                  {milestones.length > activeMilestones.length && (
                    <button className="planning-side-more" onClick={onOpenMilestones}>
                      查看其余 {milestones.length - activeMilestones.length} 个
                      <ArrowRight size={12} aria-hidden="true" />
                    </button>
                  )}
                </ul>
              )}
            </section>
          </aside>

          <section className="planning-project-main">
            <div className="planning-toolbar planning-overview-toolbar">
              <div className="planning-toolbar-actions">
                <button className="btn sm" onClick={onOpenFeatures} disabled={!activePlan}>
                  <LayoutDashboard size={13} aria-hidden="true" /> 功能列表
                </button>
                <button className="btn sm" onClick={onOpenMilestones} disabled={!activePlan}>
                  <Flag size={13} aria-hidden="true" /> 里程碑
                </button>
                <button
                  className="icon-btn sm"
                  data-tip="编辑计划"
                  aria-label="编辑计划"
                  disabled={!activePlan}
                  onClick={() => activePlan && openEditor(activePlan)}
                >
                  <Pencil size={13} />
                </button>
                {activePlan?.archived ? (
                  <button
                    className="icon-btn sm"
                    data-tip="恢复计划"
                    aria-label="恢复计划"
                    onClick={handleArchive}
                  >
                    <ArchiveRestore size={13} />
                  </button>
                ) : (
                  <button
                    className="icon-btn sm"
                    data-tip="归档计划（当前计划需要先有未归档的继任计划）"
                    aria-label="归档计划"
                    disabled={!activePlan}
                    onClick={handleArchive}
                  >
                    <Archive size={13} />
                  </button>
                )}
                <button
                  className="icon-btn sm"
                  data-tip="删除计划（影响其功能、步骤与历史）"
                  aria-label="删除计划"
                  disabled={!activePlan}
                  onClick={() => activePlan && setDeletingPlan(activePlan)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {activePlan && stats ? (
              <>
                <header className="planning-project-hero">
                  <div className="planning-project-hero-title">
                    <h3>{activePlan.name}</h3>
                    <em className={`planning-project-state s-${activePlan.status}`}>
                      {PLANNING_PROJECT_STATUS_LABELS[activePlan.status]}
                    </em>
                    {activePlan.archived && <span className="chip">已归档</span>}
                  </div>
                  <p className="planning-project-desc">
                    {activePlan.description || "尚未填写计划描述。"}
                  </p>
                  <div className="planning-project-meta">
                    {activePlan.target_date && (
                      <span>目标日期 {activePlan.target_date}</span>
                    )}
                    <span>更新于 {activePlan.updated_at.slice(0, 10)}</span>
                  </div>
                </header>

                {/* 四张等权摘要：计划级关键决策信息优先，详细分布留在右栏与功能视图。
                    无真实数据时保留 0，不用演示数字填充。 */}
                <div className="planning-summary-grid" aria-label="计划概览">
                  <div className="planning-summary-card">
                    <span className="planning-summary-label">计划状态</span>
                    <strong className="planning-summary-value">
                      {PLANNING_PROJECT_STATUS_LABELS[activePlan.status]}
                    </strong>
                    <span className="planning-summary-sub">
                      {activePlan.archived ? "计划已归档" : "当前项目激活计划"}
                    </span>
                  </div>
                  <div className="planning-summary-card">
                    <span className="planning-summary-label">功能总数</span>
                    <strong className="planning-summary-value">{stats.feature_total}</strong>
                    <span className="planning-summary-sub">
                      {stats.has_features ? "已登记交付范围" : "尚未添加功能"}
                    </span>
                  </div>
                  <div className="planning-summary-card is-success">
                    <span className="planning-summary-label">已完成</span>
                    <strong className="planning-summary-value">{stats.feature_completed}</strong>
                    <span className="planning-summary-sub">
                      {stats.has_features
                        ? `${Math.round(stats.progress_percent)}% 完成率`
                        : "等待第一条功能"}
                    </span>
                  </div>
                  <div className="planning-summary-card is-running">
                    <span className="planning-summary-label">开发中</span>
                    <strong className="planning-summary-value">{stats.feature_in_progress}</strong>
                    <span className="planning-summary-sub">
                      待验收 {stats.feature_review} · 受阻 {stats.feature_blocked}
                    </span>
                  </div>
                </div>

                <div className="planning-overall">
                  <div className="planning-overall-head">
                    <span>整体完成率</span>
                    {stats.has_features ? (
                      <strong>{Math.round(stats.progress_percent)}%</strong>
                    ) : (
                      <span className="planning-overall-empty">尚未添加功能</span>
                    )}
                  </div>
                  {stats.has_features ? (
                    <PlanningProgressBar value={stats.progress_percent} large />
                  ) : (
                    <p className="planning-section-empty">
                      这个计划还没有功能。先登记要交付的功能，再拆分步骤记录进度。
                    </p>
                  )}
                  {!stats.has_features && (
                    <button className="btn sm primary" onClick={onOpenFeatures}>
                      <Plus size={13} aria-hidden="true" /> 添加功能
                    </button>
                  )}
                </div>

                <section className="planning-recent" aria-label="最近开发进度">
                  <div className="planning-recent-head">
                    <h4>最近开发进度</h4>
                    <button className="btn sm subtle" onClick={onOpenFeatures}>
                      查看功能 <ArrowRight size={12} aria-hidden="true" />
                    </button>
                  </div>
                  {activityError ? (
                    <p className="planning-recent-empty" role="alert">
                      进度加载失败：{activityError}
                      <button className="btn sm" onClick={() => void loadActivity(null)}>
                        重试
                      </button>
                    </p>
                  ) : activity.length === 0 && !activityLoading ? (
                    <p className="planning-recent-empty">
                      还没有进度记录。进入功能详情勾选步骤或写开发日志后，这里会展示最近动态。
                    </p>
                  ) : (
                    <ul className="planning-act-list planning-recent-list">
                      {activity.slice(0, 8).map((a) => (
                        <PlanningActivityRow key={a.id} a={a} />
                      ))}
                    </ul>
                  )}
                  {activityHasMore && activity.length > 0 && (
                    <button
                      className="btn sm subtle"
                      disabled={activityLoading}
                      onClick={() => void loadMoreActivity(null)}
                    >
                      {activityLoading ? (
                        <Loader2 size={12} className="spin" aria-hidden="true" />
                      ) : null}
                      加载更早记录
                    </button>
                  )}
                </section>
              </>
            ) : (
              <div className="planning-empty-features">
                <p>当前项目尚无可用计划</p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* 右栏「本期规划」：只读汇总当前计划真实统计、目标日期与里程碑；
          编辑与功能维护仍在中央内容区，不把整页业务搬进右栏。 */}
      {activePlan && stats && (
        <WorkbenchPageDetail
          title="本期规划"
          actions={
            <button className="btn sm subtle" onClick={onOpenMilestones}>
              里程碑 <ArrowRight size={12} aria-hidden="true" />
            </button>
          }
        >
          <div className="planning-rail-project">
            <span className={`planning-project-state s-${activePlan.status}`}>
              {PLANNING_PROJECT_STATUS_LABELS[activePlan.status]}
            </span>
            <strong>{activePlan.name}</strong>
            {activePlan.target_date ? (
              <span>目标 {activePlan.target_date}</span>
            ) : (
              <span>未设置目标日期</span>
            )}
          </div>
          <WorkbenchDetailFacts
            rows={[
              { label: "功能范围", value: `${stats.feature_total} 个功能` },
              { label: "已完成", value: `${stats.feature_completed} 个` },
              { label: "开发中", value: `${stats.feature_in_progress} 个` },
              { label: "待验收", value: `${stats.feature_review} 个` },
              { label: "受阻", value: `${stats.feature_blocked} 个` },
              { label: "里程碑", value: `${milestones.length} 个` },
              {
                label: "下一节点",
                value:
                  activeMilestones.find((m) => m.target_date)?.target_date ??
                  activeMilestones[0]?.name ??
                  "尚未创建",
              },
            ]}
          />
          <div className="planning-rail-progress">
            <div className="planning-rail-progress-head">
              <span>整体完成率</span>
              <strong>{stats.has_features ? `${Math.round(stats.progress_percent)}%` : "—"}</strong>
            </div>
            {stats.has_features ? (
              <PlanningProgressBar value={stats.progress_percent} />
            ) : (
              <p>尚未添加功能。先登记交付范围，再拆分开发步骤。</p>
            )}
          </div>
          {activeMilestones.length > 0 && (
            <div className="planning-rail-milestones">
              <h4>当前里程碑</h4>
              <ul>
                {activeMilestones.slice(0, 3).map((m) => (
                  <li key={m.id}>
                    <span>{m.name}</span>
                    <em>{m.target_date ?? "未设日期"}</em>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </WorkbenchPageDetail>
      )}

      <ConfirmDialog
        open={deletingPlan !== null}
        title="删除计划"
        detail={
          deletingPlan
            ? `确定删除计划「${deletingPlan.name}」？其 ${deletingPlan.stats.feature_total} 个功能、全部开发步骤与进度历史将一并删除，且无法恢复。若这是项目的最后一个计划，将被拒绝；请在项目工作空间删除整个项目。`
            : ""
        }
        danger
        confirmLabel="删除计划"
        onConfirm={() => {
          const p = deletingPlan;
          setDeletingPlan(null);
          if (!p) return;
          deletePlan(p.id)
            .then(() => showToast(`计划「${p.name}」已删除`, { kind: "success" }))
            .catch((e) => showToast(`删除失败：${String(e)}`, { kind: "error" }));
        }}
        onCancel={() => setDeletingPlan(null)}
      />
    </div>
  );
}
