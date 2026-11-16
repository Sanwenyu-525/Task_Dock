// 本地库结构：与桌面端 SQLite 字段名保持一致，便于后续同步时直接对字段。
// 手机端专属的同步元数据（rev）留在本表内，不进入桌面 schema。
//
// 迁移规则与仓库一致：只在末尾追加，不修改已发布的迁移；版本号写 PRAGMA user_version。
// MIGRATIONS 必须是从 1 开始、逐条 +1 的序列：database.ts 会校验连续性，
// 出现缺口时直接抛错，避免「跳过某条迁移却把 user_version 推到最新」的静默损坏。
export const DATABASE_NAME = "taskdock.db";

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  tags TEXT,
  due_at INTEGER,
  remind_at INTEGER,
  advance_minutes INTEGER,
  recurrence_rule TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_captures_client ON captures(client_id);

-- 本地写操作队列：独立模式下只记录，不发送；联动模式接入后由同步器消费。
CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY NOT NULL,
  entity TEXT NOT NULL,
  target_id TEXT NOT NULL,
  base_rev INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

// v2 只做增量：新增提醒排期表、补齐 outbox 的重试状态列、补两个高频查询索引。
// 这里不能使用 CREATE TABLE IF NOT EXISTS 覆盖旧表，也不能修改 MIGRATION_1 ——
// 已安装 v1 的设备只会执行本段 SQL，必须保证在既有数据上原地升级。
export const MIGRATION_2 = `
-- 提醒排期幂等表：主键是「任务 × 发生时刻」。occurrence_at 存绝对 epoch ms（UTC），
-- 时区变化时按绝对时刻触发，不重算已有记录。
CREATE TABLE IF NOT EXISTS reminder_schedule (
  task_id TEXT NOT NULL,
  occurrence_at INTEGER NOT NULL,
  notification_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, occurrence_at)
);

-- outbox 重试状态：pending / sending / failed 由同步器维护；
-- 旧行通过 DEFAULT 直接获得 pending，不需要回填。
ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE outbox ADD COLUMN last_error TEXT;
ALTER TABLE outbox ADD COLUMN last_attempt_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at);
`;

