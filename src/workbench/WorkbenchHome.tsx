//! 工作台首页（U0）v2：不依赖任何项目即可使用的入口页。
//!
//! 只展示**真实数据**：任务统计、今日重点（到期/逾期 + 最近待办）、Agent 快照、
//! 工作空间项目、工作流进度。效果图中的示例数字、项目名与头像一律不硬编码；
//! 区块空态如实显示，不放假图表、不造假状态。

import { useEffect, useMemo } from "react";
import {
  ArrowRight,
  CalendarClock,
  Clipboard,
  FolderPlus,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Plus,
  Workflow,
  Zap,
} from "lucide-react";

import AgentIcon, { type IconComponent } from "../components/ui/AgentIcon";
import { useLocale } from "../hooks/useLocale";
import { useTasksStore } from "../store/useTasksStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useWorkflowsStore } from "../store/useWorkflowsStore";
import { formatLocalizedDate, formatLocalizedRelative } from "../i18n/format";
import { resolveWorkspaceProfile } from "../workspace/workspaceProfiles";
import type { Task, WorkspaceProject } from "../lib/bridge";
import type { WorkbenchRoute } from "../lib/workbenchLayout";
import type { MessageKey } from "../i18n/messages";

interface Props {
  projects: WorkspaceProject[];
  projectsLoading: boolean;
  onNavigate: (route: WorkbenchRoute) => void;
  onSelectProjectAndOpen: (id: string) => void;
  onCreateProject: () => void;
  /** 顶栏/宫格「新建任务」：进任务页并弹出快速添加。 */
  onQuickAddTask: () => void;
}

const QUICK_TILES: Array<{
  route: WorkbenchRoute | null;
  action?: "task" | "project";
  labelKey: MessageKey;
  icon: IconComponent;
}> = [
  { route: null, action: "task", labelKey: "workbench.createTask", icon: Plus },
  { route: "agents", labelKey: "workbench.quickNewAgent", icon: AgentIcon },
  { route: "shelf", labelKey: "workbench.quickUploadResource", icon: Clipboard },
  { route: "workflows", labelKey: "workbench.quickRunWorkflow", icon: Workflow },
  { route: "inbox", labelKey: "workbench.openCollection", icon: Inbox },
  { route: null, action: "project", labelKey: "workbench.createProject", icon: FolderPlus },
];

/** due_at（ISO 或 null）→ 展示 chip：已逾期 / 今天 / 明天 / 短日期。 */
function dueChip(
  value: string | null,
  now: Date,
): { key: MessageKey | null; text: string; tone: "is-overdue" | "is-today" | "" } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = 86_400_000;
  const diff = startOfDay(date) - startOfDay(now);
  if (diff < 0)
    return { key: "workbench.taskDueOverdue", text: "", tone: "is-overdue" };
  if (diff === 0) return { key: "workbench.taskDueToday", text: "", tone: "is-today" };
  if (diff === day) return { key: "workbench.taskDueTomorrow", text: "", tone: "" };
  return {
    key: null,
    text: formatLocalizedDate(date, { month: "numeric", day: "numeric" }),
    tone: "",
  };
}

function agentStatusTone(status: string): string {
  if (status === "running") return "is-running";
  if (status === "waiting") return "is-waiting";
  if (status === "failed") return "is-failed";
  return "";
}

