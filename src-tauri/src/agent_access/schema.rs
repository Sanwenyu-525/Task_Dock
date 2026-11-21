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

pub const MIGRATION_81: (i64, &str) = (
    81,
    r#"
-- v81（文件导入授权）：把「可以写某个 Inbox」与「可以改 TaskDock 全部资源」分开。
-- 1) 目录策略：默认无行 = 待审核；trusted 仍需能力集合 + 项目范围。
CREATE TABLE IF NOT EXISTS agent_import_policies (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_row_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  rel_dir TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'review' CHECK (mode IN ('off','review','trusted')),
  agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  project_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_row_id, rel_dir)
);
CREATE INDEX IF NOT EXISTS idx_aip_ws ON agent_import_policies(workspace_row_id, rel_dir);

-- 2) 待审核导入：只存元数据与摘要，正文仍在共享目录中，不复制进库。
CREATE TABLE IF NOT EXISTS agent_import_requests (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_row_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  claimed_agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','imported','failed')),
  reason TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT NOT NULL DEFAULT '',
  UNIQUE (workspace_row_id, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_air_status ON agent_import_requests(workspace_row_id, status, created_at DESC);

-- 3) 导入幂等声明：业务写入前先占位，成功置 ok，失败释放。
--    仅按内容 Hash 去重会把「不同请求、相同内容」误判为同一操作，因此加入
--    操作类型与请求身份（rel_path + kind + actor）。
CREATE TABLE IF NOT EXISTS agent_import_claims (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_row_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  claim_key TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inflight' CHECK (status IN ('inflight','ok')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_row_id, claim_key)
);
CREATE INDEX IF NOT EXISTS idx_aic_hash ON agent_import_claims(workspace_row_id, content_hash);
"#,
);

/// v82（稳定性加固）：导入租约、请求指纹、报告项目归属回填。
///
/// 设计约束：
/// - **只加列，不重建 v81 已发布的表**。`agent_import_claims.status` 仍只有
///   `inflight|ok`；「失败」由「租约释放/过期」表达，状态机在 Rust 侧用
///   `ImportOutcome` 枚举收敛，不依赖 bool。
/// - 迁移号取 83，因为 82 已被安全审计表（`security_audit_log`）占用。
/// - 第 4 段是数据修复：只填空值，不改已有归属，不删行。
pub const MIGRATION_83: (i64, &str) = (
    83,
    r#"
-- 1) 导入认领：租约（执行者 / 认领时间 / 过期时间 / 尝试次数）。
--    过期租约可被抢占，进程崩溃后不必人工清表。
ALTER TABLE agent_import_claims ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_import_claims ADD COLUMN claimed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_import_claims ADD COLUMN expires_at TEXT;
ALTER TABLE agent_import_claims ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_aic_lease
  ON agent_import_claims(workspace_row_id, status, expires_at);

-- 2) 导入请求：租约列 + 决策时所依据的内容 Hash（区分「同内容幂等」与「新内容重审」）。
ALTER TABLE agent_import_requests ADD COLUMN lease_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_import_requests ADD COLUMN lease_expires_at TEXT;
ALTER TABLE agent_import_requests ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_import_requests ADD COLUMN decided_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_air_lease
  ON agent_import_requests(workspace_row_id, lease_expires_at);

-- 3) REST 幂等：进行中占位状态 + 指纹要素（method/path 参与指纹，防止同 Key 跨端点重放）
--    + attempt（单调递增的 fencing token：旧请求不得完成/删除新请求的占位）。
ALTER TABLE agent_request_cache ADD COLUMN state TEXT NOT NULL DEFAULT 'done';
ALTER TABLE agent_request_cache ADD COLUMN request_method TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_request_cache ADD COLUMN request_path TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_request_cache ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_arc_state ON agent_request_cache(state, expires_at);

