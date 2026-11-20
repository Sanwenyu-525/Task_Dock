# Agent 共享工作空间 v82 验收报告

> 执行方：主 Agent + Agent A/B/C/D/E
> 基线：`main` @ `fc1c629`（开工时）；执行期间其他会话提交至 `f6b6dc9`，工作区含大量他任务未提交改动
> 结论口径：**Dev 功能验收通过**；Release 安装包 / 安装升级 / 性能基线本轮未执行

## 1. 任务范围

本轮只修 Agent 共享工作空间的授权、事务、幂等、上下文与交接一致性，不新增能力、不重构
CLI/MCP/REST/File 架构。范围：

| 编号 | 目标 | 主要文件 |
|---|---|---|
| A | 统一授权查询（CLI/MCP/REST 不再直读 store） | `service.rs`、`permissions.rs`、`cli.rs`、`mcp_tools.rs`、`rest.rs` |
| B | 完成任务与知识更新事务化、revision 同事务 | `service.rs`、`sync.rs`（导入调用点） |
| C | REST 幂等「业务提交结果」持久化与重启恢复 | `store.rs`、`schema.rs`、`db/mod.rs`、`rest.rs` |
| D | Context/Handoff 资源权限、活动过滤、报告分页 | `context.rs`、`handoff.rs`、`service.rs` |
| E | v82 独立验收脚本与证据 | `scripts/acceptance-agent-access-v82.mjs` |

不在本轮：Event Bus、Task Claim、远程 Gateway、Agent 自动调度、新 UI 页面。

## 2. 根因与修改

### 2.1 统一授权查询（A）

**根因**：`cli.rs` / `mcp_tools.rs` / `rest.rs` 直接调用 `store::list_decisions`、
`store::get_decision`、`store::list_activity`，这些函数没有 principal 参数；项目级授权与
资源归属只在少数写路径校验，读路径可跨项目读取。

**修改**（`service.rs`）：

| 方法 | 行为 |
|---|---|
| `list_decisions_authorized` | 需 `decisions.read`；显式项目先验证项目存在并要求该项目授权；未指定项目时按 `Capability::DecisionsRead` 的项目集合过滤；无项目决策仅全局授权可见 |
| `get_decision_authorized` | 按决策真实 `project_id` 判定；项目已删除时不回退全局（`project_exists` 失败 → 只接受全局授权） |
| `list_activity_authorized` | 服务端 SQL 过滤：项目级、任务级、知识库级、决策/交接/规划级分别匹配；`context.read` 不产生任何可见性；无读能力 → FORBIDDEN |
| `authorized_knowledge_base_ids` | `knowledge.read` 的全局/知识库/项目授权 → 允许的知识库集合（`None` = 全局） |
| `knowledge_index_authorized` | 先判定再导出；只保留授权知识库及其文档（不含正文也不跳过权限） |

**修改**（`permissions.rs`）：新增 `CapScope` / `AuthorizedReads`（按能力分开，避免「一种资源的
授权套到另一种资源」）、`RESOURCE_READ_CAPABILITIES`（显式排除 `ContextRead`）、
`can_read_project_metadata`（只认 `projects.read`）。

**调用点**：CLI `decision list/get`；MCP 工具 `taskdock_list_decisions`、
`taskdock_get_decision`、`taskdock_agent_activity`，资源 `taskdock://decisions`、
`taskdock://knowledge/index`，Prompt `review_architecture_decision`；REST `GET /decisions`、
`GET /decisions/{id}`、`GET /agents/activity`；REST `GET /sync/status`、`GET /sync/conflicts`
新增 `projects.read` 前置校验。

### 2.2 任务完成与知识更新（B）

**任务完成根因**：`service::complete_task()` 先校验再调用 `toggle_task_inner()`（完成/重新打开
双向语义），且 revision 在另一个连接单独推进。并发或重试时可能把已完成任务重新打开，或出现
「状态已变、revision 未变」。

**修改**：`complete_task()` 直接委托 `complete_task_guarded(&NoGuard)`；事务内完成：

