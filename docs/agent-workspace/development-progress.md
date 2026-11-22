# 开发进度

> 状态口径：**未实现 / 部分实现 / 已完成（代码）/ 已验收**。
> “已完成（代码）”只代表实现与静态检查通过，不代表运行时或真机验收通过。
> 最后更新：2026-11-18。

## Phase 0：架构审计与设计

| 交付 | 状态 | 证据 |
|---|---|---|
| 现有代码审计、复用矩阵 | 已完成 | [code-audit.md](code-audit.md) |
| 架构、数据模型、四入口协议、权限、同步、Context、Handoff | 已完成 | [architecture.md](architecture.md)、[data-model.md](data-model.md)、[workspace-protocol.md](workspace-protocol.md)、[synchronization.md](synchronization.md)、[cli-specification.md](cli-specification.md)、[mcp-specification.md](mcp-specification.md)、[rest-api-specification.md](rest-api-specification.md)、[context-engine.md](context-engine.md)、[handoff-protocol.md](handoff-protocol.md)、[permission-model.md](permission-model.md)、[security.md](security.md) |
| 功能矩阵、增强能力评估 | 已完成 | [feature-matrix.md](feature-matrix.md) |
| 开发依赖与分阶段计划 | 已完成 | 本文档第 1 节 |

## Phase 1：共享数据基础

| 交付 | 状态 | 位置 |
|---|---|---|
| v76 迁移（11 张新表 + `mcp_agent_capabilities` 扩 CHECK + `mcp_agents` 三列） | 已完成（代码） | `src-tauri/src/agent_access/schema.rs`、`db/mod.rs` |
| 新设置项（路径 / 监听 / REST 开关与端口） | 已完成（代码） | `db/mod.rs`、`commands/settings.rs` |
| Workspace 初始化、标记文件、manifest | 已完成（代码） | `agent_access/workspace.rs` |
| 文件投影（projects/tasks/knowledge/decisions/agents/context） | 已完成（代码） | `agent_access/projection.rs` |
| 受控导入、冲突、同步状态 | 已完成（代码） | `agent_access/sync.rs` |
| 20s 轮询监听（单轮 200 文件、来源判定、防回环） | 已完成（代码） | `agent_access/watch.rs` |
| 审计日志、版本与幂等缓存 | 已完成（代码） | `agent_access/store.rs`、`schema.rs` |
| 备份表登记 | 已完成（代码） | `commands/backup.rs` |

**已验收（2026-11-18）**：隔离库完成迁移；Workspace 初始化、manifest/投影导出、合法文件导入并归档、
旧 revision 冲突记录、`db` 方式解决、非法文件归档 `_rejected/`、导出后扫描不回环均真实执行。
**未验收**：删除传播、重复同步（同文件二次导入）、200 文件批量、文件监听轮询、备份恢复。

## Phase 2：CLI

| 交付 | 状态 | 位置 |
|---|---|---|
| 独立 `taskdock` 可执行 | 已完成（代码） | `src/bin/taskdock.rs`、`Cargo.toml` |
| 命令路由（status/info/project/task/plan/knowledge/decision/context/agent/search/sync） | 已完成（代码） | `agent_access/cli.rs` |
| 统一 JSON 信封、stdout/stderr 分离、退出码 | 已完成（代码） | `agent_access/mod.rs`、`cli.rs` |
| 本机用户 / Agent Token / 强制只读 | 已完成（代码） | `agent_access/permissions.rs`、`cli.rs` |

**已验收（2026-11-18）**：UI 未运行，`status`、`task list/create/complete/get`、`project list`、
`search`、`sync *`、`context get`、`agent report create` 在隔离库真实执行；冲突 exit 5、NOT_FOUND exit 3、
用法错误 exit 2、只读 exit 6、未初始化 exit 7。详见 [test-plan.md](test-plan.md) §8。
**未验收**：并发、Agent Token 身份、完整交接流转。

## Phase 3：Context Engine

| 交付 | 状态 | 位置 |
|---|---|---|
| 范围解析（项目/任务/描述/Agent/会话） | 已完成（代码） | `agent_access/context.rs` |
| 任务、计划、知识、决策、Skill、交接、近期变更检索 | 已完成（代码） | `context.rs`、`service.rs` |
| 打分、去重、预算（默认 6000 / 最大 24000） | 已完成（代码） | `context.rs` |
| Markdown 13 节 / JSON 输出、来源元数据 | 已完成（代码） | `context.rs` |
| 访问记录 | 已完成（代码） | `store::record_context_access` |
| 阶段二向量/混合检索 | 未实现（按规划延后） | — |

