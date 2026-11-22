# 数据模型（迁移 v76，追加式）

原则：**不新建第二套 Task / Project / Knowledge / Plan**。已有实体只加关联或计数器；新增表只承载
此前不存在的语义（决策、交接、同步、活动、上下文访问）。

## 1. 对既有表的改动

| 表 | 改动 | 兼容性 |
|---|---|---|
| `mcp_agents` | 追加 `vendor` / `interface_hint` / `note`（均 `NOT NULL DEFAULT ''`） | 旧库旧备份缺列时由迁移补默认值；读写均按默认值兜底 |
| `mcp_agent_capabilities` | 重建以扩展 `CHECK` 能力白名单（SQLite 不支持改 CHECK） | 原主键/外键/唯一键/索引全部保留，旧授权逐行复制 |
| `application_settings` | 新增键：`agent_workspace_path`、`agent_workspace_watch_enabled`、`agent_api_enabled`、`agent_api_port` | 缺键按默认值读取，不写库自愈 |

**能力白名单（v76 起）**：
`projects.read`、`tasks.read`、`tasks.write`、`plans.read`、`knowledge.read`、`knowledge.write`、
`decisions.read`、`decisions.write`、`context.read`、`handoffs.read`、`handoffs.write`、`skills.read`、
`notes.read`、`notes.write`、`workflows.read`、`workspace.read`。

## 2. 新增表

### 2.1 `agent_workspaces`（共享目录注册）

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | TEXT | PK（行 UUID） |
| `workspace_id` | TEXT | UNIQUE，稳定工作空间标识（写入 manifest） |
| `name` | TEXT | 显示名 |
| `root_path` | TEXT | 绝对路径，`COLLATE NOCASE` 唯一索引 |
| `protocol_version` | TEXT | `1.0` |
| `schema_version` | TEXT | `1.0` |
| `enabled` | INTEGER | 0/1 |
| `watch_enabled` | INTEGER | 0/1，轮询监听开关 |
| `last_export_at` / `last_scan_at` / `last_import_at` | TEXT | ISO-8601 |
| `created_at` / `updated_at` | TEXT | ISO-8601 |

删除策略：删除注册行时级联清理本表相关的索引/事件/冲突；**不删除磁盘文件**。

### 2.2 `agent_workspace_files`（同步索引）

`id` PK；`workspace_row_id` FK→`agent_workspaces`（CASCADE）；`rel_path`（NOCASE）；`resource_kind`；
`resource_id`；`exported_revision`；`exported_hash`；`last_seen_hash`；`size_bytes`；
`state ∈ {in_sync, stale, modified_external, conflict, deleted, untracked}`；`exported_at` / `last_seen_at`。
唯一键 `(workspace_row_id, rel_path)`；索引 `(workspace_row_id, state)`。

用途：区分「TaskDock 自己写的（hash 一致）」与「外部改过的（hash 不一致）」，是防同步环的唯一依据。

### 2.3 `agent_resource_revisions`（统一版本计数器）

`id` PK；`resource_kind`（task/project/plan/feature/knowledge/decision/handoff/report）；
`resource_id`；`revision`（0 起，每次经服务层写入 +1）；`updated_at`；`updated_by`（agent_id 或 `local`）；
`actor_kind ∈ {human, agent, system}`；`source ∈ {ui, cli, mcp, rest, file, system}`；`content_hash`。
唯一键 `(resource_kind, resource_id)`。

说明：业务表自身的 `updated_at` 也参与冲突校验（`base_revision` + `base_updated_at` 双条件），
因此 UI 直接改数据（不经服务层）也会被外部写入检测到。

任务 JSON 在 CLI/MCP/REST/文件入口输出 `revision` 字段（`Task` 的可选序列化字段），值由
`read_revision` + `effective_revision` 实时计算；桌面端既有查询不填该字段，保持原响应契约。

### 2.4 `agent_decisions`（架构/产品决策记录）

`id` PK；`project_id`（弱引用，无外键，避免跨模块级联）+ `project_kind`（v76 为
`{none, planning, workspace}`，**v92 起扩为 `{none, project, planning, workspace}`，
新数据统一写 `none`/`project`——归属只认项目根；旧值保留可读，不再产生**）；
`title`；`status ∈ {proposed, accepted, superseded, rejected}`；`context` / `decision` / `consequences` /
`alternatives`；`tags` JSON；`revision`；`superseded_by`；`created_by`；`actor_kind`；`source`；
`created_at` / `updated_at`。索引 `(project_id, created_at DESC)`、`(status, updated_at DESC)`。

