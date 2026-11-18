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
