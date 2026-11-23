//! IPC 数据契约（DTO）。从 `bridge.ts` 原样迁出，供命令封装与调用方共用。
//!
//! 约束：本文件只放纯类型/接口，不放运行时代码；不 import `bridge.ts`（避免环）。
//! 后续可按域继续拆分（tasks/agents/clipboard/…），通过 index barrel 汇总。

import type { TaskNavLink } from "./navigation";

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
   * 主界面关闭行为（2026-11-22 关闭策略）：close_window 关窗驻留托盘（默认，
   * 旧库缺键由后端补默认值）| quit_app 所有主界面关闭入口统一退出整个应用
   * （走 request_exit 的 app-before-exit 保存握手与管线排空）。
   */
  window_close_behavior: "close_window" | "quit_app";
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
  /** 生活记录默认货币（空 = 未配置，填写金额时必须让用户显式选择）。 */
  life_default_currency: string;
  nav_workspace_max: number;
  /** 开发工作台（2026-11）：当前关注的开发任务 ID（tasks.id 字符串；空 = 未设置）。 */
  workbench_current_task: string;
  /**
   * 开发现场（2026-11 Round 1）：当前开发项目 ID（dev_projects.id，UUID 字符串；
   * 空 = 未设置）。旧库缺键时后端返回空串，前端读侧按可选处理。
   */
  workbench_current_project?: string;
  /** 工作空间（v49）：当前活跃的工作空间项目 ID；空/未设置 = 无活跃项目。 */
  workspace_active_project?: string;  // 模块独立启停（v0.5 整改）
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
   * 剪贴板历史静态加密（ADR-0012）：默认 false，旧库保持明文行为；
   * 开启后新采集的正文/HTML 以 CEK 密文落库，旧记录需迁移后才变密文。
   * 读取路径兼容两种格式（密文前缀驱动），不依赖本开关。
   */
  clipboard_encrypt_history?: boolean;
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
  /** 可选收集规则（版本化 JSON）：默认空；规则默认关闭，只支持加标签/归组。 */
  shelf_collect_rules?: ShelfRuleSet;
  /**
   * 导航入口布局（v0.12）：完整面板与停靠胶囊各自的可见入口 + 排序。
   * 版本化 JSON 对象，结构见 `src/lib/navVisibility.ts`；缺失或损坏时前端回退
   * 注册中心默认值，后端只做对象级校验，不参与语义合并。
   */
  navigation_layout?: unknown;
  /**
   * 统一工作台布局（U0）：上次路由、项目、右栏显隐与分栏宽度。
   * 版本化 JSON 对象，结构见 `src/lib/workbenchLayout.ts`；缺失或损坏时前端回退
   * 默认值，后端只做结构边界校验，不参与语义合并。
   */
  workbench_layout?: unknown;
  /**
   * 文件工作区布局（U2）：global/项目态布局快照 + 自定义模板 + 最近模板。
   * 版本化 JSON 对象，结构见 `src/lib/filesWorkspace/persist.ts`；缺失或损坏时
   * 前端回退默认布局，后端只做结构边界校验，不参与语义合并。
   */
  file_workspace_layouts?: unknown;
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

/** 迁移前安全备份的可核对信息（路径与哈希，不含正文）。 */
export interface ClipboardMigrationBackup {
  dir: string;
  dbSha256: string;
  dbBytes: number;
  items: number;
  assets: number;
  createdAt: string;
}

/** 加密现有历史的计数结果（与 Rust `MigrationSummary` 对齐）。 */
export interface ClipboardMigrationSummary {
  pendingBefore: number;
  encryptedItems: number;
  verifiedItems: number;
  leftovers: number;
  walCheckpointed: boolean;
}

/** 加密现有历史的结果：备份信息 + 正文/资产计数 + 预览缓存清理数。 */
export interface ClipboardMigrationOutcome {
  report: ClipboardMigrationSummary;
  backup: ClipboardMigrationBackup;
  assetsEncrypted: number;
  assetsSkipped: number;
  previewCachePurged: number;
}

/** 列表筛选（后端 ClipboardFilter 为 camelCase）。 */
export interface ClipboardFilter {
  kind?: string;
  search?: string;
  favorite?: boolean;
  groupId?: string;
  taskId?: string;
  /** 精确匹配来源进程（如 chrome.exe）；展示名由 UI 换算。 */
  sourceApp?: string;
  /** 最近 N 天；不传/0 表示不限。 */
  recentDays?: number;
  /** recent（默认）| most_used */
  sort?: "recent" | "most_used";
  limit?: number;
  offset?: number;
}

export interface ClipboardSourceOption {
  app: string;
  count: number;
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
  /** 持久化逐项状态中的跳过数；旧后端可能省略。 */
  skipped?: number;
  started_at: string;
  ended_at: string | null;
  message: string;
  remaining_items: string[];
  /** 按键可能已发出、结果不可证明的条目：不会被自动重发 */
  uncertain_items: string[];
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
  /** paused 时的原因：user_switched / target_closed / hwnd_reused / focus_denied */
  pauseReason?: string | null;
  reasonCode?: string | null;
  uncertain?: number;
}

/** 逐项状态行（数据库持久化事实，任务中断后仍可查询） */
export interface PasteItemState {
  job_id: string;
  position: number;
  item_id: string;
  kind: string;
  state: string;
  error_message: string;
  started_at: string | null;
  finished_at: string | null;
  key_sent: boolean;
  confirmed: boolean;
  retry_safe: boolean;
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

/** 导出前确认：只读统计 + 单次有效的确认 token；不含正文。 */
export interface ClipboardExportPreview {
  items: number;
  images: number;
  bytes: number;
  kinds: string[];
  includesTaskContext: boolean;
  confirmationToken: string;
  expiresInSeconds: number;
}

/** Agent 导出目录清理结果：只含计数，不回传具体路径。 */
export interface ExportPurgeReport {
  removed: number;
  skipped: number;
  failed: number;
  bytes: number;
}

// ── 句式命令（ux.command-phrases）──
export interface PhraseTaskCandidate {
  id: string;
  title: string;
  dueAt: string | null;
  priority: number;
}

/** 写意图只给候选与目标值，真正执行在前端二次确认后进行。 */
export interface PhraseWrite {
  target: string;
  candidates: PhraseTaskCandidate[];
  dueAt: string | null;
  dateOnly: boolean;
  priority: number | null;
}

export type PhraseQueryKind = "weekCompleted" | "overdue" | "today" | "agentFailures";

export interface PhraseQuerySummary {
  completed: number;
  overdue: number;
  due: number;
}

export interface PhraseAgentRef {
  sourceId: string;
  sessionId: string;
  runId: string | null;
}

export interface PhraseQueryItem {
  id: string;
  title: string;
  kind: "task" | "agent";
  dueAt: string | null;
  occurredAt: string | null;
  sourceName: string | null;
  agent: PhraseAgentRef | null;
}

export interface PhraseQuery {
  query: PhraseQueryKind;
  summary: PhraseQuerySummary | null;
  items: PhraseQueryItem[];
}

export type PhraseResolution =
  | ({ kind: "complete" } & PhraseWrite)
  | ({ kind: "reschedule" } & PhraseWrite)
  | ({ kind: "priority" } & PhraseWrite)
  | ({ kind: "query" } & PhraseQuery);

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
  /** 数据来源：index（本地回收站索引缓存）/ filesystem（有界实时遍历）/ live（本次实时扫描）。 */
  source?: "index" | "filesystem" | "live";
  /** 数据对应时间（毫秒）；0 表示未知。回收站索引命中时为该卷最后同步时间。 */
  dataAsOfMs?: number;
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
  /** 剪贴板段是否已加密：true 时恢复必须提供备份口令。 */
  clipboard_sealed?: boolean;
  /** 信封是否带恢复密钥槽位：口令丢失时可用一次性恢复密钥恢复。 */
  clipboard_recovery_slot?: boolean;
  /** 剪贴板图片资产是否已随备份加密：true 时恢复自动解密，备份文件不含明文 PNG。 */
  clipboard_assets_sealed?: boolean;
}

