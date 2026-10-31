//! SQLite 连接管理、迁移与设置存储。
pub mod models;
pub use models::*;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use rusqlite::{Connection, TransactionBehavior};
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
    (
        10,
        r#"
-- v10（Task Dock 0.5.1）：事件因果顺序水位。
-- ingest_seq 由服务端受理时分配（客户端不可设置）；agent_runs.last_ingest_seq
-- 记录该轮次已应用的最大序号，旧序号事件只入流水、不覆盖新状态。
-- 默认 0 表示旧数据/旧备份，不参与顺序屏障（保持既有行为）。
ALTER TABLE agent_runs ADD COLUMN last_ingest_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_events ADD COLUMN ingest_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_events_ingest_seq ON agent_events(ingest_seq);
"#,
    ),
    (
        11,
        r#"
-- v11（Task Dock 0.5.1）：轮次已应用事件时间水位。
-- 文件积压、离线 Hook、跨通道延迟会把旧事件排到新事件之后受理；
-- 除受理序号外再用事件时间兜底：比水位更旧的事件只入流水，不回退状态。
-- 空字符串表示旧数据，未建立水位（保持既有行为）。
ALTER TABLE agent_runs ADD COLUMN last_event_at TEXT NOT NULL DEFAULT '';
"#,
    ),
    (
        12,
        r#"
-- v12（Task Dock 0.5.2）：事件来源可信分类与测试数据隔离。
-- category 由服务端来源注册表维护；origin 由摄取入口按「来源类别 + 服务端判定的
-- 传输通道 + 自测会话前缀」确定，客户端载荷无法把测试/压测事件标成真实事件。
-- 默认 'real' 只用于旧数据，随后由 backfill_origin_labels() 修正可证明的测试数据。
ALTER TABLE agent_sources ADD COLUMN category TEXT NOT NULL DEFAULT 'real';
ALTER TABLE agent_events ADD COLUMN origin TEXT NOT NULL DEFAULT 'real';
ALTER TABLE agent_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'real';
ALTER TABLE agent_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'real';
ALTER TABLE agent_instances ADD COLUMN origin TEXT NOT NULL DEFAULT 'real';
ALTER TABLE notification_history ADD COLUMN agent_origin TEXT NOT NULL DEFAULT 'real';

-- 内部压测来源：隐藏、不可在来源列表中选择，事件与真实状态/行动中心/系统通知隔离。
INSERT OR IGNORE INTO agent_sources
  (id, display_name, kind, enabled, verified, homepage, note, config, adapter, icon, hidden, category, created_at, updated_at)
VALUES
  ('bench', '性能基准（内部）', 'benchmark', 1, 0, '',
   '仅用于性能/压力测试：事件与真实 Agent 状态、行动中心、系统通知隔离，可在数据审计中单独清理',
   '{}', 'benchmark', '', 1, 'benchmark',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE agent_sources SET category = 'mock' WHERE kind = 'mock' OR id = 'mock';

CREATE INDEX IF NOT EXISTS idx_sources_category ON agent_sources(category);
CREATE INDEX IF NOT EXISTS idx_events_origin_received ON agent_events(origin, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_run_latest ON agent_events(source_id, run_external_id, ingest_seq DESC);
CREATE INDEX IF NOT EXISTS idx_runs_origin_status ON agent_runs(origin, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_origin_updated ON agent_runs(origin, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_origin_last ON agent_sessions(origin, last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_instances_origin_last ON agent_instances(origin, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_origin_created ON notification_history(agent_origin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread_origin ON notification_history(is_read, agent_origin, created_at DESC);
"#,
    ),
    (
        13,
        r#"
-- v13（Task Dock 0.5.2）：历史 keyset 分页索引。
-- 历史时间轴按 (received_at/created_at DESC, id DESC) 翻页，并要求来源/时间筛选
-- 与游标使用同一口径；复合索引避免深页排序、以及"筛选后翻页"退化为全表扫描。
CREATE INDEX IF NOT EXISTS idx_events_origin_received_id
  ON agent_events(origin, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_origin_source_received_id
  ON agent_events(origin, source_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_origin_created_id
  ON notification_history(agent_origin, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_origin_kind_created_id
  ON notification_history(agent_origin, kind, created_at DESC, id DESC);
"#,
    ),
    (
        14,
        r#"
-- v14（Task Dock 0.5.3）：DSH 宿主插件机制修正。
-- ~/.dsh/plugins/ 只是客户端插件位；宿主插件必须以 profile bundle 形式安装
-- （package.json 声明 dsh.bundle.patch + 登记进 profile 的 dsh.profile.bundles）。
-- 来源说明同步为真实机制，避免用户误以为「放进 plugins 目录即生效」。
UPDATE agent_sources
SET note = 'DSH：宿主插件须以 profile bundle 安装（~/.dsh/profiles/<profile>/node_modules + dsh.profile.bundles），桥接 agent/status 等事件',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = 'deepseek-harness';
"#,
    ),
];

/// 历史测试数据的保守回填（幂等）。
///
/// 只标记「可证明」的测试数据：压测脚本固定使用 `http-perf-` 会话/轮次前缀且
/// 会话与轮次必须同时命中；自测会话使用保留前缀；mock 来源整体隔离。
/// 不满足组合条件的行保持 `real`，由数据审计报告列为「需人工确认」，绝不误删。
pub fn backfill_origin_labels(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
-- 来源类别
UPDATE agent_sources SET category = 'mock' WHERE (kind = 'mock' OR id = 'mock') AND category = 'real';
UPDATE agent_sources SET category = 'benchmark' WHERE id = 'bench' AND category = 'real';

-- 事件：先自测，再压测（要求 session/run 双前缀），最后 mock 来源覆盖
UPDATE agent_events SET origin = 'selftest'
WHERE origin = 'real' AND session_external_id LIKE 'taskdock-selftest-%';
UPDATE agent_events SET origin = 'benchmark'
WHERE origin = 'real' AND source_id <> 'mock'
  AND session_external_id LIKE 'http-perf-%' AND run_external_id LIKE 'http-perf-%';
UPDATE agent_events SET origin = 'mock' WHERE origin = 'real' AND source_id = 'mock';
UPDATE agent_events SET origin = 'benchmark' WHERE origin = 'real' AND source_id = 'bench';

-- 会话：压测会话必须存在同来源、同会话的 http-perf 轮次作为佐证
UPDATE agent_sessions SET origin = 'mock' WHERE origin = 'real' AND source_id = 'mock';
UPDATE agent_sessions SET origin = 'selftest'
WHERE origin = 'real' AND external_id LIKE 'taskdock-selftest-%';
UPDATE agent_sessions SET origin = 'benchmark'
WHERE origin = 'real' AND source_id <> 'mock' AND external_id LIKE 'http-perf-%'
  AND EXISTS (
    SELECT 1 FROM agent_runs r
    WHERE r.session_id = agent_sessions.id AND r.external_run_id LIKE 'http-perf-%'
  );
UPDATE agent_sessions SET origin = 'benchmark' WHERE origin = 'real' AND source_id = 'bench';

-- 轮次
UPDATE agent_runs SET origin = 'mock' WHERE origin = 'real' AND source_id = 'mock';
UPDATE agent_runs SET origin = 'selftest'
WHERE origin = 'real' AND EXISTS (
  SELECT 1 FROM agent_sessions s
  WHERE s.id = agent_runs.session_id AND s.external_id LIKE 'taskdock-selftest-%'
);
UPDATE agent_runs SET origin = 'benchmark'
WHERE origin = 'real' AND source_id <> 'mock' AND external_run_id LIKE 'http-perf-%'
  AND EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = agent_runs.session_id AND s.external_id LIKE 'http-perf-%'
  );
UPDATE agent_runs SET origin = 'benchmark' WHERE origin = 'real' AND source_id = 'bench';

-- 实例：来源可证明，或只被压测轮次引用且从未被真实轮次引用
UPDATE agent_instances SET origin = 'mock' WHERE origin = 'real' AND source_id = 'mock';
UPDATE agent_instances SET origin = 'benchmark' WHERE origin = 'real' AND source_id = 'bench';
UPDATE agent_instances SET origin = 'benchmark'
WHERE origin = 'real' AND source_id <> 'mock'
  AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.instance_id = agent_instances.id AND r.origin = 'benchmark')
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.instance_id = agent_instances.id AND r.origin = 'real');

-- 通知：按所属轮次的 origin 归类；轮次已删除的通知无法证明，保持 real 待人工确认
UPDATE notification_history SET agent_origin = COALESCE(
  (SELECT r.origin FROM agent_runs r WHERE r.id = notification_history.ref_id), agent_origin
) WHERE ref_type = 'agent_run' AND agent_origin = 'real';

-- 旧版按事件 ID 的「已处理」映射到轮次级稳定 ID（保留审计记录，不删除旧行）
INSERT OR IGNORE INTO action_acks (event_id, acked_at)
SELECT 'run:' || r.id, a.acked_at
FROM action_acks a
JOIN agent_events e ON e.id = a.event_id
JOIN agent_runs r ON r.source_id = e.source_id AND r.external_run_id = e.run_external_id
WHERE e.run_external_id IS NOT NULL
  AND a.event_id NOT LIKE 'run:%'
  AND a.event_id NOT LIKE 'notification:%'
  AND r.origin = 'real';
"#,
    )?;
    Ok(())
}

pub struct Db {
    /// 唯一写连接：SQLite 单写者，写事务在它上面串行化。
    writer: Mutex<Connection>,
    /// 只读连接池（WAL 快照读）；内存库为空，回退写连接。
    readers: Vec<Mutex<Connection>>,
    /// 数据库文件路径（内存库为 None），用于诊断 WAL/主库文件大小。
    path: Option<std::path::PathBuf>,
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
        let prior_version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        let mut db = Self {
            writer: Mutex::new(conn),
            readers: Vec::new(),
            path: Some(path.to_path_buf()),
            next_reader: AtomicUsize::new(0),
            read_calls: AtomicU64::new(0),
            read_nanos: AtomicU64::new(0),
            read_slow: AtomicU64::new(0),
        };
        db.migrate()?;
        db.seed(prior_version)?;
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
            path: None,
            next_reader: AtomicUsize::new(0),
            read_calls: AtomicU64::new(0),
            read_nanos: AtomicU64::new(0),
            read_slow: AtomicU64::new(0),
        };
        db.migrate()?;
        db.seed(0)?;
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
        let start = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        // 跳过被长快照读占用的连接（如完整备份），否则普通查询会排队等整个备份结束。
        // 全部繁忙时仍阻塞在起始连接上（不失败，保持旧行为）。
        let mut conn = None;
        for offset in 0..self.readers.len() {
            match self.readers[(start + offset) % self.readers.len()].try_lock() {
                Ok(guard) => {
                    conn = Some(guard);
                    break;
                }
                Err(std::sync::TryLockError::Poisoned(e)) => {
                    conn = Some(e.into_inner());
                    break;
                }
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
        }
        let conn = match conn {
            Some(guard) => guard,
            None => self.readers[start]
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        };
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

    /// SQLite 文件与缓存诊断：页缓存/空闲页/WAL 大小，用于区分「SQLite 缓存增长」与其他内存。
    /// 只读 PRAGMA，不改变任何状态。
    pub fn storage_stats(&self) -> serde_json::Value {
        let pragmas = self
            .with_read(|conn| {
                let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
                let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
                let freelist: i64 =
                    conn.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
                let cache_size: i64 = conn.query_row("PRAGMA cache_size", [], |r| r.get(0))?;
                let journal: String =
                    conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
                let autockpt: i64 = conn
                    .query_row("PRAGMA wal_autocheckpoint", [], |r| r.get(0))
                    .unwrap_or(-1);
                Ok(serde_json::json!({
                    "page_count": page_count,
                    "page_size": page_size,
                    "freelist_pages": freelist,
                    "cache_size": cache_size,
                    "cache_kib": if cache_size < 0 { -cache_size } else { cache_size * page_size / 1024 },
                    "journal_mode": journal,
                    "wal_autocheckpoint_pages": autockpt,
                }))
            })
            .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }));
        let size_of = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let (db_bytes, wal_bytes, shm_bytes) = match &self.path {
            Some(p) => {
                let wal = std::path::PathBuf::from(format!("{}-wal", p.display()));
                let shm = std::path::PathBuf::from(format!("{}-shm", p.display()));
                (size_of(p), size_of(&wal), size_of(&shm))
            }
            None => (0, 0, 0),
        };
        serde_json::json!({
            "read_pool": self.readers.len(),
            "db_bytes": db_bytes,
            "wal_bytes": wal_bytes,
            "shm_bytes": shm_bytes,
            "pragma": pragmas,
            "read": self.read_stats(),
        })
    }

    /// 库内已应用的最大事件受理序号（启动/恢复备份后抬高全局序号起点）。
    pub fn max_ingest_seq(&self) -> AppResult<u64> {
        self.with_read(|conn| {
            conn.query_row(
                "SELECT COALESCE(MAX(last_ingest_seq), 0) FROM agent_runs",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v.max(0) as u64)
            .map_err(AppError::from)
        })
    }

    pub fn migrate(&self) -> AppResult<()> {
        let conn = self.conn();
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        apply_migrations(&conn, current, MIGRATIONS)?;
        // v12 一次性回填：只在首次升级时扫描历史；导入备份后由 data 模块显式重跑。
        let backfilled: Option<String> = conn
            .query_row(
                "SELECT value FROM application_settings WHERE key = 'origin_backfill_v12'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if backfilled.is_none() {
            backfill_origin_labels(&conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('origin_backfill_v12', 'true', ?1)",
                rusqlite::params![crate::agents::now_iso()],
            )?;
            tracing::info!("已回填事件来源分类（v12）");
        }
        Ok(())
    }

    /// 首次启动写入默认数据。
    ///
    /// `prior_version` 是迁移前的 `PRAGMA user_version`：0 表示全新库，
    /// < 7 表示从没有剪贴板模块的旧版本升级。剪贴板键不再每次启动补齐，
    /// 否则用户配置丢失会被默认值静默覆盖（详见 `seed_clipboard_config`）。
    fn seed(&self, prior_version: i64) -> AppResult<()> {
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
            ("notify_burst_max", "3"),
            ("notify_rate_window_secs", "60"),
            ("notify_done_aggregate", "true"),
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
        seed_clipboard_config(&conn, prior_version)?;
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

    /// 原始键值读取：保留 JSON 损坏的字符串，供剪贴板配置做 fail-closed 判断。
    ///
    /// `all_settings` 会把非法 JSON 静默转成 Null，无法区分「键缺失」「值损坏」
    /// 与「数据库读取失败」；剪贴板隐私开关不能建立在这种有损视图上。
    pub fn all_settings_raw(&self) -> AppResult<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, value FROM application_settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_setting_raw(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn();
        conn.query_row(
            "SELECT value FROM application_settings WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.conn();
        f(&conn)
    }
}

/// 事务内写入设置：缺失时插入，已存在时覆盖。
fn put_setting(
    conn: &Connection,
    key: &str,
    value: &serde_json::Value,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, serde_json::to_string(value)?, now],
    )?;
    Ok(())
}

/// 事务内写入设置：已存在时不覆盖（初始化专用）。
fn insert_setting_if_absent(
    conn: &Connection,
    key: &str,
    value: &serde_json::Value,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![key, serde_json::to_string(value)?, now],
    )?;
    Ok(())
}

/// 剪贴板配置的初始化策略。
///
/// - 已有来源标记：配置已初始化，绝不补齐缺失键；
/// - 全新库（user_version=0）：写入产品默认值，来源 `fresh_default`；
/// - 无剪贴板模块的旧库（0<version<7）：写入默认值但强制暂停，来源
///   `legacy_upgrade_paused`，等待用户确认后显式恢复；
/// - v7+ 已初始化库却没有任何剪贴板键：只记录 `missing`，保持缺失并
///   fail-closed，等待用户显式修复，不得按默认值自动开启；
/// - 只有部分键：记录 `existing`，不补齐，缺失键由读取路径 fail-closed。
///
/// 整个初始化在一个事务内完成，失败不留下半套配置。
fn seed_clipboard_config(conn: &Connection, prior_version: i64) -> AppResult<()> {
    let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let marker: i64 = tx.query_row(
        "SELECT COUNT(*) FROM application_settings WHERE key = ?1",
        rusqlite::params![CLIPBOARD_ORIGIN_KEY],
        |r| r.get(0),
    )?;
    if marker > 0 {
        return Ok(());
    }
    let now = crate::agents::now_iso();
    let mut present = 0usize;
    for key in CLIPBOARD_SETTING_KEYS {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM application_settings WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get(0),
        )?;
        if exists > 0 {
            present += 1;
        }
    }
    let origin = if present > 0 {
        CLIPBOARD_ORIGIN_EXISTING
    } else if prior_version == 0 {
        write_clipboard_defaults(&tx, false, &now)?;
        CLIPBOARD_ORIGIN_FRESH
    } else if prior_version < 7 {
        write_clipboard_defaults(&tx, true, &now)?;
        CLIPBOARD_ORIGIN_LEGACY_PAUSED
    } else {
        CLIPBOARD_ORIGIN_MISSING
    };
    put_setting(&tx, CLIPBOARD_ORIGIN_KEY, &serde_json::json!(origin), &now)?;
    tx.commit()?;
    Ok(())
}

