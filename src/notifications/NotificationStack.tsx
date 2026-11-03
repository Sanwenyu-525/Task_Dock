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
  rootRef,
  onExpire,
  onClose,
  onAction,
}: {
  cards: QueuedCard[];
  leavingIds: ReadonlySet<string>;
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
        <NotificationCard
          // 同键更新就地复用实例（不重放入场动画）；不同键互不干扰
          key={card.mergeKey}
          card={card}
          leaving={leavingIds.has(card.id)}
          expanded={expandedId === card.id}
          busy={busy}
          feedback={feedback?.id === card.id ? feedback.msg : null}
          onExpire={onExpire}
          onClose={onClose}
          onAction={onAction}
        />
      ))}
    </div>
  );
}
