# 测试计划

> 目标：用真实命令与真实数据验证四个入口（CLI / MCP / REST / 文件）共享同一套数据、同一套权限、
> 同一套版本与审计。**不以“代码存在”代替测试。**
> 未执行的项必须保留“未执行”，不得写“理论上通过”。

## 0. 测试环境与隔离

| 项 | 要求 |
|---|---|
| 数据目录 | 每轮测试设置独立 `TASK_DOCK_DATA_DIR`（如 `tmp/agent-workspace-test/data`），不得污染真实库 |
| 构建 | 必须从集成快照构建；本地开发检查走 `npm run cargo` / `npm run tauri`，禁止裸 `cargo` |
| 端口 | REST 默认 `47911`；测试前确认与 `47821/47822` 无冲突 |
| 账号 | 至少两个 Agent Token（A/B）与一个本机用户（无 Token CLI） |
| 证据 | 每条用例记录：命令、工作目录、退出码、耗时、关键输出、日志路径 |
| 清理 | 只清理本用例目录；不清理他人缓存与用户数据 |

## 1. 文件协议（Phase 1）

| # | 用例 | 步骤 | 期望 |
|---|---|---|---|
| F1 | 初始化共享空间 | `taskdock sync init --path <dir> --json` | 目录结构 + `.taskdock-workspace.json` + `manifest.json`；DB 记录 workspace |
| F2 | Manifest 内容 | `taskdock info --json` / 读取 `manifest.json` | protocol/version/workspace_id/interfaces/capabilities 完整 |
| F3 | 数据导出 | UI 创建任务后 `taskdock sync export` | `tasks/active/*.md` 出现该任务，内容含 revision |
| F4 | 外部合法写入 | 在 `tasks/inbox/` 放合法 `task.create` 信封，`taskdock sync scan` | 任务创建成功，文件归档 `_imported/`，审计 `source=file` |
| F5 | 非法格式拒绝 | 放缺少 `schema`/未知 `kind` 文件后 scan | 文件进入失败/冲突区，DB 不变，错误可读 |
| F6 | 版本冲突 | 先导出任务，再手改 `base_revision` 为旧值后 scan | 生成 `agent_sync_conflicts`，不静默覆盖 |
| F7 | 冲突解决 | `taskdock sync resolve <id> --resolution db|file` | 按选择应用，冲突关闭，revision 前进 |
| F8 | 重复同步 | 同一合法文件 scan 两次 | 第二次 skipped，不重复建任务 |
| F9 | 文件删除 | 删除导出的只读投影文件后 scan | 不回写数据库（删除不传播） |
| F10 | 大量文件 | 一次放入 200 个合法信封 | 单轮上限内全部处理，耗时/内存有记录；超出部分下一轮 |
| F11 | 防回环 | TaskDock 自身导出后立即 scan | `exported_hash` 判等跳过，不产生导入事件 |

## 2. CLI（Phase 2）

| # | 用例 | 命令 | 期望 |
|---|---|---|---|
| C1 | 独立启动 | 关闭 TaskDock UI 后 `taskdock status --json` | exit 0，stdout 只有信封 |
| C2 | 项目/任务查询 | `taskdock project list --json`、`taskdock task list --json` | 真实数据、分页字段正确 |
| C3 | 任务创建/完成 | `taskdock task create ...`、`taskdock task complete <id>` | 写入成功，UI 可见（重新打开） |
| C4 | 版本冲突 | `taskdock task update <id> --base-revision 0` | exit 5 / `CONFLICT`，返回当前 revision |
| C5 | 不存在的资源 | `taskdock task get does-not-exist` | exit 3 / `NOT_FOUND` |
| C6 | 无效参数 | `taskdock task create`（缺 title） | exit 2 / `VALIDATION`（用法错误），stderr 有说明 |
| C7 | 权限限制 | `TASKDOCK_CLI_READONLY=1 taskdock task create ...` | exit 6 / `FORBIDDEN` |
| C8 | Agent 身份 | `TASKDOCK_AGENT_TOKEN=<readonly> taskdock task create ...` | 按授权拒绝或允许 |
| C9 | 并发 | 并行 10 个 `task list --json` | 全部 exit 0，无 JSON 混杂 |
| C10 | 服务未启动 | DataDir 指向不存在库 | 明确错误（exit 7 / `UNAVAILABLE`），不 panic |

