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
| `taskdock_complete_task` | 写 | `tasks.write` | 需 `expected_revision` |
| `taskdock_search` | 读 | `projects.read` + 对应 read 能力 | 跨任务/知识/决策检索 |
| `taskdock_agent_registry` | 读 | `workspace.read` | 已注册 Agent、scope、最近访问 |
| `taskdock_agent_activity` | 读 | `workspace.read` | 四入口统一活动日志 |

共 **21** 个新工具。注册方式：`mcp::tools::tool_defs()` 追加，`call()` 命中 `is_owned` 后走
`agent_access::mcp_tools::call`。全部注册为 `write: false`，由 service 自己开短事务，避免与 MCP
外层写事务嵌套；授权、版本、审计仍在统一层完成。

已有工具（规划 18 个 + 任务/笔记/工作流/文件工作区/知识/Skill）保持不变，语义与授权不变。

## 3. Resources（只读，按需读取）

| URI | 内容 | 分页 |
|---|---|---|
| `taskdock://manifest` | 工作空间 manifest（协议/接口/能力） | 否 |
| `taskdock://projects` | 项目列表摘要 | 否（≤50） |
| `taskdock://projects/{id}` | 项目详情 | 否 |
| `taskdock://projects/{id}/context` | 该项目上下文（Markdown） | 否（受预算限制） |
| `taskdock://tasks` | 任务摘要（默认 pending，≤100） | 否 |
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
| `understand_project` | `project_id` | 读取项目状态与上下文，输出理解摘要与待确认问题 |
| `continue_previous_work` | `project_id`、`agent_id?` | 读取最近交接/报告/活动，给出续做步骤 |
| `prepare_development_context` | `task` 或 `task_id` | 装配实现所需上下文（任务/规划/决策/约束） |
| `review_architecture_decision` | `decision_id` 或 `project_id` | 审阅决策记录，列出风险与替代方案 |
| `submit_work_handoff` | `handoff_id` | 按模板填写完成项/待办/风险/下一步 |

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
