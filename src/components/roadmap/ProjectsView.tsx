//! 规划中心「项目总览」视图：左侧项目列表 + 右侧详情统计（窄窗折叠为
//! Select + 纵向排列），以及项目级 CRUD / 归档 / 删除。
//!
//! - 无项目 → 引导创建；有项目但无功能 → 「尚未添加功能」，不显示 0% 进度；
//! - 统计来自后端权威项目实体（Rust/SQLite），功能变更后由 Store 同步；
//! - 最近进度复用项目级 activity（feature_id = null），与功能级历史按作用域隔离；
//! - 加载失败显示重试入口；删除项目必须经 ConfirmDialog 明确影响面。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Flag,
  FolderPlus,
  LayoutDashboard,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Select, ConfirmDialog } from "../ui";
import {
  PLANNING_PROJECT_STATUS_LABELS,
  type PlanningProject,
} from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";
import { ProjectDialog } from "./PlanningDialogs";
import { PlanningActivityRow } from "./PlanningFeatureCard";
import { PlanningProgressBar } from "./PlanningBits";

export interface ProjectsViewProps {
  onOpenFeatures: () => void;
  onOpenMilestones: () => void;
}

function projectProgressText(p: PlanningProject): string {
  if (!p.stats.has_features) return "尚未添加功能";
  return `${p.stats.feature_completed}/${p.stats.feature_total} 完成 · ${p.stats.progress_percent}%`;
}