## 3. Context Engine（Phase 3）

| # | 用例 | 命令 | 期望 |
|---|---|---|---|
| X1 | 真实任务上下文 | `taskdock context get --project <id> --task "实现登录" --format markdown` | 含正确项目、相关任务、当前计划、决策、知识、约束 |
| X2 | JSON 结构 | 同上 `--format json` | 13 节对应字段齐全；每条有 source_id/kind/updated_at/relevance |
| X3 | 预算 | `--budget 1000` 与 `--budget 24000` | 输出长度受控，超预算被裁剪且有标记 |
| X4 | 去重 | 同一文档同时命中标题与正文 | 只出现一次 |
| X5 | 无权读取 | readonly Agent 未授权 `context.read` | exit 6 / `FORBIDDEN` |
| X6 | 访问记录 | 每次调用后查 `agent_context_access_logs` | 有记录、无正文、无 Token |

## 4. MCP（Phase 4）

| # | 用例 | 步骤 | 期望 |
|---|---|---|---|
| M1 | 工具注册 | `tools/list` | 包含 21 个新工具，无重名 |
| M2 | 参数校验 | `tools/call` 缺必填参数 | `-32602 INVALID_PARAMS` |
| M3 | 资源列表 | `resources/list` | 10 个 `taskdock://` 资源 |
| M4 | 资源读取 | `resources/read` `taskdock://projects/{id}` | 只返回该项目，不加载全库 |
| M5 | Prompts | `prompts/list`、`prompts/get` | 5 个模板；参数缺失报错；不偷偷写库 |
| M6 | 写入权限 | 只读 Agent 调 `taskdock_create_knowledge` | 拒绝（`FORBIDDEN`） |
| M7 | 版本冲突 | `taskdock_update_knowledge` 用旧 revision | 返回冲突与当前 revision |
| M8 | 非法请求 | 未知 method / 非对象 arguments | `-32601` / `-32602`，不崩溃 |
| M9 | 连接中断 | 杀掉 stdio 子进程后重启 | 主进程不受影响；无残留监听 |
| M10 | 真实客户端 | Claude Code / Codex / Cursor / Trae 任一 | 能读资源并创建任务 |

## 5. REST（Phase 5）

| # | 用例 | 命令/条件 | 期望 |
|---|---|---|---|
| R1 | 默认关闭 | 不开启设置直接请求 | 连接失败 |
| R2 | 认证 | `curl -H "Authorization: Bearer tdm_..."` | 200；错误 Token 401 |
| R3 | Origin 拒绝 | 带 `Origin: http://evil` | 403，无 CORS 头 |
| R4 | 越权 | readonly Token POST 任务 | 403 / `FORBIDDEN` |
| R5 | 分页 | `?limit=10&offset=20` | `page` 字段正确，不越界 |
| R6 | 限流 | 1 分钟 >120 次 | 429，带重试提示 |
| R7 | 幂等 | 同 `Idempotency-Key` 重放 POST | 返回首次结果，`replayed=true`，不重复写 |
| R8 | 并发修改 | 两个 Token 同时 PATCH 同资源 | 一个成功，一个 409，不静默覆盖 |
| R9 | OpenAPI | `GET /api/v1/openapi.json` | 与 `ROUTES` 一致，可被解析 |
| R10 | 超时 | 慢客户端保持连接 >20s | 服务端主动关闭，不占线程 |

## 6. 跨 Agent 协作（Phase 6/7）

| # | 用例 | 步骤 | 期望 |
|---|---|---|---|
| H1 | A 读上下文建任务 | Agent A `context get` → `task create` → `decision create` | 三项落库，活动日志 source=mcp |
| H2 | A 提交交接 | Agent A `handoff create --to B` | 状态 pending，B 可见 |
| H3 | B 接收并继续 | Agent B `handoff get` → `accept` → `task update` | revision 前进，交接 accepted |
| H4 | B 提交报告 | `report create --handoff <id>` | 报告只追加，不可改 |
| H5 | C 验收 | C 读报告与任务历史 → 记录验收结论 | UI 交接中心/活动页完整呈现 |
| H6 | 并发覆盖 | A/B 同时更新同一任务 | 后者收到冲突，不覆盖前者 |
| H7 | UI 一致性 | 以上步骤后打开能力中心「Agent 共享」 | 活动、交接、同步、权限与 DB 一致 |

