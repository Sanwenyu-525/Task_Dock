//! 快速笔记表结构（草稿版本）。
//!
//! 由集成会话在 `db::MIGRATIONS` 末尾追加 `(N, notes::schema::NOTES_SCHEMA)`，
//! 版本号以集成时仓库当前最大版本为准（本模块不直接修改 `db/mod.rs`）。
//!
//! 设计要点：
//! - `revision` 用于编辑并发检测：自动保存携带 `expected_revision`，不匹配返回
//!   `CONFLICT`，前端保留草稿并允许显式覆盖，绝不静默覆盖他人的新内容。
//! - `source_capture_id` 唯一索引保证「收集箱转笔记」重试不会重复创建。
//! - 任务 / 工作现场为弱关联：被关联对象删除时置空（`ON DELETE SET NULL`），
//!   笔记本身必须保留。
//! - 纯文本 `content` 上限由 store 层校验（`MAX_CONTENT`），不在 CHECK 里重复。

pub const NOTES_SCHEMA: &str = r#"
-- 快速笔记（长期保留、可继续编辑的记录 / 工作备忘）。
-- 与收集箱严格分离：收集箱条目只读复制，不修改原条目；本表是独立笔记。
CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  workspace_id TEXT REFERENCES workspace_snapshots(id) ON DELETE SET NULL,
  source_capture_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 默认列表：置顶优先，再按最近更新。
CREATE INDEX idx_notes_pinned_updated ON notes(pinned DESC, updated_at DESC);
CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
CREATE INDEX idx_notes_task ON notes(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_notes_workspace ON notes(workspace_id) WHERE workspace_id IS NOT NULL;
-- 收集箱转笔记的幂等键：同一原条目最多对应一条笔记。
CREATE UNIQUE INDEX idx_notes_source_capture ON notes(source_capture_id)
  WHERE source_capture_id IS NOT NULL;
"#;