-- 4) 数据修复：历史工作报告补齐项目归属（只填空值，不动已有值）。
UPDATE agent_work_reports
SET project_id = (
  SELECT h.project_id FROM agent_handoffs h WHERE h.id = agent_work_reports.handoff_id
)
WHERE (project_id IS NULL OR project_id = '')
  AND handoff_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM agent_handoffs h
    WHERE h.id = agent_work_reports.handoff_id AND h.project_id <> ''
  );
"#,
);

/// v82 补齐（迁移 84）：REST 幂等的「业务提交结果」持久化。
///
/// 问题：v82 的 `agent_request_cache` 只有 `inflight|done` 两态，业务事务与
/// 「写缓存响应」是两个独立提交。进程若在两者之间退出，缓存仍是 `inflight`，
/// 租约过期后重试会**再次执行业务创建**。
///
/// 修复：在**业务写事务内**把创建成功的资源指针写入同一行缓存（`state=committed`），
/// 业务提交与「已提交」标记原子生效。租约过期后重试看到 `committed` 时不再执行，
/// 而是按 operation 指针重建响应或返回明确的「需要恢复」错误。
///
/// 只加列，不重建 v82 已发布的 `agent_request_cache`。
pub const MIGRATION_84: (i64, &str) = (
    84,
    r#"
-- 业务提交指针：与业务数据同事务写入（state='committed'），响应丢失后据此重建。
ALTER TABLE agent_request_cache ADD COLUMN operation_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_request_cache ADD COLUMN operation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_request_cache ADD COLUMN committed_at TEXT;
-- committed 行不因租约过期被抢占：重试必须走恢复，而不是重新执行。
CREATE INDEX IF NOT EXISTS idx_arc_committed
  ON agent_request_cache(state, committed_at);
"#,
);

