# 架构设计

## 1. 分层

```
外部 Agent（Claude / Codex / Gemini / 任意能执行命令或发 HTTP 的进程）
        │
        ├── CLI:  taskdock.exe（独立 console 可执行文件，直接调用统一服务层）
        ├── MCP:  taskdock.exe --mcp-server  →(stdio JSON-RPC)→ 主进程 loopback /mcp
        ├── REST: http://127.0.0.1:<port>/api/v1/...（主进程 loopback，Bearer agent token）
        └── 文件:  TaskDock-Agent-Workspace/（投影 + 受控导入，经同步服务）
                                │
                    ┌───────────┴───────────┐
                    │  Agent Access Layer    │  权限校验 / 审计 / 版本与冲突 / 来源标注
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │  Unified Service Layer │  agent_access::service
                    └───────────┬───────────┘
                                │
        ┌───────────────┬───────┴────────┬────────────────┐
   planning 服务    tasks 服务     knowledge 服务    新建：decisions / handoffs
        └───────────────┴────────────────┴────────────────┘
                                │
                          SQLite（唯一事实来源）
                                │
                          TaskDock UI
```

**硬约束**：CLI / MCP / REST / 文件四个入口不允许各写一套 SQL。四个入口只能调用
`agent_access::service`（内部再调用既有 `*_impl`）或 `agent_access::handoff/store`（新增实体）。

## 2. 一次外部写入的固定管线

```
1. 解析身份      CLI: env TASKDOCK_AGENT_TOKEN；MCP/REST: Bearer token
2. 解析能力      permissions::require(principal, capability, scope{project|resource})
3. 读取基线      service 返回 {data, revision, updated_at}
4. 版本校验      调用方提交 base_revision（+ 可选 base_updated_at）
                 不一致 → AppError::Conflict(当前 revision 与摘要)，不落库
5. 业务写入      复用既有 *_impl（事务内完成业务 + activity）
6. 版本推进      agent_resource_revisions += 1，记录 updated_by / source / content_hash
7. 审计          写 agent_activity_logs（成功/失败、接口、对象、revision、request_id；无正文）
8. 投影          标记该资源为「待导出」，同步任务在下一个周期写出（不在请求线程里写文件）
```

写入在请求路径上**不同步写文件**：避免长 IO 阻塞与同步环。投影由 `sync::export_dirty` 异步完成。

## 3. 来源（source）判定

| 来源 | 值 | 判定方式 |
|---|---|---|
| UI | `ui` | Tauri 命令调用（`Principal::Local`） |
| CLI | `cli` | `taskdock` 可执行文件 |
| MCP | `mcp` | loopback `/mcp` 工具调用 |
| REST | `rest` | loopback `/api/v1` |
| 文件 | `file` | 同步服务导入，`force_source=file` |
| 系统 | `system` | 迁移/修复/初始化 |

来源只由服务端根据**入口**决定，调用方不能通过参数伪造（REST 忽略 body 里的 `source`）。

## 4. 文件投影与同步（不产生回环）

```
DB ──export──▶ 文件（记录 exported_hash + exported_revision 到 agent_workspace_files）
                    │
              （Agent 手动编辑 / 外部写入）
                    ▼
文件 ──scan──▶ 计算 hash：== exported_hash → 跳过（自身写入，不导入）
                        != exported_hash → 候选导入
                                          │
                        DB revision == exported_revision ? → 安全导入
                                                          : → 写冲突记录，不覆盖
```

- 文件监听是**轮询 + 有界变更集**（默认 20s，上限 200 文件/轮），不做 OS hook。
- 只扫描协议允许的目录（`inbox/`、`tasks/inbox/`、`knowledge/inbox/`）。
- 导出写入前记录 hash 与 revision，因此自身写入不会被误判为外部修改。
- 删除/重命名只更新索引状态，不删除数据库数据；数据库删除也不删除文件（避免不可逆）。

## 5. 并发与一致性