// v3：笔记表（原型 notes/note_editor 两屏的存储）。与 tasks 同一套同步纪律：
// rev 每次写 +1，写操作与 outbox 同事务（entity = "note"）。软删除保留行备将来生成墓碑。
export const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  favorited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
`;

// v4：手机同步 v1（仅任务）。server_rev 保存桌面端最后一次下发的版本号，
// outbox 的 base_rev 改用它；sync_conflicts 保存 push 冲突，等用户在冲突页处理，
// 绝不静默覆盖任何一端。
export const MIGRATION_4 = `
ALTER TABLE tasks ADD COLUMN server_rev INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sync_conflicts (
  op_id TEXT PRIMARY KEY NOT NULL,
  entity TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  server_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_created ON sync_conflicts(created_at DESC);

-- 旧 outbox 的 base_rev 记录的是本地 rev；升级时换成 server_rev（从未同步过 = 0），
-- 否则 push 会把本地创建误判成版本冲突。
UPDATE outbox SET base_rev = COALESCE((SELECT server_rev FROM tasks WHERE tasks.id = outbox.target_id), 0)
 WHERE entity = 'task' AND state = 'pending';
`;

// v5：收集箱与笔记接入同步（与任务同语义）。server_rev 记录桌面端最后下发的版本号，
// outbox 的 base_rev 改用它；升级前两者从未同步，旧 outbox 一律对齐到 0。
export const MIGRATION_5 = `
ALTER TABLE captures ADD COLUMN server_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN server_rev INTEGER NOT NULL DEFAULT 0;

UPDATE outbox SET base_rev = COALESCE((SELECT server_rev FROM captures WHERE captures.id = outbox.target_id), 0)
 WHERE entity = 'capture' AND state = 'pending';
UPDATE outbox SET base_rev = COALESCE((SELECT server_rev FROM notes WHERE notes.id = outbox.target_id), 0)
 WHERE entity = 'note' AND state = 'pending';
`;

// v6：统一采集中心的附件与暂存（照片 / 语音 / 文件）——只在本机持久化，
// 不进同步载荷，因此协议、桌面端 schema 与既有 outbox 契约都不变。
//
// 1. attachments 独立于收集箱文本：文本仍走 captures + outbox；附件需要送到桌面端时
//    复用既有「文件互传」通道（/v1/files），transfer_state 记录独立生命周期
//    （pending → uploading → sent / failed / skipped）。文本同步成功 ≠ 附件已到桌面端。
// 2. owner_entity/owner_id 是稳定关联：收集箱条目、笔记、任务都可以挂附件；
//    收集箱转任务只改 owner_entity/owner_id，不复制文件、不重建记录。
// 3. capture_stash 是「尚未保存的采集」：拍照/录音/分享先落到这里，
//    应用被杀后仍可恢复；保存时与业务表在同一事务内转正并清空。
export const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY NOT NULL,
  owner_entity TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  local_uri TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  transcript TEXT,
  transfer_state TEXT NOT NULL DEFAULT 'pending',
  transfer_error TEXT,
  remote_file_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_attachments_owner
  ON attachments(owner_entity, owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_transfer
  ON attachments(transfer_state, created_at);

CREATE TABLE IF NOT EXISTS capture_stash (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  local_uri TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  transcript TEXT,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capture_stash_created ON capture_stash(created_at);
`;

// v7：采集提交幂等登记（收集箱/任务/笔记三向共用）。
//
// 为什么需要：v6 只有收集箱用 captures.client_id 防重；任务与笔记路径重复提交
// （双击保存、进程被杀后重试、DB 已提交但 UI 响应丢失）会各生成一条新记录。
// 这里用 client_id 主键登记「这次提交最终落在哪个实体上」，提交命中直接返回真实 id；
// 与业务行、附件行、删除暂存行在同一事务内写入，失败整体回滚，不会出现半登记。
export const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS capture_commits (
  client_id TEXT PRIMARY KEY NOT NULL,
  destination TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// v8：移动采集中心的持久素材库与多目的地状态（append-only，不改 v6/v7）。
//
// 为什么另立一张表而不是复用 capture_stash / attachments：
// - capture_stash 是「尚未确认保存的采集会话」，保存成功后按 id 删除；它不能承载
//   应用重启后仍要在「本机素材库」里看到、预览、再次发送的长期素材。
// - attachments 是「已归属到收集箱/任务/笔记」的附件，owner 外键是业务实体；
//   采集素材在归属前也必须独立存在，且同一素材有 4 个互相独立的目的地状态。
// - `capture_destinations` 每个目的地一行：一个失败不回滚其他已完成的结果。
export const MIGRATION_8 = `
CREATE TABLE IF NOT EXISTS capture_assets (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo','scan','audio','file')),
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  local_path TEXT,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  thumbnail_path TEXT,
  note TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  project_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('staged','saved')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_assets_created ON capture_assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_assets_state ON capture_assets(state);

CREATE TABLE IF NOT EXISTS capture_destinations (
  asset_id TEXT NOT NULL REFERENCES capture_assets(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('local','album','desktop','shelf')),
  state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed','cancelled')),
  remote_id TEXT,
  remote_shelf_id TEXT,
  album_uri TEXT,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (asset_id, destination)
);
CREATE INDEX IF NOT EXISTS idx_capture_destinations_state ON capture_destinations(state);
`;

// v9：开发者效率工具的本地持久层（2026-11-16）。append-only，不改 v1–v8。
//
// 三张表都属于**本机数据**，不进入同步协议、不写 outbox：
// - snippets：代码片段。跨设备只通过「导出文本文件 / 发送到电脑（文件互传）」，
//   协议里没有 snippet 实体，这里也不伪造「已同步」状态。
// - tool_requests：API 调试的请求定义与历史。敏感 header 值在写入前已脱敏
//   （见 domain/tools/apiRequest.ts 的 redactDraftForHistory），token 不落库。
// - tool_resources：项目资料与 GitHub 快捷入口的链接元数据。只存链接与标题，
//   不缓存网页正文；本地文件与在线链接用 storage 字段区分。
// 索引只覆盖真实查询：列表按更新时间倒序、按语言/类型过滤、按软删除过滤。
export const MIGRATION_9 = `
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snippets_list ON snippets(deleted_at, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_snippets_language ON snippets(language);

CREATE TABLE IF NOT EXISTS tool_requests (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('saved','history')),
  name TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '[]',
  headers_json TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  body_kind TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_requests_list ON tool_requests(kind, deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS tool_resources (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('doc','github')),
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  storage TEXT NOT NULL DEFAULT 'online' CHECK (storage IN ('online','local')),
  linked_kind TEXT,
  linked_id TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_resources_list ON tool_resources(kind, deleted_at, favorite DESC, updated_at DESC);
`;

/** 解析顺序即执行顺序；末尾追加新迁移，不要插入或重排。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
  { version: 3, sql: MIGRATION_3 },
  { version: 4, sql: MIGRATION_4 },
  { version: 5, sql: MIGRATION_5 },
  { version: 6, sql: MIGRATION_6 },
  { version: 7, sql: MIGRATION_7 },
  { version: 8, sql: MIGRATION_8 },
  { version: 9, sql: MIGRATION_9 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
