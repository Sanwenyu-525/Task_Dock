//! 与 Tauri 后端的类型化桥接层。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface RecurrenceRule {
  id: string;
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  by_weekday: number[];
  by_monthday: number | null;
  /** 每月第 N 个星期X（1..=5）或最后一个（-1）；v20 新增，旧数据为 null */
  by_setpos?: number | null;
  until: string | null;
  anchor: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: "pending" | "completed";
  category: string;
  tags: string[];
  due_at: string | null;
  remind_at: string | null;
  advance_minutes: number;
  recurrence: RecurrenceRule | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  linked_agents: number;
  /** 最早未触发提醒时间（task_reminders 聚合；展示真实下次通知时间） */
  next_remind_at?: string | null;
}

export interface TaskInput {
  title: string;
  description?: string;
  priority?: number;
  category?: string;
  tags?: string[];
  due_at?: string | null;
  remind_at?: string | null;
  advance_minutes?: number;
  recurrence?: RecurrenceRuleInput | null;
}

export interface RecurrenceRuleInput {
  freq: string;
  interval: number;
  by_weekday: number[];
  by_monthday: number | null;
  /** 每月第 N 个星期X（1..=5）或最后一个（-1）；仅 monthly + by_weekday 有效 */
  by_setpos?: number | null;
}

/** 延后实际改动的一条提醒（撤销按 (id, snoozed_to) 条件恢复） */
export interface SnoozeChange {
  id: string;
  snoozedTo: string;
  restoreTo: string;
}

/** snooze_reminder 返回：前端据此展示真实下次通知时间与「撤销」 */
export interface SnoozeResult {
  taskId: string;
  taskTitle: string;
  changed: SnoozeChange[];
  insertedId: string | null;
  nextRemindAt: string;
}

/** 倒计时数据源：未触发提醒 + 任务信息（active_reminders 命令） */
export interface ActiveReminder {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  remindAt: string;
  occurrence: string;
  kind: string;
  snoozed: boolean;
  taskStatus: string;
  hasRecurrence: boolean;
}

export interface TaskFilter {
  view?: string;
  status?: string;
  category?: string;
  tag?: string;
  priority?: number;
  search?: string;
  sort?: string;
  /**
   * 返回条数上限（后端 clamp 1..=200，缺省 = 原行为不变）。
   * 胶囊轻量列表用它把 payload 压到面板实际展示的量；完整页不传。
   */
  limit?: number;
}

export interface ParsedInput {
  title: string;
  due_at: string | null;
  recurrence: RecurrenceRuleInput | null;
  advance_minutes: number | null;
  matched: string[];
  has_explicit_time: boolean;
  date_only: boolean;
}

export interface AgentSource {
  id: string;
  display_name: string;
  kind: string;
  enabled: boolean;
  verified: boolean;
  homepage: string;
  note: string;
  config: unknown;
}