- SQLite 单写连接 + WAL：同进程内写事务串行；CLI 独立进程用 `busy_timeout=5s`。
- 所有外部写要求 `base_revision`；不一致返回 409/`Conflict`，携带当前 revision。
- MCP 已有工具保持 `expected_revision` 语义不变；新增工具沿用同一规则。
- REST 写接口支持 `Idempotency-Key`：命中 `agent_request_cache` 直接返回首次结果。

## 6. 上下文装配（Context Engine）

> **记法更正（2026-11-20，第二轮架构审计）**：本节原记 `build_agent_context(query|project|task|plan|agent, budget, kinds)` 为设计稿伪签名，该名称在 Rust/TS 源码中**不存在**（全仓仅本文一处）。真实入口是
> `agent_access::context::build(db, principal, req)`（`src-tauri/src/agent_access/context.rs:1022`），
> 入参为结构体 `ContextRequest { task, task_id, project_id, agent_id, session_id, budget_tokens, kinds, format }`，
> 预算常量 `DEFAULT_BUDGET=6000` / `MAX_BUDGET=24000`（clamp 1000–24000）。
> 下列流水线描述仍为**目标态设计**：已实现的部分为 7 类来源检索、权限过滤、中文 2-gram 抽词、
> 去重与预算裁剪；「打分/relevance 排序」等为未来扩展，引用时以下方真实签名为准。

真实入口 `agent_access::context::build(db, principal, req)`：
范围解析 → 多源检索（任务/规划/知识/决策/Skill/交接/近期变更）→ 打分 → 去重 → 预算裁剪
→ Markdown / JSON 输出。每条内容带 `source_id / source_kind / updated_at / relevance / summary /
uri`，不把推测写成事实。详见 [context-engine.md](context-engine.md)。

## 7. UI 与管理面

能力中心新增「Agent 接入」子页（接入状态 / 权限 / 活动 / 交接 / 同步），复用 `cap-*` 语义样式与
既有组件；不复制 MCP 管理页，只在设置页保留 MCP Server 端开关，在本页提供统一视图与操作。

## 8. 生命周期

- REST 服务与文件监听只在设置开启时启动，设置变更即时生效（与 MCP bridge 同一模式）。
- 监听线程有取消标志与最大生命周期；退出时 join，不留下孤儿线程。
- 所有后台任务有上限（并发 1、每轮文件数上限、单文件大小上限）。

## 9. 授权读取层（v82，2026-11-20）

四个入口的读取不再直接调用 `store::list_*` / `store::get_*`。统一入口在
`agent_access/service.rs`：

```text
CLI / MCP / REST ──▶ service::list_decisions_authorized
                     service::get_decision_authorized
                     service::list_activity_authorized
                     service::knowledge_index_authorized
                     service::authorized_knowledge_base_ids
                        │
                        └─▶ permissions::{authorized_reads, can_read_project_metadata}
                              └─ mcp_agent_capabilities（每次请求重读）
```

约定：

- 能力范围**按资源类型分开**（`CapableScope`），不把 `knowledge.read` 的项目授权套给决策；
- `ContextRead` 只表示「可装配上下文」，不进入任何资源可见性判定；
- 显式项目先验证存在性再要求该项目授权；未指定项目时按授权集合过滤，分页 `total` 同步正确；
- 无项目归属的决策/活动只对全局授权可见；项目已删除不回落全局；
- 认证通过但无授权返回 `FORBIDDEN`，不返回空列表；
- **v92（统一授权四层）**：`permissions::require` 在能力判定后追加 grant 层——项目型能力且
  资源非空且 `scope≠readonly` 时必须持有 `mcp_agent_grants` 上该项目根的授权；
  `authorized_reads` 在 `project_rw` 下与 grant 求交集（projects/plans/decisions/handoffs）。
  CLI / MCP / REST 共用同一判定，任何协议都不能通过换接入绕过权限。
  职责边界详见 [permission-model.md](permission-model.md) §3。

## 10. REST 幂等与提交结果恢复（v82）

`agent_request_cache` 的状态机（迁移 83 增加 state/attempt，迁移 84 增加 operation 指针）：

