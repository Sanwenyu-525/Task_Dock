//! 工作台首页（U0）：不依赖任何项目即可使用的入口页。
//!
//! 只展示**真实数据**：任务统计、Agent 快照、未处理收集、工作空间项目。
//! 不计算「效率提升」「节省时间」等无法复核的指标，也不做假图表。

import { useEffect } from "react";
import {
  ArrowRight,
  Clipboard,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Plus,
  Sparkles,
  Workflow,
} from "lucide-react";

import AgentIcon, { type IconComponent } from "../components/ui/AgentIcon";
import { useLocale } from "../hooks/useLocale";
import { useTasksStore } from "../store/useTasksStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { resolveWorkspaceProfile } from "../workspace/workspaceProfiles";
import type { WorkspaceProject } from "../lib/bridge";
import type { WorkbenchRoute } from "../lib/workbenchLayout";
import type { MessageKey } from "../i18n/messages";

interface Props {
  projects: WorkspaceProject[];
  projectsLoading: boolean;
  onNavigate: (route: WorkbenchRoute) => void;
  onSelectProjectAndOpen: (id: string) => void;
  onCreateProject: () => void;
}

const QUICK_LINKS: Array<{ route: WorkbenchRoute; labelKey: MessageKey; icon: IconComponent }> = [
  { route: "tasks", labelKey: "nav.tasks", icon: ListTodo },
  { route: "agents", labelKey: "nav.agents", icon: AgentIcon },
  { route: "workbench", labelKey: "nav.workbench", icon: LayoutDashboard },
  { route: "inbox", labelKey: "nav.collection", icon: Inbox },
  { route: "clipboard", labelKey: "nav.clipboard", icon: Clipboard },
  { route: "workflows", labelKey: "nav.workflows", icon: Workflow },
];

export default function WorkbenchHome({
  projects,
  projectsLoading,
  onNavigate,
  onSelectProjectAndOpen,
  onCreateProject,
}: Props) {
  const { t } = useLocale();
  const stats = useTasksStore((s) => s.stats);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
  const loadAgents = useAgentsStore((s) => s.load);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const refreshInboxCount = useCaptureStore((s) => s.refreshInboxCount);

  // 首页自己的消费者：快照/计数只在需要时拉一次（不轮询、不复制后台调度）。
  useEffect(() => {
    if (!snapshot) void loadAgents();
    void refreshInboxCount();
  }, [snapshot, loadAgents, refreshInboxCount]);

  const agentSums = snapshot?.live_summary;
  const running =
    agentSums?.running ?? snapshot?.runs.filter((r) => r.status === "running").length ?? 0;
  const waiting =
    agentSums?.waiting ?? snapshot?.sessions.filter((s) => s.status === "waiting").length ?? 0;
  const failed =
    agentSums?.failed ?? snapshot?.runs.filter((r) => r.status === "failed").length ?? 0;

  const today = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return (
    <div className="wb-home">
      <header className="wb-home-head">
        <div>
          <h2>{t("workbench.home")}</h2>
          <p className="wb-home-sub">{t("workbench.homeSubtitle")}</p>
        </div>
        <span className="wb-home-date">{today}</span>
      </header>

      <div className="wb-stat-grid">
        <button type="button" className="wb-stat" onClick={() => onNavigate("tasks")}>
          <span className="wb-stat-label">{t("workbench.stat.pending")}</span>
          <strong>{stats?.pending ?? "—"}</strong>
          <span className="wb-stat-foot">
            {t("workbench.stat.overdue")} {stats?.overdue ?? "—"}
          </span>
        </button>
        <button type="button" className="wb-stat" onClick={() => onNavigate("agents")}>
          <span className="wb-stat-label">{t("workbench.stat.agents")}</span>
          <strong>{running}</strong>
          <span className="wb-stat-foot">
            {t("workbench.agentWaiting")} {waiting} · {t("workbench.agentFailed")} {failed}
          </span>
        </button>
        <button type="button" className="wb-stat" onClick={() => onNavigate("inbox")}>
          <span className="wb-stat-label">{t("workbench.stat.inbox")}</span>
          <strong>{inboxCount}</strong>
          <span className="wb-stat-foot">{t("nav.collection")}</span>
        </button>
        <button type="button" className="wb-stat" onClick={() => onNavigate("workspace")}>
          <span className="wb-stat-label">{t("nav.workspace")}</span>
          <strong>{projects.length}</strong>
          <span className="wb-stat-foot">{t("workbench.projectsTitle")}</span>
        </button>
      </div>

      {snapshotError && (
        <p className="wb-inline-warn" role="status">
          {t("workbench.agentSnapshotError", { error: snapshotError })}
        </p>
      )}

      <section className="wb-home-section" aria-labelledby="wb-quick-heading">
        <h3 id="wb-quick-heading">
          <Sparkles size={14} aria-hidden="true" /> {t("workbench.quick")}
        </h3>
        <div className="wb-quick-grid">
          {QUICK_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <button
                key={link.route}
                type="button"
                className="wb-quick"
                onClick={() => onNavigate(link.route)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{t(link.labelKey)}</span>
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>

      <section className="wb-home-section" aria-labelledby="wb-projects-heading">
        <div className="wb-section-head">
          <h3 id="wb-projects-heading">{t("workbench.projectsTitle")}</h3>
          <div className="wb-section-actions">
            <button type="button" className="btn sm" onClick={onCreateProject}>
              <Plus size={12} aria-hidden="true" /> {t("workbench.newProject")}
            </button>
            <button type="button" className="btn sm" onClick={() => onNavigate("workspace")}>
              {t("workbench.viewAll")}
            </button>
          </div>
        </div>
        {projectsLoading && <p className="wb-muted">{t("common.loading")}</p>}
        {!projectsLoading && projects.length === 0 && (
          <p className="wb-muted">{t("workbench.noProjects")}</p>
        )}
        {projects.length > 0 && (
          <ul className="wb-project-list">
            {projects.slice(0, 5).map((project) => {
              const profile = resolveWorkspaceProfile(project.kind);
              return (
                <li key={project.id}>
                  <button
                    type="button"
                    className="wb-project-row"
                    onClick={() => onSelectProjectAndOpen(project.id)}
                  >
                    <span className="wb-project-name">{project.name}</span>
                    <span className={`ws-badge ws-badge-${project.status === "archived" ? "planned" : "available"}`}>
                      {profile.label}
                    </span>
                    <span className="wb-project-meta">
                      事项 {project.itemCount} · 关联 {project.taskLinkCount}
                    </span>
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