## 7. 性能基线

数据规模：1000 任务、10000 知识文档、100 Agent 活动、10 并发读取、5 并发写入。

| # | 场景 | 指标 |
|---|---|---|
| P1 | `task list --json --limit 200` | p50/p95 耗时、内存峰值 |
| P2 | `knowledge search` 在 1 万文档 | p50/p95、SQLite 慢查询 |
| P3 | `context get` 预算 6000 | 装配耗时、返回 token |
| P4 | 10 并发 CLI 读取 | 全部成功、无锁超时 |
| P5 | 5 并发写入不同任务 | 全部成功；同任务写入产生冲突 |
| P6 | 200 文件同步 | 单轮耗时、内存、失败率 |

结论必须附：二进制 sha256、构建模式、数据目录、机器空闲状态、样本数与证据文件。

## 8. 执行记录（2026-11-18，CLI/文件链路首次真实运行）

环境：Windows 本机，`TASK_DOCK_DATA_DIR=tmp/agent-workspace-smoke`（隔离目录），
`TASK_DOCK_DATA_DIR/task-dock.db` 由空文件经迁移创建；CLI 为 dev 构建
`src-tauri/target/debug/taskdock.exe`，SHA256 `779FDE4842A8EEDCCE775D55804962781ABD4B9BF68AF62F7CD6004854290D05`。
UI 未运行，验证的是 CLI 独立进程 + 文件协议。

| 用例 | 结果 | 证据摘要 |
|---|---|---|
| F1 初始化共享空间 | 通过 | 生成 `.taskdock-workspace.json`、`manifest.json` 与 8 个投影文件；workspace_id `ws_c799972633e24001918d08c9fe8504a3` |
| F2 Manifest | 部分 | `manifest.json` 已生成；`taskdock info` 未单独执行 |
| F3 数据导出 | 通过（修复后） | `tasks/active/*.md` 生成；补 `revision` 字段后再次导出可见 `- revision: 1` |
| F4 外部合法写入 | 通过 | `inbox/import-1.json` → 创建任务 `b5e6e5ad-…`，源文件归档 `inbox/_imported/` |
| F5 非法格式拒绝 | 通过（修复后） | 缺 `task_id` 信封报 `payload 缺少非空字段 task_id`；文件归档 `inbox/_rejected/`，下一轮 `scanned=0` |
| F6 版本冲突 | 通过 | 旧 `base_revision=1` 更新已完成的 revision=2 任务 → `agent_sync_conflicts` 记录 `open`，未覆盖 |
| F7 冲突解决 | 部分 | `--resolution db` 成功，状态 `resolved_db`、`resolved_at` 写入；`file`/`dismiss` 未测 |
| F11 防回环 | 通过 | `sync export` 后立即 `sync scan`：`scanned=0, imported=0` |
| C1 独立启动 | 通过 | UI 未运行，`status --json` exit 0，stdout 仅信封 |
| C2 项目/任务查询 | 通过 | `task list` 返回 2 条与 `meta.pagination.total=2`；`project list` 空库返回 `[]` |
| C3 创建/完成 | 通过 | `task create` 成功；`task complete --base-revision 1` 成功并写 `completed_at` |
| C4 版本冲突 | 通过 | `--base-revision 99` → exit 5、`CONFLICT`，错误含当前 revision=1 |
| C5 不存在资源 | 通过 | `task get does-not-exist` → exit 3、`NOT_FOUND` |
| C6 无效参数 | 通过（修正期望） | 缺 `--title` → exit 2、`VALIDATION`（用法错误；原计划写 exit 4 与 CLI 规范冲突，已修正） |
| C7 只读限制 | 通过 | `TASKDOCK_CLI_READONLY=1 task create` → exit 6、`FORBIDDEN` |
| C10 数据库未初始化 | 通过 | 不存在的库 → exit 7、`UNAVAILABLE`，无 panic |
| X2 Context JSON | 通过 | 含 budget/items/markdown/recent_changes/scope 等字段；估算 427 tokens |
| H6 工作报告 | 通过 | `agent report create` 成功，返回 `revision=1` |
| H2/H3 交接 | 部分 | 未注册目标 Agent 被拒绝（`NOT_FOUND`）；完整交接流转未测 |

