//! Agent 面板（胶囊内）：需要处理的状态优先，其次运行中。
//!
//! 「消息数量不能简单用累计历史」的落点：这里只列**实时**运行
//! （`liveRuns`：running / waiting / 近 1 小时 failed / disconnected），
//! 并按 failed → waiting → running → disconnected 排序，需要人处理的排最前。

import { useEffect } from "react";
import { ArrowUpRight, Bot } from "lucide-react";
import { openAgentSession } from "../../lib/bridge";
import { useAgentsStore } from "../../store/useAgentsStore";
import { liveRuns } from "../../lib/agentTree";
import { AGENT_STATE_LABELS } from "../../lib/format";
import { openFullApp } from "./actions";

const STATE_ORDER: Record<string, number> = {
  failed: 0,
  waiting: 1,
  running: 2,
  disconnected: 3,
};

export default function AgentsLite() {
  const snapshot = useAgentsStore((s) => s.snapshot);
  const load = useAgentsStore((s) => s.load);

  // 面板打开时补一次快照（既有的节流/单飞机制保证不会打爆 IPC）
  useEffect(() => {
    if (!snapshot) void load();
  }, [snapshot, load]);

  const runs = [...liveRuns(snapshot?.runs ?? [])]
    .sort((a, b) => {
      const ra = STATE_ORDER[a.status] ?? 9;
      const rb = STATE_ORDER[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    })
    .slice(0, 5);

  const attention = runs.filter((r) => r.status === "waiting" || r.status === "failed").length;

  return (
    <>
      <header className="capsule-head">
        <span className="capsule-title">Agent</span>
        <span className="capsule-meta">
          {snapshot === null ? "读取中" : attention > 0 ? `${attention} 个待处理` : `${runs.length} 个实时`}
        </span>
      </header>

      <div className="capsule-body">
        {snapshot !== null && runs.length === 0 && (
          <div className="capsule-empty">
            <Bot size={20} strokeWidth={1.6} aria-hidden="true" />
            <p>未检测到运行中的 Agent</p>
            <button type="button" className="capsule-link" onClick={() => openFullApp("agents")}>
              查看接入配置
            </button>
          </div>
        )}
        {runs.map((r) => {
          const session = snapshot?.sessions.find((s) => s.id === r.session_id);
          const title = r.task_title || session?.title || r.source_id;
          return (
            <div className="capsule-row" key={r.id}>
              <span className={`capsule-state-dot state-${r.status}`} aria-hidden="true" />
              <span className="capsule-row-main">
                <span className="capsule-row-title">{title}</span>
                <span className={`capsule-row-sub state-${r.status}`}>
                  {AGENT_STATE_LABELS[r.status] ?? r.status}
                  {r.pending_items.length > 0 ? ` · ${r.pending_items.length} 项待确认` : ""}
                </span>
              </span>
              <button
                type="button"
                className="capsule-icon-btn"
                aria-label={`打开 ${title}`}
                onClick={() => void openAgentSession(r.source_id, r.session_id).catch(() => {})}
              >
                <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      <footer className="capsule-foot">
        <span className="capsule-hint">状态来自本地事件流</span>
        <button type="button" className="capsule-link" onClick={() => openFullApp("agents")}>
          Agent 页
        </button>
      </footer>
    </>
  );
}
