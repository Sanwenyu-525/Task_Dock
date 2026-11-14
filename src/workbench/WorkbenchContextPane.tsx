//! 工作台右侧上下文栏（U0）：当前任务 / 项目 / 开发项目 / Agent / 需要处理的
//! 真实状态。
//!
//! 不是每个功能都需要右栏：本组件只承载跨功能共用的上下文，不复制各页面的
//! 详情视图；没有项目/当前任务时如实降级，不显示假数据。

import { FolderOpen, GitBranch, Loader2, PlayCircle, Settings2 } from "lucide-react";
import { openPath as openSystemPath } from "@tauri-apps/plugin-opener";

import AgentIcon from "../components/ui/AgentIcon";
import { useLocale } from "../hooks/useLocale";
import { useAgentsStore } from "../store/useAgentsStore";
import { useTasksStore } from "../store/useTasksStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useActionsStore } from "../store/useActionsStore";
import { useWorkspaceDevContext } from "../workspace/useWorkspaceProjectContext";
import { resolveWorkspaceProfile } from "../workspace/workspaceProfiles";
import { priorityLabelKey } from "../lib/commandPhrases";
import { formatLocalizedDateTime, formatLocalizedRelative } from "../i18n/format";
import { errorMessage } from "../lib/errors";
import type { WorkspaceProject } from "../lib/bridge";

interface Props {
  project: WorkspaceProject | null;
  onOpenProject: () => void;
  onOpenProjectSettings: () => void;
  onOpenDevWorkbench: () => void;
  onOpenTask: () => void;
  onNotice: (kind: "ok" | "error" | "info", text: string) => void;
}

