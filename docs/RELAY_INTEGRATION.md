# Relay Agent × TaskDock 集成设计（预研稿 R0–R3）

> 状态：**预研设计，本轮不实施任何 Relay 核心代码迁移、数据库改造或联调**。
> 本文所有 Relay 侧能力结论上限为「代码存在 / 契约存在 / 未联调」；本轮没有运行中的 Relay
> 实例、PostgreSQL 或服务凭据可用（见 `tmp/acceptance/relay-integration/report.md` 的
> 「未验证 / ENVIRONMENT BLOCKED」部分）。
>
> 事实依据：代码与可复现输出优先于设计文档。Relay 的 `contracts/`、`docs/` 为 Proposed
> 契约与设计说明，字段、状态机与端点以 `apps/api/src/` 下实际代码为准；引用设计契约时单独标注。
> 候选副本 `D:\Develop\relay-baseline`、`D:\Develop\relay-head` **不作为权威依据**。

## 0. 范围与术语

- **TaskDock**：Windows 桌面任务/启动器/Agent 监控中枢。Tauri 2 + Rust（`src-tauri/`）+
  React 19 + TypeScript + Vite + Zustand（`src/`）+ SQLite；迁移在
  `src-tauri/src/db/mod.rs` 的 `MIGRATIONS` 末尾 append-only 追加。
- **Relay-Agent**：`D:\Develop\Relay-Agent`。Node.js 24 + TypeScript strict + pnpm workspace；
  `apps/api` 为 Fastify 5 服务（Kysely + pg，PostgreSQL 18），`apps/api/src/worker` 为独立
  Worker/Supervisor 进程，`apps/desktop` 为 Tauri 2 Rust 宿主（sidecar 方式拉起 API 与 Worker）。
- **执行层 Run Recovery**：Relay 对 Run/Step/Attempt/动作的崩溃恢复、租约（lease）、围栏
  （fencing）与命令重放，权威在 Relay 服务端与 PostgreSQL。
- **UI 层工作现场恢复**：TaskDock `workspace_snapshots`/`workspace_snapshot_items` 保存应用、
  URL、文件、目录、Agent 会话等引用快照，用于重新打开工作现场。两者**不是同一概念**，映射表
  中单列区分，禁止混为一谈。

## 1. D1 双方技术栈与目录核对（已验证事实）

### 1.1 Relay-Agent 顶层与包结构

| 项 | 事实 | 证据 |
|---|---|---|
| 顶层目录 | `contracts/`、`apps/`、`docs/`、`package.json`、`pnpm-workspace.yaml`、`AGENTS.md` 等真实存在 | `D:\Develop\Relay-Agent` 顶层目录列举 |
| pnpm workspace | 仅声明 `packages: apps/api` | `pnpm-workspace.yaml:1-2` |
| Node/包管理 | `engines: node >=24 <25`，`packageManager: pnpm@9.15.9` | `package.json:2-8` |
| `apps/` 子目录 | `api`、`browser-extension`、`computer-runtime`、`credential-helper`、`desktop`、`file-io-helper`、`tmp`、`workbench`（无独立 `worker/` 顶层包；Worker 在 `apps/api/src/worker/`） | `apps/` 目录列举 |
| API 运行时 | Fastify 5.12.5、@sinclair/typebox 0.34.52、Kysely 0.29.6、pg 8.16.3、ws 8.18.3、LangGraph 1.4.17 / checkpoint 1.1.5 / core 1.2.12、postgres 1.0.5 | `apps/api/package.json:28-40` |
| API 脚本 | `start: node dist/src/main.js`；`worker: node dist/src/worker/main.js`；`worker:supervisor: node dist/src/worker/supervisor-main.js`；`migrate: node cli/migrate.js` | `apps/api/package.json:17-26` |
| 数据库 | PostgreSQL + Kysely + pg；迁移目录 `apps/api/migrations/`，编号 `0001`–`0166`，共 167 个 `.sql` 文件（`0135` 编号下有两个文件） | `apps/api/migrations/` 目录列举；依赖见 `apps/api/package.json:34-39` |
| API 入口 | `src/main.ts`：创建/校验 `RelayDatabase`、`SchemaReadinessChecker`、注册 health、注册带边界的路由、启动 browser bridge | `apps/api/src/main.ts:55-57,62-67,70-72` |
| `src/api/` | Fastify 路由与 TypeBox schema（`routes.ts`、`server.ts`、`boundary.ts`、`health-api.ts`、`project-api.ts`、`task-api.ts`、`run-api.ts`、`review-api.ts`、`artifact-api.ts`、`run-events-api.ts`、`domain-schemas.ts`、`problem.ts` 等） | `apps/api/src/api/` 目录列举 |
| `src/application/` | 应用用例、守卫与领域错误（`guards.ts`、`command.ts`、`domain-error.ts` 等） | `apps/api/src/application/` 目录列举 |
| `src/worker/` | Worker 与 Supervisor 进程入口 `main.ts`、`supervisor-main.ts` | `apps/api/src/worker/main.ts:62-63,72-76,84-91` |
| 其他领域目录 | `src/project/`、`src/task/`、`src/run/`、`src/artifact/`、`src/verification/`、`src/review/`、`src/receipt/`、`src/workspace/`、`src/work-segment/`、`src/assist/`、`src/gateway/`、`src/model/` | `apps/api/src/` 目录列举 |
| 架构文档 | `docs/architecture/` 存在，含 `技术选型.md`、`domain-model.md`、`runtime-context.md`、`tool-adapters.md`、`V1_ARCHITECTURE.md`、`domain-model/`、`runtime-context/` 等 | `docs/architecture/` 目录列举 |
| 桌面宿主 | `apps/desktop` 为 Tauri 2 Rust 壳（`src-tauri/src/lib.rs`、`job_sidecar.rs`），以 sidecar 拉起 API 与 Supervisor；启动帧走 stdin/stdout JSON 握手 | `apps/desktop/src-tauri/src/lib.rs:106-108,626-664`；`job_sidecar.rs:335-343` |
| 候选副本 | `D:\Develop\relay-baseline`（含 apps/contracts/docs 等，旧副本）、`D:\Develop\relay-head`（含 apps/node_modules）仅作对照，**不作权威依据** | 目录列举 |

### 1.2 TaskDock 技术栈（背景事实，供对齐）

| 项 | 事实 | 证据 |
|---|---|---|
| 桌面框架 | Tauri 2（`tauri = { version = "2", ... }`） | `src-tauri/Cargo.toml:20` |
| 前端 | React 19.1、TypeScript 5.9、Vite 7、Zustand 5、@tauri-apps/api 2.9 | `package.json` 依赖段 |
| 本地存储 | SQLite（rusqlite 0.32 bundled + serde_json），迁移在 `MIGRATIONS` 末尾追加 | `src-tauri/src/db/mod.rs:20`；`Cargo.toml:38` |
| 异步运行时 | tokio 1（rt-multi-thread）；hyper 1 + hyper-util 仅 **server** feature，当前**无 reqwest 等出站 HTTP 客户端依赖** | `Cargo.toml:40,44-45` |
| 既有接入方向 | 现有 Agent 接入为**入站**：外部 Agent 经本地 HTTP `/api/v1/events` 推送事件，或经 MCP loopback bridge 调用工具；TaskDock 自身不驱动外部 Agent 执行 | `docs/AGENT_ADAPTERS.md:54-69`；`src-tauri/src/mcp/bridge.rs:1-10` |
| 工作台宿主 | 完整功能只在 `workspace` 窗口（`workspace.html` / `src/workspace/main.tsx`）；主窗口胶囊快捷面仅做跳转 | 背景事实（主智能体已确认），代码见 `src/workbench/WorkbenchShell.tsx`、`src/components/workbench/WorkbenchHandoff.tsx:1-5` |

