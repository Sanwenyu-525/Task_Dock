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
) => invoke<Task>("create_from_quick_add", { text, due_at: dueAt, recurrence, advance_minutes: advanceMinutes });
export const snoozeReminder = (taskId: string, minutes: number) =>
  invoke<void>("snooze_reminder", { task_id: taskId, minutes });
export const linkTaskAgent = (
  taskId: string,
  sourceId: string,
  sessionExternalId: string,
  runExternalId?: string,
) => invoke<TaskAgentLink>("link_task_agent", { task_id: taskId, source_id: sourceId, session_external_id: sessionExternalId, run_external_id: runExternalId });
export const unlinkTaskAgent = (linkId: string) => invoke<void>("unlink_task_agent", { link_id: linkId });
export const listTaskLinks = (taskId: string) => invoke<TaskAgentLink[]>("list_task_links", { task_id: taskId });
export const pendingItemsToTasks = (items: string[]) =>
  invoke<Task[]>("pending_items_to_tasks", { items });

// ── Agent ──
export const agentSnapshot = () => invoke<AgentSnapshot>("agent_snapshot");
export const setSourceEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_source_enabled", { id, enabled });
// 动态来源注册
export const createSource = (id: string, displayName: string, adapter?: string, homepage?: string, note?: string, icon?: string) =>
  invoke<void>("create_source", { id, display_name: displayName, adapter, homepage, note, icon });
export const updateSource = (id: string, patch: { display_name?: string; homepage?: string; note?: string; icon?: string; hidden?: boolean }) =>
  invoke<void>("update_source", { id, ...patch });
export const deleteSource = (id: string, alsoDeleteData = false) =>
  invoke<void>("delete_source", { id, also_delete_data: alsoDeleteData });
// 自动发现 + 接入向导
export const discoveryScan = () => invoke<DiscoveredAgent[]>("discovery_scan");
export const adapterList = () =>
  invoke<{ id: string; display_name: string; transport_kind: string; docs_url: string }[]>("adapter_list");
export const adapterPreview = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_preview", { adapter_id: adapterId });
export const adapterInstall = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_install", { adapter_id: adapterId });
export const adapterVerify = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_verify", { adapter_id: adapterId });
export const adapterUninstall = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_uninstall", { adapter_id: adapterId });
export const adapterStatus = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_status", { adapter_id: adapterId });
export const mockStartScenario = (sessionTitle: string, outcome: string) =>
  invoke<void>("mock_start_scenario", { session_title: sessionTitle, outcome });
export const codexHooksStatus = () =>
  invoke<{ installed: boolean; hooks_path: string; script_path: string; codex_home: string }>(
    "codex_hooks_status",
  );
export const codexHooksInstall = () => invoke<Record<string, unknown>>("codex_hooks_install");
export const codexHooksUninstall = () => invoke<Record<string, unknown>>("codex_hooks_uninstall");
export const openAgentSession = (sourceId: string, sessionId: string) =>
  invoke<void>("open_agent_session", { source_id: sourceId, session_id: sessionId });
export const listNotifications = (unreadOnly = false, limit = 100) =>
  invoke<NotificationRow[]>("list_notifications", { unread_only: unreadOnly, limit });
export const markNotificationRead = (id: string) => invoke<void>("mark_notification_read", { id });
export const markAllNotificationsRead = () => invoke<void>("mark_all_notifications_read");
export const clearNotifications = () => invoke<void>("clear_notifications");
export const listAgentEvents = (limit = 100, sourceId?: string) =>
  invoke<AgentEventRow[]>("list_agent_events", { limit, source_id: sourceId });

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

// ── 事件订阅 ──
export const onAgentChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("agent-changed", () => cb());
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
