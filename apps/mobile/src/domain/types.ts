// 领域模型：与桌面端 SQLite 字段语义对齐，但在应用层使用 camelCase。
// 手机端不做第二权威：这里的 `rev` 是同步预留版本号，独立模式下恒为 0。
export type TaskStatus = "pending" | "completed";

/** 0 无 / 1 低 / 2 中 / 3 高，与桌面端 priority 取值一致 */
export type Priority = 0 | 1 | 2 | 3;

/** all=未完成+已完成；today=今天到期且未完成；overdue=已过期且未完成 */
export type TaskFilter = "all" | "pending" | "completed" | "today" | "overdue";

/** 任务页主筛选：只看状态，不和时间范围混在一起 */
export type TaskStatusFilter = "all" | "pending" | "completed";

/** 任务页次级筛选：时间范围；any = 不限制 */
export type TaskPeriodFilter = "any" | "today" | "week" | "later" | "undated" | "overdue";

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
  /** 桌面端最后下发的版本号；push 的 base_rev 来源。0 = 从未同步过。 */
  serverRev: number;
}

export interface Capture {
  id: string;
  /** 客户端幂等键，重复提交只保留一条（与桌面端 quick_capture_items.client_id 同思路） */
  clientId: string;
  content: string;
  /** 桌面端 kind 原样保留；手机端 UI 目前一律按纯文本展示 */
  kind: string;
  createdAt: number;
  rev: number;
  /** 桌面端最后下发的版本号；push 的 base_rev 来源。0 = 从未同步过。 */
  serverRev: number;
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

/**
 * 笔记：纯本机的长文本记录。title 允许为空（列表回退展示摘要/「无标题」），
 * pinned/favorited 只影响列表排序与筛选，不参与任何业务判定。
 * rev 与 tasks 同语义：同步预留版本号，每次写 +1。
 */
export interface Note {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  favorited: boolean;
  createdAt: number;
  updatedAt: number;
  rev: number;
  /** 桌面端最后下发的版本号；push 的 base_rev 来源。0 = 从未同步过。 */
  serverRev: number;
}

/** 新建笔记入参：title/body 都可以为空串，空笔记在保存前会被编辑器丢弃 */
export interface NewNoteInput {
  title?: string;
  body?: string;
  pinned?: boolean;
  favorited?: boolean;
}

/**
 * 采集附件类型。只影响本机展示与传输，不进入同步载荷：
 * 收集箱文本仍是唯一同步实体（见 docs/mobile/02-data-model.md §附件）。
 */
export type AttachmentKind = "image" | "audio" | "file";

/** 附件归属：收集箱条目 / 笔记 / 任务。转任务时改归属，不复制文件。 */
export type AttachmentOwner = "capture" | "note" | "task";

/**
 * 附件送到桌面端的独立生命周期。与文本同步状态严格分开：
 * - pending：本地已保存，尚未尝试传输（离线/未配对/用户未开启自动传送）
 * - uploading：正在走文件互传通道
 * - sent：桌面端已完整接收（有 remote_file_id）
 * - failed：本次传输失败，可重试（不丢本地文件）
 * - skipped：用户明确选择不传送
 */
export type AttachmentTransferState = "pending" | "uploading" | "sent" | "failed" | "skipped";

export interface Attachment {
  id: string;
  ownerEntity: AttachmentOwner;
  ownerId: string;
  kind: AttachmentKind;
  mime: string;
  /** 展示用文件名（已做路径清洗，绝不含路径分隔符） */
  name: string;
  /** 应用私有存储里的 file:// URI；不写进任何同步文本字段 */
  localUri: string;
  size: number;
  /** 图片宽高，非图片为 null */
  width: number | null;
  height: number | null;
  /** 语音时长（毫秒），非语音为 null */
  durationMs: number | null;
  /** 语音的人工转写/编辑结果；没有识别结果时保持 null，不伪造 */
  transcript: string | null;
  transferState: AttachmentTransferState;
  transferError: string | null;
  /** 桌面端文件互传返回的文件 id（32 位十六进制），未送达为 null */
  remoteFileId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 采集入口来源：仅用于本机展示与排查，不含身份信息。 */
export type CaptureSource = "manual" | "camera" | "album" | "share" | "voice" | "file";

/**
 * 采集暂存项：还没决定保存到哪里（收集箱/任务/笔记）的原始内容。
 * 落库即持久化，应用被杀后下一次打开采集中心可恢复。
 */
export interface StashedItem {
  id: string;
  kind: AttachmentKind;
  mime: string;
  name: string;
  localUri: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  transcript: string | null;
  /** 该项自带的说明文字（分享文本、语音转写等） */
  note: string;
  source: CaptureSource;
  createdAt: number;
}
