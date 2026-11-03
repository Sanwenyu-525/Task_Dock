//! 统一通知卡片骨架：六种状态共用一个组件，按 kind 调整
//! 信息密度、语义色调与特殊区块（进度/等待/断连原则说明/合并计数）。
//!
//! 自动消失计时：hover / 键盘焦点 / 展开详情时暂停并记录剩余时间，
//! 离开后**续接剩余时间**（不是每次重获完整时长）；组件卸载清理定时器。

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Clock, Link2Off, X } from "lucide-react";
import type { ActionId, QueuedCard } from "./notificationTypes";
import {
  actionsFor,
  countByKind,
  detailRows,
  normalizeKind,
  relativeTime,
  waitingDuration,
} from "./notificationUtils";
import NotificationIcon, { kindAriaLabel } from "./NotificationIcon";
import NotificationActions from "./NotificationActions";

function BrandGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="m6 3 3.2 1.3 1.3 3.2-1.3 3.2L6 12 2.8 10.7 1.5 7.5l1.3-3.2L6 3Zm9 3 2.3 4.7L22 13l-4.7 2.3L15 20l-2.3-4.7L8 13l4.7-2.3L15 6Z"
      />
    </svg>
  );
}

function chipClass(kind: string): string {
  if (kind === "agent_done") return "done";
  if (kind === "agent_failed") return "err";
  return "lost";
}

export default function NotificationCard({
  card,
  leaving,
  expanded,
  busy,
  feedback,
  onExpire,
  onClose,
  onAction,
}: {
  card: QueuedCard;
  leaving: boolean;
  expanded: boolean;
  busy: ActionId | null;
  feedback: string | null;
  onExpire: (id: string) => void;
  onClose: (id: string) => void;
  onAction: (card: QueuedCard, id: ActionId) => void;
}) {
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  /** 暂停时刻的剩余 ms；null = 未暂停过（用 expiresAt 全量） */
  const remainingRef = useRef<number | null>(null);

  const hold = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    const base = remainingRef.current;
    const deadline = base !== null ? Date.now() + base : card.expiresAt;
    remainingRef.current = Math.max(0, deadline - Date.now());
    setPaused(true);
  }, [card.expiresAt]);

  const release = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
  }, []);

  const syncHold = useCallback(() => {
    if (hoverRef.current || focusRef.current || expanded) {
      hold();
    } else {
      release();
    }
  }, [expanded, hold, release]);

  // 卡片被同键新事件替换：重置为完整时长（内容已更新）
  useEffect(() => {
    remainingRef.current = null;
  }, [card.expiresAt]);

  // 展开期间暂停自动消失；收起后按悬停/焦点状态恢复
  useEffect(() => {
    syncHold();
  }, [syncHold]);

  // 自动消失：离开后从剩余时间续接
  useEffect(() => {
    if (paused || leaving) return;
    const base = remainingRef.current;
    const deadline = base !== null ? Date.now() + base : card.expiresAt;
    const t = window.setTimeout(() => onExpire(card.id), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(t);
  }, [paused, leaving, card.id, card.expiresAt, onExpire]);

  const kind = normalizeKind(card.kind);
  const now = Date.now();
  const rows = detailRows(card, now);

  const toggleExpand = () => onAction(card, "expand");

  let special: React.ReactNode = null;
  if (kind === "agent_running") {
    // 无可靠进度数据：只提供不确定进度样式，不伪造百分比
    special = (
      <div className="ntf-progress-row" aria-hidden="true">
        <div className="ntf-progress-track">
          <div className="ntf-progress-fill indeterminate" />
        </div>
      </div>
    );
  } else if (kind === "agent_waiting") {
    special = (
      <div className="ntf-inline-meta">
        <Clock size={14} aria-hidden="true" />
        <span>已等待 {waitingDuration(card.createdAt, now)}</span>
      </div>
    );
  } else if (kind === "agent_disconnected") {
    special = (
      <div className="ntf-inline-meta">
        <Link2Off size={14} aria-hidden="true" />
        <span>连接中断，不代表任务执行失败。</span>
      </div>
    );
  } else if (kind === "digest" && card.folded?.length) {
    const counts = countByKind(card.folded);
    special = (
      <div className="ntf-count-line">
        {Object.entries(counts).map(([k, n]) => (
          <span key={k} className={`ntf-count-chip ${chipClass(k)}`}>
            <NotificationIcon kind={k} size={12} />
            <b>{n}</b>
          </span>
        ))}
      </div>
    );
  }

  return (
    <article
      className={`ntf-card${leaving ? " leaving" : ""}${expanded ? " expanded" : ""}`}
      data-state={kind}
      role="group"
      aria-label={kindAriaLabel(card.kind)}
      onMouseEnter={() => {
        hoverRef.current = true;
        syncHold();
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
        syncHold();
      }}
      onFocus={() => {
        focusRef.current = true;
        syncHold();
      }}
      onBlur={() => {
        focusRef.current = false;
        syncHold();
      }}
    >
      <header className="ntf-head">
        <span className="ntf-app-symbol" aria-hidden="true">
          <BrandGlyph />
        </span>
        <strong>Task Dock</strong>
        <span className="ntf-timestamp">{relativeTime(card.createdAt, now)}</span>
        <button
          type="button"
          className="ntf-icon-btn"
          aria-label="关闭通知"
          data-tip="关闭通知"
          onClick={() => onClose(card.id)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="ntf-main">
        <NotificationIcon kind={card.kind} />
        <div className="ntf-title-zone">
          <h3 className="ntf-title">{card.title}</h3>
          <p className="ntf-body">{card.body}</p>
          {special}
        </div>
      </div>

      {feedback && (
        <p className="ntf-feedback" role="alert">
          {feedback}
        </p>
      )}

      <NotificationActions
        actions={actionsFor(card)}
        primaryId={kind === "agent_waiting" ? "handle" : kind === "digest" ? "expand" : "view"}
        busy={busy}
        expanded={expanded}
        onAction={(id) => onAction(card, id)}
      />

      {expanded && rows.length > 0 && (
        <div className="ntf-extra">
          {rows.map((r, i) => (
            <div key={`${r.label}-${i}`} className="ntf-extra-line">
              <span>{r.label}</span>
              <strong className={r.warning ? "warning" : undefined}>{r.value}</strong>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="ntf-inline-expand" onClick={toggleExpand}>
        <span>{expanded ? "收起详情" : "展开详情"}</span>
        <ChevronDown size={13} className={expanded ? "flip" : undefined} aria-hidden="true" />
      </button>
    </article>
  );
}