- 事务内重读任务并基于 `updated_at` 重算有效 revision，`base_revision` 不匹配 → CONFLICT；
- 已完成 → 幂等返回（不写库、不推进 revision）；
- 仅 `pending → completed`；其他状态 → CONFLICT；
- 重复任务走 `advance_recurrence_tx` 的期次 CAS；`Conflict` 不再重复记录完成事件；
- 提醒关闭、完成统计、`bump_revision`、`guard.record_operation`、`guard.complete` 同事务；
- 桌面端 `commands::tasks::toggle_task_inner` 未改动，UI 的完成/重开交互不变。

**知识更新根因**：revision 校验在事务外；正文更新与 revision 推进分两个提交；索引重建失败
没有可恢复状态。

**修改**（`update_knowledge_guarded`）：事务内重读文档、校验 revision、更新正文并置
`status='pending'`、同事务 `bump_revision`；索引重建在事务外执行，失败只写 `error` 并保持
`pending`，由 `repair_pending_knowledge()`（有界 20 篇）在后续检索时重试，最终与正文一致。
`create_knowledge_guarded` 的 revision 推进也移入文档写入事务。

### 2.3 REST 幂等结果恢复（C）

**根因**：业务事务与 `agent_request_cache` 完成是两个独立提交。进程在两者之间退出时，缓存行
仍是 `inflight`，租约过期后重试会再次执行业务创建。

**修改**：

- 迁移 **84**（`schema.rs::MIGRATION_84`，登记于 `db/mod.rs`）：`agent_request_cache` 增加
  `operation_kind`、`operation_id`、`committed_at`；只加列，不重建 82/83 已发布结构。
- `store::WriteGuard` 增加 `record_operation(kind, id)`；`RequestCacheGuard` 在**业务事务内**
  校验 attempt + 写 operation 指针 + 置 `state='committed'`。
- `cache_claim` 状态机：`inflight`（可过期抢占）→ `committed`（**永不被抢占**）→ `done`；
  新增 `CacheClaim::Committed`。
- REST `dispatch` 接收 guard；8 个写路由改用 guarded 版本：task create/update/complete、
  knowledge create/update、decision create、handoff create、report create。
- `Committed` 重试：指纹一致时按 `operation_kind/operation_id` 走只读重建（task/knowledge/
  decision/handoff/report），`meta.replayed=true` 并补写 `done`；指针为空或未知类型 →
  409 `IDEMPOTENCY_RECOVERY_REQUIRED`，**禁止重新执行**。

### 2.4 Context 与 Handoff（D）

**Context**：删除把 `context.read` 当项目访问依据的 `can_access_project`，改为
`project_read_scope_covers`（只看资源读能力）；项目名称需 `projects.read`；规划目标需
`plans.read`；默认项目只从有资源读授权的项目中选择；`recent()/handoff_activity()` 改调
`service::list_activity_authorized`，不再直接读全量活动。中文双字检索、预算裁剪与去重未改。

**Handoff**：`list_reports` 按 `handoffs.read` 的项目集合先过滤再分页（新增
`store::list_reports_in_projects`）；`list_reports_for_context` 同样先过滤；`get_report` 归属由
交接推导，无交接且无项目只接受全局授权；`ensure_handoff_access` 对文件导入也执行能力+项目校验。
状态机的操作者约束、事务内 revision CAS、审计同事务保持不变。

### 2.5 顺带修复的真实缺陷

| 问题 | 影响 | 修复 |
|---|---|---|
| `write_activity` 写入 `actor_kind='human'`，而 v76 CHECK 只允许 `agent|local|system` | 本机/UI 的审计被 CHECK 拒绝且被 best-effort 吞掉，活动列表长期缺失本机记录 | 写入前映射为 `local`（`store.rs`） |
| Markdown 导入正文保留末尾换行 | `task.update` 的 description 与测试/上游预期不一致 | 解析时只去尾部 `\r\n`（`sync.rs`） |

## 3. 数据库迁移

- 全新库：`Db::open_in_memory()` 走完整 `MIGRATIONS`，`user_version` 为当前末位迁移号。
- v83 → v84 升级：测试 `db::tests::v82_migration_84_adds_operation_pointer_to_existing_cache_rows`
  先应用到 83、插入旧格式缓存行，再应用 84 及之后；断言旧行 `operation_kind/operation_id=''`、
  `state='done'`、`committed_at=NULL`，重复执行迁移为空操作。
