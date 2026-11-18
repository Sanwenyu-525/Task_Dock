# CLI 规范（`taskdock`）

## 1. 分发与安装

- 独立 console 可执行文件 `taskdock.exe`（Cargo bin 目标，链接同一 `task_dock_lib`）。
- 直接打开同一个 SQLite 文件（`%APPDATA%\com.taskdock.desktop\task-dock.db`，可用
  `TASK_DOCK_DATA_DIR` 覆盖），调用**统一服务层**，不复制业务逻辑。
- 不依赖 TaskDock UI 是否打开；UI 打开时并发写入由 WAL + `busy_timeout=5s` 处理。
- PATH：把 `taskdock.exe` 所在目录加入用户 PATH；UI「Agent 接入」页显示实际路径并给出复制命令。
- 版本检查：`taskdock info` 输出版本、协议版本、schema 版本、数据库路径、工作空间路径。

## 2. 身份与权限

| 情形 | 身份 | 权限 |
|---|---|---|
| 无 `TASKDOCK_AGENT_TOKEN` | `local`（本机用户） | 读 + 写（等价 UI），全量审计，`actor_kind=local` |
| 有 token | `agent`（`mcp_agents` 行） | 按能力授权；无能力即拒绝 |
| `TASKDOCK_CLI_READONLY=1` | 任意 | 强制只读（写命令返回 `FORBIDDEN`） |

Token 从环境变量读取（不落 argv，避免进程列表泄露）；`--token-stdin` 可选。

## 3. 命令

```
taskdock status                     # 接口/工作空间/数据库/版本总览
taskdock info                       # 版本、路径、协议、schema

taskdock project list [--json] [--limit N] [--offset N] [--fields a,b]
taskdock project get <project_id> [--json]
taskdock project current [--json]

taskdock task list [--status pending|completed|all] [--view today|week|overdue|all]
                   [--category X] [--tag Y] [--priority 0-3] [--search Q]
                   [--limit N] [--offset N] [--fields a,b] [--json]
taskdock task get <task_id> [--json]
taskdock task create --title <t> [--description D] [--priority N] [--category C]
                     [--tags a,b] [--due <ISO>] [--json]
taskdock task update <task_id> --base-revision N [--title T] [--description D] [--priority N]
                     [--status pending|completed] [--due <ISO>|null] [--json]
taskdock task complete <task_id> [--base-revision N] [--json]
taskdock task search <keyword> [--limit N] [--json]

taskdock plan list [--project <id>] [--json]
taskdock plan current [--json]
taskdock plan get <project_id> [--json]

taskdock knowledge search <query> [--kb <id[,id]>] [--limit N] [--offset N] [--json]
taskdock knowledge get <document_id> [--json]
taskdock knowledge create --title T --content-file <path> [--kb <id>] [--json]
taskdock knowledge update <document_id> --base-revision N [--title T] [--content-file <path>] [--json]

taskdock decision list [--project <id>] [--status accepted] [--json]
taskdock decision get <decision_id> [--json]
taskdock decision create --title T --decision-file <path> [--context-file <path>]
                         [--project <id>] [--tags a,b] [--status proposed|accepted] [--json]

taskdock context get [--project <id>] [--task <id>] [--query Q] [--budget N]
                     [--format markdown|json] [--json]
taskdock context get --project <id>
taskdock context search <query> [--budget N] [--json]
taskdock context export --format markdown|json [--out <path>]

taskdock agent list [--json]
taskdock agent register --agent-id <id> --name <name> [--vendor V] [--json]   # 需 local
taskdock agent handoff list [--status pending|accepted|completed] [--json]
taskdock agent handoff get <handoff_id> [--json]
taskdock agent handoff create --to <agent_id> --summary S [--task <id>] [--project <id>]
                              [--completed-file f] [--pending-file f] [--next-file f] [--json]
taskdock agent report submit --summary S --result completed|partial|blocked|failed
                              [--handoff <id>] [--task <id>] [--json]

taskdock search <keyword> [--kinds task,project,plan,knowledge,decision] [--limit N] [--json]

taskdock sync status [--json]
taskdock sync pull [--json]          # 扫描可导入目录并导入（需写能力）
taskdock sync push [--json]          # 立即导出脏资源
taskdock sync conflicts [--json]
taskdock sync resolve <conflict_id> --action keep-db|keep-file|dismiss [--force] [--json]
```

## 4. 输出协议

`--json`（或 `TASKDOCK_CLI_JSON=1`）时 stdout **只有**一个 JSON 对象：

```json
{
  "success": true,
  "data": {},
  "error": null,
  "meta": {
    "request_id": "cli-<uuid>",
    "timestamp": "2026-11-18T09:00:00+00:00",
    "schema_version": "1.0",
    "interface": "cli",
    "actor": "local",
    "agent_id": null,
    "pagination": {"limit": 20, "offset": 0, "total": 42, "has_more": true}
  }
}
```

失败：

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "NOT_FOUND",
    "message": "任务不存在",
    "details": {"resource_kind": "task", "resource_id": "…"},
    "retryable": false
  },
  "meta": { "…": "…" }
}
```

- stdout 只输出结果；诊断、进度、警告一律 stderr。
- 分页：`meta.pagination`；`limit` 默认 20，上限 200；`offset` 上限 10000。
- 字段筛选：`--fields title,status,due_at`（逗号分隔，未知字段报 `VALIDATION`）。
- 非 `--json`：人类可读表格/段落；空结果输出 `（无结果）`。

## 5. 退出码

| 码 | 含义 | 典型错误码 |
|---|---|---|
| 0 | 成功 | — |
| 2 | 用法错误 | `USAGE` |
| 3 | 资源不存在 | `NOT_FOUND` |
| 4 | 校验失败 | `VALIDATION` / `SCHEMA_MISMATCH` |
| 5 | 版本冲突 | `CONFLICT` |
| 6 | 未认证/无权限 | `UNAUTHORIZED` / `FORBIDDEN` |
| 7 | 服务不可用（数据库占用/未初始化） | `UNAVAILABLE` |
| 8 | 内部错误 | `INTERNAL` |

## 6. 错误与并发

- 所有写命令必须给 `--base-revision`（`task create` 除外）；缺失 → `VALIDATION`。
- `task get` / `task list` 的 JSON 均返回 `revision`（与 REST/MCP 同一有效版本口径：
  `agent_resource_revisions` 计数器 + 业务 `updated_at`），可直接作为下一次写的 `--base-revision`。
- 冲突时 stderr 打印当前 revision 与更新时间，退出码 5；脚本可重新 `get` 后重试。
- 并发安全：CLI 每次调用独立开库，写事务短；同一秒内多次写入串行化，不缓存跨进程状态。

## 7. 与 UI 的一致性

CLI 写成功后，UI 通过既有事件机制刷新（CLI 是独立进程，无法 emit Tauri 事件 → UI 在
`agent-activity` 轮询/页面激活时刷新；文档明确该限制，不做假实时）。