## 2. D2 字段级实体映射表

> 表头：**语义 | TaskDock 现有实体与代码位置（真实列名/类型/主键） | Relay 实体与代码位置（真实列名/类型/主键） | 事实所有权归属 | 处理建议**。
>
> 所有权口径：每条只允许一个唯一写入方；跨端字段级切分时逐字段写明。TaskDock 侧投影缓存表
> （本节所述 `relay_*` 投影表）属**未来迁移**，本轮未设计建表，仅为目标态说明。

### 2.1 项目（Project）

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 项目身份 | `workspace_projects.id TEXT PRIMARY KEY`；`name TEXT`；`kind TEXT CHECK(development\|game\|ai_comic\|general\|novel)`；`status TEXT CHECK(active\|archived)`；`root_path TEXT`；`dev_project_id TEXT`；`note TEXT`；`created_at/updated_at TEXT`（`src-tauri/src/db/mod.rs` 迁移 v49/v57） | `projects.id TEXT`（UUID）PK；`workspace_id TEXT` NOT NULL；`title TEXT`；`project_type TEXT CHECK(GENERAL\|THESIS\|DEVELOPMENT)`；`archived_at`；`revision NUMERIC`；`created_at/updated_at`（`apps/api/src/infrastructure/database-schema.ts:119-128`）；项目状态 `ProjectStateRow`：`project_id/phase_key/next_action_task_id/revision/created_at/updated_at`（同文件 `:709-716`） | **TaskDock** 写自己的 `workspace_projects`；**Relay** 写自己的 `projects`/`project_states`。两端项目记录互不可写 | R0 只做只读并列展示；如需关联，由用户显式建立 `workspace_projects.id ↔ (workspace_id, project_id)` 弱引用（无外键），禁止按标题相似自动配对 |
| 项目归档/阶段 | TaskDock 无阶段概念；仅 `status=archived` | Relay `projects.archived_at`；`project_states.phase_key`（`schema.ts:711`）；归档冲突码 `PROJECT_ARCHIVED` / `PROJECT_ARCHIVE_BLOCKED`（`application/domain-error.ts:100,115`） | Relay | TaskDock 展示 Relay 归档/阶段为只读标签，不回写 |

> v57（2026-11-15）：`workspace_projects.kind` 的合法取值在原有四类基础上增加 `novel`
> （小说项目，创作工作台 A 阶段）。Relay 侧 `project_type` 未增加对应值，两端仍只做只读并列，
> 关联必须由用户显式建立，禁止按标题/类型自动配对。

### 2.2 任务（Task）

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 任务身份 | `tasks.id TEXT PRIMARY KEY`；`title TEXT`；`description TEXT`；`priority INTEGER CHECK(0..3)`；`status TEXT CHECK(pending\|completed)`；`category TEXT`；`tags TEXT(JSON)`；`due_at/remind_at TEXT`；`recurrence_rule_id`；`created_at/updated_at/completed_at`（`db/mod.rs:24-39`）；模型 `Task`（`db/models.rs:17-26`） | `tasks.id TEXT`（UUID）PK；`workspace_id TEXT`；`project_id TEXT NULL`；`title TEXT`；`status TaskStatus`（`INBOX\|READY\|IN_PROGRESS\|WAITING\|BLOCKED\|DONE\|CANCELLED`，`schema.ts:14`）；`mode TaskMode`（`ME\|AI_ASSIST\|DELEGATE_AI`，`:17`）；`acceptance_revision NUMERIC`；`executor_kind TaskExecutorKind`（`HUMAN\|AI`，`:20`）；`ownership_epoch NUMERIC`；`executor_run_id TEXT NULL`；`current_completion_id TEXT NULL`；`goal_alignment_mode`；`priority`；`due_local_date`；`revision NUMERIC`；时间戳（`schema.ts:200-222`） | **TaskDock** 写 `tasks`（用户自己的待办清单）；**Relay** 写 `tasks`（带验收契约与执行权的执行单元）。同名不同义，禁止合并为一张表 | R0 并列只读；R1 由用户把一条 TaskDock 任务显式链接到 Relay Task（或在 Relay 内新建 Task 后回填链接）；TaskDock 的 `pending/completed` 不映射为 Relay `DONE`；Relay 状态只作只读投影 |
| 验收条件 | TaskDock 无验收契约字段；验收结论在 `dev_acceptance_records`（见 2.5） | Relay `tasks.acceptance_revision`；验收条件在创建任务时由 `criteria[]`（`criterion_id/statement/required/method/target_spec`，`domain-schemas.ts:262-275`）冻结；`expected_outputs`（`:261`） | Relay | TaskDock 不复制验收条件文本到自己的任务描述；查看时跳转/只读读取 Relay 任务详情 |
| 执行权 | TaskDock 无执行权概念 | Relay `tasks.executor_kind`、`ownership_epoch`、`executor_run_id`（`schema.ts:211-213`）；执行权变更走 Delegate/Handoff/Run 终止协调（`contracts/01-facts-and-ownership.md:18`，Proposed 契约） | Relay | TaskDock 不展示为可编辑字段；链接展示当前占有者来源 |

### 2.3 Agent 会话（Session）

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 会话身份 | `agent_sessions.id TEXT PK`；`source_id TEXT REFERENCES agent_sources(id)`；`external_id TEXT`（外部会话 ID）；`title TEXT`；`status TEXT`；`first_seen_at/last_seen_at TEXT`；`last_run_id TEXT`；唯一索引 `(source_id, external_id)`；后补 `instance_id`、`origin`（`db/mod.rs:86-96,185,565`）；模型 `AgentSession`（`models.rs:38-47`） | `assist_sessions.id TEXT`（UUID）PK；`workspace_id TEXT`；`project_id TEXT NULL`；`task_id TEXT NULL`；`title TEXT`；`status AssistSessionStatus`（`ACTIVE\|ARCHIVED`，`schema.ts:1113`）；`conversation_mode ConversationMode`（`AGENT\|ASSISTANT\|LEARNING`，`:1379`）；`chat_mode ChatMode`（`CHAT\|PLAN\|GOAL`，`:1388`）；`assistant_profile_id`；`remember`；`working_resource_id`；`pinned_at/unread_at/last_message_at` 等（`schema.ts:1530-1584`） | **Relay** 写 `assist_sessions`；**TaskDock** 只写自己的观测投影 `agent_sessions`（由适配器同步生成/刷新），不回写 Relay 会话 | R0 适配器把 Relay 会话投影为一个 `source_id='relay'` 的观测会话；`external_id = assist_session.id`；会话标题/模式从 Relay 只读读取。TaskDock 现有会话来自入站事件，Relay 会话来自出站拉取，两条来源在投影层标注 |
| 会话归属 | TaskDock `agent_sources`（`id/display_name/kind/enabled/verified/homepage/note/config/...`，`db/mod.rs:73-84`） | Relay 会话绑定 `workspace_id` 与可选 `project_id/task_id`（`schema.ts:1531-1533`） | Relay | 跨端归属关系存链接表；TaskDock 不替 Relay 决定会话归属 |