**已验收（2026-11-18）**：`context get --task "Smoke Task" --format json` 真实生成，估算 427 tokens，
含 items/markdown/recent_changes/scope 等字段。
**未验收**：项目级上下文、预算裁剪、去重、只读 Agent 越权、访问日志落库。

## Phase 4：MCP

| 交付 | 状态 | 位置 |
|---|---|---|
| 21 个新工具注册与分发 | 已完成（代码） | `agent_access/mcp_tools.rs`、`mcp/tools.rs` |
| 10 个 Resources + 5 个 Prompts | 已完成（代码） | `mcp_tools.rs`、`mcp/protocol.rs`、`mcp/bridge.rs` |
| `initialize` 声明 resources/prompts 能力 | 已完成（代码） | `mcp/protocol.rs` |
| 权限、版本、审计复用既有 MCP 管线 | 已完成（代码） | `mcp/tools.rs`、`agent_access/service.rs` |
| HTTP 传输 | 未实现（明确不做） | 见 [mcp-specification.md](mcp-specification.md) |

**未验收**：未用真实支持 MCP 的外部 Agent 连接并读写。

## Phase 5：REST API

| 交付 | 状态 | 位置 |
|---|---|---|
| loopback HTTP（127.0.0.1，默认关闭） | 已完成（代码） | `agent_access/rest.rs` |
| 36 条路由 + OpenAPI | 已完成（代码） | `rest.rs` |
| Bearer Token、Origin 拒绝、限流、超时、幂等 | 已完成（代码） | `rest.rs`、`agent_request_cache` |
| 远程访问 | 未实现（默认关闭） | 见 [security.md](security.md) |

**未验收**：未用 curl/脚本验证认证、越权、分页、限流、并发修改；端口冲突未实测。

## Phase 6：Agent Identity / Handoff / 工作报告

| 交付 | 状态 | 位置 |
|---|---|---|
| 身份复用 `mcp_agents`（唯一真源） | 已完成（代码） | `mcp/auth.rs`、`agent_access/permissions.rs` |
| 交接创建/接收/拒绝/完成、revision 校验 | 已完成（代码） | `agent_access/handoff.rs`、`store.rs` |
| 工作报告（追加式） | 已完成（代码） | `handoff.rs`、`store.rs` |
| 活动日志（四入口统一） | 已完成（代码） | `store.rs` |

**未验收**：未模拟 Agent A → B → C 的完整交接链路。

## Phase 7：UI 管理面

| 交付 | 状态 | 位置 |
|---|---|---|
| 能力中心新增「Agent 共享」页 | 已完成（代码，TS 类型检查通过） | `src/components/capability/AgentAccessSection.tsx`、`CapabilityCenterPanel.tsx` |
| 接入状态 / 活动 / 交接 / 同步 / 权限五个子页 | 已完成（代码） | 同上 |
| 19 个 Tauri 命令 + bridge 封装 | 已完成（代码） | `agent_access/commands.rs`、`src/lib/bridge.ts`、`lib.rs` |
| 中英文文案 | 已完成（代码） | `src/locales/zh-CN/index.ts`、`en-US/index.ts` |
| 样式（语义 Token、容器查询窄窗降级） | 已完成（代码） | `agent-access.css` |
| 真机视觉走查（深/浅主题、320/400 窄窗、DPI） | 未执行 | — |

## 已完成 / 部分实现 / 未实现清单

**已完成（代码 + 静态检查）**

- Rust：`cargo check` 通过（exit 0，2026-11-18，24.72s，见 `tmp/agent-workspace-check.log`；调度任务 `m-mwly1u9c-fff525`）。
- 前端：`npx tsc --noEmit` 通过（exit 0，见 `tmp/agent-workspace-tsc.log`）。
- CLI：`cargo build --bin taskdock` 通过；在隔离数据目录完成迁移、工作空间初始化/导出/导入/冲突/解决、
  任务创建/完成、Context、报告等冒烟（详见 [test-plan.md](test-plan.md) §8）。
- 修复：CLI 顶层 `search` 参数解析、任务投影 `revision`、非法信封归档 `_rejected/`。

**部分实现**

