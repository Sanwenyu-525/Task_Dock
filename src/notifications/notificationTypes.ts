//! 通知窗口数据契约：与后端 notification_window.rs::NotificationCardPayload
//! （serde camelCase）一一对应。未知 kind 归一化为 generic，不崩窗口。

/** 六种状态模板 + 提醒/摘要复用同一骨架。 */
export type NotificationKind =
  | "agent_running"
  | "agent_waiting"
  | "agent_done"
  | "agent_failed"
  | "agent_disconnected"
  | "reminder"
  | "digest"
  | "generic";

/** 后端 notification-show 事件的单张卡片载荷。 */
export interface NotificationCardData {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** RFC3339（后端受理时间） */
  createdAt: string;
  sourceId?: string | null;
  sessionId?: string | null;
  refId?: string | null;
  /** 事件原因/错误摘要（失败卡的错误原因、等待卡的等待原因） */
  detail?: string | null;
}

/** 展示态卡片：合并键 + 自动消失期限（悬停/展开暂停时由栈重算）。 */
export interface QueuedCard extends NotificationCardData {
  /** 相同键的新事件更新既有卡片而不是新建（同一轮次合并） */
  mergeKey: string;
  /** epoch ms；null 仅出现在理论异常态（会被立即恢复） */
  expiresAt: number;
  /** 折叠进摘要卡的来源（仅 digest 卡携带） */
  folded?: { kind: string; title: string }[];
}

/** 展开详情里的一行 key-value。 */
export interface DetailRow {
  label: string;
  value: string;
  /** 警示行（断连卡的原则说明） */
  warning?: boolean;
}

/** 动作标识：与 NotificationActions 的处理分支一一对应。 */
export type ActionId = "view" | "handle" | "snooze" | "done" | "center" | "expand";