/** 加密备份结果：`recovery_code` 只在本次返回中出现一次，需用户自行保管。 */
export interface EncryptedBackupResult {
  path: string;
  recovery_code?: string | null;
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

/** 应用退出前的工作台正文保存握手；requestId 由 Rust 生成。 */
export type AppExitRequest = { requestId: number };

/** 胶囊区域模式：off = 整窗；rail = 只露分类轨道；panel = 轨道 ∪ 功能面板。 */
export type CapsuleRegionMode = "off" | "rail" | "panel" | "tab";

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

/**
 * 运行包的可核对身份（底部状态栏「包信息」与 AI/脚本读取同一份数据）。
 *
 * - `version` / `identifier` / `platform` 来自运行期包元信息；
 * - `build` 来自编译期注入：同版本号的不同构建靠 `commit` + `built_at_unix` 区分；
 * - 安装包产物、构建 ID、包含任务属于构建台账（`tmp/integration/builds/`），
 *   运行时不可得，故不在这里出现。
 */
export interface AppBuildInfo {
  name: string;
  version: string;
  identifier: string;
  /** `流程-架构`，如 `windows-x86_64`（std::env::consts 口径） */
  platform: string;
  build: {
    /** 短 commit；git 不可用时为 "unknown" */
    commit: string;
    /**
     * 40 位完整 commit（同一次 build.rs 采集）；旧版本包未注入该字段时为
     * undefined，前端必须显示「未知」，不得用运行期 git 现算冒充。
     */
    commit_full?: string;
    /** "true" | "false" | "unknown"：构建时工作树是否存在未提交改动 */
    dirty: string;
    /** Unix 秒的字符串形式；构建脚本没取到时为 "unknown" */
    built_at_unix: string;
    /** "debug" | "release" */
    profile: string;
    /** 当前运行的可执行文件路径 */
    exe: string;
  };
}

/** 当前运行环境的 Git 现场（实时读取，与安装包内的构建元数据相互独立）。 */
export type AppRuntimeGitStatus =
  | "ok"
  | "not_a_repo"
  | "git_unavailable"
  | "path_missing"
  | "not_applicable";

export interface AppRuntimeGitInfo {
  status: AppRuntimeGitStatus;
  /** 由 exe 向上找到的仓库根；not_applicable 时为 null。 */
  repoRoot: string | null;
  branch: string | null;
  detached: boolean;
  /** 40 位 HEAD；无仓库/git 不可用时为 null。 */
  headSha: string | null;
  /** 未提交改动行数（含未跟踪）；null = 未能统计，不得显示为 0。 */
  dirtyCount: number | null;
  /** 探测时间（ISO8601），用于说明这是「打开时的现场」。 */
  probedAt: string;
}

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
  navigation: TaskNavLink[];
  clipboard: ClipboardTaskLink[];
  snapshots: SnapshotSummary[];
  actions: ActionItem[];
}

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

// ── 全局快速捕获（v0.7）──
/** 五种捕获类型：任务 / 想法 / 文字 / 待办 / 链接。 */
export type CaptureKind = "task" | "idea" | "text" | "todo" | "link";

/** 草稿（单行表 active）：窗口隐藏/退出后可恢复。 */
/**
 * 快速捕获图片附件（元数据）。图片本体在应用数据目录
 * `capture-attachments/{images,thumbs}`，数据库只存路径与尺寸；
 * 前端拿到的显示 URL 都是按需读取的 data URL。
 */
export interface CaptureAttachment {
  id: string;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  /** 粘贴顺序（0 起） */
  position: number;
}

export interface CaptureDraft {
  kind: CaptureKind;
  content: string;
  updated_at: string;
  /** 草稿期间粘贴的图片；正文为空但有附件时草稿仍然有效。 */
  attachments: CaptureAttachment[];
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
  /** 图片附件（按粘贴顺序）；旧记录为空数组。 */
  attachments: CaptureAttachment[];
}

/** 提交载荷：client_id 供后端幂等去重（失败重试必须复用同一个）。 */
export interface SubmitCaptureInput {
  client_id: string;
  kind: CaptureKind;
  content: string;
  url?: string;
  note?: string;
  /** 草稿附件 ID：与正文同事务转成条目附件（失败整体回滚，图片不丢）。 */
  attachment_ids?: string[];
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

/** 隐藏快速捕获窗口的结果：already_hidden 表示重复关闭/本来就不可见。 */
export interface QuickCaptureHideResult {
  hidden: boolean;
  already_hidden: boolean;
}

/** 打开快速捕获窗口（已打开时只聚焦，不切换为隐藏）。 */
export interface QuickCaptureShowResult {
  visible: boolean;
  focused: boolean;
  /** 窗口已显示但系统前台锁拒绝聚焦时的原因；不是打开失败。 */
  focusError: string | null;
}

/** 语音输入启动结果：language 是实际使用的识别语言（BCP-47，回退时为系统语音语言）。 */
export interface CaptureVoiceStartResult {
  language: string;
}

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

// 通知窗口用户点击跳转（v0.7）：用户在桌面通知上点了「查看详情/通知中心」，
// 后端已激活主窗口；payload 携带可定位的 Agent 对象 ID（无可靠 ID 时为空）。
export interface NotificationNavigatePayload {
  tab: string;
  sourceId?: string;
  sessionId?: string;
  refId?: string;
}

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

/** 新捕获产生（提交或转任务成功后）：kind/id/task_id/status，非任务类型 task_id 为 null。 */
export interface QuickCaptureCreatedEvent {
  kind: CaptureKind;
  id: string;
  task_id: string | null;
  status: string;
}

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
  /** 乐观并发版本（v37）：计划聚合自己的令牌，随计划字段写入 +1 */
  revision?: number;
  /** 所属项目根（workspace_projects.id，ADR-0010）；id 本身是计划 ID。孤儿旧计划为 null。 */
  workspace_project_id?: string | null;
  /**
   * 所属项目根的 revision（workspace_projects.revision，v93）。
   * 与 `revision` 是两个独立聚合的版本令牌：保存名称/描述/目标日期时必须原样回传。
   * 孤儿旧计划（尚未补链）为 null。
   */
  project_revision?: number | null;
  stats: PlanningProjectStats;
}

/**
 * ADR-0010 Plan 语义别名：旧 IPC（planning_list_projects 等）返回的记录本质是
 * 「计划」，新代码统一用 PlanningPlan / Plan 命名；字段结构不变，外部契约不动。
 */
export type PlanningPlan = PlanningProject;
export type PlanningPlanInput = PlanningProjectInput;
export type PlanningPlanPatch = PlanningProjectPatch;
export type PlanningPlanStats = PlanningProjectStats;

export interface PlanningProjectInput {
  name: string;
  description?: string;
  status?: PlanningProjectStatus;
  target_date?: string | null;
}

/**
 * 计划聚合补丁：**只允许计划自身字段**。
 *
 * 名称/描述/目标日期属于项目根（ADR-0011），必须走 `ProjectRootPatch`；
 * `expected_revision` 是计划 revision，与项目根 revision 独立。
 */
export interface PlanningProjectPatch {
  /** 计划执行状态（planning | in_progress | paused | completed） */
  status?: PlanningProjectStatus;
  sort_order?: number;
  /** 计划乐观并发令牌：必填（后端缺失返回 Validation） */
  expected_revision?: number;
}

/**
 * 项目根补丁（`workspace_projects`）：名称/类型/描述/目标/目标日期/生命周期。
 *
 * `target_date` 三态：undefined = 保持；null = 清除；字符串 = 设置。
 * `expected_project_revision` 是项目根 revision（不是计划 revision），必填。
 */
export interface ProjectRootPatch {
  name?: string;
  kind?: string;
  description?: string;
  goal?: string;
  /** 项目生命周期（active | archived） */
  lifecycle_status?: string;
  target_date?: string | null;
  expected_project_revision?: number;
}

/**
 * 项目根 + 计划在同一事务内更新的结果。
 * `project.revision` 是根 revision，`plan.revision` 是计划 revision。
 */
