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

/** 后端 notification-show 事件：round 标识本批通知轮次，fit 回传时原样带回。
 *  仅用于前后端轮次关联，不参与卡片渲染。 */
export interface NotificationShowPayload {
  round: number;
  cards: NotificationCardData[];
}

/** fit_notification_window 的执行结果：applied 是工作区/最大高度钳制后的实际逻辑高度，
 *  可能小于请求高度（此时内容由通知栈内部滚动承载）。 */
export interface NotificationFitResult {
  accepted: boolean;
  round: number;
  applied: number;
  clamped: boolean;
}

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
  /** 任务提醒联动（v41）：仅关联过场景/现场且目标仍存在的提醒卡携带。
   *  动作只在用户显式点击时执行；目标已删除的卡不携带（后端解析层已过滤）。 */
  linkKind?: ReminderLinkKind | null;
  linkTargetId?: string | null;
  /** 联动目标当前名称（进入动作的确认信息用）。 */
  linkLabel?: string | null;
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

/** 任务提醒联动的目标类型（与后端 task_reminder_links.target_kind 对应）。 */
export type ReminderLinkKind = "workspace" | "scene";

/** 动作标识：与 NotificationActions 的处理分支一一对应。
 *  open_scene / open_workspace 是提醒联动动作，点击才执行，绝不自动启动。 */
export type ActionId =
  | "view"
  | "handle"
  | "snooze"
  | "done"
  | "center"
  | "expand"
  | "open_scene"
  | "open_workspace";