### 2.4 Agent 执行轮次（Run）

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 轮次身份 | `agent_runs.id TEXT PK`；`session_id TEXT REFERENCES agent_sessions(id)`；`source_id TEXT`；`external_run_id TEXT`；`task_title TEXT`；`status TEXT`（`idle/running/waiting/completed/failed/disconnected` 观测词表，见 `docs/AGENT_ADAPTERS.md:14-15,21-26`）；`started_at/updated_at/ended_at TEXT`；`pending_items TEXT(JSON)`；`meta TEXT(JSON)`；后补 `instance_id/parent_run_id/last_ingest_seq/last_event_at/origin`；唯一索引 `(source_id, external_run_id)` 允许空（`db/mod.rs:99-111,181-182,541,553,566`）；模型 `AgentRun`（`models.rs:57-68`） | `runs.id TEXT`（UUID）PK；`workspace_id TEXT`；`task_id TEXT`；`status RunStatus`（`CREATED/CONTEXT_BUILDING/PLANNING/RUNNING/WAITING_APPROVAL/VERIFYING/RETRYING/PAUSED/COMPLETED/FAILED/CANCELLED`，`schema.ts:47-58`）；`revision NUMERIC`；`ownership_epoch NUMERIC`；`retry_of_run_id TEXT NULL`；`resume_phase`；`wait_reason`；`current_step_id`；`worker_epoch/worker_id/worker_lease_until`；`created_at/updated_at/terminal_at`（`schema.ts:224-242`）；步骤 `run_steps`（`:324-335`）；尝试 `step_attempts`（`:337-351`）；控制请求 `run_control_requests`（`:353-365`） | **Relay** 写 `runs/run_steps/step_attempts/run_control_requests`；**TaskDock** 只写观测投影 `agent_runs/agent_events`，投影可被适配器重建，不具备独立可编辑真相地位 | R0 按状态映射投影（见 3.6）；`external_run_id = run.id`，`meta` 存 `revision/ownership_epoch/wait_reason/terminal_at` 等只读镜像。TaskDock 不得把 Relay Run 状态本地改写为已完成 |
| 重试/接续 | TaskDock `agent_runs.parent_run_id`（弱引用，`db/mod.rs:182`） | Relay `runs.retry_of_run_id`；恢复命令 `RunCommandKind` 含 `START/RESUME/RECOVER`（`schema.ts:254-263`）；围栏表 `run_worker_fences`；恢复回执 `outcome=REQUEUED/BLOCKED/SKIPPED`、`fenced`、`unresolved_operation_ids`、`blocked_reason`（`domain-schemas.ts:641-653`） | Relay | 映射时 `parent_run_id ↔ retry_of_run_id` 仅作展示引用；恢复动作（RECOVER/RESUME）属于 R2，且权威在 Relay |
| 事件流 | `agent_events`：`id/source_id/session_external_id/run_external_id/event_type/state/message/received_at`，后补 `schema_version/event_id/instance_id/parent_run_id/occurred_at/transport/evidence_type/confidence/dedupe_key`（`db/mod.rs:115-125` 及后续 ALTER） | Relay Run 事件：`GET /runs/:run_id/events` SSE，游标 `after`（int64 seq）或 `Last-Event-ID`；事件类型 `RUN_CHANGED/STEP_CHANGED/ATTEMPT_CHANGED/REVIEW_CHANGED/CONTROL_CHANGED/EFFECT_CHANGED`；轮询 1s、心跳 15s（`run-events-api.ts:13-15,19-33,35-55`） | Relay 是事件权威；TaskDock `agent_events` 是派生投影 | 断线后以持久化 seq 续传；TaskDock 事件表不反推 Relay 状态 |

### 2.5 人工审批与验收

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 审批请求 | TaskDock **无审批工作流**；外部 Agent 等待仅观测为 `status=waiting`（`AGENT_ADAPTERS.md:23`）；无对应表 | `review_requests`：`id/workspace_id/project_id/task_id/run_id/verification_session_id/criterion_id/operation_id/import_job_id/kind CRITERION/RETRY_BUDGET/CHECKER_RETRY/ACTION_APPROVAL/STATE_PROPOSAL/reason/status OPEN/DECIDED/EXPIRED/revision/target_hash/target/evidence/effect/allowed_decisions/expires_at/created_at/decided_at`（`schema.ts:816-839`）；决定 `review_decisions`（`:841-851`）；状态/决定枚举 `:813-814` | **Relay** 唯一写入审批请求与决定 | R0 只读列出待处理 Review（`GET /reviews`、`GET /runs/:run_id/reviews`）；决定入口在 R2，且必须经用户显式确认 |
| 验收结论 | `dev_acceptance_records`：`id/subject_kind task\|planning_feature/subject_id/verdict pass\|fail\|blocked\|not_verified/evidence JSON/created_at`，后补 `agent_source_id/agent_session_external_id/agent_run_external_id`（`db/mod.rs:1585-1595,1677-1679`）；记录只追加，结论由人工选择（`:1673-1674`） | `verification_sessions`：`id/task_id/acceptance_revision/run_id/execution_contract_id/verifier_policy_version/check_plan_hash/check_plan/status OPEN/PASS/RETRY/HUMAN/verdict/...`（`schema.ts:792-810`）；`completion_records`：`id/task_id/acceptance_revision/basis_kind HUMAN/AUTO/human_acceptance_id/verification_session_id/run_id/state_delta/committed_at`（`:777-789`）；`human_acceptance_records`（`:764-775`） | **Relay** 写验证会话、完成记录与人工接受；**TaskDock** 写自己的人工验收记录。两边验收记录不互相替代 | TaskDock 验收记录可在链接字段标注「针对哪个 Relay Run/完成记录」，但不把 Relay `COMPLETED` 自动写成 TaskDock `verdict=pass`；业务完成必须经 TaskDock 用户人工选择（现有规则 `AGENT_ADAPTERS.md:24`） |
| 完成判定 | TaskDock `tasks.status` 仅 `pending/completed`，切换由用户/既有规则；轮次 `completed` 不等于任务完成 | Relay 完成三判断：执行成功 ≠ 验证通过 ≠ 业务完成；`CompletionRecord.basis_kind` 区分 `HUMAN/AUTO`（`contracts/03-verification-and-approval.md:5-11`，Proposed 契约；表结构 `schema.ts:777-789`） | Relay 判定业务完成；TaskDock 判定自己待办完成 | 适配器禁止读取 Relay Run `COMPLETED` 后自动勾选 TaskDock 任务；只能提示「Relay 侧已有完成记录，待人工验收」 |

