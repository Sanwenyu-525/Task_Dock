//! 能力中心表结构（迁移 v72，追加式）。
//!
//! 说明：
//! - 仅新增表与索引，不改既有表；`knowledge_bases.project_id` 删除项目时置空，
//!   避免误删用户资料；
//! - 分块表是检索索引，正文同时保存在 `knowledge_documents.content`，单库可重建；
//! - 原始文件永远不在 SQLite 之外被本模块删除（导入副本除外）。

pub const MIGRATION_72: (i64, &str) = (
    72,
    r#"
-- 知识库（个人 / 项目 / 专业工作区）。
CREATE TABLE knowledge_bases (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'personal'
    CHECK (kind IN ('personal','project','workspace')),
  project_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_kb_kind ON knowledge_bases(kind, updated_at DESC);
CREATE INDEX idx_kb_project ON knowledge_bases(project_id) WHERE project_id IS NOT NULL;

-- 知识文档：reference=只引用原文件；imported=受管副本。
-- content 是索引正文（≤2 MiB），source_path 是绝对来源路径或笔记/采集箱 id。
CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY NOT NULL,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('file','folder','note','capture','text')),
  source_mode TEXT NOT NULL CHECK (source_mode IN ('reference','imported')),
  source_path TEXT,
  managed_rel_path TEXT,
  mime TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','indexed','failed')),
  error TEXT NOT NULL DEFAULT '',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_kd_kb ON knowledge_documents(kb_id, updated_at DESC);
CREATE INDEX idx_kd_status ON knowledge_documents(kb_id, status);
CREATE UNIQUE INDEX idx_kd_kb_source ON knowledge_documents(kb_id, source_path)
  WHERE source_path IS NOT NULL AND source_path <> '';

-- 检索分块：1200 字符 / 200 重叠；start_offset 用于原文定位。
CREATE TABLE knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  content TEXT NOT NULL,
  UNIQUE (doc_id, ordinal)
);
CREATE INDEX idx_kc_doc ON knowledge_chunks(doc_id, ordinal);
CREATE INDEX idx_kc_kb ON knowledge_chunks(kb_id);

-- 知识 ↔ 任务/项目/笔记/会话/工作流/文件 的弱关联。
CREATE TABLE knowledge_links (
  id TEXT PRIMARY KEY NOT NULL,
  doc_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('task','project','note','agent_session','workflow','file')),
  target_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (doc_id, target_kind, target_id)
);
CREATE INDEX idx_kl_target ON knowledge_links(target_kind, target_id);

-- Agent Skills：source_path 是 Skill 目录绝对路径（不是 SKILL.md）。
CREATE TABLE capability_skills (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL CHECK (source_kind IN ('discovered','imported')),
  source_path TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global'
    CHECK (scope IN ('global','project','workspace','agent')),
  project_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  risk_notes TEXT NOT NULL DEFAULT '[]',
  version TEXT NOT NULL DEFAULT '',
  format_ok INTEGER NOT NULL DEFAULT 1 CHECK (format_ok IN (0,1)),
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0,1)),
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_skill_path ON capability_skills(source_path);
CREATE INDEX idx_skill_scope ON capability_skills(scope, project_id, enabled);

-- 外部 MCP Server（v1 仅 stdio）。env_json 只在本地连接时使用。
CREATE TABLE external_mcp_servers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio' CHECK (transport IN ('stdio')),
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  allow_high_risk INTEGER NOT NULL DEFAULT 0 CHECK (allow_high_risk IN (0,1)),
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','ok','failed','disabled')),
  last_error TEXT NOT NULL DEFAULT '',
  server_info_json TEXT NOT NULL DEFAULT '{}',
  tools_json TEXT NOT NULL DEFAULT '[]',
  resources_json TEXT NOT NULL DEFAULT '[]',
  prompts_json TEXT NOT NULL DEFAULT '[]',
  last_connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 外部调用记录：只存元数据，不存参数/返回正文/env。
CREATE TABLE external_mcp_calls (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES external_mcp_servers(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_emc_server ON external_mcp_calls(server_id, created_at DESC);

-- 项目上下文配置。
CREATE TABLE capability_contexts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 能力配方与运行记录。
CREATE TABLE capability_recipes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE capability_recipe_runs (
  id TEXT PRIMARY KEY NOT NULL,
  recipe_id TEXT NOT NULL REFERENCES capability_recipes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_crr_recipe ON capability_recipe_runs(recipe_id, started_at DESC);
"#,
);

/// 迁移 74：真实绑定与 Agent 作用域对象。
///
/// - `knowledge_bases.workspace_id`：工作区类型知识库的真实绑定。现有系统唯一的稳定
///   Workspace 身份是 `workspace_projects.id`（项目工作空间），本轮直接复用，不新建
///   重复 Workspace 表；`project_id` 与 `workspace_id` 都是真实外键，禁止伪绑定。
/// - `capability_skills.workspace_id / agent_id`：workspace / agent 作用域的真实对象；
///   agent 复用 MCP Server 已存在的 `mcp_agents.id`，不引入第二套 Agent 身份。
/// - `external_mcp_confirmed_tools`：未知风险工具的首次调用确认记录（Server 删除级联）。
pub const MIGRATION_74: (i64, &str) = (
    74,
    r#"
ALTER TABLE knowledge_bases
  ADD COLUMN workspace_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL;
CREATE INDEX idx_kb_workspace ON knowledge_bases(workspace_id)
  WHERE workspace_id IS NOT NULL;

ALTER TABLE capability_skills
  ADD COLUMN workspace_id TEXT REFERENCES workspace_projects(id) ON DELETE SET NULL;
ALTER TABLE capability_skills
  ADD COLUMN agent_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL;
CREATE INDEX idx_skill_binding
  ON capability_skills(scope, project_id, workspace_id, agent_id, enabled);

CREATE TABLE external_mcp_confirmed_tools (
  server_id TEXT NOT NULL REFERENCES external_mcp_servers(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (server_id, tool_name)
);
"#,
);

#[cfg(test)]
mod tests {
    use crate::db::Db;

    #[test]
    fn migration_72_creates_capability_tables() {
        let db = Db::open_in_memory().unwrap();
        db.with_read(|conn| {
            for table in [
                "knowledge_bases",
                "knowledge_documents",
                "knowledge_chunks",
                "knowledge_links",
                "capability_skills",
                "external_mcp_servers",
                "external_mcp_calls",
                "capability_contexts",
                "capability_recipes",
                "capability_recipe_runs",
                "external_mcp_confirmed_tools",
            ] {
                let n: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )?;
                assert_eq!(n, 1, "缺少表 {table}");
            }
            Ok(())
        })
        .unwrap();
    }
}