- 迁移 84 只 `ALTER TABLE ADD COLUMN` + 索引；回退 = 忽略新增列，旧库仍可读。

## 4. 真实执行记录

| 检查 | 命令 / 位置 | 结果 | 时间与证据 |
|---|---|---|---|
| Rust 编译 | `npm run cargo -- check --lib`（`d:\Develop\task_dock`） | **exit 0** | 2026-11-20 21:14 起多次，最终 22:48 重建通过 |
| Agent Access 单测 | 测试二进制 `agent_access:: --test-threads=1` | **143 passed / 0 failed / 0 ignored**（81.36s，最终复跑；首次 83.39s） | 2026-11-20 22:40 前后；含 v82 四套测试与 tests.rs 权限回归 |
| 迁移 84 升级 | 测试二进制 `db::tests::v82_migration_84` | 见 §4.1 | `src-tauri/src/db/mod.rs` 测试 |
| 前端类型 | `npm run typecheck` | **exit 0** | 2026-11-20 22:52 |
| v82 独立验收 | `node scripts/acceptance-agent-access-v82.mjs --bin src-tauri/target/debug` | **52/52 通过，exit 0** | 2026-11-20T14:48:54Z–14:49:25Z；`tmp/acceptance/agent-access-v82-20261120-224854/` |
| 二进制 | `task-dock.exe` SHA256 `1C3C391F…FE64A`；`taskdock.exe` SHA256 `3B5EF668…93339` | Debug | 2026-11-20 22:48 构建 |

**验收环境**：Windows 11 22631；Debug 二进制；隔离 `TASK_DOCK_DATA_DIR` +
`WEBVIEW2_USER_DATA_FOLDER`；REST 端口 17831；CDP 端口 17881。

**关键资源 ID**（来自 52/52 运行）：
- 项目：`v82-proj-a` / `v82-proj-b`
- 知识库：KB-A `13a2613b-76da-4e8a-bf48-e13657e1b8e4`；KB-B `fd440467-f4a2-4d7d-8bd3-f2d966f8ccd9`
- 决策：A `d9cadbdf-bbf6-49d0-8f1c-b9571967c7f1`；B `7f9d3dee-89a6-4f7e-a55e-d11a29f7e909`
- 导入批准任务：`35c7f608-1c6a-4941-8714-b408ed61a3d5`
- 交接：`70947ded-f666-4c53-82e2-d1bc8c52c09b`（A→B，completed）

**预期/实际摘要**：

| 场景 | 预期 | 实际 |
|---|---|---|
| 无 `decisions.read` 读决策 | exit 6 / FORBIDDEN，无副作用 | exit 6，`agent_decisions` 2→2 |
| 项目 A Agent 读项目 B 决策 | 403 | listB=403、detailB=403、listA=200 |
| 项目 A Agent 看活动 | 200 且只含项目 A | items=3，projectB=0 |
| 知识索引（仅 KB-A） | 只含 KB-A | `bases=KB-A`，`docKbs=KB-A` |
| 同 Key 重放 | 只创建 1 条任务 | first=201、replay=201、`replayed=true`、同标题 1 条 |
| 同 Key 不同 Body | 409 且不新增 | 409 CONFLICT，tasks 2→3（该步为独立前置创建） |
| 无策略导入 | pending_review=1，不写业务表 | pending_review=1，tasks 不变 |
| 人工批准导入 | 任务 +1，请求 imported | tasks 3→4，`decided_hash` 匹配 |
| 同内容重投再扫描 | 不重复创建 | `imported=0 skipped=1`，tasks=4 |
| 两进程并发完成 | 只一次完成 | revision 1→2，`completed_at` 不变 |
| 已完成后重复完成 | 不重新打开 | exit 0，status=completed，`completed_at` 不变 |
| Handoff 越权 | A 不能替 B 接收/完成 | FORBIDDEN，状态不变 |
| 错误 revision | CONFLICT，状态不变 | exit 5，状态/revision 不变 |
| 报告项目 | 由交接推导，A 读者看不到 B | B 报告对 A 读者不可见 |

### 4.1 迁移测试结果