### 2.5 `agent_handoffs`（跨 Agent 交接）

`id` PK；`project_id`（**v92 起一律存项目根**；历史行可能仍是计划 ID，查询用计划反查兼容）+
`project_kind`（同 §2.4 的 v92 收敛）；`task_id`；`from_agent_row_id` / `to_agent_row_id`
（FK→`mcp_agents`，`ON DELETE SET NULL`）+ `from_agent_id` / `to_agent_id`（文本快照，身份撤销后仍可追溯）；
`status ∈ {pending, accepted, rejected, completed, cancelled}`；`summary`；
`completed_items` / `pending_items` / `decisions` / `files_changed` / `risks` / `next_steps`（JSON 数组）；
`revision`；`accepted_at` / `completed_at` / `rejected_at` / `rejection_reason`；`created_at` / `updated_at`。
索引 `(status, created_at DESC)`、`(project_id, created_at DESC)`、`(to_agent_row_id, status)`。

### 2.6 `agent_work_reports`（工作报告）

`id` PK；`handoff_id`（FK，`SET NULL`）；`project_id`；`task_id`；`agent_row_id` / `agent_id`；
`summary`；`result ∈ {completed, partial, blocked, failed}`；`completed_items` / `pending_items` /
`files_changed` / `evidence` / `risks`（JSON 数组）；`source`；`created_at`。

### 2.7 `agent_activity_logs`（四入口统一活动）

`id` PK；`agent_row_id`（FK，`SET NULL`）+ `agent_id`；`actor_kind ∈ {agent, local, system}`；
`interface ∈ {cli, mcp, rest, file, ui, system}`；`session_key`；`action`；`resource_kind` / `resource_id`；
`project_id`；`request_id`；`success`；`error_code`；`detail`（脱敏摘要，不含正文/Token）；`revision`；
`duration_ms`；`created_at`。索引按时间、Agent、会话。

### 2.8 `agent_sync_events`（同步事件）

`id` PK；`workspace_row_id`（FK，CASCADE）；`direction ∈ {export, import, scan, resolve}`；
`event_kind`（export/import/skip/conflict/resolve/delete/rename/error）；`rel_path`；`resource_kind` /
`resource_id`；`revision`；`status ∈ {ok, skipped, failed, conflict}`；`message`；`content_hash`；
`request_id`；`created_at`。索引 `(created_at DESC)`、`(workspace_row_id, status, created_at DESC)`。

### 2.9 `agent_sync_conflicts`

`id` PK；`workspace_row_id`（FK，CASCADE）；`rel_path`；`resource_kind` / `resource_id`；
`db_revision` / `file_revision`；`db_hash` / `file_hash`；`status ∈ {open, resolved_db, resolved_file, merged, dismissed}`；
`resolution`；`detail_json`；`detected_at` / `resolved_at`。唯一键 `(workspace_row_id, rel_path)`。

### 2.10 `agent_context_access_logs`

`id` PK；`agent_row_id`（FK，SET NULL）+ `agent_id`；`interface`；`purpose`；`project_id`；`task_id`；
`format`；`budget_tokens`；`item_count`；`estimated_tokens`；`request_id`；`created_at`。
只记录规模与来源，不记录上下文正文。

### 2.11 `agent_request_cache`（REST 幂等）

`id` PK；`agent_row_id`（FK，CASCADE）；`interface`；`idempotency_key`；`request_hash`；
`response_json`；`status_code`；`created_at` / `expires_at`。唯一键 `(agent_row_id, interface, idempotency_key)`；
索引 `(expires_at)`（用于 24h 过期清理，删除策略=按时间删除，不影响业务数据）。

## 3. 索引与体积

- 所有列表查询都有 `(维度, created_at DESC)` 复合索引；活动日志与同步事件按时间裁剪（默认保留 90 天，
  由 `agent_access::store::prune` 在启动时执行一次，单次最多删除 5000 行，可取消）。
- 交接/报告的 JSON 数组字段不做正则/全文索引（内容短，按需读取）。

## 4. 迁移与回退