```text
(无行) --claim--> inflight --record_operation--> inflight(+指针)
                     │                                  │
                     │ 业务事务内 guard.complete          │ 崩溃：响应未写
                     ▼                                  ▼
                  committed ──cache_complete──▶ done   committed（租约过期也**不可抢占**）
                                                       │
                                     重试：按 operation 指针只读重建响应
                                           无法重建 → 409 IDEMPOTENCY_RECOVERY_REQUIRED
```

- `inflight` 过期可被新 attempt 抢占；`done` 过期按 TTL 重新执行；`committed` 永不抢占。
- `RequestCacheGuard` 的 `check/record_operation/complete` 与业务写入同事务：不存在「业务已写、
  提交标记未写」的窗口。
- 重建只调用授权读取，不产生业务写入。

## 11. 操作生命周期与可视化（v86）

四入口的写入统一挂到 `agent_access::operations`（表 `agent_operations`，迁移 v86）：

```text
start(running) ──▶ writing ──▶ committed（MCP 与业务同事务；其他入口在提交返回后）
      │                │
      │                ├──▶ failed / conflict（业务回滚或版本冲突）
      └────────────────┴──▶ interrupted（租约过期、结果不可确定）
```

- 事实来源是数据库；`agent-operation-changed` 事件只降低延迟，前端只保留一个游标做增量同步，
  独立 CLI 进程因此也能被感知。
- 终态不可回退；`interrupted → committed` 是唯一例外（业务确实提交了）。
- 与 `planning-changed` 职责分离：前者刷业务数据，后者展示操作过程。
- `agent_activity_logs` 仍是追加式审计，不被改造成运行状态表。

细节（事件契约、资源关联、故障恢复、权限与测试）见
[`operation-visualization.md`](operation-visualization.md)。

## 统一项目身份（2026-11-21）

Agent 侧所有「项目」引用统一解析到 `workspace_projects.id`：

- `GET /projects` 每个项目一行，`activePlanId` 是摘要字段；
- `GET /projects/{id}` 接受项目根或计划 ID，响应带 `projectId` / `planId` / `activePlanId` / `plans`；
- `GET /plans` 独立返回计划，条目带 `projectId`；
- 授权、操作记录、上下文装配、文件投影一律用项目根；计划 ID 只在入参兼容层出现。

实现：`project_hub::service::{resolve_project_ref, resolve_project_root}`（v92 起带
`ProjectId` / `PlanId` 强类型）+ `agent_access::service` 的读模型；计划缺项目根时在事务内用
`ensure_project_for_plan_tx` 补建。

## 统一授权与幂等归属（2026-11-22，v92）

- **授权四层**：身份 → scope → capability → grant，唯一入口 `agent_access::permissions::require`；
  三个协议（CLI/MCP/REST）与文件导入共用，MCP 工具的 `ensure_grant` 是薄包装。
- **项目列表授权过滤**：全局能力 + readonly 返回全部；项目级授权只返回被授权项目；
  无授权返回 `FORBIDDEN`，`total` 为过滤后数量。
- **创建幂等归属**：`project_create_requests`（v92）按
  `UNIQUE(principal_kind, principal_id, client_request_id)` 隔离主体——同一主体重试返回原项目，
  换摘要 `Conflict`，跨主体相同请求 ID 各自独立；`project_events` payload 记录真实主体。
- **目录创建门禁**：`create_new` 仅限本机人类（UI / 未带 token 的 CLI）；RegisteredAgent 在
  CLI / MCP / REST 一律拒绝。详见
  [统一项目身份与创建服务](../project-hub/10-统一项目身份与创建服务.md) §14 与
  [permission-model.md](permission-model.md)。

## Project/Plan 双聚合契约（2026-11-22，v93，ADR-0011）

第二轮后 REST/MCP 的「项目」实际仍可能指计划行（授权按根、更新落计划），项目根也没有自己的
并发版本。第三轮把两个聚合彻底分开：