未执行：F8–F10、C8/C9、X1/X3–X6、M1–M10、R1–R10、H1/H4/H5/H7、P1–P6。
原因：MCP 需开启 `mcp_server_enabled` 并重启主程序、REST 需 UI 启动后开端口、性能需造 1000 任务/1 万文档数据集；
当前只完成 CLI 与文件协议的可重复冒烟。

### 8.1 本轮发现并已修复

1. `taskdock search <关键词>` 把关键词误当子命令 → 改为仅对含子命令的命令组吞位置参数。
2. 任务投影缺 `revision`，外部 Agent 无法取得 `base_revision` → 单任务 Markdown 增加 `revision`。
3. 非法信封留在 `inbox/` 每轮重复报错 → 归档到 `inbox/_rejected/`。

### 8.2 待处理的协议/实现偏差

- `task get` / `task list` 的 JSON 未返回 `revision`；调用方只能从冲突错误或投影文件获取。
- 文档表格写 `task.update` 用 `target_id`，实现要求 `payload.task_id`；Markdown `task.update` 尚未实现。

## 9. 执行记录（2026-11-18，REST / 身份 / 交接真实运行）

环境同 §8：隔离数据目录 `tmp/agent-workspace-smoke`；桌面 dev 二进制
`src-tauri/target/debug/task-dock.exe`，SHA256 `E7675DA9E6C0E5F25D16687C9104A88913DFFD282F77E4EABD0FE4266A75A2E8`；
CLI `taskdock.exe` SHA256 `D8CB89951586C0493D2B2318A15455422E2A437BBFAD74B596DA1E3648013221`。
REST 仅监听 `127.0.0.1:47911`。测试 Agent 为 `smoke-rest`（scope `project_rw`，16 能力）与
`smoke-readonly`（scope `readonly`，仅 `tasks.read`），Token 仅存 SHA-256，未写入本文件。

| 用例 | 结果 | 证据摘要 |
|---|---|---|
| R1 认证拒绝 | 通过 | 无 `Authorization` / 错误 Token → 401；未认证 OpenAPI → 401；带外部 `Origin` → 403 |
| R2 状态与身份 | 通过 | `/status` 200，`meta.actor=agent`、`agent_id=smoke-rest`、`interface=rest`；`interfaces.mcp=true` |
| R3 列表分页 | 通过 | `?limit=1&offset=1` → 200，`meta.pagination.total=2`、`limit=1`、`offset=1`、`has_more=false`，仅 1 条 |
| R4 详情路由 | 通过（修复后） | `GET /tasks/<id>` → 200；修复前误取 `seg(0)` 得到 `tasks` 并返回 `NOT_FOUND` |
| R5 创建与幂等 | 通过 | `Idempotency-Key: smoke-key-1` 首次创建 `70f056d7-…`；同 key 重放同一 id 且 `meta.replayed=true` |
| R6 版本更新 | 通过（修复后） | `PATCH` body `base_revision=1` → 200，标题更新；再次提交 `base_revision=1` → 409 `CONFLICT`，提示当前 revision=2 |
| R7 只读拒绝 | 通过 | `GET /tasks` → 200；`POST /tasks` → 403 `FORBIDDEN`（`scope=readonly`） |
| R8 Token 撤销 | 通过 | 写 `revoked_at` 后同一 Token → 401；恢复后不再测试 |
| R9 请求体上限 | 通过 | 1.1 MiB body → 413 `VALIDATION`（`body 超过 1MiB`） |
| R10 限流 | 通过 | 连续请求第 121 次 → 429 `RATE_LIMITED`（120 次/分） |
| R11 OpenAPI | 通过 | 认证后 200，`openapi=3.0.3`，`paths` 30 条 |
| H2/H3 交接流转 | 通过（自身闭环） | `smoke-rest → smoke-rest`：create rev1 → accept rev2 → complete rev3，`status=completed`，`accepted_at`/`completed_at` 均写入 |
| H3 越权接收 | 通过 | `smoke-rest` 接收目标为 `smoke-readonly` 的交接 → `VALIDATION`，未改变状态 |
| H6 工作报告 | 通过 | `agent report create --handoff …` 成功，返回 `revision=1`；列表 total=2 |
| 活动审计 | 通过 | `agent activity --interface rest` 可见 `task.create`、`task.update`、`rest.failed`，身份与入口正确 |