export default function WorkbenchHome({
  projects,
  projectsLoading,
  onNavigate,
  onSelectProjectAndOpen,
  onCreateProject,
  onQuickAddTask,
}: Props) {
  const { t } = useLocale();
  const stats = useTasksStore((s) => s.stats);
  const tasks = useTasksStore((s) => s.tasks);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
  const loadAgents = useAgentsStore((s) => s.load);
  const workflows = useWorkflowsStore((s) => s.workflows);
  const activeRunDetail = useWorkflowsStore((s) => s.activeRunDetail);
  const loadWorkflows = useWorkflowsStore((s) => s.loadWorkflows);
  const refreshActive = useWorkflowsStore((s) => s.refreshActive);

  // 首页自己的消费者：快照/工作流只在需要时拉一次（不轮询、不复制后台调度）。
  useEffect(() => {
    if (!snapshot) void loadAgents();
    void loadWorkflows().then(() => void refreshActive());
  }, [snapshot, loadAgents, loadWorkflows, refreshActive]);

  const agentSums = snapshot?.live_summary;
  const running =
    agentSums?.running ?? snapshot?.runs.filter((r) => r.status === "running").length ?? 0;
  const waiting =
    agentSums?.waiting ?? snapshot?.sessions.filter((s) => s.status === "waiting").length ?? 0;
  const failed =
    agentSums?.failed ?? snapshot?.runs.filter((r) => r.status === "failed").length ?? 0;

  const now = new Date();
  const hour = now.getHours();
  const greetingKey: MessageKey =
    hour < 12
      ? "workbench.homeGreetingMorning"
      : hour < 18
        ? "workbench.homeGreetingAfternoon"
        : "workbench.homeGreetingEvening";

  const today = now.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  // 今日重点：今日到期 + 逾期优先，不足 3 条时用最近的待办补位（行内 chip 如实标注）。
  const focusTasks = useMemo(() => {
    const pending = tasks.filter((task: Task) => task.status === "pending");
    const withDue = pending
      .filter((task) => task.due_at)
      .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
    const urgent = withDue.filter((task) => {
      const chip = dueChip(task.due_at, now);
      return chip?.tone === "is-overdue" || chip?.tone === "is-today";
    });
    if (urgent.length >= 3) return urgent.slice(0, 5);
    const rest = withDue.filter((task) => !urgent.includes(task));
    return [...urgent, ...rest].slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // 最近任务：按更新时间倒序（含已完成，状态徽标如实标注）。
  const recentTasks = useMemo(
    () =>
      [...tasks]
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 5),
    [tasks],
  );

  // Agent 会话：按最近活动倒序，最多 4 行（真实状态，不伪造运行态）。
  const recentSessions = useMemo(
    () =>
      [...(snapshot?.sessions ?? [])]
        .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))
        .slice(0, 4),
    [snapshot],
  );

  // 工作流：进行中的运行（真实步数）+ 最近运行过的工作流（按 last_run_at）。
  const activeWorkflow = useMemo(() => {
    if (!activeRunDetail) return null;
    const wf = workflows?.find((item) => item.id === activeRunDetail.workflow_id);
    return wf ? { name: wf.name, detail: activeRunDetail } : null;
  }, [activeRunDetail, workflows]);
  const recentWorkflows = useMemo(
    () =>
      [...(workflows ?? [])]
        .filter((item) => item.last_run_at)
        .sort((a, b) => String(b.last_run_at).localeCompare(String(a.last_run_at)))
        .slice(0, 2),
    [workflows],
  );

  return (
    <div className="wb-home">
      <header className="wb-home-head">
        <div>
          {/* 稳定的页面级标题（供导航/测试锚定）；问候语是主视觉文案。 */}
          <h2 className="sr-only">{t("workbench.home")}</h2>
          <p className="wb-home-greeting" role="presentation">
            {t(greetingKey)}
          </p>
          <p className="wb-home-sub">{t("workbench.homeSubtitle")}</p>
        </div>
        <span className="wb-home-date">{today}</span>
      </header>

      {snapshotError && (
        <p className="wb-inline-warn" role="status">
          {t("workbench.agentSnapshotError", { error: snapshotError })}
        </p>
      )}

      <div className="wb-home-grid">
        <section className="wb-panel" aria-labelledby="wb-home-focus">
            <div className="wb-panel-head">
              <h3 id="wb-home-focus">
                <CalendarClock size={14} aria-hidden="true" /> {t("workbench.homeFocusTitle")}
              </h3>
              <span className="wb-panel-count">{focusTasks.length}</span>
            </div>
            {focusTasks.length === 0 ? (
              <p className="wb-muted">{t("workbench.homeFocusEmpty")}</p>
            ) : (
              <ul className="wb-rowlist">
                {focusTasks.map((task) => {
                  const chip = dueChip(task.due_at, now);
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className="wb-row"
                        onClick={() => onNavigate("tasks")}
                      >
                        <span className="wb-row-title">{task.title}</span>
                        {(task.priority === 0 || task.priority === 1) && (
                          <span className={`wb-pri-chip is-p${task.priority}`}>
                            P{task.priority}
                          </span>
                        )}
                        {chip && (
                          <span className={`wb-due-chip ${chip.tone}`.trim()}>
                            {chip.key ? t(chip.key) : chip.text}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="wb-panel" aria-labelledby="wb-home-projects">
            <div className="wb-panel-head">
              <h3 id="wb-home-projects">
                <LayoutDashboard size={14} aria-hidden="true" /> {t("workbench.projectsTitle")}
              </h3>
              <button
                type="button"
                className="wb-panel-more"
                onClick={() => onNavigate("workspace")}
              >
                {t("workbench.viewAll")} <ArrowRight size={11} aria-hidden="true" />
              </button>
            </div>
            {projectsLoading && <p className="wb-muted">{t("common.loading")}</p>}
            {!projectsLoading && projects.length === 0 && (
              <p className="wb-muted">{t("workbench.noProjects")}</p>
            )}
            {projects.length > 0 && (
              <div className="wb-project-cards">
                {projects.slice(0, 6).map((project) => {
                  const profile = resolveWorkspaceProfile(project.kind);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className="wb-pcard"
                      onClick={() => onSelectProjectAndOpen(project.id)}
                    >
                      <span className="wb-pcard-name">
                        <span>{project.name}</span>
                        <span className="ws-badge ws-badge-soft">{profile.label}</span>
                      </span>
                      <span className="wb-pcard-meta">
                        {t("workbench.projectMeta", {
                          items: project.itemCount,
                          links: project.taskLinkCount,
                        })}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="wb-panel" aria-labelledby="wb-home-quick">
            <div className="wb-panel-head">
              <h3 id="wb-home-quick">
                <Zap size={14} aria-hidden="true" /> {t("workbench.homeQuick")}
              </h3>
            </div>
            <div className="wb-quick-tiles">
              {QUICK_TILES.map((tile) => {
                const Icon = tile.icon;
                return (
                  <button
                    key={tile.labelKey}
                    type="button"
                    className="wb-quick-tile"
                    onClick={() => {
                      if (tile.route) onNavigate(tile.route);
                      else if (tile.action === "task") onQuickAddTask();
                      else onCreateProject();
                    }}
                  >
                    <span className="wb-quick-ico">
                      <Icon size={15} aria-hidden="true" />
                    </span>
                    <span>{t(tile.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="wb-panel" aria-labelledby="wb-home-agents">
            <div className="wb-panel-head">
              <h3 id="wb-home-agents">
                <AgentIcon size={14} aria-hidden="true" /> {t("workbench.homeAgentsTitle")}
              </h3>
              <button type="button" className="wb-panel-more" onClick={() => onNavigate("agents")}>
                {t("workbench.viewAllAgents")}
              </button>
            </div>
            <p className="wb-muted">
              {t("workbench.stat.agents")} {running} · {t("workbench.agentWaiting")} {waiting} ·{" "}
              {t("workbench.agentFailed")} {failed}
            </p>
            {recentSessions.length === 0 ? (
              <p className="wb-muted">{t("workbench.homeAgentsEmpty")}</p>
            ) : (
              <ul className="wb-rowlist">
                {recentSessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className="wb-agent-row"
                      onClick={() => onNavigate("agents")}
                    >
                      <span className="wb-row-title">{session.title || session.external_id}</span>
                      <span className={`wb-status-chip ${agentStatusTone(session.status)}`.trim()}>
                        {session.status}
                      </span>
                      <span className="wb-row-meta">
                        {formatLocalizedRelative(session.last_seen_at, now)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="wb-panel" aria-labelledby="wb-home-recent">
            <div className="wb-panel-head">
              <h3 id="wb-home-recent">
                <ListTodo size={14} aria-hidden="true" /> {t("workbench.homeRecentTitle")}
              </h3>
              <span className="wb-panel-count">
                {t("workbench.stat.pending")} {stats?.pending ?? "—"}
              </span>
            </div>
            {recentTasks.length === 0 ? (
              <p className="wb-muted">{t("workbench.homeRecentEmpty")}</p>
            ) : (
              <ul className="wb-rowlist">
                {recentTasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className={`wb-row${task.status === "completed" ? " is-done" : ""}`}
                      onClick={() => onNavigate("tasks")}
                    >
                      <span className="wb-row-title">{task.title}</span>
                      <span className="wb-row-meta">
                        {task.status === "completed"
                          ? t("workbench.taskStatusCompleted")
                          : t("workbench.taskStatusPending")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="wb-panel" aria-labelledby="wb-home-workflows">
            <div className="wb-panel-head">
              <h3 id="wb-home-workflows">
                <Workflow size={14} aria-hidden="true" /> {t("workbench.homeWorkflowTitle")}
              </h3>
              <button
                type="button"
                className="wb-panel-more"
                onClick={() => onNavigate("workflows")}
              >
                {t("workbench.viewAll")}
              </button>
            </div>
            {!workflows || workflows.length === 0 ? (
              <p className="wb-muted">{t("workbench.homeWorkflowEmpty")}</p>
            ) : (
              <div>
                {activeWorkflow && (
                  <button
                    type="button"
                    className="wb-wf-row"
                    onClick={() => onNavigate("workflows")}
                  >
                    <span className="wb-wf-top">
                      <span className="wb-wf-name">{activeWorkflow.name}</span>
                      <span
                        className={`wb-status-chip ${
                          activeWorkflow.detail.status === "paused" ? "is-waiting" : "is-running"
                        }`.trim()}
                      >
                        {activeWorkflow.detail.status === "paused"
                          ? t("workbench.homeWorkflowPaused", {
                              completed: activeWorkflow.detail.completed_steps,
                              total: activeWorkflow.detail.total_steps,
                            })
                          : t("workbench.homeWorkflowActive", {
                              completed: activeWorkflow.detail.completed_steps,
                              total: activeWorkflow.detail.total_steps,
                            })}
                      </span>
                    </span>
                    <span className="wb-wf-bar">
                      <i
                        style={{
                          width: activeWorkflow.detail.total_steps
                            ? `${Math.round(
                                (activeWorkflow.detail.completed_steps /
                                  activeWorkflow.detail.total_steps) *
                                  100,
                              )}%`
                            : "0%",
                        }}
                      />
                    </span>
                  </button>
                )}
                {recentWorkflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    className="wb-wf-row"
                    onClick={() => onNavigate("workflows")}
                  >
                    <span className="wb-wf-top">
                      <span className="wb-wf-name">{workflow.name}</span>
                      <span className="wb-wf-meta">
                        {workflow.last_run_at
                          ? formatLocalizedRelative(workflow.last_run_at, now)
                          : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
      </div>
    </div>
  );
}
