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

/** 解析顺序即执行顺序；末尾追加新迁移，不要插入或重排。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
  { version: 3, sql: MIGRATION_3 },
  { version: 4, sql: MIGRATION_4 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