**REST 未通过/未执行**：REST 任务详情/列表响应仍不含 `revision` 字段，外部 Agent 无法仅靠 REST 取
`base_revision`（当前需读 workspace 投影或从冲突错误推断），记为 P1 协议缺口。`PATCH` 的知识/决策、
并发双写、端口占用、CORS 预检未测。

**MCP 传输层：ENVIRONMENT BLOCKED**。`task-dock --mcp-server` stdio 入口可正常启动并对请求返回
结构化 JSON-RPC 错误 `-32000`（MCP Server 未启用）；但桌面实例启动后未生成
`mcp-transport.json`（`%APPDATA%\com.taskdock.desktop\mcp-transport.json` 仍为旧的
`{"enabled":false,"port":0,"token":""}`）。

已定位根因：`rest::start` 持有 `slot()` 互斥锁后又调用 `status()`，`status()` 再次锁同一把
非重入 Mutex，启动线程自死锁；日志停在 `Agent REST 监听`，setup 永不继续，MCP `spawn_adapter`
不会执行。已改为写入监听槽位后 `drop(guard)` 再取状态（提交 `66899ea`），并把 setup 阶段日志
保留为启动诊断。

修复后复测：setup 已越过 REST、恢复检查、剪贴板、暂存架与 AgentHub；随后在主窗口
`WebviewWindowBuilder::build()` / 窗口辅助模块初始化处出现 `thread 'main' has overflowed its stack`
（`tmp/agent-workspace-app-stderr5.log`、`-stderr8.log`）。使用独立
`WEBVIEW2_USER_DATA_FOLDER` 时能进一步走到托盘初始化，但仍在窗口辅助模块处栈溢出
（`-stderr9.log`、`-stdout9.log`）。因此本轮 MCP bridge 仍未实际监听，`mcp-transport.json`
不是写失败，而是启动流程尚未执行到写文件；这是独立于 MCP 协议的桌面启动缺陷，需另行修复。

**Phase 6 CLI 交接补充**：交接目标不匹配时 `smoke-rest` 接收 `smoke-readonly` 的交接被明确拒绝；
自身闭环 create/accept/complete 的 revision 依次为 1/2/3，证明版本校验与状态机真实生效。

> **§8.2 更正（2026-11-18 后续）**：`task get` / `task list` 的 JSON 已补 `revision`，CLI、REST、
> MCP 三入口一致；`task update` 信封字段仍以 `payload.task_id` 为准，Markdown `task.update` 仍未实现。

## 10. 执行记录（2026-11-18，MCP 端到端真实运行）

环境：隔离数据目录 `tmp/agent-workspace-smoke`；桌面 dev 二进制 `src-tauri/target/debug/task-dock.exe`
（构建任务 `h-mwm2rzdy-4892e5`，exit 0）；CLI `src-tauri/target/debug/taskdock.exe`（构建任务
`h-mwm2tf3n-b90446`，exit 0）。
MCP bridge 由 `TASKDOCK_TEST_HEADLESS=1` 实例启动：transport `port=6946`、`enabled=true`；stdio 客户端
通过 `TASK_DOCK_DATA_DIR` 读到同一 transport。测试 Agent `smoke-rest`（16 能力）与 `smoke-readonly`。

| 用例 | 结果 | 证据摘要 |
|---|---|---|
| MCP initialize | 通过 | `protocolVersion=2025-06-18`，`serverInfo=task-dock/0.5.0` |
| tools/list | 通过 | 94 个工具（既有 73 + 本任务 21） |
| resources/list | 通过 | 10 个资源 |
| prompts/list | 通过 | 5 个提示模板 |
| manifest | 通过（修复后） | `capabilities` 16 项，与 DB 授予一致；修复前仅硬编码 12 项 |
| 创建任务 | 通过（修复后） | `taskdock_create_task` → `d794e49f-…`，`revision=1`；修复前任务 JSON 无 revision |
| 读取任务 | 通过 | `taskdock_get_task` 返回 `revision=1`、`updated_at` |
| 完成任务 | 通过（修复后） | `expected_revision=1` → 200，`status=completed`、`revision=2` |
| 统一活动 | 通过（修复后） | `agent_activity(interface=mcp)` 返回 `task.create`/`task.complete`，`agent_id=smoke-rest` |
| 只读拒绝 | 通过 | `smoke-readonly` 创建任务 → JSON-RPC `-32002`，明确 scope=readonly |
| 未知工具 | 通过 | `taskdock_nonexistent` → `-32602` |
| 缺失 token | 通过（修复后） | 修复前 `-32000 retryable=true`；修复后 `-32001 retryable=false` |
| resources/read tasks | 通过 | 5 条任务均含 `revision`，含 completed |
| prompts/get | 通过 | `prepare_development_context` 返回上下文 Markdown（487 tokens，2 条目） |