export interface ProjectAndPlanOutcome {
  project: ProjectHubProjectSummary;
  plan: PlanningPlan;
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
  /** 计划 ID（planning_projects.id）：feature 的规划归属（ADR-0010）。 */
  project_id: string;
  /** 所属项目根（workspace_projects.id）；导航/授权用它。孤儿旧计划为 null。 */
  workspace_project_id?: string | null;
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
  revision?: number;
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

export interface McpLastCall {
  action: string;
  agentId: string;
  createdAt: string;
  success: boolean;
  authorized: boolean;
}

export interface McpStatus {
  /** 设置开关（mcp_server_enabled） */
  enabled: boolean;
  /** bridge 是否在监听（实际运行状态，不等于开关） */
  running: boolean;
  port: number | null;
  agent_count: number;
  /** 未撤销的 Agent 数 */
  active_agent_count: number;
  started_at: string | null;
  /** 最近一次工具调用；无调用为 null */
  last_call: McpLastCall | null;
}

export type McpCapability =
  | "tasks.read"
  | "tasks.write"
  | "notes.read"
  | "notes.write"
  | "workflows.read"
  | "workspace.read"
  | "knowledge.read"
  | "skills.read"
  // v76 项目协作 + v90/v92 项目创建与项目写（与 Rust mcp::permissions::CAPABILITIES 对齐）。
  | "projects.read"
  | "plans.read"
  | "decisions.read"
  | "decisions.write"
  | "context.read"
  | "handoffs.read"
  | "handoffs.write"
  | "projects.create"
  | "projects.write";

export interface McpCapabilityGrant {
  capability: McpCapability;
  /** 空串表示全局能力 */
  resourceId: string;
  createdAt: string;
}

export interface McpWorkspaceRoot {
  id: string;
  rootPath: string;
  createdAt: string;
}

export type McpDiagnosticStatus = "ok" | "failed" | "not_run" | "unverified";

export interface McpDiagnosticStep {
  id: string;
  label: string;
  status: McpDiagnosticStatus;
  detail: string;
  hint?: string;
}

export interface McpDiagnosticsReport {
  generatedAt: string;
  overall: "ok" | "degraded" | "failed" | "not_run";
  steps: McpDiagnosticStep[];
  toolCount: number;
  originalToolCount: number;
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

// ── Agent 共享工作空间（v76）───────────────────────────────────────
// 四入口（CLI/MCP/REST/文件）共用同一 service 层；这里只做 UI 管理面封装。
export type AgentAccessData = Record<string, unknown>;

/** MCP 写入成功后主进程广播（v37）：payload camelCase。 */
export interface PlanningChangedEvent {
  kind:
    | "project"
    | "plan"
    | "feature"
    | "step"
    | "milestone"
    | "activity"
    | "task"
    | "note";
  /** 项目根 ID（计划事件也带所属项目根） */
  projectId?: string;
  /** 计划 ID（kind=plan 时必带）；不得用 projectId 冒充 */
  planId?: string;
  featureId?: string;
  revision?: number;
}

// ── Agent 操作生命周期（v86）────────────────────────────────────
// 契约固定为五个状态、四个阶段；不含进度百分比，也不含正文/凭据/绝对路径。
// 事实来源是数据库（agent_operations），事件只做低延迟推送。

export type AgentOperationStatus =
  | "running"
  | "committed"
  | "failed"
  | "conflict"
  | "interrupted";

/** 可验证阶段：由入口在真实节点推进，界面不得据此推算百分比。 */
export type AgentOperationPhase = "started" | "writing" | "finalizing" | "done";

export type AgentOperationInterface = "cli" | "mcp" | "rest" | "file" | "ui" | "system";

export interface AgentOperation {
  id: string;
  /** Agent 身份快照（本机用户为 `local`，未认证文件为 `file:...`）。 */
  agentId: string;
  actorKind: "agent" | "local" | "system";
  interface: AgentOperationInterface;
  action: string;
  resourceKind: string;
  /** 新建资源在提交前为空，成功后绑定真实 ID。 */
  resourceId: string;
  projectId: string;
  status: AgentOperationStatus;
  phase: AgentOperationPhase;
  /**
   * 状态版本：后端每次**真实状态变更**（状态/阶段/资源绑定/详情追加）单调 +1。
   * 心跳不推进。前端以它优先于 `updatedAt` 判定先后，避免同一时间戳
   * 或时钟回拨让终态被旧事件覆盖。旧后端可能不返回（按 v88 之前的数据处理）。
   */
  stateRevision?: number;
  revision?: number;
  requestId: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  leaseExpiresAt?: string;
  errorCode: string;
  detail: string;
}

/** 复合游标：同一时间戳下用 id 继续分页，不跳行也不重复。 */
export interface AgentOperationCursor {
  updatedAt: string;
  id: string;
}

export interface AgentOperationSync {
  operations: AgentOperation[];
  cursor: AgentOperationCursor | null;
  activeCount: number;
  hasMore: boolean;
}

/** `agent-operation-changed` 事件载荷（与 AgentOperation 同构）。 */
export type AgentOperationChangeEvent = AgentOperation;

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
  /** 细粒度来源：`"mobile_capture"` = 手机采集导入；null/缺省 = 其他既有来源。 */
  origin?: string | null;
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

/**
 * 主动粘贴当前剪贴板的结果协议。
 *
 * `success=false` 表示没有产生条目（空/占用/不支持/全部失败），不是 IPC 错误；
 * `partial=true` 表示有成功也有失败或跳过。`operation_id` 是后端本次粘贴的稳定
 * 会话标识，前端诊断另用 `startOperation` 的 id 关联，不混用。
 */
export interface ShelfPasteReport {
  operation_id: string;
  source: "clipboard-current";
  content_kind: "file" | "files" | "image" | "link" | "text" | "html" | "html-link" | "none";
  added: ShelfItem[];
  added_ids: string[];
  failed: ShelfFailedEntry[];
  skipped: number;
  /** 与已有条目同路径/同正文的条数；只提示，不阻止本次保存。 */
  duplicates: number;
  success: boolean;
  partial: boolean;
  requires_user_action: boolean;
  code?: string | null;
  retryable: boolean;
}

/** 全局收集热键 / 资源管理器「发送到」完成事件：只带计数与稳定码。 */
export interface ShelfCollectedEvent {
  operationId: string;
  source: "clipboard-current" | "sendto";
  contentKind: string;
  success: boolean;
  partial: boolean;
  added: number;
  failed: number;
  skipped: number;
  duplicates?: number;
  code?: string | null;
  retryable: boolean;
}

export interface ShelfDeleteReport {
  deleted: number;
  skipped: number;
  freed_bytes: number;
  failed_files: number;
}

/** 软删除（回收站）：托管副本在保留期内保留，batch_id 用于撤销。 */
export interface ShelfTrashDeleteReport {
  batch_id: string;
  removed: number;
  skipped_protected: number;
  managed_retained: number;
}

export interface ShelfTrashRestoreReport {
  batch_id: string;
  restored: number;
  conflicts: number;
  restored_relations: number;
}

export interface ShelfTrashPurgeReport {
  batches: number;
  items: number;
  freed_bytes: number;
  failed_files: number;
}

/** 外部真实文件删除预览：status=blocked 的条目绝不会被删除。 */
export interface ShelfRecycleEntry {
  path: string;
  name: string;
  is_dir: boolean;
  byte_size: number;
  modified_ms: number;
  status: "ready" | "blocked";
  reason: string | null;
}

export interface ShelfRecyclePreview {
  entries: ShelfRecycleEntry[];
  ready: number;
  blocked: number;
  has_dirs: boolean;
  total_bytes: number;
}

/** 确认时的文件指纹：执行前重新比对，变化即跳过（不删）。 */
export interface ShelfRecycleExpectation {
  path: string;
  is_dir: boolean;
  byte_size: number;
  modified_ms: number;
}

export interface ShelfRecycleReportEntry {
  path: string;
  name: string;
  status: "ok" | "skipped" | "failed";
  reason: string | null;
}

export interface ShelfRecycleReport {
  deleted: number;
  skipped: number;
  failed: number;
  entries: ShelfRecycleReportEntry[];
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

/** 资源管理器右键「发送到 Task Dock」的 HKCU 动词状态。 */
export interface ShelfSendToStatus {
  enabled: boolean;
  exe: string;
  command?: string | null;
  stale: boolean;
}

/** 系统级拖出结果：effect 为目标应用实际接受的放置效果。 */
export interface ShelfDragOutResult {
  effect: "copy" | "move" | "none";
  count: number;
  /** move 后目标应用已搬走的源条目。 */
  missing_ids: string[];
}

/** 暂存条目 ↔ 工作空间项目直接关联（只存关系，不复制项目/条目）。 */
export interface ShelfProjectLink {
  project_id: string;
  item_id: string;
  project_name: string;
  created_at: string;
}

/** 批量关联报告：条目级失败不影响其余条目，重复关联幂等。 */
export interface ShelfBatchLinkFailure {
  item_id: string;
  code: string;
  reason: string;
}

export interface ShelfBatchLinkReport {
  target: "project" | "task";
  target_id: string;
  target_name: string;
  linked: number;
  duplicates: number;
  failed: ShelfBatchLinkFailure[];
  success: boolean;
  partial: boolean;
  code: string | null;
}

// ── 标签（v52）：只存关系，不做自动整理 ──────────────────────

export interface ShelfTagFailure {
  item_id: string;
  code: string;
  reason: string;
}

export interface ShelfTagChangeReport {
  tags: string[];
  items: number;
  changed: number;
  skipped: number;
  failed: ShelfTagFailure[];
  success: boolean;
  partial: boolean;
  code: string | null;
}

export interface ShelfRecentTag {
  tag: string;
  count: number;
  last_used_at: string;
}

// ── 重复内容检测：只提示，不自动合并/删除 ─────────────────────

export interface ShelfDedupItem {
  id: string;
  display_name: string;
  kind: string;
  byte_size: number;
  original_path: string | null;
  content_hash: string | null;
}

export interface ShelfDedupGroup {
  kind: "exact" | "same_path" | "similar_image" | "same_name";
  key: string;
  items: ShelfDedupItem[];
}

export interface ShelfDedupFailure {
  item_id: string;
  code: string;
  reason: string;
}

export interface ShelfDedupReport {
  scanned: number;
  hashed: number;
  groups: ShelfDedupGroup[];
  unreadable: ShelfDedupFailure[];
  truncated: boolean;
}

// ── 可选收集规则（P3）：默认关闭，只支持可逆动作 ───────────────

export interface ShelfRuleMatch {
  kinds?: string[];
  exts?: string[];
  name_contains?: string;
  source_kinds?: string[];
}

export interface ShelfRuleAction {
  type: "add_tag" | "assign_group";
  value: string;
}

export interface ShelfRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: ShelfRuleMatch;
  action: ShelfRuleAction;
}

export interface ShelfRuleSet {
  version: number;
  rules: ShelfRule[];
}

export interface ShelfRulePreviewMatch {
  rule_id: string;
  rule_name: string;
  item_id: string;
  item_name: string;
  action_type: string;
  action_value: string;
}

export interface ShelfRulePreviewConflict {
  item_id: string;
  item_name: string;
  rule_ids: string[];
  rule_names: string[];
}

export interface ShelfRuleCount {
  rule_id: string;
  rule_name: string;
  matched: number;
}

export interface ShelfRulePreview {
  evaluated_items: number;
  matched_items: number;
  matches: ShelfRulePreviewMatch[];
  conflicts: ShelfRulePreviewConflict[];
  per_rule: ShelfRuleCount[];
  truncated: boolean;
}

export interface ShelfRuleApplyEntry {
  item_id: string;
  item_name: string;
  rule_id: string;
  action_type: string;
  action_value: string;
  applied: boolean;
  reason: string | null;
}

export interface ShelfRuleApplyReport {
  evaluated_items: number;
  applied: number;
  tagged: number;
  grouped: number;
  skipped: number;
  entries: ShelfRuleApplyEntry[];
  truncated: boolean;
}

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
  /** 最近一次成功投递时间；旧后端缺省 */
  last_used_at?: string;
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
  /**
   * 最近一次写失败的分类：
   * `disk_full` / `permission_denied` / `file_locked` / `unknown`。
   * 三种可处置故障需要用户做不同的事（清盘 / 改目录权限 / 关掉占用进程）。
   */
  lastFailureKind?: string | null;
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
  /** 本次导出是否包含安全审计事件（默认不含，须用户显式授权）。 */
  includesSecurityAudit?: boolean;
}

// ── 诊断中心 · 安全审计统一视图 ─────────────────────────────
// 多源适配：每个来源对应一套原始存储，统一视图只借用相同字段名展示，
// **不把不同数据库的原始记录伪装成同一张物理表**（事件自带 source 标识）。

/** 审计来源（与 Rust `security_audit::adapter::AuditSource` 一一对应）。 */
export type SecurityAuditSource = "securityAuditLog" | "mcpAuditLog" | "vault" | "personalHub";

/** 统一分类（跨来源展示分区；未归类的来源事件落 `other`）。 */
export type SecurityAuditCategory =
  | "pairing"
  | "auth"
  | "deviceRevoke"
  | "mcp"
  | "clipboard"
  | "vault"
  | "personalHub"
  | "other";

export interface SecurityAuditEvent {
  /** 前端去重/选中用：`<source>:<raw id>`；不是任何物理表的 id。 */
  id: string;
  source: SecurityAuditSource;
  /** 原始存储中的事件类型（保留原语义，不跨源改名）。 */
  eventType: string;
  category: SecurityAuditCategory;
  /** 主体：设备 UUID / 代理 ID / 最小化网段；不含密钥。 */
  subject?: string | null;
  action: string;
  /** `ok` | `denied` | `failed` | `unknown` */
  result: string;
  reasonCode?: string | null;
  /** 关联诊断链路（仅 securityAuditLog / mcp 来源可能有值；绝不参与鉴权）。 */
  traceId?: string | null;
  createdAt: string;
}

/** 来源覆盖状态：未接入/不可读必须显式显示，不能伪装成「没有事件」。 */
export interface SecurityAuditSourceStatus {
  source: SecurityAuditSource;
  status: "available" | "empty" | "locked" | "notWired" | "error";
  /** 该源可读总条数；不可读时为 null。 */
  total?: number | null;
  /** 人类可读说明（如「保险库未解锁」）。 */
  note?: string;
}

export interface SecurityAuditPage {
  items: SecurityAuditEvent[];
  /** 合并视图总条数（各源 COUNT 之和，不是物理表行数）。 */
  total: number;
  offset: number;
  limit: number;
  sources: SecurityAuditSourceStatus[];
}

export interface SecurityAuditFilter {
  source?: SecurityAuditSource;
  category?: SecurityAuditCategory;
  eventType?: string;
  /** `ok` | `denied` | `failed` */
  result?: string;
  /** 主体过滤（设备 UUID / 代理 ID 精确匹配，或最小化网段前缀）。 */
  device?: string;
  /** RFC3339 */
  from?: string;
  /** RFC3339 */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface SecurityAuditPruneOptions {
  /** 元数据保留天数（7..=3650，默认 90） */
  metadataDays?: number;
  /** reason_code 明细保留天数（1..=metadataDays，默认 30） */
  detailDays?: number;
}

export interface SecurityAuditPruneReport {
  clearedReasonCodes: number;
  deletedRows: number;
  remainingRows: number;
  metadataCutoff: string;
  detailCutoff: string;
}

// ── 诊断中心 · 性能指标（进程生命周期累计窗口）─────────────
// MetricsRegistry 是进程内有界聚合（指纹表上限 + 最近样本 p95），
// `window` 说明数据窗口；`startedAt` 是聚合起始时刻。重启进程即重置，
// 不存在「最近 24 小时」之类的滚动窗口，前端不得这样表述。

export interface DiagnosticsMetricsEntry {
  module: string;
  action: string;
  count: number;
  failures: number;
  slowCount: number;
  avgMs: number;
  maxMs: number;
  p95Ms: number;
}

export interface DiagnosticsMetricsSummary {
  /** 数据窗口：`process` = 进程启动以来累计 */
  window: "process";
  /** 聚合起始时刻（RFC3339） */
  startedAt: string;
  generatedAt: string;
  fingerprints: number;
  entries: DiagnosticsMetricsEntry[];
  /** 因容量淘汰丢失的指纹数 */
  evicted: number;
}

// ── 诊断中心 · 导出预览 ───────────────────────────────────
export interface DiagnosticsExportPreview {
  /** 预览覆盖的时间范围（来自筛选；未设时为 null） */
  since?: string | null;
  until?: string | null;
  /** 将包含的事件条数 */
  records: number;
  errors: number;
  warnings: number;
  /** 涉及模块（最多 20 个，按事件数降序） */
  modules: string[];
  /** 导出文件大小估算（字节） */
  estimatedBytes: number;
  /** 是否包含安全审计（需用户显式勾选，默认 false） */
  includesSecurityAudit: boolean;
  /** 是否包含设备诊断（日志/状态） */
  includesDeviceDiagnostics: boolean;
  /** 脱敏状态：导出前强制脱敏，恒为 `applied` */
  redaction: "applied";
  /** 预估是否触发截断 */
  truncated: boolean;
}

export interface DiagnosticClearResult {
  removedBytes: number;
  /** 是否真正执行完成；false = 超时/取消，日志未被删除 */
  completed: boolean;
  status: DiagnosticsStatus;
}

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
  /** 上传/发送设备 ID（映射设备名用；旧后端不下发时为 undefined，UI 回落未知设备）。 */
  device_id?: string;
  /** 已加入暂存架时的 ShelfItem.id；未导入为 null；重试幂等。 */
  shelf_item_id: string | null;
  shelf_imported_at: string | null;
  shelf_group_id: string | null;
}

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
  /** v50：该交接包要交给哪个 Agent 会话执行（与 task_agent_links 同一身份口径）。 */
  agentSourceId: string | null;
  agentSessionExternalId: string | null;
  /** 读时派生：会话标题；会话被删除时为 null。 */
  agentSessionTitle: string | null;
  /** 读时派生：该会话当前是否仍存在。 */
  agentSessionAvailable: boolean;
}

