# MCP 规范

## 1. 传输

沿用既有二层结构（不改）：

```
MCP 客户端 ──stdio──▶ taskdock.exe --mcp-server ──HTTP 127.0.0.1──▶ 主进程 /mcp
                        （bridge token + agent token）                （统一服务层）
```

- 协议：JSON-RPC 2.0；版本协商 `2024-11-05` / `2025-06-18`（未知回退最老版本）。
- 已实现方法：`initialize`、`ping`、`notifications/*`、`tools/list`、`tools/call`。
  **v76 新增**：`resources/list`、`resources/read`、`prompts/list`、`prompts/get`。
  未实现的方法返回 `-32601`（客户端可降级），不伪造能力。
- HTTP 模式：不新增。stdio 足够覆盖 Claude Code / Codex / Cursor / Trae；引入 HTTP 传输会带来
  端口生命周期与会话管理复杂度，收益不匹配（见附录「为何不做」）。

## 2. Tools（v76 新增部分）

| 工具 | 读/写 | 能力 | 说明 |
|---|---|---|---|
| `taskdock_get_project_status` | 读 | `projects.read` | 项目进度/功能计数/阻塞项 |
| `taskdock_list_plans` | 读 | `plans.read` | 按项目列出计划（里程碑+功能） |
| `taskdock_get_current_plan` | 读 | `plans.read` | 进行中项目的当前计划 |
| `taskdock_get_plan_details` | 读 | `plans.read` | 单项目完整计划（含步骤与活动） |
| `taskdock_create_knowledge` | 写 | `knowledge.write` | 新建文本知识文档 |
| `taskdock_update_knowledge` | 写 | `knowledge.write` | 需 `expected_revision` |
| `taskdock_get_knowledge` | 读 | `knowledge.read` | 知识文档详情（正文/分块/revision） |
| `taskdock_list_decisions` | 读 | `decisions.read` | 决策列表 |
| `taskdock_get_decision` | 读 | `decisions.read` | 决策详情 |
| `taskdock_create_decision` | 写 | `decisions.write` | 决策记录 |
| `taskdock_get_project_context` | 读 | `context.read` | 指定项目上下文 |
| `taskdock_get_relevant_context` | 读 | `context.read` | 按任务描述/查询装配 |
| `taskdock_get_recent_context` | 读 | `context.read` | 近期变更与活动 |
| `taskdock_create_handoff` | 写 | `handoffs.write` | 创建交接 |
| `taskdock_get_handoff` | 读 | `handoffs.read` | 交接详情 |
| `taskdock_list_handoffs` | 读 | `handoffs.read` | 待接收/进行中/已完成 |
| `taskdock_submit_work_report` | 写 | `handoffs.write` | 工作报告 |
| `taskdock_complete_task` | 写 | `tasks.write` | 先读任务 JSON 的 `revision`，作为 `expected_revision` 提交 |
| `taskdock_search` | 读 | `projects.read` + 对应 read 能力 | 跨任务/知识/决策检索 |
| `taskdock_agent_registry` | 读 | `workspace.read` | 已注册 Agent、scope、最近访问 |
| `taskdock_agent_activity` | 读 | `workspace.read` | 四入口统一活动日志 |

共 **21** 个新工具。注册方式：`mcp::tools::tool_defs()` 追加，`call()` 命中 `is_owned` 后走
`agent_access::mcp_tools::call`。全部注册为 `write: false`，由 service 自己开短事务，避免与 MCP
外层写事务嵌套；授权、版本、审计仍在统一层完成。

已有工具（规划 18 个 + 任务/笔记/工作流/文件工作区/知识/Skill）保持不变，语义与授权不变。
其中 `taskdock_create_task` / `taskdock_update_task` 返回的任务 JSON 也包含 `revision`，并在同一
事务内写入 `agent_activity_logs`（`interface=mcp`），与 CLI/REST/文件入口共用版本与审计口径。

上下文工具 `taskdock_get_project_context` 与 `taskdock_get_relevant_context` 可传
`format: "compact_json"` 只返回单行 JSON 文本，或传 `format: "markdown"` 只返回 Markdown 文本。
省略格式时继续返回含 Markdown 的结构化 JSON。

项目任务操作使用项目根 ID，可兼容解析其计划 ID。任务工具有以下可选参数和新增工具：

- `taskdock_list_tasks` 传 `project_id` 时支持 `limit` 与 `offset`，返回 `{items, page}`。
  省略项目时保留原任务数组响应。
- `taskdock_create_task` 传 `project_id` 时，任务与项目关联同事务提交。
- `taskdock_link_project_task` 与 `taskdock_unlink_project_task` 接收 `project_id` 和 `task_id`，
  返回归一化项目 ID、任务 ID 和关系状态 `linked`。重复请求同一状态为幂等。
- Breaking Change: No。原调用保留，新增模式要求项目和任务两道权限，重放时也会重新核验。

## 3. Resources（只读，按需读取）

