//! Agent 面板（胶囊内，对照 `docs/screenshots/v07/停靠效果图/02-agents.png`）。
//!
//! 「消息数量不能简单用累计历史」的落点：这里只列**实时**运行
//! （`liveRuns`：running / waiting / 近 1 小时 failed / disconnected），
//! 并按 failed → waiting → running → disconnected 排序，需要人处理的排最前。
//!
//! 效果图里的 Agent 名称、会话数、轮次都只是视觉示例；这里全部来自
//! `useAgentsStore.snapshot`（本地事件流），没有的字段（如进度百分比）不显示，
//! 也不提供后端不支持的「暂停 / 重启 / 新建 Agent」。
//! 每个 Agent 能做的只有两件真实存在的事：打开它的会话，或进入完整 Agent 页。

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Activity, ArrowUpRight, Bot, ChevronRight, RefreshCw } from "lucide-react";
import { openAgentSession } from "../../lib/bridge";
import { useAgentsStore } from "../../store/useAgentsStore";
import { liveRuns, liveSummary } from "../../lib/agentTree";
import { AGENT_STATE_LABELS } from "../../lib/format";
import { avatarHue } from "../../lib/navigation";
import { openFullApp } from "./actions";
import { EmptyState, PanelHead } from "./PanelKit";

const STATE_ORDER: Record<string, number> = {
  failed: 0,
  waiting: 1,
  running: 2,
  disconnected: 3,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** 最近活动时间：今天显示 HH:mm，其他显示 M/D。 */
function stamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function AgentsLite() {
  const snapshot = useAgentsStore((s) => s.snapshot);
  const load = useAgentsStore((s) => s.load);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 面板打开时补一次快照（既有的节流/单飞机制保证不会打爆 IPC）
  useEffect(() => {
    if (!snapshot) void load();
  }, [snapshot, load]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(t);
  }, [notice]);

  const summary = useMemo(() => liveSummary(snapshot), [snapshot]);
  const runs = useMemo(
    () =>
      [...liveRuns(snapshot?.runs ?? [])]
        .sort((a, b) => {
          const ra = STATE_ORDER[a.status] ?? 9;
          const rb = STATE_ORDER[b.status] ?? 9;
          if (ra !== rb) return ra - rb;
          return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
        })
        .slice(0, 8),
    [snapshot],
  );
  const monitored = summary.running + summary.waiting + summary.failed + summary.disconnected;
  const attention = summary.waiting + summary.failed;

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await load();
    } catch {
      setNotice("刷新失败");
    } finally {
      setBusy(false);
    }
  };

  const open = async (sourceId: string, sessionId: string) => {
    try {
      await openAgentSession(sourceId, sessionId);
    } catch {
      // 会话跳转依赖具体 Agent 的能力：失败时如实提示，不伪造成功
      setNotice("打开会话失败");
    }
  };

  return (
    <>
      <PanelHead
        title="Agent"
        sub="监控状态与快速跳转"
        actions={
          <>
            {/* 效果图右侧是「搜索 / 筛选 / 新建」三颗按钮；后端没有搜索、筛选、
                新建 Agent 的接口，因此只保留两件真实可做的事：刷新快照、进完整页。 */}
            <button
              type="button"
              className="cap-iconbtn"
              aria-label="刷新 Agent 状态"
              aria-disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="cap-iconbtn"
              aria-label="在完整页打开 Agent"
              onClick={() => openFullApp("agents")}
            >
              <ArrowUpRight size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </>
        }
      />

      <div className="cap-summary">
        <Activity size={13} strokeWidth={1.9} aria-hidden="true" />
        {snapshot === null ? (
          <span>读取中…</span>
        ) : (
          <span>
            监控中 <b>{monitored}</b> · 运行中 <b>{summary.running}</b> · 待处理 <b>{attention}</b>
          </span>
        )}
      </div>

      <div className="cap-list">
        {snapshot !== null && runs.length === 0 && (
          <EmptyState
            icon={<Bot size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="未检测到运行中的 Agent"
            actionLabel="查看接入配置"
            onAction={() => openFullApp("agents")}
          />
        )}
        {runs.map((r) => {
          const session = snapshot?.sessions.find((s) => s.id === r.session_id);
          const title = r.task_title || session?.title || r.source_id;
          const label = AGENT_STATE_LABELS[r.status] ?? r.status;
          const sessionCount = snapshot?.sessions.filter((s) => s.source_id === r.source_id).length ?? 0;
          const runCount = snapshot?.runs.filter((x) => x.source_id === r.source_id).length ?? 0;
          const hue = avatarHue(r.source_id || title);
          return (
            <div className="cap-item cap-agent-row" key={r.id}>
              <span
                className="cap-tile tile-sm"
                style={{ "--app-hue": String(hue) } as CSSProperties}
                aria-hidden="true"
              >
                <span className="cap-agent-initial">{title.slice(0, 1).toUpperCase()}</span>
              </span>
              <span className="cap-main">
                <span className="cap-agent-head">
                  <span className="cap-agent-name" title={title}>
                    {title}
                  </span>
                  <span className={`cap-state state-${r.status}`}>{label}</span>
                </span>
                <span className="cap-agent-meta">
                  会话 {sessionCount}
                  <i className="sep" aria-hidden="true" />
                  运行 {runCount}
                  {stamp(r.updated_at) ? (
                    <>
                      <i className="sep" aria-hidden="true" />
                      {stamp(r.updated_at)}
                    </>
                  ) : null}
                </span>
                {r.pending_items.length > 0 ? (
                  <span className="cap-agent-meta">待确认 {r.pending_items.length} 项</span>
                ) : null}
              </span>
              <span className="cap-agent-side">
                {r.session_id ? (
                  <button
                    type="button"
                    className="cap-mini"
                    aria-label={`打开 ${title} 的会话`}
                    onClick={() => void open(r.source_id, r.session_id)}
                  >
                    打开
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cap-mini is-icon"
                    aria-label={`查看 ${title}`}
                    onClick={() => openFullApp("agents")}
                  >
                    <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">{notice ?? "状态来自本地事件流"}</span>
        <button type="button" className="cap-link" onClick={() => openFullApp("agents")}>
          Agent 页
          <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
