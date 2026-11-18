# 代码审计（开发前，2026-11-18）

审计对象：`D:\Develop\task_dock` 当前工作树（`main`，含其他任务的在途改动，本次只读不改）。
方法：读迁移 DDL、既有服务层 `*_impl`、MCP 模块、能力中心、设置白名单与实际命令注册表。

## 1. 已有能力

| 领域 | 现状 | 位置 |
|---|---|---|
| SQLite | 单写连接 + 3 只读连接池、WAL、`busy_timeout=5s`、迁移列表 `MIGRATIONS` 当前 **v75** | `src-tauri/src/db/mod.rs` |
| 任务 | `tasks` 表（标题/描述/优先级/状态/分类/标签/时间/重复规则）、筛选、统计、完成事件 | `db/mod.rs`、`commands/tasks.rs` |
| 项目（两类） | `planning_projects`（规划中心）与 `workspace_projects`（项目工作空间） | 同上 + `commands/project_workspace.rs` |
| 规划 | 里程碑 / 功能 / 步骤 / 活动流，含 `revision` 乐观并发 | `commands/planning.rs`、`mcp/tools.rs` |
| 知识库 | `knowledge_bases` / `knowledge_documents` / `knowledge_chunks` / `knowledge_links`，分块检索、导入、重建索引 | `capability/schema.rs`、`capability/knowledge.rs` |
| Skill | `capability_skills`（发现/导入/作用域/风险等级） | 同上 |
| MCP（对外） | 同二进制 `--mcp-server` stdio → loopback `/mcp` 桥（Bearer + agent token 双层），工具集已覆盖规划/任务/笔记/工作流/文件工作区/知识 | `mcp/*` |
| Agent 身份 | `mcp_agents`（token 仅存 SHA-256、scope=disabled/readonly/project_rw、撤销即时生效）、`mcp_agent_grants`（项目级写授权）、能力表（tasks/notes/workflows/workspace/knowledge/skills） | `mcp/auth.rs`、`mcp/permissions.rs` |
| 审计 | `mcp_audit_log`（动作/对象/身份/request_id/成功/授权/脱敏摘要/幂等结果） | `mcp/audit.rs` |
| 诊断 | `diagnostics` 模块、MCP 诊断、资源/磁盘检查 | `diagnostics/`、`mcp/diagnostics.rs` |
| 设置 | `Settings` + `ALLOWED_KEYS` 白名单 + 逐键校验 | `db/mod.rs`、`commands/settings.rs` |
| 无头入口 | `task-dock.exe --agentctl`（scan/install/verify/…，直接开库） | `lib.rs::agentctl` |
| UI | 能力中心五页（知识/Skill/MCP/上下文/配方）、设置页 MCP 接入段 | `src/components/capability/`、`src/components/settings/McpAccessSection.tsx` |

## 2. 可直接复用的服务（不新建第二套）

- `commands::tasks::{list_tasks, create_task_inner, update_task_inner, task_stats_inner}`：任务读写与统计。
- `commands::planning::{list_projects_impl, load_project_tx, list_features_impl, load_feature_tx, ...}`：
  规划读；写走 `ProjectInput/FeatureInput` 与 revision 校验。
- `capability::knowledge::{search_impl, search_in_conn, create_text_impl, get_document_impl, ...}`：知识检索与写入。
- `mcp::{auth, permissions, audit}`：身份解析、能力授权、审计留痕（CLI/REST 复用同一套判定）。
- `agents::now_iso()`：统一 ISO-8601 时间。
- `AppError` / `AppError::code()`：统一错误到错误码/HTTP 状态映射。

## 3. 需要扩展的服务

| 扩展点 | 原因 | 方式 |
|---|---|---|
| `mcp_agent_capabilities.CHECK` | 现有能力白名单缺 `projects.read/plans.read/knowledge.write/decisions.*/context.read/handoffs.*` | 迁移 v76 重建表，保留原数据（同 v73/v75 模式） |
| `mcp_agents` | 缺「厂商 / 接入方式 / 说明」元数据 | 追加列（不重建） |
| `mcp/permissions.rs` | 能力枚举需与 CHECK 同步 | 追加枚举项与 `is_write` |
| MCP 协议层 | 只实现 `tools/*`，缺 `resources/*`、`prompts/*` | 在 `protocol.rs` 增加方法分发 |
| 设置 | 缺 Agent 工作空间路径、REST 开关/端口、监听开关 | `Settings` + `ALLOWED_KEYS` + `validate_setting` |
| 能力中心 UI | 缺接入/活动/交接/同步管理 | 新增 `AgentAccessSection` 子页，复用 `cap-*` 语义样式 |