| URI | 内容 | 分页 |
|---|---|---|
| `taskdock://manifest` | 工作空间 manifest（协议/接口/能力） | 否 |
| `taskdock://projects` | 项目列表摘要 | 否（≤50） |
| `taskdock://projects/{id}` | 项目详情 | 否 |
| `taskdock://projects/{id}/context` | 该项目上下文（Markdown） | 否（受预算限制） |
| `taskdock://tasks` | 任务快照（≤200，含 pending/completed，含 `revision`） | 否 |
| `taskdock://plans/current` | 当前计划 | 否 |
| `taskdock://knowledge/index` | 知识库与文档索引（≤200） | 否 |
| `taskdock://decisions` | 决策列表（≤100） | 否 |
| `taskdock://agents/sessions` | 当日/近期接口会话摘要 | 否 |
| `taskdock://context/current` | 最近装配的上下文 | 否 |

`resources/read` 返回 `{contents:[{uri, mimeType, text}]}`；资源必须**按需**生成（不缓存全量、
不一次加载整库）。授权按对应 read 能力；无能力返回 `-32002`。

## 4. Prompts（可复用模板）

| 名称 | 参数 | 用途 |
|---|---|---|
| `understand_project` | `project_id`（必填） | 读取项目状态与上下文，输出理解摘要与待确认问题 |
| `continue_previous_work` | `handoff_id`（必填） | 读取最近交接/报告/活动，给出续做步骤 |
| `prepare_development_context` | `task`（必填）、`project_id`（可选） | 装配实现所需上下文（任务/规划/决策/约束） |
| `review_architecture_decision` | `decision_id`（必填） | 审阅决策记录，列出风险与替代方案 |
| `submit_work_handoff` | `to_agent_id`、`summary`（必填） | 按模板填写完成项/待办/风险/下一步 |

`prompts/get` 返回 `messages`（role=user 的模板文本），不包含任何密钥或默认自动执行指令。

## 5. 错误码

| 码 | 含义 |
|---|---|
| `-32700` / `-32600` / `-32601` / `-32602` | JSON-RPC 标准 |
| `-32000` | TaskDock 未运行 / MCP 未启用 / 传输失败（可重试） |
| `-32001` | agent token 缺失/无效/已撤销 |
| `-32002` | scope 或能力不足 |

业务失败（校验/冲突/未找到）以 `isError:true` 的 tool result 返回，附 `code` 与 `details`，
与既有工具一致。

## 6. 为何不引入 MCP SDK

现有实现已覆盖 tools 的完整语义（含 idempotency、审计、双层凭据）且经过测试；引入 SDK 会带来
新的依赖树、异步 runtime 与传输层抽象，收益不足。v76 只按规范补齐 resources/prompts 两种方法，
协议封套与错误码沿用既有实现。

## 7. 真实客户端验收记录（2026-11-18）

使用 `task-dock.exe --mcp-server` 作为真实 stdio 子进程，`TASKDOCK_MCP_TOKEN=…` 指向测试 Agent
`smoke-rest`，transport 文件由无头测试实例生成。结果：

- `initialize` 返回 `protocolVersion=2025-06-18`、`serverInfo=task-dock/0.5.0`；`tools/list` 94 个、
  `resources/list` 10 个、`prompts/list` 5 个。
- `resources/read taskdock://manifest`：`capabilities` 16 项（与 `mcp_agent_capabilities` 授权一致），
  `interfaces.mcp=true`、`rest=true`。
- `tools/call taskdock_create_task` → 任务 `d794e49f-…`，`revision=1`；`taskdock_get_task` 返回同一
  `revision=1`；`taskdock_complete_task(expected_revision=1)` → `revision=2`、`status=completed`。
- `taskdock_agent_activity(interface=mcp)` 返回 `task.create` 与 `task.complete` 两条，`agent_id=smoke-rest`。
- `smoke-readonly` 调用 `taskdock_create_task` → JSON-RPC `-32002`（scope=readonly 拒绝写）。
- 缺 `TASKDOCK_MCP_TOKEN` → 修复后返回 `-32001`（此前误归类为可重试 `-32000`）；未知工具 → `-32602`。
- 任务写工具此前不返回 `revision`、不写 `agent_activity_logs`；manifest 硬编码 12 项能力。均已在
  本轮修复，详见 [test-plan.md](test-plan.md) §11 与 [acceptance-report.md](acceptance-report.md) §11。

**限制**：上述 MCP 验收运行在 `TASKDOCK_TEST_HEADLESS=1` 下，绕过了主窗口栈溢出；正常桌面启动
仍未通过，不能据此宣称 UI/安装包验收通过。

## `taskdock_create_project`（2026-11-21 收敛）

- 授权：`scope=project_rw` **且** 显式持有 `projects.create`；缺一即 `AUTHZ`，不再「有 scope 就能建」；
- 入参：`name`（必填）、`kind`、`description`、`goal`、`template_id`、`root_path`、`target_date`、
  `requestId`；`root_path` 只登记已有目录（不存在登记为离线），**不创建目录**；
- 返回（破坏性修正）：`id` 从「计划 ID」改为**项目根 ID**，并新增
  `projectId` / `planId` / `activePlanId` / `project` / `activePlan` / `workspace` / `provisioningStatus`；
- 授权：创建者只获得刚创建项目根的 grant（`mcp_agent_grants.project_id` v91 外键指向项目根）；
- 幂等：`requestId` 命中同一摘要时返回原结果，参数不同返回冲突；审计 entity 指向项目根。