/// v86（Agent 操作可视化）：统一操作生命周期表。
///
/// 与 `agent_activity_logs` 的分工：
/// - 本表是**可变的过程状态**（running 会被更新为终态），一行业务写入对应一行；
/// - 活动日志仍是**追加式审计**，只增不改。两者用 `request_id` 与资源指针关联，
///   不把审计表改造成运行状态表。
///
/// 约束：
/// - `resource_id` 在创建前允许为空（新建资源尚未分配 ID），提交后绑定真实 ID；
/// - `agent_row_id` 仅作弱引用（ON DELETE SET NULL），`agent_id` 是身份快照，
///   Agent 删除后仍可追溯；
/// - 不存文件正文、Token、密码或绝对路径，`detail` 由写入方脱敏；
/// - 资源被删除后本表不级联删除：历史操作保留，前端不再尝试定位已删除资源。
pub const MIGRATION_86: (i64, &str) = (
    86,
    r#"
CREATE TABLE IF NOT EXISTS agent_operations (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT REFERENCES mcp_agents(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'agent'
    CHECK (actor_kind IN ('agent','local','system')),
  interface TEXT NOT NULL
    CHECK (interface IN ('cli','mcp','rest','file','ui','system')),
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','committed','failed','conflict','interrupted')),
  phase TEXT NOT NULL DEFAULT 'started'
    CHECK (phase IN ('started','writing','finalizing','done')),
  revision INTEGER,
  request_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  lease_expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_ops_status
  ON agent_operations(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_ops_resource
  ON agent_operations(resource_kind, resource_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_ops_project
  ON agent_operations(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_ops_agent
  ON agent_operations(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_ops_cursor
  ON agent_operations(updated_at, id);
"#,
);

/// v88（v86.1 可靠性修复）：操作状态版本 + 租约扫描索引。
///
/// `state_revision` 是**同一操作内部**的单调版本号：
/// - 每次真实状态变更（状态/阶段/资源绑定/详情追加）+1；
/// - 心跳与读取不推进——心跳不是状态变更，不能推动游标；
/// - 前端以它优先于时间戳判定先后，避免同一时间戳或时钟回拨导致终态回退。
///
/// 旧行默认 0（表示「v88 之前写入」），新行从 1 开始；不修改既有状态语义。
/// `idx_agent_ops_lease` 让周期过期扫描按索引定位，而不是全表扫 running。
pub const MIGRATION_88: (i64, &str) = (
    88,
    r#"
ALTER TABLE agent_operations ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_agent_ops_lease
  ON agent_operations(status, lease_expires_at);
"#,
);

/// v90：能力白名单扩展「项目创建 / 项目写」。
///
/// SQLite 无法原地修改 CHECK，按 v73/v75/v76 的既有做法重建并逐行复制旧授权。
/// **不新增默认授权**：创建项目必须由用户在「Agent 接入」里显式勾选，
/// `scope=project_rw` 不等于可以创建项目。
pub const MIGRATION_90: (i64, &str) = (
    90,
    r#"
CREATE TABLE mcp_agent_capabilities_v90 (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN (
    'projects.read','projects.create','projects.write',
    'tasks.read','tasks.write','plans.read',
    'knowledge.read','knowledge.write','decisions.read','decisions.write',
    'context.read','handoffs.read','handoffs.write','skills.read',
    'notes.read','notes.write','workflows.read','workspace.read'
  )),
  resource_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (agent_row_id, capability, resource_id)
);
INSERT INTO mcp_agent_capabilities_v90(id, agent_row_id, capability, resource_id, created_at)
SELECT id, agent_row_id, capability, resource_id, created_at FROM mcp_agent_capabilities;
DROP TABLE mcp_agent_capabilities;
ALTER TABLE mcp_agent_capabilities_v90 RENAME TO mcp_agent_capabilities;
CREATE INDEX idx_mcp_caps_agent ON mcp_agent_capabilities(agent_row_id, capability);
"#,
);

/// v91：把项目授权表的外键从「计划」改到「项目根」。
///
/// 为什么必须改：`mcp_agent_grants.project_id` 原本 `REFERENCES planning_projects(id)`，
/// 而统一身份后授权目标是 `workspace_projects(id)`；在外键开启时写入项目根会直接失败。
/// 迁移先为「有授权但缺项目根」的历史计划补建根（与 v78 / `ensure_project_for_plan_tx`
/// 同一规则：同 ID 优先），再重建表并逐行映射，**不丢任何有效授权**。
pub const MIGRATION_91: (i64, &str) = (
    91,
    r#"
-- 1) 有授权但缺项目根的历史计划：同 ID 补建项目根。
INSERT INTO workspace_projects
  (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at,
   description, goal, target_date, active_plan_id)
SELECT p.id, p.name, 'general',
       CASE WHEN p.archived = 1 OR p.status = 'completed' THEN 'archived' ELSE 'active' END,
       '', NULL, p.description, p.created_at, p.updated_at, p.description, '', p.target_date, NULL
FROM planning_projects p
WHERE EXISTS (SELECT 1 FROM mcp_agent_grants g WHERE g.project_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM workspace_projects w WHERE w.id = p.id);

-- 2) 计划归属与 active 指针：只在缺失时补，不覆盖既有选择。
UPDATE planning_projects
SET workspace_project_id = id, is_active = 1
WHERE id IN (SELECT project_id FROM mcp_agent_grants)
  AND (workspace_project_id IS NULL OR workspace_project_id = '');

UPDATE workspace_projects
SET active_plan_id = (
  SELECT p.id FROM planning_projects p
  WHERE p.workspace_project_id = workspace_projects.id AND p.is_active = 1
  ORDER BY p.created_at LIMIT 1
)
WHERE active_plan_id IS NULL
  AND EXISTS (
    SELECT 1 FROM planning_projects p
    WHERE p.workspace_project_id = workspace_projects.id AND p.is_active = 1
  );

-- 3) 能力授权的资源范围同样归一到项目根（旧数据可能按计划 ID 授权）。
--    只在能解析出项目根时改写；UNIQUE 冲突用 OR IGNORE，已有根授权优先保留。
UPDATE OR IGNORE mcp_agent_capabilities
SET resource_id = (
  SELECT trim(p.workspace_project_id) FROM planning_projects p
  WHERE p.id = mcp_agent_capabilities.resource_id
)
WHERE capability IN ('projects.read','projects.write','plans.read',
                     'decisions.read','decisions.write','handoffs.read','handoffs.write')
  AND resource_id <> ''
  AND EXISTS (
    SELECT 1 FROM planning_projects p
    WHERE p.id = mcp_agent_capabilities.resource_id
      AND p.workspace_project_id IS NOT NULL
      AND trim(p.workspace_project_id) <> ''
  );

-- 4) 重建授权表：外键指向项目根，删除项目即级联清理授权。
CREATE TABLE mcp_agent_grants_v91 (
  id TEXT PRIMARY KEY NOT NULL,
  agent_row_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (agent_row_id, project_id)
);
INSERT OR IGNORE INTO mcp_agent_grants_v91 (id, agent_row_id, project_id, created_at)
SELECT g.id,
       g.agent_row_id,
       COALESCE(NULLIF(trim(p.workspace_project_id), ''), g.project_id),
       g.created_at
FROM mcp_agent_grants g
LEFT JOIN planning_projects p ON p.id = g.project_id
WHERE COALESCE(NULLIF(trim(p.workspace_project_id), ''), g.project_id)
      IN (SELECT id FROM workspace_projects);
DROP TABLE mcp_agent_grants;
ALTER TABLE mcp_agent_grants_v91 RENAME TO mcp_agent_grants;
CREATE INDEX idx_mcp_agent_grants_project ON mcp_agent_grants(project_id);
"#,
);

#[cfg(test)]
mod tests {
    use crate::db::Db;
    use crate::error::AppError;

    #[test]
    fn migration_86_creates_operation_lifecycle_table() {
        let db = Db::open_in_memory().unwrap();
        db.with_read(|conn| {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_operations'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            for status in ["running", "committed", "failed", "conflict", "interrupted"] {
                assert!(sql.contains(status), "状态 CHECK 缺少 {status}");
            }
            for phase in ["started", "writing", "finalizing", "done"] {
                assert!(sql.contains(phase), "阶段 CHECK 缺少 {phase}");
            }
            // 索引必须覆盖：状态+时间、资源、项目、Agent、游标。
            for index in [
                "idx_agent_ops_status",
                "idx_agent_ops_resource",
                "idx_agent_ops_project",
                "idx_agent_ops_agent",
                "idx_agent_ops_cursor",
            ] {
                let n: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                        [index],
                        |r| r.get(0),
                    )
                    .map_err(AppError::from)?;
                assert_eq!(n, 1, "缺少索引 {index}");
            }
            // 非法状态必须被数据库拒绝（不依赖应用层校验）。
            let rejected = conn.execute(
                "INSERT INTO agent_operations
                   (id, agent_id, actor_kind, interface, action, status, phase, started_at, updated_at)
                 VALUES ('bad', 'a', 'agent', 'mcp', 'task.update', 'success', 'started', 'now', 'now')",
                [],
            );
            assert!(rejected.is_err(), "CHECK 必须拒绝未知状态");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn migration_88_adds_state_revision_and_lease_index() {
        let db = Db::open_in_memory().unwrap();
        db.with_read(|conn| {
            let has_column: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('agent_operations')
                      WHERE name='state_revision'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            assert_eq!(has_column, 1, "v88 必须为 agent_operations 增加 state_revision");
            // 旧行（未显式赋值）必须得到 0，避免 NULL 参与前端比较。
            conn.execute(
                "INSERT INTO agent_operations
                   (id, agent_id, actor_kind, interface, action, status, phase, started_at, updated_at)
                 VALUES ('legacy', 'a', 'agent', 'mcp', 'task.update', 'running', 'started', 'now', 'now')",
                [],
            )
            .map_err(AppError::from)?;
            let revision: i64 = conn
                .query_row(
                    "SELECT state_revision FROM agent_operations WHERE id='legacy'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            assert_eq!(revision, 0);
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                      WHERE type='index' AND name='idx_agent_ops_lease'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)?;
            assert_eq!(n, 1, "缺少租约扫描索引");
            Ok(())
        })
        .unwrap();
    }

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