- 文件监听为 20s 轮询（非 OS 原生事件），符合“无差别双向监听会回环”的约束，但不是实时。
- Context 检索仅 SQLite 关键词/标题匹配，无语义检索。
- 远程访问：未实现，UI 标注“未开放”。

**未实现**

- 向量检索/重排序（阶段二）。
- MCP HTTP 传输（明确不做，保持 stdio + loopback）。
- 远程访问与公网暴露。

## 验证记录（截至 2026-11-18）

| 检查 | 命令 | 结果 | 证据 |
|---|---|---|---|
| Rust 类型检查 | `npm run cargo -- check -j 1` | exit 0，24.72s（清理本轮告警后复跑）；本轮新增代码 0 警告，剩余 19 条均为既有模块 | `tmp/agent-workspace-check.log`、`.git/taskdock-build-sched/logs/m-mwly1u9c-fff525.log` |
| 前端类型检查 | `npx tsc --noEmit` | exit 0 | `tmp/agent-workspace-tsc.log` |
| 桌面 dev 构建 | `npm run cargo -- build --bin task-dock -j 1` | exit 0，44s（REST 修复后）；另一次 1m49s（MCP 日志后） | `tmp/agent-workspace-desktop-build.log`、` -build2.log` |
| CLI / 文件协议 | `taskdock` + `sync` | 通过：CRUD、导入归档、冲突、解决、防回环；错误码 2/3/5/6/7 符合规范 | `tmp/agent-workspace-smoke/`、test-plan §8 |
| REST 真实链路 | `curl` @127.0.0.1:47911 | 通过：401/403、分页、详情、PATCH+409、只读 403、撤销 401、413、第 121 次 429、OpenAPI 30 路径 | test-plan §9 |
| MCP stdio 入口 | `task-dock --mcp-server` | 入口返回结构化 `-32000`；bridge 未启动，无 transport 文件 | 本报告 §10 |
| Rust 单测 | `npm run cargo -- test --lib mcp::protocol::tests` | 未执行：测试二进制编译 OOM（`os error 1455`） | `tmp/agent-workspace-mcp-protocol-test.log` |
| 端到端场景 A–F | — | 部分执行：CLI/文件/REST 已覆盖，MCP/UI/安装包未覆盖 | [test-plan.md](test-plan.md)、[acceptance-report.md](acceptance-report.md) |
| 性能基线 | — | 未执行 | [test-plan.md](test-plan.md) |

> 说明：首次 `cargo check` 在“类型检查已通过、写 metadata”阶段因机器可用内存不足被 rustc OOM 终止（exit 101），
> 属 `ENVIRONMENT BLOCKED` 类资源问题；内存恢复后同一命令通过，未发现代码错误。

## 阶段状态更新（2026-11-18 晚）

上表“MCP stdio 入口仅返回 -32000、bridge 未启动”为历史记录。补上 REST 启动自死锁修复后，MCP bridge
已真实监听；用测试专用 `TASKDOCK_TEST_HEADLESS=1` 启动后端后完成端到端验收。

- **Phase 4（MCP）**：从“已完成（代码）”更新为“已完成（真实测试）”。94 tools / 10 resources /
  5 prompts；initialize、工具调用、资源读取、提示生成、任务创建/完成、权限拒绝、统一活动日志均通过。
- **任务版本口径**：`Task` JSON 在 CLI/MCP/REST 统一输出 `revision`；MCP create/update 同事务写
  `agent_resource_revisions` 与 `agent_activity_logs`；manifest `capabilities` 恢复 16 项。
- **错误码**：stdio 401→`-32001`、403→`-32002`、400→`-32600`。
- **启动缺陷未修复**：正常 GUI 启动仍在主窗口 `WebviewWindowBuilder::build()` 处主线程栈溢出；
  headless 仅用于验收，不是产品能力。Phase 7 UI 真机、安装包、性能基线仍为未执行。

> **状态更正（2026-11-20，第二轮架构审计）**：上条「启动缺陷未修复」已被
> [acceptance-report.md](acceptance-report.md) §12（2026-11-18 20:25）推翻——完整正常 GUI 启动
> （不设 headless、不跳过辅助窗口）已通过（PID 96464，20s 仍在运行、窗口标题 Task Dock、
> stderr 为空），旧栈溢出未复现；同一节亦记录了多实例共用 WebView2 用户数据导致的隔离事故与
> 环境阻塞项。另据同报告 v81 修订轮（2026-11-19）：端到端 A–F 场景 36/36 通过（Release 构建
> `1e8817c`、独立数据目录；MCP 场景经 `--mcp-server` 模式），干净工作区 `npm run tauri build`
> exit 0 产出 NSIS 安装包，但正式安装包验收（安装/升级/卸载）与集成快照路径仍 BLOCKED。
> Phase 7 UI 真机走查（主题/窄窗/DPI）、`buildId` 正式验收、性能基线仍未执行。

