//! 极简模式：全局待办数、下一次到期、Agent 实时状态（均不依赖当前筛选）。

import { useTasksStore } from "../store/useTasksStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore } from "../store/useUiStore";
import { formatRelative } from "../lib/format";
import { applyMode } from "../lib/bridge";
import { liveSummary } from "../lib/agentTree";
import { useLocale } from "../hooks/useLocale";

export default function MinimalView() {
  const stats = useTasksStore((s) => s.stats);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const setTab = useUiStore((s) => s.setTab);
  const { t } = useLocale();

  const live = liveSummary(snapshot);
  const agentSummary =
    live.failed > 0
      ? t("minimal.agentFailed", { n: live.failed })
      : live.waiting > 0
        ? t("minimal.agentWaiting", { n: live.waiting })
        : live.running > 0
          ? t("minimal.agentRunning", { n: live.running })
          : t("minimal.allIdle");

  return (
    <div className="minimal-view">
      <button
        className="minimal-count"
        onClick={() => { setTab("tasks"); applyMode("full"); }}
        title={t("minimal.switchToFull")}
      >
        <span className="minimal-number">{stats?.pending ?? "—"}</span>
        <span className="minimal-label">{t("minimal.pending")}</span>
      </button>
      <div
        className="minimal-next"
        title={
          stats?.next_due_at
            ? t("minimal.nextDueTip", { time: formatRelative(stats.next_due_at) })
            : t("minimal.noSchedule")
        }
      >
        <span className="minimal-next-label">{t("minimal.nextDue")}</span>
        <span className="minimal-next-value">
          {stats?.next_due_at ? formatRelative(stats.next_due_at) : "—"}
        </span>
      </div>
      <button
        className={`minimal-agent state-${live.worst}`}
        onClick={() => { setTab("agents"); applyMode("full"); }}
        title={t("minimal.agentStatusTip")}
      >
        <span className={`minimal-agent-dot state-${live.worst}`} />
        <span>{agentSummary}</span>
      </button>
    </div>
  );
}
