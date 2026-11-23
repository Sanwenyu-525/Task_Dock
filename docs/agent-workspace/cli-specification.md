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

taskdock agent registry [--json]       # 已注册 Agent 列表（别名：agent list）
taskdock agent activity [--agent <id>] [--interface cli|mcp|rest|file] [--limit N] [--json]
taskdock agent handoff list [--status pending|accepted|completed] [--project <id>] [--json]
taskdock agent handoff get <handoff_id> [--json]
taskdock agent handoff create --to <agent_id> --summary S [--task-id <id>] [--project <id>]
                              [--completed-file f] [--pending-file f] [--next-file f] [--json]
taskdock agent handoff accept <handoff_id> --base-revision N [--json]
taskdock agent handoff reject <handoff_id> --base-revision N --reason <文本> [--json]
taskdock agent handoff complete <handoff_id> --base-revision N [--json]
taskdock agent report create --summary S --result completed|partial|blocked|failed
                              [--handoff <id>] [--task-id <id>] [--json]
taskdock agent report list [--agent <id>] [--handoff <id>] [--json]

taskdock search <keyword> [--kind task|knowledge|decision|project] [--limit N] [--json]

taskdock sync status [--json]
taskdock sync init [--path <绝对目录>] [--name <名称>] [--json]
taskdock sync export [--json]         # 立即导出脏资源（别名：sync push）
taskdock sync scan [--json]           # 扫描可导入目录并导入（别名：sync pull）
taskdock sync conflicts [--json]
taskdock sync resolve <conflict_id> --resolution db|file|dismiss [--json]
```

> v81 对齐说明：旧文档里的 `sync pull` / `sync push` / `agent list` / `--action keep-db|keep-file`
> 与实现漂移，现已统一到上表的真实命令；旧写法保留**兼容别名**（`pull`→`scan`、`push`→`export`、
> `list`→`registry`、`--action keep-db|keep-file|dismiss`→`--resolution db|file|dismiss`）。
> 冲突解决方式与 UI / REST 完全一致：`db` / `file` / `dismiss`。

## 3.1 命令注册表与文档契约（v81）

- `taskdock task list --project <id> --limit 20 --offset 0 --json` 查询项目内可读任务。
- `taskdock task create --title "…" --project <id> --json` 在同一事务创建任务并关联项目。
- `taskdock task link <task_id> --project <id>` 与 `taskdock task unlink <task_id> --project <id>`
  修改关系，解绑保留任务。项目参数接受项目根 ID 或暂可解析到项目根的计划 ID。
- Breaking Change: Yes（同步命令授权收紧）。`sync init`、`sync export/push` 仅供本机用户，
  带 Agent 凭据的 `sync status`、`sync conflicts` 需要全局 `projects.read`。

- `agent_access::cli::COMMANDS` 是命令真源（命令组、子命令、说明）；
- `describe_cli_commands()` 输出人类可读清单（诊断/帮助用）；
- `check_cli_documentation_contract(USAGE)` 校验帮助文本覆盖注册表，缺命令即失败（有单测锁定）；
- `validate_cli_arguments()` 在解析后检查残留 `--xxx`：未知参数 → `USAGE`（退出码 2），
  不再静默忽略拼错的参数。

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
- Agent 可用 `taskdock context get --task-id <id> --format compact_json --budget 1500 --json`。
  这会保留 JSON 信封和结构化上下文，省略 Markdown 并使用单行 JSON。只阅读文本时可使用
  `--format markdown` 并省略 `--json`。

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

## `taskdock project create`（2026-11-21）

```text
taskdock project create --name <名称> [--kind general] [--description ...] [--goal ...]
                        [--target-date YYYY-MM-DD] [--template ID]
                        [--root <绝对目录>]
                        [--dir-mode metadata_only|attach_existing|create_new]
                        [--request-id ID] [--json]
```

- 身份：本机人类（默认）或 `TASKDOCK_AGENT_TOKEN`；Agent 身份必须有 `projects.create`
  （全局能力）且 scope=`project_rw`，否则返回 `FORBIDDEN`；
- `--dir-mode` 缺省：给了 `--root` 按 `attach_existing`，否则 `metadata_only`；
  `create_new` 必须显式指定，父目录必须存在、目标必须不存在；
- 输出（`--json`）：`{ created, project{id,...}, activePlan{id,...}, workspace{...}, provisioningStatus }`；
- 幂等：`--request-id` 相同且参数相同返回原结果（`created=false`），参数不同返回 `CONFLICT`；
- Agent 创建成功后自动获得**该项目根**的授权，不扩大为全局。
