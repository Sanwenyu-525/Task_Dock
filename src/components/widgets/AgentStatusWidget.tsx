//! Agent 状态微件：复用 useAgentsStore 的快照与事件刷新，无独立扫描/轮询。
//! 只展示实时轮次计数与最需关注的 3 条，详细操作交给 Agent 页。

import { useEffect } from "react";
import { Activity, AlertTriangle, ChevronRight } from "lucide-react";

import { AGENT_STATE_LABELS } from "../../lib/format";
import { liveSummary } from "../../lib/agentTree";
import { attentionRuns } from "../../lib/widgets/selectors";
import { useAgentsStore } from "../../store/useAgentsStore";
import { openFullApp } from "../capsule/actions";

export default function AgentStatusWidget() {
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
  const load = useAgentsStore((s) => s.load);

  // 首次挂载若还没有快照，复用既有 load（单飞刷新）；之后完全由全局事件驱动。
  useEffect(() => {
    if (!snapshot) void load();
  }, [snapshot, load]);

  const summary = liveSummary(snapshot);
  const runs = attentionRuns(snapshot?.runs ?? [], Date.now(), 3);
  const hasLive = summary.running + summary.waiting + summary.failed + summary.disconnected > 0;

  return (
    <div className="widget-agents">
      <div className="widget-chips">
        <span className="widget-chip running">运行中 {summary.running}</span>
        <span className={`widget-chip waiting ${summary.waiting > 0 ? "" : "muted"}`}>
          等待 {summary.waiting}
        </span>
        <span className={`widget-chip failed ${summary.failed > 0 ? "" : "muted"}`}>
          失败 {summary.failed}
        </span>
      </div>

      {snapshotError && (
        <div className="widget-status-line">
          <span className="widget-warn">
            <AlertTriangle size={12} aria-hidden="true" /> 状态可能不是最新
          </span>
        </div>
      )}

      {runs.length > 0 ? (
        <ul className="widget-list" aria-label="需要关注的 Agent 轮次">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                className="widget-row"
                aria-label={`在 Agent 页查看「${run.task_title}」`}
                onClick={() => openFullApp("agents")}
              >
                <span className={`widget-state-dot state-${run.status}`} aria-hidden="true" />
                <span className="widget-task-title">{run.task_title || "未命名轮次"}</span>
                <span className="widget-task-meta">{AGENT_STATE_LABELS[run.status] ?? run.status}</span>
                <ChevronRight size={12} className="widget-row-chevron" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="widget-empty">
          <Activity size={20} aria-hidden="true" />
          <span>{snapshot ? "当前没有活跃轮次" : "读取中…"}</span>
        </div>
      )}

      {hasLive && summary.disconnected > 0 && (
        <div className="widget-status-line">
          <span className="widget-task-meta">另有 {summary.disconnected} 条失联轮次</span>
        </div>
      )}

      <div className="widget-foot">
        <button className="widget-link" onClick={() => openFullApp("agents")}>
          打开 Agent 页
        </button>
      </div>
    </div>
  );
}