fn write_clipboard_defaults(conn: &Connection, paused: bool, now: &str) -> AppResult<()> {
    for key in CLIPBOARD_SETTING_KEYS {
        let Some(mut value) = Settings::clipboard_setting_default(key) else {
            continue;
        };
        if *key == "clipboard_paused" {
            value = serde_json::json!(paused);
        }
        insert_setting_if_absent(conn, key, &value, now)?;
    }
    Ok(())
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
    /// 视觉预设（v0.6）：dream-gradient | liquid-glass。
    /// 与 theme（明暗）/ material（材质）正交；未知值由前端回退到默认预设。
    #[serde(default = "default_visual_preset")]
    pub visual_preset: String,
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
    /// 通知风暴治理：窗口内最多独立弹窗数（1~20）
    #[serde(default = "default_notify_burst")]
    pub notify_burst_max: u32,
    /// 通知风暴治理：限流窗口（秒，10~3600）
    #[serde(default = "default_notify_window")]
    pub notify_rate_window_secs: u32,
    /// 高频完成合并为一条摘要（关闭后逐个弹出，仍受频率上限约束）
    #[serde(default = "default_true")]
    pub notify_done_aggregate: bool,
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
    // ── 模块独立启停（v0.5.2；关闭只停本模块的后台动作，Agent 接入不受影响）──
    /// 工作现场：关闭后停止捕获与后台恢复，历史数据保留
    #[serde(default = "default_true")]
    pub workspace_enabled: bool,
    /// 行动中心：关闭后停止聚合刷新与徽标，原始事件仍照常入库
    #[serde(default = "default_true")]
    pub actions_enabled: bool,
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
fn default_visual_preset() -> String {
    "dream-gradient".into()
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
fn default_notify_burst() -> u32 {
    3
}
fn default_notify_window() -> u32 {
    60
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

/// 剪贴板设置键白名单：安全读取、缺失兼容与显式修复都以此为准。
pub const CLIPBOARD_SETTING_KEYS: &[&str] = &[
    "clipboard_enabled",
    "clipboard_paused",
    "clipboard_capture_images",
    "clipboard_capture_files",
    "clipboard_capture_html",
    "clipboard_auto_group",
    "clipboard_group_window_secs",
    "clipboard_retention_days",
    "clipboard_max_items",
    "clipboard_max_storage_mb",
    "clipboard_exclude_apps",
    "clipboard_paste_interval_ms",
    "clipboard_paste_interval_image_ms",
    "clipboard_paste_interval_html_ms",
    "clipboard_paste_interval_files_ms",
    "clipboard_sensitive_filter",
];

/// 剪贴板配置初始化来源（内部诊断标记，不出现在设置界面）。
///
/// 用来区分「首次安装默认值」「旧版本升级保守暂停」「已有配置」与
/// 「配置整体丢失」；只有后两者中的已有配置才谈得上用户授权。
pub const CLIPBOARD_ORIGIN_KEY: &str = "clipboard_config_origin";
pub const CLIPBOARD_ORIGIN_FRESH: &str = "fresh_default";
pub const CLIPBOARD_ORIGIN_LEGACY_PAUSED: &str = "legacy_upgrade_paused";
pub const CLIPBOARD_ORIGIN_EXISTING: &str = "existing";
pub const CLIPBOARD_ORIGIN_MISSING: &str = "missing";

/// 剪贴板配置读取失败的类别（只描述结构问题，不含任何设置值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardConfigErrorKind {
    Database,
    /// 已初始化的配置缺少键：可能是用户配置丢失，不得按默认值自动开启。
    Missing,
    Json,
    Type,
    Range,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardConfigError {
    pub kind: ClipboardConfigErrorKind,
    /// 只记录键名，绝不包含值（排除名单也可能含应用路径）。
    pub keys: Vec<String>,
}

impl ClipboardConfigError {
    pub fn message(&self) -> String {
        match self.kind {
            ClipboardConfigErrorKind::Database => {
                "无法读取剪贴板设置（数据库错误），已停止自动记录".into()
            }
            ClipboardConfigErrorKind::Json => format!(
                "剪贴板设置已损坏（{}），已停止自动记录",
                self.keys.join("、")
            ),
            ClipboardConfigErrorKind::Missing => format!(
                "剪贴板设置缺失（{}），无法确认用户授权，已停止自动记录",
                self.keys.join("、")
            ),
            ClipboardConfigErrorKind::Type => format!(
                "剪贴板设置类型错误（{}），已停止自动记录",
                self.keys.join("、")
            ),
            ClipboardConfigErrorKind::Range => format!(
                "剪贴板设置超出安全范围（{}），已停止自动记录",
                self.keys.join("、")
            ),
        }
    }
}

/// 剪贴板配置的安全视图：任一相关键不可靠时 `capture_allowed=false`。
#[derive(Debug, Clone)]
pub struct ClipboardConfig {
    pub settings: Settings,
    pub error: Option<ClipboardConfigError>,
    /// 初始化来源；缺失键被判定为异常时也保留来源用于诊断。
    pub origin: Option<String>,
}

impl ClipboardConfig {
    pub fn capture_allowed(&self) -> bool {
        self.error.is_none() && self.settings.clipboard_enabled && !self.settings.clipboard_paused
    }
}

fn clipboard_value<T: serde::de::DeserializeOwned>(
    raw: &HashMap<String, String>,
    key: &str,
    json_keys: &mut Vec<String>,
    type_keys: &mut Vec<String>,
) -> Option<T> {
    let text = raw.get(key)?;
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => match serde_json::from_value::<T>(value) {
            Ok(parsed) => Some(parsed),
            Err(_) => {
                type_keys.push(key.to_string());
                None
            }
        },
        Err(_) => {
            json_keys.push(key.to_string());
            None
        }
    }
}

fn clipboard_u32(
    raw: &HashMap<String, String>,
    key: &str,
    min: u32,
    max: u32,
    json_keys: &mut Vec<String>,
    type_keys: &mut Vec<String>,
    range_keys: &mut Vec<String>,
) -> Option<u32> {
    let value = clipboard_value::<u32>(raw, key, json_keys, type_keys)?;
    if !(min..=max).contains(&value) {
        range_keys.push(key.to_string());
        return None;
    }
    Some(value)
}

/// 单个剪贴板键的 JSON 值是否可安全采用（供 `Settings::load` 剔除损坏字段）。
fn clipboard_value_valid(key: &str, value: &serde_json::Value) -> bool {
    let boolean = matches!(
        key,
        "clipboard_enabled"
            | "clipboard_paused"
            | "clipboard_capture_images"
            | "clipboard_capture_files"
            | "clipboard_capture_html"
            | "clipboard_auto_group"
            | "clipboard_sensitive_filter"
    );
    if boolean {
        return value.is_boolean();
    }
    if key == "clipboard_exclude_apps" {
        return value
            .as_str()
            .map(|v| {
                v.chars().count() <= 4096
                    && !v
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
            })
            .unwrap_or(false);
    }
    let range = match key {
        "clipboard_group_window_secs" => Some((5, 600)),
        "clipboard_retention_days" => Some((1, 3650)),
        "clipboard_max_items" => Some((20, 50_000)),
        "clipboard_max_storage_mb" => Some((16, 102_400)),
        "clipboard_paste_interval_ms"
        | "clipboard_paste_interval_image_ms"
        | "clipboard_paste_interval_html_ms"
        | "clipboard_paste_interval_files_ms" => Some((100, 5_000)),
        _ => None,
    };
    match range {
        Some((min, max)) => value
            .as_u64()
            .map(|n| n <= u32::MAX as u64 && (min..=max).contains(&(n as u32)))
            .unwrap_or(false),
        None => true,
    }
}

impl Settings {
    pub fn load(db: &Db) -> AppResult<Self> {
        let raw = db.all_settings()?;
        // 单个损坏的剪贴板键不能让整套设置回退默认（会连带影响任务/Agent 的
        // 端口、主题、通知等）。这里先剔除不可靠的剪贴板字段，剪贴板的
        // fail-closed 由 `load_clipboard` 单独负责。
        let mut obj = match raw {
            serde_json::Value::Object(obj) => obj,
            _ => serde_json::Map::new(),
        };
        for key in CLIPBOARD_SETTING_KEYS {
            if obj
                .get(*key)
                .map(|v| !clipboard_value_valid(key, v))
                .unwrap_or(false)
            {
                obj.remove(*key);
            }
        }
        let s: Settings =
            serde_json::from_value(serde_json::Value::Object(obj)).unwrap_or_default();
        Ok(s)
    }

    /// 剪贴板字段的 fail-closed 解析：缺失键沿用默认（兼容旧库），
    /// 损坏/类型错误/越界/数据库失败都返回错误，调用方必须停止自动采集。
    pub fn reload_clipboard(&mut self, db: &Db) -> Option<ClipboardConfigError> {
        match db.all_settings_raw() {
            Ok(rows) => {
                let raw: HashMap<String, String> = rows.into_iter().collect();
                self.reload_clipboard_raw(&raw)
            }
            Err(_) => Some(ClipboardConfigError {
                kind: ClipboardConfigErrorKind::Database,
                keys: CLIPBOARD_SETTING_KEYS
                    .iter()
                    .map(|k| k.to_string())
                    .collect(),
            }),
        }
    }

    /// 从原始键值解析剪贴板字段；已初始化配置缺少键即 fail-closed。
    fn reload_clipboard_raw(
        &mut self,
        raw: &HashMap<String, String>,
    ) -> Option<ClipboardConfigError> {
        let missing: Vec<String> = CLIPBOARD_SETTING_KEYS
            .iter()
            .filter(|key| !raw.contains_key(**key))
            .map(|key| (*key).to_string())
            .collect();
        let mut json_keys = Vec::new();
        let mut type_keys = Vec::new();
        let mut range_keys = Vec::new();

        macro_rules! boolean {
            ($field:ident, $key:literal) => {
                if let Some(v) = clipboard_value::<bool>(&raw, $key, &mut json_keys, &mut type_keys)
                {
                    self.$field = v;
                }
            };
        }
        macro_rules! ranged {
            ($field:ident, $key:literal, $min:expr, $max:expr) => {
                if let Some(v) = clipboard_u32(
                    &raw,
                    $key,
                    $min,
                    $max,
                    &mut json_keys,
                    &mut type_keys,
                    &mut range_keys,
                ) {
                    self.$field = v;
                }
            };
        }

        boolean!(clipboard_enabled, "clipboard_enabled");
        boolean!(clipboard_paused, "clipboard_paused");
        boolean!(clipboard_capture_images, "clipboard_capture_images");
        boolean!(clipboard_capture_files, "clipboard_capture_files");
        boolean!(clipboard_capture_html, "clipboard_capture_html");
        boolean!(clipboard_auto_group, "clipboard_auto_group");
        boolean!(clipboard_sensitive_filter, "clipboard_sensitive_filter");
        ranged!(
            clipboard_group_window_secs,
            "clipboard_group_window_secs",
            5,
            600
        );
        ranged!(
            clipboard_retention_days,
            "clipboard_retention_days",
            1,
            3650
        );
        ranged!(clipboard_max_items, "clipboard_max_items", 20, 50_000);
        ranged!(
            clipboard_max_storage_mb,
            "clipboard_max_storage_mb",
            16,
            102_400
        );
        ranged!(
            clipboard_paste_interval_ms,
            "clipboard_paste_interval_ms",
            100,
            5_000
        );
        ranged!(
            clipboard_paste_interval_image_ms,
            "clipboard_paste_interval_image_ms",
            100,
            5_000
        );
        ranged!(
            clipboard_paste_interval_html_ms,
            "clipboard_paste_interval_html_ms",
            100,
            5_000
        );
        ranged!(
            clipboard_paste_interval_files_ms,
            "clipboard_paste_interval_files_ms",
            100,
            5_000
        );

        if let Some(v) = clipboard_value::<String>(
            raw,
            "clipboard_exclude_apps",
            &mut json_keys,
            &mut type_keys,
        ) {
            let illegal = v.chars().count() > 4096
                || v.chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t');
            if illegal {
                range_keys.push("clipboard_exclude_apps".into());
            } else {
                self.clipboard_exclude_apps = v;
            }
        }

        let had_missing = !missing.is_empty();
        let mut invalid: Vec<String> = missing;
        for key in json_keys.iter().chain(&type_keys).chain(&range_keys) {
            if !invalid.contains(key) {
                invalid.push(key.clone());
            }
        }
        if invalid.is_empty() {
            return None;
        }
        let kind = if had_missing {
            ClipboardConfigErrorKind::Missing
        } else if !json_keys.is_empty() {
            ClipboardConfigErrorKind::Json
        } else if !type_keys.is_empty() {
            ClipboardConfigErrorKind::Type
        } else {
            ClipboardConfigErrorKind::Range
        };
        Some(ClipboardConfigError {
            kind,
            keys: invalid,
        })
    }

    /// 只面向剪贴板调用方：非剪贴板字段为默认值，不能用于任务/Agent 设置。
    pub fn load_clipboard(db: &Db) -> ClipboardConfig {
        match db.all_settings_raw() {
            Ok(rows) => {
                let raw: HashMap<String, String> = rows.into_iter().collect();
                Self::clipboard_config_from_raw(&raw)
            }
            Err(_) => ClipboardConfig {
                settings: Settings::default(),
                error: Some(ClipboardConfigError {
                    kind: ClipboardConfigErrorKind::Database,
                    keys: CLIPBOARD_SETTING_KEYS
                        .iter()
                        .map(|k| k.to_string())
                        .collect(),
                }),
                origin: None,
            },
        }
    }

    fn clipboard_config_from_raw(raw: &HashMap<String, String>) -> ClipboardConfig {
        let mut settings = Settings::default();
        let error = settings.reload_clipboard_raw(raw);
        let origin = raw
            .get(CLIPBOARD_ORIGIN_KEY)
            .and_then(|s| serde_json::from_str::<String>(s).ok());
        ClipboardConfig {
            settings,
            error,
            origin,
        }
    }

    /// 设置界面读取：配置异常时把剪贴板字段展示为「已停用 + 已暂停」，
    /// 其他模块设置保持原值（绝不因剪贴板损坏影响任务/Agent）。
    pub fn load_display(db: &Db) -> AppResult<Self> {
        let mut settings = Self::load(db)?;
        if settings.reload_clipboard(db).is_some() {
            settings.clipboard_enabled = false;
            settings.clipboard_paused = true;
        }
        Ok(settings)
    }

    pub fn clipboard_setting_default(key: &str) -> Option<serde_json::Value> {
        let d = Settings::default();
        Some(match key {
            "clipboard_enabled" => serde_json::json!(d.clipboard_enabled),
            "clipboard_paused" => serde_json::json!(d.clipboard_paused),
            "clipboard_capture_images" => serde_json::json!(d.clipboard_capture_images),
            "clipboard_capture_files" => serde_json::json!(d.clipboard_capture_files),
            "clipboard_capture_html" => serde_json::json!(d.clipboard_capture_html),
            "clipboard_auto_group" => serde_json::json!(d.clipboard_auto_group),
            "clipboard_group_window_secs" => serde_json::json!(d.clipboard_group_window_secs),
            "clipboard_retention_days" => serde_json::json!(d.clipboard_retention_days),
            "clipboard_max_items" => serde_json::json!(d.clipboard_max_items),
            "clipboard_max_storage_mb" => serde_json::json!(d.clipboard_max_storage_mb),
            "clipboard_exclude_apps" => serde_json::json!(d.clipboard_exclude_apps),
            "clipboard_paste_interval_ms" => serde_json::json!(d.clipboard_paste_interval_ms),
            "clipboard_paste_interval_image_ms" => {
                serde_json::json!(d.clipboard_paste_interval_image_ms)
            }
            "clipboard_paste_interval_html_ms" => {
                serde_json::json!(d.clipboard_paste_interval_html_ms)
            }
            "clipboard_paste_interval_files_ms" => {
                serde_json::json!(d.clipboard_paste_interval_files_ms)
            }
            "clipboard_sensitive_filter" => serde_json::json!(d.clipboard_sensitive_filter),
            _ => return None,
        })
    }

    /// 用户显式修复损坏的剪贴板配置。
    ///
    /// 整个「读取 → 备份 → 修复 → 校验」在一写事务内完成：监听线程读取设置
    /// 走同一写连接，事务提交前只能看到修复前的 fail-closed 状态，提交后
    /// 才能看到完整的合法状态；中途失败整体回滚。
    ///
    /// - `resume=false`：只修复，强制暂停，绝不自动恢复采集；
    /// - `resume=true`：仅由用户显式触发，全部键修复并校验通过后才恢复。
    pub fn repair_clipboard(db: &Db, resume: bool) -> AppResult<ClipboardConfig> {
        db.with_conn(|conn| Self::repair_clipboard_tx(conn, resume))?;
        Ok(Self::load_clipboard(db))
    }

    fn repair_clipboard_tx(conn: &Connection, resume: bool) -> AppResult<()> {
        let tx = match rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate) {
            Ok(tx) => tx,
            // 数据库不可用：不写任何东西，由调用方重新读取并 fail-closed。
            Err(_) => return Ok(()),
        };
        let raw = match read_all_settings_raw(&tx) {
            Ok(raw) => raw,
            Err(_) => return Ok(()),
        };
        repair_hook(RepairPhase::AfterRead)?;
        let config = Self::clipboard_config_from_raw(&raw);
        let now = crate::agents::now_iso();

        let Some(error) = config.error.as_ref() else {
            if !resume {
                // 配置本身健康且用户只要「仅修复」：不写库，避免无意义变更。
                return Ok(());
            }
            put_setting(&tx, "clipboard_enabled", &serde_json::json!(true), &now)?;
            put_setting(&tx, "clipboard_paused", &serde_json::json!(false), &now)?;
            verify_clipboard_repair(&tx, true)?;
            repair_hook(RepairPhase::BeforeCommit)?;
            tx.commit()?;
            return Ok(());
        };

        // 原始值备份（缺失键记 null），保留损坏原因与来源，绝不静默删除。
        let mut backup = match raw
            .get("clipboard_config_corrupt_backup")
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v.as_object().cloned())
        {
            Some(obj) => obj,
            None => {
                let mut obj = serde_json::Map::new();
                if let Some(prev) = raw.get("clipboard_config_corrupt_backup") {
                    obj.insert(
                        "_replaced_backup_raw".into(),
                        serde_json::Value::String(prev.clone()),
                    );
                }
                obj
            }
        };
        for key in &error.keys {
            backup.insert(
                key.clone(),
                match raw.get(key) {
                    Some(raw_value) => serde_json::Value::String(raw_value.clone()),
                    None => serde_json::Value::Null,
                },
            );
        }
        backup.insert(
            "_last_repair".into(),
            serde_json::json!({
                "kind": error.kind,
                "keys": error.keys,
                "origin": config.origin,
                "at": now,
                "resume": resume,
            }),
        );
        put_setting(
            &tx,
            "clipboard_config_corrupt_backup",
            &serde_json::Value::Object(backup),
            &now,
        )?;
        repair_hook(RepairPhase::AfterBackup)?;

        for key in &error.keys {
            let value = match (resume, key.as_str()) {
                // 无法解析/缺失的开关：仅修复时按最保守值落盘；
                // 显式恢复是唯一允许写 true 的路径。
                (true, "clipboard_enabled") => serde_json::json!(true),
                (false, "clipboard_enabled") => serde_json::json!(false),
                (_, "clipboard_paused") => serde_json::json!(!resume),
                _ => match Self::clipboard_setting_default(key) {
                    Some(v) => v,
                    None => continue,
                },
            };
            put_setting(&tx, key, &value, &now)?;
        }
        // 最终启停状态单独落定：即使开关键没坏，「仅修复」也必须保持暂停。
        if resume {
            put_setting(&tx, "clipboard_enabled", &serde_json::json!(true), &now)?;
            put_setting(&tx, "clipboard_paused", &serde_json::json!(false), &now)?;
        } else {
            put_setting(&tx, "clipboard_paused", &serde_json::json!(true), &now)?;
        }
        repair_hook(RepairPhase::AfterWrites)?;
        verify_clipboard_repair(&tx, resume)?;
        repair_hook(RepairPhase::BeforeCommit)?;
        tx.commit()?;
        Ok(())
    }
}

