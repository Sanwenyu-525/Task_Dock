//! 全局跨 Tab 联动的前端类型（与 `src-tauri/src/transfer/mod.rs` 的 serde camelCase 对齐）。
//!
//! 原则：这里只描述 IPC 契约与前端动作定义，不放业务实现；服务端返回的字段
//! 一律以后端为准，前端不自行推导状态或目标。

/** 工作篮条目类型（后端白名单）。 */
export type TransferItemType =
  | "text"
  | "richtext"
  | "image"
  | "file"
  | "directory"
  | "url"
  | "clipboard"
  | "task"
  | "project"
  | "planning"
  | "knowledge"
  | "capture";

/** 来源模块。`tray` / `manual` 用于工作篮内部整理。 */
export type TransferSourceModule =
  | "clipboard"
  | "files"
  | "tasks"
  | "projects"
  | "planning"
  | "knowledge"
  | "capture"
  | "mobile"
  | "resource"
  | "shelf"
  | "tray"
  | "manual";

/** 目标模块；本期真实执行只支持 `files`，其余由动作层处理或明确拒绝。 */
export type TransferTargetModule =
  | "files"
  | "tasks"
  | "projects"
  | "planning"
  | "knowledge"
  | "shelf"
  | "capture";

/** `ready` 可发送 | `sending` 批次进行中 | `sent` 已发送 | `failed` 失败 | `expired` 已过期。 */
export type TransferItemStatus = "ready" | "sending" | "sent" | "failed" | "expired";

export interface TransferItem {
  id: string;
  itemType: TransferItemType | string;
  sourceModule: TransferSourceModule | string;
  sourceId: string;
  title: string;
  description: string;
  content: string;
  payload: Record<string, unknown>;
  sortOrder: number;
  pinned: boolean;
  status: TransferItemStatus | string;
  errorCode: string;
  errorMessage: string;
  lastTarget: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  /** 运行时引用校验结果（不落库）。 */
  available: boolean;
  unavailableReason: string;
}

export interface TransferItemInput {
  id?: string;
  itemType: TransferItemType | string;
  sourceModule: TransferSourceModule | string;
  sourceId?: string;
  title?: string;
  description?: string;
  content?: string;
  payload?: Record<string, unknown>;
  pinned?: boolean;
}

export interface TransferFilter {
  itemTypes?: string[];
  sourceModules?: string[];
  status?: string;
  search?: string;
  pinnedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface TransferPage {
  items: TransferItem[];
  total: number;
}

export interface TransferAddReport {
  items: TransferItem[];
  duplicates: number;
  rejected: Array<{ title: string; code: string; message: string }>;
}

export interface TransferCounts {
  total: number;
  ready: number;
  failed: number;
  pinned: number;
}

export interface TransferTarget {
  module: TransferTargetModule | string;
  /** 目标引用：文件工作区为目录绝对路径；其余模块为实体 id。 */
  ref: string;
}

export interface TransferOptions {
  conflict: "skip" | "rename" | "overwrite";
  textFormat: "txt" | "md";
  textMode: "separate" | "merge";
  fileOperation: "copy" | "move";
  urlMode: "url" | "markdown";
  sentRetentionDays?: number | null;
}

export interface TargetValidation {
  valid: boolean;
  message: string;
  displayName: string;
}

export interface TransferPreview {
  targetModule: string;
  targetRef: string;
  targetValid: boolean;
  targetMessage: string;
  counts: {
    text: number;
    richtext: number;
    image: number;
    file: number;
    directory: number;
    url: number;
    clipboard: number;
    entity: number;
    unsupported: number;
  };
  plannedFiles: number;
  conflicts: Array<{ name: string; resolution: string }>;
  unsupported: Array<{ itemId: string; title: string; reason: string }>;
  warnings: string[];
  moveRemovesSources: number;
  estimatedBytes: number;
}

export interface BatchEntry {
  itemId: string;
  label: string;
  status: string;
  code: string;
  message: string;
  target: string | null;
}

export interface TransferBatch {
  id: string;
  targetModule: string;
  targetRef: string;
  operation: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled" | string;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  jobIds: string[];
  entries: BatchEntry[];
  undoState: string;
  undoReason: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchUndoResult {
  batchId: string;
  ok: boolean;
  moved: number;
  message: string;
}

export interface TransferContext {
  module: string;
  projectId: string | null;
  taskId: string | null;
  directory: string | null;
  planningId: string | null;
  knowledgeId: string | null;
  captureId: string | null;
  window: string;
  updatedAt: number;
}

/** 面板形态：工作台固定列 / 窄窗抽屉。 */
export type PanelMode = "dock" | "drawer";

export interface PanelState {
  visible: boolean;
  pinned: boolean;
  width: number;
  /** 用户是否关闭了智能推荐（P2 预留，持久化）。 */
  suggestionsEnabled: boolean;
}

/** 全局动作定义。动作由模块注册，菜单只按上下文筛选，不硬编码。 */
export interface ActionDefinition {
  actionId: string;
  title: string;
  description?: string;
  /** 空数组表示不限。 */
  supportedItemTypes: string[];
  sourceModules: string[];
  targetModules: string[];
  /** 需要目标引用（目录 / 实体 id）。 */
  requiresTarget?: boolean;
  confirmationRequired?: boolean;
  /** `execute` 由动作所属模块实现，失败必须抛出真实错误。 */
  run: (payload: ActionPayload) => Promise<ActionResult>;
}

export interface ActionPayload {
  items: TransferItem[];
  target?: TransferTarget;
  context: TransferContext;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** 失败重试需要的批次 id（文件发送类动作）。 */
  batchId?: string;
}

/** 与 Rust `LinkInput` 对应；实体类型 / 关系由后端白名单校验。 */
export interface EntityLinkInput {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface EntityLink {
  id: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation: string;
  label: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** 失败重试需要的原始输入（仅当前窗口内存持有，不复制业务数据）。 */
export interface PendingTransfer {
  ids: string[];
  target: TransferTarget;
  options: TransferOptions;
}