### 2.6 产物 Artifact

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 产物条目 | `shelf_items`：`id/kind file\|folder\|image\|link\|text/display_name/source_kind/storage_mode reference\|managed\|link/original_path/managed_path/content/byte_size/file_ext/.../note/expire_at/created_at/updated_at`（`db/mod.rs:842-862`）；关联 `shelf_task_links`（`:870-871`）、`shelf_project_links`（`:1696-1703`） | `artifacts`：`id/workspace_id/project_id NULL/task_id/artifact_kind MARKDOWN_DOCUMENT/title/revision/created_at/updated_at`（`schema.ts:739-749`）；`artifact_versions`：`id/artifact_id/version_number/storage_ref/content_hash/size/media_type/source_kind HUMAN\|AI/source_ref/created_at`（`:751-762`）；正文按确切版本读取 `GET /artifact-versions/:artifact_version_id/content`（`artifact-api.ts:406-407`） | **Relay** 写产物与不可变版本；**TaskDock** 写自己的暂存条目与链接 | R0 只读列出 Relay 产物及其版本号/摘要；R3 可把 Relay 产物版本引用钉到 TaskDock 暂存条目中（引用模式 `storage_mode=reference`），不复制正文批量入库；已发布版本不原地覆盖（`contracts/01:20`） |

### 2.7 执行恢复（Run Recovery）与 UI 工作现场恢复（单列，禁止混淆）

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 执行层 Run Recovery | TaskDock **无执行层恢复**；观测超时仅置 `disconnected`（`stale_run_minutes` 默认 15，`db/mod.rs:2083`；`AGENT_ADAPTERS.md:26`） | Relay `runs.worker_epoch/worker_id/worker_lease_until`（`schema.ts:236-238`）；`run_worker_fences`；恢复命令 `POST /runs/:run_id/recovery`（`command_id/stopped_worker_id/stop_evidence`，`domain-schemas.ts:641-653`；`run-api.ts:236`）；动作身份 `logical_operation_id`、尝试 `invocation/attempt`，UNKNOWN 不重放（`contracts/04-recovery-and-commit.md:13-21`，Proposed 契约） | **Relay** 唯一拥有执行恢复权威 | TaskDock 不实现租约、围栏、重试或动作重放；R2 仅在 UI 呈现 Relay 恢复状态并经用户确认发起受控命令；崩溃恢复矩阵以 Relay 为准 |
| UI 层工作现场快照 | `workspace_snapshots`：`id/task_id NULL/name/note/source manual\|task/item_count/created_at/updated_at/last_restored_at/restore_count`（`db/mod.rs:475-486`）；`workspace_snapshot_items`：`id/snapshot_id/item_kind application\|url\|file\|directory\|agent_session/display_name/target_id/app_key/exe_path/url/path/agent_source_id/agent_session_id/...`（`:490-513`） | Relay 无等价的「桌面工作现场快照」表；Relay 侧接续点为 `project_continuation_points`（捕获 Project/Task/Artifact 版本引用，`docs/api/http-command-contract/part-03.md:205-214`，设计文档；表结构以代码为准） | **TaskDock** 写自己的现场快照；**Relay** 写自己的接续点 | 两套快照互不复刻；R3 联动时可互相给出「打开对应现场/接续点」的入口链接，不复制对方快照内容 |

### 2.8 其他关联实体（补充行）

| 字段 | TaskDock 侧 | Relay 侧 | 事实所有权 | 处理建议 |
|---|---|---|---|---|
| 计划/特性 | `planning_projects`、`planning_milestones`、`planning_features`（`status planned/in_progress/review/completed/blocked/paused`，`priority P0/P1/P2`）、`planning_feature_steps`、`planning_activity`（`db/mod.rs:685-697` 等）；命令 `planning_list_projects/planning_list_features/planning_list_feature_agent_links`（`commands/planning.rs:662,912,977`） | Relay 无同构计划表；有 `goals` 及任务 Goal 对齐（`tasks.goal_alignment_mode`，`schema.ts:215`；`docs/api/project-goal-maintenance.md`） | 各自所有 | 不做字段级映射；R3 仅允许人工把 planning_feature 链接到 Relay Task/Project |
| 本地资源路径 | `dev_projects.root_path`（`db/mod.rs:1562-1569`）；`shelf_items.original_path/managed_path`（`:848-849`） | Relay 工作目录/资源经 `working_resource_id`、连接与资源表管理；任务委托体 `file_read_action/file_write_action/cli_run_action` 携带 `connection_id/resource_id`（`domain-schemas.ts:474-500`） | 各自所有；路径语义以本机各自存储为准 | 不交换原始路径清单；联动时只在用户显式选择后引用 |
| 人工交接包 | `dev_handoff_packs`：`id/task_id/title/version/content_md/source_summary/secret_scan/created_at`，后补 `agent_source_id/agent_session_external_id`（`db/mod.rs:1572-1581,1675-1676`） | Relay 交接走 Task 执行权迁移（Handoff 控制请求 `run_control_requests.type=HANDOFF`，`schema.ts:353-357`）与 `retry_of_run_id` | 各自所有 | R2 可把 Relay 交接状态投影到交接包视图；交接包内容本身仍归 TaskDock 编辑 |

## 3. D3 集成架构设计

### 3.1 分层与调用链

```
┌────────────────────────── TaskDock 进程（Tauri 2 + Rust + React） ──────────────────────────┐
│ Workbench（workspace 窗口，React/TS）                                                       │
│   └─ Relay 面板/区块（只读视图 → 委托确认 → 接续操作 → 工作台联动，按 R0–R3 逐步开放）        │
│        │  Tauri IPC（invoke，命令名前缀 relay_*，参数 camelCase）                           │
│        ▼                                                                                    │
│ Relay Adapter（Rust，新增模块；出站 HTTP 客户端 + 投影仓储 + 连接生命周期）                  │
│   ├─ 连接配置：base_url / bearer token / workspace_id / 显示名 / 契约标记                    │
│   ├─ 只读同步器：拉取/订阅 Relay 事实 → 校验 schema → 写入 TaskDock 投影（可重建缓存）        │
│   ├─ 写命令网关：仅 R1/R2 开放；command_id 幂等；确认闸门；错误码映射；日志脱敏              │
│   └─ 投影仓储：agent_sources/agent_sessions/agent_runs/agent_events 或未来 relay_projection  │
└──────────────────────────────────────┼───────────────────────────────────────────────────┘
                                         │ loopback HTTP（127.0.0.1 / ::1）
                                         │ Authorization: Bearer <token>
                                         │ 前缀 /api/v1/workspaces/:workspace_id
                                         ▼
┌────────────────────────── Relay-Agent 进程（Fastify 5，独立 Node 进程） ───────────────────┐
│ 边界：Host/Origin 校验 + Bearer 常量时间比较（boundary.ts:32-83）                           │
│ 应用用例（application/）→ 领域仓储（project/task/run/review/artifact/...）→ PostgreSQL       │
│ Worker/Supervisor（独立进程）领取持久化命令，LangGraph 推进；执行状态权威在 Relay            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **方向**：TaskDock 是出站消费方；Relay 是被连接的本地服务。TaskDock 不内嵌 Relay Worker、
  不连 Relay 的 PostgreSQL。
- **接入点对齐现有约定**：业务 IPC 统一经 `src/lib/bridge.ts`（现有命令如 `list_tasks`，
  `bridge.ts:855-884`）；适配器作为新 Rust 模块注册命令，前端经 bridge 调用；投影写入复用
  既有事件管线与 `agent_sources/agent_sessions/agent_runs/agent_events` 口径，新增来源
  `source_id='relay'`（来源归属仍由 TaskDock 服务端判定，沿用现有规则，`docs/AGENT_ADAPTERS.md:28-53`）。

### 3.2 连接与启动发现机制

**已验证事实**：
- Relay API 绑定回环：`RELAY_API_BIND_HOST`、`RELAY_API_PORT`；桌面模式端口可为 0（系统分配临时端口），
  非桌面默认 1024（`config.ts:302-311`，键名见 `.env.example:7-8`）。
- Relay 桌面宿主通过 stdin 启动帧向 API 传 `workspaceId`/`bearerToken`，从 stdout `desktop_ready`
  事件读取 `port/workspace_id/node_version`（`apps/desktop/src-tauri/src/lib.rs:106-108,626-664`；
  `job_sidecar.rs:335-343`）。
- 浏览器桥接 `browser/bridge.ts` 在 `RELAY_DATA_ROOT/browser/bridge.json` 写 `{ port, token,
  protocol: 'relay-browser-bridge-v1' }`（`bridge.ts:31,56`）；该 token 是浏览器桥接凭据，**不是**
  API Bearer（`bridge.ts:8`），且不含 workspace_id，不能用于受保护 API 调用。
- **未找到**公开的「列出全部 workspace」HTTP 端点：路由表中 `workspace_id` 均为路径作用域参数
  （`routes.ts:95`；全 `src/api/` 检索无 `GET /workspaces` 列举路由）。

**设计结论**：
1. TaskDock 连接配置由用户在设置中显式录入：`base_url`（仅接受 `http://127.0.0.1:` 或
   `http://[::1]:`）、`bearer_token`、`workspace_id`（UUID）、显示名。不自动扫描局域网。