/// 修复事务内的校验：所有键可解析，且采集状态恰好等于用户选择。
fn verify_clipboard_repair(conn: &Connection, resume: bool) -> AppResult<()> {
    let raw = read_all_settings_raw(conn)?;
    let config = Settings::clipboard_config_from_raw(&raw);
    if config.error.is_some() || config.capture_allowed() != resume {
        return Err(AppError::Validation("剪贴板配置修复校验失败".into()));
    }
    Ok(())
}

fn read_all_settings_raw(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM application_settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (key, value) = row?;
        out.insert(key, value);
    }
    Ok(out)
}

/// 修复事务的测试检查点（生产构建为空实现，无运行时开销）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepairPhase {
    AfterRead,
    AfterBackup,
    AfterWrites,
    BeforeCommit,
}

#[cfg(test)]
type RepairHook = std::sync::Arc<dyn Fn(RepairPhase) -> AppResult<()>>;

#[cfg(test)]
thread_local! {
    static REPAIR_HOOK: std::cell::RefCell<Option<RepairHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_repair_hook(hook: Option<RepairHook>) {
    REPAIR_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
fn repair_hook(phase: RepairPhase) -> AppResult<()> {
    let hook = REPAIR_HOOK.with(|slot| slot.borrow().clone());
    match hook {
        Some(hook) => hook(phase),
        None => Ok(()),
    }
}

#[cfg(not(test))]
fn repair_hook(_phase: RepairPhase) -> AppResult<()> {
    Ok(())
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
    fn backfill_origin_marks_only_provable_test_data() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            let now = "2026-10-20T10:00:00+00:00";
            // codex / mock 为迁移预置来源，直接复用
            for (id, source, external) in [
                ("real-sess", "codex", "real-1"),
                ("perf-sess", "codex", "http-perf-x-session-0"),
                ("perf-uncertain", "codex", "http-perf-y-session-0"),
                ("self-sess", "codex", "taskdock-selftest-codex"),
                ("mock-sess", "mock", "mock-1"),
            ] {
                conn.execute(
                    "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                     VALUES (?1, ?2, ?3, '', 'idle', ?4, ?4)",
                    rusqlite::params![id, source, external, now],
                )?;
            }
            conn.execute(
                "INSERT INTO agent_instances (id, source_id, instance_key, first_seen_at, last_seen_at)
                 VALUES ('perf-inst', 'codex', 'http-instance-0', ?1, ?1)",
                rusqlite::params![now],
            )?;
            conn.execute(
                "INSERT INTO agent_instances (id, source_id, instance_key, first_seen_at, last_seen_at)
                 VALUES ('shared-inst', 'codex', 'shared', ?1, ?1)",
                rusqlite::params![now],
            )?;
            for (id, session, run, state, instance) in [
                ("run-real", "real-sess", "real-run-1", "completed", "shared-inst"),
                ("run-perf", "perf-sess", "http-perf-x-run-0-0", "completed", "perf-inst"),
                ("run-shared", "real-sess", "real-run-2", "running", "shared-inst"),
            ] {
                conn.execute(
                    "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, status, started_at, updated_at, instance_id)
                     VALUES (?1, ?2, 'codex', ?3, ?4, ?5, ?5, ?6)",
                    rusqlite::params![id, session, run, state, now, instance],
                )?;
            }
            for (id, session, run) in [
                ("ev-real", "real-1", Some("real-run-1")),
                ("ev-self", "taskdock-selftest-codex", None),
                ("ev-perf", "http-perf-x-session-0", Some("http-perf-x-run-0-0")),
                // 只有会话前缀命中、轮次不符合：不可证明，保持 real 待人工确认
                ("ev-uncertain", "http-perf-y-session-0", Some("custom-run")),
            ] {
                conn.execute(
                    "INSERT INTO agent_events (id, source_id, session_external_id, run_external_id, state, received_at)
                     VALUES (?1, 'codex', ?2, ?3, 'completed', ?4)",
                    rusqlite::params![id, session, run, now],
                )?;
            }
            conn.execute(
                "INSERT INTO agent_events (id, source_id, session_external_id, state, received_at)
                 VALUES ('ev-mock', 'mock', 'mock-1', 'waiting', ?1)",
                rusqlite::params![now],
            )?;
            conn.execute(
                "INSERT INTO notification_history (id, kind, title, ref_type, ref_id, occurrence, created_at)
                 VALUES ('n-perf', 'agent_done', '完成', 'agent_run', 'run-perf', 'run-perf:completed', ?1)",
                rusqlite::params![now],
            )?;
            conn.execute(
                "INSERT INTO notification_history (id, kind, title, ref_type, ref_id, occurrence, created_at)
                 VALUES ('n-lost', 'agent_done', '完成', 'agent_run', 'run-deleted', 'run-deleted:completed', ?1)",
                rusqlite::params![now],
            )?;
            backfill_origin_labels(conn)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let origin = |table: &str, id: &str| {
            db.with_conn(|conn| {
                conn.query_row(
                    &format!("SELECT origin FROM {} WHERE id = ?1", table),
                    rusqlite::params![id],
                    |r| r.get::<_, String>(0),
                )
                .map_err(AppError::from)
            })
            .unwrap()
        };
        assert_eq!(origin("agent_sessions", "real-sess"), "real");
        assert_eq!(origin("agent_sessions", "perf-sess"), "benchmark");
        assert_eq!(
            origin("agent_sessions", "perf-uncertain"),
            "real",
            "缺少轮次佐证时不标记"
        );
        assert_eq!(origin("agent_sessions", "self-sess"), "selftest");
        assert_eq!(origin("agent_sessions", "mock-sess"), "mock");
        assert_eq!(origin("agent_runs", "run-perf"), "benchmark");
        assert_eq!(origin("agent_runs", "run-real"), "real");
        assert_eq!(origin("agent_events", "ev-perf"), "benchmark");
        assert_eq!(origin("agent_events", "ev-self"), "selftest");
        assert_eq!(origin("agent_events", "ev-uncertain"), "real");
        assert_eq!(origin("agent_events", "ev-mock"), "mock");
        assert_eq!(origin("agent_instances", "perf-inst"), "benchmark");
        assert_eq!(
            origin("agent_instances", "shared-inst"),
            "real",
            "被真实轮次引用过的实例不得标记为测试"
        );
        let n_origin = |id: &str| {
            db.with_conn(|conn| {
                conn.query_row(
                    "SELECT agent_origin FROM notification_history WHERE id = ?1",
                    rusqlite::params![id],
                    |r| r.get::<_, String>(0),
                )
                .map_err(AppError::from)
            })
            .unwrap()
        };
        assert_eq!(n_origin("n-perf"), "benchmark");
        assert_eq!(n_origin("n-lost"), "real", "无法证明的通知保持 real");
        // 再一次回填必须幂等
        db.with_conn(|conn| {
            backfill_origin_labels(conn)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        assert_eq!(
            db.with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM agent_sessions WHERE origin <> 'real'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(AppError::from)
            })
            .unwrap(),
            3
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

    /// v12/v13（0.5 数据可信 + 分页索引）：从 v11 库升级 —— 老数据一行不少、
    /// 新列默认值正确、可证明的测试数据被回填隔离、v13 索引齐备、幂等重开不重复回填。
    #[test]
    fn v11_to_v13_upgrade_keeps_rows_and_isolates_provable_test_data() {
        let dir = std::env::temp_dir().join(format!("td-mig13-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let now = "2026-10-27T09:00:00+00:00";
        {
            // 先按 v11 建库并放入旧结构数据（模拟用户升级前的真实库）
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            apply_migrations(&conn, 0, &MIGRATIONS[..11]).unwrap();
            conn.execute(
                "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess-real', 'codex', 'real-sess', '真实会话', 'failed', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, status, started_at, updated_at)
                 VALUES ('run-real', 'sess-real', 'codex', 'real-run', 'failed', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_events (id, source_id, session_external_id, run_external_id, state, received_at)
                 VALUES ('evt-real', 'codex', 'real-sess', 'real-run', 'failed', ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            // 自测会话：保留前缀，可证明
            conn.execute(
                "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess-self', 'codex', 'taskdock-selftest-codex', '自测会话', 'idle', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_events (id, source_id, session_external_id, state, received_at)
                 VALUES ('evt-self', 'codex', 'taskdock-selftest-codex', 'running', ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            // 压测轮次：会话与轮次双前缀，可证明
            conn.execute(
                "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES ('sess-perf', 'codex', 'http-perf-sess', '压测会话', 'idle', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_runs (id, session_id, source_id, external_run_id, status, started_at, updated_at)
                 VALUES ('run-perf', 'sess-perf', 'codex', 'http-perf-run', 'failed', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notification_history (id, kind, title, body, ref_type, ref_id, occurrence, is_read, created_at)
                 VALUES ('notif-1', 'agent_failed', '失败', '', 'agent_run', 'run-real', 'occ-1', 0, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
        }

        // 用新版本打开同一文件 → 触发 v12/v13 迁移与一次性回填
        let db = Db::open(&path).unwrap();
        db.with_conn(|c| {
            let version: i64 = c
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(AppError::from)?;
            assert_eq!(
                version,
                MIGRATIONS[MIGRATIONS.len() - 1].0,
                "升级后应到达最新迁移版本"
            );
            // 老数据一行不少
            for (table, expected) in [
                ("agent_sessions", 3),
                ("agent_runs", 2),
                ("agent_events", 2),
                ("notification_history", 1),
            ] {
                let n: i64 = c
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                    .map_err(AppError::from)?;
                assert_eq!(n, expected, "{} 的行数在升级后不得变化", table);
            }
            // 旧行默认判为真实；可证明的自测/压测数据被回填隔离
            let origin_of = |table: &str, id: &str| -> AppResult<String> {
                c.query_row(
                    &format!("SELECT origin FROM {table} WHERE id = ?1"),
                    rusqlite::params![id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            };
            assert_eq!(origin_of("agent_events", "evt-real")?, "real");
            assert_eq!(origin_of("agent_runs", "run-real")?, "real");
            assert_eq!(origin_of("agent_sessions", "sess-real")?, "real");
            assert_eq!(origin_of("agent_events", "evt-self")?, "selftest");
            assert_eq!(origin_of("agent_sessions", "sess-self")?, "selftest");
            assert_eq!(origin_of("agent_sessions", "sess-perf")?, "benchmark");
            assert_eq!(origin_of("agent_runs", "run-perf")?, "benchmark");
            // 通知按所属轮次归类
            let notif_origin: String = c
                .query_row(
                    "SELECT agent_origin FROM notification_history WHERE id = 'notif-1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            assert_eq!(notif_origin, "real", "真实轮次的通知应保持 real");
            // 隐藏的压测来源已注册且被隔离
            let (category, hidden): (String, i64) = c
                .query_row(
                    "SELECT category, hidden FROM agent_sources WHERE id = 'bench'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(AppError::from)?;
            assert_eq!(category, "benchmark");
            assert_eq!(hidden, 1, "压测来源必须隐藏，不可被选中");
            // v13 的分页索引齐备
            for idx in [
                "idx_events_origin_received_id",
                "idx_events_origin_source_received_id",
                "idx_notifications_origin_created_id",
                "idx_notifications_origin_kind_created_id",
            ] {
                let n: i64 = c
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                        rusqlite::params![idx],
                        |r| r.get(0),
                    )
                    .map_err(AppError::from)?;
                assert_eq!(n, 1, "v13 索引 {} 必须存在", idx);
            }
            // 外键无破损
            let fk: i64 = c
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)?;
            assert_eq!(fk, 0, "升级后不得出现外键破损");
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 幂等：再次打开不重复回填、不改写既有归类
        let db2 = Db::open(&path).unwrap();
        db2.with_conn(|c| {
            let n: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM application_settings WHERE key = 'origin_backfill_v12'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            assert_eq!(n, 1, "回填标记只应写一次");
            let origin: String = c
                .query_row(
                    "SELECT origin FROM agent_events WHERE id = 'evt-self'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            assert_eq!(origin, "selftest", "重复打开不得改变归类");
            Ok::<_, AppError>(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 逐个历史 schema 版本（v1…v13）升级到最新：版本推进、任务行不丢、
    /// 外键零违规、重复打开幂等。覆盖 v0.1–v0.4 各历史库的真实升级入口。
    #[test]
    fn every_historical_schema_version_upgrades_to_latest_without_losing_rows() {
        let latest = MIGRATIONS[MIGRATIONS.len() - 1].0;
        let now = "2026-10-27T09:00:00+00:00";
        for from in 1..=MIGRATIONS.len() {
            let dir = std::env::temp_dir().join(format!("td-migall-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("t.db");
            {
                let conn = Connection::open(&path).unwrap();
                conn.pragma_update(None, "foreign_keys", "ON").unwrap();
                apply_migrations(&conn, 0, &MIGRATIONS[..from]).unwrap();
                // 每个历史版本都放一条任务：验证升级前后任务行不丢
                conn.execute(
                    "INSERT INTO tasks (id, title, created_at, updated_at)
                     VALUES ('task-old', '历史任务', ?1, ?1)",
                    rusqlite::params![now],
                )
                .unwrap();
                let version: i64 = conn
                    .query_row("PRAGMA user_version", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(version, from as i64, "夹具的 schema 版本应等于 {}", from);
            }

            let db = Db::open(&path).unwrap();
            db.with_conn(|c| {
                let version: i64 = c
                    .query_row("PRAGMA user_version", [], |r| r.get(0))
                    .map_err(AppError::from)?;
                assert_eq!(version, latest, "v{} 升级后应到达最新迁移版本", from);
                let tasks: i64 = c
                    .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
                    .map_err(AppError::from)?;
                assert_eq!(tasks, 1, "v{} 升级后历史任务不得丢失", from);
                let fk: i64 = c
                    .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                        r.get(0)
                    })
                    .map_err(AppError::from)?;
                assert_eq!(fk, 0, "v{} 升级后不得出现外键破损", from);
                Ok::<_, AppError>(())
            })
            .unwrap();

            // 幂等：再次打开版本不再推进、数据仍在
            let db2 = Db::open(&path).unwrap();
            db2.with_conn(|c| {
                let version: i64 = c
                    .query_row("PRAGMA user_version", [], |r| r.get(0))
                    .map_err(AppError::from)?;
                assert_eq!(version, latest, "v{} 重复打开不得再次推进版本", from);
                let tasks: i64 = c
                    .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
                    .map_err(AppError::from)?;
                assert_eq!(tasks, 1, "v{} 重复打开后历史任务不得丢失", from);
                Ok::<_, AppError>(())
            })
            .unwrap();
            std::fs::remove_dir_all(&dir).ok();
        }
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
                     DROP INDEX IF EXISTS idx_events_ingest_seq;
                     DROP INDEX IF EXISTS idx_events_run_latest;
                     DROP INDEX IF EXISTS idx_events_origin_received;
                     DROP INDEX IF EXISTS idx_sources_category;
                     DROP INDEX IF EXISTS idx_runs_origin_status;
                     DROP INDEX IF EXISTS idx_runs_origin_updated;
                     DROP INDEX IF EXISTS idx_sessions_origin_last;
                     DROP INDEX IF EXISTS idx_instances_origin_last;
                     DROP INDEX IF EXISTS idx_notifications_origin_created;
                     DROP INDEX IF EXISTS idx_notifications_unread_origin;
                     DROP INDEX IF EXISTS idx_events_origin_received_id;
                     DROP INDEX IF EXISTS idx_events_origin_source_received_id;
                     DROP INDEX IF EXISTS idx_notifications_origin_created_id;
                     DROP INDEX IF EXISTS idx_notifications_origin_kind_created_id;
                     ALTER TABLE agent_events DROP COLUMN ingest_seq;
                     ALTER TABLE agent_events DROP COLUMN origin;
                     ALTER TABLE agent_sources DROP COLUMN category;
                     ALTER TABLE agent_sessions DROP COLUMN origin;
                     ALTER TABLE agent_runs DROP COLUMN origin;
                     ALTER TABLE agent_instances DROP COLUMN origin;
                     ALTER TABLE notification_history DROP COLUMN agent_origin;
                     ALTER TABLE agent_runs DROP COLUMN last_ingest_seq;
                     ALTER TABLE agent_runs DROP COLUMN last_event_at;
                     DELETE FROM application_settings WHERE key = 'origin_backfill_v12';
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

    // ── 剪贴板配置 fail-closed 故障注入（P0）──

    fn raw_setting(db: &Db, key: &str, raw: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, '2026-10-29T00:00:00+00:00')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                rusqlite::params![key, raw],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("td-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 只执行迁移、不执行 seed 的文件库，用于模拟旧版本升级/配置丢失。
    fn db_file_with_version(dir: &Path, migration_count: usize) -> std::path::PathBuf {
        let path = dir.join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            apply_migrations(&conn, 0, &MIGRATIONS[..migration_count]).unwrap();
        }
        path
    }

    fn wait_flag(flag: &std::sync::atomic::AtomicBool, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while !flag.load(Ordering::SeqCst) {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        true
    }

    fn sorted_raw(db: &Db) -> Vec<(String, String)> {
        let mut rows = db.all_settings_raw().unwrap();
        rows.sort();
        rows
    }

    /// 全新安装：seed 一次性写入默认值并标记来源，读取本身绝不自愈写入。
    #[test]
    fn clipboard_fresh_install_seeds_defaults_and_marks_origin() {
        let db = Db::open_in_memory().unwrap();
        let before = sorted_raw(&db);
        let config = Settings::load_clipboard(&db);
        assert!(config.error.is_none());
        assert!(config.settings.clipboard_enabled);
        assert!(!config.settings.clipboard_paused);
        assert!(config.capture_allowed());
        assert_eq!(
            config.origin.as_deref(),
            Some(CLIPBOARD_ORIGIN_FRESH),
            "全新安装来源必须可追溯"
        );
        assert_eq!(before, sorted_raw(&db), "读取不得自愈写入");
    }

    /// 单个剪贴板键 JSON 损坏：停止采集，但不得把整套设置回退默认。
    #[test]
    fn clipboard_corrupt_json_fails_closed_and_keeps_unrelated_settings() {
        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "theme", "\"dark\"");
        raw_setting(&db, "http_port", "50123");
        raw_setting(&db, "clipboard_enabled", "{not-json");
        let before = sorted_raw(&db);

        let config = Settings::load_clipboard(&db);
        let error = config.error.as_ref().expect("损坏配置必须报错");
        assert_eq!(error.kind, ClipboardConfigErrorKind::Json);
        assert!(error.keys.iter().any(|k| k == "clipboard_enabled"));
        assert!(!config.capture_allowed(), "配置损坏时绝不能采集");
        assert!(error.message().contains("clipboard_enabled"));
        assert!(
            !error.message().contains("not-json"),
            "错误信息不得包含原始值"
        );

        let settings = Settings::load(&db).unwrap();
        assert_eq!(settings.theme, "dark", "剪贴板损坏不得重置主题");
        assert_eq!(settings.http_port, 50123, "剪贴板损坏不得重置端口");
        let _ = Settings::load_display(&db).unwrap();
        assert_eq!(before, sorted_raw(&db), "所有读取路径都不得改写设置");
    }

    /// 类型错误（布尔键给字符串、字符串键给数字）→ fail-closed。
    #[test]
    fn clipboard_type_errors_fail_closed() {
        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "clipboard_sensitive_filter", "\"yes\"");
        raw_setting(&db, "clipboard_exclude_apps", "42");
        let config = Settings::load_clipboard(&db);
        let error = config.error.as_ref().expect("类型错误必须报错");
        assert_eq!(error.kind, ClipboardConfigErrorKind::Type);
        assert!(error.keys.iter().any(|k| k == "clipboard_sensitive_filter"));
        assert!(error.keys.iter().any(|k| k == "clipboard_exclude_apps"));
        assert!(!config.capture_allowed());
    }

    /// 越界值（间隔、条目数）与非法排除名单（控制字符）→ fail-closed。
    #[test]
    fn clipboard_range_errors_fail_closed() {
        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "clipboard_paste_interval_ms", "50");
        raw_setting(&db, "clipboard_max_items", "1");
        raw_setting(&db, "clipboard_exclude_apps", "\"a.exe\\u0000b.exe\"");
        let config = Settings::load_clipboard(&db);
        let error = config.error.as_ref().expect("越界必须报错");
        assert_eq!(error.kind, ClipboardConfigErrorKind::Range);
        for key in [
            "clipboard_paste_interval_ms",
            "clipboard_max_items",
            "clipboard_exclude_apps",
        ] {
            assert!(error.keys.iter().any(|k| k == key), "缺少 {}", key);
        }
        assert!(!config.capture_allowed());
    }

    /// 数据库读取失败：不得默认开启采集。
    #[test]
    fn clipboard_database_failure_fails_closed() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|c| {
            c.execute("DROP TABLE application_settings", [])?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let config = Settings::load_clipboard(&db);
        let error = config.error.as_ref().expect("数据库失败必须报错");
        assert_eq!(error.kind, ClipboardConfigErrorKind::Database);
        assert!(!config.capture_allowed());
    }

    /// 用户已关闭/暂停时，其他键损坏不得把开关自动打开。
    #[test]
    fn clipboard_config_never_enables_after_user_disabled() {
        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "clipboard_enabled", "false");
        raw_setting(&db, "clipboard_paused", "true");
        raw_setting(&db, "clipboard_group_window_secs", "0");
        let config = Settings::load_clipboard(&db);
        assert!(config.error.is_some());
        assert!(!config.settings.clipboard_enabled);
        assert!(config.settings.clipboard_paused);
        assert!(!config.capture_allowed());
        let repaired = Settings::repair_clipboard(&db, false).unwrap();
        assert!(!repaired.capture_allowed(), "修复后仍须保持暂停");
    }

    /// 显式修复：备份原始损坏值、只重写损坏键、默认保持暂停，恢复需显式 resume。
    #[test]
    fn clipboard_repair_backs_up_raw_values_and_requires_explicit_resume() {
        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "clipboard_enabled", "true");
        raw_setting(&db, "clipboard_paused", "false");
        raw_setting(&db, "clipboard_max_items", "oops");

        let repaired = Settings::repair_clipboard(&db, false).unwrap();
        assert!(repaired.error.is_none(), "修复后应可解析");
        assert!(!repaired.capture_allowed(), "仅修复必须保持暂停");
        assert!(repaired.settings.clipboard_paused);

        let backup = db
            .get_setting("clipboard_config_corrupt_backup")
            .unwrap()
            .expect("原始损坏值必须备份");
        assert_eq!(
            backup.get("clipboard_max_items").and_then(|v| v.as_str()),
            Some("oops"),
            "备份必须是原始字符串，不得静默删除"
        );
        let raw: HashMap<_, _> = db.all_settings_raw().unwrap().into_iter().collect();
        assert_eq!(
            raw.get("clipboard_enabled").map(String::as_str),
            Some("true"),
            "用户的总开关偏好不得被改写"
        );
        assert_eq!(
            raw.get("clipboard_max_items").map(String::as_str),
            Some("1000"),
            "只重写损坏键"
        );

        let resumed = Settings::repair_clipboard(&db, true).unwrap();
        assert!(resumed.error.is_none());
        assert!(resumed.capture_allowed(), "显式恢复后应重新允许采集");
        assert!(
            db.get_setting("clipboard_config_corrupt_backup")
                .unwrap()
                .is_some(),
            "恢复采集不得丢弃备份"
        );
    }

    #[test]
    fn with_read_skips_reader_held_by_long_snapshot() {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};

        let dir = std::env::temp_dir().join(format!("td-readpool-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();
        assert_eq!(db.readers.len(), READ_POOL_SIZE);

        // 0 号读连接被完整备份式的长快照占用，且下一次轮询起点也指向它。
        let held = db.readers[0].lock().unwrap();
        db.next_reader.store(0, Ordering::Relaxed);
        let started = Instant::now();
        let value: i64 = db
            .with_read(|c| {
                c.query_row("SELECT 1", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(value, 1);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "普通读不应排队等待长快照结束，实际 {:?}",
            started.elapsed()
        );
        drop(held);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 数据库损坏时 repair 不得假装成功写入。
    #[test]
    fn clipboard_repair_does_not_write_when_database_broken() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|c| {
            c.execute("DROP TABLE application_settings", [])?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let config = Settings::repair_clipboard(&db, true).unwrap();
        assert_eq!(
            config.error.as_ref().map(|e| e.kind),
            Some(ClipboardConfigErrorKind::Database)
        );
        assert!(!config.capture_allowed());
    }

    // ── 缺失键初始化策略（P1-02）──

    /// 没有剪贴板模块的旧库升级：写入默认值但强制暂停，其他设置不受影响。
    #[test]
    fn clipboard_legacy_upgrade_starts_paused() {
        let dir = temp_dir("legacy-clip");
        let path = db_file_with_version(&dir, 6);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "INSERT INTO application_settings (key, value, updated_at) VALUES ('theme', '\"dark\"', '2026-10-01T00:00:00+00:00')",
                [],
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let config = Settings::load_clipboard(&db);
        assert!(config.error.is_none());
        assert!(config.settings.clipboard_enabled);
        assert!(
            config.settings.clipboard_paused,
            "旧版本升级不得默认开始采集"
        );
        assert!(!config.capture_allowed());
        assert_eq!(
            config.origin.as_deref(),
            Some(CLIPBOARD_ORIGIN_LEGACY_PAUSED)
        );
        assert_eq!(Settings::load(&db).unwrap().theme, "dark");
        drop(db);

        let db = Db::open(&path).unwrap();
        assert!(
            Settings::load_clipboard(&db).settings.clipboard_paused,
            "重启后仍保持升级时的暂停状态"
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 已初始化库的剪贴板键全部丢失：只记录 missing，绝不按默认值自动开启。
    #[test]
    fn clipboard_missing_config_never_reenables_across_restarts() {
        let dir = temp_dir("missing-clip");
        let path = db_file_with_version(&dir, MIGRATIONS.len());
        let db = Db::open(&path).unwrap();
        let config = Settings::load_clipboard(&db);
        let error = config
            .error
            .as_ref()
            .expect("已初始化库缺少全部剪贴板键必须报错");
        assert_eq!(error.kind, ClipboardConfigErrorKind::Missing);
        assert!(!config.capture_allowed());
        assert_eq!(config.origin.as_deref(), Some(CLIPBOARD_ORIGIN_MISSING));
        let raw: HashMap<_, _> = db.all_settings_raw().unwrap().into_iter().collect();
        for key in CLIPBOARD_SETTING_KEYS {
            assert!(
                !raw.contains_key(*key),
                "配置丢失后不得自动补默认键: {}",
                key
            );
        }
        drop(db);

        let db = Db::open(&path).unwrap();
        let config = Settings::load_clipboard(&db);
        assert_eq!(
            config.error.as_ref().map(|e| e.kind),
            Some(ClipboardConfigErrorKind::Missing),
            "重启不得把缺失配置当成首次安装"
        );
        assert!(!config.capture_allowed());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 部分键缺失：不补齐、不恢复采集，重启后仍然 fail-closed。
    #[test]
    fn clipboard_partial_missing_is_not_filled_on_restart() {
        let dir = temp_dir("partial-clip");
        let path = dir.join("t.db");
        let db = Db::open(&path).unwrap();
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM application_settings WHERE key = 'clipboard_paused'",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        drop(db);

        let db = Db::open(&path).unwrap();
        let config = Settings::load_clipboard(&db);
        let error = config.error.as_ref().expect("缺失键必须 fail-closed");
        assert_eq!(error.kind, ClipboardConfigErrorKind::Missing);
        assert!(error.keys.iter().any(|k| k == "clipboard_paused"));
        assert!(!config.capture_allowed());
        let raw: HashMap<_, _> = db.all_settings_raw().unwrap().into_iter().collect();
        assert!(
            !raw.contains_key("clipboard_paused"),
            "重启不得静默补齐缺失键"
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 用户明确关闭后某个键丢失：修复只能还原损坏键，不得静默恢复开启。
    #[test]
    fn clipboard_user_disabled_survives_key_loss_and_repair_only() {
        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "clipboard_enabled", "false");
        raw_setting(&db, "clipboard_paused", "true");
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM application_settings WHERE key = 'clipboard_max_items'",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let config = Settings::load_clipboard(&db);
        assert_eq!(
            config.error.as_ref().map(|e| e.kind),
            Some(ClipboardConfigErrorKind::Missing)
        );
        assert!(!config.settings.clipboard_enabled);
        assert!(!config.capture_allowed());

        let repaired = Settings::repair_clipboard(&db, false).unwrap();
        assert!(repaired.error.is_none());
        assert!(
            !repaired.settings.clipboard_enabled,
            "用户关闭意图不得因缺失键修复而改变"
        );
        assert!(repaired.settings.clipboard_paused);
        assert!(!repaired.capture_allowed());
    }

    /// 缺失的开关按最保守值修复；只有显式 resume 才允许恢复采集。
    #[test]
    fn clipboard_repair_missing_switch_is_conservative() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM application_settings WHERE key IN
                 ('clipboard_enabled', 'clipboard_paused', 'clipboard_capture_images')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let config = Settings::load_clipboard(&db);
        assert_eq!(
            config.error.as_ref().map(|e| e.kind),
            Some(ClipboardConfigErrorKind::Missing)
        );

        let repaired = Settings::repair_clipboard(&db, false).unwrap();
        assert!(repaired.error.is_none());
        assert!(
            !repaired.settings.clipboard_enabled,
            "缺失的开关必须视为未授权"
        );
        assert!(repaired.settings.clipboard_paused);
        assert!(!repaired.capture_allowed());

        let backup = db
            .get_setting("clipboard_config_corrupt_backup")
            .unwrap()
            .expect("缺失键必须留下备份记录");
        assert!(
            backup.get("clipboard_enabled").map(|v| v.is_null()) == Some(true),
            "缺失键应以 null 记录，便于追溯"
        );
        let diagnostic = backup.get("_last_repair").expect("必须记录修复诊断");
        assert_eq!(
            diagnostic.get("kind").and_then(|v| v.as_str()),
            Some("missing")
        );
        assert_eq!(
            diagnostic.get("resume").and_then(|v| v.as_bool()),
            Some(false)
        );

        let resumed = Settings::repair_clipboard(&db, true).unwrap();
        assert!(resumed.capture_allowed(), "显式恢复是唯一允许采集的路径");
    }

    // ── P0-01 修复事务的并发与故障注入 ──

    fn repair_concurrency_case(resume: bool) {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let db = Arc::new(Db::open_in_memory().unwrap());
        raw_setting(&db, "clipboard_max_items", "oops");
        let before = Settings::load_clipboard(&db);
        assert!(before.error.is_some());
        assert!(!before.capture_allowed());

        let history_before: i64 = db
            .with_conn(|c| {
                Ok(c.query_row("SELECT COUNT(*) FROM clipboard_items", [], |r| r.get(0))?)
            })
            .unwrap();

        let tx_open = Arc::new(AtomicBool::new(false));
        let monitor_attempted = Arc::new(AtomicBool::new(false));
        let monitor_done = Arc::new(AtomicBool::new(false));
        let theme_started = Arc::new(AtomicBool::new(false));
        let theme_done = Arc::new(AtomicBool::new(false));
        let observed = Arc::new(Mutex::new(None));

        let repair_db = Arc::clone(&db);
        let tx_open_hook = Arc::clone(&tx_open);
        let monitor_attempted_hook = Arc::clone(&monitor_attempted);
        let monitor_done_hook = Arc::clone(&monitor_done);
        let theme_started_hook = Arc::clone(&theme_started);
        let theme_done_hook = Arc::clone(&theme_done);
        let repair = std::thread::spawn(move || {
            set_repair_hook(Some(Arc::new(move |phase| {
                if phase == RepairPhase::AfterWrites {
                    tx_open_hook.store(true, Ordering::SeqCst);
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while !(monitor_attempted_hook.load(Ordering::SeqCst)
                        && theme_started_hook.load(Ordering::SeqCst))
                    {
                        assert!(
                            Instant::now() < deadline,
                            "并发线程未能在超时前发起读取/写入"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    std::thread::sleep(Duration::from_millis(250));
                    assert!(
                        !monitor_done_hook.load(Ordering::SeqCst),
                        "事务未提交时监听线程不得读到任何配置"
                    );
                    assert!(
                        !theme_done_hook.load(Ordering::SeqCst),
                        "事务未提交时其他设置写入不得穿透"
                    );
                }
                Ok(())
            })));
            let result = Settings::repair_clipboard(&repair_db, resume);
            set_repair_hook(None);
            result
        });

        assert!(
            wait_flag(&tx_open, Duration::from_secs(5)),
            "修复事务未进入写入阶段"
        );

        let monitor_db = Arc::clone(&db);
        let m_attempt = Arc::clone(&monitor_attempted);
        let m_done = Arc::clone(&monitor_done);
        let seen = Arc::clone(&observed);
        let monitor = std::thread::spawn(move || {
            m_attempt.store(true, Ordering::SeqCst);
            let config = Settings::load_clipboard(&monitor_db);
            *seen.lock().unwrap() = Some(config);
            m_done.store(true, Ordering::SeqCst);
        });
        let theme_db = Arc::clone(&db);
        let t_started = Arc::clone(&theme_started);
        let t_done = Arc::clone(&theme_done);
        let theme = std::thread::spawn(move || {
            t_started.store(true, Ordering::SeqCst);
            theme_db
                .set_setting("theme", serde_json::json!("dark"))
                .unwrap();
            t_done.store(true, Ordering::SeqCst);
        });

        let repaired = repair.join().unwrap().unwrap();
        monitor.join().unwrap();
        theme.join().unwrap();

        assert!(repaired.error.is_none());
        assert_eq!(repaired.capture_allowed(), resume);
        let seen = observed
            .lock()
            .unwrap()
            .take()
            .expect("监听线程必须读到提交后的配置");
        assert!(
            seen.error.is_none(),
            "监听线程不得观察到半修复状态（resume={}）",
            resume
        );
        assert_eq!(
            seen.capture_allowed(),
            resume,
            "监听线程只能看到修复前 fail-closed 或完整提交后的状态"
        );
        assert_eq!(
            Settings::load(&db).unwrap().theme,
            "dark",
            "修复不得覆盖并发写入的其他设置"
        );
        let history_after: i64 = db
            .with_conn(|c| {
                Ok(c.query_row("SELECT COUNT(*) FROM clipboard_items", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(history_before, history_after, "修复过程不得新增剪贴板历史");
    }

    #[test]
    fn clipboard_repair_blocks_monitor_until_commit_without_resume() {
        repair_concurrency_case(false);
    }

    #[test]
    fn clipboard_repair_blocks_monitor_until_commit_with_resume() {
        repair_concurrency_case(true);
    }

    /// 事务中途失败：备份与已修复键一起回滚，不留下半修复状态。
    #[test]
    fn clipboard_repair_fault_after_writes_rolls_back() {
        use std::sync::Arc;

        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "clipboard_max_items", "oops");
        let before = sorted_raw(&db);
        set_repair_hook(Some(Arc::new(|phase| {
            if phase == RepairPhase::AfterWrites {
                return Err(AppError::Validation("injected failure".into()));
            }
            Ok(())
        })));
        let result = Settings::repair_clipboard(&db, false);
        set_repair_hook(None);

        assert!(result.is_err(), "注入失败必须向外报告");
        assert_eq!(
            before,
            sorted_raw(&db),
            "失败后所有写入（含备份）都必须回滚"
        );
        assert!(db
            .get_setting("clipboard_config_corrupt_backup")
            .unwrap()
            .is_none());
        let config = Settings::load_clipboard(&db);
        assert!(config.error.is_some());
        assert!(!config.capture_allowed());
    }

    /// 真实数据库写入失败（触发器 ABORT）：已写入的部分与备份一并回滚。
    #[test]
    fn clipboard_repair_database_write_failure_rolls_back_backup() {
        let db = Db::open_in_memory().unwrap();
        raw_setting(&db, "clipboard_max_items", "oops");
        raw_setting(&db, "clipboard_auto_group", "\"yes\"");
        let before = sorted_raw(&db);
        db.with_conn(|c| {
            c.execute_batch(
                "CREATE TRIGGER fail_clipboard_repair
                 BEFORE UPDATE ON application_settings
                 WHEN NEW.key = 'clipboard_auto_group'
                 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let result = Settings::repair_clipboard(&db, true);
        assert!(result.is_err(), "数据库写入失败必须向外报告");
        assert_eq!(before, sorted_raw(&db), "回滚后原始值必须完全一致");
        assert!(db
            .get_setting("clipboard_config_corrupt_backup")
            .unwrap()
            .is_none());
        let config = Settings::load_clipboard(&db);
        assert!(config.error.is_some());
        assert!(!config.capture_allowed());
    }

    /// 进程在提交前异常终止：未提交的修复（含备份）必须由 WAL 回滚。
    ///
    /// 父进程准备真实文件库并拉起当前测试二进制；子进程在 BeforeCommit
    /// 直接 exit(9)，模拟崩溃/断电，然后父进程重开数据库核对。
    #[test]
    fn clipboard_repair_process_death_rolls_back_on_reopen() {
        use std::process::{Command, Stdio};

        const ENV_DIR: &str = "TASKDOCK_REPAIR_CRASH_DIR";
        if let Some(dir) = std::env::var_os(ENV_DIR) {
            let dir = std::path::PathBuf::from(dir);
            let db = Db::open(&dir.join("t.db")).unwrap();
            raw_setting(&db, "clipboard_max_items", "oops");
            set_repair_hook(Some(std::sync::Arc::new(|phase| {
                if phase == RepairPhase::BeforeCommit {
                    std::process::exit(9);
                }
                Ok(())
            })));
            let _ = Settings::repair_clipboard(&db, false);
            std::process::exit(0);
        }

        let dir = temp_dir("crash-clip");
        let path = dir.join("t.db");
        {
            let db = Db::open(&path).unwrap();
            raw_setting(&db, "clipboard_enabled", "true");
            raw_setting(&db, "clipboard_paused", "false");
            raw_setting(&db, "clipboard_max_items", "oops");
        }
        let before: HashMap<_, _> = {
            let db = Db::open(&path).unwrap();
            db.all_settings_raw().unwrap().into_iter().collect()
        };

        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::tests::clipboard_repair_process_death_rolls_back_on_reopen",
                "--nocapture",
            ])
            .env(ENV_DIR, &dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(9), "子进程必须在提交前异常退出");

        let db = Db::open(&path).unwrap();
        let after: HashMap<_, _> = db.all_settings_raw().unwrap().into_iter().collect();
        assert_eq!(after, before, "进程终止后未提交的修复必须完整回滚");
        let config = Settings::load_clipboard(&db);
        assert!(config.error.is_some());
        assert!(!config.capture_allowed());
        assert!(db
            .get_setting("clipboard_config_corrupt_backup")
            .unwrap()
            .is_none());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
