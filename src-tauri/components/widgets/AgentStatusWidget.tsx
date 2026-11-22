//! Agent 状态微件：复用 useAgentsStore 的快照与事件刷新，无独立扫描/轮询。
//! 只展示实时轮次计数与最需关注的 3 条，详细操作交给 Agent 页。

import { useEffect } from "react";
import { Activity, AlertTriangle, ChevronRight } from "lucide-react";

import { AGENT_STATE_LABELS } from "../../lib/format";
import { liveSummary } from "../../lib/agentTree";
import { attentionRuns } from "../../lib/widgets/selectors";
import { useLocale } from "../../hooks/useLocale";
import { useAgentsStore } from "../../store/useAgentsStore";
import { openFullApp } from "../capsule/actions";

export interface AgentStatusWidgetProps {
  /** 独立桌面窗口：打开主窗口 Agent 页；默认使用本窗口导航。 */
  onOpenAgents?: () => void;
  /** 独立桌面窗口不得自行 load（否则每个窗口启动一套刷新），由主窗口快照注入。 */
  autoLoad?: boolean;
}

export default function AgentStatusWidget({ onOpenAgents, autoLoad = true }: AgentStatusWidgetProps) {
  const { t } = useLocale();
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
  const load = useAgentsStore((s) => s.load);

  // 首次挂载若还没有快照，复用既有 load（单飞刷新）；之后完全由全局事件驱动。
  // 桌面微件窗口关闭 autoLoad：数据统一由主窗口出版本快照，避免多 WebView 重复扫描。
  useEffect(() => {
    if (autoLoad && !snapshot) void load();
  }, [autoLoad, snapshot, load]);

  const openAgents = () => (onOpenAgents ? onOpenAgents() : openFullApp("agents"));

  const summary = liveSummary(snapshot);
  const runs = attentionRuns(snapshot?.runs ?? [], Date.now(), 3);
  const hasLive = summary.running + summary.waiting + summary.failed + summary.disconnected > 0;

  return (
    <div className="widget-agents">
      <div className="widget-chips">
        <span className="widget-chip running">
          {t("widgets.agentStatus.running", { n: summary.running })}
        </span>
        <span className={`widget-chip waiting ${summary.waiting > 0 ? "" : "muted"}`}>
          {t("widgets.agentStatus.waiting", { n: summary.waiting })}
        </span>
        <span className={`widget-chip failed ${summary.failed > 0 ? "" : "muted"}`}>
          {t("widgets.agentStatus.failed", { n: summary.failed })}
        </span>
      </div>

      {snapshotError && (
        <div className="widget-status-line">
          <span className="widget-warn">
            <AlertTriangle size={12} aria-hidden="true" /> {t("widgets.agentStatus.stale")}
          </span>
        </div>
      )}

      {runs.length > 0 ? (
        <ul className="widget-list" aria-label={t("widgets.agentStatus.listAria")}>
          {runs.map((run) => {
            const runTitle = run.task_title || t("widgets.agentStatus.unnamedRun");
            return (
              <li key={run.id}>
                <button
                  className="widget-row"
                  aria-label={t("widgets.agentStatus.openRunAria", { title: runTitle })}
                  onClick={openAgents}
                >
                  <span className={`widget-state-dot state-${run.status}`} aria-hidden="true" />
                  <span className="widget-task-title">{runTitle}</span>
                  <span className="widget-task-meta">
                    {AGENT_STATE_LABELS[run.status] ?? run.status}
                  </span>
                  <ChevronRight size={12} className="widget-row-chevron" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="widget-empty">
          <Activity size={20} aria-hidden="true" />
          <span>
            {snapshot
              ? t("widgets.agentStatus.noRuns")
              : snapshotError
                ? t("common.failed")
                : t("widgets.agentStatus.loading")}
          </span>
        </div>
      )}

      {hasLive && summary.disconnected > 0 && (
        <div className="widget-status-line">
          <span className="widget-task-meta">
            {t("widgets.agentStatus.disconnected", { n: summary.disconnected })}
          </span>
        </div>
      )}

      <div className="widget-foot">
        <button className="widget-link" onClick={openAgents}>
          {t("widgets.agentStatus.openPanel")}
        </button>
      </div>
    </div>
  );
}
