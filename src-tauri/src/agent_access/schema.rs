//! Agent 共享工作空间表结构（迁移 v76，追加式）。
//!
//! 设计约束（见 `docs/agent-workspace/data-model.md`）：
//! - 不新建第二套 Task / Project / Knowledge / Plan；既有实体只加计数器与弱关联；
//! - 新增表只承载此前不存在的语义：工作空间注册、同步索引、统一版本、决策、交接、
//!   工作报告、活动日志、同步事件/冲突、上下文访问、REST 幂等缓存；
//! - `mcp_agent_capabilities` 因 SQLite 无法改 CHECK，按既有 v73/v75 的做法重建并
//!   逐行复制旧授权；不改任何已发布迁移。

pub const MIGRATION_76: (i64, &str) = (
    76,
    r#"
-- v76（Agent 共享工作空间）：身份元数据 + 能力白名单扩展 + 十张新表。
-- 与任务/项目/知识/规划既有表的关系是「引用与计数」，不是「复制」。

-- 1) Agent 身份元数据（只加列，不重建）。旧行取空串默认值，旧程序 SELECT 不引用。
ALTER TABLE mcp_agents ADD COLUMN vendor TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_agents ADD COLUMN interface_hint TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_agents ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- 2) 能力白名单扩展：项目/规划/知识写/决策/上下文/交接。
--    重建保留主键、外键、唯一键与索引，旧授权原样复制（默认最小权限不变）。
CREATE TABLE mcp_agent_capabilities_v76 (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN (
    'projects.read','tasks.read','tasks.write','plans.read',
    'knowledge.read','knowledge.write','decisions.read','decisions.write',
    'context.read','handoffs.read','handoffs.write','skills.read',
    'notes.read','notes.write','workflows.read','workspace.read'
  )),
  resource_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (agent_row_id, capability, resource_id)
);
INSERT INTO mcp_agent_capabilities_v76(id, agent_row_id, capability, resource_id, created_at)
SELECT id, agent_row_id, capability, resource_id, created_at FROM mcp_agent_capabilities;
DROP TABLE mcp_agent_capabilities;
ALTER TABLE mcp_agent_capabilities_v76 RENAME TO mcp_agent_capabilities;
CREATE INDEX idx_mcp_caps_agent ON mcp_agent_capabilities(agent_row_id, capability);

-- 3) 共享工作空间注册。root_path 是用户显式选择的目录，绝不由代码猜测。
CREATE TABLE agent_workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  root_path TEXT NOT NULL COLLATE NOCASE,
  protocol_version TEXT NOT NULL DEFAULT '1.0',
  schema_version TEXT NOT NULL DEFAULT '1.0',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  watch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (watch_enabled IN (0,1)),
  last_export_at TEXT,
  last_scan_at TEXT,
  last_import_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_agent_workspaces_root ON agent_workspaces(root_path);

-- 4) 同步索引：区分「自身写入」与「外部修改」的唯一依据。
CREATE TABLE agent_workspace_files (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_row_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL COLLATE NOCASE,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  exported_revision INTEGER NOT NULL DEFAULT 0,
  exported_hash TEXT NOT NULL DEFAULT '',
  last_seen_hash TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'in_sync'
    CHECK (state IN ('in_sync','stale','modified_external','conflict','deleted','untracked')),
  exported_at TEXT,
  last_seen_at TEXT,
  UNIQUE (workspace_row_id, rel_path)
);
CREATE INDEX idx_awf_state ON agent_workspace_files(workspace_row_id, state);
CREATE INDEX idx_awf_resource ON agent_workspace_files(workspace_row_id, resource_kind, resource_id);

-- 5) 统一版本计数器：UI / CLI / MCP / REST / 文件 共用。业务表自身的 updated_at
--    同时参与冲突校验，因此绕过服务层的 UI 写入也能被检测。
CREATE TABLE agent_resource_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_kind IN ('human','agent','system')),
  source TEXT NOT NULL DEFAULT 'ui'
    CHECK (source IN ('ui','cli','mcp','rest','file','system')),
  content_hash TEXT NOT NULL DEFAULT '',
  UNIQUE (resource_kind, resource_id)
);
CREATE INDEX idx_arr_updated ON agent_resource_revisions(updated_at DESC);
CREATE INDEX idx_arr_kind ON agent_resource_revisions(resource_kind, updated_at DESC);

-- 6) 决策记录（ADR）。project_id 是弱引用（规划项目或项目工作空间，二选一），
--    无外键：项目删除后决策仍保留用于追溯，`project_kind` 标明来源。
CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  project_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (project_kind IN ('none','planning','workspace')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','accepted','superseded','rejected')),
  context TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '',
  consequences TEXT NOT NULL DEFAULT '',
  alternatives TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_kind IN ('human','agent','system')),
  source TEXT NOT NULL DEFAULT 'ui'
    CHECK (source IN ('ui','cli','mcp','rest','file','system')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_decisions_project ON agent_decisions(project_id, created_at DESC);
CREATE INDEX idx_agent_decisions_status ON agent_decisions(status, updated_at DESC);

-- 7) 跨 Agent 交接。from/to 身份同时保存「行 ID」与「agent_id 快照」：
--    身份撤销或删除后仍可追溯是谁交给谁（行 ID 允许为空）。
CREATE TABLE agent_handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  project_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (project_kind IN ('none','planning','workspace')),
  task_id TEXT,
  from_agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL,
  from_agent_id TEXT NOT NULL DEFAULT '',
  to_agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL,
  to_agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','completed','cancelled')),
  summary TEXT NOT NULL DEFAULT '',
  completed_items TEXT NOT NULL DEFAULT '[]',
  pending_items TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]',
  files_changed TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  next_steps TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  accepted_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_handoffs_status ON agent_handoffs(status, created_at DESC);