## GUI / UI 状态更新（2026-11-18 20:25）

- **正常 GUI 启动**：已从“主线程栈溢出阻塞”更新为“当前构建通过”。完整启动（不设 headless、
  不跳过辅助窗口）PID 96464，20s 后仍响应，标题 `Task Dock`，stderr 为空。旧栈溢出未复现，
  根因未最终确认。
- **UI 渲染**：WebView2 CDP 实测主工作台、能力中心、`Agent 共享` 与 5 个子页签正常渲染；
  能力中心首次动态 chunk 失败后重试成功。
- **UI 写链路**：初始化按钮触发成功，但多实例共用 WebView2 导致写入另一任务 `round8` 数据目录，
  不作为本任务干净验收证据；待独立 `WEBVIEW2_USER_DATA_FOLDER` 复测。
- **窄窗修复**：`agent-access.css` 在小容器下将 `cap-kv` 改为上下排列，避免路径逐字换行。
- **未完成**：隔离 WebView2 UI 复测、深浅主题/视觉预设/320·400/DPI/真实通知/托盘、安装包、
  `buildId`、性能基线。当前桌面二进制因重建 OOM 被移除，重建 3 次失败（内存不足）。

证据见 [test-plan.md](test-plan.md) §12、[acceptance-report.md](acceptance-report.md) §12。

## v81 修订轮（2026-11-19 代码级缺陷修复与协议统一）

| 交付 | 状态 | 位置 |
|---|---|---|
| P0 文件导入权限边界：身份拆分 + 目录策略 + 待审核 + 幂等声明 | 已完成（代码） | `agent_access/{mod,permissions,sync,watch,commands}.rs`、`schema.rs`（迁移 v81） |
| P1 冲突契约统一（db/file/dismiss）与按资源类型鉴权 | 已完成（代码） | `agent_access/sync.rs`、`commands.rs`、前端 `AgentAccessSection.tsx` |
| P1 Context 分权装配、项目范围、近期变更关联、预算、中文检索 | 已完成（代码） | `agent_access/context.rs` |
| P1 REST 生命周期（先绑定后登记、真实状态、端口切换） | 已完成（代码） | `agent_access/rest.rs` |
| P1 Handoff 操作者身份与报告范围 | 已完成（代码） | `agent_access/handoff.rs` |
| P2 Markdown task.update、导入幂等、监听状态可观测 | 已完成（代码） | `agent_access/sync.rs`、`watch.rs` |
| P2 前端：报告数据源、冲突单条选择、导入审核、权限分组与撤销确认 | 已完成（代码） | `src/components/capability/AgentAccessSection.tsx`、`agent-access.css` |
| P2 CLI 命令注册表 / 文档契约 / 未知参数校验 / 兼容别名 | 已完成（代码） | `agent_access/cli.rs`、`docs/agent-workspace/cli-specification.md` |
| 契约测试（Rust 18 例 + 前端 9 例） | 已完成（代码） | `agent_access/tests.rs`、`AgentAccessSection.test.tsx` |

**验证口径**：`npm run typecheck` exit 0；`npx vitest run src/components/capability/AgentAccessSection.test.tsx` 9/9 通过；
`npm run cargo -- check --lib` exit 0。`cargo test --lib agent_access` 在共享工作区被**其他会话**的
`src-tauri/src/diagnostics/panic_hook.rs`（test cfg）编译错误阻塞（E0597，非本任务模块），
改在集成隔离工作区执行，结论见 [acceptance-report.md](acceptance-report.md) v81 章节。

## v82 架构审查整改（2026-11-20）

本轮目标不是新增能力，而是让四入口的**授权、事务、重试、并发**闭环。结论：Dev 功能验收通过
（`scripts/acceptance-agent-access-v82.mjs` 52/52，exit 0；Rust `agent_access::` 143/143）。

