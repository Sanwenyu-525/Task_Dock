import { useEffect, useRef, useState } from "react";
import { ExternalLink, Link2, Loader2, Unlink } from "lucide-react";

import {
  planningListFeatureAgentLinks,
  planningUnlinkAgentSession,
  type PlanningAgentFeatureLink,
} from "../../lib/bridge";
import { formatRelative, AGENT_STATE_LABELS } from "../../lib/format";
import { useUiStore } from "../../store/useUiStore";

export default function FeatureAgentLinks({ featureId }: { featureId: string }) {
  const [items, setItems] = useState<PlanningAgentFeatureLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const mounted = useRef(true);
  const showToast = useUiStore((s) => s.showToast);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSeq.current += 1;
    };
  }, []);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    void planningListFeatureAgentLinks(featureId)
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
  }, [featureId, reloadKey]);

  const unlink = async (link: PlanningAgentFeatureLink) => {
    setBusyId(link.id);
    try {
      await planningUnlinkAgentSession(featureId, link.agent_source, link.session_id);
      if (!mounted.current) return;
      setReloadKey((key) => key + 1);
      showToast("Agent 关联已解除", { kind: "success" });
    } catch (cause) {
      if (mounted.current) showToast(`解除 Agent 关联失败：${String(cause)}`, { kind: "error" });
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const openSession = (link: PlanningAgentFeatureLink) => {
    if (!link.agent_session_id) return;
    const ui = useUiStore.getState();
    ui.setTab("agents");
    ui.focusAgent({
      sourceId: link.agent_source,
      sessionId: link.agent_session_id,
      refId: null,
    });
  };

  return (
    <section className="planning-detail-block" aria-label="关联 Agent">
      <h4>
        <Link2 size={13} aria-hidden="true" /> 关联 Agent
      </h4>
      {loading ? (
        <p className="planning-section-empty" role="status">
          <Loader2 size={12} className="spin" aria-hidden="true" /> 正在读取 Agent 关联…
        </p>
      ) : error ? (
        <p className="planning-history-error" role="alert">
          Agent 关联读取失败：{error}
          <button className="btn sm" onClick={() => setReloadKey((key) => key + 1)}>
            重试
          </button>
        </p>
      ) : items.length === 0 ? (
        <p className="planning-section-empty">暂无 Agent 关联。</p>
      ) : (
        <ul className="planning-act-list">
          {items.map((link) => {
            const knownStatus = link.agent_status
              ? AGENT_STATE_LABELS[link.agent_status] ?? "未知"
              : "未知";
            return (
              <li className="planning-act" key={link.id}>
                <span className="planning-act-kind">
                  {link.agent_name || "未知 Agent"}
                  <span className="run-source">{link.agent_source}</span>
                </span>
                <span className="planning-act-body" style={{ overflowWrap: "anywhere" }}>
                  会话 ID：{link.session_id}
                </span>
                <span className="planning-act-time">
                  Agent 状态：{knownStatus} · 最近执行：
                  {link.last_execution_at ? formatRelative(link.last_execution_at) : "未知"}
                  {link.status === "unlinked" ? " · 已解除关联" : " · 已关联"}
                </span>
                <span className="planning-detail-foot-actions">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!link.agent_session_id}
                    data-tip={!link.agent_session_id ? "没有匹配的真实 Agent 会话" : undefined}
                    aria-label={`跳转 Agent 会话 ${link.session_id}`}
                    onClick={() => openSession(link)}
                  >
                    <ExternalLink size={12} aria-hidden="true" /> 跳转会话
                  </button>
                  {link.status === "linked" && (
                    <button
                      type="button"
                      className="btn sm subtle"
                      disabled={busyId === link.id}
                      aria-label={`解除 ${link.agent_source} 会话关联`}
                      onClick={() => void unlink(link)}
                    >
                      {busyId === link.id ? (
                        <Loader2 size={12} className="spin" aria-hidden="true" />
                      ) : (
                        <Unlink size={12} aria-hidden="true" />
                      )}
                      解除关联
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