CREATE INDEX idx_agent_handoffs_project ON agent_handoffs(project_id, created_at DESC);
CREATE INDEX idx_agent_handoffs_target ON agent_handoffs(to_agent_row_id, status);

-- 8) 工作报告：追加式，不可修改；`evidence` 只放可复核元数据。
CREATE TABLE agent_work_reports (
  id TEXT PRIMARY KEY NOT NULL,
  handoff_id TEXT REFERENCES agent_handoffs(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'completed'
    CHECK (result IN ('completed','partial','blocked','failed')),
  completed_items TEXT NOT NULL DEFAULT '[]',
  pending_items TEXT NOT NULL DEFAULT '[]',
  files_changed TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'cli'
    CHECK (source IN ('cli','mcp','rest','file','ui')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_reports_created ON agent_work_reports(created_at DESC);
CREATE INDEX idx_agent_reports_handoff ON agent_work_reports(handoff_id, created_at DESC);
CREATE INDEX idx_agent_reports_agent ON agent_work_reports(agent_id, created_at DESC);

-- 9) 四入口统一活动日志：只存元数据与脱敏摘要，不存正文与凭据。
CREATE TABLE agent_activity_logs (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'agent'
    CHECK (actor_kind IN ('agent','local','system')),
  interface TEXT NOT NULL
    CHECK (interface IN ('cli','mcp','rest','file','ui','system')),
  session_key TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0,1)),
  error_code TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  revision INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_aal_created ON agent_activity_logs(created_at DESC);
CREATE INDEX idx_aal_agent ON agent_activity_logs(agent_row_id, created_at DESC);
CREATE INDEX idx_aal_session ON agent_activity_logs(session_key, created_at DESC);
CREATE INDEX idx_aal_interface ON agent_activity_logs(interface, created_at DESC);

-- 10) 同步事件与冲突。冲突表以 (workspace, rel_path) 唯一，避免同一文件堆积多条。
CREATE TABLE agent_sync_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_row_id TEXT REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('export','import','scan','resolve')),
  event_kind TEXT NOT NULL,
  rel_path TEXT NOT NULL DEFAULT '',
  resource_kind TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ok','skipped','failed','conflict')),
  message TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ase_created ON agent_sync_events(created_at DESC);
CREATE INDEX idx_ase_status ON agent_sync_events(workspace_row_id, status, created_at DESC);

CREATE TABLE agent_sync_conflicts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_row_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  db_revision INTEGER NOT NULL DEFAULT 0,
  file_revision INTEGER NOT NULL DEFAULT 0,
  db_hash TEXT NOT NULL DEFAULT '',
  file_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved_db','resolved_file','merged','dismissed')),
  resolution TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (workspace_row_id, rel_path)
);
CREATE INDEX idx_asc_status ON agent_sync_conflicts(workspace_row_id, status, detected_at DESC);

-- 11) 上下文访问日志：只记录规模与来源，不记录上下文正文。
CREATE TABLE agent_context_access_logs (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  interface TEXT NOT NULL CHECK (interface IN ('cli','mcp','rest','file','ui')),
  purpose TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown',
  budget_tokens INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_acal_created ON agent_context_access_logs(created_at DESC);
CREATE INDEX idx_acal_agent ON agent_context_access_logs(agent_id, created_at DESC);

-- 12) REST 幂等缓存（24h）：唯一键防重复执行；按 expires_at 定期删除。
CREATE TABLE agent_request_cache (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE CASCADE,
  interface TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 200,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (agent_row_id, interface, idempotency_key)
);
CREATE INDEX idx_arc_expires ON agent_request_cache(expires_at);
"#,
);

#[cfg(test)]
mod tests {
    use crate::db::Db;

    #[test]
    fn migration_76_creates_agent_access_tables() {
        let db = Db::open_in_memory().unwrap();
        db.with_read(|conn| {
            for table in [
                "agent_workspaces",
                "agent_workspace_files",
                "agent_resource_revisions",
                "agent_decisions",
                "agent_handoffs",
                "agent_work_reports",
                "agent_activity_logs",
                "agent_sync_events",
                "agent_sync_conflicts",
                "agent_context_access_logs",
                "agent_request_cache",
            ] {
                let n: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )?;
                assert_eq!(n, 1, "缺少表 {table}");
            }
            // 旧能力授权在白名单扩展后仍然可用（重建不得丢行）。
            let cols: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('mcp_agents') WHERE name IN ('vendor','interface_hint','note')",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(cols, 3, "mcp_agents 缺元数据列");
            Ok(())
        })
        .unwrap();
    }
}
