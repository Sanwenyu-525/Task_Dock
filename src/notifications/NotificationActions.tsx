//! 通知动作按钮：统一按钮基元（hover/active/focus-visible/disabled 全态）。
//! 动作执行由 NotificationWindow 分发（invoke 后端命令）；这里只负责渲染与回调。
//! 无真实能力的动作（重试/重连）不渲染 —— 规格禁止伪造操作入口。

import type { ActionId, QueuedCard } from "./notificationTypes";
import { actionLabel, isLightweightActionCard } from "./notificationUtils";

export default function NotificationActions({
  card,
  actions,
  primaryId,
  busy,
  expanded,
  onAction,
}: {
  card: QueuedCard;
  actions: ActionId[];
  primaryId: ActionId | null;
  busy: ActionId | null;
  expanded: boolean;
  onAction: (id: ActionId) => void;
}) {
  if (actions.length === 0) return null;
  // 完成/执行中只有单个跳转动作时用轻量文字，不再占整行强主按钮。
  const lightweight = isLightweightActionCard(card) && actions.length === 1;
  return (
    <div className={`ntf-actions${lightweight ? " lightweight" : ""}`}>
      {actions.map((id) => (
        <button
          key={id}
          type="button"
          className={`ntf-cta${id === primaryId ? " strong" : ""}${lightweight ? " text" : ""}`}
          disabled={busy !== null}
          aria-busy={busy === id}
          data-ntf-action={id}
          onClick={() => onAction(id)}
        >
          {id === "expand"
            ? expanded
              ? "收起详情"
              : "展开详情"
            : actionLabel(card, id)}
        </button>
      ))}
    </div>
  );
}
