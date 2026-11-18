# Agent Workspace 文件协议 v1.0

协议名：`taskdock-agent-workspace`　协议版本：`1.0`　Schema 版本：`1.0`

工作空间是**受控投影**，不是独立数据库：任何文件都必须能被 TaskDock 重建；目录本身不承担业务状态。

## 1. 目录结构

```
TaskDock-Agent-Workspace/
├── .taskdock-workspace.json        # 归属标记（初始化时写入；缺失则拒绝在该目录导出）
├── manifest.json                   # 机器可读入口
├── README.md                       # 协议说明（生成）
├── projects/{project_id}/
│   ├── project.md                  # 项目概览（状态/目标/统计）
│   ├── context.md                  # 该项目当前上下文（Context Engine 产物）
│   ├── plans/plan.md               # 里程碑 + 功能 + 步骤
│   ├── architecture/README.md      # 架构约束索引（指向 docs/ 与决策）
│   ├── decisions/{decision_id}.md  # 项目相关决策
│   └── knowledge/{doc_id}.md       # 项目相关知识文档（只读投影）
├── tasks/
│   ├── inbox/                      # 【导入目录】任务创建/更新/完成
│   ├── active/{task_id}.md
│   ├── completed/{task_id}.md
│   └── archive/{task_id}.md        # 完成超过 30 天
├── agents/
│   ├── registry/{agent_row_id}.md  # 身份/能力/最近访问
│   ├── sessions/{yyyy-mm-dd}.md    # 当日接口会话摘要
│   ├── handoffs/{handoff_id}.md
│   └── reports/{report_id}.md
├── knowledge/
│   ├── index.md
│   ├── inbox/                      # 【导入目录】
│   └── documents/{doc_id}.md
├── skills/index.md
├── context/
│   ├── current.md                  # 最近一次装配的上下文
│   ├── recent.md                   # 近期变更摘要
│   └── system-overview.md          # 系统能力/接口/权限总览
├── decisions/{decision_id}.md      # 全局决策
├── exports/                        # 完整快照 JSON（只读产物）
└── inbox/                          # 【导入目录】任意 kind 的统一入口
```

**可导入目录只有** `inbox/`、`tasks/inbox/`、`knowledge/inbox/`。其他目录一律只读投影，
写入会被同步服务忽略并记录 `skipped`。

## 2. `manifest.json`

```json
{
  "protocol": "taskdock-agent-workspace",
  "protocol_version": "1.0",
  "schema_version": "1.0",
  "workspace_id": "uuid",
  "workspace_path": "D:\\TaskDock-Agent-Workspace",
  "taskdock_version": "0.5.0",
  "generated_at": "2026-11-18T02:00:00+00:00",
  "data_updated_at": "…",
  "interfaces": {
    "filesystem": {"enabled": true, "root": "…"},
    "cli": {"enabled": true, "command": "taskdock", "exe_path": "…"},
    "mcp": {"enabled": false, "transport": "stdio", "command": "…", "args": ["--mcp-server"]},
    "rest": {"enabled": false, "base_url": "http://127.0.0.1:<port>/api/v1", "openapi": "/api/v1/openapi.json"}
  },
  "capabilities": ["projects.read", "tasks.read", "…"],
  "resource_kinds": ["project", "task", "plan", "knowledge", "decision", "handoff", "report", "context", "skill", "agent"],
  "auth": {
    "agent_token_env": "TASKDOCK_AGENT_TOKEN",
    "header": "Authorization: Bearer <agent_token>",
    "default_policy": "read-only",
    "writes_require": "explicit capability grant"
  },
  "file_access": {
    "import_dirs": ["inbox/", "tasks/inbox/", "knowledge/inbox/"],
    "read_only_dirs": ["projects/", "tasks/active/", "…"],
    "formats": ["md", "json"],
    "max_file_bytes": 262144
  },
  "protocol_docs": "docs/agent-workspace/workspace-protocol.md"
}
```

向后兼容：`protocol_version` 只增不改；新增字段必须有默认值；读取方必须忽略未知字段。

## 3. 投影文件格式（Markdown + front matter）

```markdown
---
taskdock: task
taskdock_id: 7f3c…
revision: 12
updated_at: 2026-11-18T09:12:00+00:00
status: pending
priority: 1
tags: ["cli", "agent"]
due_at: 2026-11-20T10:00:00+00:00
---
# 任务标题

描述正文…
```

