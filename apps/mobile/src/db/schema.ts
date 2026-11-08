// 本地库结构：与桌面端 SQLite 字段名保持一致，便于后续同步时直接对字段。
// 手机端专属的同步元数据（rev）留在本表内，不进入桌面 schema。
//
// 迁移规则与仓库一致：只在末尾追加，不修改已发布的迁移；版本号写 PRAGMA user_version。
export const DATABASE_NAME = "taskdock.db";
export const SCHEMA_VERSION = 1;

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