- **revision 模型**：项目根并发令牌 = `workspace_projects.revision`（迁移 v93，DEFAULT 1）；
  `update_project_fields_tx` 同事务「读 → 比对 expected_revision → +1」，并把
  name/description/target_date 镜像同步到全部计划行；计划聚合沿用 `planning_projects.revision`
  （v37）。校验唯一实现 `project_hub::service::check_expected_revision_tx`。
- **读模型同源**：`project_hub::service::ProjectSummary.revision` 与
  `agent_access::service::project_summary` 都读根列（弃用 agent_resource_revisions 计数器
  派生），description/goal 改读 `workspace_projects.description/goal` 事实源列（原映射
  note 列，与 PATCH 写入不对称）。
- **资源边界**：`GET/PATCH /api/v1/projects/{projectId}` 与 `taskdock_get_project` /
  `taskdock_update_project` = 项目根聚合（lifecycleStatus=active|archived、根 revision）；
  `GET/PATCH /api/v1/plans/{planId}` 与 `taskdock_get_plan` / `taskdock_update_plan`
  = 计划聚合（执行状态、计划 revision）。**第五轮收紧**：`/plans/{id}` 读写都只接受
  PlanId（根 ID → Validation），计划 PATCH 不再接受 name/description/targetDate；
  计划工具传根 ID → Validation 指路；项目聚合传计划 ID 仍兼容（边界归一根）。
  项目根 → 活动计划用 `GET /api/v1/plans/current` 或 `GET /api/v1/projects/{id}`。
- **写入口必须带版本令牌**：REST/MCP/CLI/IPC 的通用更新入口缺 `expectedRevision`
  （根或计划）直接 Validation；空补丁同样 Validation，不推进 revision、不发事件、
  不产生成功审计/committed 操作。唯一例外是明确区分的领域方法（归档/恢复、工作空间
  编辑器、补链后首次写入）。
- **创建事务统一**：`agent_access::project_creation::create_for_agent(_in_conn)`——
  行 ID fail-closed → 拒 `create_new` → scope 重读（撤销即时生效）→ `projects.create`
  → 创建 → **仅 created=true 时**项目根自动授权，单事务原子提交；CLI/MCP/REST 三入口共用，
  「创建已提交、事务外授权失败」窗口消除。幂等重放（created=false）不写授权：
  人类撤销的权限不能被原 requestId 重放恢复。人类 UI 保持 `creation::create()`。
- **幂等 fail-closed**：`Prepared` 携带独立 `principal`；缺行 ID 的 Agent 直接拒绝；
  历史兜底按主体类别判定（Agent 永不进人类事件兜底）；actor/`payload.principal` 记真实主体。
- **全局 ID 契约**：`resolve_project_ref` / `resolve_project_root` 是唯一解析入口；
  `context.rs::project_name` 已从「先查计划再查根」改为归一根（字符串猜测消除）；
  collab 表 `project_id` 是 FK→planning_projects（类型化计划 ID，合法 Plan 聚合归属）。

## 专业领域接入 Phase 1（Novel + Comic，2026-11-23）

首阶段将**事务、幂等、权限、版本、数据安全**收敛到同一套领域应用服务。
游戏、通用和开发的后续接入见下文。

### 12.1 Domain Application Service 职责

`src-tauri/src/agent_access/domains/{novel,comic}.rs` 是领域应用服务，负责：

1. 编排权限、项目类型/状态、资源归属（调用 `domains::policy`，不复制权限判定）；
2. 调用既有业务写核心（`novel_chapter_save_content_in_conn` /
   `comic_media_save_in_conn` / `comic_media_adopt_in_conn`），不复制 SQL；
3. 在**调用方传入的 Connection** 上读取 revision、推进 revision、登记操作；
4. 组装 Agent 专用 DTO（最小化字段、相对路径、revision/updatedAt）。

领域层提供三种显式入口，禁止入口层再包一层事务：

