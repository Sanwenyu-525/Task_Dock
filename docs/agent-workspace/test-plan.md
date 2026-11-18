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
结构化 JSON-RPC 错误 `-32000`（MCP Server 未启用）；但桌面实例启动后仅监听 `47911`，未生成
`mcp-transport.json`（`%APPDATA%\com.taskdock.desktop\mcp-transport.json` 仍为旧的
`{"enabled":false,"port":0,"token":""}`）。在 `spawn_adapter` 入口新增日志后重建并重启，日志仍未
出现，说明 setup 尚未执行到 MCP 适配器（应用窗口 `Responding=False`），不是 MCP 代码本身的编译或
协议错误。另 `cargo test --lib mcp::protocol::tests` 因系统分页文件不足（`os error 1455`、OOM）
在编译测试二进制时失败，未取得协议单测结果。

**Phase 6 CLI 交接补充**：交接目标不匹配时 `smoke-rest` 接收 `smoke-readonly` 的交接被明确拒绝；
自身闭环 create/accept/complete 的 revision 依次为 1/2/3，证明版本校验与状态机真实生效。