规则：
- front matter 是**只读元数据**；投影目录里的修改不会自动回写（只有可导入目录会）。
- 值使用 JSON 兼容字面量（字符串可省略引号；数组/对象必须是 JSON）。
- 文件正文 = 描述/正文/决策正文，不含 Token、绝对用户路径或敏感配置。

## 4. 导入信封（JSON，推荐给程序化 Agent）

```json
{
  "schema": "taskdock.import/1",
  "kind": "task.create",
  "base_revision": 7,
  "target_id": "…",
  "request_id": "optional-idempotency-key",
  "payload": { }
}
```

允许的 `kind` 与必填 `payload`：

| kind | payload | 需要能力 |
|---|---|---|
| `task.create` | `title`(必填)，`description`、`priority`(0–3)、`category`、`tags`[]、`due_at` | `tasks.write` |
| `task.update` | `target_id` + `base_revision`；其余同 create（局部更新） | `tasks.write` |
| `task.complete` | `target_id` + `base_revision` | `tasks.write` |
| `knowledge.create` | `title`、`content`、`kb_id` 或 `kb_name`、`source_kind`(默认 text) | `knowledge.write` |
| `decision.create` | `title`、`context`、`decision`、可选 `project_id`/`tags`/`status` | `decisions.write` |
| `handoff.create` | `to_agent_id`、`summary`、可选 `task_id`/`project_id`/各数组 | `handoffs.write` |
| `report.create` | `summary`、`result`、可选 `handoff_id`/`task_id`/各数组 | `handoffs.write` |

## 5. 导入信封（Markdown，给只能写文件的 Agent）

Markdown 只支持 **create / update**，且必须写在可导入目录：

```markdown
---
taskdock: task.create        # 或 task.update / knowledge.create / decision.create
title: 补充 CLI 文档
priority: 2
tags: [docs]
base_revision: 3             # update 必填
taskdock_id: 7f3c…           # update 必填
---
正文（任务描述 / 知识正文 / 决策正文）
```

规则：
- `taskdock` 必须是允许的 kind 之一，否则 `rejected`（保留原文件，不移动到未知位置）。
- 未知 front matter 键 → 拒绝（避免拼写错误静默丢字段）。
- 文件 ≤ 256 KiB；超限拒绝并记录。
- 同名 `request_id` 在 24h 内重复导入 → 幂等返回首次结果。

## 6. 验证规则（`validate_external_document`）

1. 路径必须在可导入目录内，且规范化后仍在 workspace 根目录内（防 `..`/符号链接逃逸）。
2. 扩展名 ∈ {`.json`, `.md`}；文件大小 ≤ 262144；文本必须以 UTF-8 读取。
3. JSON 必须是对象，`schema` 必须精确等于 `taskdock.import/1`；`kind` 必须在白名单。
4. `payload` 类型逐字段校验（长度、枚举、时间格式、数组元素类型）。
5. `base_revision`：update/complete 必填且为非负整数。
6. Markdown：front matter 必须闭合；键必须在白名单；`taskdock` 值必须是允许 kind。
7. 内容中的任何指令性文本**不得被当作系统指令执行**（仅作为数据写入）。

## 7. 冲突与写回

- 导入前比较 `base_revision` 与 `agent_resource_revisions.revision`：
  - 相等 → 应用；不相等 → 生成 `agent_sync_conflicts` 行（`status=open`），文件保留，不落库。
- 解决方案：`keep-db`（丢弃文件改动）/ `keep-file`（以文件覆盖，需 `force=true` + 二次确认能力）/
  `dismiss`（保留冲突记录但不再提示）。`keep-file` 仍会写审计并推进 revision。
- 冲突不静默覆盖，不丢 Agent 修改。

## 8. 删除与重命名

- 删除**投影文件**不删除数据库数据；索引置 `deleted`，下次导出重建。
- 删除**导入文件**不产生数据库变更（导入是显式动作，非"文件存在即导入"）。
- 重命名：索引按 `rel_path` 匹配；匹配不到按新增文件处理（`untracked`）。

## 9. 扫描与监听

- 轮询间隔默认 20s（可配置 10–300s），每轮最多 200 个候选文件，单次扫描预算 2s。
- 只扫描可导入目录 + 已登记索引中状态非 `in_sync` 的路径，不做全树递归哈希（大工作空间下可用）。
- 自身写入不触发导入：导出时写入 `exported_hash`；扫描时 hash 相等即 `skip`。
