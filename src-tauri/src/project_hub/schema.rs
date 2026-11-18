//! 项目中枢 v78：项目根收敛、目标/能力/交付物/版本/事件与任务关联。
//!
//! 设计约束：
//! - 唯一项目根是 `workspace_projects`；`planning_projects` 只作为计划容器。
//! - 新增表全部以 `workspace_projects(id)` 为项目外键；阶段/计划用弱引用，避免备份恢复顺序违例。
//! - 能力库是全局表，项目删除不得删除共享能力。
//! - v77 协作中心保留 `project_id`（计划 ID）语义，新增 `workspace_project_id` 作为项目根。

pub const MIGRATION_78: (i64, &str) = (
    78,
    r#"
-- ── 既有表加列 ─────────────────────────────────────────────────────
ALTER TABLE workspace_projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_projects ADD COLUMN goal TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_projects ADD COLUMN target_date TEXT;
ALTER TABLE workspace_projects ADD COLUMN active_plan_id TEXT;

ALTER TABLE planning_projects ADD COLUMN workspace_project_id TEXT;
ALTER TABLE planning_projects ADD COLUMN template_id TEXT NOT NULL DEFAULT '';
ALTER TABLE planning_projects ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_plan_project ON planning_projects(workspace_project_id, is_active);

ALTER TABLE planning_milestones ADD COLUMN kind TEXT NOT NULL DEFAULT 'milestone'
  CHECK (kind IN ('phase','milestone'));
ALTER TABLE planning_milestones ADD COLUMN start_date TEXT;
ALTER TABLE planning_milestones ADD COLUMN phase_id TEXT;

-- ── 新表 ───────────────────────────────────────────────────────────
CREATE TABLE project_goals (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES project_goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'goal' CHECK (kind IN ('goal','subgoal')),
  metric TEXT NOT NULL DEFAULT '',
  target_value REAL,
  unit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','template','inferred')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pgoal_project ON project_goals(project_id, sort_order, created_at);
CREATE INDEX idx_pgoal_parent ON project_goals(parent_id);

CREATE TABLE project_capabilities (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'human'
    CHECK (category IN ('human','tool','ai','agent','external')),
  description TEXT NOT NULL DEFAULT '',
  mastery TEXT NOT NULL DEFAULT 'unknown'
    CHECK (mastery IN ('expert','proficient','basic','learning','none','unknown')),
  mastery_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name, category)
);
CREATE INDEX idx_pcap_category ON project_capabilities(category, name);

CREATE TABLE project_capability_requirements (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES project_capabilities(id) ON DELETE CASCADE,
  phase_id TEXT,
  necessity TEXT NOT NULL DEFAULT 'required'
    CHECK (necessity IN ('required','recommended','optional')),
  target_level TEXT NOT NULL DEFAULT 'basic',
  assessment_level TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','waived')),
  impact TEXT NOT NULL DEFAULT '',
  alternative TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','template','inferred')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, capability_id)
);
CREATE INDEX idx_pcreq_project ON project_capability_requirements(project_id, phase_id, necessity);
CREATE INDEX idx_pcreq_capability ON project_capability_requirements(capability_id);

CREATE TABLE capability_resource_links (
  id TEXT PRIMARY KEY NOT NULL,
  capability_id TEXT NOT NULL REFERENCES project_capabilities(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL
    CHECK (resource_kind IN ('knowledge','skill','mcp','agent','tool','template','workflow')),
  resource_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (availability IN ('available','partial','unavailable','unknown')),
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (capability_id, resource_kind, resource_id)
);
CREATE INDEX idx_crl_kind ON capability_resource_links(resource_kind, resource_id);

CREATE TABLE capability_gap_resolutions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES project_capabilities(id) ON DELETE CASCADE,
  solution TEXT NOT NULL
    CHECK (solution IN ('learn','resource','alternative','descope','accept')),
  resource_kind TEXT,
  resource_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','applied','rejected')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX idx_cgr_project ON capability_gap_resolutions(project_id, status, created_at);

CREATE TABLE project_deliverables (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  phase_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file'
    CHECK (kind IN ('file','document','build','asset','link','other')),
  target_path TEXT NOT NULL DEFAULT '',
  external_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','produced','accepted','rejected')),
  evidence TEXT NOT NULL DEFAULT '',
  produced_at TEXT,
  accepted_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pdel_project ON project_deliverables(project_id, phase_id, status);

CREATE TABLE plan_versions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'revision'
    CHECK (source IN ('manual','generated','revision','rollback','import')),
  parent_version_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE (project_id, version_no)
);
CREATE INDEX idx_pver_project ON plan_versions(project_id, created_at DESC);

CREATE TABLE project_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user' CHECK (actor IN ('user','agent','system')),
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pevent_project ON project_events(project_id, created_at DESC);

CREATE TABLE plan_dependencies (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  depends_on_phase_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, phase_id, depends_on_phase_id)
);

CREATE TABLE task_plan_links (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL DEFAULT '',
  milestone_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (task_id, phase_id, milestone_id)
);
CREATE INDEX idx_tpl_project ON task_plan_links(project_id, phase_id);

CREATE TABLE task_capability_links (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL REFERENCES project_capabilities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, capability_id)
);

