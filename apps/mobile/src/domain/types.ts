// 领域模型：与桌面端 SQLite 字段语义对齐，但在应用层使用 camelCase。
// 手机端不做第二权威：这里的 `rev` 是同步预留版本号，独立模式下恒为 0。
export type TaskStatus = "pending" | "completed";

/** 0 无 / 1 低 / 2 中 / 3 高，与桌面端 priority 取值一致 */
export type Priority = 0 | 1 | 2 | 3;

/** all=未完成+已完成；today=今天到期且未完成；overdue=已过期且未完成 */
export type TaskFilter = "all" | "pending" | "completed" | "today" | "overdue";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  category: string | null;
  tags: string[];
  /** epoch ms（UTC 存储，展示按设备本地时区） */
  dueAt: number | null;
  remindAt: number | null;
  advanceMinutes: number | null;
  /**
   * 重复规则 JSON（字段见 domain/recurrence.ts）。独立模式下由手机自己推进期次；
   * 联动模式接入后规则会随任务同步，桌面端仍是跨设备合并的权威。
   */
  recurrenceRule: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  rev: number;
}

export interface Capture {
  id: string;
  /** 客户端幂等键，重复提交只保留一条（与桌面端 quick_capture_items.client_id 同思路） */
  clientId: string;
  content: string;
  kind: "text";
  createdAt: number;
  rev: number;
}

export interface TaskCounts {
  total: number;
  pending: number;
  completed: number;
  dueToday: number;
  overdue: number;
}

/** 新建任务入参：只有 title 必填，其余保持 null 表示「不设置」 */
export interface NewTaskInput {
  title: string;
  description?: string;
  priority?: Priority;
  dueAt?: number | null;
  remindAt?: number | null;
  /** 提前提醒的分钟数（与桌面端 advance_minutes 同义）；有值时 remindAt = dueAt - N 分钟 */
  advanceMinutes?: number | null;
  /** 重复规则 JSON；null/缺省表示不重复 */
  recurrenceRule?: string | null;
  tags?: string[];
  category?: string | null;
}