2. 发现顺序：先 `GET /health/live`（无需鉴权，`health-api.ts:34-38`）探活；再 `GET /health/ready`
   （Bearer 守卫，`health-api.ts:40-132`）校验凭据、数据库与 schema；成功后用 `GET /projects`
   （`project-api.ts:66`）验证 workspace 作用域可读。
3. 不解析 Relay 桌面进程命令行、不读取其数据库或受管数据目录；如未来 Relay 提供本地连接清单
   文件/端点，再评估只读导入。
4. 适配器只在 TaskDock 设置启用时启动；关闭即释放端口订阅与定时器（遵循 TaskDock 异步生命周期
   规则：可取消、有超时、有上限）。

### 3.3 服务可用性检查与版本兼容

- **健康分级**：`/health/live` 进程存活；`/health/ready` 含数据库/schema/workspace 就绪检查。
  适配器展示三态：已连接（ready）、仅进程存活（live，执行类操作禁用）、不可达。
- **版本兼容**：Relay API 前缀 `/api/v1`（`routes.ts:95`）。代码中**未找到**独立的契约版本/
  能力发现端点；适配器按 v1 前缀 + TypeBox 响应 schema 形状做本地断言：
  - 响应缺字段/类型不符 → 标记「契约不兼容」，降级为只读或断开，并在 UI 明示版本不匹配；
  - 收到 `409 REVISION_CONFLICT` / `422 VALIDATION_FAILED` / 404 等按 3.10 错误码映射处理；
  - 适配器本地固化其所依赖的字段清单（本文 D2 表），Relay 后续 v2 前缀不被静默接入。
- **兼容策略**：读模型优先容忍可选字段缺失；写请求严格按 Relay 当前 schema 构造，缺字段即 422，
  不做宽松猜测。

### 3.4 身份与授权

- **凭据**：Relay Bearer Token 存 TaskDock 本地设置（未来迁移的受保护设置键），不进入事件正文、
  不写日志、不进前端可导出的快照；展示页只读掩码。参照 Relay 自身要求：token 至少 32 字符、不含
  空白（`config.ts:342-353`；`.env.example:13-15`）。
- **传输边界**：仅回环地址；请求不携带 userinfo/query 中的凭据；Relay 侧 Host/Origin 白名单校验
  由 Relay 边界执行（`boundary.ts:32-61`），适配器不伪造 Origin。
- **权限模型分层**：
  - R0 连接只调用读端点；适配器本地标记连接为 `read-only`，写命令网关拒绝发出；
  - R1 连接可调用任务创建/委托；R2 连接可调用控制请求/恢复/审批决定；能力在适配器本地按阶段
    开关，不依赖 UI 隐藏按钮；
  - Relay 侧 `DENY`/权限策略变更以 Relay 判定为准（`contracts/01:23`，Proposed）；适配器不提升
    权限，不缓存「已授权动作」跨 Run 复用。
- **撤销**：用户删除连接配置 → 适配器停止订阅与轮询、清除内存凭据、本地投影标记「Relay 已断开」；
  不调用 Relay 撤销端点（Relay 无对应吊销 API 属未找到项），token 本地即失效。

### 3.5 项目/任务关联

- 关联表（未来迁移，append-only 新表，不改已发布迁移）字段建议：`local_task_id`（TaskDock
  `tasks.id`，可空）、`local_project_id`（`workspace_projects.id`，可空）、`relay_workspace_id`、
  `relay_project_id`（可空）、`relay_task_id`（可空）、`link_kind`（manual_link / created_from_local）、
  `created_at`、`updated_at`；无外键指向 Relay ID（Relay 记录删除后本地链接保留为悬空只读引用）。
- 关联只能由用户显式动作建立：在 TaskDock 任务上选择「关联 Relay 任务」并搜索/选择 Relay Task；
  或 R1 委托成功后把新建的 Relay Task/Run 回填链接。禁止按标题、描述相似度自动配对。
- 一个 TaskDock 任务可链接一个 Relay Task；一个 Relay Task 也只在 TaskDock 侧有一条主链接（UI
  重复链接时提示已有主链接）。

### 3.6 Run 状态查询与事件订阅

- **查询**：`GET /tasks/:task_id/runs`（`run-api.ts:52`）、`GET /runs/:run_id`（`:119`）；
  响应含 `status/revision/ownership_epoch/current_step/steps/recent_attempts/blocking_review_ids/
  pending_control_request/unresolved_operation_ids`（`domain-schemas.ts:676-695`）。
- **订阅**：`GET /runs/:run_id/events` SSE，游标 `after=<seq>` 或 `Last-Event-ID`
  （`run-events-api.ts:19-33`）；断线重连用上次持久化 seq 续传；`after` 大于最新已提交 seq 时
  Relay 返回校验错误（`:46-52`），适配器回退到全量拉取该 Run 并重建投影。
- **降级**：SSE 不可用时按有界轮询（间隔与上限受 TaskDock 性能红线约束）；窗口隐藏/恢复不重复
  全量刷新；订阅可取消、有超时、可回收。
