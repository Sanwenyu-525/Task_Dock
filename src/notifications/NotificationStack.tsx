//! 通知栈：多条通知排列、堆叠压缩与展开互斥的展示层。
//! 队列状态在 NotificationWindow（事件入口），这里只渲染。

import type { ActionId, QueuedCard } from "./notificationTypes";
import NotificationCard from "./NotificationCard";

export default function NotificationStack({
  cards,
  leavingIds,
  expandedId,
  busy,
  feedback,
  heldKeys,
  rootRef,
  onExpire,
  onClose,
  onAction,
}: {
  cards: QueuedCard[];
  leavingIds: ReadonlySet<string>;
  /** 窗口已可见时新增的卡片键：先占位（不绘制）等窗口长高，避免入场瞬间被裁。 */
  heldKeys: ReadonlySet<string>;
  expandedId: string | null;
  busy: ActionId | null;
  feedback: { id: string; msg: string } | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  onExpire: (id: string) => void;
  onClose: (id: string) => void;
  onAction: (card: QueuedCard, id: ActionId) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div
      ref={rootRef}
      className={`ntf-stack${cards.length > 1 ? " stacked" : ""}`}
      role="region"
      aria-label="桌面通知"
      aria-live="polite"
    >
      {cards.map((card) => (
        // 槽位负责“离场后自然填补”：收缩高度 150ms，其余卡片平滑上移而非瞬跳。
        <div
          key={card.mergeKey}
          className={`ntf-slot${leavingIds.has(card.id) ? " leaving" : ""}`}
        >
          <NotificationCard
            // 同键更新就地复用实例（不重放入场动画）；不同键互不干扰
            card={card}
            held={heldKeys.has(card.mergeKey)}
            leaving={leavingIds.has(card.id)}
            expanded={expandedId === card.id}
            busy={busy}
            feedback={feedback?.id === card.id ? feedback.msg : null}
            onExpire={onExpire}
            onClose={onClose}
            onAction={onAction}
          />
        </div>
      ))}
    </div>
  );
}