- 单事务执行（`apply_migrations` 既有机制）；任何一步失败整体回滚。
- 迁移只追加，不改已发布 DDL；`mcp_agent_capabilities` 重建保留全部旧行。
- 备份/恢复：新表登记进 `BACKUP_TABLES`（见实现），旧备份恢复后缺表由迁移补齐。
- 回退：删除新表不影响既有业务；`mcp_agents` 三个新列留空即可（旧程序 SELECT 不引用）。

## v90 / v91：统一项目身份（2026-11-21）

- **v90**：重建 `mcp_agent_capabilities` 的 CHECK，加入 `projects.create` / `projects.write`，
  逐行复制旧授权，不新增默认授权。
- **v91**：`mcp_agent_grants.project_id` 的外键从 `planning_projects(id)` 改到
  `workspace_projects(id)`。迁移步骤：
  1. 为「有授权但缺项目根」的历史计划按同 ID 补建项目根；
  2. 给这些计划回填 `workspace_project_id` 与 `is_active`，并补 `active_plan_id`；
  3. 重建授权表并按 `COALESCE(plan.workspace_project_id, grant.project_id)` 映射，`INSERT OR IGNORE` 去重；
  4. 删除旧表、改名、重建索引。
- 影响：授权只能挂项目根；删除项目级联清理授权；旧计划 ID 入参在判定前解析，不需要重新授权。

## v92：幂等请求归属与 project_kind 收敛（2026-11-22）

- **新表 `project_create_requests`**（幂等请求归属，统一创建服务专用）：
  | 字段 | 说明 |
  |---|---|
  | `id` | PK（行 UUID） |
  | `principal_kind` | `local_human` / `registered_agent`（CHECK 约束） |
  | `principal_id` | LocalHuman 固定 `local`；RegisteredAgent = `mcp_agents.id` |
  | `client_request_id` | 客户端请求 ID |
  | `request_digest` | 清洗后业务参数摘要（`requestDigestV2` 同值） |
  | `project_id` | FK→`workspace_projects(id)` ON DELETE CASCADE（删除项目级联清理归属行） |
  | `plan_id` | 初始计划 ID |
  | `created_at` | ISO-8601 |
  约束：`UNIQUE (principal_kind, principal_id, client_request_id)`——同一主体的同一请求 ID
  在数据库层面只可能对应一个项目；索引 `(project_id)`、`(client_request_id)`。
  **历史 `project_events` 不回填归属**（payload 无此信息）；旧事件兜底判定只对本机人类
  （`actor='user'`）生效，Agent 请求一律走新表。
- **重建 `agent_decisions` / `agent_handoffs`**：`project_kind` CHECK 从
  `{none, planning, workspace}` 扩为 `{none, project, planning, workspace}`；逐列复制全部行，
  不丢历史。新数据统一写 `project_id=项目根` + `project_kind='none'|'project'`；
  入参声明的旧枚举值不参与判定（归属由 `resolve_project_root` 推导）。
- **迁移与回退**：v92 登记在 `db/mod.rs::MIGRATIONS` 末尾，单事务原子执行；
  `project_create_requests` / `agent_import_claims` / `agent_import_policies` /
  `agent_import_requests` 已登记备份注册表（`BACKUP_TABLES` + `EXTENDED_TABLES`），
  恢复顺序：workspace_projects(435) → project_create_requests(436) →
  agent_workspaces(740) → 导入三表(762/764/766)。
- **修复存量测试假设**：`db::tests` 的「迁移步数 == `MIGRATIONS.len()`」断言在 v87 被跳过
  （v86.1 占用 v88）后即失效，改为「最后一条迁移的真实版本号」；历史前缀夹具按条目版本号
  而非下标推进。

## v93：项目根 revision 列（2026-11-22，双聚合契约）

- `ALTER TABLE workspace_projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`
  （`project_hub/schema.rs::MIGRATION_93`，登记 `db/mod.rs::MIGRATIONS` 末尾；纯加列，
  不改已发布迁移）；
- 语义：项目根乐观并发版本，与计划 `planning_projects.revision`（v37）互相独立；
  旧行为（不传 expectedRevision）完全不变；
- 写入点：`update_project_fields_tx` 同事务「读→比对→+1」（镜像同步写不动计划 revision）；
  计划更新携带 name/description/targetDate 时经同一内核写根，根 revision 相应递增；
- 读取点：`project_hub::service::ProjectSummary.revision`、
  `agent_access::service::project_summary`（REST/CLI 读模型，弃用计数器派生）；
- 备份登记：无新表（仅加列），`BACKUP_TABLES` 不变。