export default function ProjectsView({ onOpenFeatures, onOpenMilestones }: ProjectsViewProps) {
  const projects = usePlanningStore((s) => s.projects);
  const projectsLoading = usePlanningStore((s) => s.projectsLoading);
  const projectsError = usePlanningStore((s) => s.projectsError);
  const loadProjects = usePlanningStore((s) => s.loadProjects);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const loadedForProject = usePlanningStore((s) => s.loadedForProject);
  const selectProject = usePlanningStore((s) => s.selectProject);
  const archiveProject = usePlanningStore((s) => s.archiveProject);
  const deleteProject = usePlanningStore((s) => s.deleteProject);
  const activity = usePlanningStore((s) => s.activity);
  const activityHasMore = usePlanningStore((s) => s.activityHasMore);
  const activityLoading = usePlanningStore((s) => s.activityLoading);
  const activityError = usePlanningStore((s) => s.activityError);
  const loadActivity = usePlanningStore((s) => s.loadActivity);
  const loadMoreActivity = usePlanningStore((s) => s.loadMoreActivity);
  const showToast = useUiStore((s) => s.showToast);

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<PlanningProject | null>(null);
  const [deletingProject, setDeletingProject] = useState<PlanningProject | null>(null);
  // 项目级 recent activity 只在本项目数据就绪后请求一次；Store 内按作用域防护乱序
  const activityRequestedFor = useRef<string | null>(null);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const archivedProjects = useMemo(() => projects.filter((p) => p.archived), [projects]);
  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);

  useEffect(() => {
    if (!activeProjectId || loadedForProject !== activeProjectId) return;
    if (activityRequestedFor.current === activeProjectId) return;
    activityRequestedFor.current = activeProjectId;
    void loadActivity(null);
  }, [activeProjectId, loadedForProject, loadActivity]);

  const stats = activeProject?.stats;

  const handleArchive = () => {
    if (!activeProject) return;
    const next = !activeProject.archived;
    archiveProject(activeProject.id, next)
      .then(() =>
        showToast(next ? "项目已归档，可在列表中恢复" : "项目已恢复", { kind: "success" }),
      )
      .catch((e) => showToast(`操作失败：${String(e)}`, { kind: "error" }));
  };

  // ── 无项目：引导创建 ──
  if (!projectsLoading && projects.length === 0 && !projectsError) {
    return (
      <div className="planning-projects">
        <div className="planning-empty-hero">
          <h3>规划中心</h3>
          <p>创建你的第一个项目：规划功能、拆分开发步骤、记录进度。</p>
          <p className="planning-empty-sub">
            Task Dock 自身的路线图在上方「内置路线图」中查看，两者互不影响。
          </p>
          <button
            className="btn primary"
            onClick={() => {
              setEditingProject(null);
              setProjectDialogOpen(true);
            }}
          >
            <FolderPlus size={14} aria-hidden="true" /> 新建项目
          </button>
        </div>
        <ProjectDialog
          open={projectDialogOpen}
          project={null}
          onClose={() => setProjectDialogOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="planning-projects planning-overview-page">
      {projectsError && (
        <div className="planning-error" role="alert">
          <span>项目列表加载失败：{projectsError}</span>
          <button className="btn sm" onClick={() => void loadProjects()}>
            重试
          </button>
        </div>
      )}

      {projectsLoading && projects.length === 0 ? (
        <div className="planning-loading" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 加载项目…
        </div>
      ) : (
        <div className="planning-overview-layout">
          {/* 宽窗：左侧项目列表；窄窗由 CSS 收起，改用 Select */}
          <aside className="planning-project-list" aria-label="项目列表">
            <div className="planning-project-list-head">
              <span>我的项目</span>
              <span className="planning-project-list-count">{activeProjects.length}</span>
            </div>
            {activeProjects.map((p) => (
              <button
                key={p.id}
                className={`task-card planning-project-item ${p.id === activeProjectId ? "is-active" : ""}`}
                onClick={() => {
                  activityRequestedFor.current = null;
                  void selectProject(p.id);
                }}
                aria-pressed={p.id === activeProjectId}
              >
                <span className="planning-project-item-top">
                  <span className="planning-project-item-name">{p.name}</span>
                  <em className={`planning-project-state s-${p.status}`}>
                    {PLANNING_PROJECT_STATUS_LABELS[p.status]}
                  </em>
                </span>
                <span className="planning-project-item-progress">{projectProgressText(p)}</span>
                {p.stats.has_features && <PlanningProgressBar value={p.stats.progress_percent} />}
              </button>
            ))}
            {archivedProjects.length > 0 && (
              <div className="planning-project-archived">
                <span className="planning-project-list-sub">已归档</span>
                {archivedProjects.map((p) => (
                  <button
                    key={p.id}
                    className={`task-card planning-project-item is-archived ${
                      p.id === activeProjectId ? "is-active" : ""
                    }`}
                    onClick={() => {
                      activityRequestedFor.current = null;
                      void selectProject(p.id);
                    }}
                    aria-pressed={p.id === activeProjectId}
                  >
                    <span className="planning-project-item-top">
                      <span className="planning-project-item-name">{p.name}</span>
                      <em className="planning-project-state">已归档</em>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button
              className="planning-project-add"
              onClick={() => {
                setEditingProject(null);
                setProjectDialogOpen(true);
              }}
            >
              <Plus size={13} aria-hidden="true" /> 新建项目
            </button>
          </aside>

          <section className="planning-project-main">
            {/* 窄窗项目选择器 */}
            <div className="planning-toolbar planning-overview-toolbar">
              <div className="planning-project-picker planning-wide-hidden">
                <Select
                  value={activeProjectId ?? ""}
                  ariaLabel="选择项目"
                  block
                  menuMinWidth={220}
                  options={projects.map((p) => ({
                    value: p.id,
                    label: p.archived ? `${p.name}（已归档）` : p.name,
                  }))}
                  onChange={(id) => {
                    activityRequestedFor.current = null;
                    void selectProject(id);
                  }}
                />
              </div>
              <div className="planning-toolbar-actions">
                <button className="btn sm" onClick={onOpenFeatures} disabled={!activeProject}>
                  <LayoutDashboard size={13} aria-hidden="true" /> 功能列表
                </button>
                <button className="btn sm" onClick={onOpenMilestones} disabled={!activeProject}>
                  <Flag size={13} aria-hidden="true" /> 里程碑
                </button>
                <button
                  className="icon-btn sm"
                  data-tip="编辑项目"
                  aria-label="编辑项目"
                  disabled={!activeProject}
                  onClick={() => {
                    setEditingProject(activeProject);
                    setProjectDialogOpen(true);
                  }}
                >
                  <Pencil size={13} />
                </button>
                {activeProject?.archived ? (
                  <button
                    className="icon-btn sm"
                    data-tip="恢复项目"
                    aria-label="恢复项目"
                    onClick={handleArchive}
                  >
                    <ArchiveRestore size={13} />
                  </button>
                ) : (
                  <button
                    className="icon-btn sm"
                    data-tip="归档项目"
                    aria-label="归档项目"
                    disabled={!activeProject}
                    onClick={handleArchive}
                  >
                    <Archive size={13} />
                  </button>
                )}
                <button
                  className="icon-btn sm"
                  data-tip="删除项目（影响其功能、步骤与历史）"
                  aria-label="删除项目"
                  disabled={!activeProject}
                  onClick={() => setDeletingProject(activeProject)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {activeProject && stats ? (
              <>
                <header className="planning-project-hero">
                  <div className="planning-project-hero-title">
                    <h3>{activeProject.name}</h3>
                    <em className={`planning-project-state s-${activeProject.status}`}>
                      {PLANNING_PROJECT_STATUS_LABELS[activeProject.status]}
                    </em>
                    {activeProject.archived && <span className="chip">已归档</span>}
                  </div>
                  <p className="planning-project-desc">
                    {activeProject.description || "尚未填写项目描述。"}
                  </p>
                  <div className="planning-project-meta">
                    {activeProject.target_date && (
                      <span>目标日期 {activeProject.target_date}</span>
                    )}
                    <span>更新于 {activeProject.updated_at.slice(0, 10)}</span>
                  </div>
                </header>

                <div className="planning-stat-grid" aria-label="项目概览">
                  <div className="planning-stat-card">
                    <span className="planning-stat-label">功能总数</span>
                    <strong className="planning-stat-value">{stats.feature_total}</strong>
                  </div>
                  <div className="planning-stat-card tone-success">
                    <span className="planning-stat-label">已完成</span>
                    <strong className="planning-stat-value">{stats.feature_completed}</strong>
                  </div>
                  <div className="planning-stat-card tone-running">
                    <span className="planning-stat-label">开发中</span>
                    <strong className="planning-stat-value">{stats.feature_in_progress}</strong>
                  </div>
                  <div className="planning-stat-card">
                    <span className="planning-stat-label">待开发</span>
                    <strong className="planning-stat-value">{stats.feature_planned}</strong>
                  </div>
                  <div className="planning-stat-card tone-review">
                    <span className="planning-stat-label">待验收</span>
                    <strong className="planning-stat-value">{stats.feature_review}</strong>
                  </div>
                  <div className="planning-stat-card tone-danger">
                    <span className="planning-stat-label">受阻</span>
                    <strong className="planning-stat-value">{stats.feature_blocked}</strong>
                  </div>
                  {stats.feature_paused > 0 && (
                    <div className="planning-stat-card">
                      <span className="planning-stat-label">已暂停</span>
                      <strong className="planning-stat-value">{stats.feature_paused}</strong>
                    </div>
                  )}
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
                      这个项目还没有功能。先登记要交付的功能，再拆分步骤记录进度。
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
                <p>选择一个项目查看详情</p>
              </div>
            )}
          </section>
        </div>
      )}

      <ProjectDialog
        open={projectDialogOpen}
        project={editingProject}
        onClose={() => setProjectDialogOpen(false)}
      />
      <ConfirmDialog
        open={deletingProject !== null}
        title="删除项目"
        detail={
          deletingProject
            ? `确定删除项目「${deletingProject.name}」？其 ${deletingProject.stats.feature_total} 个功能、全部开发步骤与进度历史将一并删除，且无法恢复。`
            : ""
        }
        danger
        confirmLabel="删除项目"
        onConfirm={() => {
          const p = deletingProject;
          setDeletingProject(null);
          if (!p) return;
          deleteProject(p.id)
            .then(() => showToast(`项目「${p.name}」已删除`, { kind: "success" }))
            .catch((e) => showToast(`删除失败：${String(e)}`, { kind: "error" }));
        }}
        onCancel={() => setDeletingProject(null)}
      />
    </div>
  );
}
