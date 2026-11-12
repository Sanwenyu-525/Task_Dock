//! 与 Tauri 后端的类型化桥接层。

import { invokeCommand as invoke } from "./errors";
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
  /** 当前有效的真实轮次数；超出实时快照轮次上限时仍保留准确计数。 */
  live_run_count?: number;
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
  /** 后端全量计数；明细仍有界，超限可经 keyset 分页继续查看。 */
  live_summary?: AgentLiveSummary;
}

export interface AgentLiveCounts {
  active_session_total: number;
  session_total: number;
  run_total: number;
  running: number;
  waiting: number;
  failed: number;
  disconnected: number;
}

export interface AgentLiveSummary extends AgentLiveCounts {
  by_source?: Record<string, AgentLiveCounts>;
  sessions_truncated: boolean;
  runs_truncated: boolean;
  next_cursor: string | null;
}

/**
 * 历史会话条目（P1-02 后端分页）。
 * 与 `AgentSession` 字段一致，额外给出该会话的真实轮次数 `run_count`；
 * 数据来自独立分页查询，不受实时快照 200 条上限影响。
 */
export interface AgentHistorySession extends AgentSession {
  run_count: number;
  /** 当前有效真实轮次的最差状态；历史会话为 null。 */
  live_state?: string | null;
  live_run_count?: number;
}

export interface AgentHistorySessionsPage {
  items: AgentHistorySession[];
  /** 当前筛选条件下的全库总数（与游标无关） */
  total: number;
  /** 下一页游标；null 表示没有更多 */
  next_cursor: string | null;
}

export interface AgentHistoryRunsPage {
  items: AgentRun[];
  total: number;
  next_cursor: string | null;
}

/** 历史入口分组：按真实 source/instance 聚合历史数量（不含实时会话）。 */
export interface AgentHistoryGroup {
  source_id: string;
  /** null = 未关联实例或实例行已失效 */
  instance_id: string | null;
  instance_key: string | null;
  display_name: string | null;
  count: number;
}

export interface AgentHistoryGroups {
  items: AgentHistoryGroup[];
  truncated: boolean;
}