| 入口 | 领域包装 | 事务所有权 | 守卫 |
|---|---|---|---|
| MCP | `*_in_conn` | `mcp::tools::run_tool_call` | `NoGuard`（MCP 外层幂等/操作已持锁） |
| REST | `*_with_guard` | 领域包装内开启唯一业务事务（HTTP 层不持 Db 锁） | `RequestCacheGuard + OperationGuard` |
| CLI | `*_with_request` | `domains::idempotency::execute` 内单事务 | 外层 `OperationGuard` + cache 占位 |
| 文件 | `*_in_conn` | `domain_import` 的导入租约事务 | `ImportLeaseGuard` |

`domains::idempotency::execute` 不再创建 `AgentOperation`、不再自开写事务；它只把
cache 占位叠加到入口守卫（`StackedGuard`）。事务内核心**不得**调用
`db.with_conn` / `db.with_read` / `db.with_transaction`——`Db::writer` 是
`Mutex<Connection>`，外层事务已持锁，嵌套必然自锁。

### 12.2 一次外部写请求的唯一性

- 一条权威 Operation（MCP 由 `run_tool_call`，REST 由 `begin_rest_operation`，
  CLI 由 `operations::try_start`，文件导入由导入租约记录）；
- 一个权威幂等身份（MCP `requestId`、REST `Idempotency-Key` + 指纹、CLI 外层 requestId）；
- 一个业务写事务（业务行、操作终态、幂等占位同事务）；
- 一份成功审计（MCP 外层审计；REST/CLI 走各自活动记录，不重复写）；
- 一份真实 revision（`bump_revision_from` 基于 effective revision）。

### 12.3 Manifest 授权

`domains::manifest::build_for_principal(db, principal, project_ref)` 是唯一入口：
解析项目根 → `projects.read`（身份/scope/能力/项目 grant）→ 读 kind/status →
`DomainKind::parse`。Manifest 不是授权凭证，但也不是免授权接口；MCP/REST/CLI
三入口全部走该服务。响应中的 `project.kind` 是真实数据库类型（漫剧为
`ai_comic`），`domain` 才是领域名（`comic`），二者不得混用。

### 12.4 revision 契约

Agent DTO 统一携带 `revision` 与业务行真实 `updatedAt`。`updatedAt` 只来自业务表
`updated_at`，不得用 revision 计数器的 `counter_at` 冒充；`read_revision_snapshot`
用 `effective_revision` 把 UI 直接改业务行计入版本，Agent 写入后在同事务推进。
UI 命令层（`novel_chapter_save_impl`、`novel_chapter_save_content_impl`、
`comic_media_save_impl`、`comic_media_adopt_impl`）通过 `revision::note_ui_write`
在**同一业务事务**推进版本；因此即使 Agent 从未建立基线，首次 UI 修改后读取也是
revision=1，而不是无基线 0。Agent 领域核心只调用 `_in_conn`，不会重复推进。

## 游戏、通用、开发领域接入（2026-11-24）

三类项目复用静态操作注册、Manifest 和入口事务所有权。写入复用各自命令模块的业务核心，
并在同一事务完成项目门禁、写入与资源指针登记。CLI、MCP、REST 的领域写请求重放按当前授权
检查项目，开发证据同时检查任务归属与读取权限。操作和传输映射见[功能矩阵](feature-matrix.md)。

- 游戏读写已登记的运行结果元数据。构建与测试可由 Agent 新建，引用的构建和事项均在本项目内
  校验。DTO 限制路径暴露，并标明构建或测试的结果尚未独立验证。
- 通用里程碑保存沿用 `general_milestones` 及原有字段校验。桌面和外部写入共同推进 revision。
  资料列表与统计通过数据库读取项目内元数据。
- 开发领域从库内读取 Git 快照和任务证据元信息。Agent 关联已有交接包或人工验收记录，
  使用开发工作台的关联写入核心，检查证据归属且拒绝覆盖已存在的关联。

兼容性为增量扩展，沿用现有迁移及桌面 IPC 签名。

小说人物、世界观、引用与漫剧角色、场景读取会在完成项目授权后释放数据库连接，再调用已有列表
服务。内存数据库在读取时使用写连接，旧实现嵌套借用连接会等待同一把锁。
