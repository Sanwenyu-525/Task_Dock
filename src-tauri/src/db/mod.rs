//! SQLite 连接管理、迁移与设置存储。
pub mod models;
pub use models::*;

use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 读连接池大小：WAL 下多个只读连接可与单写连接并行，降低快照/历史查询的互斥等待。
const READ_POOL_SIZE: usize = 3;

/// 迁移列表：按顺序应用，版本号 = PRAGMA user_version。
const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        r#"
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  due_at TEXT,
  remind_at TEXT,
  advance_minutes INTEGER NOT NULL DEFAULT 0,
  recurrence_rule_id TEXT REFERENCES recurrence_rules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_tasks_status_due ON tasks(status, due_at);

CREATE TABLE recurrence_rules (
  id TEXT PRIMARY KEY NOT NULL,
  freq TEXT NOT NULL CHECK (freq IN ('daily','weekly','monthly')),
  interval INTEGER NOT NULL DEFAULT 1 CHECK (interval >= 1),
  by_weekday TEXT NOT NULL DEFAULT '[]',
  by_monthday INTEGER,
  until TEXT,
  anchor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE task_reminders (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  occurrence TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'due' CHECK (kind IN ('due','advance','custom')),
  fired INTEGER NOT NULL DEFAULT 0,
  fired_at TEXT,
  UNIQUE (task_id, occurrence)
);
CREATE INDEX idx_reminders_pending ON task_reminders(fired, remind_at);

CREATE TABLE task_categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6366f1',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_sources (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  enabled INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 0,
  homepage TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES agent_sources(id),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_run_id TEXT,
  UNIQUE (source_id, external_id)
);
CREATE INDEX idx_sessions_status ON agent_sessions(status, last_seen_at);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  external_run_id TEXT,
  task_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  pending_items TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_runs_status ON agent_runs(status, updated_at);
CREATE UNIQUE INDEX idx_runs_external ON agent_runs(source_id, external_run_id) WHERE external_run_id IS NOT NULL;

CREATE TABLE agent_events (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  session_external_id TEXT NOT NULL,
  run_external_id TEXT,
  event_type TEXT NOT NULL DEFAULT 'status',
  state TEXT NOT NULL,
  message TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_events_received ON agent_events(received_at);

CREATE TABLE task_agent_links (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  session_external_id TEXT NOT NULL,
  run_external_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_links_task ON task_agent_links(task_id);

CREATE TABLE notification_history (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT,
  ref_id TEXT,
  occurrence TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref_id, occurrence)
);
CREATE INDEX idx_notifications_created ON notification_history(created_at);

CREATE TABLE application_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#,
    ),
    (
        2,
        r#"
-- v2（Task Dock 0.2）：Agent 分层模型 + 事件扩展 + 动态来源。

-- 实例层：同一 Agent 的多个安装/进程实例分开记录。
CREATE TABLE agent_instances (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES agent_sources(id) ON DELETE CASCADE,
  instance_key TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  exe_path TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source_id, instance_key)
);

-- P0 修复：缺失的 run_id 曾被写成空字符串，与部分唯一索引
-- idx_runs_external(source_id, external_run_id) 冲突（两个无 run_id 的会话必然撞索引）。
-- 统一修复为 NULL（NULL 不参与部分唯一索引）。
UPDATE agent_runs SET external_run_id = NULL WHERE external_run_id = '';

ALTER TABLE agent_runs ADD COLUMN instance_id TEXT;
ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT;
CREATE INDEX idx_runs_session ON agent_runs(session_id, updated_at);

ALTER TABLE agent_sessions ADD COLUMN instance_id TEXT;

-- 事件模型扩展（对应 Agent→Instance→Session→Run→Event 分层）。
ALTER TABLE agent_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_events ADD COLUMN event_id TEXT;
ALTER TABLE agent_events ADD COLUMN instance_id TEXT;
ALTER TABLE agent_events ADD COLUMN parent_run_id TEXT;
ALTER TABLE agent_events ADD COLUMN occurred_at TEXT;
ALTER TABLE agent_events ADD COLUMN transport TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE agent_events ADD COLUMN evidence_type TEXT NOT NULL DEFAULT 'observed';
ALTER TABLE agent_events ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
ALTER TABLE agent_events ADD COLUMN dedupe_key TEXT;
-- 普通 UNIQUE 索引（SQLite 中多个 NULL 互不冲突，且 ON CONFLICT(dedupe_key) 可直接匹配）
CREATE UNIQUE INDEX idx_events_dedupe ON agent_events(dedupe_key);

-- 动态来源注册。
ALTER TABLE agent_sources ADD COLUMN adapter TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sources ADD COLUMN icon TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sources ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sources ADD COLUMN last_event_at TEXT;

-- P1-5 修复：v0.1 把 codex 预置为 verified=1 但从未真实联调。
-- verified 从此只代表「已收到该来源的真实事件」，一律重置，由真实事件到达时再置位。
UPDATE agent_sources SET verified = 0;

INSERT OR IGNORE INTO agent_sources
  (id, display_name, kind, enabled, verified, homepage, note, config, adapter, created_at, updated_at)
