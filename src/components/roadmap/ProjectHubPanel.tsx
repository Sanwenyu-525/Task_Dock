//! 项目中枢（v78）：项目总览 / 目标与规划 / 功能与看板 / 能力 / 项目资源 / 执行。
//!
//! 交互原则：
//! - 默认入口是「你想完成什么？」自然语言描述；模板与手动创建保留为并列入口。
//! - 草案先预览、可改名/改目标，确认后才写库；没有 AI 时完全走本地解析。
//! - 进度与能力准备度使用已测试的领域函数；数据不足显示「待评估」，不编造百分比。
//! - 创建请求带稳定 `clientRequestId`：同一草案重试幂等，参数变化自动换 ID。
//! - 规划编辑仍由既有 PlanningWorkspace 承担（兼容深链），本面板不复制第二套写路径。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  CircleDashed,
  FolderOpen,
  KanbanSquare,
  Layers,
  LayoutDashboard,
  Link2,
  ListChecks,
  Plus,
  Sparkles,
  Target,
  Unlink,
} from "lucide-react";
import {
  openProjectWorkspaceWindow,
  projectHubCreateProject,
  projectHubGetProject,
  projectHubResourceCandidates,
  projectHubResourceLink,
  projectHubResourceLinks,
  projectHubResourceUnlink,
  projectHubResourceValidate,
  type ProjectHubCreateInput,
  type ProjectHubResourceCandidate,
  type ProjectHubResourceLink,
  type ProjectHubSnapshot,
} from "../../lib/bridge";
import { useProjectContext } from "../../workbench/ProjectContext";
import { useUiStore } from "../../store/useUiStore";
import { SectionTabs } from "../ui";
import {
  buildCapabilityInput,
  buildCreatePayload,
  buildManualCreatePayload,
  buildPhaseSummaries,
  buildProgressInput,
  calculateCapabilityReadiness,
  calculateProjectProgress,
  clearRequestIdState,
  cloneProjectDraft,
  createRequestId,
  currentPhaseOf,
  generateProjectDraft,
  parseProjectIntent,
  requestSignature,
  resolveRequestId,
  KIND_LABELS,
} from "../../lib/projectHub";
import type { ProjectDraft, ProjectKind } from "../../lib/projectHub/types";
import { Dialog } from "../ui/Dialog";
import PlanningWorkspace from "./PlanningWorkspace";
import ProjectHubDomainSummary from "./ProjectHubDomainSummary";
import "./project-hub.css";

type HubView = "overview" | "planning" | "features" | "capability" | "resources" | "execution";
type CreateMode = "intent" | "template" | "manual";

const VIEW_TABS: { key: HubView; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "总览", icon: LayoutDashboard },
  { key: "planning", label: "目标与规划", icon: Layers },
  { key: "features", label: "功能与看板", icon: KanbanSquare },
  { key: "capability", label: "能力", icon: Boxes },
  { key: "resources", label: "项目资源", icon: Link2 },
  { key: "execution", label: "执行", icon: ListChecks },
];

const KIND_OPTIONS: ProjectKind[] = ["novel", "game", "ai_comic", "general", "development"];

const FEATURE_COLUMNS: { key: string; label: string }[] = [
  { key: "planned", label: "待开始" },
  { key: "in_progress", label: "进行中" },
  { key: "review", label: "评审中" },
  { key: "completed", label: "已完成" },
  { key: "blocked", label: "受阻" },
  { key: "paused", label: "已暂停" },
];

function readinessLabel(label: string): string {
  return {
    unassessed: "待评估",
    blocked: "存在阻塞",
    ready: "已就绪",
    partial: "部分就绪",
  }[label] ?? "待评估";
}

function availabilityLabel(value: string): string {
  return {
    available: "可用",
    partial: "部分可用",
    unavailable: "不可用",
    unknown: "未校验",
  }[value] ?? value;
}

function resourceKindLabel(value: string): string {
  return {
    knowledge: "知识库",
    skill: "Skill",
    mcp: "MCP",
    agent: "Agent",
    tool: "工具",
    template: "模板",
    workflow: "工作流",
  }[value] ?? value;
}

export interface ProjectHubPanelProps {
  /** 打开既有规划编辑器（兼容深链）：传入当前 active 计划 ID。 */
  onOpenPlanning?: (planId: string | null) => void;
}