| 交付 | 状态 | 位置 |
|---|---|---|
| 统一授权查询：决策/活动/知识索引/项目元数据按能力与真实归属判定 | 已完成 | `agent_access/service.rs`、`permissions.rs` |
| CLI/MCP 读取接口移除 store 直读（决策、活动、知识索引、Prompt） | 已完成 | `agent_access/cli.rs`、`mcp_tools.rs` |
| REST 决策/活动/同步状态授权 + `dispatch` 事务内守卫 | 已完成 | `agent_access/rest.rs` |
| 完成任务统一为 `pending → completed`，revision/提醒/统计/守卫同事务；已完成幂等不重开 | 已完成 | `agent_access/service.rs` |
| 知识更新 revision 与正文同事务；索引失败保持 pending 并可重试 | 已完成 | `agent_access/service.rs` |
| REST 幂等 operation 指针（迁移 84）：`committed` 永不被抢占，崩溃后重建或 409 RECOVERY_REQUIRED | 已完成 | `agent_access/store.rs`、`schema.rs`、`db/mod.rs`、`rest.rs` |
| Context：`context.read` 不再授予项目/资源可见；活动按授权 SQL 过滤 | 已完成 | `agent_access/context.rs` |
| Handoff：报告先按项目过滤再分页；文件导入读交接也校验能力 | 已完成 | `agent_access/handoff.rs`、`store.rs` |
| 本机活动审计 `actor_kind` 与 v76 CHECK 不一致导致静默丢失 | 已修复 | `agent_access/store.rs` |
| Markdown 正文尾部换行导致 description 不一致 | 已修复 | `agent_access/sync.rs` |
| v82 独立验收脚本 | 已完成 | `scripts/acceptance-agent-access-v82.mjs` |

**验证**：`npm run cargo -- check --lib` exit 0；`npm run typecheck` exit 0；测试二进制
`agent_access::` 143 passed / 0 failed（81.36s，最终复跑）；迁移 84 升级用例通过；独立脚本 52/52、
exit 0（隔离数据目录 `tmp/acceptance/agent-access-v82-20261120-224854/`）。详见
[v82-acceptance-report.md](v82-acceptance-report.md)。

**交付提交**：`c110711e9f6052d8d75276098fb812dc727375b7`（`main`）。
文档与报告路径：[v82-acceptance-report.md](v82-acceptance-report.md)、
[test-plan.md](test-plan.md) §13、[architecture.md](architecture.md) §9–10、
[permission-model.md](permission-model.md) §9。

## 项目级交接发现（2026-11-21）

- 接续 v82 保留的项目级列表限制：CLI / MCP / REST 省略项目时，按
  `handoffs.read` 的授权项目集合发现交接；SQL 先过滤再分页，`total` 与可见列表一致。
- 修复 `list_handoffs` 对文件导入身份跳过鉴权：要求显式读取能力，收敛到导入授权项目，
  绑定 Agent 时复核授权及撤销状态。全局与本机身份的既有列表行为保持兼容。
- 无数据库、IPC 签名或响应结构变化；协议说明见 [handoff-protocol.md](handoff-protocol.md) §7。
- 自动化验证：`npm run cargo -- test --lib agent_access::tests_v82_handoff -- --nocapture`
  exit 0，11/11 通过（含新增 4 例）；日志 `tmp/acceptance/agent-handoff-discovery/cargo-test.log`。
  定向差异与文档链接检查通过；未执行桌面与安装包验收。

## 单任务授权上下文（2026-11-21）

- CLI、MCP 与 REST 显式查询目标任务时，可使用已授予的单任务读取权限装配上下文。
  装配根据真实任务关联选择项目，项目名称、规划和其他任务仍各自鉴权。