VALUES
  ('mock', 'Mock 模拟器', 'mock', 1, 0, '', '内置模拟适配器：仅手动触发（UI 明确标注「模拟」，不作为真实接入证据）', '{}', 'mock', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('codex', 'Codex', 'transport', 1, 0, 'https://github.com/openai/codex', 'OpenAI Codex CLI/App：通过 ~/.codex/hooks.json 生命周期钩子上报', '{}', 'codex', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('trae', 'Trae', 'transport', 1, 0, 'https://docs.trae.ai/ide/hook-configuration-reference', 'Trae IDE：通过 ~/.trae/hooks.json（国际版）与 ~/.trae-cn/hooks.json（CN 版）上报', '{}', 'trae', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('workbuddy', 'WorkBuddy', 'transport', 1, 0, 'https://www.workbuddy.ai/docs/zh/cli/hooks', 'WorkBuddy / CodeBuddy：settings.json hooks（安装后需在 CLI /hooks 面板确认生效）', '{}', 'workbuddy', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('qoder', 'Qoder', 'transport', 1, 0, 'https://docs.qoder.cn/qoder/hooks', 'Qoder：~/.qoder/settings.json hooks（与 CLI 兼容，支持 PermissionRequest）', '{}', 'qoder', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('deepseek-harness', 'DeepSeek Harness', 'plugin', 1, 0, 'https://github.com/libukai/awesome-deepseek-harness', 'DSH：~/.dsh/plugins/ 宿主插件桥接（agent/status 等事件）', '{}', 'dsh', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('opencode', 'OpenCode', 'plugin', 1, 0, 'https://opencode.ai/docs/plugins', 'OpenCode：~/.config/opencode/plugins/ TS 插件桥接（session.idle 等事件）', '{}', 'opencode', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('zcode', 'ZCode', 'discovery', 1, 0, '', 'ZCode：插件市场机制提供 hooks；当前支持安装发现与进程识别，事件桥接待验证', '{}', 'zcode', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bridge', '通用桥接', 'manual', 1, 0, '', '任意 Agent 通用接入：HTTP /api/v1/events 或文件投递，source_id=bridge', '{}', 'bridge', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 既有 v0.1 来源补 adapter 标注（qoder/workbuddy 在 v0.1 为 stub，现已有官方接入方式）。
UPDATE agent_sources SET adapter = 'codex', kind = 'transport' WHERE id = 'codex';
UPDATE agent_sources SET adapter = 'qoder', kind = 'transport',
  homepage = 'https://docs.qoder.cn/qoder/hooks',
  note = 'Qoder：~/.qoder/settings.json hooks（与 CLI 兼容，支持 PermissionRequest）' WHERE id = 'qoder';
UPDATE agent_sources SET adapter = 'workbuddy', kind = 'transport',
  homepage = 'https://www.workbuddy.ai/docs/zh/cli/hooks',
  note = 'WorkBuddy / CodeBuddy：settings.json hooks（安装后需在 CLI /hooks 面板确认生效）' WHERE id = 'workbuddy';
UPDATE agent_sources SET adapter = 'mock', kind = 'mock' WHERE id = 'mock';
"#,
    ),
    (
        3,
        r#"
-- v3（Task Dock 0.3 修复版）：接入验证分层。
-- verified 收敛语义为 natural_session_verified：只有「真实通道 + 非自测会话」的事件才置位；
-- 新增 transport_verified：传输通道自身打通（Hook 自测事件即可证明通道可用，但不代表真实会话）。
ALTER TABLE agent_sources ADD COLUMN transport_verified INTEGER NOT NULL DEFAULT 0;
"#,
    ),
    (
        4,
        r#"
-- v4（Task Dock 0.4）：统一导航系统。
-- navigation_targets 是用户确认过的可信启动配置（跳转一律读库重校验，不信任前端透传路径）；
-- task_navigation_targets 让普通任务可关联任意导航目标（应用/网址/文件/目录/Agent 会话），
-- 与既有 task_agent_links 并存互补，旧表与历史数据不动。

CREATE TABLE navigation_targets (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  -- application | url | file | directory | agent_session
  target_type TEXT NOT NULL CHECK (target_type IN ('application','url','file','directory','agent_session')),
  -- 稳定应用身份：exe 绝对路径（小写）/ UWP AUMID / url 本身 / 路径本身，用于去重与重解析
  app_key TEXT NOT NULL DEFAULT '',
  exe_path TEXT NOT NULL DEFAULT '',
  launch_args TEXT NOT NULL DEFAULT '',
  working_dir TEXT NOT NULL DEFAULT '',
  -- UWP / MSIX 启动身份（shell:AppsFolder\<AUMID>）
  app_user_model_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  agent_source_id TEXT NOT NULL DEFAULT '',
  agent_session_id TEXT NOT NULL DEFAULT '',
  -- 窗口匹配提示（标题子串，如「微信」；用于 exe 不可判定时的窗口定位）
  window_title_hint TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_nav_targets_app ON navigation_targets(app_key);
CREATE INDEX idx_nav_targets_type ON navigation_targets(target_type);

CREATE TABLE task_navigation_targets (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES navigation_targets(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  -- default（按全局偏好）| focus_or_launch | launch | resume_session | open
  launch_behavior TEXT NOT NULL DEFAULT 'default' CHECK (launch_behavior IN ('default','focus_or_launch','launch','resume_session','open')),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, target_id)
);
CREATE INDEX idx_task_nav_targets ON task_navigation_targets(task_id);

-- 导航执行流水（失败记录供「应用管理」回看）
CREATE TABLE navigation_log (
  id TEXT PRIMARY KEY NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  target_name TEXT NOT NULL DEFAULT '',
  requested_action TEXT NOT NULL,
  actual_action TEXT,
  success INTEGER NOT NULL,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  verification_level TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_nav_log_created ON navigation_log(created_at);
"#,
    ),
    (
        5,
        r#"
-- v5（Task Dock 0.4 收尾）：task_agent_links 关联所有权语义。
-- origin 区分两类关联，修复「解除导航关联误删用户手工关联」的所有权冲突：
--   user = 用户手工创建（旧版 UI / link_task_agent 命令），任何自动逻辑不得删除；
--   auto = nav link_task 为旧表兼容自动补写的影子记录，随其导航关联一同解除。
-- 旧数据（v0.3 及更早）全部是手工关联，DEFAULT 'user' 保守兼容，绝不误标。
ALTER TABLE task_agent_links ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';

-- 回填：v0.4 开发版 link_task 自动补写的影子记录与导航关联在同一事务写入，
-- created_at 严格相等（同一 now_iso()），且存在同身份的 agent_session 导航目标。
-- 两个条件同时满足才标 auto；用户手工关联不会同时命中（时间戳精度为纳秒级）。
UPDATE task_agent_links SET origin = 'auto'
WHERE origin = 'user'
  AND EXISTS (
    SELECT 1 FROM task_navigation_targets nl
    JOIN navigation_targets t ON t.id = nl.target_id
    WHERE nl.task_id = task_agent_links.task_id
      AND t.target_type = 'agent_session'
      AND t.agent_source_id = task_agent_links.source_id
      AND t.agent_session_id = task_agent_links.session_external_id
      AND nl.created_at = task_agent_links.created_at
  );
"#,
    ),
    (
        6,
        r#"
-- 显式窗口身份属于任务关联，应用目标仍可复用。HWND 不持久化。
ALTER TABLE task_navigation_targets ADD COLUMN window_identity TEXT;
ALTER TABLE task_navigation_targets ADD COLUMN window_fallback TEXT NOT NULL DEFAULT 'reselect'
  CHECK (window_fallback IN ('reselect', 'focus_app', 'launch'));
"#,
    ),
    (
        7,
        r#"
-- v7（Task Dock 0.5）：智能剪贴板。
-- 图片/缩略图落文件（clipboard_assets 记录引用），文字与元数据入库；
-- 分组、组内排序、任务关联、逐项粘贴审计各有独立表。

CREATE TABLE clipboard_items (
  id TEXT PRIMARY KEY NOT NULL,
  -- text | url | html | image | files
  kind TEXT NOT NULL CHECK (kind IN ('text','url','html','image','files')),
  text TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  source_app TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  image_width INTEGER,
  image_height INTEGER,
  file_paths TEXT NOT NULL DEFAULT '[]',
  favorite INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  copy_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
-- 同一内容只保留一条；再次复制只更新时间与次数（去重策略的持久化约束）
CREATE UNIQUE INDEX idx_clip_items_hash ON clipboard_items(content_hash);
CREATE INDEX idx_clip_items_seen ON clipboard_items(last_seen_at DESC);
CREATE INDEX idx_clip_items_kind ON clipboard_items(kind, last_seen_at DESC);
CREATE INDEX idx_clip_items_fav ON clipboard_items(favorite, last_seen_at DESC);

-- 剪贴板资产：图片原始文件与缩略图（磁盘文件，不入库二进制）
CREATE TABLE clipboard_assets (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('image','thumb')),
  -- 相对剪贴板根目录的路径（根目录随应用数据目录迁移，绝对路径不落库）
  path TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (item_id, role)
);
CREATE INDEX idx_clip_assets_item ON clipboard_assets(item_id);

CREATE TABLE clipboard_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  -- auto=连续截图自动收集；manual=用户新建
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','manual')),
  -- collecting=收集会话未结束；closed=已结束
  status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','closed')),
  favorite INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_clip_groups_status ON clipboard_groups(status, updated_at DESC);

CREATE TABLE clipboard_group_items (
  group_id TEXT NOT NULL REFERENCES clipboard_groups(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  -- auto=分组引擎追加；manual=用户手动加入/拆分/合并
  origin TEXT NOT NULL DEFAULT 'auto' CHECK (origin IN ('auto','manual')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, item_id)
);
-- 不做 UNIQUE(group_id, position)：重排时中间态必然冲突，排序由事务内重写保证
CREATE INDEX idx_clip_group_pos ON clipboard_group_items(group_id, position);
CREATE INDEX idx_clip_group_item ON clipboard_group_items(item_id);

-- 任务资料关联：任务删除只级联删除关联行，剪贴板内容保留
CREATE TABLE clipboard_task_links (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('item','group')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, target_type, target_id)
);
CREATE INDEX idx_clip_task_links ON clipboard_task_links(task_id);
CREATE INDEX idx_clip_task_target ON clipboard_task_links(target_type, target_id);

-- 逐项粘贴审计：未完成项、目标窗口、验证级别（不做"粘贴成功"的虚假断言）
CREATE TABLE clipboard_paste_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  target_title TEXT NOT NULL DEFAULT '',
  target_exe TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  message TEXT NOT NULL DEFAULT '',
  remaining_items TEXT NOT NULL DEFAULT '[]',
  restored INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_clip_paste_started ON clipboard_paste_jobs(started_at DESC);
"#,
    ),
    (
        8,
        r#"
-- v8（Task Dock 0.5 性能专项）：事件保留/分页与常用查询索引。
-- 只加索引，不改既有列与数据；可在旧库上重复执行（IF NOT EXISTS）。
CREATE INDEX IF NOT EXISTS idx_events_source_received ON agent_events(source_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_received ON agent_events(session_external_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_external_id);
CREATE INDEX IF NOT EXISTS idx_events_state_received ON agent_events(state, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notification_history(is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_updated ON agent_runs(updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON agent_sessions(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_reminders_task ON task_reminders(task_id, fired);
CREATE INDEX IF NOT EXISTS idx_sources_visible ON agent_sources(hidden, enabled);
CREATE INDEX IF NOT EXISTS idx_links_session ON task_agent_links(source_id, session_external_id);
"#,
    ),
    (
        9,
        r#"
-- v9（Task Dock 0.5）：统一任务上下文三张窄表。
-- 工作现场只存元数据（窗口类名/标题/exe、文件路径、网址），不存窗口内容、不截图；
-- 删除任务不销毁现场（降级为手动快照），删除现场级联删除条目与素材关联。

CREATE TABLE workspace_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','task')),
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_restored_at TEXT,
  restore_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ws_snapshots_task ON workspace_snapshots(task_id, updated_at DESC);
CREATE INDEX idx_ws_snapshots_updated ON workspace_snapshots(updated_at DESC);

CREATE TABLE workspace_snapshot_items (
  id TEXT PRIMARY KEY NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('application','url','file','directory','agent_session')),
  display_name TEXT NOT NULL,
  target_id TEXT,
  app_key TEXT NOT NULL DEFAULT '',
  exe_path TEXT NOT NULL DEFAULT '',
  launch_args TEXT NOT NULL DEFAULT '',
  working_dir TEXT NOT NULL DEFAULT '',
  app_user_model_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  agent_source_id TEXT NOT NULL DEFAULT '',
  agent_session_id TEXT NOT NULL DEFAULT '',
  window_title_hint TEXT NOT NULL DEFAULT '',
  window_class TEXT NOT NULL DEFAULT '',
  window_title TEXT NOT NULL DEFAULT '',
  restore_note TEXT NOT NULL DEFAULT '',
  last_result TEXT NOT NULL DEFAULT '',
  last_verification TEXT NOT NULL DEFAULT '',
  last_restored_at TEXT
);
CREATE INDEX idx_ws_items_snapshot ON workspace_snapshot_items(snapshot_id, display_order);

-- 行动中心「已处理」：按事件 id 去重持久化，幂等写入
CREATE TABLE action_acks (
  event_id TEXT PRIMARY KEY NOT NULL,
  acked_at TEXT NOT NULL
);

-- 现场 ↔ 剪贴板素材：只写关联，不复制内容；素材删除即级联删除关联
CREATE TABLE clipboard_snapshot_links (
  id TEXT PRIMARY KEY NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('item','group')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (snapshot_id, target_type, target_id)
);
CREATE INDEX idx_clip_snapshot_links ON clipboard_snapshot_links(snapshot_id);
"#,
    ),
];

pub struct Db {
    /// 唯一写连接：SQLite 单写者，写事务在它上面串行化。
    writer: Mutex<Connection>,
    /// 只读连接池（WAL 快照读）；内存库为空，回退写连接。
    readers: Vec<Mutex<Connection>>,
    next_reader: AtomicUsize,
    /// 读查询延迟采样（轻量原子计数，供性能诊断；采样本身 < 1µs）。
    read_calls: AtomicU64,
    read_nanos: AtomicU64,
    read_slow: AtomicU64,
}

impl Db {
    /// 打开（或创建）数据库并执行迁移。
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        configure_writer(&conn)?;
        let mut db = Self {
            writer: Mutex::new(conn),
            readers: Vec::new(),
            next_reader: AtomicUsize::new(0),
            read_calls: AtomicU64::new(0),
            read_nanos: AtomicU64::new(0),
            read_slow: AtomicU64::new(0),
        };
        db.migrate()?;
        db.seed()?;
        db.readers = (0..READ_POOL_SIZE)
            .filter_map(|_| match open_reader(path) {
                Ok(c) => Some(Mutex::new(c)),
                Err(e) => {
                    tracing::warn!("只读连接打开失败（回退写连接读）: {}", e);
                    None
                }
            })
            .collect();
        Ok(db)
    }

    /// 内存数据库（测试用）。
    #[allow(dead_code)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self {
            writer: Mutex::new(conn),
            readers: Vec::new(),
            next_reader: AtomicUsize::new(0),
            read_calls: AtomicU64::new(0),
            read_nanos: AtomicU64::new(0),
            read_slow: AtomicU64::new(0),
        };
        db.migrate()?;
        db.seed()?;
        Ok(db)
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // 锁中毒时不 panic：前一次 panic 的连接依然可用（SQLite 连接本身未损坏）。
        self.writer.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 只读查询：优先使用读连接池；内存库回退到写连接。
    /// 注意：只读连接上禁止执行写语句（PRAGMA query_only=ON 会直接报错）。
    pub fn with_read<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        if self.readers.is_empty() {
            return self.with_conn(f);
        }
        let started = Instant::now();
        let idx = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let conn = self.readers[idx].lock().unwrap_or_else(|e| e.into_inner());
        let out = f(&conn);
        let elapsed = started.elapsed();
        self.read_calls.fetch_add(1, Ordering::Relaxed);
        self.read_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
        if elapsed.as_millis() >= 100 {
            self.read_slow.fetch_add(1, Ordering::Relaxed);
        }
        out
    }

    /// 读查询延迟摘要（诊断面板）。采样 = 一次 with_read 调用（含排队等锁）。
    pub fn read_stats(&self) -> serde_json::Value {
        let calls = self.read_calls.load(Ordering::Relaxed);
        let nanos = self.read_nanos.load(Ordering::Relaxed);
        let avg_ms = if calls == 0 {
            0.0
        } else {
            ((nanos as f64 / calls as f64) / 1_000_000.0 * 100.0).round() / 100.0
        };
        serde_json::json!({
            "pool_size": self.readers.len(),
            "calls": calls,
            "avg_ms": avg_ms,
            "slow_queries_100ms": self.read_slow.load(Ordering::Relaxed),
        })
    }

    pub fn migrate(&self) -> AppResult<()> {
        let conn = self.conn();
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        apply_migrations(&conn, current, MIGRATIONS)
    }

    /// 首次启动写入默认数据。
    fn seed(&self) -> AppResult<()> {
        let now = crate::agents::now_iso();
        let conn = self.conn();
        // 来源预置由迁移（含 v2 INSERT OR IGNORE）统一完成，避免两份清单漂移。
        // 默认设置
        let defaults: &[(&str, &str)] = &[
            ("theme", "\"system\""),
            ("mode", "\"full\""),
            ("material", "\"glass\""),
            ("snap_enabled", "true"),
            ("autostart", "false"),
            ("hotkey_enabled", "true"),
            ("http_enabled", "true"),
            ("http_port", "47821"),
            ("mock_enabled", "true"),
            ("notify_reminder", "true"),
            ("notify_agent", "true"),
            ("notify_muted", "false"),
            ("overdue_grace_hours", "24"),
            ("stale_run_minutes", "15"),
            ("auto_backup", "true"),
            ("backup_retain_days", "7"),
            // 事件接入管线与保留策略（v0.5 性能专项）
            ("ingest_queue_capacity", "1024"),
            ("ingest_batch_size", "100"),
            ("ingest_coalesce_ms", "250"),
            ("agent_event_retention_days", "30"),
            ("agent_event_max_rows", "200000"),
            ("agent_event_archive", "true"),
            ("agent_inbox_max_file_bytes", "4194304"),
            ("agent_inbox_max_files", "200"),
            ("perf_diagnostics_enabled", "true"),
            // 智能剪贴板（v0.5）
            ("clipboard_enabled", "true"),
            ("clipboard_paused", "false"),
            ("clipboard_capture_images", "true"),
            ("clipboard_capture_files", "true"),
            ("clipboard_capture_html", "true"),
            ("clipboard_auto_group", "true"),
            ("clipboard_group_window_secs", "45"),
            ("clipboard_retention_days", "30"),
            ("clipboard_max_items", "1000"),
            ("clipboard_max_storage_mb", "512"),
            (
                "clipboard_exclude_apps",
                "\"keepass.exe,keepassxc.exe,1password.exe,bitwarden.exe,lastpass.exe,dashlane.exe,enpass.exe\"",
            ),
            ("clipboard_paste_interval_ms", "350"),
            ("clipboard_paste_interval_image_ms", "1200"),
            ("clipboard_paste_interval_html_ms", "600"),
            ("clipboard_paste_interval_files_ms", "900"),
            ("clipboard_sensitive_filter", "true"),
            // 自动分组序号（内部状态，不属于用户偏好）
            ("clipboard_group_seq", "0"),
        ];
        for (k, v) in defaults {
            conn.execute(
                "INSERT OR IGNORE INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![k, v, now],
            )?;
        }
        // HTTP 接入令牌：首次启动生成随机令牌
        let has_token: i64 = conn.query_row(
            "SELECT COUNT(*) FROM application_settings WHERE key = 'http_token'",
            [],
            |r| r.get(0),
        )?;
        if has_token == 0 {
            let token = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO application_settings (key, value, updated_at) VALUES ('http_token', ?1, ?2)",
                rusqlite::params![serde_json::to_string(&token)?, now],
            )?;
        }
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<serde_json::Value>> {
        let conn = self.conn();
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM application_settings WHERE key = ?1",
                rusqlite::params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw.map(|s| serde_json::from_str(&s).unwrap_or(serde_json::Value::Null)))
    }

    pub fn set_setting(&self, key: &str, value: serde_json::Value) -> AppResult<()> {
        let now = crate::agents::now_iso();
        let conn = self.conn();
        conn.execute(
            "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![key, serde_json::to_string(&value)?, now],
        )?;
        Ok(())
    }

    /// 读取全部设置为 JSON 对象（前端一次性获取）。
    pub fn all_settings(&self) -> AppResult<serde_json::Value> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, value FROM application_settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (k, v) = row?;
            map.insert(
                k,
                serde_json::from_str(&v).unwrap_or(serde_json::Value::Null),
            );
        }
        Ok(serde_json::Value::Object(map))
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.conn();
        f(&conn)
    }
}

fn configure_writer(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

fn open_reader(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "query_only", true)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

// rusqlite optional 扩展
use rusqlite::OptionalExtension;

/// 按序应用迁移：每一步迁移 SQL 与 user_version 更新在同一个事务内原子提交。
///
/// 修复缺陷：此前 execute_batch 与 pragma_update 是两条独立语句，迁移中途失败
/// （磁盘满/进程被杀）会留下「半套 DDL + 旧 user_version」，下次启动重放迁移
/// 必然撞「table already exists」，数据库永久打不开。原子化后失败整体回滚，
/// user_version 不变，可安全重试。
pub fn apply_migrations(
    conn: &Connection,
    current: i64,
    migrations: &[(i64, &str)],
) -> AppResult<()> {
    for (version, sql) in migrations {
        if *version > current {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let applied = conn
                .execute_batch(sql)
                .and_then(|_| conn.pragma_update(None, "user_version", *version));
            match applied {
                Ok(()) => {
                    conn.execute_batch("COMMIT")?;
                    tracing::info!("数据库迁移至 v{}", version);
                }
                Err(e) => {
                    // 回滚失败的迁移：schema 与 user_version 均保持迁移前状态
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(AppError::from(e));
                }
            }
        }
    }
    Ok(())
}

/// 前端设置对象（与 application_settings 键一一对应，缺失走默认值）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    /// 窗口材质：solid（不透明）| glass（毛玻璃，不支持时自动回退 solid）
    #[serde(default = "default_material")]
    pub material: String,
    #[serde(default = "default_true")]
    pub snap_enabled: bool,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default = "default_true")]
    pub hotkey_enabled: bool,
    #[serde(default = "default_true")]
    pub http_enabled: bool,
    #[serde(default = "default_http_port")]
    pub http_port: u16,
    #[serde(default)]
    pub http_token: String,
    #[serde(default = "default_true")]
    pub mock_enabled: bool,
    #[serde(default = "default_true")]
    pub notify_reminder: bool,
    #[serde(default = "default_true")]
    pub notify_agent: bool,
    #[serde(default)]
    pub notify_muted: bool,
    #[serde(default = "default_grace")]
    pub overdue_grace_hours: u32,
    #[serde(default = "default_stale")]
    pub stale_run_minutes: u32,
    #[serde(default = "default_true")]
    pub auto_backup: bool,
    #[serde(default = "default_retain")]
    pub backup_retain_days: u32,
    // ── 事件接入管线 / 保留 / 诊断（v0.5 性能专项；带默认值，旧库无需迁移键）──
    /// 有界队列容量（事件数）
    #[serde(default = "default_ingest_capacity")]
    pub ingest_queue_capacity: usize,
    /// 单事务最大事件数
    #[serde(default = "default_ingest_batch")]
    pub ingest_batch_size: usize,
    /// 合并窗口（毫秒，200~500）
    #[serde(default = "default_ingest_coalesce")]
    pub ingest_coalesce_ms: u64,
    /// agent_events 保留天数（0 = 不按时间清理）
    #[serde(default = "default_event_retention")]
    pub agent_event_retention_days: u32,
    /// agent_events 最大行数（0 = 不按行数清理）
    #[serde(default = "default_event_max_rows")]
    pub agent_event_max_rows: u64,
    /// 清理前是否先归档为 JSONL（默认开启；不静默丢弃历史）
    #[serde(default = "default_true")]
    pub agent_event_archive: bool,
    /// 文件投递单文件上限（字节）
    #[serde(default = "default_inbox_max_file")]
    pub agent_inbox_max_file_bytes: u64,
    /// 文件投递每轮最多处理的文件数
    #[serde(default = "default_inbox_max_files")]
    pub agent_inbox_max_files: usize,
    /// 性能诊断采集开关（关闭后仅保留最小计数，不采样延迟分位）
    #[serde(default = "default_true")]
    pub perf_diagnostics_enabled: bool,
    // ── 导航偏好（v0.4；全部带默认值，旧库无键也能反序列化）──
    /// 优先唤醒现有窗口（而非重复启动）
    #[serde(default = "default_true")]
    pub nav_prefer_focus: bool,
    /// 允许启动未运行的程序（关闭后仅唤醒已有窗口）
    #[serde(default = "default_true")]
    pub nav_allow_launch: bool,
    /// 精准跳转失败时按层级降级（关闭则直接报错）
    #[serde(default = "default_true")]
    pub nav_fallback: bool,
    /// 记住上次选择的窗口（多窗口应用）
    #[serde(default = "default_true")]
    pub nav_remember_window: bool,
    /// 默认浏览器 app_key（空 = 系统默认浏览器）
    #[serde(default)]
    pub nav_default_browser: String,
    /// 工作区批量启动数量上限
    #[serde(default = "default_workspace_max")]
    pub nav_workspace_max: u32,
    // ── 智能剪贴板（v0.5；全部带默认值，旧库无键也能反序列化）──
    /// 全局监听开关（关闭后不再记录任何新的剪贴板内容）
    #[serde(default = "default_true")]
    pub clipboard_enabled: bool,
    /// 临时暂停（与 enabled 区分：恢复时保留用户的总开关偏好）
    #[serde(default)]
    pub clipboard_paused: bool,
    #[serde(default = "default_true")]
    pub clipboard_capture_images: bool,
    #[serde(default = "default_true")]
    pub clipboard_capture_files: bool,
    #[serde(default = "default_true")]
    pub clipboard_capture_html: bool,
    /// 连续截图自动分组
    #[serde(default = "default_true")]
    pub clipboard_auto_group: bool,
    /// 连续截图分组窗口（秒）
    #[serde(default = "default_clip_group_window")]
    pub clipboard_group_window_secs: u32,
    /// 非收藏条目的保留天数
    #[serde(default = "default_clip_retention")]
    pub clipboard_retention_days: u32,
    /// 最大条目数（非收藏、非置顶）
    #[serde(default = "default_clip_max_items")]
    pub clipboard_max_items: u32,
    /// 资产最大占用（MB）
    #[serde(default = "default_clip_max_storage")]
    pub clipboard_max_storage_mb: u32,
    /// 应用排除名单（小写 exe 名，逗号/换行分隔）
    #[serde(default = "default_clip_exclude")]
    pub clipboard_exclude_apps: String,
    /// 逐项粘贴的步骤间隔（毫秒）；文本/链接基准值
    #[serde(default = "default_clip_paste_interval")]
    pub clipboard_paste_interval_ms: u32,
    /// 图片粘贴间隔：目标应用解码大图更慢，默认更保守
    #[serde(default = "default_clip_paste_image_interval")]
    pub clipboard_paste_interval_image_ms: u32,
    /// 富文本粘贴间隔
    #[serde(default = "default_clip_paste_html_interval")]
    pub clipboard_paste_interval_html_ms: u32,
    /// 文件列表粘贴间隔
    #[serde(default = "default_clip_paste_files_interval")]
    pub clipboard_paste_interval_files_ms: u32,
    /// 高置信敏感内容过滤（如 PEM 私钥）；不宣称能识别全部密码/令牌
    #[serde(default = "default_true")]
    pub clipboard_sensitive_filter: bool,
}

fn default_theme() -> String {
    "system".into()
}
fn default_mode() -> String {
    "full".into()
}
fn default_material() -> String {
    "glass".into()
}
fn default_true() -> bool {
    true
}
fn default_http_port() -> u16 {
    47821
}
fn default_grace() -> u32 {
    24
}
fn default_stale() -> u32 {
    15
}
fn default_retain() -> u32 {
    7
}
fn default_ingest_capacity() -> usize {
    1024
}
fn default_ingest_batch() -> usize {
    100
}
fn default_ingest_coalesce() -> u64 {
    250
}
fn default_event_retention() -> u32 {
    30
}
fn default_event_max_rows() -> u64 {
    200_000
}
fn default_inbox_max_file() -> u64 {
    4 * 1024 * 1024
}
fn default_inbox_max_files() -> usize {
    200
}
fn default_workspace_max() -> u32 {
    8
}
fn default_clip_group_window() -> u32 {
    45
}
fn default_clip_retention() -> u32 {
    30
}
fn default_clip_max_items() -> u32 {
    1000
}
fn default_clip_max_storage() -> u32 {
    512
}
fn default_clip_exclude() -> String {
    "keepass.exe,keepassxc.exe,1password.exe,bitwarden.exe,lastpass.exe,dashlane.exe,enpass.exe"
        .into()
}
fn default_clip_paste_interval() -> u32 {
    350
}
fn default_clip_paste_image_interval() -> u32 {
    1200
}
fn default_clip_paste_html_interval() -> u32 {
    600
}
fn default_clip_paste_files_interval() -> u32 {
    900
}

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_value(serde_json::json!({})).expect("Settings 默认值可反序列化")
    }
}

impl Settings {
    pub fn load(db: &Db) -> AppResult<Self> {
        let raw = db.all_settings()?;
        let s: Settings = serde_json::from_value(raw).unwrap_or_default();
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    #[test]
    fn v5_to_v6_preserves_links_and_defaults_to_reselection() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        apply_migrations(&conn, 0, &MIGRATIONS[..5]).unwrap();
        conn.execute("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('task', '任务', 'now', 'now')", []).unwrap();
        conn.execute("INSERT INTO navigation_targets (id, display_name, target_type, app_key, created_at, updated_at) VALUES ('target', '浏览器', 'application', 'browser', 'now', 'now')", []).unwrap();
        conn.execute("INSERT INTO task_navigation_targets (id, task_id, target_id, created_at) VALUES ('link', 'task', 'target', 'now')", []).unwrap();
        apply_migrations(&conn, 5, MIGRATIONS).unwrap();
        let (identity, fallback): (Option<String>, String) = conn.query_row("SELECT window_identity, window_fallback FROM task_navigation_targets WHERE id = 'link'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert!(identity.is_none());
        assert_eq!(fallback, "reselect");
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            MIGRATIONS[MIGRATIONS.len() - 1].0,
            "迁移应推进到最新版本（不依赖写死的版本号）"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }

    #[test]
    fn v1_to_v2_upgrade_preserves_data_and_fixes_run_ids() {
        let dir = std::env::temp_dir().join(format!("td-mig-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            // 构造 v0.1 数据库：仅执行迁移 v1 + 手工预置数据
            conn.execute_batch(MIGRATIONS[0].1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            let now = "2026-10-20T10:00:00+00:00";
            conn.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('t1', '旧任务', '', 1, 'pending', '', '[]', 0, ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_sources (id, display_name, kind, enabled, verified, homepage, note, config, created_at, updated_at)
                 VALUES ('codex', 'Codex CLI', 'transport', 1, 1, '', '', '{}', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess1', 'codex', 'old-sess', '旧会话', 'running', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            // v0.1 缺陷现场：缺失 run_id 被写成空字符串
            conn.execute(
                "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, task_title, status, started_at, updated_at, pending_items, meta)
                 VALUES ('run1', 'sess1', 'codex', '', '旧轮次', 'completed', ?1, ?1, '[]', '{}')",
                rusqlite::params![now],
            )
            .unwrap();
        }
        // 重新打开 → 应用迁移 v2/v3
        let db = Db::open(&path).unwrap();
        let version: i64 = db
            .with_conn(|c| {
                c.query_row("PRAGMA user_version", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64, "应依次迁移至最新版");
        // v3：transport_verified 分层验证列已加入
        let cols: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('agent_sources') WHERE name = 'transport_verified'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(cols, 1, "v3 应添加 transport_verified 列");
        // 旧任务保留
        let title: String = db
            .with_conn(|c| {
                c.query_row("SELECT title FROM tasks WHERE id = 't1'", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(title, "旧任务");
        // 空字符串 run_id 修复为 NULL
        let ext: Option<String> = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT external_run_id FROM agent_runs WHERE id = 'run1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(ext.is_none(), "空字符串 run_id 应修复为 NULL");
        // P1-5：无真实联调证据的 verified 一律重置
        let verified: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT verified FROM agent_sources WHERE id = 'codex'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(verified, 0);
        // 新来源已注册
        let n: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM agent_sources", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert!(n >= 9, "新来源已并入（mock/7 Agent/bridge），实际 {}", n);
        // 新表可用
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO agent_instances (id, source_id, instance_key, first_seen_at, last_seen_at)
                 VALUES ('i1', 'codex', 'proc-1', '2026-10-25T10:00:00+00:00', '2026-10-25T10:00:00+00:00')",
                [],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// v4（0.4 统一导航）：从 v3 库升级 —— 新表齐备、旧数据原样、task_agent_links 兼容并存。
    #[test]
    fn v3_to_v4_upgrade_adds_navigation_tables_and_keeps_old_links() {
        let dir = std::env::temp_dir().join(format!("td-mig4-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let db = Db::open(&path).unwrap(); // 全新库 → v4
            let now = "2026-10-26T09:00:00+00:00";
            // 构造 v3 时代的旧数据：任务 + Agent 会话 + 旧式关联
            db.with_conn(|c| {
                c.execute(
                    "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                     VALUES ('t1', '旧任务', '', 2, 'pending', '', '[]', 0, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                c.execute(
                    "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                     VALUES ('sess1', 'codex', 'old-sess', '旧会话', 'running', ?1, ?1)",
                    rusqlite::params![now],
                )?;
                c.execute(
                    "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, created_at)
                     VALUES ('l1', 't1', 'codex', 'old-sess', ?1)",
                    rusqlite::params![now],
                )?;
                Ok::<_, AppError>(())
            })
            .unwrap();
        }
        // 重新打开（幂等重放已迁移库不应再执行任何迁移）
        let db2 = Db::open(&path).unwrap();
        let version: i64 = db2
            .with_conn(|c| {
                c.query_row("PRAGMA user_version", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        // 旧关联原样保留
        let old_links: i64 = db2
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(old_links, 1, "旧 Agent 关联不得被迁移触碰");
        // 新表可写且约束生效
        db2.with_conn(|c| {
            c.execute(
                "INSERT INTO navigation_targets (id, display_name, target_type, app_key, created_at, updated_at)
                 VALUES ('n1', 'GitHub', 'url', 'https://github.com', ?1, ?1)",
                rusqlite::params!["2026-10-26T09:05:00+00:00"],
            )?;
            c.execute(
                "INSERT INTO task_navigation_targets (id, task_id, target_id, display_order, is_default, launch_behavior, created_at)
                 VALUES ('nl1', 't1', 'n1', 0, 1, 'open', '2026-10-26T09:05:00+00:00')",
                [],
            )?;
            // 同任务同目标唯一
            let dup = c.execute(
                "INSERT INTO task_navigation_targets (id, task_id, target_id, created_at)
                 VALUES ('nl2', 't1', 'n1', '2026-10-26T09:06:00+00:00')",
                [],
            );
            assert!(dup.is_err(), "UNIQUE(task_id, target_id) 必须生效");
            // 非法 launch_behavior 被 CHECK 拒绝
            let bad = c.execute(
                "INSERT INTO task_navigation_targets (id, task_id, target_id, launch_behavior, created_at)
                 VALUES ('nl3', 't1', 'n1', 'evil', '2026-10-26T09:06:00+00:00')",
                [],
            );
            assert!(bad.is_err(), "launch_behavior CHECK 必须生效");
            // 级联：删任务 → 新旧关联同时消失
            c.execute("DELETE FROM tasks WHERE id = 't1'", [])?;
            let nl: i64 =
                c.query_row("SELECT COUNT(*) FROM task_navigation_targets", [], |r| r.get(0))?;
            let ol: i64 =
                c.query_row("SELECT COUNT(*) FROM task_agent_links", [], |r| r.get(0))?;
            assert_eq!((nl, ol), (0, 0), "任务删除应级联清理两种关联");
            Ok::<_, AppError>(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migration_failure_rolls_back_atomically_and_can_retry() {
        // 迁移 SQL 中途失败：DDL + user_version 必须整体回滚，重试可成功
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let broken: &[(i64, &str)] = &[
            (1, MIGRATIONS[0].1),
            (
                2,
                "CREATE TABLE partial_step (id TEXT PRIMARY KEY);
                 CREATE TABLE partial_step (id TEXT PRIMARY KEY);", // 第二条必失败
            ),
        ];
        conn.execute_batch("BEGIN").unwrap();
        conn.execute_batch(MIGRATIONS[0].1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute_batch("COMMIT").unwrap();

        let err = apply_migrations(&conn, 1, broken).unwrap_err();
        assert!(!err.to_string().is_empty());
        // user_version 未推进
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1, "失败的迁移不得推进 user_version");
        // 半套 DDL 已回滚：v2 特有表不存在
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_instances'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 0, "失败迁移创建的表必须回滚");
        // 修复后重试（真实迁移列表）成功
        apply_migrations(&conn, 1, MIGRATIONS).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS[MIGRATIONS.len() - 1].0);
    }

    #[test]
    fn v3_adds_transport_verified_column() {
        let db = Db::open_in_memory().unwrap();
        let n: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('agent_sources') WHERE name = 'transport_verified'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 1, "v3 必须新增 transport_verified 列");
    }

    /// v5：task_agent_links.origin 所有权语义。
    /// 手工关联（无同时间戳的导航关联）保持 user；v0.4-dev 自动补写的影子记录
    /// （created_at 与导航关联严格相等 + 同身份会话目标存在）回填为 auto。
    #[test]
    fn v5_backfills_auto_compat_links_and_keeps_user_links() {
        let dir = std::env::temp_dir().join(format!("td-mig5-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            // 构造 v4 库：一条手工关联（v0.3 语义）+ 一条 v0.4-dev 自动影子记录
            let db = Db::open(&path).unwrap(); // 全新库 → 迁移到 v4（此时 MIGRATIONS 已含 v5，需手动降级构造）
            db.with_conn(|c| {
                // 手动把库降回 v4（模拟升级前状态）：v5/v6 的列、v7 的剪贴板表先撤销
                c.execute_batch(
                    "ALTER TABLE task_navigation_targets DROP COLUMN window_fallback;
                     ALTER TABLE task_navigation_targets DROP COLUMN window_identity;
                     ALTER TABLE task_agent_links DROP COLUMN origin;
                     DROP TABLE clipboard_group_items;
                     DROP TABLE clipboard_assets;
                     DROP TABLE clipboard_task_links;
                     DROP TABLE clipboard_paste_jobs;
                     DROP TABLE clipboard_groups;
                     DROP TABLE clipboard_items;
                     DROP TABLE clipboard_snapshot_links;
                     DROP TABLE workspace_snapshot_items;
                     DROP TABLE workspace_snapshots;
                     DROP TABLE action_acks;
                     PRAGMA user_version = 4;",
                )?;
                Ok::<_, AppError>(())
            })
            .unwrap();
            let now_auto = "2026-10-27T08:00:00.123456789+00:00";
            let now_user = "2026-10-20T08:00:00+00:00";
            db.with_conn(|c| {
                c.execute(
                    "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                     VALUES ('t1','任务','',2,'pending','','[]',0,?1,?1)",
                    rusqlite::params![now_user],
                )?;
                c.execute(
                    "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                     VALUES ('t2','任务2','',2,'pending','','[]',0,?1,?1)",
                    rusqlite::params![now_user],
                )?;
                c.execute(
                    "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                     VALUES ('s1','codex','sess-1','会话','running',?1,?1)",
                    rusqlite::params![now_user],
                )?;
                // 手工关联（v0.3 时间戳，无导航关联）
                c.execute(
                    "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, created_at)
                     VALUES ('l-user','t1','codex','sess-1',?1)",
                    rusqlite::params![now_user],
                )?;
                // v0.4-dev 自动影子记录：created_at 与导航关联严格相等
                c.execute(
                    "INSERT INTO navigation_targets (id, display_name, target_type, app_key, agent_source_id, agent_session_id, created_at, updated_at)
                     VALUES ('nt1','会话','agent_session','codex:sess-1','codex','sess-1',?1,?1)",
                    rusqlite::params![now_auto],
                )?;
                c.execute(
                    "INSERT INTO task_navigation_targets (id, task_id, target_id, display_order, is_default, launch_behavior, created_at)
                     VALUES ('nl1','t2','nt1',0,0,'default',?1)",
                    rusqlite::params![now_auto],
                )?;
                c.execute(
                    "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, created_at)
                     VALUES ('l-auto','t2','codex','sess-1',?1)",
                    rusqlite::params![now_auto],
                )?;
                Ok::<_, AppError>(())
            })
            .unwrap();
        }
        // 重新打开 → 应用 v5 迁移
        let db = Db::open(&path).unwrap();
        let origin_of = |id: &str| -> AppResult<String> {
            db.with_conn(|c| {
                c.query_row(
                    "SELECT origin FROM task_agent_links WHERE id = ?1",
                    rusqlite::params![id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
        };
        assert_eq!(
            origin_of("l-user").unwrap(),
            "user",
            "手工关联必须保持 user"
        );
        assert_eq!(
            origin_of("l-auto").unwrap(),
            "auto",
            "同事务影子记录应回填为 auto"
        );
        // 幂等：再次打开不重复回填/报错
        let db2 = Db::open(&path).unwrap();
        let n: i64 = db2
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(n, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clipboard_paste_intervals_keep_conservative_defaults() {
        let s = Settings::default();
        assert_eq!(s.clipboard_paste_interval_ms, 350);
        assert_eq!(s.clipboard_paste_interval_html_ms, 600);
        assert_eq!(s.clipboard_paste_interval_files_ms, 900);
        assert_eq!(s.clipboard_paste_interval_image_ms, 1200);
    }
}