- **状态映射**（Relay `RunStatus` → TaskDock 观测词表，仅展示层映射，不改写 Relay）：

  | Relay RunStatus（`schema.ts:47-58`） | TaskDock 观测状态 | 说明 |
  |---|---|---|
  | `CREATED` / `CONTEXT_BUILDING` / `PLANNING` / `RUNNING` / `VERIFYING` / `RETRYING` | `running` | 执行进行中 |
  | `WAITING_APPROVAL` | `waiting` | 等待人工审批；`wait_reason` 入 `meta` |
  | `PAUSED` | `waiting`（`meta.wait_reason='PAUSED'`） | TaskDock 词表无 `paused`，不新增伪状态 |
  | `COMPLETED` | `completed` | 轮次结束，**不等于** TaskDock 任务完成（`AGENT_ADAPTERS.md:24`） |
  | `FAILED` / `CANCELLED` | `failed` | 取消原因入 `meta`；不伪造成功 |
  | 不可达/超时未更新 | `disconnected` | 沿用既有过期判定口径（`stale_run_minutes`，`db/mod.rs:2083`） |

### 3.7 断线恢复与数据一致性

- TaskDock 投影只保存 Relay 事实的派生缓存，每条投影带 `relay_revision`（Task `revision` /
  Run `revision` / Review `revision`）与 `fetched_at`；Relay 是唯一权威。
- 断线期间：本地视图保留最后已知状态并标注「连接断开」；不阻塞 TaskDock 自身任务与工作台操作。
- 重连后：按游标续传事件；对活跃 Run 主动拉取一次 `GET /runs/:id` 校正；revision 落后于 Relay
  时以 Relay 为准重建投影，不做 last-write-wins 合并。
- 断线不丢执行记录：执行记录权威在 Relay PostgreSQL；TaskDock 投影丢失可重新拉取重建，不承担
  持久化 Relay 历史的职责。

### 3.8 人工审批入口

- R0：只读呈现 `OPEN` Review（`GET /reviews`、`GET /runs/:run_id/reviews`、`GET /reviews/:id`，
  `review-api.ts:19,27,34`），展示 `kind/reason/evidence/allowed_decisions/expires_at`；
  操作入口为「在 Relay 中处理」。
- R2：TaskDock 内可发起决定，请求体 `ReviewDecisionBodySchema`：`command_id`、`expected_revision`、
  `target_hash`（sha256）、`decision`（`ACCEPT/REQUEST_CHANGES/SET_RETRY_BUDGET/RETRY_CHECKS/
  APPROVE/DENY`）、`feedback?`、`retry_budget?`（`domain-schemas.ts:869-883`）。
- 决定前必须展示绑定对象版本与 `target_hash`；`expected_revision` 不匹配返回 `409
  REVISION_CONFLICT`，适配器刷新后由用户重新决定，不自动套用旧意图。
- TaskDock 不自动审批：任何 `APPROVE/ACCEPT` 都需用户在确认对话框中显式点击；`REQUEST_CHANGES`/
  `DENY` 同样记录 command_id 留痕。

### 3.9 操作幂等

- 所有写请求携带 `command_id`（UUID，Relay 契约字段）；适配器本地维护命令台账：请求意图、
  `command_id`、Relay 回执、`x-request-id`、时间。
- 重试规则：同一 `command_id` + 相同请求重放，Relay 返回原回执并附响应头
  `command-replayed: true`（`api/envelope.ts:364-365`；契约语义见 `contracts/01:55`；代码异常类型
  `CommandIdReusedError`，`server.ts:5,116`）；相同 `command_id` 不同请求被拒绝，适配器不得换 ID 重试。
- 危险动作（委托、控制请求、审批决定、恢复）UI 层做按钮防重；超时未拿到回执时，先按
  `command_id` 查询既有回执（`GET /control-requests/:id`，`run-api.ts:207`；`CHECK_RECEIPT_THEN_RETRY`
  语义），确认未执行后再决定是否重发。
- 读接口天然幂等；投影刷新可安全重复执行。

### 3.10 错误码映射

Relay 错误体为 `application/problem+json`，含 `status/code/retryable/retry_action/field_errors`
（`problem.ts:38-42,58-71`）。适配器映射：

| Relay status/code（证据） | 含义 | TaskDock 处理 | 是否自动重试 |
|---|---|---|---|
| 401 `AUTH_REQUIRED`（`problem.ts:171-179`） | 凭据缺失/无效 | 标记未授权，引导重填 token；停止自动重连 | 否 |
| 403 `PERMISSION_DENIED`（`problem.ts:195-203`） | Origin/权限拒绝 | 展示权限被拒；不重试 | 否 |
| 404 `RESOURCE_NOT_FOUND` / `COMMAND_NOT_FOUND`（`problem.ts:219`；`domain-error.ts:128`） | 对象或命令不存在 | 投影标记悬空/失效；命令台账标注 | 否（COMMAND_NOT_FOUND 先核对回执） |
| 409 `PROJECT_ARCHIVED` / `PROJECT_ARCHIVE_BLOCKED` / `REVISION_CONFLICT` / `INVALID_TRANSITION` / `CAPABILITY_DISABLED`（`domain-error.ts:100,115,145,166,267-278`） | 状态/版本冲突或能力未开放 | 冲突：刷新当前对象由用户重新决策（`REFRESH_AND_REDECIDE`）；`CAPABILITY_DISABLED`：展示「能力尚未开放」，不重试 | 否，先刷新/不重试 |
| 422 `VALIDATION_FAILED` / `REQUIRED_INPUT_MISSING`（`problem.ts:231`；`domain-error.ts:179,192`） | 请求体不符契约 | 定位字段错误展示；修正后再发 | 否 |
| 503 `DATABASE_UNAVAILABLE` / `SCHEMA_UNAVAILABLE`（`problem.ts:244,256`） | 依赖不可用/schema 不兼容 | 进入退避轮询；schema 不兼容同时标记契约不兼容 | 是，退避轮询 |
| 500 `INTERNAL_ERROR`（`problem.ts:268`） | Relay 内部错误 | 记录 `x-request-id`；按回执核对后重试 | 受限，先核对回执 |
| 网络不可达 / 超时 | 进程未启动或断连 | 标记 `disconnected`；后台有界重试 | 是，退避上限 |

### 3.11 日志关联与数据隐私

- **日志**：适配器日志只记方法、路径、状态码、耗时、Relay `x-request-id`、本地 command_id；
  不记 token、请求体正文、产物正文、完整文件路径（对齐 TaskDock 剪贴板/既有接入的脱敏口径，
  `mcp/bridge.rs:9`）。
- **关联**：本地命令台账记录 Relay `x-request-id` 与 `command_id`；Run 投影记录 `run.id/revision`；
  Review 投影记录 `review_id/target_hash`，便于跨端排障。
- **隐私**：默认只同步当前连接 workspace 下被打开/被链接对象的元数据；产物正文按需读取，不批量
  镜像；不上传 TaskDock 本地任务内容到 Relay（R1 委托内容由用户在确认框中明示）；凭据不落
  可提交文件、不进备份导出明文（沿用 TaskDock 备份与敏感数据规则）。

## 4. D4 最小可用集成路线 R0–R3

> **本轮（预研）不实施 R1–R3；以下为目标态设计。** 成本量级为人日区间估算，依据是：现有
> TaskDock 入站事件管线与 MCP bridge 可复用模式，但出站 HTTP 客户端、写命令网关、确认 UI 与
> 投影迁移为新增工作；未含 Relay 侧改动（本路线不改 Relay）。