export default function ProjectHubPanel({ onOpenPlanning }: ProjectHubPanelProps = {}) {
  // 全局项目上下文（ADR-0010）：本面板不再维护第二份项目列表/选择状态，
  // 快照只由全局 projectId 驱动；列表与选择器统一由 Shell 顶栏提供。
  const {
    projectId,
    selectedProject,
    projects,
    projectsLoading,
    projectsError,
    selectProject,
    refreshProjects,
  } = useProjectContext();
  const showToast = useUiStore((s) => s.showToast);
  const [snapshot, setSnapshot] = useState<ProjectHubSnapshot | null>(null);
  const [view, setView] = useState<HubView>("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<CreateMode | null>(null);
  // 规划编辑视图：默认概览；编辑模式复用 PlanningWorkspace，不复制第二套 CRUD。
  const [planningMode, setPlanningMode] = useState<"summary" | "edit">("summary");
  const loadSeq = useRef(0);
  // 专业摘要只在「总览」视图挂载；用户点刷新时递增，触发一次手动重取（不轮询）。
  const [domainRefreshToken, setDomainRefreshToken] = useState(0);
  // 刷新按钮等延迟回调需要「最新」projectId，不能捕获点击时的旧值。
  const projectIdRef = useRef<string | null>(projectId);
  // 手动刷新时保留当前快照：否则 `active` 归零，整块总览（含专业摘要）卸载重建，
  // 会让同一次刷新重复请求一次领域聚合。
  const snapshotRef = useRef<ProjectHubSnapshot | null>(null);
  snapshotRef.current = snapshot;

  // 快照加载：代际防乱序 + 归属校验（返回的 project.id 必须等于请求的 projectId）。
  // 每次请求先递增代际并丢弃旧快照；无 id 也递增，让在途旧请求返回时自然失效。
  // `keepCurrent` 仅用于手动刷新同一项目：保留旧快照直到新快照落地，避免总览整体重建。
  const reloadSnapshot = useCallback(async (id: string | null, options?: { keepCurrent?: boolean }) => {
    const seq = ++loadSeq.current;
    if (!id) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }
    // 只有「同一个 id 且明确要求保留」才沿用旧快照；切项目必须立刻清空，防止串数据。
    const keepCurrent = options?.keepCurrent === true && snapshotRef.current?.project.id === id;
    if (!keepCurrent) setSnapshot(null);
    setLoading(true);
    setError(null);
    try {
      const next = await projectHubGetProject(id);
      if (seq !== loadSeq.current) return;
      if (next.project.id !== id) {
        // 一致性错误不落地：宁可如实报错，也不用错项目数据渲染。
        setSnapshot(null);
        setError("项目快照与请求的项目不一致，请重试");
        return;
      }
      setSnapshot(next);
    } catch (cause) {
      if (seq === loadSeq.current) {
        // 失败不是「无数据」：清掉旧快照，给出可区分的错误态。
        setSnapshot(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    projectIdRef.current = projectId;
    void reloadSnapshot(projectId);
  }, [projectId, reloadSnapshot]);

  // 渲染归属保护：快照只属于当前全局 projectId，竞态漏网时也不串数据。
  const active = snapshot?.project.id === projectId ? snapshot : null;

  // 进度口径统一走领域函数：阶段按功能 + 交付物，整体按阶段等权。
  const progress = useMemo(
    () => (active ? calculateProjectProgress(buildProgressInput(active)) : null),
    [active],
  );
  const phases = useMemo(() => (active ? buildPhaseSummaries(active) : []), [active]);
  const current = useMemo(() => (active ? currentPhaseOf(active) : null), [active]);
  const status = useMemo(
    () => (active ? calculateCapabilityReadiness(buildCapabilityInput(active)) : null),
    [active],
  );

  // 创建项目（ADR-0010）：创建成功后先关闭表单，再刷新 Shell 项目列表并经全局
  // 上下文切换到新项目根；快照由 projectId 变化触发重载，不手动强插 created。
  // 切换失败时如实提示「已创建但未切换」，保留当前项目上下文且不重复创建。
  const onCreate = async (input: ProjectHubCreateInput) => {
    const created = await projectHubCreateProject(input);
    setCreateMode(null);
    setView("overview");
    await refreshProjects();
    const switched = await selectProject(created.project.id);
    if (!switched) {
      showToast(`项目「${created.project.name}」已创建，但全局项目切换未完成`, {
        kind: "warning",
      });
    }
  };

  return (
    <div className="project-hub page-fill">
      <div className="ph-toolbar">
        {/* 全局上下文只读展示（ADR-0010）：项目根选择器唯一在 Shell 顶栏。 */}
        <div className="ph-project-select">
          <span>当前项目</span>
          <strong className="ph-project-name">
            {selectedProject?.name ?? (projectId ? "…" : "未选择项目")}
          </strong>
        </div>
        <div className="ph-toolbar-meta">
          共 {projects.length} 个项目 · 阶段 {active?.project.phaseCount ?? 0} · 任务{" "}
          {active?.project.taskCount ?? 0}
        </div>
        <button
          className="btn btn-ghost btn-sm"
          // 刷新期间内容仍可见（keepCurrent），禁用按钮避免重复点击叠加请求。
          disabled={loading}
          onClick={() => {
            setDomainRefreshToken((n) => n + 1);
            void refreshProjects().then(() =>
              reloadSnapshot(projectIdRef.current, { keepCurrent: true }),
            );
          }}
        >
          刷新
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setCreateMode("intent")}>
          <Plus size={14} /> 新建项目
        </button>
      </div>

      {error ? (
        <div className="ph-error" role="alert">
          <AlertTriangle size={16} /> {error}
          <button className="btn btn-ghost btn-sm" onClick={() => void reloadSnapshot(projectId)}>
            重试
          </button>
        </div>
      ) : null}

      {/* 列表加载失败：明确错误态 + 重试，绝不伪装成「还没有项目」。 */}
      {!projectsLoading && projectsError ? (
        <div className="ph-error" role="alert">
          <AlertTriangle size={16} /> 项目列表加载失败：{projectsError}
          <button className="btn btn-ghost btn-sm" onClick={() => void refreshProjects()}>
            重试
          </button>
        </div>
      ) : null}

      {!projectsLoading && !projectsError && projects.length === 0 ? (
        <div className="ph-empty">
          <Sparkles size={28} />
          <h3>还没有项目</h3>
          <p>告诉 TaskDock 你想完成什么，它会先生成一份可修改的项目草案。</p>
          <button className="btn btn-primary" onClick={() => setCreateMode("intent")}>
            开始规划
          </button>
        </div>
      ) : null}

      {/* 有项目但全局未选择：引导到顶栏选择器，不静默挑第一个项目。 */}
      {!projectsLoading && !projectId && projects.length > 0 ? (
        <div className="ph-empty">
          <Sparkles size={28} />
          <h3>尚未选择项目</h3>
          <p>使用顶栏的项目选择器选择一个项目，或创建新项目。</p>
          <button className="btn btn-primary" onClick={() => setCreateMode("intent")}>
            新建项目
          </button>
        </div>
      ) : null}

      {loading && !active ? (
        <p className="ph-muted" role="status">
          正在加载项目…
        </p>
      ) : null}

      {active ? (
        <div className="ph-layout">
          <section className="ph-hero">
            <div>
              <div className="ph-hero-eyebrow">{KIND_LABELS[active.project.kind as ProjectKind] ?? active.project.kind}</div>
              <h2>{active.project.name}</h2>
              <p>{active.project.goal || "还没有写项目目标。"}</p>
            </div>
            <div className="ph-hero-side">
              <span>当前阶段</span>
              <strong>{current?.title ?? "全部阶段已完成"}</strong>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void openProjectWorkspaceWindow({ projectId: active.project.id })}
              >
                <FolderOpen size={14} /> 打开工作空间
              </button>
            </div>
          </section>

          <div className="ph-metrics">
            <Metric
              label="任务完成"
              value={progress ? metricText(progress.tasks.percent) : "待评估"}
              hint={progress ? `${progress.tasks.completed}/${progress.tasks.total}` : ""}
            />
            <Metric
              label="阶段完成"
              value={progress ? metricText(progress.phases.percent) : "待评估"}
              hint={progress ? progress.phases.note : ""}
            />
            <Metric
              label="里程碑"
              value={progress ? metricText(progress.milestones.percent) : "待评估"}
              hint={progress ? progress.milestones.note : ""}
            />
            <Metric
              label="整体进度"
              value={progress ? metricText(progress.overall.percent) : "待评估"}
              hint={progress ? progress.overall.note : ""}
            />
            <Metric
              label="能力准备"
              value={status ? readinessLabel(status.label) : "待评估"}
              hint={status ? `${status.assessedCount}/${active.capabilities.length} 已评估` : ""}
            />
            <Metric label="交付物" value={String(active.project.deliverableCount)} hint="已记录" />
          </div>

          <SectionTabs
            items={VIEW_TABS.map((tab) => ({ id: tab.key, label: tab.label, icon: tab.icon }))}
            activeId={view}
            onChange={setView}
            aria-label="项目中枢视图"
            idPrefix="ph"
          />

          {view === "overview" ? (
            <div
              id="ph-panel-overview"
              role="tabpanel"
              aria-labelledby="ph-tab-overview"
              className="ph-view ph-overview"
            >
              {/* 专业工作进展：只读摘要，失败/为空都不影响下方公共项目视图。 */}
              <ProjectHubDomainSummary
                projectId={active.project.id}
                projectKind={active.project.kind}
                refreshToken={domainRefreshToken}
              />
              <section className="ph-section">
                <h3><Target size={16} /> 下一步</h3>
                {active.risks.length > 0 ? (
                  <ul className="ph-list warn">
                    {active.risks.slice(0, 5).map((risk) => <li key={risk}>{risk}</li>)}
                  </ul>
                ) : (
                  <p className="ph-muted">当前没有检测到阻塞项。继续推进当前阶段任务。</p>
                )}
                <div className="ph-next">
                  {!active.planId ? "项目还没有计划" : current ? `推进「${current.title}」` : "阶段已全部完成"}
                  <ArrowUpRight size={14} />
                </div>
              </section>
              <section className="ph-section">
                <h3><BookOpen size={16} /> 最近活动</h3>
                {active.events.length === 0 ? <p className="ph-muted">暂无活动记录。</p> : (
                  <ul className="ph-events">
                    {active.events.slice(0, 6).map((event) => (
                      <li key={event.id}>
                        <span>{event.summary || event.kind}</span>
                        <time>{event.createdAt.slice(0, 10)}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="ph-section">
                <h3><FolderOpen size={16} /> 最近产出</h3>
                {active.deliverables.length === 0 ? (
                  <p className="ph-muted">还没有记录交付物。</p>
                ) : (
                  <ul className="ph-list">
                    {active.deliverables.slice(0, 4).map((item) => (
                      <li key={item.id}>
                        <span className={`ph-dot ${item.status === "accepted" ? "ok" : ""}`} />
                        <span>{item.title}</span>
                        <time>{item.acceptedAt?.slice(0, 10) ?? item.producedAt?.slice(0, 10) ?? ""}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          ) : null}

          {view === "planning" ? (
            <div id="ph-panel-planning" role="tabpanel" aria-labelledby="ph-tab-planning" className="ph-view">
              <div className="ph-section-head">
                <div className="seg-group" role="group" aria-label="规划视图">
                  <button
                    className={`seg-btn ${planningMode === "summary" ? "active" : ""}`}
                    aria-pressed={planningMode === "summary"}
                    onClick={() => setPlanningMode("summary")}
                  >
                    概览
                  </button>
                  <button
                    className={`seg-btn ${planningMode === "edit" ? "active" : ""}`}
                    aria-pressed={planningMode === "edit"}
                    onClick={() => setPlanningMode("edit")}
                  >
                    编辑阶段与功能
                  </button>
                </div>
                {onOpenPlanning ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => onOpenPlanning(active.planId)}
                  >
                    在规划中心打开（兼容入口）
                  </button>
                ) : null}
              </div>
              {planningMode === "edit" ? (
                <section className="ph-section ph-embed" aria-label="规划编辑（复用规划工作区）">
                  {active.planId ? (
                    <PlanningWorkspace initialPlanId={active.planId} />
                  ) : (
                    <p className="ph-muted">项目还没有计划，先在概览里创建计划后再编辑阶段与功能。</p>
                  )}
                </section>
              ) : null}
              {planningMode === "summary" ? (
              <>
              <section className="ph-section">
                <div className="ph-section-head">
                  <h3><Target size={16} /> 目标</h3>
                </div>
                {active.goals.length === 0 ? (
                  <p className="ph-muted">还没有目标。可以回到规划编辑器补充，或用自然语言重新规划。</p>
                ) : (
                  <ul className="ph-list">
                    {active.goals.map((goal) => (
                      <li key={goal.id}>
                        <span className={`ph-dot ${goal.status === "achieved" ? "ok" : ""}`} />
                        {goal.title}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="ph-section">
                <h3><Layers size={16} /> 阶段与里程碑</h3>
                {active.phases.length === 0 ? (
                  <p className="ph-muted">还没有阶段。可以回到规划编辑器补充，或用自然语言重新规划。</p>
                ) : (
                  <div className="ph-phases">
                    {active.phases.map((phase) => {
                      const summary = phases.find((item) => item.id === phase.id);
                      const milestones = active.milestones.filter((item) => item.phaseId === phase.id);
                      return (
                        <div className="ph-phase" key={phase.id}>
                          <div className="ph-phase-head">
                            <strong>{phase.name}</strong>
                            <span>
                              {summary?.status === "completed"
                                ? "已完成"
                                : phase.featureCount > 0
                                  ? `功能 ${phase.completedFeatureCount}/${phase.featureCount}`
                                  : phase.taskCount > 0
                                    ? `任务 ${phase.completedTaskCount}/${phase.taskCount}`
                                    : "待评估"}
                            </span>
                          </div>
                          <p>{phase.description || "（无说明）"}</p>
                          {milestones.length > 0 ? (
                            <ul className="ph-milestones">
                              {milestones.map((milestone) => (
                                <li key={milestone.id}>
                                  <CircleDashed size={13} /> {milestone.name}
                                  {milestone.targetDate ? <time>{milestone.targetDate}</time> : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
              </>
              ) : null}
            </div>
          ) : null}

          {view === "features" ? (
            <div id="ph-panel-features" role="tabpanel" aria-labelledby="ph-tab-features" className="ph-view">
              <section className="ph-section">
                <h3><KanbanSquare size={16} /> 功能与看板</h3>
                {active.features.length === 0 ? (
                  <p className="ph-muted">还没有功能。创建项目时的功能草案会直接落库，也可以在规划编辑器里补充。</p>
                ) : (
                  <div className="ph-board">
                    {FEATURE_COLUMNS.map((column) => {
                      const items = active.features.filter((feature) => feature.status === column.key);
                      if (items.length === 0) return null;
                      return (
                        <div className="ph-board-col" key={column.key}>
                          <h4>{column.label}（{items.length}）</h4>
                          <ul>
                            {items.map((feature) => (
                              <li key={feature.id}>
                                <strong>{feature.title}</strong>
                                <small>
                                  {feature.priority}
                                  {feature.acceptanceCriteria ? ` · ${feature.acceptanceCriteria}` : ""}
                                </small>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {view === "capability" ? (
            <div id="ph-panel-capability" role="tabpanel" aria-labelledby="ph-tab-capability" className="ph-view">
              <section className="ph-section">
                <h3><Boxes size={16} /> 能力需求与缺口</h3>
                {active.capabilities.length === 0 ? (
                  <p className="ph-muted">还没有能力需求。创建项目时可以由目标自动推断，也可以在能力中心补充。</p>
                ) : (
                  <div className="ph-cap-list">
                    {active.capabilities.map((capability) => (
                      <div className="ph-cap" key={capability.id}>
                        <div>
                          <strong>{capability.name}</strong>
                          <span className={`ph-tag ${capability.necessity}`}>{necessityLabel(capability.necessity)}</span>
                        </div>
                        <p>
                          {capability.assessmentLevel && capability.assessmentLevel !== "unknown"
                            ? `${masteryLabel(capability.assessmentLevel)} · ${capability.category}`
                            : capability.mastery && capability.mastery !== "unknown"
                              ? `${masteryLabel(capability.mastery)} · ${capability.category}`
                              : "掌握程度待评估"}
                        </p>
                        <p>
                          {capability.resourceCount === 0
                            ? "没有关联资源"
                            : capability.verifiedResourceCount === 0
                              ? `已关联 ${capability.resourceCount} 个资源，尚未校验可用性`
                              : `${capability.availableResourceCount}/${capability.resourceCount} 个资源可用`}
                        </p>
                        {capability.impact ? <small>影响：{capability.impact}</small> : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {view === "resources" ? (
            <div id="ph-panel-resources" role="tabpanel" aria-labelledby="ph-tab-resources">
              <ResourceView projectId={active.project.id} capabilities={active.capabilities} />
            </div>
          ) : null}

          {view === "execution" ? (
            <div id="ph-panel-execution" role="tabpanel" aria-labelledby="ph-tab-execution" className="ph-view">
              <section className="ph-section">
                <h3><ListChecks size={16} /> 项目任务</h3>
                {active.tasks.length === 0 ? <p className="ph-muted">还没有任务。</p> : (
                  <ul className="ph-tasks">
                    {active.tasks.map((task) => (
                      <li key={task.id}>
                        {task.status === "completed" ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}
                        <span className={task.status === "completed" ? "done" : ""}>{task.title}</span>
                        {task.dueAt ? <time>{task.dueAt.slice(0, 10)}</time> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="ph-section">
                <h3><FolderOpen size={16} /> 交付物</h3>
                {active.deliverables.length === 0 ? <p className="ph-muted">还没有记录交付物。</p> : (
                  <ul className="ph-list">
                    {active.deliverables.map((item) => (
                      <li key={item.id}>{item.title}<span className="ph-tag">{item.status}</span></li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          ) : null}
        </div>
      ) : null}

      {createMode ? (
        <CreateProjectDialog
          mode={createMode}
          onModeChange={setCreateMode}
          onClose={() => setCreateMode(null)}
          onCreate={onCreate}
        />
      ) : null}
    </div>
  );
}

function metricText(value: number | null): string {
  return value === null ? "待评估" : `${Math.round(value * 10) / 10}%`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="ph-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function necessityLabel(value: string): string {
  return { required: "必需", recommended: "推荐", optional: "可选" }[value] ?? value;
}

function masteryLabel(value: string): string {
  return {
    expert: "专家",
    proficient: "熟练",
    basic: "基础",
    learning: "学习中",
    none: "缺失",
    unknown: "待评估",
  }[value] ?? value;
}

/** 项目资源视图：真实查询、绑定、解除绑定与可用性校验。 */
function ResourceView({
  projectId,
  capabilities,
}: {
  projectId: string;
  capabilities: ProjectHubSnapshot["capabilities"];
}) {
  const [links, setLinks] = useState<ProjectHubResourceLink[]>([]);
  const [candidates, setCandidates] = useState<ProjectHubResourceCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bindKind, setBindKind] = useState<string>("knowledge");
  const [bindCapabilityId, setBindCapabilityId] = useState<string>("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [linkRows, candidateRows] = await Promise.all([
        projectHubResourceLinks(projectId),
        projectHubResourceCandidates(projectId, bindKind),
      ]);
      setLinks(linkRows);
      setCandidates(candidateRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, bindKind]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const bind = async (resourceId: string) => {
    const capabilityId = bindCapabilityId || capabilities[0]?.capabilityId;
    if (!capabilityId) return;
    setError(null);
    try {
      await projectHubResourceLink(projectId, {
        capabilityId,
        resourceKind: bindKind,
        resourceId,
      });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const unlink = async (linkId: string) => {
    setError(null);
    try {
      await projectHubResourceUnlink(projectId, linkId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const validate = async (linkId: string) => {
    setError(null);
    try {
      await projectHubResourceValidate(projectId, linkId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="ph-view">
      <section className="ph-section">
        <h3><Link2 size={16} /> 已关联资源</h3>
        {error ? (
          <div className="ph-dialog-error" role="alert">
            <AlertTriangle size={14} /> {error}
          </div>
        ) : null}
        {links.length === 0 ? (
          <p className="ph-muted">还没有关联资源。能力是「能不能做」，资源是「有没有可调用的东西」，两者分开管理。</p>
        ) : (
          <ul className="ph-list">
            {links.map((link) => (
              <li key={link.id}>
                <span className="ph-tag">{resourceKindLabel(link.resourceKind)}</span>
                <span>{link.label || link.resourceId}</span>
                {link.scope === "global" ? <span className="ph-tag">共享</span> : null}
                <span className="ph-muted">
                  {link.capabilityName} · {availabilityLabel(link.availability)}
                  {link.lastCheckedAt ? ` · ${link.lastCheckedAt.slice(0, 10)}` : ""}
                  {link.detail ? ` · ${link.detail}` : ""}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => void validate(link.id)}>
                  校验可用性
                </button>
                {/* 共享关联对其他项目可见，但解除权只属于创建者：不展示注定 403 的按钮。 */}
                {link.projectId === projectId ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => void unlink(link.id)}>
                    <Unlink size={13} /> 解除
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ph-section">
        <h3><Plus size={16} /> 关联新资源</h3>
        <div className="ph-bind-row">
          <label className="field">
            <span>资源类型</span>
            <select
              className="select"
              value={bindKind}
              onChange={(event) => setBindKind(event.target.value)}
              aria-label="资源类型"
            >
              {["knowledge", "skill", "mcp", "agent", "workflow"].map((kind) => (
                <option key={kind} value={kind}>
                  {resourceKindLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>关联到能力</span>
            <select
              className="select"
              value={bindCapabilityId}
              onChange={(event) => setBindCapabilityId(event.target.value)}
              aria-label="关联到能力"
            >
              <option value="">（默认第一个能力）</option>
              {capabilities.map((capability) => (
                <option key={capability.capabilityId} value={capability.capabilityId}>
                  {capability.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p className="ph-muted">正在读取资源…</p>
        ) : candidates.length === 0 ? (
          <p className="ph-muted">没有可关联的资源。{resourceKindLabel(bindKind)} 资源库当前为空。</p>
        ) : (
          <ul className="ph-list">
            {candidates.map((candidate) => (
              <li key={`${candidate.kind}:${candidate.id}`}>
                <span>{candidate.label}</span>
                <span className="ph-muted">
                  {resourceKindLabel(candidate.kind)} · {candidate.scope === "project" ? "项目内" : "全局"} ·{" "}
                  {availabilityLabel(candidate.availability)}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void bind(candidate.id)}
                  disabled={capabilities.length === 0}
                >
                  关联
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateProjectDialog({
  mode,
  onModeChange,
  onClose,
  onCreate,
}: {
  mode: CreateMode;
  onModeChange: (mode: CreateMode) => void;
  onClose: () => void;
  onCreate: (input: ProjectHubCreateInput) => Promise<void>;
}) {
  const [intentText, setIntentText] = useState("");
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [manualName, setManualName] = useState("");
  const [manualKind, setManualKind] = useState<ProjectKind>("general");
  const [manualGoal, setManualGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 同一份草案重试复用同一个请求 ID；参数变化或创建成功后重置。
  const requestIdRef = useRef({ id: "", signature: "" });

  const preview = useMemo(() => {
    if (!draft) return null;
    return {
      name: draft.name,
      kind: draft.kind,
      goal: draft.goal,
      phases: draft.phases,
      capabilities: draft.capabilityRequirements,
      uncertainties: draft.uncertainties,
      featureCount: draft.phases.reduce((sum, phase) => sum + phase.features.length, 0),
    };
  }, [draft]);

  const startIntent = () => {
    const text = intentText.trim();
    if (!text) {
      setError("先写一句你想完成什么。");
      return;
    }
    setError(null);
    const intent = parseProjectIntent(text);
    setDraft(generateProjectDraft(intent));
  };

  const useTemplate = (kind: ProjectKind) => {
    const intent = parseProjectIntent("");
    const next = generateProjectDraft(intent, { templateId: kind });
    setDraft(next);
    onModeChange("template");
  };

  const confirmDraft = async (value: ProjectDraft) => {
    if (!value.name.trim()) {
      setError("项目名称不能为空。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 唯一转换点：草案 → 载荷（未分配阶段为 null，能力带阶段归属）。
      const payload = buildCreatePayload(value);
      const signature = requestSignature(payload as Record<string, unknown>);
      const resolved = resolveRequestId(requestIdRef.current, signature, createRequestId);
      requestIdRef.current = resolved.state;
      await onCreate({ ...payload, clientRequestId: resolved.id });
      // 创建成功：清理请求 ID，下一次创建必然是新的请求。
      requestIdRef.current = clearRequestIdState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmManual = async () => {
    if (!manualName.trim()) {
      setError("项目名称不能为空。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = buildManualCreatePayload({
        name: manualName,
        kind: manualKind,
        goal: manualGoal,
      });
      const signature = requestSignature(payload as Record<string, unknown>);
      const resolved = resolveRequestId(requestIdRef.current, signature, createRequestId);
      requestIdRef.current = resolved.state;
      await onCreate({ ...payload, clientRequestId: resolved.id });
      requestIdRef.current = clearRequestIdState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={mode === "manual" ? "手动创建项目" : "你想完成什么？"}
      size="lg"
      panelClassName="ph-dialog-panel"
      dismissOnScrim={!busy}
    >
      <div className="ph-dialog-body">
        <p className="ph-muted">
          {mode === "intent"
            ? "一句话描述目标，TaskDock 先生成可修改的草案；确认前不会写入正式项目数据。"
            : "选择模板或手动填写；确认前不会写入正式项目数据。"}
        </p>

        <div className="ph-mode-switch">
          <button className={`seg-btn ${mode === "intent" ? "active" : ""}`} onClick={() => onModeChange("intent")}>自然语言</button>
          <button className={`seg-btn ${mode === "template" ? "active" : ""}`} onClick={() => onModeChange("template")}>使用模板</button>
          <button className={`seg-btn ${mode === "manual" ? "active" : ""}`} onClick={() => onModeChange("manual")}>手动创建</button>
        </div>

        {mode === "intent" ? (
          <div className="ph-create-body">
            <textarea
              className="textarea ph-intent"
              value={intentText}
              onChange={(event) => setIntentText(event.target.value)}
              placeholder="例如：我要在六个月内完成一款 2D Roguelike 游戏的垂直切片。"
              rows={4}
              autoFocus
            />
            <div className="ph-create-actions">
              <button className="btn btn-primary" onClick={startIntent}>开始规划</button>
              <button className="btn btn-ghost" onClick={() => onModeChange("template")}>使用模板</button>
            </div>
          </div>
        ) : null}

        {mode === "template" ? (
          <div className="ph-template-list">
            {KIND_OPTIONS.map((kind) => (
              <button key={kind} className="ph-template" onClick={() => useTemplate(kind)}>
                <strong>{KIND_LABELS[kind]}</strong>
                <span>{kindHint(kind)}</span>
              </button>
            ))}
          </div>
        ) : null}

        {mode === "manual" ? (
          <div className="ph-create-body">
            <label className="field"><span>项目名称</span><input className="input" value={manualName} onChange={(e) => setManualName(e.target.value)} autoFocus /></label>
            <label className="field"><span>项目类型</span>
              <select className="select" value={manualKind} onChange={(e) => setManualKind(e.target.value as ProjectKind)}>
                {KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
              </select>
            </label>
            <label className="field"><span>目标（可选）</span><textarea className="textarea" rows={3} value={manualGoal} onChange={(e) => setManualGoal(e.target.value)} /></label>
            <div className="ph-create-actions">
              <button className="btn btn-primary" onClick={() => void confirmManual()} disabled={busy}>创建项目</button>
              <button className="btn btn-ghost" onClick={() => onModeChange("intent")}>返回自然语言</button>
            </div>
          </div>
        ) : null}

        {draft && preview ? (
          <div className="ph-draft">
            <div className="ph-draft-head">
              <label className="field"><span>项目名称</span>
                <input className="input" value={draft.name} onChange={(e) => setDraft(cloneProjectDraft({ ...draft, name: e.target.value }))} />
              </label>
              <span className="ph-tag">{KIND_LABELS[draft.kind]}</span>
            </div>
            <label className="field"><span>核心目标</span>
              <textarea className="textarea" rows={2} value={draft.goal} onChange={(e) => setDraft(cloneProjectDraft({ ...draft, goal: e.target.value }))} />
            </label>
            <div className="ph-draft-grid">
              <div>
                <h4>阶段与里程碑（{preview.phases.length}）</h4>
                <ul>{preview.phases.map((phase) => (
                  <li key={phase.id}>
                    <span>{phase.title}</span>
                    <small>
                      {phase.features.length} 项功能 ·{" "}
                      {phase.milestoneTitles.length > 0 ? phase.milestoneTitles.join(" / ") : "无里程碑"}
                    </small>
                  </li>
                ))}</ul>
              </div>
              <div>
                <h4>能力需求（{preview.capabilities.length}）</h4>
                <ul>{preview.capabilities.map((capability) => <li key={capability.key}>{capability.name}<small>{necessityLabel(capability.necessity)} · {capability.targetLevel}</small></li>)}</ul>
              </div>
              <div>
                <h4>预计产出（{preview.featureCount} 项功能，将随项目一起保存）</h4>
                {preview.featureCount > 0 ? (
                  <ul>
                    {draft.phases
                      .flatMap((phase) => phase.features)
                      .slice(0, 6)
                      .map((feature) => <li key={feature.id}>{feature.title}<small>{feature.priority}</small></li>)}
                  </ul>
                ) : (
                  <p className="ph-muted">还没有功能草稿，创建后可在规划中补充。</p>
                )}
              </div>
              <div>
                <h4>初始任务（{draft.tasks.length}）</h4>
                {draft.tasks.length > 0 ? (
                  <ul>
                    {draft.tasks.slice(0, 6).map((task) => {
                      const phase = draft.phases.find((item) => item.id === task.phaseId);
                      return <li key={task.id}>{task.title}<small>{phase?.title ?? "未分阶段"}</small></li>;
                    })}
                  </ul>
                ) : (
                  <p className="ph-muted">暂无初始任务，创建后可在执行视图补充。</p>
                )}
              </div>
            </div>
            <div className="ph-uncertain">
              <h4>工作空间建议（仅建议，创建时不会自动创建工作空间）</h4>
              <p>{draft.workspace.note || "创建后可在工作空间中登记项目根目录。"}</p>
              <p>建议模块：{draft.workspace.moduleHints.join(" / ") || "按项目类型自动选择"}</p>
              {draft.workspace.rootPathHint ? <p>根目录：{draft.workspace.rootPathHint}</p> : null}
            </div>
            {preview.uncertainties.length > 0 ? (
              <div className="ph-uncertain">
                <h4>仍不确定</h4>
                {preview.uncertainties.map((item) => <p key={item.id}>{item.question}{item.blocking ? "（会影响规划）" : ""}</p>)}
              </div>
            ) : null}
            <div className="ph-uncertain" role="note">
              <h4>创建后会保存什么</h4>
              <p>会写入：项目名称 / 类型 / 描述 / 目标 / 目标日期、阶段与里程碑、功能草案（含所属阶段）、初始任务、能力需求（含阶段归属）。</p>
              <p>
                本轮<b>不保存</b>：约束 {draft.constraints.length} 条、风险 {draft.risks.length} 条、不确定项{" "}
                {draft.uncertainties.length} 条、工作空间路径建议。它们只用于本次草案预览，创建后不会出现在数据库里。
              </p>
            </div>
            <div className="ph-create-actions">
              <button className="btn btn-primary" onClick={() => void confirmDraft(draft)} disabled={busy}>确认并创建</button>
              <button className="btn btn-ghost" onClick={() => setDraft(null)} disabled={busy}>重新描述</button>
            </div>
          </div>
        ) : null}

        {error ? <div className="ph-dialog-error" role="alert"><AlertTriangle size={14} /> {error}</div> : null}
      </div>
    </Dialog>
  );
}

function kindHint(kind: ProjectKind): string {
  return {
    novel: "世界观、人物、分卷、章节",
    game: "设计、原型、玩法、美术、测试",
    ai_comic: "故事、剧本、分镜、画面、配音",
    general: "自定义目标与阶段",
    development: "需求、架构、开发、测试、部署",
  }[kind] ?? "自定义";
}
