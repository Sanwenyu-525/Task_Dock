//! 与 Tauri 后端的类型化桥接层。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface RecurrenceRule {
  id: string;
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  by_weekday: number[];
  by_monthday: number | null;
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
}

export interface TaskFilter {
  view?: string;
  status?: string;
  category?: string;
  tag?: string;
  priority?: number;
  search?: string;
  sort?: string;
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
  last_event_at: string | null;
  health_state: string;
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
  applied: boolean;
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
  byte_size: number;
  source_app: string;
  source_title: string;
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
}

export interface CleanupReport {
  items_deleted: number;
  groups_closed: number;
  bytes_freed: number;
  orphan_files_removed: number;
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
  skipped: number;
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

export interface ClipboardStatus {
  enabled: boolean;
  paused: boolean;
  monitoring: boolean;
  activeJob: string | null;
  platform: string;
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
  invoke<void>("snooze_reminder", { taskId, minutes });
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
export const listNotifications = (unreadOnly = false, limit = 100) =>
  invoke<NotificationRow[]>("list_notifications", { unreadOnly, limit });
export const markNotificationRead = (id: string) => invoke<void>("mark_notification_read", { id });
export const markAllNotificationsRead = () => invoke<void>("mark_all_notifications_read");
export const clearNotifications = () => invoke<void>("clear_notifications");
export const listAgentEvents = (limit = 100, sourceId?: string, before?: string) =>
  invoke<AgentEventRow[]>("list_agent_events", { limit, sourceId, before });

// ── 设置 ──
export const getSettings = () => invoke<Settings>("get_settings");
export const updateSettings = (patch: Partial<Settings>) =>
  invoke<Settings>("update_settings", { patch });
export const saveWindowRect = (rect: { x: number; y: number; w: number; h: number }) =>
  invoke<void>("save_window_rect", { rect });
export const getWindowRect = () =>
  invoke<{ x: number; y: number; w: number; h: number } | null>("get_window_rect");
export const saveSnapState = (edge: string, hidden: boolean) =>
  invoke<void>("save_snap_state", { state: { edge, hidden } });
export const getSnapState = () =>
  invoke<{ edge: string; hidden: boolean } | null>("get_snap_state");

// ── 数据 ──
export const exportData = (path: string) => invoke<string>("export_data", { path });
export const importData = (path: string) => invoke<void>("import_data", { path });
export const backupNow = () => invoke<string>("backup_now");
export const listBackups = () =>
  invoke<{ name: string; size: number; modified: string }[]>("list_backups");
export const quitApp = () => invoke<void>("quit_app");
export const setAutostart = (enabled: boolean) => invoke<boolean>("set_autostart", { enabled });
export const applyMode = (mode: string) => invoke<void>("apply_mode", { mode });
export const applyWindowMaterial = (material: string) =>
  invoke<MaterialResult>("apply_window_material", { material });
export const setHotkeysEnabled = (enabled: boolean) =>
  invoke<void>("set_hotkeys_enabled", { enabled });
export const getAgentInboxDir = () => invoke<string>("get_agent_inbox_dir");
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
export const clipboardCopyGroupRich = (groupId: string) =>
  invoke<CopyReport>("clipboard_copy_group_rich", { groupId });
export const clipboardCopyGroupFiles = (groupId: string) =>
  invoke<CopyReport>("clipboard_copy_group_files", { groupId });
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
export type ActionKind =
  | "failed"
  | "authorization"
  | "waiting_input"
  | "running"
  | "completed"
  | "disconnected"
  | "reminder";

export interface ActionItem {
  id: string;
  kind: ActionKind;
  /** 0=P0 最高 … 3=P3 */
  priority: number;
  source_id: string;
  source_name: string;
  session_external_id: string;
  run_row_id: string | null;
  task_id: string | null;
  task_title: string | null;
  title: string;
  message: string;
  occurred_at: string;
  /** 合并窗口内的重复事件数 */
  count: number;
  event_ids: string[];
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
  failed: number;
  authorization: number;
  waiting_input: number;
  running: number;
  completed: number;
  disconnected: number;
  reminder: number;
}

export interface ActionFeed {
  items: ActionItem[];
  counts: ActionCounts;
  coverage: ActionCoverage[];
  generated_at: string;
  truncated: boolean;
  scanned_events: number;
}

export interface ActionFilter {
  source_id?: string;
  task_id?: string;
  kind?: ActionKind;
  priority?: number;
  include_acked?: boolean;
  limit?: number;
}

export const actionsFeed = (filter?: ActionFilter) =>
  invoke<ActionFeed>("actions_feed", { filter });
export const actionsAck = (eventIds: string[]) =>
  invoke<number>("actions_ack", { eventIds });
export const actionsUnack = (eventIds: string[]) =>
  invoke<number>("actions_unack", { eventIds });
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
  cancel_requested: boolean;
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
export const workspacePrune = (keep?: number) => invoke<number>("workspace_prune", { keep });
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