/** 验收记录：追加式历史，无更新/删除入口。 */
export interface DevAcceptanceRecord {
  id: string;
  subjectKind: "task" | "planning_feature";
  subjectId: string;
  verdict: "pass" | "fail" | "blocked" | "not_verified";
  summary: string;
  /** 证据描述数组（只存用户登记的元数据描述，不存正文/截图本体）。 */
  evidence: string[];
  createdAt: string;
  /** v50：本记录针对的 Agent 轮次（人工登记时可选标注；历史记录为 null）。 */
  agentSourceId: string | null;
  agentSessionExternalId: string | null;
  agentRunExternalId: string | null;
}

/**
 * 「Agent 已完成、可人工验收」的轮次候选（后端只读派生，不落库、不自动通过）。
 * 已登记过验收的轮次仍会返回，并带 accepted* 字段。
 */
export interface DevAgentRunCandidate {
  sourceId: string;
  sessionExternalId: string;
  /** agent_sessions 行 ID（供按会话继续查轮次）。 */
  sessionId: string;
  sessionTitle: string;
  sessionStatus: string;
  /** user = 手工关联；auto = 导航目标影子关联；handoff = 由交接包绑定的会话。 */
  linkOrigin: "user" | "auto" | "handoff" | string;
  runExternalId: string;
  runTaskTitle: string | null;
  runStatus: string;
  endedAt: string | null;
  updatedAt: string;
  acceptedRecordId: string | null;
  acceptedVerdict: "pass" | "fail" | "blocked" | "not_verified" | null;
  acceptedAt: string | null;
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

// ── 快速笔记（notes_*，2026-11-13 Round 2a）──────────────────────────
// notes_list 一直由 useNotesStore 直接 invokeCommand 调用；为交接包「资料选择」
// 补一个类型化包装（只读列表），字段与后端 notes/store.rs 的 NoteSummary 一一对应。
// 不新增后端命令，不改既有 useNotesStore 路径。

export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  pinned: boolean;
  favorite: boolean;
  task_id: string | null;
  workspace_id: string | null;
  source_capture_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  content_chars: number;
}