`db::tests::v82_migration_84_adds_operation_pointer_to_existing_cache_rows`
（测试二进制，`--nocapture`）：**1 passed / 0 failed / 0 ignored**，0.42s，exit 0（2026-11-20 23:04）。
覆盖：v83 旧缓存行升到 84 后 `operation_kind=''`、`operation_id=''`、`state='done'`、
`committed_at=NULL`；按真实 `user_version` 重复执行迁移为空操作；全新库走完整迁移链。
注意：迁移 85 由并行会话随后追加，测试不硬编码末位版本号，只断言「≥84 且等于当前末位」。

## 5. 问题清单

| 级别 | 问题 | 状态 |
|---|---|---|
| P0 | 读接口绕过授权（决策/活动/知识索引可跨项目） | 已修复，52/52 验收覆盖 |
| P0 | `complete_task` 双向 toggle 可能重新打开已完成任务 | 已修复，并发/重放用例覆盖 |
| P0 | 幂等业务提交后崩溃会重复创建 | 已修复（committed + operation 指针 + 重建/409） |
| P0 | 本机活动审计被 CHECK 拒绝且静默丢弃 | 已修复 |
| P1 | 知识更新 revision 与正文分事务 | 已修复 |
| P1 | `context.read` 被当作项目访问能力 | 已修复 |
| P1 | 活动记录不做授权过滤 | 已修复（服务端 SQL） |
| P1 | 报告列表未按项目过滤 | 已修复（先过滤再分页） |
| P2 | Markdown 正文尾部换行导致 description 不一致 | 已修复 |
| P2 | `list_handoffs` 项目级未指定项目仍 FORBIDDEN | 保留（fail-closed，未扩权） |
| P2 | 项目级 `tasks.read` 无法进入显式项目上下文 | 保留（既有语义，未扩权） |

## 6. 未验证项与边界

- **Release 正式验收未执行**：安装包生成、安装/升级/卸载、签名与更新、生产资源加载、正式性能
  基线需要 Integration Snapshot + 安装包；本轮为 Dev 功能验收。
- 内存/CPU/动画流畅度不构成本轮结论（Debug 未优化）。
- `handoff accept/reject/complete` 与 `sync resolve/scan` 不具备 operation 恢复语义：它们不创建
  新业务实体，重试依赖 revision CAS / 业务幂等；提交后崩溃会得到 CONFLICT，而不是重复写入。
- 部分项目级授权仍 fail-closed（如未指定项目的 `list_handoffs`）；这是保守行为，非越权。
- 测试二进制运行需要嵌入 comctl32 v6 manifest（共享 target 的 test exe 默认无 manifest 会以
  `STATUS_ENTRYPOINT_NOT_FOUND` 退出）；这是本机测试执行环境处理，不涉及业务代码。验收脚本使用
  真实 `task-dock.exe`/`taskdock.exe`，不受影响。

## 7. 结论

**Dev 功能验收：通过。**

14 条最终 PASS 条件中，除「Release 安装包 / 正式性能基线」属 Release 专属范围外，授权一致性、
完成任务不重开、知识 revision 一致、REST 幂等不重复创建、文件导入事务内 fencing、Handoff
身份/状态/项目/版本覆盖、v82 独立脚本真实执行、全新库与升级库迁移、Rust/TS 检查、真实
CLI/MCP/REST/File 链路均已实际执行并记录。

证据路径：

- 交付提交：`c110711e9f6052d8d75276098fb812dc727375b7`（`main`；只包含本任务 agent_access / db 迁移登记 / 文档 / 验收脚本）
- 验收脚本：`scripts/acceptance-agent-access-v82.mjs`
- 52/52 运行：`tmp/acceptance/agent-access-v82-20261120-224854/`（`acceptance.log`、`summary.md`、`gui.log`）
- 单测：`src-tauri/src/agent_access/tests*.rs`、`src-tauri/src/db/mod.rs`
- 本报告：`docs/agent-workspace/v82-acceptance-report.md`

**提交后工作区**：其余未提交改动均属其他并行任务；本任务路径已全部提交。提交时 `db/mod.rs` 的
未暂存差异经复核只含 v82 的迁移 83/84 登记与迁移测试（协作中心迁移 85 已由其他会话先行提交，
未混入本次提交）。
