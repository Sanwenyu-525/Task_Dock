//! 紧凑模式：快速添加 + 最近待办 + 活跃 Agent（实时状态，含失联提示）。

import QuickAdd from "./tasks/QuickAdd";
import TaskItem from "./tasks/TaskItem";
import { useTasksStore } from "../store/useTasksStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore } from "../store/useUiStore";
import { formatBetween, AGENT_STATE_LABELS } from "../lib/format";
import { applyMode } from "../lib/bridge";
import { liveRuns } from "../lib/agentTree";
import { useLocale } from "../hooks/useLocale";

export default function CompactView() {
  const { t } = useLocale();
  const tasks = useTasksStore((s) => s.tasks);
  const stats = useTasksStore((s) => s.stats);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const setTab = useUiStore((s) => s.setTab);
  const pending = tasks.filter((t) => t.status === "pending").slice(0, 5);
  const activeRuns = liveRuns(snapshot?.runs ?? []).slice(0, 3);

  return (
    <div className="compact-view">
      <QuickAdd compact />
      <div className="compact-section">
        <div className="compact-section-head">
          <span>
            {t("compact.recentTasks")}
            {stats && stats.pending > pending.length ? ` · ${stats.pending}` : ""}
          </span>
          <button className="link-btn" onClick={() => { setTab("tasks"); applyMode("full"); }}>
            {t("compact.all")}
          </button>
        </div>
        {pending.length === 0 && <div className="empty-hint">{t("compact.noTasks")}</div>}
        {pending.map((t) => (
          <TaskItem key={t.id} task={t} compact />
        ))}
      </div>
      {activeRuns.length > 0 && (
        <div className="compact-section">
          <div className="compact-section-head">
            <span>{t("compact.activeAgents")}</span>
            <button className="link-btn" onClick={() => { setTab("agents"); applyMode("full"); }}>
              {t("compact.details")}
            </button>
          </div>
          {activeRuns.map((r) => {
            const session = snapshot?.sessions.find((s) => s.id === r.session_id);
            return (
              <div key={r.id} className={`compact-agent state-${r.status}`}>
                <span className={`agent-dot state-${r.status}`} />
                <span className="compact-agent-title">{r.task_title || session?.title || r.source_id}</span>
                <span className="compact-agent-meta">
                  {AGENT_STATE_LABELS[r.status]} · {formatBetween(r.started_at, r.ended_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