### R0 只读查看

**目标**：在 TaskDock 工作台查看 Relay 项目、任务、Run 状态、执行结果与待人工处理事项；不产生
任何 Relay 写入。

- **API 契约（真实端点/字段）**：
  - `GET /health/live`（`health-api.ts:34`）、`GET /health/ready`（`:40`）；
  - `GET /projects` → `ProjectSchema`：`id/workspace_id/title/project_type/archived_at/revision/created_at/updated_at`（`domain-schemas.ts:1019` 起）；
  - `GET /tasks?project_id=&status=` → 任务摘要（`task-api.ts:165`；`TaskSchema`，`:1001` 起；摘要字段 `taskSummaryFields`，`:946-998`）；
  - `GET /tasks/:task_id`、`GET /tasks/:task_id/runs`（`task-api.ts:225`；`run-api.ts:52`）；
  - `GET /runs/:run_id`（`run-api.ts:119`）；`GET /runs/:run_id/tool-calls`（`:136`）；
  - `GET /reviews`、`GET /runs/:run_id/reviews`、`GET /reviews/:review_id`（`review-api.ts:19,27,34`）；
  - `GET /artifacts/:artifact_id`（`artifact-api.ts:379`）；按需 `GET /artifact-versions/:artifact_version_id/content`（`:407`）；
  - SSE `GET /runs/:run_id/events`（`run-api.ts:170`）。
- **调用链**：Workbench Relay 面板 → IPC `relay_list_projects / relay_list_tasks / relay_get_run / relay_list_reviews` → 适配器出站 GET → 投影仓储 → 面板只读渲染。
- **状态所有权**：Relay 是所有执行/审批/产物事实的唯一写入方；TaskDock 仅持有可重建的只读投影。
- **权限模型**：连接标记 `read-only`；写命令网关在 R0 不注册任何 mutate 路由；token 仅授读场景使用。
- **兼容策略**：响应 schema 本地断言；缺字段降级为不展示对应列；契约不兼容时面板明示并停用自动刷新。
- **测试清单**：
  1. 适配器单测：mock HTTP 返回 Relay 真实形状 DTO，断言字段映射与状态映射表（3.6）；
  2. 401/403/404/409/422/503/500 与网络不可达的错误码映射与 UI 状态；
  3. SSE 游标续传与断线重连重建投影；
  4. 断言 R0 代码路径不发起任何 POST/PATCH/DELETE；
  5. 凭据脱敏日志检查；回环地址校验拒绝非 loopback base_url；
  6. 投影过期 `disconnected` 判定与既有 `stale_run_minutes` 口径一致。
- **成本量级**：6–10 人日。依据：出站客户端 + 连接设置 UI + 投影表迁移 + 只读视图 + 单测；复用既有事件投影与设置存储模式。
- **回退方案**：设置中关闭 Relay 连接即可停用；适配器停止订阅/轮询。本地投影表保留为只读缓存，
  可由「清除 Relay 投影」一键清空；Relay 侧未产生任何数据，无回滚负担。

### R1 受控任务委托（用户明确选择并发起）

**目标**：用户在 TaskDock 对自己的任务显式确认后，在 Relay 创建任务并委托执行；TaskDock 保留
自身待办，Relay 持有执行权。

- **API 契约**：
  - 创建 Relay Task：`POST /tasks`，体 `CreateTaskBodySchema`：`command_id`、`project_id?`、`title`、`objective`、`mode?`（`ME/AI_ASSIST/DELEGATE_AI`）、`expected_outputs?`、`criteria[]?`（`criterion_id?/statement/required?/method?/target_spec?`）（`domain-schemas.ts:247-279`；`task-api.ts:130`）；
  - 委托：`POST /tasks/:task_id/delegations`，体 `DelegateTaskBodySchema`：`command_id`、`expected_task_revision`、`retry_of_run_id?`、`workflow_version_id?`、`execution_config_version_id?` 及受控动作块（`domain-schemas.ts:461-505`；`run-api.ts:70`）。
- **调用链**：用户在 TaskDock 任务上点「委托到 Relay」→ 确认对话框展示目标项目/标题/objective/criteria/预期产物 → IPC `relay_delegate_task` → 适配器生成 `command_id`、先查链接与 revision → 调 `POST /tasks`（如需新建）→ 调 delegations → 回填链接表（TaskDock task ↔ Relay task/run）→ 投影 Run。
- **状态所有权**：Relay 写 Relay Task/Run；TaskDock 写自己的 `tasks` 与链接表；委托后 TaskDock
  任务不自动置完成。
- **权限模型**：每个委托动作独立确认；适配器本地 `delegate` 能力开关；Relay 返回
  `409 CAPABILITY_DISABLED`（如 `DELEGATE_AI` 未开放，`domain-schemas.ts:257` 注释；错误定义
  `domain-error.ts:267-278`）时如实展示「能力尚未开放」，不降级为静默人工模式。
- **兼容策略**：`expected_task_revision` 取自最近一次读取；409 冲突刷新后重新打开确认框；
  `command_id` 本地台账防重复提交。
- **测试清单**：
  1. 确认闸门：未确认不发出 POST；双击/重试不产生第二个 Run（同 `command_id` 重放）；
  2. 创建任务→委托→链接回填全链路 mock；revision 冲突与命令重放回执处理；
  3. 委托内容只来自用户在确认框明示的字段，不截取 TaskDock 私有备注；
  4. 失败/取消后链接状态展示；R0 只读连接拒绝委托命令的本地守卫测试。
- **成本量级**：8–14 人日。依据：写命令网关、确认 UI、链接表迁移、幂等台账、错误冲突处理与测试。
- **回退方案**：把连接降回 `read-only` 即停止新委托；已在 Relay 的 Run 继续归 Relay 所有，
  TaskDock 不自动取消；本地链接保留为只读指向。用户可在 Relay 桌面侧终止执行。无本地数据需要
  回滚；链接表行可手动解除关联。

### R2 执行接续（暂停/恢复/人工接管/任务交接）

**目标**：在 TaskDock 内对已链接 Run 发起受控控制、处理审批决定；区分执行恢复与 UI 现场恢复。

- **API 契约**：
  - 控制请求：`POST /runs/:run_id/control-requests`，体 `RunControlRequestBodySchema`：`command_id`、`type`（`PAUSE/CANCEL/HANDOFF/CANCEL_TASK`）、`reason?`（`domain-schemas.ts:607-613`；`run-api.ts:187`）；查询 `GET /runs/:run_id/control-requests/:control_request_id`（`:207`）；
  - 恢复：`POST /runs/:run_id/resume`，体 `RunResumeBodySchema`：`command_id`、`expected_revision`、`resume_phase?`、`retry_of_run_id?`、`resume_input?`、受控动作块（`domain-schemas.ts:615-638`；`run-api.ts:219`）；
  - 审批决定：`POST /reviews/:review_id/decisions`（见 3.8；`review-api.ts:41`）；
  - 执行恢复（运维诊断，默认不进普通 UI）：`POST /runs/:run_id/recovery`，体 `RunRecoveryBodySchema`：`command_id`、`stopped_worker_id`、`stop_evidence`；回执 `outcome/fenced/unresolved_operation_ids/blocked_reason`（`domain-schemas.ts:641-653`；`run-api.ts:236`）。
