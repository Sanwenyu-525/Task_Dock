//! 胶囊专注徽标：只展示当前状态与剩余时间，不承载任何控制。
//!
//! 数据与工作台共用同一个 store 与同一组后端事件（引用计数保证全应用只有
//! 一组监听）；倒计时同样只做「快照 remaining_ms − 经过时间」的展示级推算，
//! 不持有本地递减的权威计时。胶囊无活动会话时不渲染任何内容，避免占位。

import { useEffect } from "react";
import { Coffee, Pause, Timer } from "lucide-react";

import { useSharedClock } from "../../lib/sharedClock";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import {
  acquireFocusEvents,
  formatRemaining,
  remainingFromSnapshot,
  useFocusStore,
  type FocusSessionView,
} from "../../store/useFocusStore";
import "./focus.css";

/** 徽标文案按已存在的 `focus.badge.*` / `focus.state.paused` 键取值。 */
function badgeLabel(
  active: FocusSessionView,
  t: (key: MessageKey) => string,
): string {
  if (active.state === "paused") return t("focus.state.paused");
  if (active.kind === "short_break") return t("focus.badge.shortBreak");
  if (active.kind === "long_break") return t("focus.badge.longBreak");
  return t("focus.badge.focus");
}

function BadgeIcon({ active }: { active: FocusSessionView }) {
  if (active.state === "paused") return <Pause size={11} aria-hidden="true" />;
  if (active.kind !== "focus") return <Coffee size={11} aria-hidden="true" />;
  return <Timer size={11} aria-hidden="true" />;
}

export interface FocusCapsuleBadgeProps {
  /** 点击后打开专注工作台；不传则只作为状态展示。 */
  onClick?: () => void;
  className?: string;
}

export default function FocusCapsuleBadge({ onClick, className }: FocusCapsuleBadgeProps) {
  const snapshot = useFocusStore((s) => s.snapshot);
  const snapshotAt = useFocusStore((s) => s.snapshotAt);
  const now = useSharedClock();
  const { t } = useLocale();

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | null = null;
    // 胶囊面板折叠时本组件会被卸载，期间的 focus-changed/completed/sedentary 事件
    // 无人接收。每次挂载都必须重新拉取真实快照，否则会把旧会话当成当前状态展示
    // （倒计时归零后也不会再更新）。
    void useFocusStore.getState().load();
    void acquireFocusEvents().then((off) => {
      if (disposed) off();
      else release = off;
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, []);

  const active = snapshot?.active ?? null;
  if (!active) return null;

  const remaining = remainingFromSnapshot(active, snapshotAt, now);
  const label = badgeLabel(active, t);
  const text = formatRemaining(remaining);
  const ariaLabel = t("focus.badge.aria", { label, time: text });
  const classes = `focus-capsule-badge state-${active.state} kind-${active.kind} ${
    className ?? ""
  }`.trim();

  if (!onClick) {
    return (
      <span className={classes} role="status" aria-label={ariaLabel} data-tip={ariaLabel}>
        <BadgeIcon active={active} />
        <span className="focus-capsule-label">{label}</span>
        <span className="focus-capsule-time">{text}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      aria-label={ariaLabel}
      data-tip={ariaLabel}
    >
      <BadgeIcon active={active} />
      <span className="focus-capsule-label">{label}</span>
      <span className="focus-capsule-time">{text}</span>
    </button>
  );
}