// ── 项目工作空间（project workspace，v49）────────────────
export type WorkspaceKind = "development" | "game" | "ai_comic" | "general" | "novel";

export type WorkspaceProjectStatus = "active" | "archived";

export type WorkspaceItemStatus = "todo" | "doing" | "blocked" | "done" | "archived";

export interface WorkspaceProject {
  id: string;
  name: string;
  kind: WorkspaceKind;
  status: WorkspaceProjectStatus;
  rootPath: string;
  rootExists: boolean;
  devProjectId: string | null;
  devProjectExists: boolean;
  devProjectName: string | null;
  note: string;
  itemCount: number;
  taskLinkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInstance {
  projectId: string;
  activeModule: string;
  layoutJson: string;
  lastOpenedAt: string | null;
}

export interface WorkspaceItem {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  stage: string;
  status: WorkspaceItemStatus;
  sortOrder: number;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTaskLink {
  projectId: string;
  taskId: string;
  title: string;
  status: string;
  priority: number;
  dueAt: string | null;
  createdAt: string;
}

export interface WorkspaceProjectProgress {
  projectId: string;
  itemsTotal: number;
  itemsTodo: number;
  itemsDoing: number;
  itemsBlocked: number;
  itemsDone: number;
  itemsArchived: number;
  itemsPercent: number | null;
  linkedTasksTotal: number;
  linkedTasksCompleted: number;
  linkedTasksPercent: number | null;
}

export type WorkspaceResourceKind = "note" | "agent_session" | "artifact";

export interface WorkspaceResourceLink {
  id: string;
  projectId: string;
  kind: WorkspaceResourceKind;
  target: string;
  label: string;
  note: string;
  targetExists: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceResourcePage {
  links: WorkspaceResourceLink[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── 小说卷/章（B1，v58）────────────────────────────────
// 章节列表只返回元信息（不含正文），打开具体章节时才读取正文，避免整本正文
// 一次性进入渲染层。字数由 Rust 按「非空白字符」统计。
export interface NovelVolume {
  id: string;
  projectId: string;
  title: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelChapterSummary {
  id: string;
  projectId: string;
  volumeId: string | null;
  title: string;
  wordCount: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelChapter extends NovelChapterSummary {
  content: string;
}

// ── 统一工作台（U0）：结构化导航协议 ─────────────────────────────────
//
// 「invoke 返回」只代表请求已受理；真实导航结果必须等 `workbench-nav-ack`。
// 窗口未创建 / 正在创建 / 已存在 / 最小化 都由 Rust 统一收敛为「入队 + 唤醒 +
// 事件快路径」，工作台挂载后再拉取队列（事件丢失也不会丢导航）。

/** 目标功能 ID：与导航注册中心/Tab 一致；`home` 为工作台首页。 */
export interface WorkbenchNavTarget {
  tab: string;
  projectId?: string | null;
  taskId?: string | null;
  objectId?: string | null;
  /** 合并入口子页（如 collection 的 inbox/shelf/notes）。 */
  sub?: string | null;
}

export interface WorkbenchNavRequest {
  requestId: number;
  target: WorkbenchNavTarget;
}

/** 导航回执终态；`pending` 之后工作台还会再发一条最终结果。 */
export type WorkbenchNavStatus = "succeeded" | "pending" | "cancelled" | "failed";

export interface WorkbenchNavAck {
  requestId: number;
  status: WorkbenchNavStatus;
  error: string | null;
}

/** 跨窗口导航回执的终态；`pending` 之后主窗口还会再发一条最终回执。 */
export type OpenDevWorkbenchStatus = "pending" | "succeeded" | "cancelled" | "failed";

export interface OpenDevWorkbenchAck {
  requestId: number;
  ok: boolean;
  pending: boolean;
  status?: OpenDevWorkbenchStatus;
  error: string | null;
}

// ── Android 屏幕与控制（ADB + scrcpy）──────────────────────────
//
// 桌面端只托管 scrcpy 进程：画面、输入与窗口由 scrcpy 提供。
// 设备/应用均从本机 adb 实时读取，不落库；会话仅存在于本次运行期。

/** mirror=镜像手机实体屏；virtual=创建独立虚拟屏并启动一个应用。 */
export type VdMode = "mirror" | "virtual";

export type VdSessionStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error"
  | "disconnected";

export interface VdDevice {
  /** 本次操作应使用的 transport。 */
  serial: string;
  /** 物理设备身份（同一手机的多个 ADB transport 会合并）。 */
  uid: string;
  state: string;
  model: string | null;
  product: string | null;
  device: string | null;
  transport_id: string | null;
  connection: "usb" | "wifi" | "mdns" | "other";
  transports: string[];
}

export interface VdDeviceList {
  devices: VdDevice[];
  adb_ok: boolean;
  error: string | null;
}

export interface VdApp {
  package: string;
  /** Android PackageManager 的本地化应用名；未知时回退显示包名。 */
  label: string | null;
  /** 96×96 PNG data URL；读取失败时为 null，前端显示统一占位。 */
  icon: string | null;
  system: boolean;
  /** true=确认可启动；false=确认没有启动入口；null=设备无法判定。 */
  launchable: boolean | null;
  reason: string | null;
}

export interface VdAppList {
  device_uid: string;
  serial: string;
  apps: VdApp[];
  launchable_known: boolean;
  include_all: boolean;
  error: string | null;
}

export interface VdSession {
  id: string;
  pid: number;
  serial: string;
  device_uid: string;
  device_model: string | null;
  mode: VdMode;
  package: string | null;
  app_label: string | null;
  status: VdSessionStatus;
  /** process | display | app | video | ready */
  stage: string;
  /** scrcpy 确认的 Display ID；虚拟屏未确认前为 null，导航操作会被拒绝。 */
  display_id: number | null;
  title: string;
  started_at: string;
  ready_at: string | null;
  ended_at: string | null;
  alive: boolean;
  error: string | null;
  warning: string | null;
  /** 子进程是否确认纳入 Windows Job Object（false 时 stop 无法保证收尾）。 */
  job_assigned: boolean;
  size: string | null;
  /** 投屏控制栏状态：pending | ready | unavailable | closed。 */
  toolbar_state: string;
}

export interface VdProbe {
  adb_path: string | null;
  adb_version: string | null;
  scrcpy_path: string | null;
  scrcpy_version: string | null;
  supports_new_display: boolean;
  supports_ime_local: boolean;
  devices: VdDevice[];
  error: string | null;
}

export interface VdFocus {
  found: boolean;
  focused: boolean;
}

export interface VdScreenshot {
  path: string;
  width: number;
  height: number;
  captured_at: string;
  /** 启发式质量警告（纯色/低色彩变化/窗口不可见等），不影响文件本身可读。 */
  warning: string | null;
}

export interface VdDiagnostics {
  owned_sessions: number;
  stale_displays: string[];
  note: string;
}

export interface VdStartOptions {
  serial: string;
  mode: VdMode;
  /** 仅虚拟屏模式使用。 */
  packageName?: string | null;
  /** 仅虚拟屏模式使用，格式 `宽x高/DPI`。 */
  size?: string | null;
  /** 默认关闭：不让 scrcpy 自动覆盖电脑/手机剪贴板。 */
  clipboardSync?: boolean;
  /** 实验多屏：允许最多两个会话。 */
  allowMulti?: boolean;
}

// ── 投屏窗口伴随系统（v0.17）──────────────────────────────

export type ProjectionWindowMode = "normal" | "maximized" | "fullscreen";

/** 一体化布局模式（后端 calculate_projection_layout 的判定结果）。 */
export type ProjectionLayoutMode = "side" | "bottom" | "compact";

/** 控制栏导航动作（与后端 vd_nav 的白名单一致）。 */
export type ProjectionNavigationAction = "back" | "home" | "recents";

/** 后端 `vd-toolbar-state` 事件载荷（一体化布局口径）。 */
export interface ProjectionToolbarState {
  /** 窗口形态：normal / maximized / fullscreen。 */
  window_mode: ProjectionWindowMode;
  /** 布局模式：side（视频+右导航列）/ bottom（视频+底部条）/ compact（导航悬浮）。 */
  layout_mode: ProjectionLayoutMode;
  /** 当前显示器 DPI scale（96 → 1.0）。 */
  dpi_scale: number;
  session_id: string;
}

/** 投屏窗口品牌身份回读报告（vd_projection_identity）。 */
export interface ProjectionIdentityReport {
  title: string;
  title_matches: boolean;
  icon_small_set: boolean;
  icon_big_set: boolean;
  aumid: string | null;
  aumid_matches: boolean;
}

/** 控制栏截图完成事件（复用主窗口截图预览）。 */
export interface VdScreenshotEvent {
  session: VdSession;
  screenshot: VdScreenshot;
}

// ── 文件工作区（多目录文件浏览/操作/缩略图）────────────────────────────

/** 目录条目（后端 file_workspace::FsEntry）。 */
export interface FsEntry {
  name: string;
  kind: "dir" | "file" | "link";
  ext: string;
  size: number | null;
  modifiedMs: number | null;
  hidden: boolean;
  /** folder/image/video/audio/text/doc/sheet/slide/archive/code/data/program/link/other */
  category: string;
}

export interface FsDirListing {
  path: string;
  entries: FsEntry[];
  /**
   * 本轮结束时从目录开头累计的已消费磁盘位置（磁盘原始序，含隐藏过滤项与
   * 元数据失败项）；恒 >= 入参 offset（offset 超界时等于目录条目总数且 hasMore=false）。
   * 翻页不要用本字段自行累加，一律用 `nextOffset`。
   */
  scanned: number;
  /**
   * 下一页的**绝对偏移**，显式等于 `scanned`；前端翻页一律用本字段，
   * 禁止再 `offset + scanned` 自行累加。`hasMore=true` 时必 > offset。
   */
  nextOffset: number;
  /**
   * 目录还有更多未返回的条目：仅因返回条数上限或扫描预算停止、且目录尚有未读条目
   * 时为 true；遍历到末尾必为 false。
   */
  hasMore: boolean;
}

export interface FsDirSignature {
  exists: boolean;
  isDir: boolean;
  modifiedMs: number | null;
}

export interface FsPlace {
  name: string;
  path: string;
  /** fixed | removable | network | optical | ram | unknown */
  driveKind: string;
}

export interface FsEntryReport {
  source: string;
  target: string | null;
  status: "ok" | "failed" | "skipped" | "partial";
  reason: string | null;
  /** 稳定失败码（`FS_OP_*`）；成功/跳过为空。诊断聚合与界面分类都用它。 */
  code?: string | null;
  /** 失败阶段：prepare / transfer / recycle / cleanup。 */
  stage?: string | null;
}

export interface FsOpReport {
  /** 与诊断共享的操作 ID：前端 `startOperation()` 生成，后端原样沿用。 */
  operationId: string;
  attempted: number;
  ok: number;
  failed: number;
  skipped: number;
  /** 内容已落地但源未删除等「部分完成」条数。 */
  partial: number;
  entries: FsEntryReport[];
}

export interface FsStat {
  path: string;
  exists: boolean;
  kind: "dir" | "file" | "link" | "missing";
  size: number | null;
  createdMs: number | null;
  modifiedMs: number | null;
  /** 最后访问时间；Windows 可能延迟更新，仅作参考。 */
  accessedMs: number | null;
  /** Windows 属性位的小写代码（readonly/hidden/system/...）。 */
  attributes: string[];
  readonly: boolean;
  hidden: boolean;
  childCount: number | null;
  childTruncated: boolean;
}

export interface FsBatchRenameItem {
  path: string;
  newName: string;
}

export interface FsHashEntry {
  path: string;
  size: number | null;
  hash: string | null;
  error: string | null;
}

/** 重复文件删除请求：后端会重新哈希保留项与待删项，校验失败时不删除。 */
export interface VerifiedDuplicateDeleteGroup {
  keepPath: string;
  deletePaths: string[];
  expectedSize: number;
  expectedHash: string;
}

export interface FsTextPreview {
  path: string;
  size: number;
  truncated: boolean;
  /** 实际解码口径（UTF-8 / UTF-8 BOM / UTF-16 LE / UTF-16 BE / UTF-8 (lossy)）。 */
  encoding: string;
  content: string;
}

/** 原始字节只读预览（图片原图 / PDF）；超限时只含前缀字节。 */
export interface FsBinaryPreview {
  path: string;
  size: number;
  truncated: boolean;
  mime: string;
  base64: string;
}

/**
 * conflict: skip | rename | overwrite
 *
 * `operationId` 可选：前端用 `startOperation("file", "workspace_copy").id` 传入，
 * 后端把同一 ID 写进业务诊断事件——这样「用户看到的那次失败」在诊断中心可以
 * 精确关联，而不是前后端各记一条互不相认的日志。
 */
export interface PreviewConflict {
  source: string;
  target: string;
  kind: "file" | "dir" | "link";
}

/** 只读操作预演结果；不执行任何文件写入。 */
export interface OperationPreview {
  effect: "copy" | "move";
  items: number;
  files: number;
  dirs: number;
  bytes: number;
  conflicts: PreviewConflict[];
  inaccessible: string[];
  duplicates: string[];
  warnings: string[];
  /** false = 统计触达条目/深度/读取上限，结果不完整。 */
  complete: boolean;
}

// ── 回收站索引与统一文件操作任务（v68）─────────────────────────────────
//
// 设计约束：
// - 列表/统计只读本地索引（毫秒级），不触发扫描；同步是显式后台动作；
// - 索引 ID 为 `"{volume}|{recordKey}"`，不含 SID；后端按 ID 回查真实 `$I/$R`；
// - 批量操作返回任务快照，进度经事件 `recycle:job-progress` 推送；
// - 已执行的操作不可撤销，UI 不得把取消描述成「回滚」。

export type RecycleState = "present" | "missing_data" | "unreadable";

export interface RecycleItem {
  id: string;
  volume: string;
  name: string;
  originalPath: string;
  isDir: boolean;
  /** null = 目录或元数据未记录大小（UI 显示 —，绝不递归统计）。 */
  size: number | null;
  deletedMs: number;
  state: RecycleState;
  anomaly: string | null;
}

export interface RecycleVolumeStat {
  volume: string;
  items: number;
  files: number;
  folders: number;
  knownBytes: number;
  unknownSize: number;
  /** ok | partial | offline | error | scanning | stale */
  state: string;
  lastSyncMs: number;
  systemItems: number | null;
  systemBytes: number | null;
  systemCheckedMs: number | null;
  errorCode: string | null;
}

export interface RecycleStats {
  items: number;
  files: number;
  folders: number;
  knownBytes: number;
  unknownSize: number;
  volumes: RecycleVolumeStat[];
  lastSyncMs: number;
  /** empty | ready | scanning | partial | offline | error */
  state: string;
  /** index（本地索引） | system（Shell 口径） */
  source: string;
  indexedAtMs: number;
  /** >0 表示后台正在同步的卷数量。 */
  syncing: number;
}

export interface RecycleQuery {
  search?: string;
  volume?: string | null;
  kind?: "all" | "file" | "folder";
  state?: "present" | "missing" | "unreadable" | null;
  minSize?: number | null;
  maxSize?: number | null;
  deletedAfterMs?: number | null;
  deletedBeforeMs?: number | null;
  sort?: "deleted" | "name" | "size" | "path" | "volume";
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
  /** 是否附带全表统计（10 万级为两次全表扫描，只在首页/刷新时请求）。 */
  includeStats?: boolean;
}

export interface RecyclePage {
  items: RecycleItem[];
  total: number;
  offset: number;
  limit: number;
  /** 仅首页/刷新请求统计；翻页时后端返回 null，避免每次翻页做全表聚合。 */
  stats: RecycleStats | null;
  /** 后端实测查询耗时（供性能验收记录）。 */
  queryMs: number;
}

export interface RecycleSyncStatus {
  running: boolean;
  startedMs: number;
  finishedMs: number;
  volumesDone: number;
  volumesTotal: number;
  cancelRequested: boolean;
  lastError: string | null;
}

export interface RecycleSyncVolumeOutcome {
  volume: string;
  state: string;
  items: number;
  added: number;
  updated: number;
  removed: number;
  durationMs: number;
  errorCode: string | null;
}

export interface RecycleSyncSummary {
  startedMs: number;
  finishedMs: number;
  durationMs: number;
  cancelled: boolean;
  volumes: RecycleSyncVolumeOutcome[];
  error: string | null;
}

export interface RecycleScanProgress {
  volume: string;
  phase: "enumerating" | "reading" | "writing" | "verifying" | "done";
  done: number;
  total: number;
  added: number;
  updated: number;
  removed: number;
}

export interface FileJobEntry {
  label: string;
  status: "ok" | "failed" | "skipped" | "partial";
  code: string | null;
  message: string | null;
}

export interface FileJobSnapshot {
  id: string;
  /** 统一任务类型：复制/移动/重命名/删除/永久删除/恢复/永久删除回收站项/清空 */
  kind:
    | "copy"
    | "move"
    | "rename"
    | "delete"
    | "delete_permanent"
    | "delete_duplicates"
    | "restore"
    | "purge"
    | "empty";
  /**
   * pending | running | cancelling | completed | partial | failed | cancelled
   * `pending` 表示已入队未开始（可安全取消）；`cancelling` 表示取消已受理，
   * 任务会在批次边界停止，已执行的不可逆操作不回滚。
   */
  status:
    | "pending"
    | "running"
    | "cancelling"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled";
  total: number;
  done: number;
  ok: number;
  failed: number;
  /** 内容已落地但源未删除等「部分完成」条数。 */
  partial: number;
  skipped: number;
  /** queued | executing | verifying | done */
  phase: string;
  cancelable: boolean;
  cancelRequested: boolean;
  startedMs: number;
  finishedMs: number;
  failures: FileJobEntry[];
  message: string | null;
  /** 系统操作成功但回收站索引写入失败的条数（已标记该卷需要重新对账）。 */
  indexPending?: number;
  /** 已处理字节数（仅需读内容的任务：哈希 / 复制；其余为 0）。 */
  bytesDone?: number;
  /** 本次任务的字节总量；0 表示该任务不提供字节进度。 */
  bytesTotal?: number;
}

// ── 知识与 AI 能力中心（v72）────────────────────────────────────────
// 约定：字段 camelCase 与 Rust `#[serde(rename_all="camelCase")]` 一一对应；
// 知识正文、Skill 内容、MCP 返回一律按不可信数据展示。

export type KnowledgeBaseKind = "personal" | "project" | "workspace";

export type KnowledgeSourceKind = "file" | "folder" | "note" | "capture" | "text";

export type KnowledgeSourceMode = "reference" | "imported";

export type KnowledgeDocStatus = "pending" | "indexed" | "failed";

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  kind: KnowledgeBaseKind;
  projectId: string | null;
  /** 工作区类型知识库的真实绑定（复用 workspace_projects.id）。 */
  workspaceId: string | null;
  favorite: boolean;
  docCount: number;
  indexedCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  kbId: string;
  title: string;
  sourceKind: KnowledgeSourceKind;
  sourceMode: KnowledgeSourceMode;
  sourcePath: string | null;
  mime: string;
  sizeBytes: number;
  contentHash: string;
  status: KnowledgeDocStatus;
  error: string;
  chunkCount: number;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeLink {
  id: string;
  docId: string;
  targetKind: "task" | "project" | "note" | "agent_session" | "workflow" | "file";
  targetId: string;
  label: string;
  createdAt: string;
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  content: string;
  truncated: boolean;
  links: KnowledgeLink[];
}

export interface KnowledgeBaseDetail extends KnowledgeBase {
  recentDocuments: KnowledgeDocument[];
}

export interface KnowledgeStats {
  kbCount: number;
  docCount: number;
  indexedCount: number;
  failedCount: number;
  chunkCount: number;
}

export interface KnowledgeDocumentPage {
  documents: KnowledgeDocument[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface KnowledgeImportItem {
  path: string;
  status: "imported" | "skipped" | "duplicate" | "failed";
  reason: string;
}

export interface KnowledgeImportReport {
  imported: number;
  skipped: number;
  duplicates: number;
  failed: number;
  items: KnowledgeImportItem[];
  documents: KnowledgeDocument[];
}

export interface KnowledgeSearchHit {
  docId: string;
  kbId: string;
  kbName: string;
  title: string;
  sourceKind: KnowledgeSourceKind;
  sourcePath: string | null;
  snippet: string;
  chunkOffset: number;
  rank: number;
  status: string;
  updatedAt: string;
}

export interface KnowledgeSearchPage {
  query: string;
  hits: KnowledgeSearchHit[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SkillRiskNote {
  kind: string;
  detail: string;
  file: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  sourceKind: "discovered" | "imported";
  sourcePath: string;
  scope: "global" | "project" | "workspace" | "agent";
  projectId: string | null;
  workspaceId: string | null;
  /** 作用域为 agent 时复用 mcp_agents.id。 */
  agentId: string | null;
  enabled: boolean;
  riskLevel: "low" | "medium" | "high";
  riskNotes: SkillRiskNote[];
  version: string;
  formatOk: boolean;
  missing: boolean;
  nameConflict: boolean;
  updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  files: { path: string; isDir: boolean; sizeBytes: number }[];
}

export interface SkillScanReport {
  discovered: number;
  updated: number;
  missing: number;
  roots: string[];
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
  highRisk: boolean;
  riskLevel: "low" | "medium" | "high" | "unknown";
  riskReasons: string[];
  /** Server 的 ToolAnnotations；不可信提示，不是安全边界。 */
  annotations: unknown;
  trusted: boolean;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpPromptInfo {
  name: string;
  description: string;
  arguments: unknown;
}

export interface ExternalMcpServer {
  id: string;
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: { key: string; hasValue: boolean }[];
  enabled: boolean;
  allowHighRisk: boolean;
  status: "unknown" | "ok" | "failed" | "disabled";
  lastError: string;
  serverInfo: unknown;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpConnectionReport {
  ok: boolean;
  durationMs: number;
  protocolVersion: string;
  serverInfo: unknown;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  error: string | null;
}

export interface McpCallReport {
  ok: boolean;
  durationMs: number;
  isError: boolean;
  content: unknown;
  error: string | null;
}

export interface McpCallRecord {
  id: string;
  serverId: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  error: string;
  createdAt: string;
}

export interface McpCallPage {
  items: McpCallRecord[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface CapabilityMcpToolRef {
  serverId: string;
  toolName: string;
}

export interface CapabilityContextConfig {
  kbIds: string[];
  skillIds: string[];
  mcpTools: CapabilityMcpToolRef[];
  taskIds: string[];
  rules: string;
}

export interface CapabilityContextProfile {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  config: CapabilityContextConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityBundleItem {
  id: string;
  title: string;
  source: string;
  excerpt: string;
  chars: number;
}

export interface CapabilityBundleSection {
  kind: string;
  title: string;
  items: CapabilityBundleItem[];
  chars: number;
}

export interface CapabilityBundleSource {
  kind: string;
  id: string;
  label: string;
  path: string | null;
}

export interface CapabilityContextBundle {
  sections: CapabilityBundleSection[];
  totalChars: number;
  truncated: boolean;
  sources: CapabilityBundleSource[];
}

export type CapabilityRecipeStep =
  | { type: "knowledge_search"; kbIds: string[]; query: string; limit: number }
  | {
      type: "mcp_tool";
      serverId: string;
      toolName: string;
      args: Record<string, unknown>;
      highRisk: boolean;
    }
  | { type: "save_note"; title: string };

export interface CapabilityRecipe {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  enabled: boolean;
  steps: CapabilityRecipeStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRecipeSummary {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  enabled: boolean;
  stepCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  updatedAt: string;
}

export interface CapabilityRecipeRunStep {
  index: number;
  stepType: string;
  status: string;
  detail: string;
  output: unknown;
  durationMs: number;
}

export interface CapabilityRecipeRun {
  id: string;
  recipeId: string;
  recipeName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  steps: CapabilityRecipeRunStep[];
  error: string;
}

export interface CapabilityRecipeRunSummary {
  id: string;
  recipeId: string;
  recipeName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string;
}

export interface CapabilityRecipeRunPage {
  items: CapabilityRecipeRunSummary[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── 项目中枢（v78）：项目根 + 计划/阶段/能力/任务/交付物事实 ─────────
export interface ProjectHubProjectSummary {
  id: string;
  name: string;
  kind: string;
  status: string;
  description: string;
  goal: string;
  targetDate: string | null;
  activePlanId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 项目根乐观并发版本（v93）：与计划 revision 独立 */
  revision: number;
  phaseCount: number;
  taskCount: number;
  completedTaskCount: number;
  capabilityCount: number;
  capabilityGapCount: number;
  deliverableCount: number;
}

export interface ProjectHubGoal {
  id: string;
  parentId: string | null;
  title: string;
  note: string;
  kind: string;
  metric: string;
  targetValue: number | null;
  unit: string;
  status: string;
  source: string;
  sortOrder: number;
}

export interface ProjectHubPhase {
  id: string;
  name: string;
  description: string;
  targetDate: string | null;
  startDate: string | null;
  sortOrder: number;
  taskCount: number;
  completedTaskCount: number;
  /** 阶段内功能数（功能通过 planning_features.milestone_id 关联阶段）。 */
  featureCount: number;
  completedFeatureCount: number;
}

export interface ProjectHubMilestone {
  id: string;
  name: string;
  description: string;
  targetDate: string | null;
  phaseId: string | null;
  sortOrder: number;
  featureCount: number;
  completedFeatureCount: number;
}

export interface ProjectHubCapability {
  id: string;
  capabilityId: string;
  name: string;
  category: string;
  description: string;
  mastery: string;
  necessity: string;
  targetLevel: string;
  assessmentLevel: string | null;
  status: string;
  impact: string;
  alternative: string;
  phaseId: string | null;
  resourceCount: number;
  availableResourceCount: number;
  /** 已做过可用性校验的关联数；0 且 resourceCount>0 表示「关联了但从未校验」。 */
  verifiedResourceCount: number;
}

export interface ProjectHubTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  dueAt: string | null;
  completedAt: string | null;
  phaseId: string | null;
  milestoneId: string | null;
}

export interface ProjectHubDeliverable {
  id: string;
  title: string;
  kind: string;
  status: string;
  phaseId: string | null;
  targetPath: string;
  externalUrl: string;
  evidence: string;
  producedAt: string | null;
  acceptedAt: string | null;
}

export interface ProjectHubEvent {
  id: string;
  kind: string;
  actor: string;
  summary: string;
  createdAt: string;
}

export interface ProjectHubFeature {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  /** 所属阶段（planning_features.milestone_id 指向阶段行）。 */
  milestoneId: string | null;
  acceptanceCriteria: string;
  targetDate: string | null;
  sortOrder: number;
}

export interface ProjectHubSnapshot {
  project: ProjectHubProjectSummary;
  planId: string | null;
  goals: ProjectHubGoal[];
  phases: ProjectHubPhase[];
  milestones: ProjectHubMilestone[];
  features: ProjectHubFeature[];
  capabilities: ProjectHubCapability[];
  tasks: ProjectHubTask[];
  deliverables: ProjectHubDeliverable[];
  events: ProjectHubEvent[];
  risks: string[];
}

export interface ProjectHubCreateGoalInput {
  title: string;
  note?: string;
}

export interface ProjectHubCreateMilestoneInput {
  name: string;
  description?: string;
  targetDate?: string | null;
}

export interface ProjectHubCreatePhaseInput {
  name: string;
  description?: string;
  targetDate?: string | null;
  startDate?: string | null;
  milestones?: ProjectHubCreateMilestoneInput[];
}

export interface ProjectHubCreateTaskInput {
  title: string;
  description?: string;
  phaseIndex?: number | null;
  dueAt?: string | null;
  priority?: number | null;
}

/** 功能草案：随项目同事务落库到 planning_features。 */
export interface ProjectHubCreateFeatureInput {
  title: string;
  /** 验收标准；空串表示尚未填写。 */
  acceptance?: string;
  /** P0 / P1 / P2。 */
  priority?: string;
  /** 所属阶段在 phases 数组中的下标；null = 暂未分阶段。 */
  phaseIndex?: number | null;
}

export interface ProjectHubCreateCapabilityInput {
  name: string;
  category?: string;
  necessity?: string;
  targetLevel?: string;
  impact?: string;
  alternative?: string;
  /** 所属阶段在 phases 数组中的下标；null = 全项目能力需求（禁止用 -1 之类的哨兵值）。 */
  phaseIndex?: number | null;
}

export interface ProjectHubCreateInput {
  name: string;
  kind: string;
  description?: string;
  goal?: string;
  targetDate?: string | null;
  rootPath?: string | null;
  templateId?: string | null;
  clientRequestId?: string | null;
  goals?: ProjectHubCreateGoalInput[];
  phases?: ProjectHubCreatePhaseInput[];
  features?: ProjectHubCreateFeatureInput[];
  tasks?: ProjectHubCreateTaskInput[];
  capabilities?: ProjectHubCreateCapabilityInput[];
}

/**
 * 统一项目创建（Workbench 快速创建 / ProjectHub 高级创建 / CLI / MCP / REST 共用）。
 *
 * `directoryMode` 三态互斥：`metadata_only` 只建元数据；`attach_existing` 关联已有目录
 * （允许离线，不允许是文件）；`create_new` 由后端创建目录，父目录必须存在、目标必须不存在。
 */
export type ProjectDirectoryMode = "metadata_only" | "attach_existing" | "create_new";

export type ProjectAgentAccessPolicy =
  | "none"
  | "creator_project"
  | "creator_project_and_plan";

export interface ProjectCreateInput extends ProjectHubCreateInput {
  directoryMode?: ProjectDirectoryMode;
  devProjectId?: string | null;
  note?: string | null;
  planName?: string | null;
  agentAccessPolicy?: ProjectAgentAccessPolicy;
}

/** 计划摘要：`id` 是计划 ID，`projectId` 才是项目根。 */
export interface ProjectPlanSummary {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: string;
  targetDate: string | null;
  isActive: boolean;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkspaceView {
  projectId: string;
  rootPath: string;
  rootExists: boolean;
  devProjectId: string | null;
  provisioningStatus: string;
}

export interface ProjectCreateResult {
  /** false = 幂等重放，返回既有结果。 */
  created: boolean;
  project: ProjectHubProjectSummary;
  activePlan: ProjectPlanSummary;
  workspace: ProjectWorkspaceView;
  /** metadata_only | attached | attached_offline | created */
  provisioningStatus: string;
}

/** 可绑定资源候选：能力是「能不能做」，资源是「有没有可调用的东西」。 */
export interface ProjectHubResourceCandidate {
  kind: string;
  id: string;
  label: string;
  /** global / project */
  scope: string;
  availability: string;
  detail: string;
}

export interface ProjectHubResourceLink {
  id: string;
  /** 关联归属项目（scope=global 时是创建者项目）。 */
  projectId: string;
  /** project / global：私有绑定或显式共享。 */
  scope: string;
  capabilityId: string;
  capabilityName: string;
  resourceKind: string;
  resourceId: string;
  label: string;
  availability: string;
  /** 探测依据（数据库/本地文件/记录状态），不当成「在线可用」的结论。 */
  detail: string;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface ProjectHubResourceLinkInput {
  capabilityId: string;
  resourceKind: string;
  resourceId: string;
}