## 11. 本轮修复与回归

1. `Task` 增加可选 `revision`（`db/models.rs`），CLI/MCP/REST 的任务详情、列表、创建、更新、完成统一输出；
   桌面端既有查询保持 `None`，不改变原响应契约。
2. 旧 MCP `taskdock_create_task` / `taskdock_update_task` 在同一事务内 `bump_revision` 并写
   `agent_activity_logs`（`interface=mcp`），修复“MCP 写不进统一活动日志”的缺口。
3. `manifest` 的 `capabilities` 改为 `mcp::permissions::CAPABILITIES`，从 12 项恢复为完整 16 项。
4. stdio 错误映射：401 → `-32001`、403 → `-32002`、400 → `-32600`，不再一律 `-32000`。
5. 测试专用 `TASKDOCK_TEST_HEADLESS=1`：跳过主窗口、窗口恢复/材质/吸附、开机自启、快捷键与辅助窗口，
   保留托盘、REST、MCP、Hook 与接入管线；正常启动不设置，行为不变。该开关只用于验收，不是产品启动路径。

**回归结果**：`npm run cargo -- check -j 1` exit 0（任务 `m-mwm2mxfc-0996bd`，29.54s）；
桌面构建 exit 0（`h-mwm2rzdy-4892e5`）；CLI 构建 exit 0（`h-mwm2tf3n-b90446`）；
REST `GET /tasks/<id>` revision=2、`PATCH base_revision=2` → revision=3、旧 base=2 → 409；
CLI `task get` revision=3，`task list` 每条含 revision。

**仍未通过**：正常桌面启动（不设置 headless）仍在主窗口 `WebviewWindowBuilder::build()` 处
`thread 'main' has overflowed its stack`，因此 UI 真机、托盘交互、通知、剪贴板体验、安装包与
`buildId` 正式验收均未执行；MCP 结论仅覆盖协议与后端服务层。

## 12. GUI / UI 真实运行更新（2026-11-18 20:18–20:25）

本节修正 §11「正常桌面启动仍未通过」的历史结论；§11 原文保留。

**完整正常启动：通过（当前构建）**

- 不设置 `TASKDOCK_TEST_HEADLESS`、不设置 `TASKDOCK_TEST_SKIP_AUX_WINDOWS`，启动
  `task-dock.exe --autostart`（数据目录 `tmp/agent-workspace-gui2`）。
- 20s 后 PID 96464 `HasExited=False`、`Responding=True`、`MainWindowTitle=Task Dock`；
  stderr 为空；stdout 依次出现 `setup: 主窗口已创建`、窗口恢复、快捷键、托盘、MCP bridge、
  `Task Dock 启动完成`。此前 `thread 'main' has overflowed its stack` 未复现。
- 另一次设置 `TASKDOCK_TEST_SKIP_AUX_WINDOWS=1` 的启动（PID 46284）同样正常；说明当前构建的
  主窗口与辅助窗口创建路径均可运行。旧栈溢出日志保留为历史证据，根因未最终确认（更接近旧 debug
  增量产物或共享 WebView2 环境，而非可稳定复现的代码缺陷）。

**UI 渲染：部分通过**

- 通过 WebView2 CDP 连接真实窗口（`--remote-debugging-port=9222/9223`）读取 DOM 并截图：
  主工作台、能力中心、`Agent 共享` 页均可渲染；接入/活动/交接/同步/权限 5 个子页签存在。
- 能力中心首次动态 import `CapabilityCenterPanel-BHiA6hOy.js` 失败，点「重试」后成功；文件存在且
  HTTP 200，属 Vite/热更新瞬态，不是缺失产物。