## 4. 完全缺失的能力

- 文件投影 / 受控导入 / 同步索引 / 冲突记录（无任何实现）。
- 决策记录（ADR）：现存 `dev_acceptance_records` 是验收记录，语义不同。
- 交接（Handoff）与工作报告：现存 `dev_handoff_packs` 是「开发交接文档版本」，面向人，不含
  Agent 目标/状态/接收/完成生命周期；不复用，另建 `agent_handoffs`。
- 资源版本表（跨 UI/Agent 的统一 revision 计数器）。
- 上下文装配（Context Engine）：`capability_contexts` 只是「项目上下文配置 JSON」，不是检索装配器。
- CLI（面向 Agent 的查询/写入命令）、REST API、OpenAPI。
- Agent 活动日志（`mcp_audit_log` 只覆盖 MCP 工具，不含 CLI/REST/文件读写）。

## 5. 数据模型冲突与取舍

| 风险 | 结论 |
|---|---|
| `agent_sessions` 已存在（旁路观测的运行会话：`source_id`+`external_id`） | **不复用、不改名**。接口会话由 `agent_activity_logs.session_key` 聚合派生，避免语义冲突 |
| `agent_sources` / `agent_runs` 是「被观测的 Agent 运行」 | 与「接入 TaskDock 的身份」不同，身份仍以 `mcp_agents` 为唯一真源 |
| `dev_handoff_packs` 是人工交接文档 | 不扩展成 Agent 交接；新建 `agent_handoffs` |
| `capability_contexts` 是配置 | 不当作上下文产物；新建上下文访问日志 |
| 任务/知识/项目已有表 | **只加关联字段/关联表，不新建同类表**；决策/交接属新增语义，允许新表 |
| `mcp_audit_log` 字段面向 MCP | 不改造；新增 `agent_activity_logs` 覆盖四入口，MCP 仍写原表（双写仅元数据，无正文） |

## 6. 需要迁移的结构

- v76：能力表重建（扩展 CHECK）；`mcp_agents` 追加 `vendor` / `interface_hint` / `note`；
  新建 `agent_workspaces`、`agent_workspace_files`、`agent_resource_revisions`、`agent_decisions`、
  `agent_handoffs`、`agent_work_reports`、`agent_activity_logs`、`agent_sync_events`、
  `agent_sync_conflicts`、`agent_context_access_logs`、`agent_request_cache`。
- 不修改任何已发布迁移；不重建业务表；不改 `tasks`/`knowledge_*`/`planning_*` 的 DDL。

## 7. 安全风险（审计结论）

1. 现有 MCP 的 scope 只分「只读 / 项目读写」，缺少知识写、决策写、交接写等细粒度 → 本层补齐并默认拒绝。
2. 文件接口如果不做路径与 schema 校验，等价于「任意文件即命令」→ 必须限定目录、扩展名、信封 schema、
   大小上限，且导入内容一律视为不可信数据（不执行其中指令）。
3. 本地 loopback 端口可能被浏览器跨站访问 → REST 拒绝携带 `Origin` 的请求、不返回 CORS 头、
   强制 `Authorization` 头（不使用 Cookie）。
4. Token 明文绝不入库/入日志；审计只存摘要。
5. 远程访问不实现；设置项存在但只显示「未开放」。

## 8. 性能风险

- 1000 任务 / 10000 知识分块：投影必须分页写入、单次导出有文件数上限与耗时预算；
  检索走既有 LIKE + 分块索引，不引入向量库。
- 文件监听用**有界轮询 + 变更集**（默认 20s），不做 OS 级 hook，避免句柄泄漏与同步风暴。
- 所有循环可取消、有上限；写事务短、不跨 IO。
