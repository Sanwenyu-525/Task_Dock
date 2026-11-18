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
| C6 | 无效参数 | `taskdock task create`（缺 title） | exit 4 / `VALIDATION`，stderr 有说明 |
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

## 8. 未执行登记（截至 2026-11-18）

- F1–F11、C1–C10、X1–X6、M1–M10、R1–R10、H1–H7、P1–P6：**均未执行**。
- 已执行：`cargo check`（exit 0）、`npx tsc --noEmit`（exit 0）。
- 原因：本轮以代码落地与静态检查为主；真实运行需要独立数据目录、构建产物、Agent Token 与外部客户端，
  且共享机器内存紧张（曾导致 rustc OOM），需在资源空闲窗口按本计划逐项执行。