- 窄窗 500×700 截图发现 `cap-kv` 值列被压成每行几个字符；已在 `agent-access.css` 的
  `@container cap-body (max-width:560px)` 下改为上下排列，尚未在重建后的窗口复验。

**测试隔离事故（必须记录）**

- 多个 Task Dock 实例未隔离 `WEBVIEW2_USER_DATA_FOLDER` 时共用 WebView2 用户数据；CDP 实际操作的
  UI 可能属于另一个正在运行的实例。点击「初始化共享空间」后，工作空间写入了另一个任务的
  `tmp\acceptance\files-workspace\round8\data\task-dock.db`：
  `workspace_id=ws_178919e0c30a428f828a19c54da75896`、DB 行 `b448b049-…`、
  目录 `...\round8\data\TaskDock-Agent-Workspace`（创建时间 20:23:28）。
- 该次 UI 初始化不计为干净验收证据；后续 UI 测试必须使用独立 `WEBVIEW2_USER_DATA_FOLDER`。
  误写目录未删除，等待该任务负责人确认后清理；不要把它当作本任务产物。

**未完成 / 环境阻塞**

- 隔离 WebView2 的 UI 复测未执行：桌面二进制在后续 `cargo build` 失败时被移除，
  重建连续 3 次因系统提交内存不足失败（`memory allocation failed`、exit 101/0xc0000409）。
- 全量 `cargo test --lib` 未完成：先在 test cfg 下出现与本任务无关的
  `src-tauri/src/project_hub/commands.rs:16` `tauri::async_runtime::JoinError` 找不到；随后 rustc
  再次 `memory allocation failed`（exit 101 / 0xc0000409）。不得记为通过。
- 一次 CDP 会话中进程于 20:21:22 崩溃（`0xc0000374`，ntdll 堆损坏，
  WER `APPCRASH`）；隔离会话未复现，需在稳定构建上复测。
- CU 桌面控制初始化失败（PIP SDK `SdkNotInitialized`），系统级视觉/DPI/托盘/通知走查未执行。
- 浅色/深色主题、两套视觉预设、320/400 窄窗、DPI、真实通知与剪贴板仍未走查；安装包与
  `buildId` 验收未开始。

## 13. v82 授权与事务回归（2026-11-20）

**执行口径**：本机共享 target 的 lib test 二进制需嵌入 comctl32 v6 manifest 才能启动（否则
`STATUS_ENTRYPOINT_NOT_FOUND`）；下表结果为嵌入 manifest 后的真实运行。独立验收脚本使用真实
`task-dock.exe` / `taskdock.exe`，不依赖该处理。

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `agent_access::tests` | 无 `decisions.read` 读决策、KnowledgeRead 只读授权库、ContextRead 不授予资源、项目 A/B 活动隔离、Token 撤销、本机 CLI | 全部通过 |
| `tests_v82_import` | 租约三态、真并发单赢家、人工批准与扫描共用租约、无策略待审核、失败不写业务表、同内容重投 skipped | 全部通过 |
| `tests_v82_rest` | 401/403、决策/活动项目隔离、同 Key 重放、异 Body 409、并发同 Key、fencing、committed 恢复/无指针 409、超时回滚、生命周期与端口释放 | 全部通过 |
| `tests_v82_context` | ContextRead-only FORBIDDEN、项目名/规划元数据按能力隐藏、活动按项目过滤、report 不等于 decision、中文双字与预算 | 全部通过 |
| `tests_v82_handoff` | 目标 Agent 才能迁移、revision CAS、撤销/文件导入拒绝、报告项目隔离与先过滤再分页、追加式与 result 语义 | 全部通过 |
| `db::tests::v82_migration_84...` | v83 旧行升级到 84、operation 列默认值、重复迁移幂等 | 通过（见验收报告） |

合计 `agent_access::` 143 passed / 0 failed / 0 ignored（81.36s，2026-11-20 最终复跑）。
独立脚本 52/52，exit 0，证据 `tmp/acceptance/agent-access-v82-20261120-224854/`。

### 13.1 真实外部 Agent 会话（2026-11-20）

