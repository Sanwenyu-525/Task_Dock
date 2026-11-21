# 交接协议（Handoff）

## 1. 数据结构

```json
{
  "handoff_id": "uuid",
  "project_id": "",
  "project_kind": "none|planning|workspace",
  "task_id": null,
  "from_agent": "agent-a",
  "to_agent": "agent-b",
  "status": "pending|accepted|rejected|completed|cancelled",
  "summary": "工作总结",
  "completed_items": [],
  "pending_items": [],
  "decisions": [{"title":"…","decision_id":"…"}],
  "files_changed": ["src/…"],
  "risks": [],
  "next_steps": [],
  "revision": 1,
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

字段约束：
- `summary` ≤ 2000 字符；各数组 ≤ 50 项，单项 ≤ 500 字符；`files_changed` 只存相对路径。
- `from_agent` 必须是当前身份（不可伪造）；`to_agent` 必须是已注册 `agent_id`（`assign_handoff_target`）。
- 同一 `(from, to, task_id)` 存在未完成交接时，重复创建返回已存在的那条（幂等），不产生并行覆盖。

## 2. 状态机

```
pending ──accept──▶ accepted ──complete──▶ completed
   │                    │
   └──reject──▶ rejected└──cancel（创建方）──▶ cancelled
```

- 只有 `to_agent`（或被授予 `handoffs.write` 的同一身份）能 `accept/reject`。
- `completed` 必须带 `report_id`（完成时提交工作报告）或显式 `summary`。
- 任何状态变更写 `agent_resource_revisions`（kind=handoff）+ 审计；`revision` +1。
- 终态（completed/rejected/cancelled）不可再改状态，只能追加报告。

## 3. 工作报告

```json
{
  "report_id": "uuid",
  "handoff_id": "…",
  "project_id": "…",
  "task_id": "…",
  "agent_id": "agent-b",
  "result": "completed|partial|blocked|failed",
  "summary": "…",
  "completed_items": [], "pending_items": [],
  "files_changed": [], "evidence": [], "risks": [],
  "created_at": "ISO-8601"
}
```

- `evidence` 只放可复核信息（命令、退出码、路径、截图文件名），不放原始日志正文。
- 报告不可修改（追加式），需要更正时提交新报告并在 summary 说明。

## 4. 方法映射

| 职责 | 实现 |
|---|---|
| `create_agent_handoff` | `handoff::create` |
| `validate_handoff_payload` | `handoff::validate` |
| `assign_handoff_target` | `handoff::assign`（校验注册身份是否存在/未撤销） |
| `list_pending_handoffs` | `handoff::list(status=pending)` |
| `get_handoff_details` | `handoff::get` |
| `accept_handoff` / `reject_handoff` / `complete_handoff` | `handoff::set_status` |
| `submit_agent_work_report` | `handoff::submit_report` |
| `record_agent_activity` | `store::activity` |

## 5. 多 Agent 冲突控制

- 交接创建/接受/完成都要求 `base_revision`；不一致 → `CONFLICT` 并返回当前 revision。
- 一条交接同一时刻只属于一个 `to_agent`；转交需先 `cancel` 再新建（保留历史）。
- 两个 Agent 同时 `accept`：后到者收到 409（首个成功者推进 revision）。
- 交接与任务的关系是弱引用：任务被删除不删除交接（`task_id` 保留用于追溯）。

## 6. 操作者身份约束（v81 修订）

状态机之外新增**操作者**约束，统一在 `handoff::authorize_handoff_transition()` 生效
（`transition()` 在写库前调用，`accept/reject/complete` 共用）：

| 迁移 | 允许的操作者 |
|---|---|
| pending → accepted | 目标 Agent，或本机协调者（`LocalHuman`） |
| pending → rejected | 目标 Agent，或本机协调者 |
| accepted → completed | 目标 Agent，或本机协调者 |
| → cancelled | 创建方，或本机协调者 |
| 其他 | 一律拒绝（`FORBIDDEN`） |

范围约束：
- 读/写交接按**项目范围**判定（`HandoffsRead/Write` + `resource_id=project_id`）；
  项目为空的交接只对全局授权可见。
- 工作报告必须挂到**可访问**的交接上；报告项目与交接项目不一致时拒绝；
- 报告不写空项目绕过范围限制。

## 7. 按授权范围发现交接（2026-11-21）

CLI `agent handoff list`、MCP `taskdock_list_handoffs` 与 REST
`GET /api/v1/agents/handoffs` 共用 `handoff::list_handoffs`：

- 省略项目筛选时，项目级 `handoffs.read` 返回全部已授权项目的交接；不再要求全局授权。
- 项目范围、状态筛选都在 SQL 分页前应用，`total` 只统计可见记录。
- 显式指定未授权项目（包括空项目）仍返回 `FORBIDDEN`；无项目交接仅全局授权或本机身份可读。
- 每次请求重新读取授权，禁用或撤销立即生效；`projects.read`、`handoffs.write` 不替代读取权限。
- 文件导入身份必须显式持有 `handoffs.read`，且不能超出导入授权项目；绑定 Agent 时复核其有效权限。

兼容性：Breaking Change: No（已授权客户端的请求参数与响应结构不变；项目级发现由拒绝变为受限列表）。
文件导入列表原先跳过鉴权的行为被修复；缺少读取授权的调用现在被拒绝。
无数据库迁移，不改变交接状态迁移和写入权限。