- **调用链**：Run 投影行上的操作按钮 → 二次确认（展示当前 revision/wait_reason/绑定 Review）→
  IPC `relay_control_run / relay_resume_run / relay_decide_review` → 适配器带 `command_id` 与
  `expected_revision/target_hash` 调用 → 回执入台账 → 投影刷新。
- **状态所有权**：控制请求、Run 状态迁移、审批决定全部由 Relay 提交；TaskDock 只展示与发起，不
  本地改 Run 状态。
- **权限模型**：连接标记 `control`；`CANCEL/HANDOFF/恢复` 类动作高于普通暂停，单独确认文案；
  恢复端点默认隐藏在诊断视图；任何动作不绕过 Relay 的权限准入与 Review 流程。
- **兼容策略**：`PAUSED` 等状态映射到 TaskDock `waiting`（3.6）；控制请求 `PENDING/APPLIED/
  REJECTED/SUPERSEDED`（`schema.ts:359`）原样投影；`INVALID_TRANSITION` 时刷新并禁用不可用按钮。
- **测试清单**：
  1. 四类控制请求的确认闸门、幂等重放与冲突处理；
  2. 审批决定 `target_hash` 校验、`expected_revision` 409 刷新重决；
  3. 恢复端点围栏/UNKNOWN 操作投影展示；确认 UI 现场快照（`workspace_snapshots`）与执行恢复互不调用；
  4. 断线期间控制请求不重复发出；连接降为 read-only 后 R2 按钮禁用。
- **成本量级**：10–18 人日。依据：控制/恢复/审批三条写路径、确认与台账、状态机映射、诊断视图与测试。
- **回退方案**：连接降回 R1/R0；未决控制请求留在 Relay 侧（`PENDING` 状态可在 Relay 桌面查看），
  TaskDock 不代执行撤销；本地台账保留 command_id 与回执供追溯。已产生的外部副作用不可承诺撤回
  （Relay 契约口径，`contracts/04:34`）。

### R3 工作台联动（文件、任务、暂存、诊断、工作现场）

**目标**：Relay 上下文与 TaskDock 工作台互通：产物/文件互链、任务双向定位、暂存引用、诊断关联、
工作现场入口互跳。

- **API 契约**：复用 R0 只读端点 + R1/R2 写端点；新增本地联动（TaskDock 内部）：
  - 暂存引用：把 Relay `artifact_id/artifact_version_id` 记入 `shelf_items` 关联（引用模式）；
  - 任务互链：链接表（3.5）支持双向定位；
  - 诊断：Run 投影携带 Relay `x-request-id`、`run.id/revision`、未决 `operation_id` 列表；
  - 现场：TaskDock `workspace_snapshots` 条目可引用 Relay 会话/Run；Relay 接续点以入口链接呈现。
- **调用链**：工作台组件读取本地链接表 + 适配器只读投影 → 渲染关联卡片；「在 Relay 打开」走
  Relay 桌面既有入口（深链能力待 Relay 侧提供，当前未找到通用深链端点，列为未决项）。
- **状态所有权**：TaskDock 工作台、暂存、快照、验收记录归 TaskDock；Relay 产物/Run/Review 归
  Relay；联动仅为引用与导航，不复制第二套业务状态。
- **权限模型**：联动读取沿用连接能力级别；写暂存/快照条目是 TaskDock 本地动作，不要求 Relay
  写权限。
- **兼容策略**：Relay 对象悬空（删除/归档）时链接展示失效态，不报错清空本地数据。
- **测试清单**：链接双向定位、悬空引用展示、暂存引用不复制正文、快照与 Relay 现场入口隔离、
  面板在窄窗/深色/浅色主题下不溢出。
- **成本量级**：12–20 人日。依据：跨模块 UI 联动、引用迁移、双向导航与多视图回归。
- **回退方案**：解除本地链接即可断开联动；Relay 数据不受影响；暂存/快照本地条目由用户自行
  管理，适配器不批量删除。

## 5. D5 禁止项 → 架构强制约束

| 禁止项 | 架构上如何强制 |
|---|---|
| 不复制 Relay 整套数据库 | 适配器不直连 PostgreSQL；只通过 HTTP API 读取被引用对象的元数据；投影表按对象维度缓存并带 revision/fetched_at，可整体重建；不迁移 Relay 表结构、不本地镜像全量任务/产物历史（3.2、3.7、2.6）。 |
| 不在 TaskDock 重写 Relay Worker | TaskDock 不实现执行领取、租约、围栏、LangGraph 推进、动作重试或恢复写权；Worker 职责留在 Relay `apps/api/src/worker/`；适配器只做查询、订阅与受控命令转发（1.1、2.7）。 |
| 不让两端同时成为同一 Run 的写入权威 | Run/Step/Attempt/Review/Completion 的写入只经 Relay API；TaskDock 投影表是适配器拥有的可重建缓存，UI 不能就地编辑 Relay 状态字段；本地链接表只存稳定 ID 引用（2.4、2.5、3.5、3.7）。 |
| 不凭 Agent 自述自动验收完成 | Run `COMPLETED` 只投影为轮次结束；TaskDock 任务完成与验收 verdict 必须人工选择；Relay 业务完成以 `completion_records`/`verification_sessions` 为准，适配器不把轮次状态映射成本地验收通过（2.5、3.6）。 |
| 未经用户批准不执行有副作用动作 | R0 零写路径；R1/R2 每个 mutate 请求前有显式确认闸门；写命令网关按阶段能力开关；所有写请求带 `command_id` 幂等台账；`DENY/ASK` 留在 Relay 判定；适配器不自动批准、不自动重试危险动作（3.4、3.8、3.9、4.R1/R2）。 |

## 6. 未决项与假设（本轮未联调，进入开发前需核实）

1. **工作区列举**：代码中未找到 `GET /workspaces` 列举端点；`workspace_id` 需用户录入或从 Relay
   桌面配置获取。开发前确认 Relay 是否有计划提供连接清单/默认工作区端点。
2. **契约版本发现**：未找到独立版本/能力协商端点；当前依赖 `/api/v1` 前缀与响应 schema 断言。
3. **桌面深链**：未找到 Relay 对外深链协议（如 `relay://` 或自定义 URL scheme）；「在 Relay 打开」
   的落地方式待确认。
4. **出站 HTTP 客户端**：TaskDock Rust 侧当前无 reqwest 类客户端（`Cargo.toml:44-45` hyper 仅
   server）；R0 开发时需选定客户端并走依赖评审，本轮未安装任何依赖。
5. **投影表形态**：复用既有 `agent_sessions/agent_runs/agent_events` 观测口径，还是新增独立
   `relay_projection_*` 表，需在 R0 设计落地时结合既有来源归属规则决定；迁移必须 append-only。
6. 本文引用的 `contracts/01/03/04` 状态为 Proposed；其中所有权与恢复规则以最终代码实现为准，
   本设计已在字段级以 `apps/api/src/` 代码复核。