export default function WorkbenchContextPane({
  project,
  onOpenProject,
  onOpenProjectSettings,
  onOpenDevWorkbench,
  onOpenTask,
  onNotice,
}: Props) {
  const { t } = useLocale();
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
  const feedItems = useActionsStore((s) => s.feed?.items ?? null);
  const dev = useWorkspaceDevContext(project?.devProjectId ?? null);

  // 当前任务：设置键指向真实任务时才显示详情；失效/未设置如实降级。
  const currentTaskId = useSettingsStore((s) => s.settings?.workbench_current_task ?? "");
  const currentTask = useTasksStore((s) =>
    currentTaskId ? s.tasks.find((task) => String(task.id) === currentTaskId) : undefined,
  );

  const profile = resolveWorkspaceProfile(project?.kind);
  const sums = snapshot?.live_summary;
  const running = sums?.running ?? snapshot?.runs.filter((r) => r.status === "running").length ?? 0;
  const waiting = sums?.waiting ?? snapshot?.sessions.filter((s) => s.status === "waiting").length ?? 0;
  const failed = sums?.failed ?? snapshot?.runs.filter((r) => r.status === "failed").length ?? 0;

  const openRoot = async (path: string) => {
    try {
      await openSystemPath(path);
    } catch (e) {
      onNotice("error", `打开目录失败：${errorMessage(e)}`);
    }
  };

  return (
    <aside className="wb-context" aria-label={t("workbench.context")}>
      <header className="wb-context-head">
        <h3>{t("workbench.context")}</h3>
      </header>

      <section className="wb-context-block" aria-labelledby="wb-context-task">
        <h4 id="wb-context-task">{t("workbench.contextCurrentTask")}</h4>
        {!currentTask && <p className="wb-muted">{t("workbench.contextNoTask")}</p>}
        {currentTask && (
          <>
            <p className="wb-context-task-name">{currentTask.title}</p>
            <dl className="wb-context-facts">
              <dt>{t("workbench.contextTaskStatus")}</dt>
              <dd>
                {currentTask.status === "completed"
                  ? t("workbench.taskStatusCompleted")
                  : t("workbench.taskStatusPending")}
              </dd>
              <dt>{t("workbench.contextPriority")}</dt>
              <dd>{t(priorityLabelKey(currentTask.priority))}</dd>
              <dt>{t("workbench.contextDue")}</dt>
              <dd>
                {currentTask.due_at
                  ? formatLocalizedDateTime(currentTask.due_at)
                  : t("workbench.taskNoDue")}
              </dd>
            </dl>
            <div className="wb-context-task-actions">
              <button type="button" className="btn sm" onClick={onOpenTask}>
                <PlayCircle size={12} aria-hidden="true" /> {t("nav.tasks")}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="wb-context-block" aria-labelledby="wb-context-project">
        <h4 id="wb-context-project">{t("workbench.projectsTitle")}</h4>
        {!project && <p className="wb-muted">{t("workbench.noProject")}</p>}
        {project && (
          <>
            <div className="wb-context-project">
              <strong>{project.name}</strong>
              <span className="ws-badge ws-badge-soft">{profile.label}</span>
              {project.status === "archived" && (
                <span className="ws-badge ws-badge-planned">已归档</span>
              )}
            </div>
            <dl className="wb-context-facts">
              <dt>{t("workbench.projectKind")}</dt>
              <dd>{profile.label}</dd>
              <dt>{t("workbench.projectRoot")}</dt>
              <dd className="wb-path" title={project.rootPath || undefined}>
                {project.rootPath || "—"}
                {project.rootPath && project.rootExists && (
                  <button
                    type="button"
                    className="wb-icon-btn"
                    aria-label={t("common.open")}
                    data-tip={t("common.open")}
                    onClick={() => void openRoot(project.rootPath)}
                  >
                    <FolderOpen size={12} aria-hidden="true" />
                  </button>
                )}
              </dd>
            </dl>
            {project.rootPath && !project.rootExists && (
              <p className="wb-inline-warn">工作目录不存在（登记仍保留）</p>
            )}
            <div className="wb-context-actions">
              <button type="button" className="btn sm" onClick={onOpenProject}>
                <PlayCircle size={12} aria-hidden="true" /> 打开项目页
              </button>
              <button type="button" className="btn sm" onClick={onOpenProjectSettings}>
                <Settings2 size={12} aria-hidden="true" /> {t("workbench.openProjectSettings")}
              </button>
            </div>
          </>
        )}
      </section>

      {project?.devProjectId && (
        <section className="wb-context-block" aria-labelledby="wb-context-dev">
          <h4 id="wb-context-dev">开发项目</h4>
          {dev.status === "loading" && (
            <p className="wb-muted">
              <Loader2 size={12} className="ws-spin" aria-hidden="true" /> 正在读取…
            </p>
          )}
          {dev.status === "missing" && <p className="wb-inline-warn">{dev.reason}</p>}
          {dev.status === "error" && (
            <p className="wb-inline-warn">读取失败：{dev.error}</p>
          )}
          {dev.devProject && (
            <>
              <div className="wb-context-project">
                <strong>{dev.devProject.name}</strong>
              </div>
              <p className="wb-path" title={dev.devProject.rootPath}>
                {dev.devProject.rootPath}
              </p>
              {dev.probe?.status === "ok" && (
                <p className="wb-muted">
                  <GitBranch size={12} aria-hidden="true" />{" "}
                  {dev.probe.detached ? "detached HEAD" : `分支 ${dev.probe.branch ?? "（未知）"}`}
                  {dev.probe.dirtyCount === null ? "" : ` · 未提交 ${dev.probe.dirtyCount}`}
                </p>
              )}
              {dev.probe?.status === "not_a_repo" && (
                <p className="wb-inline-warn">根目录不是 Git 仓库</p>
              )}
              {dev.probe?.status === "git_unavailable" && (
                <p className="wb-inline-warn">未检测到可用的 Git 命令</p>
              )}
              {dev.probe?.status === "path_missing" && (
                <p className="wb-inline-warn">开发项目根目录不存在</p>
              )}
              <div className="wb-context-actions">
                <button type="button" className="btn sm" onClick={onOpenDevWorkbench}>
                  <GitBranch size={12} aria-hidden="true" /> 开发工作台
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="wb-context-block" aria-labelledby="wb-context-agents">
        <h4 id="wb-context-agents">
          <AgentIcon size={13} aria-hidden="true" /> Agent
        </h4>
        {snapshotError && (
          <p className="wb-inline-warn">{t("workbench.agentSnapshotError", { error: snapshotError })}</p>
        )}
        <div className="wb-agent-grid">
          <div>
            <strong>{running}</strong>
            <span>运行</span>
          </div>
          <div>
            <strong>{waiting}</strong>
            <span>{t("workbench.agentWaiting")}</span>
          </div>
          <div>
            <strong>{failed}</strong>
            <span>{t("workbench.agentFailed")}</span>
          </div>
        </div>
      </section>

      <section className="wb-context-block" aria-labelledby="wb-context-activity">
        <h4 id="wb-context-activity">{t("workbench.contextRecentActivity")}</h4>
        {!feedItems || feedItems.length === 0 ? (
          <p className="wb-muted">{t("workbench.contextActivityEmpty")}</p>
        ) : (
          <div>
            {feedItems.slice(0, 4).map((item) => (
              <div key={item.id} className="wb-activity-row">
                <span
                  className={`wb-activity-dot${item.priority <= 1 ? "" : " is-muted"}`}
                  aria-hidden="true"
                />
                <span className="wb-activity-body">
                  <span className="wb-activity-title">{item.title}</span>
                  <span className="wb-activity-meta">
                    {formatLocalizedRelative(item.occurred_at)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
