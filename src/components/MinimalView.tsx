//! 极简模式：全局待办数、下一次到期、Agent 实时状态（均不依赖当前筛选）。

import { useTasksStore } from "../store/useTasksStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore } from "../store/useUiStore";
import { formatRelative } from "../lib/format";
import { applyMode } from "../lib/bridge";
import { liveSummary } from "../lib/agentTree";

export default function MinimalView() {
  const stats = useTasksStore((s) => s.stats);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const setTab = useUiStore((s) => s.setTab);

  const live = liveSummary(snapshot);
  const agentSummary =
    live.failed > 0
      ? `${live.failed} 个失败`
      : live.waiting > 0
        ? `${live.waiting} 个等待`
        : live.running > 0
          ? `${live.running} 个运行中`
          : "全部空闲";

  return (
    <div className="minimal-view">
      <button
        className="minimal-count"
        onClick={() => { setTab("tasks"); applyMode("full"); }}
        title="切换到完整模式 · 查看任务"
      >
        <span className="minimal-number">{stats?.pending ?? "—"}</span>
        <span className="minimal-label">待办</span>
      </button>
      <div className="minimal-next" title={stats?.next_due_at ? `下次到期 ${formatRelative(stats.next_due_at)}` : "暂无安排"}>
        <span className="minimal-next-label">下次到期</span>
        <span className="minimal-next-value">
          {stats?.next_due_at ? formatRelative(stats.next_due_at) : "—"}
        </span>
      </div>
      <button
        className={`minimal-agent state-${live.worst}`}
        onClick={() => { setTab("agents"); applyMode("full"); }}
        title="Agent 实时状态 · 点击查看"
      >
        <span className={`minimal-agent-dot state-${live.worst}`} />
        <span>{agentSummary}</span>
      </button>
    </div>
  );
}