- 校验目标任务与项目的关联。未关联项目的任务保持独立范围，目标超出候选列表上限时仍可按 ID 入选。
- 上下文 Rust 测试 24/24，实际 Dev 桌面与外部入口复验 64/64，含五项新增任务上下文断言。
  详见 [context-engine.md](context-engine.md#73-项目范围) 与 [test-plan.md](test-plan.md#15-单任务授权上下文2026-11-21)。

## 上下文输出与 token 预算（2026-11-21）

- CLI、MCP 和 REST 支持 `compact_json`，同一份上下文可只返回结构化数据。
- 预算按选定表示估算，双份输出计入 Markdown。REST GET 支持字段投影，分页元数据以及资源授权继续独立处理。
- 等量上下文样本中，CLI、MCP、REST 的 token 分别减少 49.5%、48.5%、36.7%。
  Rust 模块回归 171/171，真实传输与文件投影抽测 5/5。详见 [test-plan.md](test-plan.md#16-上下文输出与-token-预算2026-11-21)。

## 2026-11-21：统一项目身份与项目创建

已完成：`project_hub::creation` 统一创建服务（幂等优先、目录三模式、恢复日志带租约/状态）、
Agent 读模型按项目根去重、计划独立列表与反解析、`projects.create` / `projects.write`（v90）、
授权表外键改挂项目根（v91）、MCP/CLI/REST 共用创建服务、投影文件协议按项目根分目录。

验证（22:10 提交 bf13dd6 后补齐）：`cargo test --test project_creation_identity` 18/18；
CLI 真机端到端（隔离库）：创建/幂等重放/摘要冲突 exit=5/列表去重/计划反解析/`create_new` 目录
真实初始化全部通过，并由此发现修复详情 JSON 非 camelCase（`a7a474b`）；真实窗口验收
（隔离实例 + CDP 截图）：「新建项目」弹层全字段渲染 → 创建成功 Toast 显示真实
activePlanId → 自动选中新项目 → CLI 交叉读取同一项目与同一计划 ID。
证据：`tmp/acceptance/project-identity-v2/{report.md,cli-e2e/,gui/}`。

未完成：MCP/REST 真机调用（需外部客户端；服务端与 CLI/REST 共用创建服务，已由集成测试覆盖）、
Agent Token 写链路演练（需注册 Token）。

## 2026-11-22：第二轮架构治理（v92）

已完成：幂等请求归属 `IdempotencyScope` + `project_create_requests`（跨 Agent 幂等隔离）；
统一授权四层（`require` 增加 grant 层、`authorized_reads` grant 交集）；
`ProjectId`/`PlanId` 强类型与旧 `project_kind` 契约收敛（v92 重建 agent_decisions/agent_handoffs，
新数据写 `'project'`）；MCP grant/revoke 归一根（v91 外键对齐）+ McpAccessSection 换项目根列表 +
能力清单补齐；CLI `create_new` 身份门禁 + `cli_operation_result` 复用 `from_value`；
REST `PATCH /api/v1/projects/{projectId}`；Agent 项目列表授权过滤；
Workbench 创建 requestId 按参数摘要派生；备份注册表补登记（project_create_requests 与
导入三表）+ `db::tests` 迁移断言修复。

修复的存量断裂（v90/v91 之后产生）：带项目的交接创建 CHECK 失败、文件导入任务/决策被旧
字符串比较拒绝、MCP grant 直插计划 ID 触发 v91 外键失败。

验证：`agent_access` 139+112+5+4 全过；`mcp` 81/0（修复 18 个 FK 夹具失败 + 8 个新测试）；
`collab` 19/0；`project_hub::creation` 36/0（含 6 个幂等归属新测试）；`db::tests` 51/0；
`commands::planning` 12/0（修复 v0.7 时代遗留的归档不变量过期断言）；`commands::project_workspace`
13/0；前端 `McpAccessSection.test.tsx` 14/0、WorkbenchShell 用例追加。

真实场景验收（CLI 端到端，隔离库 tmp/debug/agent-gov-round3/，证据
tmp/acceptance/agent-gov-round3/）：A/B/C/D/E/G/H/I/J 十场景中九项直接通过——跨 Agent 同
requestId 独立创建、同 Agent 重试返回原项目、Agent create_new 拒绝且目录未建、人类 create_new
真实建目录（事件主体=local）、Decision/Handoff/文件协议导入落项目根（project_kind='project'）、
B 授权后接受交接（未授权 FORBIDDEN）、未授权项目读取拒绝；场景 I（操作记录项目指针）首次
运行为空 → 修复 CLI 项目上下文回填（--project / task create 位置参数解析为根，
complete_tx COALESCE 回填）后复验通过。场景 F（MCP 设置真实窗口走查）以组件测试覆盖，
真实窗口受单实例协议阻塞。

未完成 / 存量：`tests/mcp_e2e.rs` 与 `tests/project_creation_identity.rs` 已修复/待运行
（ENVIRONMENT BLOCKED：并行会话实例锁 target/debug/task-dock.exe，os error 5，锁释放后补跑）；
`commands::settings` 布局宽度文案、`commands::projection_window` 吸附宽度、
backup/restore/shelf 的 voice 资产三处为其他在途任务存量失败，未在本轮范围；CLI `project update`
子命令未实现（REST/MCP 已覆盖，见 feature-matrix「projects.write 更新链路」）。