export interface AgentInstance {
  id: string;
  source_id: string;
  instance_key: string;
  display_name: string;
  exe_path: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface AgentSession {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  last_run_id: string | null;
  /** 关联的 agent_instances 行 ID；未知为 null（UI 不得伪造实例） */
  instance_id?: string | null;
}

export interface AgentRun {
  id: string;
  session_id: string;
  source_id: string;
  external_run_id: string | null;
  task_title: string;
  status: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  pending_items: string[];
  /** 关联的 agent_instances 行 ID；未知为 null */
  instance_id?: string | null;
}

export interface AgentSnapshot {
  sources: AgentSource[];
  instances: AgentInstance[];
  sessions: AgentSession[];
  runs: AgentRun[];
}

export interface DiscoveredAgent {
  source_id: string;
  display_name: string;
  transport_kind: string;
  installed: boolean;
  version: string | null;
  install_paths: string[];
  config_homes: string[];
  install_method: string;
  running_instances: { pid: number; name: string; exe: string | null }[];
  capabilities: string[];
  supported_events: string[];
  docs_url: string;
  limitations: string[];
  registered: boolean;
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  /** 传输通道自测通过（不代表第三方 Agent 真实接入） */
  transport_verified: boolean;
  /** 是否收到过真实（非自测）事件 */
  real_event_seen: boolean;
  last_event_at: string | null;
  health_state: string;
  /** disabled | recent-event | channel-verified | unknown */
  connection_state: string;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  ref_type: string | null;
  ref_id: string | null;
  occurrence: string | null;
  is_read: boolean;
  created_at: string;
}

export interface AgentEventRow {
  id: string;
  source_id: string;
  session_external_id: string;
  run_external_id: string | null;
  event_type: string;
  state: string;
  message: string | null;
  received_at: string;
  occurred_at?: string | null;
  transport?: string | null;
  evidence_type?: string | null;
}

export interface Settings {
  theme: "light" | "dark" | "system";
  mode: "minimal" | "compact" | "full";
  /** 窗口材质：solid 不透明 | glass 毛玻璃（系统不支持时自动回退 solid） */
  material: "solid" | "glass";
  /**
   * 视觉预设（v0.6/v0.9）：dream-gradient 梦幻渐变 | liquid-glass 液态玻璃
   * | frosted 柔光玻璃 | clear 清透玻璃。
   * 与 theme / material 正交；旧库缺失该键时后端返回默认值，前端对未知值也做回退。
   */
  visual_preset: "dream-gradient" | "liquid-glass" | "frosted" | "clear";
  /** 清透模式前景配色：auto 跟随明暗主题 | dark 深色文字 | light 浅色文字。 */
  clear_foreground: "auto" | "dark" | "light";
  snap_enabled: boolean;
  autostart: boolean;
  hotkey_enabled: boolean;
  http_enabled: boolean;
  http_port: number;
  http_token: string;
  mock_enabled: boolean;
  notify_reminder: boolean;
  notify_agent: boolean;
  notify_muted: boolean;
  /** 通知风暴治理：窗口内最多独立弹窗数（1~20） */
  notify_burst_max: number;
  /** 通知风暴治理：限流窗口（秒，10~3600） */
  notify_rate_window_secs: number;
  /** 高频完成合并为一条摘要 */
  notify_done_aggregate: boolean;
  /** Agent 异常（waiting/failed）时隐藏态胶囊脉动 + 提示音（v0.6 异常变响） */
  agent_alert_sound: boolean;
  overdue_grace_hours: number;
  stale_run_minutes: number;
  auto_backup: boolean;
  backup_retain_days: number;
  // 接入管线 / 事件保留 / 诊断（v0.5）
  ingest_queue_capacity: number;
  ingest_batch_size: number;
  ingest_coalesce_ms: number;
  agent_event_retention_days: number;
  agent_event_max_rows: number;
  agent_event_archive: boolean;
  agent_inbox_max_file_bytes: number;
  agent_inbox_max_files: number;
  perf_diagnostics_enabled: boolean;
  // 导航偏好（v0.4）
  nav_prefer_focus: boolean;
  nav_allow_launch: boolean;
  nav_fallback: boolean;
  nav_remember_window: boolean;
  nav_default_browser: string;
  nav_workspace_max: number;
  // 模块独立启停（v0.5 整改）
  workspace_enabled: boolean;
  actions_enabled: boolean;
  // 智能剪贴板（v0.5）
  clipboard_enabled: boolean;
  clipboard_paused: boolean;
  clipboard_capture_images: boolean;
  clipboard_capture_files: boolean;
  clipboard_capture_html: boolean;
  clipboard_auto_group: boolean;
  clipboard_group_window_secs: number;
  clipboard_retention_days: number;
  clipboard_max_items: number;
  clipboard_max_storage_mb: number;
  clipboard_exclude_apps: string;
  clipboard_paste_interval_ms: number;
  clipboard_paste_interval_image_ms: number;
  clipboard_paste_interval_html_ms: number;
  clipboard_paste_interval_files_ms: number;
  clipboard_sensitive_filter: boolean;
  /**
   * 快速捕获上次使用的类型（v0.7）：task | idea | text | todo | link。
   * 旧库缺省该键时后端补默认 "task"；前端再做一次归一兜底。
   */
  quick_capture_last_type?: string;
  // 文件暂存架（v0.8）：自动过期清理默认关闭；旧库缺省走后端默认值
  shelf_auto_cleanup_enabled?: boolean;
  shelf_retention_days?: number;
  shelf_max_storage_mb?: number;
}

/** 全局任务统计（跨所有筛选视图）。 */
export interface TaskStats {
  pending: number;
  overdue: number;
  due_today: number;
  completed_today: number;
  next_due_at: string | null;
}

/** apply_window_material 的返回。 */
export interface MaterialResult {
  material: string;
  /** 玻璃渲染已生效（CSS 或原生都算） */
  applied: boolean;
  /** 原生模糊真正生效（仅 mica/acrylic/blur）；旧后端可能缺省 */
  native?: boolean;
  /** 实际命中的效果名：mica / acrylic / blur / css / none */
  effect: string;
  os_version: string;
}

export interface TaskAgentLink {
  id: string;
  task_id: string;
  source_id: string;
  session_external_id: string;
  run_external_id: string | null;
  created_at: string;
  available: boolean;
}

// ── 智能剪贴板（v0.5）──

/** 条目类型；与后端 KIND_* 一致。 */
export type ClipboardKind = "text" | "url" | "html" | "image" | "files";

export interface ClipboardItem {
  id: string;
  kind: ClipboardKind | string;
  /** 列表接口只返回预览；详情接口返回完整正文 */
  text: string;
  /** 列表接口为空；详情接口返回完整 HTML */
  html: string;
  preview: string;
  /** 展示标题：自动生成（≤30 字符）或手动编辑（≤80）；空串时回退 preview */
  title: string;
  /** none（旧记录）/ auto / manual */
  title_source: string;
  byte_size: number;
  source_app: string;
  source_title: string;
  /** owner / foreground / unknown；旧记录为 ''（未记录） */
  source_kind?: string;
  image_width: number | null;
  image_height: number | null;
  file_paths: string[];
  favorite: boolean;
  pinned: boolean;
  copy_count: number;
  created_at: string;
  last_seen_at: string;
  has_image: boolean;
  has_thumb: boolean;
}

export interface ClipboardGroup {
  id: string;
  name: string;
  /** auto | manual */
  mode: string;
  /** collecting | closed */
  status: string;
  favorite: boolean;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  item_count: number;
  image_count: number;
  preview: string;
  /** 仅详情接口填充 */
  items: ClipboardItem[];
}

export interface ClipboardStats {
  items: number;
  groups: number;
  images: number;
  files: number;
  favorites: number;
  bytes: number;
  asset_bytes: number;
  max_items: number;
  max_storage_bytes: number;
  enabled: boolean;
  paused: boolean;
  auto_group: boolean;
}

export interface ClipboardView {
  items: ClipboardItem[];
  groups: ClipboardGroup[];
  stats: ClipboardStats;
  total_items: number;
}

/** 列表筛选（后端 ClipboardFilter 为 camelCase）。 */
export interface ClipboardFilter {
  kind?: string;
  search?: string;
  favorite?: boolean;
  groupId?: string;
  taskId?: string;
  limit?: number;
  offset?: number;
}

export interface CopyReport {
  /** text | html | image | files */
  mode: string;
  bytes: number;
  warnings: string[];
  sequence: number;
  item_count: number;
}

export interface DeleteReport {
  deleted: number;
  freed_bytes: number;
  retained_shared: number;
  /** 实际删除的分组数；0 表示分组不存在（delete_items 恒为 0） */
  groups_deleted: number;
}

export interface CleanupReport {
  items_deleted: number;
  groups_closed: number;
  bytes_freed: number;
  orphan_files_removed: number;
}

/** 一键清空历史的结果；`failed_files` 为数据库已清空但缓存文件未删除的数量。 */
export interface ClearReport {
  items: number;
  groups: number;
  freed_bytes: number;
  failed_files: number;
}

export interface ClipboardTaskLink {
  id: string;
  task_id: string;
  target_type: "item" | "group" | string;
  target_id: string;
  created_at: string;
  label: string;
  kind: string;
}

export interface PasteTarget {
  hwnd: number;
  pid: number;
  title: string;
  exe_path: string;
}

export interface PasteIntervals {
  text_ms: number;
  html_ms: number;
  image_ms: number;
  files_ms: number;
}

export interface PasteStartReport {
  job_id: string;
  target: PasteTarget;
  total: number;
  interval_ms: number;
  intervals: PasteIntervals;
}

export interface PasteJob {
  id: string;
  group_id: string;
  target_title: string;
  target_exe: string;
  status: string;
  total: number;
  sent: number;
  started_at: string;
  ended_at: string | null;
  message: string;
  remaining_items: string[];
  restored: boolean;
}

export interface ClipboardMonitorStats {
  observed_events: number;
  merged_events: number;
  captured: number;
  recorded: number;
  duplicates: number;
  /** 策略性跳过：自写、配置拒绝、超限等 */
  skipped: number;
  /** 打开剪贴板重试后仍失败（被其他程序独占） */
  read_failed: number;
  /** 监听线程被看门狗重启的次数 */
  monitor_restarts: number;
  superseded_events: number;
  self_write_events: number;
  empty_events: number;
  cleared_stale_events: number;
  cleared_stale_contents: number;
  /** WM_CLIPBOARDUPDATE 到达但监听未就绪（启动/看门狗重启盲区）——诊断计数 */
  unobserved_events: number;
  dropped_events: number;
  dropped_contents: number;
  failed: number;
  peak_event_queue: number;
  peak_content_queue: number;
  max_capture_latency_ms: number;
  max_process_latency_ms: number;
  event_queue_capacity: number;
  content_queue_capacity: number;
  content_queue_max_bytes: number;
}

export interface ClipboardConfigError {
  /** database | json | type | range */
  kind: string;
  /** 仅键名，不含任何设置值 */
  keys: string[];
  message: string;
}

export interface ClipboardStatus {
  enabled: boolean;
  paused: boolean;
  monitoring: boolean;
  activeJob: string | null;
  platform: string;
  configError?: ClipboardConfigError | null;
  configOrigin?: string | null;
  captureAllowed?: boolean;
  monitor?: ClipboardMonitorStats;
}

export interface ClipboardPasteEvent {
  jobId: string;
  status: string;
  sent: number;
  total: number;
  pending: number;
  message?: string;
  restored?: boolean;
  itemId?: string;
  itemIndex?: number;
  itemState?: string;
  userTookOver?: boolean;
  confirmed?: number;
  unverified?: number;
}

export interface ClipboardProbe {
  readable: boolean;
  kind?: string;
  bytes?: number;
  hasImage?: boolean;
  fileCount?: number;
  reason?: string;
}

export interface AgentCapability {
  supported: boolean;
  evidence: string;
  note: string;
}

export interface AgentClipboardTarget {
  source_id: string;
  display_name: string;
  installed: boolean;
  window_present: boolean;
  /** exe-found / window-present / not-installed */
  evidence: string;
  note: string;
  direct_send: AgentCapability;
  file_import: AgentCapability;
  desktop_paste: AgentCapability;
  export: AgentCapability;
  /** direct / import / paste / export / none */
  recommended: string;
}

export interface ExportPackage {
  dir: string;
  markdown_path: string;
  manifest_path: string;
  files: string[];
  item_count: number;
  summary: string;
  warnings: string[];
}

// ── 任务 ──
export const listTasks = (filter: TaskFilter) => invoke<Task[]>("list_tasks", { filter });
export const taskStats = () => invoke<TaskStats>("task_stats");
export const createTask = (input: TaskInput) => invoke<Task>("create_task", { input });
export const updateTask = (id: string, input: TaskInput) => invoke<Task>("update_task", { id, input });
export const toggleTask = (id: string) => invoke<Task>("toggle_task", { id });
export const deleteTask = (id: string) => invoke<void>("delete_task", { id });
export const parseQuickAdd = (text: string) => invoke<ParsedInput>("parse_quick_add", { text });
export const createFromQuickAdd = (
  text: string,
  dueAt: string | null,
  recurrence: RecurrenceRuleInput | null,
  advanceMinutes: number | null,
) => invoke<Task>("create_from_quick_add", { text, dueAt, recurrence, advanceMinutes });
export const snoozeReminder = (taskId: string, minutes: number) =>
  invoke<SnoozeResult>("snooze_reminder", { taskId, minutes });
export const undoSnooze = (
  taskId: string,
  changes: SnoozeChange[],
  insertedId: string | null,
) => invoke<[number, number]>("undo_snooze", { taskId, changes, insertedId });
export const activeReminders = () => invoke<ActiveReminder[]>("active_reminders");
export const cancelReminders = (taskId: string) => invoke<number>("cancel_reminders", { taskId });
export const linkTaskAgent = (
  taskId: string,
  sourceId: string,
  sessionExternalId: string,
  runExternalId?: string,
) => invoke<TaskAgentLink>("link_task_agent", { taskId, sourceId, sessionExternalId, runExternalId });
export const unlinkTaskAgent = (linkId: string) => invoke<void>("unlink_task_agent", { linkId });
export const listTaskLinks = (taskId: string) => invoke<TaskAgentLink[]>("list_task_links", { taskId });
export const pendingItemsToTasks = (items: string[]) =>
  invoke<Task[]>("pending_items_to_tasks", { items });

// ── Agent ──
export const agentSnapshot = () => invoke<AgentSnapshot>("agent_snapshot");
export const setSourceEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_source_enabled", { id, enabled });
// 动态来源注册
export const createSource = (id: string, displayName: string, adapter?: string, homepage?: string, note?: string, icon?: string) =>
  invoke<void>("create_source", { id, displayName, adapter, homepage, note, icon });
export const updateSource = (id: string, patch: { displayName?: string; homepage?: string; note?: string; icon?: string; hidden?: boolean }) =>
  invoke<void>("update_source", { id, ...patch });
export const deleteSource = (id: string, alsoDeleteData = false) =>
  invoke<void>("delete_source", { id, alsoDeleteData });
// 自动发现 + 接入向导
export const discoveryScan = () => invoke<DiscoveredAgent[]>("discovery_scan");
export const adapterList = () =>
  invoke<{ id: string; display_name: string; transport_kind: string; docs_url: string }[]>("adapter_list");
export const adapterPreview = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_preview", { adapterId });
export const adapterInstall = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_install", { adapterId });
export const adapterVerify = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_verify", { adapterId });
export const adapterUninstall = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_uninstall", { adapterId });
export const adapterStatus = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_status", { adapterId });
export const mockStartScenario = (sessionTitle: string, outcome: string) =>
  invoke<void>("mock_start_scenario", { sessionTitle, outcome });
export const codexHooksStatus = () =>
  invoke<{ installed: boolean; hooks_path: string; script_path: string; codex_home: string }>(
    "codex_hooks_status",
  );
export const codexHooksInstall = () => invoke<Record<string, unknown>>("codex_hooks_install");
export const codexHooksUninstall = () => invoke<Record<string, unknown>>("codex_hooks_uninstall");
/** 跳转 Agent 会话（v0.4 走统一导航：证据化能力 + 诚实降级；返回结构化结果）。 */
export const openAgentSession = (sourceId: string, sessionId: string) =>
  invoke<import("./navigation").NavigationResult>("open_agent_session", { sourceId, sessionId });
export interface NotificationPage {
  items: NotificationRow[];
  has_more: boolean;
  /** 当前筛选下的全库总数（与分页无关，只计真实来源） */
  filtered_total: number;
}

export interface NotificationInboxStats {
  /** 全库未读（真实来源，不受列表分页/筛选影响） */
  unread: number;
  total: number;
}

export interface AgentEventPage {
  items: AgentEventRow[];
  has_more: boolean;
  filtered_total: number;
}

export const notificationPage = (opts: {
  sourceId?: string;
  since?: string;
  before?: string;
  limit?: number;
} = {}) => invoke<NotificationPage>("notification_page", opts);
export const notificationInboxStats = () =>
  invoke<NotificationInboxStats>("notification_inbox_stats");
export const markNotificationRead = (id: string) => invoke<void>("mark_notification_read", { id });
export const markAllNotificationsRead = () => invoke<void>("mark_all_notifications_read");
export const clearNotifications = () => invoke<void>("clear_notifications");
export const listAgentEvents = (
  limit = 100,
  opts: { sourceId?: string; since?: string; before?: string } = {},
) =>
  invoke<AgentEventPage>("list_agent_events", {
    limit,
    sourceId: opts.sourceId,
    since: opts.since,
    before: opts.before,
  });

// ── 设置 ──
export const getSettings = () => invoke<Settings>("get_settings");
export const updateSettings = (patch: Partial<Settings>) =>
  invoke<Settings>("update_settings", { patch });
export const saveWindowRect = (rect: { x: number; y: number; w: number; h: number }) =>
  invoke<void>("save_window_rect", { rect });
export const getWindowRect = () =>
  invoke<{ x: number; y: number; w: number; h: number } | null>("get_window_rect");
export const saveSnapState = (edge: string, hidden: boolean, center: number | null = null) =>
  invoke<void>("save_snap_state", { state: { edge, hidden, center } });
export const getSnapState = () =>
  invoke<{ edge: string; hidden: boolean; center?: number | null } | null>("get_snap_state");

// ── 数据 ──
export interface BackupEntry {
  name: string;
  size: number;
  modified: string;
  /** quick / full；旧版单文件备份为 null */
  kind?: string | null;
  /** 快速备份为 true（事件/通知按上限截断，不含归档） */
  partial?: boolean | null;
  totals?: Record<string, number> | null;
  /** 被截断的数据表（partial 时非空） */
  truncated_tables?: string[] | null;
  /** 是否携带剪贴板/工作现场/行动中心扩展模块 */
  extended_modules?: boolean | null;
}

/** 导入前读取的备份头信息（不解析正文）。 */
export interface BackupMeta {
  format: string;
  kind: string;
  partial: boolean;
  partial_reasons?: string[] | null;
  truncated_tables?: string[] | null;
  extended_modules?: boolean;
  manifest_version?: number;
  exported_at?: string | null;
  preserved_modules?: string[] | null;
  counts?: Record<string, number> | null;
}

export interface RestoreOutcome {
  session_id: string;
  state: string;
  source_kind: string;
  backup_kind: string;
  partial: boolean;
  assets: number;
  archives: number;
  pre_backup: string | null;
  extended_preserved: boolean;
  recovered: boolean;
  message: string;
}

export const exportData = (path: string) => invoke<string>("export_data", { path });
export const importData = (path: string, allowPartial = false) =>
  invoke<RestoreOutcome>("import_data", { path, allowPartial });
export const inspectBackup = (path: string) => invoke<BackupMeta>("inspect_backup", { path });
export const backupNow = (full = false) => invoke<string>("backup_now", { full });
export const listBackups = () => invoke<BackupEntry[]>("list_backups");

export interface AuditTableCounts {
  events: number;
  sessions: number;
  runs: number;
  instances: number;
  notifications: number;
}

export interface AuditOriginBucket {
  origin: string;
  counts: AuditTableCounts;
  sources: string[];
}

export interface AuditUncertainItem {
  kind: string;
  detail: string;
  count: number;
  samples: string[];
}

export interface TestDataAudit {
  dry_run: boolean;
  generated_at: string;
  real: AuditTableCounts;
  provable: AuditOriginBucket[];
  provable_total: AuditTableCounts;
  uncertain: AuditUncertainItem[];
  backup_path: string | null;
  deleted: AuditTableCounts | null;
  fk_violations: number;
  notes: string[];
}

/** 历史压测/自测数据审计：apply=false 只预览，true 会先备份再删除可证明数据。 */
export const auditTestData = (apply = false) =>
  invoke<TestDataAudit>("audit_test_data", { apply });

export const quitApp = () => invoke<void>("quit_app");
export const setAutostart = (enabled: boolean) => invoke<boolean>("set_autostart", { enabled });
export const applyMode = (mode: string) => invoke<void>("apply_mode", { mode });

// ── 液态玻璃右键菜单（v0.6）──
export const hideContextMenu = () => invoke<void>("hide_context_menu");
/**
 * 下发窗口材质。`preset` 用于隔离清透玻璃：该预设必须保持「无原生模糊」，
 * 后端据此强制 CSS 通道，避免 Win10 Acrylic 把窗口后的桌面糊掉。
 */
export const applyWindowMaterial = (material: string, preset?: string) =>
  invoke<MaterialResult>("apply_window_material", { material, preset });

/**
 * 下发窗口圆角半径（逻辑像素）给 Win32 区域裁剪。
 * 返回 false 表示原生裁剪不可用（CSS 圆角仍在，四角可能露出原生背景直角）。
 */
export const applyWindowRadius = (radius: number) =>
  invoke<boolean>("apply_window_radius", { radius });
export const setHotkeysEnabled = (enabled: boolean) =>
  invoke<void>("set_hotkeys_enabled", { enabled });
export const getAgentInboxDir = () => invoke<string>("get_agent_inbox_dir");

/** 胶囊区域模式：off = 整窗；rail = 只露分类轨道；panel = 轨道 ∪ 功能面板。 */
export type CapsuleRegionMode = "off" | "rail" | "panel";

/**
 * 分类胶囊区域（Smart Dock Capsule）：把主窗口的 Win32 区域裁成
 * 轨道（折叠态）或「轨道 ∪ 面板」（展开态），区域外不绘制、不命中鼠标。
 * **窗口位置与尺寸不变**——这是命中区稳定的前提。
 * `seq` 为前端单调序号：原生侧据此丢弃迟到的旧请求，保证最终区域由最新状态决定。
 * 返回 false 表示应用失败或被乱序保护丢弃（前端按可见性兜底，不得假设胶囊形态生效）。
 */
export const applyWindowCapsule = (mode: CapsuleRegionMode, edge: string, seq: number) =>
  invoke<boolean>("apply_window_capsule", { mode, edge, seq });

/**
 * 拖拽磁力参数（CSS px）：吸引范围 / 最大额外位移 / 脱离拖动距离。
 *
 * 原生侧在 `WM_MOVING` 里按这组参数修正移动矩形，前端不参与逐帧移动。
 * `enabled=false` 时吸引与阻力同时失效（`snap_enabled` 关闭必须彻底停用）。
 * 返回值表示子类化是否已安装（false = 退化为纯阈值吸附，不影响停靠正确性）。
 */
export const setMagneticDragConfig = (
  enabled: boolean,
  range: number,
  maxLead: number,
  release: number,
) => invoke<boolean>("set_magnetic_drag_config", { enabled, range, maxLead, release });

/**
 * 停靠位（物理像素，齐平位置）：`edge=null` 表示未停靠（阻力失效）。
 * 前端只在停靠事务**提交成功后**下发，解除/关闭吸附/卸载时清除。
 */
export const setMagneticDock = (edge: string | null, x = 0, y = 0) =>
  invoke<boolean>("set_magnetic_dock", { edge, x, y });

/**
 * 拖离解除的鼠标锚定：请求原生在**拖拽循环内**把窗口恢复为 `mode` 的尺寸，
 * 并以「标题栏中心 = 光标」对齐（含工作区钳制，见 `magnetic::undock_anchor_rect`）。
 *
 * **只有用户拖离胶囊的解除路径调用**：按钮解除 / 打开完整页 / 托盘唤回等
 * 路径保持各自原有的定位策略。返回 false = 原生磁力层未安装，
 * 解除流程照常，由调用方按实际恢复后的窗口尺寸回退定位。
 */
export const setUndockAnchor = (mode: string, titlebarCss: number) =>
  invoke<boolean>("set_undock_anchor", { mode, titlebarCss });

/** 锚定请求是否已在拖拽循环内应用（取后复位）；false 时调用方需自行定位。 */
export const takeUndockAnchorApplied = () => invoke<boolean>("take_undock_anchor_applied");

/** 作废尚未应用的锚定请求（解除中止 / 回滚时防残留到下一次拖拽）。 */
export const cancelUndockAnchor = () => invoke<void>("cancel_undock_anchor");

/** 唤回事件：托盘/快捷键等入口发现主窗口"可见但大部分在屏外"时下发，
 *  前端吸附引擎据此安全展开（物理位置在屏外时仅 show/focus 找不回窗口）。 */
export const onSnapRecall = (cb: () => void): Promise<UnlistenFn> =>
  listen("snap-recall", () => cb());

/**
 * 首屏就绪：设置已加载且**启动时的停靠恢复结论已确定**，放行主窗口显示。
 *
 * 后端在「上次退出为停靠态」时延后 `show()`：先显示会露出完整主窗口再缩成
 * 胶囊（实测约 1.9s 的矩形窗口）。非停靠启动时窗口早已显示，本调用是 no-op。
 * 幂等，失败不重试（后端有 4s 兜底显示）。
 */
export const notifyUiReady = () => invoke<boolean>("notify_ui_ready");

export const hubHealth = () =>
  invoke<{ sources: number; sessions: number; runs: number; worst_state: string }>("hub_health");

// ── 性能诊断 / 事件保留（v0.5）──
export interface LatencyPercentiles {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  samples: number;
}
export interface PipelineDiag {
  running: boolean;
  submissions: number;
  events_received: number;
  events_processed: number;
  events_merged: number;
  events_sampled: number;
  overload_rejects: number;
  commit_failures: number;
  fallback_jobs: number;
  batches: number;
  queue_capacity: number;
  queue_depth_events: number;
  queue_depth_jobs: number;
  merge_buffer: number;
  last_batch_size: number;
  coalesce_ms: number;
  ingest_latency: LatencyPercentiles;
  db_write_latency: LatencyPercentiles;
  uptime_secs: number;
}
export interface PerformanceDiagnostics {
  enabled: boolean;
  generated_at?: string;
  pipeline?: PipelineDiag;
  http?: Record<string, number | string | null>;
  file_drop?: Record<string, number | string | null>;
  sqlite?: { pool_size: number; calls: number; avg_ms: number; slow_queries_100ms: number };
  retention?: Record<string, number | string | boolean | null>;
  hub?: { sources: number; sessions: number; runs: number; worst_state: string };
}
export interface RetentionReport {
  ran_at: string;
  cutoff: string | null;
  candidates: number;
  deleted: number;
  archived: number;
  archive_file: string | null;
  archive_error: string | null;
  prunable_remaining: number;
  protected_rows: number;
}
export const performanceDiagnostics = () =>
  invoke<PerformanceDiagnostics>("performance_diagnostics");
export const agentRetentionStatus = () => invoke<Record<string, unknown>>("agent_retention_status");
export const agentRetentionRun = () => invoke<RetentionReport>("agent_retention_run");
export const agentArchiveList = () =>
  invoke<{ name: string; path: string; size: number; modified?: string }[]>("agent_archive_list");
export const agentInboxRetry = () => invoke<number>("agent_inbox_retry");

// ── 智能剪贴板（v0.5）──
export const clipboardView = (filter?: ClipboardFilter) =>
  invoke<ClipboardView>("clipboard_view", { filter });
export const clipboardItem = (itemId: string) =>
  invoke<ClipboardItem>("clipboard_item", { itemId });
export const clipboardGroup = (groupId: string) =>
  invoke<ClipboardGroup>("clipboard_group", { groupId });
export const clipboardStats = () => invoke<ClipboardStats>("clipboard_stats");
export const clipboardThumb = (itemId: string) =>
  invoke<string | null>("clipboard_thumb", { itemId });
export const clipboardImage = (itemId: string) =>
  invoke<string | null>("clipboard_image", { itemId });
export const clipboardCopyItem = (itemId: string) =>
  invoke<CopyReport>("clipboard_copy_item", { itemId });
/** 通用文本写入：与单项复制共用后端受控写入与自写登记。 */
export const clipboardCopyText = (text: string) =>
  invoke<void>("clipboard_copy_text", { text });
/**
 * 图片另存为：把落盘 PNG 写入用户选择的路径，返回写入字节数。
 *
 * 系统保存对话框只负责选路径（当前 rfd 不设置 `FOS_OVERWRITEPROMPT`），不构成可验证的
 * 覆盖授权。目标已存在时，前端必须先经应用内确认框取得授权，才把 `overwrite=true`
 * 显式传给后端；该值只对本次调用有效，后端不会缓存或复用。
 */
export const clipboardSaveImage = (itemId: string, path: string, overwrite: boolean) =>
  invoke<number>("clipboard_save_image", { itemId, path, overwrite });
/** 用系统默认浏览器打开链接条目（后端校验仅 http/https）。 */
export const clipboardOpenUrl = (itemId: string) =>
  invoke<void>("clipboard_open_url", { itemId });
/** 用系统关联程序打开本地文件/目录（后端校验绝对路径且必须存在）。 */
export const clipboardOpenLocalPath = (path: string) =>
  invoke<void>("clipboard_open_local_path", { path });
/** 在资源管理器中定位文件（explorer /select）。 */
export const clipboardRevealLocalPath = (path: string) =>
  invoke<void>("clipboard_reveal_local_path", { path });
/**
 * 批量查询文件路径状态：ok / missing / inaccessible。
 *
 * 后端在阻塞线程池中批量执行（最多 200 条）；后台任务异常结束时 Promise 以错误拒绝，
 * 调用方必须按「未知」处理，不得把所有路径视为存在。
 */
export const clipboardPathStatus = (paths: string[]) =>
  invoke<string[]>("clipboard_path_status", { paths });
export const clipboardCopyGroupRich = (groupId: string) =>
  invoke<CopyReport>("clipboard_copy_group_rich", { groupId });
export const clipboardCopyGroupFiles = (groupId: string) =>
  invoke<CopyReport>("clipboard_copy_group_files", { groupId });
/** 任意多选批量富文本复制：按选择顺序整合，不创建永久分组。 */
export const clipboardCopyItemsRich = (itemIds: string[]) =>
  invoke<CopyReport>("clipboard_copy_items_rich", { itemIds });
/** 任意多选批量文件复制：文件/图片条目取本地路径，普通文字不转为文件。 */
export const clipboardCopyItemsFiles = (itemIds: string[]) =>
  invoke<CopyReport>("clipboard_copy_items_files", { itemIds });
/** 编辑条目标题：非空设为手动标题；空串恢复自动生成。 */
export const clipboardRenameItem = (itemId: string, title: string) =>
  invoke<ClipboardItem>("clipboard_rename_item", { itemId, title });
export const clipboardToggleItem = (itemId: string, flag: "favorite" | "pinned") =>
  invoke<ClipboardItem>("clipboard_toggle_item", { itemId, flag });
export const clipboardToggleGroup = (groupId: string, flag: "favorite" | "pinned") =>
  invoke<ClipboardGroup>("clipboard_toggle_group", { groupId, flag });
export const clipboardCloseGroup = (groupId: string) =>
  invoke<ClipboardGroup>("clipboard_close_group", { groupId });
export const clipboardDeleteItems = (ids: string[]) =>
  invoke<DeleteReport>("clipboard_delete_items", { ids });
export const clipboardDeleteGroup = (groupId: string, alsoDeleteItems: boolean) =>
  invoke<DeleteReport>("clipboard_delete_group", { groupId, alsoDeleteItems });
/** 清空全部剪贴板历史（含收藏/置顶），不影响系统剪贴板与外部文件。 */
export const clipboardClearHistory = () =>
  invoke<ClearReport>("clipboard_clear_history");
export const clipboardCreateGroup = (name: string, itemIds: string[]) =>
  invoke<ClipboardGroup>("clipboard_create_group", { name, itemIds });
export const clipboardRenameGroup = (groupId: string, name: string) =>
  invoke<ClipboardGroup>("clipboard_rename_group", { groupId, name });
export const clipboardAddToGroup = (groupId: string, itemIds: string[]) =>
  invoke<ClipboardGroup>("clipboard_add_to_group", { groupId, itemIds });
export const clipboardRemoveGroupItem = (groupId: string, itemId: string) =>
  invoke<ClipboardGroup>("clipboard_remove_group_item", { groupId, itemId });
export const clipboardMoveGroupItem = (groupId: string, itemId: string, newIndex: number) =>
  invoke<ClipboardGroup>("clipboard_move_group_item", { groupId, itemId, newIndex });
export const clipboardSplitGroup = (groupId: string, itemIds: string[], name: string) =>
  invoke<ClipboardGroup>("clipboard_split_group", { groupId, itemIds, name });
export const clipboardMergeGroups = (groupIds: string[], name: string) =>
  invoke<ClipboardGroup>("clipboard_merge_groups", { groupIds, name });
export const clipboardLinkTask = (taskId: string, targetType: "item" | "group", targetId: string) =>
  invoke<ClipboardTaskLink>("clipboard_link_task", { taskId, targetType, targetId });
export const clipboardUnlinkTask = (linkId: string) =>
  invoke<void>("clipboard_unlink_task", { linkId });
export const clipboardTaskLinks = (taskId: string) =>
  invoke<ClipboardTaskLink[]>("clipboard_task_links", { taskId });
export const clipboardVisibleTargets = () =>
  invoke<PasteTarget[]>("clipboard_visible_targets");
export const clipboardForegroundTarget = () =>
  invoke<PasteTarget | null>("clipboard_foreground_target");
export const clipboardPastePrecheck = (hwnd: number) =>
  invoke<PasteTarget>("clipboard_paste_precheck", { hwnd });
export const clipboardPasteGroup = (groupId: string, targetHwnd: number, itemIds?: string[]) =>
  invoke<PasteStartReport>("clipboard_paste_group", { groupId, targetHwnd, itemIds });
/** 任意多选逐项粘贴：不依赖永久分组，按传入顺序逐条写入并发送。 */
export const clipboardPasteItems = (targetHwnd: number, itemIds: string[]) =>
  invoke<PasteStartReport>("clipboard_paste_items", { targetHwnd, itemIds });
export const clipboardPasteCancel = (jobId: string) =>
  invoke<void>("clipboard_paste_cancel", { jobId });
export const clipboardPasteResume = (jobId: string, targetHwnd: number) =>
  invoke<PasteStartReport>("clipboard_paste_resume", { jobId, targetHwnd });
export const clipboardPasteJob = (jobId: string) =>
  invoke<PasteJob>("clipboard_paste_job", { jobId });
export const clipboardPasteActive = () =>
  invoke<string | null>("clipboard_paste_active");
export const clipboardCleanup = () => invoke<CleanupReport>("clipboard_cleanup");
export const clipboardStatus = () => invoke<ClipboardStatus>("clipboard_status");
/** 用户显式修复损坏的剪贴板配置；resume=true 时同时恢复自动记录。 */
export const clipboardRepairConfig = (resume: boolean) =>
  invoke<Settings>("clipboard_repair_config", { resume });
export const clipboardAgentTargets = () =>
  invoke<AgentClipboardTarget[]>("clipboard_agent_targets");
export const clipboardExportForAgent = (
  targetType: "item" | "group",
  targetId: string,
  taskId?: string | null,
) => invoke<ExportPackage>("clipboard_export_for_agent", { targetType, targetId, taskId });
export const clipboardExportPreview = (targetType: "item" | "group", targetId: string) =>
  invoke<Record<string, unknown>>("clipboard_export_preview", { targetType, targetId });
/** 只读探测当前剪贴板可读性与格式，不返回正文。 */
export const clipboardProbe = () => invoke<ClipboardProbe>("clipboard_probe");

// ── 行动中心（v0.5）──
export type ActionCategory = "intervention" | "notification" | "history";
export type ActionKind =
  | "failed"
  | "authorization"
  | "waiting_input"
  | "running"
  | "completed"
  | "disconnected"
  | "reminder";

export interface ActionItem {
  /** 稳定 ID：`run:<轮次>` / `notification:<通知>` */
  id: string;
  category: ActionCategory;
  kind: ActionKind;
  /** 0=P0 最高 … 3=P3 */
  priority: number;
  source_id: string;
  source_name: string;
  session_external_id: string;
  run_row_id: string | null;
  run_external_id: string | null;
  task_id: string | null;
  task_title: string | null;
  title: string;
  message: string;
  occurred_at: string;
  acked: boolean;
  /** 「需授权」是关键词推断，UI 必须标注 */
  authorization_inferred: boolean;
}

export interface ActionCoverage {
  source_id: string;
  display_name: string;
  enabled: boolean;
  verified: boolean;
  transport_verified: boolean;
  /** 仅 enabled && transport_verified 才算真正接入监控 */
  monitored: boolean;
  last_event_at: string | null;
  /** live | stale | no-events | disabled | not-configured */
  level: string;
  explanation: string;
  note: string;
}

export interface ActionCounts {
  /** 需介入：当前失败（未确认） */
  failed: number;
  /** 需介入：等待授权（关键词推断，未确认） */
  authorization: number;
  /** 需介入：等待输入（未确认） */
  waiting_input: number;
  /** 未读任务提醒 */
  reminder: number;
  /** 通知总数（提醒 + 未被当前状态代表的失败） */
  notification: number;
  /** 历史：运行中 */
  running: number;
  /** 历史：已完成 */
  completed: number;
  /** 历史：连接中断 */
  disconnected: number;
  /** 历史总轮次（最近 30 天） */
  history: number;
  /** 需介入总数 */
  intervention: number;
  /** 徽标数 = 需介入 + 通知（两者不重叠） */
  total: number;
}

export interface ActionFeed {
  items: ActionItem[];
  /** 全局计数：与筛选、分页、当前分类均无关 */
  counts: ActionCounts;
  coverage: ActionCoverage[];
  generated_at: string;
  category: ActionCategory;
  /** 该分类在数据库中的总条数（与筛选无关） */
  db_total: number;
  /** 当前筛选命中的总条数（与分页无关） */
  filtered_total: number;
  /** 当前返回页已加载条数 */
  loaded: number;
  has_more: boolean;
  next_cursor: string | null;
  /** 模块开关：关闭时为 false，items 必为空 */
  enabled: boolean;
}

export interface ActionFilter {
  source_id?: string;
  task_id?: string;
  kind?: ActionKind;
  priority?: number;
  include_acked?: boolean;
  category?: ActionCategory;
  cursor?: string;
  limit?: number;
}

export const actionsFeed = (filter?: ActionFilter) =>
  invoke<ActionFeed>("actions_feed", { filter });
/** ID 为 ActionItem.id（`run:` / `notification:`），不再使用原始事件 ID。 */
export const actionsAck = (ids: string[]) => invoke<number>("actions_ack", { eventIds: ids });
export const actionsUnack = (ids: string[]) =>
  invoke<number>("actions_unack", { eventIds: ids });
export const actionsOpenSession = (sourceId: string, sessionId: string) =>
  invoke<import("./navigation").NavigationResult>("actions_open_session", { sourceId, sessionId });

// ── 工作现场（v0.5）──
export interface SnapshotSummary {
  id: string;
  task_id: string | null;
  task_title: string | null;
  name: string;
  note: string;
  source: "manual" | "task";
  item_count: number;
  created_at: string;
  updated_at: string;
  last_restored_at: string | null;
  restore_count: number;
}

export interface SnapshotItem {
  id: string;
  snapshot_id: string;
  display_order: number;
  item_kind: "application" | "url" | "file" | "directory" | "agent_session";
  display_name: string;
  target_id: string | null;
  app_key: string;
  exe_path: string;
  launch_args: string;
  working_dir: string;
  app_user_model_id: string;
  url: string;
  path: string;
  agent_source_id: string;
  agent_session_id: string;
  window_title_hint: string;
  window_class: string;
  window_title: string;
  restore_note: string;
  last_result: string;
  last_verification: string;
  last_restored_at: string | null;
}

export interface SnapshotDetail extends SnapshotSummary {
  items: SnapshotItem[];
  /** 超过保留上限且受任务保护时由后端给出明确说明 */
  capacity_warning?: string | null;
}

export interface SnapshotItemInput {
  item_kind: SnapshotItem["item_kind"];
  display_name: string;
  target_id?: string | null;
  exe_path?: string;
  launch_args?: string;
  working_dir?: string;
  app_user_model_id?: string;
  url?: string;
  path?: string;
  agent_source_id?: string;
  agent_session_id?: string;
  window_title_hint?: string;
  window_class?: string;
  window_title?: string;
  restore_note?: string;
}

export interface CaptureInput {
  task_id?: string | null;
  name: string;
  note?: string;
  source?: "manual" | "task";
  items?: SnapshotItemInput[];
  /** 勾选的当前窗口句柄（仅本次解析，不落库） */
  window_hwnds?: number[];
}

export interface CaptureWindow {
  hwnd: number;
  title: string;
  class_name: string;
  exe_path: string | null;
  is_minimized: boolean;
}

export interface RestoreItemResult {
  item_id: string;
  display_name: string;
  item_kind: string;
  outcome: "restored" | "skipped" | "failed" | "cancelled";
  action: string | null;
  verification_level: string;
  fallback_used: boolean;
  reason: string | null;
}

export interface RestoreSummary {
  snapshot_id: string;
  total: number;
  restored: number;
  failed: number;
  skipped: number;
  cancelled: number;
  items: RestoreItemResult[];
}

export interface RestoreStatus {
  running: boolean;
  snapshot_id: string | null;
  /** 当前持有恢复槽的操作 ID；旧操作不得清除新操作状态 */
  operation_id?: string | null;
  cancel_requested: boolean;
}

export interface PruneReport {
  removed: number;
  protected: number;
  remaining: number;
  over_capacity: boolean;
  warning: string | null;
}

export const workspaceList = (taskId?: string | null) =>
  invoke<SnapshotSummary[]>("workspace_list", { taskId });
export const workspaceGet = (id: string) => invoke<SnapshotDetail>("workspace_get", { id });
export const workspaceCreate = (input: CaptureInput) =>
  invoke<SnapshotDetail>("workspace_create", { input });
export const workspaceCaptureTask = (taskId: string, name?: string, note?: string) =>
  invoke<SnapshotDetail>("workspace_capture_task", { taskId, name, note });
export const workspaceRename = (id: string, name: string, note?: string) =>
  invoke<void>("workspace_rename", { id, name, note });
export const workspaceDelete = (id: string) => invoke<void>("workspace_delete", { id });
export const workspacePrune = (keep?: number) =>
  invoke<PruneReport>("workspace_prune", { keep });
export const workspaceDetachTask = (id: string) => invoke<void>("workspace_detach_task", { id });
export const workspaceCaptureWindows = () =>
  invoke<CaptureWindow[]>("workspace_capture_windows");
export const workspaceRestore = (id: string) => invoke<boolean>("workspace_restore", { id });
export const workspaceRestoreCancel = () => invoke<void>("workspace_restore_cancel");
export const workspaceRestoreStatus = () =>
  invoke<RestoreStatus>("workspace_restore_status");

// ── 统一任务上下文（v0.5）──
export interface ContextAgent {
  link_id: string | null;
  source_id: string;
  source_name: string;
  session_external_id: string;
  title: string;
  state: string;
  last_seen_at: string | null;
  origin: "user" | "auto" | "nav";
}

export interface TaskContext {
  task: Task;
  agents: ContextAgent[];
  navigation: import("./navigation").TaskNavLink[];
  clipboard: ClipboardTaskLink[];
  snapshots: SnapshotSummary[];
  actions: ActionItem[];
}

export const taskContext = (taskId: string) => invoke<TaskContext>("task_context", { taskId });

export const clipboardLinkSnapshot = (
  snapshotId: string,
  targetType: "item" | "group",
  targetId: string,
) => invoke<ClipboardSnapshotLink>("clipboard_link_snapshot", { snapshotId, targetType, targetId });
export const clipboardUnlinkSnapshot = (linkId: string) =>
  invoke<void>("clipboard_unlink_snapshot", { linkId });
export const clipboardSnapshotLinks = (snapshotId: string) =>
  invoke<ClipboardSnapshotLink[]>("clipboard_snapshot_links", { snapshotId });

export interface ClipboardSnapshotLink {
  id: string;
  snapshot_id: string;
  target_type: "item" | "group";
  target_id: string;
  created_at: string;
  label: string;
  kind: string;
}

// ── 全局快速捕获（v0.7）──
/** 五种捕获类型：任务 / 想法 / 文字 / 待办 / 链接。 */
export type CaptureKind = "task" | "idea" | "text" | "todo" | "link";

/** 草稿（单行表 active）：窗口隐藏/退出后可恢复。 */
export interface CaptureDraft {
  kind: CaptureKind;
  content: string;
  updated_at: string;
}

/** 捕获窗口初始状态：草稿 + 上次类型 + 未处理条目数。 */
export interface CaptureState {
  draft: CaptureDraft | null;
  /** 后端 Settings.quick_capture_last_type；前端仍需归一兜底 */
  last_type: CaptureKind;
  inbox_count: number;
}

/**
 * 收集箱条目。status：inbox 未处理 / handled 已标记处理 / converted 已转任务。
 * 字段与后端 serde 一致（snake_case）；url/note 只在链接等类型上有值。
 */
export interface CaptureItem {
  id: string;
  client_id: string;
  kind: CaptureKind;
  content: string;
  url: string | null;
  note: string | null;
  status: "inbox" | "handled" | "converted";
  task_id: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

/** 提交载荷：client_id 供后端幂等去重（失败重试必须复用同一个）。 */
export interface SubmitCaptureInput {
  client_id: string;
  kind: CaptureKind;
  content: string;
  url?: string;
  note?: string;
}

export interface SubmitCaptureResult {
  id: string;
  kind: CaptureKind;
  status: string;
  task_id: string | null;
  duplicate: boolean;
  created_at: string;
}

/** quick_capture_save_draft 返回值：返回即视为已落库。 */
export interface CaptureDraftSaved {
  saved_at: string;
}

export const quickCaptureState = () => invoke<CaptureState>("quick_capture_state");
/** 保存草稿；content trim 后为空 = 清空草稿（后端仍返回 saved_at）。 */
export const quickCaptureSaveDraft = (kind: string, content: string) =>
  invoke<CaptureDraftSaved>("quick_capture_save_draft", { kind, content });
export const quickCaptureClearDraft = () => invoke<void>("quick_capture_clear_draft");
export const quickCaptureSetLastType = (kind: string) =>
  invoke<void>("quick_capture_set_last_type", { kind });
export const quickCaptureSubmit = (input: SubmitCaptureInput) =>
  invoke<SubmitCaptureResult>("quick_capture_submit", { input });
/** status：null/"all" = 全部；"inbox" = 未处理；limit 默认 50、上限 200。 */
export const quickCaptureList = (
  status?: string | null,
  limit?: number,
  offset?: number,
) => invoke<CaptureItem[]>("quick_capture_list", { status: status ?? null, limit, offset });
export const quickCaptureMarkHandled = (id: string) =>
  invoke<CaptureItem>("quick_capture_mark_handled", { id });
export const quickCaptureDelete = (id: string) => invoke<void>("quick_capture_delete", { id });
/** 转为任务（后端复用任务创建链路并回写 task_id/status）。 */
export const quickCaptureConvertToTask = (id: string) =>
  invoke<CaptureItem>("quick_capture_convert_to_task", { id });
/**
 * 隐藏捕获窗口并恢复原前台焦点（后端实现）。
 * 后端命令为零参数（`quick_capture_hide()`），不传任何参数；
 * reason 仅用于前端语义标注（用户关闭 / 保存成功），不会发给后端。
 */
export const quickCaptureHide = (_reason?: "user" | "success") =>
  invoke<void>("quick_capture_hide");

// ── 事件订阅 ──
/** 后端批量聚合后的 Agent 变化事件（一批一次，不随事件数量线性增长）。 */
export interface AgentChangedEvent {
  source_id: string;
  sources: string[];
  session_id: string;
  run_id?: string | null;
  state?: string | null;
  states: Record<string, number>;
  batch: number;
  changed: boolean;
  deduplicated: boolean;
  late: boolean;
}
export const onAgentChanged = (cb: (payload: AgentChangedEvent) => void): Promise<UnlistenFn> =>
  listen<AgentChangedEvent>("agent-changed", (e) => cb(e.payload));
export const onReminderFired = (cb: () => void): Promise<UnlistenFn> =>
  listen("reminder-fired", () => cb());
/** 延后成功（任意入口）：后端统一广播，主窗口弹带「撤销」的 Toast */
export const onReminderSnoozed = (cb: (payload: SnoozeResult) => void): Promise<UnlistenFn> =>
  listen<SnoozeResult>("reminder-snoozed", (e) => cb(e.payload));
export const onNotification = (cb: () => void): Promise<UnlistenFn> =>
  listen("notification", () => cb());
export const onModeChanged = (cb: (mode: string) => void): Promise<UnlistenFn> =>
  listen<string>("mode-changed", (e) => cb(e.payload));
export const onThemeChanged = (cb: (theme: string) => void): Promise<UnlistenFn> =>
  listen<string>("theme-changed", (e) => cb(e.payload));
export const onFocusQuickAdd = (cb: () => void): Promise<UnlistenFn> =>
  listen("focus-quick-add", () => cb());
export const onAppReady = (cb: () => void): Promise<UnlistenFn> =>
  listen("app-ready", () => cb());
// 通知窗口用户点击跳转（v0.7）：用户在桌面通知上点了「查看详情/通知中心」，
// 后端已激活主窗口；payload 携带可定位的 Agent 对象 ID（无可靠 ID 时为空）。
export interface NotificationNavigatePayload {
  tab: string;
  sourceId?: string;
  sessionId?: string;
  refId?: string;
}
export const onNotificationNavigate = (
  cb: (payload: NotificationNavigatePayload) => void,
): Promise<UnlistenFn> =>
  listen<NotificationNavigatePayload>("notification-navigate", (e) => cb(e.payload));
export const onClipboardChanged = (
  cb: (payload: { kind: string; created?: boolean; grouped?: boolean }) => void,
): Promise<UnlistenFn> =>
  listen<{ kind: string; created?: boolean; grouped?: boolean }>("clipboard-changed", (e) =>
    cb(e.payload),
  );
export const onClipboardPaste = (cb: (payload: ClipboardPasteEvent) => void): Promise<UnlistenFn> =>
  listen<ClipboardPasteEvent>("clipboard-paste", (e) => cb(e.payload));

// ── 工作现场事件（v0.5）──
export interface WorkspaceRestoreProgress {
  snapshot_id: string;
  index: number;
  total: number;
  phase: "started" | "running" | "item-done" | "done" | "error";
  item_id?: string | null;
  display_name?: string;
  result?: RestoreItemResult;
  summary?: RestoreSummary;
  error?: string;
}
export const onWorkspaceRestoreProgress = (
  cb: (payload: WorkspaceRestoreProgress) => void,
): Promise<UnlistenFn> =>
  listen<WorkspaceRestoreProgress>("workspace-restore-progress", (e) => cb(e.payload));
export const onWorkspaceChanged = (
  cb: (payload: { kind: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ kind: string }>("workspace-changed", (e) => cb(e.payload));

export const onAgentRetention = (cb: (payload: RetentionReport) => void): Promise<UnlistenFn> =>
  listen<RetentionReport>("agent-retention", (e) => cb(e.payload));

// ── 快速捕获事件（v0.7）──
/** 捕获窗口被唤起（后端已 show）后触发：前端借此刷新状态、恢复草稿、聚焦输入框。 */
export const onQuickCaptureSummoned = (cb: () => void): Promise<UnlistenFn> =>
  listen("quick-capture-summoned", () => cb());
/** 捕获窗口被隐藏（用户关闭 / 成功后自动隐藏 / 失焦）。 */
export const onQuickCaptureHidden = (cb: () => void): Promise<UnlistenFn> =>
  listen("quick-capture-hidden", () => cb());
/** 新捕获产生（提交或转任务成功后）：kind/id/task_id/status，非任务类型 task_id 为 null。 */
export interface QuickCaptureCreatedEvent {
  kind: CaptureKind;
  id: string;
  task_id: string | null;
  status: string;
}
export const onQuickCaptureCreated = (
  cb: (payload: QuickCaptureCreatedEvent) => void,
): Promise<UnlistenFn> =>
  listen<QuickCaptureCreatedEvent>("quick-capture-created", (e) => cb(e.payload));
/** 应用退出前要求立即落盘草稿（窗口可能即将销毁）。 */
export const onCaptureFlushDraft = (cb: () => void): Promise<UnlistenFn> =>
  listen("capture-flush-draft", () => cb());

// ── 规划中心（v0.7）：用户自建项目的功能规划、步骤、里程碑与进度历史 ──
// 数据边界：Task Dock 内置路线图（lib/featureCatalog.ts）不入库、不可通过本节命令修改。

export type PlanningProjectStatus = "planning" | "in_progress" | "paused" | "completed";
export type PlanningFeatureStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "completed"
  | "blocked"
  | "paused";
export type PlanningPriority = "P0" | "P1" | "P2";
export type PlanningActivityKind = "note" | "status_change" | "step_done";

export interface PlanningProjectStats {
  feature_total: number;
  feature_completed: number;
  feature_in_progress: number;
  feature_blocked: number;
  feature_planned: number;
  feature_review: number;
  feature_paused: number;
  /** false = 项目还没有功能；此时 progress_percent 恒为 0，UI 必须显示「尚未添加功能」 */
  has_features: boolean;
  progress_percent: number;
}

export interface PlanningProject {
  id: string;
  name: string;
  description: string;
  status: PlanningProjectStatus;
  archived: boolean;
  target_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  stats: PlanningProjectStats;
}

export interface PlanningProjectInput {
  name: string;
  description?: string;
  status?: PlanningProjectStatus;
  target_date?: string | null;
}

export interface PlanningProjectPatch {
  name?: string;
  description?: string;
  status?: PlanningProjectStatus;
  /** 三态：undefined = 保持；null = 清除；字符串 = 设置 */
  target_date?: string | null;
  sort_order?: number;
}

export interface PlanningStep {
  id: string;
  feature_id: string;
  title: string;
  done: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PlanningFeature {
  id: string;
  project_id: string;
  title: string;
  description: string;
  /** 空串 = 尚未填写；与 steps 分离，不用步骤冒充 */
  acceptance_criteria: string;
  status: PlanningFeatureStatus;
  priority: PlanningPriority;
  milestone_id: string | null;
  milestone_name: string | null;
  target_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  steps: PlanningStep[];
  /** 0 = 未拆分步骤（不产出百分比，UI 如实显示） */
  step_total: number;
  step_done: number;
}

export interface PlanningFeatureInput {
  title: string;
  description?: string;
  acceptance_criteria?: string;
  status?: PlanningFeatureStatus;
  priority?: PlanningPriority;
  milestone_id?: string | null;
  target_date?: string | null;
}

export interface PlanningFeaturePatch {
  title?: string;
  description?: string;
  acceptance_criteria?: string;
  status?: PlanningFeatureStatus;
  priority?: PlanningPriority;
  milestone_id?: string | null;
  target_date?: string | null;
  sort_order?: number;
}

export interface PlanningMilestone {
  id: string;
  project_id: string;
  name: string;
  description: string;
  target_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  feature_total: number;
  feature_completed: number;
}

export interface PlanningMilestoneInput {
  name: string;
  description?: string;
  target_date?: string | null;
}

export interface PlanningMilestonePatch {
  name?: string;
  description?: string;
  target_date?: string | null;
  sort_order?: number;
}

export interface PlanningActivity {
  id: string;
  project_id: string;
  feature_id: string | null;
  feature_title: string | null;
  kind: PlanningActivityKind;
  old_status: string | null;
  new_status: string | null;
  message: string;
  created_at: string;
}

export interface PlanningActivityPage {
  items: PlanningActivity[];
  has_more: boolean;
}

export interface PlanningStepPatch {
  title?: string;
  done?: boolean;
}

export const planningListProjects = (includeArchived?: boolean) =>
  invoke<PlanningProject[]>("planning_list_projects", { includeArchived });
export const planningCreateProject = (input: PlanningProjectInput) =>
  invoke<PlanningProject>("planning_create_project", { input });
export const planningUpdateProject = (id: string, patch: PlanningProjectPatch) =>
  invoke<PlanningProject>("planning_update_project", { id, patch });
export const planningArchiveProject = (id: string, archived: boolean) =>
  invoke<PlanningProject>("planning_archive_project", { id, archived });
export const planningDeleteProject = (id: string) =>
  invoke<void>("planning_delete_project", { id });
export const planningReorderProjects = (ids: string[]) =>
  invoke<void>("planning_reorder_projects", { ids });

export const planningListFeatures = (projectId: string) =>
  invoke<PlanningFeature[]>("planning_list_features", { projectId });
export const planningCreateFeature = (projectId: string, input: PlanningFeatureInput) =>
  invoke<PlanningFeature>("planning_create_feature", { projectId, input });
export const planningUpdateFeature = (id: string, patch: PlanningFeaturePatch) =>
  invoke<PlanningFeature>("planning_update_feature", { id, patch });
export const planningDeleteFeature = (id: string) =>
  invoke<void>("planning_delete_feature", { id });
export const planningReorderFeatures = (projectId: string, ids: string[]) =>
  invoke<void>("planning_reorder_features", { projectId, ids });

export const planningAddStep = (featureId: string, title: string) =>
  invoke<PlanningFeature>("planning_add_step", { featureId, title });
export const planningUpdateStep = (id: string, patch: PlanningStepPatch) =>
  invoke<PlanningFeature>("planning_update_step", { id, patch });
export const planningDeleteStep = (id: string) =>
  invoke<PlanningFeature>("planning_delete_step", { id });
export const planningReorderSteps = (featureId: string, ids: string[]) =>
  invoke<PlanningFeature>("planning_reorder_steps", { featureId, ids });

export const planningListMilestones = (projectId: string) =>
  invoke<PlanningMilestone[]>("planning_list_milestones", { projectId });
export const planningCreateMilestone = (projectId: string, input: PlanningMilestoneInput) =>
  invoke<PlanningMilestone>("planning_create_milestone", { projectId, input });
export const planningUpdateMilestone = (id: string, patch: PlanningMilestonePatch) =>
  invoke<PlanningMilestone>("planning_update_milestone", { id, patch });
export const planningDeleteMilestone = (id: string) =>
  invoke<void>("planning_delete_milestone", { id });

export const planningActivityPage = (
  projectId: string,
  opts?: { featureId?: string | null; limit?: number; offset?: number },
) =>
  invoke<PlanningActivityPage>("planning_activity_page", {
    projectId,
    featureId: opts?.featureId ?? null,
    limit: opts?.limit ?? null,
    offset: opts?.offset ?? null,
  });
export const planningAddNote = (
  projectId: string,
  featureId: string | null,
  message: string,
) => invoke<PlanningActivity>("planning_add_note", { projectId, featureId, message });

/** 规划中心展示辅助：功能状态 → 中文标签（与 featureCatalog 状态语义相互独立）。 */
export const PLANNING_FEATURE_STATUS_LABELS: Record<PlanningFeatureStatus, string> = {
  planned: "待开发",
  in_progress: "开发中",
  review: "待验收",
  completed: "已完成",
  blocked: "受阻",
  paused: "已暂停",
};

export const PLANNING_PROJECT_STATUS_LABELS: Record<PlanningProjectStatus, string> = {
  planning: "规划中",
  in_progress: "进行中",
  paused: "已暂停",
  completed: "已完成",
};

// ── 文件暂存架（v0.8）──

/** 条目内容类型：file=普通文件 / folder=文件夹 / image=图片 / link=网页链接 / text=文本片段。 */
export type ShelfKind = "file" | "folder" | "image" | "link" | "text";
/** 存储模式：reference=路径引用（不复制）/ managed=托管副本 / link=链接。 */
export type ShelfStorageMode = "reference" | "managed" | "link";
/** 来源：picker=文件选择器 / drag=拖入 / clipboard=从剪贴板添加 / url=手动输入链接 / manual=手动文本。 */
export type ShelfSourceKind = "picker" | "drag" | "clipboard" | "url" | "manual";

export interface ShelfItem {
  id: string;
  kind: ShelfKind;
  display_name: string;
  source_kind: ShelfSourceKind;
  storage_mode: ShelfStorageMode;
  /** 引用模式：原文件路径；托管模式：来源路径（可空） */
  original_path: string | null;
  /** 托管文件相对 shelf 目录的路径（files|images/thumbs 前缀） */
  managed_path: string | null;
  /** link=URL；text=正文。列表载荷不含（shelf_read_text 单独拉取） */
  content: string | null;
  byte_size: number;
  file_ext: string | null;
  favorite: boolean;
  pinned: boolean;
  /** 最近一次存在性检查：ok / missing / unknown */
  exists_state: "ok" | "missing" | "unknown";
  group_id: string | null;
  /** 场景工作区软关联预留（接口稳定前恒为 null） */
  scene_id: string | null;
  note: string;
  expire_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShelfGroup {
  id: string;
  name: string;
  builtin: boolean;
  sort_order: number;
  item_count: number;
}

export interface ShelfPage {
  items: ShelfItem[];
  total: number;
}

export interface ShelfStats {
  total: number;
  file_count: number;
  image_count: number;
  folder_count: number;
  link_count: number;
  text_count: number;
  managed_bytes: number;
  disk_bytes: number;
  quota_mb: number;
}

export interface ShelfFailedEntry {
  path: string;
  reason: string;
}

export interface ShelfAddReport {
  added: ShelfItem[];
  failed: ShelfFailedEntry[];
}

export interface ShelfDeleteReport {
  deleted: number;
  skipped: number;
  freed_bytes: number;
  failed_files: number;
}

export interface ShelfCleanupReport {
  dry_run: boolean;
  candidates: number;
  skipped_protected: number;
  freed_bytes: number;
  failed_files: number;
  orphan_files_removed: number;
}

export interface ShelfTaskLink {
  task_id: string;
  item_id: string;
  task_title: string;
  created_at: string;
}

export interface ShelfUpdatePatch {
  display_name?: string;
  favorite?: boolean;
  pinned?: boolean;
  /** 具体分组 id 或 "none"（未分组）；缺省不修改 */
  group_id?: string;
  note?: string;
  expire_at?: string | null;
}

export const shelfList = (opts?: {
  search?: string;
  kind?: ShelfKind | "all";
  group_id?: string;
  favorite_only?: boolean;
  limit?: number;
  offset?: number;
}) =>
  invoke<ShelfPage>("shelf_list", {
    search: opts?.search ?? null,
    kind: opts?.kind ?? "all",
    groupId: opts?.group_id ?? "all",
    favoriteOnly: opts?.favorite_only ?? false,
    limit: opts?.limit ?? 100,
    offset: opts?.offset ?? 0,
  });

export const shelfStats = () => invoke<ShelfStats>("shelf_stats");

export const shelfGroups = () => invoke<ShelfGroup[]>("shelf_groups");

export const shelfGroupCreate = (name: string) =>
  invoke<ShelfGroup>("shelf_group_create", { name });

export const shelfGroupRename = (id: string, name: string) =>
  invoke<void>("shelf_group_rename", { id, name });

export const shelfGroupDelete = (id: string) => invoke<void>("shelf_group_delete", { id });

/**
 * 批量添加文件/文件夹（拖入与文件选择器共用）。
 * reference 不复制原文件；managed 复制到 Task Dock 托管目录（受配额约束）。
 */
export const shelfAddPaths = (
  paths: string[],
  storageMode: ShelfStorageMode,
  sourceKind: "picker" | "drag" | "manual",
  groupId?: string | null,
) =>
  invoke<ShelfAddReport>("shelf_add_paths", {
    paths,
    storageMode,
    sourceKind,
    groupId: groupId ?? null,
  });

export const shelfAddLink = (url: string, groupId?: string | null) =>
  invoke<ShelfItem>("shelf_add_link", { url, groupId: groupId ?? null });

export const shelfAddText = (text: string, groupId?: string | null) =>
  invoke<ShelfItem>("shelf_add_text", { text, groupId: groupId ?? null });

/** 从剪贴板条目添加：生成独立副本，与剪贴板历史生命周期解耦。 */
export const shelfAddFromClipboard = (
  itemIds: string[],
  storageMode: ShelfStorageMode,
  groupId?: string | null,
) =>
  invoke<ShelfAddReport>("shelf_add_from_clipboard", {
    itemIds,
    storageMode,
    groupId: groupId ?? null,
  });

export const shelfUpdate = (id: string, patch: ShelfUpdatePatch) =>
  invoke<ShelfItem>("shelf_update", { id, patch });

/** 删除条目：托管副本一并删除；引用模式绝不触碰原文件。收藏/置顶需显式确认。 */
export const shelfDelete = (ids: string[], includeProtected: boolean) =>
  invoke<ShelfDeleteReport>("shelf_delete", { ids, includeProtected });

export const shelfClear = (includeProtected: boolean) =>
  invoke<ShelfDeleteReport>("shelf_clear", { includeProtected });

/** 过期清理：dryRun=true 只返回预览（候选数/释放字节/受保护跳过）。 */
export const shelfCleanup = (dryRun: boolean, includeProtected: boolean) =>
  invoke<ShelfCleanupReport>("shelf_cleanup", { dryRun, includeProtected });

export const shelfCheckExists = (ids: string[]) =>
  invoke<{ id: string; exists_state: string }[]>("shelf_check_exists", { ids });

export const shelfOpenItem = (id: string) => invoke<void>("shelf_open_item", { id });

export const shelfRevealItem = (id: string) => invoke<void>("shelf_reveal_item", { id });

export const shelfReadText = (id: string) =>
  invoke<{ content: string; truncated: boolean }>("shelf_read_text", { id });

/** full=false 读缩略图；full=true 读原图（≤40MB）。引用失效返回 null。 */
export const shelfReadImage = (id: string, full: boolean) =>
  invoke<string | null>("shelf_read_image", { id, full });

/** 复制路径（文本）/ 复制文件（CF_HDROP，资源管理器可直接粘贴）——系统级拖出未实现前的替代。 */
export const shelfCopyPaths = (ids: string[]) => invoke<number>("shelf_copy_paths", { ids });
export const shelfCopyFiles = (ids: string[]) => invoke<number>("shelf_copy_files", { ids });

export const shelfTaskLinks = (itemId: string) =>
  invoke<ShelfTaskLink[]>("shelf_task_links", { itemId });

export const shelfLinkTask = (itemId: string, taskId: string) =>
  invoke<void>("shelf_link_task", { itemId, taskId });

export const shelfUnlinkTask = (itemId: string, taskId: string) =>
  invoke<void>("shelf_unlink_task", { itemId, taskId });

/** 暂存架条目类型 → 中文名。 */
export const SHELF_KIND_LABELS: Record<ShelfKind, string> = {
  file: "文件",
  folder: "文件夹",
  image: "图片",
  link: "链接",
  text: "文本",
};