/** 历史会话查询条件；未提供的字段表示不筛选。 */
export interface AgentHistorySessionsQuery {
  sourceId?: string;
  instanceId?: string;
  /** 只查未关联到任何已知实例的会话；与 instanceId 同时提供时以 instanceId 为准 */
  unassigned?: boolean;
  /** 会话状态（running/waiting/completed/failed/disconnected/idle） */
  status?: string;
  /** 会话标题 / external_id / 关联轮次任务标题 */
  keyword?: string;
  /** 按会话行 ID 精确查找（通知定位）；命中时忽略游标 */
  sessionId?: string;
  /**
   * 是否包含实时会话。默认 false：历史列表/COUNT 与实时树互斥；
   * 精确按会话 ID 定位由后端固定包含实时。
   */
  includeLive?: boolean;
  /** 仅查实时会话，用于从快照容量边界继续按 keyset 访问。 */
  liveOnly?: boolean;
  cursor?: string;
  /** 1..100，默认 20 */
  limit?: number;
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
  /** 宿主真实触发（origin='real'）的最近事件；自测/手动上报不计入 */
  last_real_event_at: string | null;
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
  /**
   * 边缘吸附展示形态：capsule 胶囊隐藏（默认，老用户兼容）| full 完整面板。
   * 完整面板停靠不强制置顶；仅影响停靠后的展示，不改变窗口生命周期。
   */
  snap_display_mode: "capsule" | "full";
  /**
   * 工具面板宽度（CSS px，280–480）：停靠期拖拽面板内侧边调整并持久化。
   * 旧库缺键时后端返回默认 340；前端读侧仍按胶囊契约收敛。
   */
  capsule_panel_width: number;
  autostart: boolean;
  hotkey_enabled: boolean;
  http_enabled: boolean;
  http_port: number;
  http_token: string;
  mcp_server_enabled: boolean;
  /** 手机接入（v0.16）：允许局域网配对与连接，默认关闭。 */
  mobile_sync_enabled?: boolean;
  /** 手机接入监听端口（默认 47822，需与 Agent 接入端口区分）。 */
  mobile_sync_port?: number;
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
  // ── 统一提示音 / 语音播报 / 本地缓存（v0.13，后端缺键时有默认值）──
  audio_sound_enabled?: boolean;
  audio_sound_volume?: number;
  audio_sound_agent_started?: boolean;
  audio_sound_agent_done?: boolean;
  audio_sound_agent_waiting?: boolean;
  audio_sound_agent_failed?: boolean;
  audio_sound_agent_disconnected?: boolean;
  audio_sound_task_due?: boolean;
  audio_sound_reminder?: boolean;
  tts_enabled?: boolean;
  tts_voice_id?: string;
  tts_voice_gender?: "auto" | "female" | "male";
  tts_volume?: number;
  tts_rate?: number;
  tts_speak_source?: boolean;
  tts_speak_title?: boolean;
  tts_agent_started?: boolean;
  tts_agent_done?: boolean;
  tts_agent_waiting?: boolean;
  tts_agent_failed?: boolean;
  tts_agent_disconnected?: boolean;
  tts_task_due?: boolean;
  tts_reminder?: boolean;
  tts_cache_enabled?: boolean;
  tts_cache_max_mb?: number;
  /** 自定义固定语音片段：仅在现有 TTS 总开关开启时参与语音路由。 */
  tts_voice_pack_enabled?: boolean;
  tts_voice_pack_id?: string;
  tts_voice_route?: "auto" | "system" | "custom";
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
  /** 开发工作台（2026-11）：当前关注的开发任务 ID（tasks.id 字符串；空 = 未设置）。 */
  workbench_current_task: string;
  /**
   * 开发现场（2026-11 Round 1）：当前开发项目 ID（dev_projects.id，UUID 字符串；
   * 空 = 未设置）。旧库缺键时后端返回空串，前端读侧按可选处理。
   */
  workbench_current_project?: string;
  // 模块独立启停（v0.5 整改）
  workspace_enabled: boolean;
  actions_enabled: boolean;
  /** 行动中心临时暂停：只停自动聚合刷新与徽标，历史仍可手动查看。 */
  actions_paused?: boolean;
  /**
   * 提醒调度暂停（v0.15）：暂停期间到期提醒保持未触发，恢复后按既有过期
   * 补偿语义补触发；任务/提醒数据不删除。旧库缺省为 false。
   */
  reminders_paused?: boolean;
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
   * 自动识别图片文字（v0.13）：默认 false。第一阶段只保存设置，
   * 不接入采集热路径；手动「提取文字」始终可用。
   */
  clipboard_ocr_auto?: boolean;
  /**
   * 快速捕获上次使用的类型（v0.7）：task | idea | text | todo | link。
   * 旧库缺省该键时后端补默认 "task"；前端再做一次归一兜底。
   */
  quick_capture_last_type?: string;
  // 文件暂存架（v0.8）：自动过期清理默认关闭；旧库缺省走后端默认值
  shelf_auto_cleanup_enabled?: boolean;
  shelf_retention_days?: number;
  shelf_max_storage_mb?: number;
  /**
   * 导航入口布局（v0.12）：完整面板与停靠胶囊各自的可见入口 + 排序。
   * 版本化 JSON 对象，结构见 `src/lib/navVisibility.ts`；缺失或损坏时前端回退
   * 注册中心默认值，后端只做对象级校验，不参与语义合并。
   */
  navigation_layout?: unknown;
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

/**
 * 本地 OCR 结果。状态与短原因分开：
 * ok / empty / unavailable / busy / cancelled / error / too_large。
 * text 为识别与规范化后的文字（可能被后端截断到上限），不含图片内容。
 */
export interface ClipboardOcrReport {
  status: "ok" | "empty" | "unavailable" | "busy" | "cancelled" | "error" | "too_large";
  /** 机器可读原因：not_image / missing_image / engine_unavailable / busy / … */
  code: string;
  text: string;
  reason: string | null;
  durationMs: number;
  cached: boolean;
  lines: number;
  chars: number;
  width: number;
  height: number;
  engine: string | null;
  suggestedTitle: string | null;
}

/** 组内各内容类型的数量（html 计入文本展示，但仍单独给出）。 */
export interface ClipboardGroupKindCounts {
  image: number;
  text: number;
  html: number;
  url: number;
  files: number;
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
  /**
   * 列表接口即填充；旧数据/旧后端可能缺失，前端按 item_count/image_count 兜底。
   */
  kind_counts?: ClipboardGroupKindCounts;
  /** 图片组的代表缩略图（最多 3 条，只含图片元数据，不含正文）。 */
  cover_items?: ClipboardItem[];
  /** 仅详情接口填充 */
  items: ClipboardItem[];
}

/**
 * 截图组有界分页结果（`clipboard_group_page`）：只下发请求范围内的条目，
 * 不整组返回。`totalCount` / `imageCount` 是组内真实总数，不是到手条目数；
 * `revision` 是后端内容版本（计数 + 组更新时间 + 组内最近变更），用于前端缓存键。
 */
export interface ClipboardGroupPage {
  groupId: string;
  items: ClipboardItem[];
  totalCount: number;
  imageCount: number;
  offset: number;
  limit: number;
  revision: string;
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
  /**
   * 使用次数是否已落库。`false` 表示剪贴板写入成功但统计持久化失败：
   * 前端显示「部分成功」，且不得本地累加使用次数。
   * 后端旧版本/预览夹具可能缺省该字段，按 `true` 兼容。
   */
  stats_recorded?: boolean;
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
  /** 看门狗/过期清理维护线程是否仍在运行（暂停后用于区分 paused / pausing） */
  maintenance?: boolean;
  /** 采集实例是否正在异步回收（与 maintenance 一起决定是否仍为 pausing） */
  draining?: boolean;
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

/**
 * 一次探测结果。`probed_at_ms` 是快照**真实扫描完成时间**（Unix 毫秒）；
 * 命中 5 分钟缓存时它就是旧快照时间，`cached=true` 表示本次没有重新扫描。
 */
export interface AgentTargetsSnapshot {
  targets: AgentClipboardTarget[];
  probed_at_ms: number;
  cached: boolean;
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
/** 按 ID 读取单个任务；用于微件点击时主窗当前筛选列表未加载该任务的场景。 */
export const fetchTask = (id: string) => invoke<Task>("fetch_task", { id });
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
/**
 * 历史会话分页（P1-02）：独立 COUNT + keyset 游标，不受实时快照上限影响。
 * 展开历史分区、加载更多、搜索历史时调用；实时刷新仍走 `agentSnapshot`。
 */
export const agentHistorySessions = (query: AgentHistorySessionsQuery = {}) =>
  invoke<AgentHistorySessionsPage>("agent_history_sessions", { query });
/** 会话轮次按需分页：展开会话后再加载，避免一次拉全部历史轮次。 */
export const agentHistoryRuns = (
  sessionId: string,
  cursor?: string | null,
  limit = 10,
  includeLive = false,
  liveOnly = false,
) =>
  invoke<AgentHistoryRunsPage>("agent_history_runs", {
    sessionId,
    cursor: cursor ?? undefined,
    limit,
    includeLive: includeLive || undefined,
    liveOnly: liveOnly || undefined,
  });
/** 按会话行 ID 精确定位（通知跳转/深链）。 */
export const agentHistorySession = (sessionId: string) =>
  invoke<AgentHistorySession | null>("agent_history_session", { sessionId });
/** 历史入口分组：一次聚合查询某来源下每个真实实例/未关联实例的历史数量。 */
export const agentHistoryGroups = (query: { sourceId?: string; includeLive?: boolean } = {}) =>
  invoke<AgentHistoryGroups>("agent_history_groups", { query });
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

// ── 统一音频通知服务：TTS 合成与本地缓存（v0.13）──
export interface TtsVoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: "male" | "female" | "unknown";
  /** 合成引擎 ID：系统语音固定 `system`；高品质引擎为其模型 ID */
  engine: string;
  available: boolean;
}
/**
 * 引擎元数据：`available=false` 时 UI 必须如实展示原因，
 * 不得伪造音色、不得静默回退（后端同样拒绝不可用引擎的合成请求）。
 */
export interface TtsEngineInfo {
  id: string;
  name: string;
  available: boolean;
  /** not_integrated | unsupported_platform；可用时为空 */
  reason: string;
  detail: string;
  requiresDownload: boolean;
}
export interface TtsVoicesReport {
  ok: boolean;
  code: string;
  message: string;
  voices: TtsVoiceInfo[];
  engines: TtsEngineInfo[];
  hasChineseMale: boolean;
  hasChineseFemale: boolean;
  platform: string;
}
export interface TtsSynthesisReport {
  ok: boolean;
  code: string;
  message: string;
  dataUrl?: string;
  contentType?: string;
  voiceId?: string;
  voiceName?: string;
  language?: string;
  gender?: string;
  requestedVoiceId?: string;
  /** 请求语音不可用、系统实际回退到另一语音（UI 应如实提示，不伪装） */
  voiceFallback: boolean;
  /** 来自持久化缓存（未重新合成） */
  cached: boolean;
  persisted: boolean;
  bytes: number;
  latencyMs: number;
}
export interface TtsCacheReport {
  ok: boolean;
  enabled: boolean;
  bytes: number;
  files: number;
  maxBytes: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  memoryHits: number;
  failedFiles?: number;
  skippedFiles?: number;
  status?: "ready" | "partial" | "unavailable";
  errorCode?: string;
  errorMessage?: string;
}
export interface TtsCacheClearReport {
  ok: boolean;
  freedBytes: number;
  removedFiles: number;
  failedFiles?: number;
  skippedFiles?: number;
  status?: "success" | "partial" | "failed";
  errorCode?: string;
  errorMessage?: string;
}

export type VoiceEventKind =
  | "agent_started"
  | "agent_done"
  | "agent_done_multiple"
  | "agent_waiting"
  | "agent_failed"
  | "agent_disconnected"
  | "task_due"
  | "reminder";

export type VoiceRouteMode = "auto" | "system" | "custom";

export interface VoiceAsset {
  id: string;
  displayName: string;
  mediaType: "audio/mpeg" | "audio/wav";
  durationMs: number;
  sizeBytes: number;
}

export interface VoiceBinding {
  eventKind: VoiceEventKind;
  assetId: string;
}

export interface VoicePack {
  id: string;
  name: string;
  storageBytes: number;
  assets: VoiceAsset[];
  bindings: VoiceBinding[];
}

export interface VoiceClip {
  assetId: string;
  mediaType: VoiceAsset["mediaType"];
  durationMs: number;
}

export interface VoiceAssetImportResult {
  ok: boolean;
  code: string;
  asset?: VoiceAsset;
  /** 超过建议时长但未超过硬上限时为 true。 */
  durationWarning?: boolean;
}

export interface VoiceDeleteResult {
  /** 数据库删除已提交成功。 */
  deleted: boolean;
  /** 仍有孤儿文件待后续重试清理。 */
  cleanupPending: boolean;
  /** 清理警告代码，成功清理时为 null。 */
  cleanupWarning?: string | null;
  /** 本次实际解除引用的资源数。 */
  removedAssets: number;
  /** 本次实际确认释放的字节。 */
  freedBytes: number;
}

export const voicePacksList = () => invoke<VoicePack[]>("voice_packs_list");
export const voicePackCreate = (name: string) =>
  invoke<string>("voice_pack_create", { name });
export const voicePackRename = (packId: string, name: string) =>
  invoke<void>("voice_pack_rename", { packId, name });
export const voicePackDelete = (packId: string) =>
  invoke<VoiceDeleteResult>("voice_pack_delete", { packId });
export const voiceAssetImport = (packId: string, path: string) =>
  invoke<VoiceAssetImportResult>("voice_asset_import", { packId, path });
export const voiceAssetRemove = (packId: string, assetId: string) =>
  invoke<VoiceDeleteResult>("voice_asset_remove", { packId, assetId });
export const voiceBindingSet = (
  packId: string,
  eventKind: VoiceEventKind,
  assetId: string | null,
) => invoke<void>("voice_binding_set", { packId, eventKind, assetId });
export const voiceResolveClip = (eventKind: VoiceEventKind) =>
  invoke<VoiceClip | null>("voice_resolve_clip", { eventKind });
export const voiceAssetPath = (assetId: string) =>
  invoke<string>("voice_asset_path", { assetId });

export const ttsListVoices = () => invoke<TtsVoicesReport>("tts_list_voices");
export const ttsSynthesize = (args: {
  text: string;
  voiceId?: string;
  gender?: string;
  rate?: number;
  persist?: boolean;
  /** 合成引擎；缺省为 system。不可用引擎返回结构化 engine_unavailable */
  engine?: string;
}) => invoke<TtsSynthesisReport>("tts_synthesize", args);
export const ttsCacheStats = () => invoke<TtsCacheReport>("tts_cache_stats");
export const ttsCacheClear = () => invoke<TtsCacheClearReport>("tts_cache_clear");

export type ResourceCleanupCategory = "temporary" | "tts" | "orphan_thumbnails";
export type ResourceAvailability = "ready" | "partial" | "unavailable";
export type ResourceCleanupStatus = "success" | "partial" | "failed" | "skipped";

/** 进程状态只表达可解释的观察结果，不构成「应该结束」的建议。 */
export type ResourceProcessStatus = "normal" | "high_usage" | "exited" | "unknown";
/** 归属分级：名称匹配只作线索，不作为所有权证明。 */
export type ResourceProcessAssociation =
  | "self"
  | "managed_child"
  | "project_dev"
  | "external_tool"
  | "unknown_owner";
export type ResourceProcessBasis =
  | "self"
  | "parent_chain"
  | "image_path"
  | "name_and_path"
  | "unverified";

export interface ResourceProcessSnapshot {
  pid: number;
  name: string;
  cpuPercent: number | null;
  cpuWindowMs: number;
  workingSetBytes: number | null;
  privateBytes: number | null;
  uptimeSecs: number | null;
  status: ResourceProcessStatus;
}

export interface ResourceProcessRow extends ResourceProcessSnapshot {
  association: ResourceProcessAssociation;
  associationBasis: ResourceProcessBasis;
}

export interface ResourceProcessDiagnostics {
  sampledAt: string;
  cpuWindowMs: number;
  supported: boolean;
  truncated: boolean;
  /** 名称匹配但归属未确认、被折叠未展示的外部工具数量。 */
  omittedExternal: number;
  /** 归属不明、被折叠未展示的进程数量。 */
  omittedUnknown: number;
  processes: ResourceProcessRow[];
}

export interface ResourceSnapshot {
  sampledAt: string;
  application: {
    knownCacheBytes: number | null;
    knownCacheFiles: number | null;
    status: ResourceAvailability;
  };
  memory: {
    totalBytes: number | null;
    availableBytes: number | null;
  };
  /** 只读枚举的全部逻辑卷；数据目录所在卷排首位（界面据此显示主盘）。 */
  disks: Array<{
    volume: string;
    kind: "fixed" | "removable" | "remote" | "ramdisk" | "optical" | "unknown";
    totalBytes: number | null;
    availableBytes: number | null;
  }>;
  process: ResourceProcessSnapshot;
}

export interface ResourceCleanupCategoryPreview {
  category: ResourceCleanupCategory;
  status: ResourceAvailability | "incomplete";
  candidates: number;
  estimatedBytes: number;
  protectedFiles: number;
  skippedFiles: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ResourceCleanupPreview {
  previewId: string;
  createdAt: string;
  expiresAt: string;
  categories: ResourceCleanupCategoryPreview[];
  totalCandidates: number;
  totalEstimatedBytes: number;
}

export interface ResourceCleanupCategoryResult {
  category: ResourceCleanupCategory;
  status: ResourceCleanupStatus;
  candidates: number;
  estimatedBytes: number;
  freedBytes: number;
  deletedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ResourceCleanupExecutionReport {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: ResourceCleanupStatus;
  totalFreedBytes: number;
  totalDeletedFiles: number;
  categories: ResourceCleanupCategoryResult[];
}

export const resourceSnapshot = () => invoke<ResourceSnapshot>("resource_snapshot");
/** 只读进程诊断：仅在用户显式请求时调用；后端不结束进程、不读取命令行。 */
export const resourceProcessDiagnostics = () =>
  invoke<ResourceProcessDiagnostics>("resource_process_diagnostics");

/** 应用数据目录的只读占用分布（只扫描应用自有目录，有界、不跟随链接）。 */
export interface ResourceStorageEntry {
  /** 稳定类别 ID（文案按 ID 映射）。 */
  id: string;
  bytes: number;
  files: number;
  kind: "regenerable" | "persistent";
  status: "ready" | "missing" | "partial";
}

export interface ResourceStorageBreakdown {
  sampledAt: string;
  entries: ResourceStorageEntry[];
  totalBytes: number;
  truncated: boolean;
}

/** 应用自身可回收内存缓存（只读目录）。 */
export interface ResourceMemorySource {
  id: string;
  entries: number;
  bytes: number;
  status: "available" | "empty";
}

export interface ResourceMemoryCatalog {
  sampledAt: string;
  sources: ResourceMemorySource[];
  totalBytes: number;
}

export interface ResourceMemoryReleaseReport {
  sampledAt: string;
  releasedBytes: number;
  sources: Array<{ id: string; entries: number; bytes: number }>;
}

export const resourceDiskUsage = () =>
  invoke<ResourceStorageBreakdown>("resource_disk_usage");

/** 只读空间分析：指定目录的直接子目录占用与最大文件（不删除、不写盘）。 */
export interface ResourceDiskScanFolder {
  name: string;
  path: string;
  /** null = 达到上限未扫描；不是 0 B。 */
  bytes: number | null;
  files: number | null;
}

export interface ResourceDiskScanFile {
  name: string;
  path: string;
  bytes: number;
}

export interface ResourceDiskScanReport {
  /** 实际分析的目录（已规范化）。 */
  path: string;
  /** 上一级目录；盘符根为 null。 */
  parent: string | null;
  sampledAt: string;
  totalBytes: number;
  totalFiles: number;
  totalDirs: number;
  /** 扫描根下直接存放的文件（如 pagefile.sys）。 */
  rootFilesBytes: number;
  rootFiles: number;
  /** 未跟随的符号链接 / reparse point。 */
  skippedLinks: number;
  /** 无法读取的目录或项。 */
  skippedErrors: number;
  /** 达到条目/时间/深度上限，结果为已扫描部分。 */
  truncated: boolean;
  elapsedMs: number;
  folders: ResourceDiskScanFolder[];
  files: ResourceDiskScanFile[];
}

export const resourceDiskAnalyze = (path: string) =>
  invoke<ResourceDiskScanReport>("resource_disk_analyze", { path });
export const resourceMemoryCatalog = () =>
  invoke<ResourceMemoryCatalog>("resource_memory_catalog");
/** 释放应用自身可回收缓存；返回每项实际释放量（不做系统级内存优化）。 */
export const resourceMemoryRelease = () =>
  invoke<ResourceMemoryReleaseReport>("resource_memory_release");
export const resourceCleanupPreview = (categories: ResourceCleanupCategory[]) =>
  invoke<ResourceCleanupPreview>("resource_cleanup_preview", { categories });
export const resourceCleanupExecute = (args: {
  previewId: string;
  categories: ResourceCleanupCategory[];
}) => invoke<ResourceCleanupExecutionReport>("resource_cleanup_execute", args);

/**
 * 用户级磁盘垃圾清理：回收站 / 用户临时文件 / Windows 临时文件 / 崩溃转储。
 * 与应用缓存清理相互独立；扫描根由后端从系统环境变量推导，前端不传路径。
 */
export type ResourceJunkCategory =
  | "recycle_bin"
  | "user_temp"
  | "system_temp"
  | "crash_dumps";

export interface ResourceJunkCategoryPreview {
  category: ResourceJunkCategory;
  status: ResourceAvailability;
  /** 文件类为候选文件数；回收站为 Shell 报告的项数。 */
  candidates: number;
  estimatedBytes: number;
  /** 未满保留年龄、被保护的文件数（仅文件类）。 */
  protectedFiles: number;
  skippedFiles: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ResourceJunkPreview {
  previewId: string;
  createdAt: string;
  expiresAt: string;
  /** 临时类候选的最短年龄（小时）。 */
  minimumAgeHours: number;
  categories: ResourceJunkCategoryPreview[];
  totalCandidates: number;
  totalEstimatedBytes: number;
}

export interface ResourceJunkCategoryResult {
  category: ResourceJunkCategory;
  status: ResourceCleanupStatus | "unavailable";
  candidates: number;
  estimatedBytes: number;
  /** 实际释放量：文件类为成功删除文件大小之和；回收站为清空前后统计差。 */
  freedBytes: number;
  deletedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ResourceJunkExecutionReport {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: ResourceCleanupStatus;
  totalFreedBytes: number;
  totalDeletedFiles: number;
  categories: ResourceJunkCategoryResult[];
}

/** 只读扫描用户级垃圾；不删除、不写入。 */
export const resourceJunkPreview = (categories: ResourceJunkCategory[]) =>
  invoke<ResourceJunkPreview>("resource_junk_preview", { categories });
/** 执行已预览的用户级垃圾清理；previewId 一次性消费。 */
export const resourceJunkExecute = (args: {
  previewId: string;
  categories: ResourceJunkCategory[];
}) => invoke<ResourceJunkExecutionReport>("resource_junk_execute", args);

/** 后端音频事件：来自真实 Agent 通知记录 / 任务提醒，eventId 用于去重。 */
export interface AudioEventItem {
  eventId: string;
  kind: string;
  sourceName?: string | null;
  taskTitle?: string | null;
}
export interface AudioEventPayload {
  items: AudioEventItem[];
}
export const onAudioEvent = (cb: (payload: AudioEventPayload) => void): Promise<UnlistenFn> =>
  listen<AudioEventPayload>("audio-event", (e) => cb(e.payload));
export const saveWindowRect = (rect: { x: number; y: number; w: number; h: number }) =>
  invoke<void>("save_window_rect", { rect });
export const getWindowRect = () =>
  invoke<{ x: number; y: number; w: number; h: number } | null>("get_window_rect");
/** 停靠显示器恢复信息（P2-4）：旧记录的这些字段全部缺失，必须保持可选。 */
export interface SnapDisplayInfo {
  name?: string | null;
  bounds?: { x: number; y: number; w: number; h: number };
  workArea?: { x: number; y: number; w: number; h: number };
  scaleFactor?: number;
}
export interface SnapStateExtra {
  /** 沿边中心在显示器可用区内的相对比例（0–1），用于分辨率变化后重算绝对坐标。 */
  centerRatio?: number | null;
  display?: SnapDisplayInfo | null;
  /** 显示形态：`capsule`（轨道/面板）或 `tab`（Edge Tab）；旧记录缺失按胶囊恢复。 */
  form?: "capsule" | "tab" | null;
}
export const saveSnapState = (
  edge: string,
  hidden: boolean,
  center: number | null = null,
  extra: SnapStateExtra = {},
) =>
  invoke<void>("save_snap_state", {
    state: {
      edge,
      hidden,
      center,
      centerRatio: extra.centerRatio ?? null,
      display: extra.display ?? null,
      form: extra.form ?? null,
    },
  });
export const getSnapState = () =>
  invoke<
    | {
        edge: string;
        hidden: boolean;
        center?: number | null;
        centerRatio?: number | null;
        display?: SnapDisplayInfo | null;
        form?: "capsule" | "tab" | null;
      }
    | null
  >("get_snap_state");

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
  /** 是否携带可选用户配置（快捷键/语言/微件布局） */
  config_included?: boolean | null;
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
  /** 是否携带可选用户配置（快捷键/语言/微件布局）；旧备份为 false/缺省。 */
  config_included?: boolean;
}

/** 备份内的单个微件偏好（与 src/lib/widgets/model.ts 的 WidgetItem 同形）。 */
export interface UserWidgetPreference {
  widget_id: string;
  type: string;
  enabled: boolean;
  config: { maxItems?: number };
  size: string;
  sort_order: number;
}

/** 用户偏好镜像（preferences.json）与恢复标记的读取结果。 */
export interface UserPreferencesView {
  version: number;
  locale: string | null;
  widgets: UserWidgetPreference[] | null;
  /** 应用网格手动顺序（含加号伪项）；null = 从未手动排序。 */
  app_grid_order: string[] | null;
  warnings: string[];
  /** true = 刚恢复过配置：前端必须以文件为准覆盖本机 localStorage。 */
  apply_restore: boolean;
  restore_id: string | null;
}

/** 恢复后配置应用摘要（供 UI 提示，不参与成功/失败判定）。 */
export interface RestoreConfigSummary {
  included: boolean;
  locale: string | null;
  widgets: number;
  hotkeys_applied: number;
  hotkeys_disabled: number;
  hotkeys_pending: boolean;
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
  /** None = 备份不含用户配置，本机快捷键/语言/微件保持不变。 */
  config: RestoreConfigSummary | null;
  /** 配置归一化/快捷键注册/偏好写入等非致命问题。 */
  warnings: string[];
}

export const exportData = (path: string) => invoke<string>("export_data", { path });
export const importData = (path: string, allowPartial = false) =>
  invoke<RestoreOutcome>("import_data", { path, allowPartial });
export const inspectBackup = (path: string) => invoke<BackupMeta>("inspect_backup", { path });
export const backupNow = (full = false) => invoke<string>("backup_now", { full });
export const listBackups = () => invoke<BackupEntry[]>("list_backups");

// ── 用户偏好镜像（语言 / 桌面微件布局）──
// 运行时权威仍是 localStorage；这里只做文件镜像与恢复标记对账。
export const getUserPreferences = () =>
  invoke<UserPreferencesView>("get_user_preferences");
export const setUserPreferences = (
  locale: string | null,
  widgets: UserWidgetPreference[] | null,
  appliedRestoreId: string | null = null,
  appGridOrder: string[] | null = null,
) =>
  invoke<UserPreferencesView>("set_user_preferences", {
    locale,
    widgets,
    appGridOrder,
    appliedRestoreId,
  });

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
export type CapsuleRegionMode = "off" | "rail" | "panel" | "tab";

/**
 * 分类胶囊区域（Smart Dock Capsule）：把主窗口的 Win32 区域裁成
 * 轨道（折叠态）或「轨道 ∪ 面板」（展开态），区域外不绘制、不命中鼠标。
 * **窗口位置与尺寸不变**——这是命中区稳定的前提。
 * `seq` 为前端单调序号：原生侧据此丢弃迟到的旧请求，保证最终区域由最新状态决定。
 * `panelWidthCss` 是工具面板当前宽度（280–480）：拖拽改变宽度时窗口不动，
 * 只按新宽度重写面板矩形；缺省时由后端按默认 340 处理。
 * 返回 false 表示应用失败或被乱序保护丢弃（前端按可见性兜底，不得假设胶囊形态生效）。
 */
export const applyWindowCapsule = (
  mode: CapsuleRegionMode,
  edge: string,
  seq: number,
  panelWidthCss?: number,
) => invoke<boolean>("apply_window_capsule", { mode, edge, seq, panelWidthCss });

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
  invoke<ClipboardView>("clipboard_view", {
    // Rust 侧 ClipboardFilter.favorite 为非可选 bool（无 serde default），缺字段会被
    // serde 以「missing field favorite」拒绝；在 IPC 边界统一补齐默认值，
    // 调用方只需传自己关心的字段（轻量列表曾因只传 limit 而长期加载失败）。
    filter: {
      kind: filter?.kind ?? null,
      search: filter?.search ?? null,
      favorite: filter?.favorite ?? false,
      groupId: filter?.groupId ?? null,
      taskId: filter?.taskId ?? null,
      limit: filter?.limit ?? null,
      offset: filter?.offset ?? null,
    },
  });
export const clipboardItem = (itemId: string) =>
  invoke<ClipboardItem>("clipboard_item", { itemId });
export const clipboardGroup = (groupId: string) =>
  invoke<ClipboardGroup>("clipboard_group", { groupId });
/**
 * 有界读取截图组（`clipboard_group_page`，参数 camelCase）：
 * limit 超过后端 `GROUP_PAGE_MAX_LIMIT=50` 会被截断并在响应 `limit` 回传实际值；
 * `imagesOnly` 为 true 时 SQL 阶段只取图片条目。Lite 封面用 limit 1、组预览用 limit 9。
 * 整组复制仍走 `clipboard_copy_group_rich`（完整数据），不要接到本命令上。
 */
export const clipboardGroupPage = (
  groupId: string,
  opts: { limit: number; offset?: number; imagesOnly?: boolean },
) =>
  invoke<ClipboardGroupPage>("clipboard_group_page", {
    groupId,
    limit: opts.limit,
    offset: opts.offset ?? 0,
    imagesOnly: opts.imagesOnly ?? false,
  });
/**
 * 组内条目定位（`clipboard_group_item_position`）：返回条目在组内「图片序列」中的
 * 0-based 序位与组内容版本（revision 与 `clipboard_group_page` 完全一致）。
 * 组不存在时后端返回 NotFound；条目不在组内或不是图片时 `found=false`、`index=null`。
 * Lite 原图预览用它按图片 ID 恢复身份，组内容变化后不静默换成另一张图。
 */
export interface ClipboardGroupItemPosition {
  found: boolean;
  index: number | null;
  imageCount: number;
  totalCount: number;
  revision: string;
}

export const clipboardGroupItemPosition = (groupId: string, itemId: string) =>
  invoke<ClipboardGroupItemPosition>("clipboard_group_item_position", {
    groupId,
    itemId,
  });
export const clipboardStats = () => invoke<ClipboardStats>("clipboard_stats");
export const clipboardThumb = (itemId: string) =>
  invoke<string | null>("clipboard_thumb", { itemId });
export const clipboardImage = (itemId: string) =>
  invoke<string | null>("clipboard_image", { itemId });
/**
 * 图片文字识别：只传已有条目 id，Rust 侧直接读图片缓存，不通过 IPC 传整张图。
 *
 * 同一时刻最多 1 个任务；并发请求返回 `status: "busy"` 而不是排队。
 * `requestId` 用于精准取消（切换条目 / 离开详情），每次请求必须新生成。
 */
export const clipboardOcr = (itemId: string, requestId: string) =>
  invoke<ClipboardOcrReport>("clipboard_ocr", { itemId, requestId });
/** 取消进行中的识别；只匹配同一 requestId，未命中返回 false。 */
export const clipboardOcrCancel = (requestId: string) =>
  invoke<boolean>("clipboard_ocr_cancel", { requestId });
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
 * 后端在阻塞线程池中批量执行（最多 200 条），同时最多 3 个批量任务；超出以
 * `SERVICE_OVERLOADED` 拒绝（不排队）。后台任务异常结束同样以错误拒绝：调用方必须
 * 按「未知」处理，不得把所有路径视为存在；「繁忙」也不得显示成文件丢失，且不得自动
 * 无限重试（当前调用方仅在重新进入详情时再查一次）。
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
/**
 * 目标窗口的真实应用图标（PNG data URL；无图标返回 null）。
 * 后端按当前窗口身份重新解析 exe 路径并提取，前端不能传任意路径。
 */
export const clipboardTargetIcon = (hwnd: number, expectedPid?: number) =>
  invoke<string | null>("clipboard_target_icon", { hwnd, expectedPid });
export const clipboardForegroundTarget = () =>
  invoke<PasteTarget | null>("clipboard_foreground_target");
/** `expectedPid` 是选中窗口时记录的进程号；HWND 复用时会拒绝操作。 */
export const clipboardPastePrecheck = (hwnd: number, expectedPid?: number) =>
  invoke<PasteTarget>("clipboard_paste_precheck", { hwnd, expectedPid });
export const clipboardPasteGroup = (
  groupId: string,
  targetHwnd: number,
  expectedPid?: number,
  itemIds?: string[],
) => invoke<PasteStartReport>("clipboard_paste_group", { groupId, targetHwnd, expectedPid, itemIds });
/** 任意多选逐项粘贴：不依赖永久分组，按传入顺序逐条写入并发送。 */
export const clipboardPasteItems = (targetHwnd: number, expectedPid: number | undefined, itemIds: string[]) =>
  invoke<PasteStartReport>("clipboard_paste_items", { targetHwnd, expectedPid, itemIds });
export const clipboardPasteCancel = (jobId: string) =>
  invoke<void>("clipboard_paste_cancel", { jobId });
export const clipboardPasteResume = (jobId: string, targetHwnd: number, expectedPid?: number) =>
  invoke<PasteStartReport>("clipboard_paste_resume", { jobId, targetHwnd, expectedPid });
/** 跳转到目标窗口：只激活并核实前台，不写剪贴板、不发送按键。失败抛出具体原因。 */
export const clipboardFocusTarget = (hwnd: number, expectedPid?: number) =>
  invoke<PasteTarget>("clipboard_focus_target", { hwnd, expectedPid });
export const clipboardPasteJob = (jobId: string) =>
  invoke<PasteJob>("clipboard_paste_job", { jobId });
export const clipboardPasteActive = () =>
  invoke<string | null>("clipboard_paste_active");
export const clipboardCleanup = () => invoke<CleanupReport>("clipboard_cleanup");
export const clipboardStatus = () => invoke<ClipboardStatus>("clipboard_status");
/** 用户显式修复损坏的剪贴板配置；resume=true 时同时恢复自动记录。 */
export const clipboardRepairConfig = (resume: boolean) =>
  invoke<Settings>("clipboard_repair_config", { resume });
export const clipboardAgentTargets = (refresh = false) =>
  invoke<AgentTargetsSnapshot>("clipboard_agent_targets", { refresh });
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
/** 屏幕矩形（物理像素，虚拟屏幕坐标） */
export interface GeometryRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 捕获的窗口几何：矩形 + 显示器设备名/DPI 元数据（不含 HWND，句柄绝不落库） */
export interface WindowGeometry {
  rect: GeometryRect;
  monitor: string;
  monitor_rect: GeometryRect;
  scale: number;
}

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
  /** 捕获到的窗口几何；缺省 = 无几何数据（旧快照/捕获时最小化），恢复时不摆位 */
  window_geometry?: WindowGeometry;
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

/** 单条目窗口几何恢复状态；缺省 = 无几何数据，UI 不展示几何行 */
export type GeometryRestoreState = "applied" | "converged" | "skipped" | "failed";

export interface RestoreItemResult {
  item_id: string;
  display_name: string;
  item_kind: string;
  outcome: "restored" | "skipped" | "failed" | "cancelled";
  action: string | null;
  verification_level: string;
  fallback_used: boolean;
  reason: string | null;
  /** 窗口几何恢复状态（随原因文案一起反馈） */
  geometry?: GeometryRestoreState;
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

// ── 任务提醒联动（v41）：任务 ↔ 场景 / 工作现场 ──
/** 联动目标类型：workspace=工作现场快照 / scene=场景工作区。 */
export type ReminderLinkKind = "workspace" | "scene";

/** 已解析的联动（后端只返回目标仍存在的条目；label 为目标当前名称）。 */
export interface TaskReminderLink {
  taskId: string;
  targetKind: ReminderLinkKind;
  targetId: string;
  label: string;
  updatedAt: string;
}

/** 一个任务最多一条联动；set 覆盖既有关联，目标已删除时拒绝。 */
export const taskReminderLinkGet = (taskId: string) =>
  invoke<TaskReminderLink | null>("task_reminder_link_get", { taskId });
export const taskReminderLinkSet = (
  taskId: string,
  targetKind: ReminderLinkKind,
  targetId: string,
) => invoke<TaskReminderLink>("task_reminder_link_set", { taskId, kind: targetKind, targetId });
export const taskReminderLinkClear = (taskId: string) =>
  invoke<void>("task_reminder_link_clear", { taskId });

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
/** 打开快速捕获窗口（已打开时只聚焦，不切换为隐藏）。 */
export interface QuickCaptureShowResult {
  visible: boolean;
  focused: boolean;
  /** 窗口已显示但系统前台锁拒绝聚焦时的原因；不是打开失败。 */
  focusError: string | null;
}
export const quickCaptureShow = () =>
  invoke<QuickCaptureShowResult>("quick_capture_show");
/**
 * 隐藏捕获窗口并恢复原前台焦点（后端实现）。
 * 后端命令为零参数（`quick_capture_hide()`），不传任何参数；
 * reason 仅用于前端语义标注（用户关闭 / 保存成功），不会发给后端。
 */
export const quickCaptureHide = (_reason?: "user" | "success") =>
  invoke<void>("quick_capture_hide");

/** 语音输入启动结果：language 是实际使用的识别语言（BCP-47，回退时为系统语音语言）。 */
export interface CaptureVoiceStartResult {
  language: string;
}

export const quickCaptureVoiceStart = () =>
  invoke<CaptureVoiceStartResult>("quick_capture_voice_start");
/**
 * 停止听写并释放麦克风；返回停止瞬间才定稿的片段
 * （WinRT StopAsync 会补发待定结果；未启动过时为空数组）。
 */
export const quickCaptureVoiceStop = () => invoke<string[]>("quick_capture_voice_stop");
/** 打开 Windows「语音」隐私设置（在线语音识别未开启时的一步恢复入口）。 */
export const quickCaptureOpenSpeechSettings = () =>
  invoke<void>("quick_capture_open_speech_settings");

// ── 事件订阅 ──
/**
 * 后端批量聚合后的 Agent 变化事件（一批一次，不随事件数量线性增长）。
 * 正常批量事件与 stale 清理事件（`stale_cleanup`）共用同一契约：
 * `sources` 为受影响来源列表，缺失 `sources` 时按 `source_id` 兜底，
 * 两者均缺失时视为全局刷新（空 `sources`）。
 */
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
  stale_cleanup?: number;
}

/**
 * 归一化 agent-changed 载荷（运行时校验，不依赖 TS 断言）。
 * - 非对象 / null / 数组 / `sources` 或 `source_id` 类型非法 → 返回 null（调用方应忽略，
 *   不抛 TypeError、不刷新）。
 * - 缺少可选字段（`states`、`batch`、`changed` 等）→ 补默认值，仍视为合法事件。
 * - 缺少 `sources` 但有 `source_id` → `sources=[source_id]`。
 * - 仅有 `stale_cleanup` 的旧载荷 → 规范为全局事件（`sources=[]`、`changed=true`），
 *   由所有历史分区与实时摘要刷新消费，不误报为任务成功/失败。
 */
export function normalizeAgentChangedPayload(
  payload: unknown,
): AgentChangedEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const hasSignal =
    "changed" in raw ||
    "stale_cleanup" in raw ||
    "states" in raw ||
    "sources" in raw ||
    "source_id" in raw ||
    "session_id" in raw;
  if (!hasSignal) return null;
  if (
    "sources" in raw &&
    raw.sources !== undefined &&
    !Array.isArray(raw.sources)
  ) {
    return null;
  }
  if (
    "source_id" in raw &&
    raw.source_id !== undefined &&
    typeof raw.source_id !== "string"
  ) {
    return null;
  }
  if (
    "session_id" in raw &&
    raw.session_id !== undefined &&
    typeof raw.session_id !== "string"
  ) {
    return null;
  }
  if (
    "states" in raw &&
    raw.states !== undefined &&
    (typeof raw.states !== "object" || raw.states === null || Array.isArray(raw.states))
  ) {
    return null;
  }
  if (
    "stale_cleanup" in raw &&
    raw.stale_cleanup !== undefined &&
    typeof raw.stale_cleanup !== "number"
  ) {
    return null;
  }
  const sources: string[] = Array.isArray(raw.sources)
    ? (raw.sources as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : typeof raw.source_id === "string" && raw.source_id
      ? [raw.source_id]
      : [];
  const sourceId =
    typeof raw.source_id === "string" && raw.source_id
      ? raw.source_id
      : (sources[0] ?? "");
  const states: Record<string, number> = {};
  if (raw.states && typeof raw.states === "object" && !Array.isArray(raw.states)) {
    for (const [k, v] of Object.entries(raw.states as Record<string, unknown>)) {
      if (typeof v === "number") states[k] = v;
    }
  }
  const staleCleanup =
    typeof raw.stale_cleanup === "number" ? raw.stale_cleanup : undefined;
  const batch =
    typeof raw.batch === "number"
      ? raw.batch
      : (staleCleanup ?? sources.length);
  return {
    source_id: sourceId,
    sources,
    session_id: typeof raw.session_id === "string" ? raw.session_id : "",
    run_id:
      typeof raw.run_id === "string" || raw.run_id === null
        ? (raw.run_id as string | null)
        : null,
    state: typeof raw.state === "string" ? raw.state : null,
    states,
    batch,
    changed: raw.changed === false ? false : true,
    deduplicated: raw.deduplicated === true,
    late: raw.late === true,
    ...(staleCleanup !== undefined ? { stale_cleanup: staleCleanup } : {}),
  };
}
export const onAgentChanged = (cb: (payload: AgentChangedEvent) => void): Promise<UnlistenFn> =>
  listen<unknown>("agent-changed", (e) => {
    const normalized = normalizeAgentChangedPayload(e.payload);
    if (normalized) cb(normalized);
  });
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
/** 右键菜单切换「边缘吸附方式」后广播：capsule | full（主窗口据此原地切换形态）。 */
export const onSnapFormChanged = (cb: (form: string) => void): Promise<UnlistenFn> =>
  listen<string>("snap-form-changed", (e) => cb(e.payload));
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

/** 语音事件载荷：识别正文只走事件，不进日志。 */
export interface CaptureVoiceText {
  text: string;
}

/** 语音会话状态：idle = 自然结束/静音超时；error = 需要用户处理。 */
export interface CaptureVoiceStatus {
  status: "idle" | "error";
  code: string;
  message: string | null;
}

/** 临时识别结果（实时字幕，会被下一帧替换，不写入正文）。 */
export const onCaptureVoicePartial = (
  cb: (payload: CaptureVoiceText) => void,
): Promise<UnlistenFn> =>
  listen<CaptureVoiceText>("capture-voice-partial", (e) => cb(e.payload));
/** 定稿片段（前端追加进正文，草稿防抖负责落盘）。 */
export const onCaptureVoiceFinal = (
  cb: (payload: CaptureVoiceText) => void,
): Promise<UnlistenFn> =>
  listen<CaptureVoiceText>("capture-voice-final", (e) => cb(e.payload));
export const onCaptureVoiceStatus = (
  cb: (payload: CaptureVoiceStatus) => void,
): Promise<UnlistenFn> =>
  listen<CaptureVoiceStatus>("capture-voice-status", (e) => cb(e.payload));

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
  /** 乐观并发版本（v37）：MCP 写工具强制校验；UI 路径可选传入 */
  revision?: number;
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
  /** 乐观并发（v37）：传入时后端校验，不匹配返回冲突 */
  expected_revision?: number;
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
  /** 乐观并发版本（v37）：MCP 写工具强制校验 */
  revision?: number;
  steps: PlanningStep[];
  /** 0 = 未拆分步骤（不产出百分比，UI 如实显示） */
  step_total: number;
  step_done: number;
}

/** 用户规划功能与 Agent 会话的真实关联；Agent 当前状态仅在 session 可匹配时提供。 */
export interface PlanningAgentFeatureLink {
  id: string;
  feature_id: string;
  feature_title: string;
  project_id: string;
  project_name: string;
  agent_source: string;
  agent_name: string | null;
  session_id: string;
  status: "linked" | "unlinked";
  agent_status: string | null;
  agent_session_id: string | null;
  last_seen_at: string | null;
  last_execution_at: string | null;
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
  /** 乐观并发（v37）：传入时后端校验，不匹配返回冲突 */
  expected_revision?: number;
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
  /** 乐观并发（v37）：校验所属功能的 revision */
  expected_revision?: number;
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
export const planningListFeatureAgentLinks = (featureId: string) =>
  invoke<PlanningAgentFeatureLink[]>("planning_list_feature_agent_links", { featureId });
export const planningListAgentFeatureLinks = (agentSource: string, sessionId: string) =>
  invoke<PlanningAgentFeatureLink[]>("planning_list_agent_feature_links", { agentSource, sessionId });
export const planningUnlinkAgentSession = (
  featureId: string,
  agentSource: string,
  sessionId: string,
) => invoke<void>("planning_unlink_agent_session", { featureId, agentSource, sessionId });
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

// ── Agent MCP Server（v37）：外部 MCP 客户端经 loopback bridge 读写规划中心 ──
// 管理命令只暴露元数据；agent token 明文只在 mcp_agent_create 返回值出现一次，
// 前端必须提示用户立即保存，库内只存 SHA-256。

export type McpAgentScope = "disabled" | "readonly" | "project_rw";
export type McpConfigClient = "claude-code" | "codex" | "cursor" | "trae" | "generic";

export interface McpAgentInfo {
  /** mcp_agents 行 id（UUID），set_scope/grant/revoke 用它 */
  id: string;
  agent_id: string;
  display_name: string;
  scope: McpAgentScope;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  granted_project_ids: string[];
}

export interface McpStatus {
  /** 设置开关（mcp_server_enabled） */
  enabled: boolean;
  /** bridge 是否在监听 */
  running: boolean;
  port: number | null;
  agent_count: number;
  started_at: string | null;
}

/** mcp_agent_create 返回：token 明文仅此一次。 */
export interface McpAgentCreated extends McpAgentInfo {
  token: string;
}

export interface McpAuditSummary {
  agentId: string;
  displayName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  success: boolean;
  authorized: boolean;
  errorCategory: "authorization_denied" | "operation_failed" | null;
}

export interface McpAuditPage {
  items: McpAuditSummary[];
  total: number;
  offset: number;
  limit: number;
}

export const agentMcpStatus = () => invoke<McpStatus>("mcp_status", {});
export const agentMcpList = () => invoke<McpAgentInfo[]>("mcp_agent_list", {});
export const agentMcpCreate = (agentId: string, displayName: string) =>
  invoke<McpAgentCreated>("mcp_agent_create", { agentId, displayName });
export const agentMcpRotateToken = (id: string) =>
  invoke<McpAgentCreated>("mcp_agent_rotate_token", { id });
export const agentMcpSetScope = (id: string, scope: McpAgentScope) =>
  invoke<McpAgentInfo>("mcp_agent_set_scope", { id, scope });
export const agentMcpGrantProject = (id: string, projectId: string) =>
  invoke<McpAgentInfo>("mcp_agent_grant_project", { id, projectId });
export const agentMcpRevokeProject = (id: string, projectId: string) =>
  invoke<McpAgentInfo>("mcp_agent_revoke_project", { id, projectId });
export const agentMcpRevoke = (id: string) => invoke<McpAgentInfo>("mcp_agent_revoke", { id });
export const agentMcpAuditList = (offset: number, limit: number) =>
  invoke<McpAuditPage>("mcp_audit_list", { offset, limit });
export const agentMcpConfigSnippet = (client: McpConfigClient, agentToken: string) =>
  invoke<string>("mcp_config_snippet", { input: { client, agentToken } });

/** MCP 写入成功后主进程广播（v37）：payload camelCase。 */
export interface PlanningChangedEvent {
  kind: "project" | "feature" | "step" | "milestone" | "activity";
  projectId?: string;
  featureId?: string;
  revision?: number;
}

export const onPlanningChanged = (
  cb: (payload: PlanningChangedEvent) => void,
): Promise<UnlistenFn> =>
  listen<PlanningChangedEvent>("planning-changed", (e) => cb(e.payload));

// ── 场景工作区（v0.11，迁移 v38）：可重复进入的预设工作环境 ──
// 主 Agent 预置契约（Subagent C 按此实现 scenario_* 命令；字段全部 camelCase）。

/** 场景内的应用目标：优先引用已登记导航目标，否则用 exe 路径直启。 */
export interface ScenarioAppTarget {
  targetId?: string;
  exePath?: string;
  args?: string;
  displayName?: string;
}

/** 场景摘要（列表用）。 */
export interface ScenarioSummary {
  id: string;
  name: string;
  icon: string | null;
  appCount: number;
  urlCount: number;
  folderCount: number;
  linkedWorkflowId: string | null;
  lastEnteredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 场景详情（编辑 / 进入前确认用）。 */
export interface ScenarioDetail extends ScenarioSummary {
  apps: ScenarioAppTarget[];
  urls: string[];
  folders: string[];
  snapshotId: string | null;
  /** 暂存架文件/文件夹的稳定条目 ID；不保存或回传文件路径。 */
  shelfItemIds: string[];
}

/** 场景保存载荷：id 为空表示新建；name 必填。 */
export interface ScenarioSaveInput {
  id?: string;
  name: string;
  icon?: string | null;
  apps: ScenarioAppTarget[];
  urls: string[];
  folders: string[];
  linkedWorkflowId?: string | null;
  snapshotId?: string | null;
  /** 整体替换当前场景关联的暂存架文件/文件夹 ID。 */
  shelfItemIds?: string[];
}

/** 一键进入的逐项结果：单失败不阻断，缺失降级 skipped。 */
export interface ScenarioEnterItemResult {
  kind: "app" | "url" | "folder" | "snapshot" | "workflow";
  label: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

export interface ScenarioEnterResult {
  items: ScenarioEnterItemResult[];
  startedAt: string;
  /** 计划项总数（含未执行的剩余项）；items 只包含已处理项。 */
  total: number;
  /** 因用户取消提前停止；已启动的应用/网页/目录/工作流/现场恢复不回滚。 */
  cancelled: boolean;
  /** 超过整体预算（120s）提前停止；已启动项不回滚。 */
  timedOut: boolean;
}

export const scenarioList = () => invoke<ScenarioSummary[]>("scenario_list", {});
export const scenarioGet = (id: string) => invoke<ScenarioDetail>("scenario_get", { id });
export const scenarioSave = (input: ScenarioSaveInput) =>
  invoke<{ id: string }>("scenario_save", { input });
export const scenarioDelete = (id: string) => invoke<void>("scenario_delete", { id });
export const scenarioDuplicate = (id: string) =>
  invoke<{ id: string }>("scenario_duplicate", { id });
export const scenarioEnter = (id: string) => invoke<ScenarioEnterResult>("scenario_enter", { id });
/** 请求取消在途进入：幂等，未在途返回 false；取消只在项间生效。 */
export const scenarioEnterCancel = (id: string) =>
  invoke<boolean>("scenario_enter_cancel", { id });

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
  /** 稳定错误码（后端 `AppError::code`）；旧后端/未知类型时缺省。 */
  code?: string | null;
  /** 稳定错误分类（后端 `AppError::category`）；旧后端时缺省。 */
  category?: string | null;
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
  temporary_files_skipped: number;
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
  /** default = 置顶优先（完整暂存架）；recent = 纯创建时间倒序（胶囊最近暂存） */
  sort?: "default" | "recent";
}) =>
  invoke<ShelfPage>("shelf_list", {
    search: opts?.search ?? null,
    kind: opts?.kind ?? "all",
    groupId: opts?.group_id ?? "all",
    favoriteOnly: opts?.favorite_only ?? false,
    limit: opts?.limit ?? 100,
    offset: opts?.offset ?? 0,
    sort: opts?.sort ?? null,
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

/** 单条全量读取（含 content）：列表载荷不带大文本。 */
export const shelfGetItem = (id: string) => invoke<ShelfItem>("shelf_get_item", { id });

export const shelfUpdate = (id: string, patch: ShelfUpdatePatch) =>
  invoke<ShelfItem>("shelf_update", { id, patch });

/** 删除条目：托管副本一并删除；引用模式绝不触碰原文件。收藏/置顶/场景引用需显式确认。 */
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

/** 复制路径（文本）/ 复制文件（CF_HDROP，资源管理器可直接粘贴）——拖出的键盘/回退通道。 */
export const shelfCopyPaths = (ids: string[]) => invoke<number>("shelf_copy_paths", { ids });
export const shelfCopyFiles = (ids: string[]) => invoke<number>("shelf_copy_files", { ids });

/** 系统级拖出结果：effect 为目标应用实际接受的放置效果。 */
export interface ShelfDragOutResult {
  effect: "copy" | "move" | "none";
  count: number;
  /** move 后目标应用已搬走的源条目。 */
  missing_ids: string[];
}

/**
 * 从暂存架卡片发起 Windows 原生拖出（OLE DoDragDrop）。
 * 必须在 pointerdown 后、左键仍按下时调用；路径由后端按 id 解析，前端不传路径。
 */
export const shelfDragOut = (ids: string[]) =>
  invoke<ShelfDragOutResult>("shelf_drag_out", { ids });

export const shelfTaskLinks = (itemId: string) =>
  invoke<ShelfTaskLink[]>("shelf_task_links", { itemId });

export const shelfLinkTask = (itemId: string, taskId: string) =>
  invoke<void>("shelf_link_task", { itemId, taskId });

// ── 文件操作：移动 / 复制 / 失效重定位 / 最近目标目录 ──────────

export type ShelfConflictStrategy = "skip" | "rename";

export interface ShelfOpEntry {
  id: string;
  display_name: string;
  source: string | null;
  target: string | null;
  /** partial：目标已完整写入，但源清理或记录更新未完成 */
  status: "ok" | "skipped" | "failed" | "partial";
  reason: string | null;
  /** 部分完成时建议的恢复动作 */
  recovery?: string | null;
  /** 部分完成时仍残留的源路径 */
  residual_source?: string | null;
}

export interface ShelfOpReport {
  success: number;
  skipped: number;
  failed: number;
  /** 文件操作成功但源清理/记录更新未完成的数量 */
  partial?: number;
  /** 按用户选择从暂存架移除的记录数 */
  removed: number;
  /** 托管文件删除失败数；后端结果模型演进期按 0 兜底 */
  remove_failed_files?: number;
  /** 文件操作成功但移除暂存记录失败的数量 */
  record_cleanup_failed?: number;
  /** 记录清理失败的原因摘要 */
  record_cleanup_error?: string | null;
  /** 逐项结果；缺失时按空列表兜底，面板仍展示汇总 */
  entries?: ShelfOpEntry[];
}

export interface ShelfRecentDir {
  path: string;
  pinned: boolean;
  last_used_at: string;
  available: boolean;
}

/**
 * 移动原文件/文件夹到目标目录。
 * - 默认不覆盖同名：skip=跳过，rename=`名称 (1).ext`；
 * - managed / link / text 由后端明确拒绝；
 * - removeAfter=true 只移除成功处理的暂存记录，不删除已移动的目标文件。
 */
export const shelfMoveItems = (
  ids: string[],
  targetDir: string,
  conflictStrategy: ShelfConflictStrategy = "skip",
  removeAfter = false,
) =>
  invoke<ShelfOpReport>("shelf_move_items", {
    ids,
    targetDir,
    conflictStrategy,
    removeAfter,
  });

/** 复制到目录（托管条目为导出副本），源文件始终保留。 */
export const shelfCopyTo = (
  ids: string[],
  targetDir: string,
  conflictStrategy: ShelfConflictStrategy = "skip",
  removeAfter = false,
) =>
  invoke<ShelfOpReport>("shelf_copy_to", {
    ids,
    targetDir,
    conflictStrategy,
    removeAfter,
  });

/** 失效引用条目重新指向外部文件/文件夹；托管条目拒绝。 */
export const shelfRelocateItem = (id: string, path: string) =>
  invoke<ShelfItem>("shelf_relocate_item", { id, path });

/** 最近目标目录（最多 8 个，按固定 + 最近成功使用排序）。 */
export const shelfRecentDirs = () => invoke<ShelfRecentDir[]>("shelf_recent_dirs");

export const shelfRecentDirPin = (path: string, pinned: boolean) =>
  invoke<void>("shelf_recent_dir_pin", { path, pinned });

export const shelfRecentDirRemove = (path: string) =>
  invoke<void>("shelf_recent_dir_remove", { path });

// ── 快捷投递目标（收集箱「文件投递」子页） ──────────────────
//
// 与 `ShelfRecentDir` 的区别：那是文件操作面板的自动「最近使用」记录（路径主键、
// 最多 8 条、无别名）；这里是用户命名的固定入口（别名、排序、工具面板显示开关、
// 默认操作模式）。两者共享同一套路径校验，但存储与语义独立。

/** copy=复制（默认，保留源文件）；move=移动（删除源文件，有更严格的安全流程）。 */
export type DropTargetOpMode = "copy" | "move";

export interface ShelfDropTarget {
  id: string;
  name: string;
  path: string;
  sort_order: number;
  /** 是否出现在工具面板（胶囊）「文件投递」子页 */
  show_in_capsule: boolean;
  op_mode: DropTargetOpMode;
  conflict: ShelfConflictStrategy;
  /** 读取时探测的目录可用性；false 时前端禁止投递 */
  available: boolean;
  created_at: string;
  updated_at: string;
}

export interface ShelfDropTargetPatch {
  name?: string;
  path?: string;
  show_in_capsule?: boolean;
  op_mode?: DropTargetOpMode;
  conflict?: ShelfConflictStrategy;
}

export interface ShelfDropEntry {
  source: string;
  display_name: string;
  target?: string | null;
  /** ok / skipped / failed / partial */
  status: "ok" | "skipped" | "failed" | "partial";
  reason?: string | null;
  recovery?: string | null;
  residual_source?: string | null;
  /** 稳定失败分类（诊断聚合用），如 SHELF_DROP_DB_SCHEMA_INCOMPATIBLE */
  code?: string | null;
  /** 失败阶段：prepare/resolve/journal/commit/copy/cleanup/rewrite */
  stage?: string | null;
}

export interface ShelfDropReport {
  batch_id: string;
  target_id: string;
  target_path: string;
  op: DropTargetOpMode;
  total: number;
  success: number;
  skipped: number;
  failed: number;
  partial: number;
  /** 逐项结果；缺失时按空列表兜底（与 ShelfOpReport 同口径） */
  entries?: ShelfDropEntry[];
}

/** 投递目标列表（每次读取都会探测目录可用性，不做后台轮询）。 */
export const shelfDropTargets = () => invoke<ShelfDropTarget[]>("shelf_drop_targets_list");

export const shelfDropTargetCreate = (input: {
  name?: string;
  path: string;
  showInCapsule?: boolean;
  opMode?: DropTargetOpMode;
  conflict?: ShelfConflictStrategy;
}) =>
  invoke<ShelfDropTarget>("shelf_drop_target_create", {
    name: input.name ?? null,
    path: input.path,
    showInCapsule: input.showInCapsule ?? null,
    opMode: input.opMode ?? null,
    conflict: input.conflict ?? null,
  });

export const shelfDropTargetUpdate = (id: string, patch: ShelfDropTargetPatch) =>
  invoke<ShelfDropTarget>("shelf_drop_target_update", { id, patch });

/** 只删除配置行；真实目录与其内容不受影响。 */
export const shelfDropTargetDelete = (id: string) =>
  invoke<void>("shelf_drop_target_delete", { id });

export const shelfDropTargetMove = (id: string, direction: "up" | "down") =>
  invoke<ShelfDropTarget[]>("shelf_drop_target_move", { id, direction });

export const shelfDropTargetOpen = (id: string) =>
  invoke<void>("shelf_drop_target_open", { id });

/**
 * 把拖入的路径直接投递到目标目录。
 * - 目标按 id 由后端解析，前端不传目录字符串；
 * - 单条失败不影响其他条目，结果逐条返回；
 * - `batchId` 只用于操作日志归属（崩溃恢复区分批次）。
 */
export const shelfDropToDirectory = (
  targetId: string,
  paths: string[],
  batchId: string,
) =>
  invoke<ShelfDropReport>("shelf_drop_to_directory", {
    targetId,
    paths,
    batchId,
  });


export const shelfRecentDirsClear = () => invoke<void>("shelf_recent_dirs_clear");

// ── 一键工作流（v0.9）：白名单动作编排、顺序执行、暂停 / 取消与运行历史 ──

export type WorkflowStepType =
  | "open_app"
  | "open_url"
  | "open_path"
  | "create_task"
  | "enter_scene"
  | "restore_workspace";

export type WorkflowOnError = "stop" | "continue";

/** 运行步骤回执状态（pending → running → 终态；skipped = 步骤停用）。 */
export type WorkflowRunStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "cancelled";

/** 运行稳定态。pausing/cancelling 过渡态只出现在事件流（activeRun 概览），不落库。 */
export type WorkflowRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WorkflowStepParams {
  target_id?: string;
  title?: string;
  description?: string;
  priority?: number;
  remind_at?: string | null;
  advance_minutes?: number;
  snapshot_id?: string;
  scene_id?: string;
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  step_type: WorkflowStepType;
  params: WorkflowStepParams;
  display_order: number;
  enabled: boolean;
  on_error: WorkflowOnError;
  created_at: string;
  updated_at: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  sort_order: number;
  step_count: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

export interface WorkflowStepInput {
  /** 前端生成的稳定 ID；新建步骤传空串由后端生成。 */
  id: string;
  step_type: WorkflowStepType;
  params: WorkflowStepParams;
  enabled: boolean;
  on_error: WorkflowOnError;
}

export interface WorkflowInput {
  name: string;
  description?: string;
  steps?: WorkflowStepInput[];
}

export interface WorkflowPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
}

export interface WorkflowDetail extends Workflow {
  steps: WorkflowStep[];
}

export interface WorkflowRunStep {
  id: string;
  run_id: string;
  step_id: string;
  step_type: WorkflowStepType;
  display_order: number;
  status: WorkflowRunStepStatus;
  detail: string;
  result: string | null;
  started_at: string | null;
  finished_at: string | null;
  operation_id: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  current_step_index: number;
  total_steps: number;
  completed_steps: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface WorkflowRunDetail extends WorkflowRun {
  steps: WorkflowRunStep[];
}

export interface WorkflowRunPage {
  items: WorkflowRun[];
  total: number;
  limit: number;
  offset: number;
}

/** 当前活动运行概览（全局单槽；UI 据此显示「执行中」并启用暂停 / 取消）。 */
export interface WorkflowActiveRun {
  run_id: string;
  workflow_id: string;
  paused: boolean;
  cancel_requested: boolean;
}

export interface WorkflowLastRunSummary {
  run_id: string;
  status: WorkflowRunStatus;
  total_steps: number;
  completed_steps: number;
  error: string | null;
  started_at: string;
  started_at_local: string;
  finished_at: string | null;
}

export const workflowList = () => invoke<Workflow[]>("workflow_list");
export const workflowGet = (id: string) => invoke<WorkflowDetail>("workflow_get", { id });
export const workflowCreate = (input: WorkflowInput) =>
  invoke<WorkflowDetail>("workflow_create", { input });
export const workflowUpdate = (id: string, patch: WorkflowPatch) =>
  invoke<WorkflowDetail>("workflow_update", { id, patch });
export const workflowDelete = (id: string) => invoke<void>("workflow_delete", { id });
export const workflowDuplicate = (id: string) =>
  invoke<WorkflowDetail>("workflow_duplicate", { id });
export const workflowReorder = (orderedIds: string[]) =>
  invoke<void>("workflow_reorder", { orderedIds });
/** 整表替换步骤编排（原子事务；增删改排序共用）。 */
export const workflowReplaceSteps = (id: string, steps: WorkflowStepInput[]) =>
  invoke<WorkflowDetail>("workflow_replace_steps", { id, steps });
/** 编辑保存：名称 / 描述 / 步骤在单事务内写入，避免半保存。 */
export const workflowSave = (
  id: string,
  name: string,
  description: string,
  steps: WorkflowStepInput[],
) => invoke<WorkflowDetail>("workflow_save", { id, name, description, steps });

export const workflowRun = (id: string) => invoke<WorkflowRunDetail>("workflow_run", { id });
export const workflowPause = (id: string) => invoke<WorkflowRunDetail>("workflow_pause", { id });
export const workflowResume = (id: string) => invoke<WorkflowRunDetail>("workflow_resume", { id });
export const workflowCancel = (id: string) => invoke<WorkflowRunDetail>("workflow_cancel", { id });
export const workflowActive = () => invoke<WorkflowActiveRun | null>("workflow_active");

export const workflowRunDetail = (runId: string) =>
  invoke<WorkflowRunDetail>("workflow_run_detail", { runId });
export const workflowLastRun = (id: string) =>
  invoke<WorkflowRunDetail | null>("workflow_last_run", { id });
export const workflowLastRunSummary = (id: string) =>
  invoke<WorkflowLastRunSummary | null>("workflow_last_run_summary", { id });
export const workflowListRuns = (id: string, limit?: number, offset?: number) =>
  invoke<WorkflowRunPage>("workflow_list_runs", { id, limit: limit ?? 20, offset: offset ?? 0 });

/** 运行进度推送：payload 为完整运行详情（运行头 + 全部步骤回执）。 */
export const onWorkflowRunProgress = (cb: (payload: WorkflowRunDetail) => void): Promise<UnlistenFn> =>
  listen<WorkflowRunDetail>("workflow-run-progress", (e) => cb(e.payload));

/** 步骤类型的中文标签（与后端 StepType::label 对齐）。 */
export const WORKFLOW_STEP_TYPE_LABELS: Record<WorkflowStepType, string> = {
  open_app: "打开应用 / 激活窗口",
  open_url: "打开网页",
  open_path: "打开文件或目录",
  create_task: "创建任务",
  enter_scene: "进入场景",
  restore_workspace: "恢复工作现场",
};

/** 运行状态的中文标签。 */
export const WORKFLOW_RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** 步骤回执状态的中文标签。 */
export const WORKFLOW_STEP_STATUS_LABELS: Record<WorkflowRunStepStatus, string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已取消",
};

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

// ── 诊断日志（本机持久化 / 查询 / 摘要 / 导出 / 清理）──────────────
//
// 事件体字段使用 snake_case：这是落盘 JSONL 的稳定契约，和 `Task` 等后端载荷一致。
// 查询参数使用 camelCase（项目 IPC 参数规范）。

export type DiagnosticLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
export type DiagnosticStatusValue =
  | "started"
  | "success"
  | "failed"
  | "cancelled"
  | "recovered";

export interface DiagnosticEventRecord {
  timestamp: string;
  level: DiagnosticLevel;
  module: string;
  action: string;
  event: string;
  session_id: string;
  operation_id?: string;
  window_id?: string;
  component?: string;
  stage?: string;
  status?: DiagnosticStatusValue;
  error_code?: string;
  error_category?: string;
  duration_ms?: number;
  retry_count?: number;
  message?: string;
  metadata?: Record<string, unknown>;
  source: "rust" | "frontend" | "system";
  /** 本行代表的重复次数（聚合摘要行 > 1）。 */
  count: number;
}

export interface DiagnosticQuery {
  levels?: DiagnosticLevel[];
  modules?: string[];
  errorCodes?: string[];
  statuses?: DiagnosticStatusValue[];
  windowIds?: string[];
  operationId?: string;
  text?: string;
  /** RFC3339（含时区） */
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  /** 只统计 WARN 及以上（摘要/导出默认视图） */
  anomaliesOnly?: boolean;
}

export interface DiagnosticPage {
  items: DiagnosticEventRecord[];
  matched: number;
  scanned: number;
  truncated: boolean;
  files: number;
  skipped: number;
}

export interface DiagnosticCountItem {
  key: string;
  count: number;
}

export interface DiagnosticSummaryGroup {
  module: string;
  action: string;
  errorCode?: string;
  level: DiagnosticLevel;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastStatus?: DiagnosticStatusValue;
  recovered: boolean;
  sampleMessage?: string;
  sampleOperationId?: string;
}

export interface DiagnosticSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  groups: DiagnosticSummaryGroup[];
  byModule: DiagnosticCountItem[];
  byCode: DiagnosticCountItem[];
  truncated: boolean;
  scanned: number;
  skipped: number;
  files: number;
  generatedAt: string;
  since?: string;
  until?: string;
}

export interface DiagnosticLogFile {
  name: string;
  bytes: number;
  modifiedAt?: string;
  active: boolean;
}

export interface DiagnosticsStatus {
  sessionId: string;
  startedAt: string;
  logDir: string;
  mode: "normal" | "verbose";
  verboseRemainingMs: number;
  files: DiagnosticLogFile[];
  totalBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxArchiveFiles: number;
  written: number;
  dropped: number;
  queueFull: number;
  aggregated: number;
  rotations: number;
  failures: number;
  skippedLines: number;
  degraded: boolean;
  lastError?: string;
}

export interface DiagnosticExportResult {
  path: string;
  bytes: number;
  records: number;
  /** 扫描/条数上限截断：报告只包含部分事件 */
  truncated: boolean;
  /** 导出前是否确认刷盘成功（false = 可能有更新的日志未进入报告） */
  flushed: boolean;
  /** 刷盘降级原因：`timeout` / `queue_full` / `not_flushed`；正常为 undefined */
  flushIssue?: string;
  /** 报告内容是否完整可信（flushed && !truncated） */
  complete: boolean;
}

export const diagnosticsStatus = () => invoke<DiagnosticsStatus>("diagnostics_status");

export const diagnosticsSetMode = (mode: "normal" | "verbose", minutes?: number) =>
  invoke<DiagnosticsStatus>("diagnostics_set_mode", { mode, minutes });

export const diagnosticsQuery = (filter: DiagnosticQuery = {}) =>
  invoke<DiagnosticPage>("diagnostics_query", { filter });

export const diagnosticsSummary = (filter: DiagnosticQuery = {}) =>
  invoke<DiagnosticSummary>("diagnostics_summary", { filter });

export const diagnosticsExport = (filter: DiagnosticQuery = {}) =>
  invoke<DiagnosticExportResult>("diagnostics_export", { filter });

export interface DiagnosticClearResult {
  removedBytes: number;
  /** 是否真正执行完成；false = 超时/取消，日志未被删除 */
  completed: boolean;
  status: DiagnosticsStatus;
}

export const diagnosticsClear = () =>
  invoke<DiagnosticClearResult>("diagnostics_clear");

export const diagnosticsOpenDir = () => invoke<void>("diagnostics_open_dir");

// ── 功能生命周期（只读批量快照）────────────────────────────────
//
// 用户意图仍由 SQLite 设置键承载；这里只读取「实际运行状态」，用于模块页
// 标题按钮与资源管理「功能运行」分区。状态查询不注册轮询，只在需要时调用。

export type LifecycleState =
  | "running"
  | "pausing"
  | "stopping"
  | "paused"
  | "stopped"
  | "idle"
  | "error"
  | "unsupported";

export type LifecycleCategory = "resident" | "task" | "ondemand" | "shared";

export interface ModuleRuntimeStatus {
  id: string;
  category: LifecycleCategory;
  state: LifecycleState;
  intent: "running" | "paused" | "stopped";
  controllable: boolean;
  /** 实际存在的后台活动标记（如 clipboard-monitor / shelf-auto-cleanup） */
  background: string[];
  detail: Record<string, unknown>;
  error: string | null;
}

export const lifecycleStatus = () =>
  invoke<ModuleRuntimeStatus[]>("lifecycle_status");

// ── 手机配对与局域网连接（v0.16）────────────────────────────────
//
// 桌面端是配对授权中心：二维码/6 位码只在用户点击「配对新设备」后生成，
// 120 秒过期；令牌只在配对成功响应里返回一次（由手机端保存），桌面端只存哈希。
// 这些类型与 Rust `mobile_sync` 的 snake_case 返回值一一对应。

export interface MobileSyncPairingStatus {
  code: string;
  expires_in_secs: number;
}

export interface MobileSyncPairedNotice {
  device_id: string;
  name: string;
  platform: string;
  paired_at: string;
}

export interface MobileDevice {
  id: string;
  name: string;
  platform: string;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  revoked_at: string | null;
}

export interface MobileSyncStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  lan_ip: string | null;
  base_url: string | null;
  server_name: string;
  instance_id: string;
  fingerprint: string;
  error: string | null;
  pairing: MobileSyncPairingStatus | null;
  paired_device: MobileSyncPairedNotice | null;
  devices: MobileDevice[];
}

export interface MobileSyncPairingOffer {
  code: string;
  expires_in_secs: number;
  lan_ip: string;
  port: number;
  server_name: string;
  instance_id: string;
  fingerprint: string;
  qr_payload: string;
}

export const mobileSyncStatus = () =>
  invoke<MobileSyncStatus>("mobile_sync_status");

export const mobileSyncStartPairing = () =>
  invoke<MobileSyncPairingOffer>("mobile_sync_start_pairing");

export const mobileSyncCancelPairing = () =>
  invoke<void>("mobile_sync_cancel_pairing");

export const mobileSyncListDevices = () =>
  invoke<MobileDevice[]>("mobile_sync_list_devices");

export const mobileSyncRevokeDevice = (deviceId: string) =>
  invoke<boolean>("mobile_sync_revoke_device", { deviceId });

// ── 手机文件互传（v1）──────────────────────────────────────────
// 文件本体在 data_dir/mobile_files；这些返回值与 Rust `mobile_sync::files`
// 的 snake_case 字段一一对应，stored_path 永远不下发。

export interface MobileFile {
  id: string;
  direction: "to_phone" | "to_desktop";
  name: string;
  size: number;
  sha256: string;
  status: "pending" | "ready" | "failed";
  chunk_size: number;
  chunks: number;
  received_chunks: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const mobileFileList = () => invoke<MobileFile[]>("mobile_file_list");

export const mobileFileOffer = (paths: string[]) =>
  invoke<MobileFile[]>("mobile_file_offer", { paths });

export const mobileFileDelete = (id: string) =>
  invoke<boolean>("mobile_file_delete", { id });

export const mobileFileReveal = (id: string) =>
  invoke<void>("mobile_file_reveal", { id });

export const mobileFileOpenInbox = () => invoke<void>("mobile_file_open_inbox");

// ── 开发现场 / 任务交接 / 验收工作台（dev workbench Round 1）────────────
// 与后端 `dev_*` 命令一一对应；参数 camelCase（IPC 约定见 AGENTS.md 第 4 节）。
// 全部命令只读元数据或写入显式提交的内容：Git 摘要不含文件内容，交接包正文
// 只经 dev_handoff_save 落库，敏感扫描结果绝不回传命中原文（只回传位置与类型）。

/** 开发项目：本地代码仓库目录的元数据。`exists` 由后端保存/读取时校验目录。 */
export interface DevProject {
  id: string;
  name: string;
  rootPath: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** false = 目录已不存在：前端显示失效徽标，不自动删除。 */
  exists: boolean;
}

/** dev_project_probe 的 Git 摘要状态：非 ok 时其余字段为空值，前端按状态降级展示。 */
export type DevGitStatus = "ok" | "not_a_repo" | "git_unavailable" | "path_missing";

/** 只读 Git 现场摘要：分支 / 未提交数 / worktree 标记。不读取任何文件内容。 */
export interface DevGitInfo {
  status: DevGitStatus;
  branch: string | null;
  detached: boolean;
  isWorktree: boolean;
  mainRepoPath: string | null;
  headSha: string | null;
  /** null = 未能统计（如 git 不可用），前端不得显示为 0。 */
  dirtyCount: number | null;
  probedAt: string;
}

/** 任务交接包的一个历史版本（追加式：只新增版本，不覆盖旧版）。 */
export interface DevHandoffPack {
  id: string;
  /** null = 无当前任务的草稿交接包。 */
  taskId: string | null;
  title: string;
  version: number;
  contentMd: string;
  /** 保存时的来源清单（JSON 字符串），用于回溯预填依据。 */
  sourceSummary: string;
  /** 保存时的敏感扫描结论摘要（非命中原文）。 */
  secretScan: string;
  createdAt: string;
}

/** 验收记录：追加式历史，无更新/删除入口。 */
export interface DevAcceptanceRecord {
  id: string;
  subjectKind: "task" | "planning_feature";
  subjectId: string;
  verdict: "pass" | "fail" | "blocked" | "not_verified";
  summary: string;
  /** 证据列表（每条一行；只存用户登记的元数据描述，不存正文/截图本体）。 */
  evidence: string;
  createdAt: string;
}

/** 敏感扫描命中：只给类型与位置（第几段文本第几行），绝不回传原文。 */
export interface SecretFinding {
  /** 命中的第几段输入文本（0 起）。 */
  textIndex: number;
  /** 命中行号（1 起，按该段文本计）。 */
  line: number;
  /** 命中的敏感模式类型（如 token / password）。 */
  kind: string;
}

export const devProjectList = () => invoke<{ projects: DevProject[] }>("dev_project_list");

export const devProjectSave = (input: {
  id: string | null;
  name: string;
  rootPath: string;
  note?: string;
}) => invoke<{ project: DevProject }>("dev_project_save", { id: input.id, name: input.name, rootPath: input.rootPath, note: input.note ?? "" });

export const devProjectDelete = (id: string) => invoke<{ ok: true }>("dev_project_delete", { id });

export const devProjectProbe = (rootPath: string) =>
  invoke<DevGitInfo>("dev_project_probe", { rootPath });

export const devHandoffSave = (input: {
  taskId: string | null;
  title: string;
  contentMd: string;
  sourceSummary?: string;
}) =>
  invoke<{ pack: DevHandoffPack }>("dev_handoff_save", {
    taskId: input.taskId,
    title: input.title,
    contentMd: input.contentMd,
    sourceSummary: input.sourceSummary ?? "",
  });

export const devHandoffList = (opts?: { taskId?: string | null; limit?: number }) =>
  invoke<{ packs: DevHandoffPack[] }>("dev_handoff_list", {
    taskId: opts?.taskId ?? null,
    limit: opts?.limit ?? null,
  });

export const devHandoffGet = (id: string) => invoke<{ pack: DevHandoffPack }>("dev_handoff_get", { id });

export const devHandoffDelete = (id: string) => invoke<{ ok: true }>("dev_handoff_delete", { id });

export const devHandoffSecretScan = (texts: string[]) =>
  invoke<{ findings: SecretFinding[]; truncated: boolean }>("dev_handoff_secret_scan", { texts });

export const devAcceptanceRecordCreate = (input: {
  subjectKind: "task" | "planning_feature";
  subjectId: string;
  verdict: "pass" | "fail" | "blocked" | "not_verified";
  summary: string;
  evidence?: string[];
}) =>
  invoke<{ record: DevAcceptanceRecord }>("dev_acceptance_record_create", {
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    verdict: input.verdict,
    summary: input.summary,
    evidence: input.evidence ?? [],
  });

export const devAcceptanceRecordList = (opts?: {
  subjectKind?: "task" | "planning_feature" | null;
  subjectId?: string | null;
  limit?: number;
}) =>
  invoke<{ records: DevAcceptanceRecord[] }>("dev_acceptance_record_list", {
    subjectKind: opts?.subjectKind ?? null,
    subjectId: opts?.subjectId ?? null,
    limit: opts?.limit ?? null,
  });