-- ── v77 协作中心：A 方案项目根兼容列 ───────────────────────────────
ALTER TABLE collab_issues ADD COLUMN workspace_project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE collab_evidence ADD COLUMN workspace_project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE collab_plans ADD COLUMN workspace_project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE collab_visual_docs ADD COLUMN workspace_project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE collab_ai_jobs ADD COLUMN workspace_project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE collab_audit ADD COLUMN workspace_project_id TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_collab_issues_workspace
  ON collab_issues(workspace_project_id, status, updated_at);
CREATE INDEX idx_collab_evidence_workspace
  ON collab_evidence(workspace_project_id, created_at);
CREATE INDEX idx_collab_plans_workspace
  ON collab_plans(workspace_project_id, status, updated_at);
CREATE INDEX idx_collab_visual_workspace
  ON collab_visual_docs(workspace_project_id, kind, updated_at);
CREATE INDEX idx_collab_ai_jobs_workspace
  ON collab_ai_jobs(workspace_project_id, status, created_at);

-- ── 回填：计划 → 项目根 ────────────────────────────────────────────
CREATE TEMP TABLE _v78_project_map AS
SELECT p.id AS plan_id,
       CASE WHEN EXISTS (
         SELECT 1 FROM workspace_projects w WHERE w.id = p.id
       ) THEN 'plan-' || p.id ELSE p.id END AS workspace_id
FROM planning_projects p
WHERE p.workspace_project_id IS NULL OR p.workspace_project_id = '';

INSERT INTO workspace_projects
  (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at,
   description, goal, target_date, active_plan_id)
SELECT m.workspace_id,
       p.name,
       'general',
       CASE WHEN p.archived = 1 OR p.status = 'completed' THEN 'archived' ELSE 'active' END,
       '',
       NULL,
       p.description,
       p.created_at,
       p.updated_at,
       p.description,
       '',
       p.target_date,
       p.id
FROM _v78_project_map m
JOIN planning_projects p ON p.id = m.plan_id;

UPDATE planning_projects
SET workspace_project_id = (
  SELECT m.workspace_id FROM _v78_project_map m WHERE m.plan_id = planning_projects.id
)
WHERE (workspace_project_id IS NULL OR workspace_project_id = '')
  AND EXISTS (SELECT 1 FROM _v78_project_map m WHERE m.plan_id = planning_projects.id);

-- 每个项目只保留一个 active 计划；其余置 0，供 UI/服务显式选择。
UPDATE planning_projects SET is_active = 0;
UPDATE planning_projects
SET is_active = 1
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY workspace_project_id
             ORDER BY archived, updated_at DESC, id
           ) AS rn
    FROM planning_projects
    WHERE workspace_project_id IS NOT NULL AND workspace_project_id <> ''
  )
  WHERE rn = 1
);
CREATE UNIQUE INDEX idx_plan_project_active
  ON planning_projects(workspace_project_id)
  WHERE is_active = 1 AND workspace_project_id IS NOT NULL;

UPDATE collab_issues
SET workspace_project_id = (
  SELECT p.workspace_project_id FROM planning_projects p WHERE p.id = collab_issues.project_id
)
WHERE workspace_project_id = '';

UPDATE collab_evidence
SET workspace_project_id = (
  SELECT p.workspace_project_id FROM planning_projects p WHERE p.id = collab_evidence.project_id
)
WHERE workspace_project_id = '';

UPDATE collab_plans
SET workspace_project_id = (
  SELECT p.workspace_project_id FROM planning_projects p WHERE p.id = collab_plans.project_id
)
WHERE workspace_project_id = '';

UPDATE collab_visual_docs
SET workspace_project_id = (
  SELECT p.workspace_project_id FROM planning_projects p WHERE p.id = collab_visual_docs.project_id
)
WHERE workspace_project_id = '';

UPDATE collab_ai_jobs
SET workspace_project_id = (
  SELECT p.workspace_project_id FROM planning_projects p WHERE p.id = collab_ai_jobs.project_id
)
WHERE workspace_project_id = '';

UPDATE collab_audit
SET workspace_project_id = (
  SELECT p.workspace_project_id FROM planning_projects p WHERE p.id = collab_audit.project_id
)
WHERE workspace_project_id = '';

DROP TABLE temp._v78_project_map;
"#,
);
