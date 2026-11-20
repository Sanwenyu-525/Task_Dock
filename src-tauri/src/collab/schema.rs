//! 协作与可视化规划中心（v77）：需求/Bug/方案/证据/可视化/版本/AI 任务/审计。
//!
//! 设计约束：
//! - 纯新增表，不修改 `planning_*` / `tasks` / 既有迁移；
//! - 不复制既有业务实体，方案与任务用弱关联（`collab_plan_links`）；
//! - 所有可写实体带 `revision`，版本表只增不减；
//! - DDL 放在本文件，`db/mod.rs` 只登记迁移号（与 capability/mcp schema 同一约定）。

pub const MIGRATION_77: &str = r#"
CREATE TABLE collab_issues (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('feature','improvement','architecture','performance','security','tech_debt','bug','other')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN
    ('open','triaged','in_progress','resolved','verified','closed','archived')),
  acceptance TEXT NOT NULL DEFAULT '',
  repro_steps TEXT NOT NULL DEFAULT '[]',
  expected_result TEXT,
  actual_result TEXT,
  environment TEXT,
  related_files TEXT NOT NULL DEFAULT '[]',
  resolution TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL DEFAULT '',
  source_agent TEXT NOT NULL DEFAULT '',
  source_session TEXT NOT NULL DEFAULT '',
  client_request_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ui'
    CHECK (source IN ('ui','cli','mcp','rest','file','system','ai')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_collab_issues_project_status ON collab_issues(project_id, status, updated_at);
CREATE INDEX idx_collab_issues_project_kind ON collab_issues(project_id, kind, updated_at);
CREATE INDEX idx_collab_issues_dedupe ON collab_issues(project_id, dedupe_key);
CREATE INDEX idx_collab_issues_source ON collab_issues(source_agent, source_session);
CREATE INDEX idx_collab_issues_request ON collab_issues(project_id, client_request_id)
  WHERE client_request_id <> '';
CREATE INDEX idx_collab_issues_priority ON collab_issues(project_id, priority, status);

CREATE TABLE collab_issue_links (
  id TEXT PRIMARY KEY NOT NULL,
  issue_id TEXT NOT NULL REFERENCES collab_issues(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('issue','plan')),
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('related','duplicate','blocks','caused_by')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(issue_id, target_kind, target_id, relation)
);
CREATE INDEX idx_collab_issue_links_target ON collab_issue_links(target_kind, target_id);

CREATE TABLE collab_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('issue','bug','plan','task','visual')),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot','log','stack','video','report','test','other')),
  title TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ui'
    CHECK (source IN ('ui','cli','mcp','rest','file','system','ai')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, sha256, subject_kind, subject_id)
);
CREATE INDEX idx_collab_evidence_subject ON collab_evidence(subject_kind, subject_id, created_at);
CREATE INDEX idx_collab_evidence_project ON collab_evidence(project_id, created_at);

CREATE TABLE collab_plans (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
  issue_id TEXT REFERENCES collab_issues(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  solution_md TEXT NOT NULL DEFAULT '',
  breakdown_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','in_review','changes_requested','approved','developing','accepting','completed','archived')),
  review_note TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL DEFAULT '',
  approved_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_collab_plans_project_status ON collab_plans(project_id, status, updated_at);
CREATE INDEX idx_collab_plans_issue ON collab_plans(issue_id);

CREATE TABLE collab_plan_links (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES collab_plans(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('issue','visual','task','feature')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, target_kind, target_id)
);
CREATE INDEX idx_collab_plan_links_target ON collab_plan_links(target_kind, target_id);

CREATE TABLE collab_visual_docs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES collab_plans(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN
    ('flowchart','architecture','dataflow','prototype','bug_annotation','static_image','diff')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  source_format TEXT NOT NULL CHECK (source_format IN ('json','mermaid','image','svg')),
  source_content TEXT NOT NULL DEFAULT '{}',
  renderer TEXT NOT NULL,
  preview_asset TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_collab_visual_project ON collab_visual_docs(project_id, kind, updated_at);
CREATE INDEX idx_collab_visual_plan ON collab_visual_docs(plan_id);

CREATE TABLE collab_visual_versions (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES collab_visual_docs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ui'
    CHECK (source IN ('ui','cli','mcp','rest','file','system','ai')),
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version)
);

CREATE TABLE collab_ai_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES collab_plans(id) ON DELETE SET NULL,
  document_id TEXT REFERENCES collab_visual_docs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','image')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','succeeded','failed','cancelled','provider_unavailable')),
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  cost_units REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_collab_ai_jobs_project ON collab_ai_jobs(project_id, status, created_at);

CREATE TABLE collab_audit (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  revision_before INTEGER,
  revision_after INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_collab_audit_entity ON collab_audit(entity_kind, entity_id, created_at);
CREATE INDEX idx_collab_audit_project ON collab_audit(project_id, created_at);
"#;

/// v85（2026-11-20）：创作工作台。
///
/// - 文档与版本增加 `authoring_mode`（人工/AI/Agent/导入），与 `source` 正交；
/// - 新增可视化资产表（图片），只存元数据与受控路径，不复用证据表。
///
/// 纯新增列 + 新表，不重建 v77 表；`ADD COLUMN` 不带 CHECK，枚举由服务层校验，
/// 避免旧数据在升级时被数据库约束卡住。
pub const MIGRATION_85: &str = r#"
ALTER TABLE collab_visual_docs ADD COLUMN authoring_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE collab_visual_versions ADD COLUMN authoring_mode TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE collab_visual_assets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES planning_projects(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES collab_visual_docs(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ui'
    CHECK (source IN ('ui','cli','mcp','rest','file','system','ai')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, sha256)
);
CREATE INDEX idx_collab_visual_assets_project ON collab_visual_assets(project_id, status, created_at);
CREATE INDEX idx_collab_visual_assets_document ON collab_visual_assets(document_id);
"#;
