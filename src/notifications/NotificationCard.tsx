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
  primaryActionFor,
  relativeTime,
  visibleSummary,
  waitingDuration,
} from "./notificationUtils";
import NotificationIcon, { kindAriaLabel } from "./NotificationIcon";
import NotificationActions from "./NotificationActions";
// 项目品牌图标（与 src-tauri/icons 的 01-flat-2d 应用图标同源，取 64px 档兼顾小尺寸清晰度）
import appLogo from "../../assets/branding/icons/01-flat-2d/64x64.png";

function chipClass(kind: string): string {
  if (kind === "agent_done") return "done";
  if (kind === "agent_failed") return "err";
  return "lost";
}

export default function NotificationCard({
  card,
  held = false,
  extraHeld = false,
  leaving,
  expanded,
  busy,
  feedback,
  onExpire,
  onClose,
  onAction,
}: {
  card: QueuedCard;
  /** 窗口已可见时新增：先占位不绘制，等窗口按新高度显示后再播入场动画。 */
  held?: boolean;
  /** 展开详情已请求但窗口高度尚未就绪：只以零高度影子节点参与测量，不绘制。 */
  extraHeld?: boolean;
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
  // 完成=结果摘要、失败=错误原因、等待=等待原因；只用事件回执里的真实内容。
  const summary = visibleSummary(card);

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

  // 详情节点在「窗口高度就绪前」包进零高度影子容器：参与测量但不占布局、
  // 不绘制；窗口长到目标高度后再由正常布局接管并播 ntfDetailIn 动画。
  const extraContent =
    expanded && rows.length > 0 ? (
      <div className="ntf-extra">
        {rows.map((r, i) => (
          <div
            key={`${r.label}-${i}`}
            // 长原因/长路径改为整行左对齐，避免被 max-width 挤成右对齐的多行碎块
            className={`ntf-extra-line${r.value.length > 36 ? " long" : ""}`}
          >
            <span>{r.label}</span>
            <strong className={r.warning ? "warning" : undefined}>{r.value}</strong>
          </div>
        ))}
      </div>
    ) : null;

  return (
    <article
      className={`ntf-card${held ? " ntf-held" : ""}${leaving ? " leaving" : ""}${expanded ? " expanded" : ""}`}
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
      onFocus={(e) => {
        if (e.currentTarget.contains(e.target as Node)) {
          focusRef.current = true;
          syncHold();
        }
      }}
      onBlur={(e) => {
        // 焦点在卡片内按钮间移动时不释放暂停；只有真正离开卡片才恢复倒计时。
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) {
          focusRef.current = false;
          syncHold();
        }
      }}
    >
      <header className="ntf-head">
        <span className="ntf-app-symbol" aria-hidden="true">
          <img src={appLogo} alt="" width={18} height={18} draggable={false} />
        </span>
        <strong>Task Dock</strong>
        <span className="ntf-timestamp">{relativeTime(card.createdAt, now)}</span>
        <button
          type="button"
          className="ntf-icon-btn"
          aria-label="关闭通知"
          data-tip="关闭通知"
          // 卡片顶部贴窗口上缘：气泡朝下才不会被窗口边界裁掉
          data-tip-placement="bottom"
          onClick={() => onClose(card.id)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="ntf-main">
        {/* svg 14px 与 24px 状态图标容器配套（紧凑化，对齐系统通知的信息密度，见 styles-notifications.css） */}
        <NotificationIcon kind={card.kind} size={14} />
        <div className="ntf-title-zone">
          <h3 className="ntf-title">{card.title}</h3>
          <p className="ntf-body">{card.body}</p>
          {summary && (
            // 两行截断：完整内容仍走展开详情，避免长错误/长路径撑破卡片
            <p className="ntf-summary">{summary}</p>
          )}
          {special}
        </div>
      </div>

      {feedback && (
        <p className="ntf-feedback" role="alert">
          {feedback}
        </p>
      )}

      <NotificationActions
        card={card}
        actions={actionsFor(card)}
        primaryId={primaryActionFor(card)}
        busy={busy}
        expanded={expanded}
        onAction={(id) => onAction(card, id)}
      />

      {extraContent &&
        (extraHeld ? (
          <div className="ntf-extra-measure" aria-hidden="true">
            {extraContent}
          </div>
        ) : (
          extraContent
        ))}

      {/* 只有存在补充信息时才提供就地展开；纯重复信息不再显示无意义入口。 */}
      {rows.length > 0 && (
        <button
          type="button"
          className="ntf-inline-expand"
          aria-expanded={expanded}
          aria-label={expanded ? "收起详情" : "展开详情"}
          onClick={toggleExpand}
        >
          <span>{expanded ? "收起详情" : "展开详情"}</span>
          <ChevronDown size={13} className={expanded ? "flip" : undefined} aria-hidden="true" />
        </button>
      )}
    </article>
  );
}
