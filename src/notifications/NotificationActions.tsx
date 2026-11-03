//! 通知动作按钮：统一按钮基元（hover/active/focus-visible/disabled 全态）。
//! 动作执行由 NotificationWindow 分发（invoke 后端命令）；这里只负责渲染与回调。
//! 无真实能力的动作（重试/重连）不渲染 —— 规格禁止伪造操作入口。

import type { ActionId } from "./notificationTypes";

export const ACTION_LABELS: Record<ActionId, string> = {
  view: "查看详情",
  handle: "立即处理",
  snooze: "稍后提醒",
  center: "通知中心",
  expand: "展开详情",
};

export default function NotificationActions({
  actions,
  primaryId,
  busy,
  expanded,
  onAction,
}: {
  actions: ActionId[];
  primaryId: ActionId | null;
  busy: ActionId | null;
  expanded: boolean;
  onAction: (id: ActionId) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="ntf-actions">
      {actions.map((id) => (
        <button
          key={id}
          type="button"
          className={`ntf-cta${id === primaryId ? " strong" : ""}`}
          disabled={busy !== null}
          aria-busy={busy === id}
          data-ntf-action={id}
          onClick={() => onAction(id)}
        >
          {id === "expand" ? (expanded ? "收起详情" : "展开详情") : ACTION_LABELS[id]}
        </button>
      ))}
    </div>
  );
}
