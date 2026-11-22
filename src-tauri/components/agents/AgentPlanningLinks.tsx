import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import {
  planningListAgentFeatureLinks,
  type PlanningAgentFeatureLink,
} from "../../lib/bridge";
import { formatRelative, AGENT_STATE_LABELS } from "../../lib/format";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";

export default function AgentPlanningLinks({
  agentSource,
  sessionId,
}: {
  agentSource: string;
  sessionId: string;
}) {
  const [items, setItems] = useState<PlanningAgentFeatureLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    void planningListAgentFeatureLinks(agentSource, sessionId)
      .then((result) => {
        if (seq === requestSeq.current) setItems(result);
      })
      .catch((cause) => {
        if (seq === requestSeq.current) setError(String(cause));
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
    return () => {
      if (seq === requestSeq.current) requestSeq.current += 1;
    };
  }, [agentSource, sessionId]);

  const openFeature = (link: PlanningAgentFeatureLink) => {
    useGlobalSearchStore.getState().requestPlanningFeatureLocate(link.feature_id, link.project_id);
  };

  return (
    <section className="tree-children" aria-label="关联规划功能">
      <div className="empty-hint">关联项目功能</div>
      {loading ? (
        <div className="empty-hint" role="status">
          <Loader2 size={12} className="spin" aria-hidden="true" /> 正在读取关联…
        </div>
      ) : error ? (
        <div className="empty-hint error-text" role="alert">
          规划关联读取失败：{error}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-hint">暂无关联的规划功能。</div>
      ) : (
        items.map((link) => {
          const status = link.agent_status
            ? AGENT_STATE_LABELS[link.agent_status] ?? "未知"
            : "未知";
          return (
            <div className="tree-row" key={link.id}>
              <span className="tree-row-main">
                <span className="tree-title">{link.feature_title}</span>
                <span className="tree-meta">{link.project_name}</span>
                <span className="run-source">
                  {status} · 最近执行：
                  {link.last_execution_at ? formatRelative(link.last_execution_at) : "未知"}
                </span>
              </span>
              <button
                type="button"
                className="btn sm"
                aria-label={`定位规划功能 ${link.feature_title}`}
                onClick={() => openFeature(link)}
              >
                <ExternalLink size={12} aria-hidden="true" /> 查看功能
              </button>
            </div>
          );
        })
      )}
    </section>
  );
}