- 身份通过真实 Tauri 命令 `mcp_agent_create` / `mcp_agent_set_scope` / `mcp_agent_grant_capability` 创建，不使用 DB seed。
- 外部 MCP stdio 客户端（`task-dock.exe --mcp-server` + `TASKDOCK_MCP_TOKEN`）+ CLI + REST 完整会话。
- 结果 **34/34 通过，exit 0**：项目隔离、知识索引过滤、重复完成不重开、REST 幂等重放/409、交接身份与报告归属、在线撤销后 CLI 6 / REST 401 / MCP -32001。
- 证据：`tmp/acceptance/external-agent-live/`（`results.log`、`summary.json`）。
- 边界：客户端为验收脚本实现的 JSON-RPC stdio 客户端，不含 LLM 推理；Release 安装包未覆盖。

## 14. 项目级交接发现（2026-11-21）

定向命令：`npm run cargo -- test --lib agent_access::tests_v82_handoff -- --nocapture`。
新增 4 例 `handoff_discovery_*`，在隔离内存库验证：

- 两个授权项目与一个未授权项目混合时，列表先过滤再分页，越界页为空且总数正确。
- 显式项目筛选、状态筛选、无项目交接与全局/本机可见性。
- `projects.read` / `handoffs.write` 不能替代读取权限，撤销后的已有主体立即失效。
- 文件导入无授权、只有其它读能力或写能力时拒绝；显式交接读授权仅返回授权项目。

执行结果：11 passed / 0 failed / 0 ignored，exit 0（含新增 4 例，2026-11-21）。
证据：`tmp/acceptance/agent-handoff-discovery/cargo-test.log`。
上述自动化测试不代表真实桌面或安装包验收。

## 15. 单任务授权上下文（2026-11-21）

`npm run cargo -- test --lib agent_access::tests_v82_context` 在隔离内存库执行，
24 passed / 0 failed / 0 ignored，exit 0。新增两例验证：

- 精确任务授权可按真实关联进入目标任务的上下文，保留任务详情及其近期变更。
  同项目其他任务、项目名称及规划目标仍按各自能力过滤。
- 无读取授权（含撤销）返回 `FORBIDDEN`，任务和项目不匹配返回 `VALIDATION`。
- 未关联项目的任务保留独立范围，即使在 200 项候选之外也可凭 ID 取得详情。

单测日志：`tmp/acceptance/agent-task-context/rust.log`。

Dev 端到端复验 64/64，exit 0。用真实 Tauri 命令创建身份、授予 `context.read` 与目标任务的
`tasks.read`，再由 CLI、MCP stdio 和 REST 读取。同项目未授权任务和错误项目均被拒绝，
撤销单任务能力后，三个入口立即拒绝目标上下文。原有交接、受控文件导入和鉴权用例同轮通过。
证据：`tmp/acceptance/agent-task-context/report.md`。未执行 Release 安装包验收。

## 16. 上下文输出与 token 预算（2026-11-21）

- `npm run cargo -- test --lib agent_access::` 通过 171 项，exit 0。覆盖按表示估算预算、
  固定内容超预算时拒绝、近期变更预算、REST GET 投影、分页、授权及既有写入和幂等。
- 真实 CLI、MCP stdio、REST 与文件投影抽测 5/5。使用新编译的 Debug 二进制、
  独立测试数据库和无窗口模式。同一上下文的旧版和紧凑模式保留相同的条目及近期变更。
- 复测采用 `o200k_base`。CLI 的 6000 token 样本标记截断，保留 24 个条目，输出测得 5432 token。
  证据：`tmp/acceptance/agent-context-compact/report.md`。本轮未执行桌面 UI 与 Release 安装态验收。

## 17. 外部 Agent 项目任务（2026-11-23）

- Rust 真实回环 REST 定向用例验证授权项目先过滤再分页、精确任务授权、创建原子性、
  关联与解绑幂等、任务本身保留，以及项目撤销后的写入重放拒绝。Agent Access 模块回归 232/232。
- 最终 Debug 二进制通过隔离数据上的真实 CLI、MCP stdio 与 REST 抽测 10/10。
  覆盖空项目 ID、未授权项目、计划 ID 归一、跨入口关联与解绑、权限撤销、
  CLI 同步权限和监听端口释放。证据：`tmp/acceptance/external-agent-project-tasks/report.md`。
- 本轮后端验收使用无窗口测试进程，桌面界面和正式安装包未纳入范围。
