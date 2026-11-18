//! 项目中枢（v78）：项目总览 / 规划 / 能力 / 执行 四视图。
//!
//! 交互原则：
//! - 默认入口是「你想完成什么？」自然语言描述；模板与手动创建保留为并列入口。
//! - 草案先预览、可改名/改目标，确认后才写库；没有 AI 时完全走本地解析。
//! - 进度与能力准备度使用已测试的领域函数；数据不足显示「待评估」，不编造百分比。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  CircleDashed,
  FolderOpen,
  Layers,
  LayoutDashboard,
  ListChecks,
  Plus,
  Sparkles,
  Target,
} from "lucide-react";
import {
  openProjectWorkspaceWindow,
  projectHubCreateProject,
  projectHubGetProject,
  projectHubListProjects,
  type ProjectHubCreateInput,
  type ProjectHubProjectSummary,
  type ProjectHubSnapshot,
} from "../../lib/bridge";
import {
  calculateCapabilityReadiness,
  cloneProjectDraft,
  generateProjectDraft,
  parseProjectIntent,
  KIND_LABELS,
} from "../../lib/projectHub";
import type { ProjectDraft, ProjectKind } from "../../lib/projectHub/types";
import { Dialog } from "../ui/Dialog";
import "./project-hub.css";

type HubView = "overview" | "planning" | "capability" | "execution";
type CreateMode = "intent" | "template" | "manual";

const VIEW_TABS: { key: HubView; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "总览", icon: LayoutDashboard },
  { key: "planning", label: "规划", icon: Layers },
  { key: "capability", label: "能力", icon: Boxes },
  { key: "execution", label: "执行", icon: ListChecks },
];

const KIND_OPTIONS: ProjectKind[] = ["novel", "game", "ai_comic", "general", "development"];

function percent(completed: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((completed / total) * 100);
}

function phasePercent(snapshot: ProjectHubSnapshot): number | null {
  if (snapshot.phases.length === 0) return null;
  const finished = snapshot.phases.filter(
    (phase) => phase.taskCount > 0 && phase.completedTaskCount === phase.taskCount,
  ).length;
  return Math.round((finished / snapshot.phases.length) * 100);
}

function currentPhase(snapshot: ProjectHubSnapshot) {
  return (
    snapshot.phases.find(
      (phase) => phase.taskCount > 0 && phase.completedTaskCount < phase.taskCount,
    ) ?? snapshot.phases[0] ?? null
  );
}

function readiness(snapshot: ProjectHubSnapshot) {
  const requirements = snapshot.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId,
    name: capability.name,
    category: capability.category as "human" | "tool" | "ai" | "agent" | "external",
    necessity: capability.necessity as "required" | "recommended" | "optional",
    phaseId: capability.phaseId,
    assessmentLevel: capability.assessmentLevel as
      | "expert"
      | "proficient"
      | "basic"
      | "learning"
      | "none"
      | null,
    libraryMastery: capability.mastery as
      | "expert"
      | "proficient"
      | "basic"
      | "learning"
      | "none"
      | "unknown",
    resource:
      capability.availableResourceCount > 0
        ? ("available" as const)
        : capability.resourceCount > 0
          ? ("partial" as const)
          : ("unknown" as const),
    impact: capability.impact,
    alternative: capability.alternative,
  }));
  return calculateCapabilityReadiness(requirements);
}

function readinessLabel(label: string): string {
  return {
    unassessed: "待评估",
    blocked: "存在阻塞",
    ready: "已就绪",
    partial: "部分就绪",
  }[label] ?? "待评估";
}

export default function ProjectHubPanel() {
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
  const current = active ? currentPhase(active) : null;
  const status = active ? readiness(active) : null;
  const taskPct = active ? percent(active.project.completedTaskCount, active.project.taskCount) : null;
  const phasePct = active ? phasePercent(active) : null;

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
              <strong>{current?.name ?? "未规划"}</strong>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void openProjectWorkspaceWindow({ projectId: active.project.id })}
              >
                <FolderOpen size={14} /> 打开工作空间
              </button>
            </div>
          </section>

          <div className="ph-metrics">
            <Metric label="任务完成" value={taskPct === null ? "待评估" : `${taskPct}%`} hint={`${active.project.completedTaskCount}/${active.project.taskCount}`} />
            <Metric label="阶段完成" value={phasePct === null ? "待评估" : `${phasePct}%`} hint={`${active.phases.length} 个阶段`} />
            <Metric label="能力准备" value={status ? readinessLabel(status.label) : "待评估"} hint={`${status?.assessedCount ?? 0}/${active.capabilities.length} 已评估`} />
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
                  {!active.planId ? "项目还没有计划" : current ? `推进「${current.name}」` : "补充阶段"}
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
              {active.goals.length > 0 ? (
                <section className="ph-section">
                  <h3><Target size={16} /> 目标</h3>
                  <ul className="ph-list">
                    {active.goals.map((goal) => (
                      <li key={goal.id}>
                        <span className={`ph-dot ${goal.status === "achieved" ? "ok" : ""}`} />
                        {goal.title}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section className="ph-section">
                <h3><Layers size={16} /> 阶段与里程碑</h3>
                {active.phases.length === 0 ? (
                  <p className="ph-muted">还没有阶段。可以回到规划编辑器补充，或用自然语言重新规划。</p>
                ) : (
                  <div className="ph-phases">
                    {active.phases.map((phase) => {
                      const milestones = active.milestones.filter((item) => item.phaseId === phase.id);
                      return (
                        <div className="ph-phase" key={phase.id}>
                          <div className="ph-phase-head">
                            <strong>{phase.name}</strong>
                            <span>{phase.taskCount === 0 ? "待评估" : `${phase.completedTaskCount}/${phase.taskCount}`}</span>
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
                          {capability.resourceCount > 0
                            ? ` · ${capability.availableResourceCount}/${capability.resourceCount} 个可用资源`
                            : " · 暂无关联资源"}
                        </p>
                        {capability.impact ? <small>影响：{capability.impact}</small> : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
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

  const preview = useMemo(() => {
    if (!draft) return null;
    return {
      name: draft.name,
      kind: draft.kind,
      goal: draft.goal,
      phases: draft.phases,
      capabilities: draft.capabilityRequirements,
      uncertainties: draft.uncertainties,
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
      await onCreate({
        name: value.name.trim(),
        kind: value.kind,
        description: value.description,
        goal: value.goal,
        targetDate: value.targetDate,
        templateId: value.templateId,
        clientRequestId: crypto.randomUUID(),
        goals: value.goal ? [{ title: value.goal }] : [],
        phases: value.phases.map((phase) => ({
          name: phase.title,
          description: phase.purpose,
          targetDate: phase.targetDate,
          startDate: phase.startDate,
          milestones: phase.milestoneTitles.map((name) => ({ name })),
        })),
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
      });
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
      await onCreate({
        name: manualName.trim(),
        kind: manualKind,
        goal: manualGoal.trim(),
        clientRequestId: crypto.randomUUID(),
        phases: [],
        tasks: [],
        capabilities: [],
        goals: manualGoal.trim() ? [{ title: manualGoal.trim() }] : [],
      });
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
                <h4>预计产出（{draft.phases.reduce((sum, phase) => sum + phase.features.length, 0)} 项功能）</h4>
                {draft.phases.some((phase) => phase.features.length > 0) ? (
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
              <h4>工作空间建议</h4>
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
