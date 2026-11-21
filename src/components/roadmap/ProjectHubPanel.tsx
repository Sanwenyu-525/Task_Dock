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
  projectHubListProjects,
  projectHubResourceCandidates,
  projectHubResourceLink,
  projectHubResourceLinks,
  projectHubResourceUnlink,
  projectHubResourceValidate,
  type ProjectHubCreateInput,
  type ProjectHubProjectSummary,
  type ProjectHubResourceCandidate,
  type ProjectHubResourceLink,
  type ProjectHubSnapshot,
} from "../../lib/bridge";
import {
  buildCapabilityInput,
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
  const [projects, setProjects] = useState<ProjectHubProjectSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ProjectHubSnapshot | null>(null);
  const [view, setView] = useState<HubView>("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<CreateMode | null>(null);
  const loadSeq = useRef(0);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await projectHubListProjects();
      setProjects(rows);
      setSelectedId((current) => current ?? rows[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedId) {
      setSnapshot(null);
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    projectHubGetProject(selectedId)
      .then((next) => {
        if (seq === loadSeq.current) setSnapshot(next);
      })
      .catch((cause) => {
        if (seq === loadSeq.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false);
      });
  }, [selectedId]);

  const active = snapshot;

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

  const onCreate = async (input: ProjectHubCreateInput) => {
    const created = await projectHubCreateProject(input);
    setProjects((rows) => {
      const without = rows.filter((row) => row.id !== created.project.id);
      return [created.project, ...without];
    });
    setSelectedId(created.project.id);
    setSnapshot(created);
    setCreateMode(null);
    setView("overview");
  };

  return (
    <div className="project-hub page-fill">
      <div className="ph-toolbar">
        <label className="ph-project-select">
          <span>当前项目</span>
          <select
            className="select"
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(event.target.value || null)}
            disabled={projects.length === 0}
            aria-label="选择项目"
          >
            {projects.length === 0 ? <option value="">暂无项目</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <div className="ph-toolbar-meta">
          got {projects.length} 个项目 · 阶段 {active?.project.phaseCount ?? 0} · 任务{" "}
          {active?.project.taskCount ?? 0}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void loadProjects()}>
          刷新
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setCreateMode("intent")}>
          <Plus size={14} /> 新建项目
        </button>
      </div>

      {error ? (
        <div className="ph-error" role="alert">
          <AlertTriangle size={16} /> {error}
          <button className="btn btn-ghost btn-sm" onClick={() => void loadProjects()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && projects.length === 0 ? (
        <div className="ph-empty">
          <Sparkles size={28} />
          <h3>还没有项目</h3>
          <p>告诉 TaskDock 你想完成什么，它会先生成一份可修改的项目草案。</p>
          <button className="btn btn-primary" onClick={() => setCreateMode("intent")}>
            开始规划
          </button>
        </div>
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

          <div className="ph-tabs" role="tablist" aria-label="项目中枢视图">
            {VIEW_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  role="tab"
                  aria-selected={view === tab.key}
                  className={`seg-btn ${view === tab.key ? "active" : ""}`}
                  onClick={() => setView(tab.key)}
                >
                  <Icon size={14} /> {tab.label}
                </button>
              );
            })}
          </div>

          {view === "overview" ? (
            <div className="ph-view ph-overview">
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
            <div className="ph-view">
              <section className="ph-section">
                <div className="ph-section-head">
                  <h3><Target size={16} /> 目标</h3>
                  {onOpenPlanning ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => onOpenPlanning(active.planId)}
                    >
                      在规划编辑器中打开
                    </button>
                  ) : null}
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
            </div>
          ) : null}

          {view === "features" ? (
            <div className="ph-view">
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
            <div className="ph-view">
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
            <ResourceView projectId={active.project.id} capabilities={active.capabilities} />
          ) : null}

          {view === "execution" ? (
            <div className="ph-view">
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
                <span className="ph-muted">
                  {link.capabilityName} · {availabilityLabel(link.availability)}
                  {link.lastCheckedAt ? ` · ${link.lastCheckedAt.slice(0, 10)}` : ""}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => void validate(link.id)}>
                  校验可用性
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => void unlink(link.id)}>
                  <Unlink size={13} /> 解除
                </button>
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
              {["knowledge", "skill", "mcp", "agent"].map((kind) => (
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
      const payload: Omit<ProjectHubCreateInput, "clientRequestId"> = {
        name: value.name.trim(),
        kind: value.kind,
        description: value.description,
        goal: value.goal,
        targetDate: value.targetDate,
        templateId: value.templateId,
        goals: value.goal ? [{ title: value.goal }] : [],
        phases: value.phases.map((phase) => ({
          name: phase.title,
          description: phase.purpose,
          targetDate: phase.targetDate,
          startDate: phase.startDate,
          milestones: phase.milestoneTitles.map((name) => ({ name })),
        })),
        features: value.phases.flatMap((phase) =>
          phase.features.map((feature) => ({
            title: feature.title,
            acceptance: feature.acceptance,
            priority: feature.priority,
            phaseIndex: value.phases.findIndex((item) => item.id === phase.id),
          })),
        ),
        tasks: value.tasks.map((task) => ({
          title: task.title,
          description: "",
          phaseIndex: value.phases.findIndex((phase) => phase.id === task.phaseId),
          dueAt: task.dueDate,
          priority: task.priority === "P0" ? 0 : task.priority === "P1" ? 1 : 3,
        })),
        capabilities: value.capabilityRequirements.map((capability) => ({
          name: capability.name,
          category: capability.category,
          necessity: capability.necessity,
          targetLevel: capability.targetLevel,
          impact: capability.impact,
          alternative: capability.alternative,
        })),
      };
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
      const payload: Omit<ProjectHubCreateInput, "clientRequestId"> = {
        name: manualName.trim(),
        kind: manualKind,
        goal: manualGoal.trim(),
        phases: [],
        features: [],
        tasks: [],
        capabilities: [],
        goals: manualGoal.trim() ? [{ title: manualGoal.trim() }] : [],
      };
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
