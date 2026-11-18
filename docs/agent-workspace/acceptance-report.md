# 验收报告（v76 · Agent 共享工作空间）

- 日期：2026-11-18
- 范围：Phase 0–7 代码落地、静态检查，以及 CLI/文件协议首次真实冒烟；MCP/REST/UI/性能未执行
- 构建版本：共享工作区（非集成快照）；未生成正式安装包
- 结论：**部分通过（代码级 + CLI/文件协议真实冒烟）；MCP/REST/UI/性能仍证据不足**

## 1. 任务范围

把 TaskDock 扩展为 Human + Agent Shared Workspace：外部 Agent 通过 CLI / MCP / REST / 受控文件目录
访问同一套 SQLite 数据（项目、任务、规划、知识、决策、上下文、Skill、交接、工作报告），四个入口共用
权限、来源标识、审计、版本冲突与 UI 管理面；远程访问默认关闭。

不做：Coding Agent 管理器、Agent CLI 启动器、仅 MCP 或仅 Markdown 目录、把整库直接暴露给外部 Agent。

## 2. 检查依据

- `AGENTS.md` §3（Git 安全、交付）、§4（架构红线）、§5（构建与证据）、§6（UI/UX）、§7（文档与报告）。
- [README.md](README.md)、[code-audit.md](code-audit.md)、[architecture.md](architecture.md)、
  [data-model.md](data-model.md)、[workspace-protocol.md](workspace-protocol.md)、
  [synchronization.md](synchronization.md)、[cli-specification.md](cli-specification.md)、
  [mcp-specification.md](mcp-specification.md)、[rest-api-specification.md](rest-api-specification.md)、
  [context-engine.md](context-engine.md)、[handoff-protocol.md](handoff-protocol.md)、
  [permission-model.md](permission-model.md)、[security.md](security.md)、[test-plan.md](test-plan.md)。

## 3. 实际执行的检查

| 检查 | 命令 | 工作目录 | 退出码 | 时间 | 证据 |
|---|---|---|---|---|---|
| Rust 类型检查 | `npm run cargo -- check -j 1` | `D:\Develop\task_dock` | 0 | 2026-11-18，24.72s（清理本轮告警后复跑；本次新增代码 0 警告） | `tmp/agent-workspace-check.log`；调度日志 `.git/taskdock-build-sched/logs/m-mwly1u9c-fff525.log` |
| 前端类型检查 | `npx tsc --noEmit` | `D:\Develop\task_dock` | 0 | 2026-11-18 | `tmp/agent-workspace-tsc.log` |
| CLI 构建 | `npm run cargo -- build --bin taskdock -j 1` | `D:\Develop\task_dock` | 0 | 1m21s；后续修复重建 60s/153s/45s（含排队） | `tmp/agent-workspace-cli-build*.log`、`.git/taskdock-build-sched/logs/h-mwly9atc-9a5af5.log` 等 |
| CLI/文件协议冒烟 | `taskdock status/info/task/sync/context/agent/search`，隔离 `TASK_DOCK_DATA_DIR` | `D:\Develop\task_dock` | 各命令见 [test-plan.md](test-plan.md) §8 | 2026-11-18 | DB `tmp/agent-workspace-smoke/task-dock.db`、工作空间 `tmp/agent-workspace-smoke/ws`、二进制 SHA256 `779FDE48…4290D05` |

补充事实：首次 `cargo check` 在类型检查已通过、写 metadata 阶段因机器可用内存不足被 rustc OOM 终止
（exit 101 / `STATUS_STACK_BUFFER_OVERRUN`），属运行期资源问题；内存恢复后同一命令通过。未发现代码错误。

未执行：MCP 真实客户端、REST 端口/认证/限流/幂等、UI 真机走查、场景 A–F 全链路、性能基线、
`cargo test`、Tauri 安装包。CLI 的 C8/C9、文件 F8–F10、交接完整流转也未执行；已执行项与证据见
[test-plan.md](test-plan.md) §8。

## 4. 代码审查问题清单

### P0

无。

### P1

| # | 现象 | 根因 | 影响 | 证据/状态 |
|---|---|---|---|---|
| P1-1 | 四入口仅 CLI/文件链路完成真实冒烟 | MCP/REST/UI 仍是静态检查 | 后三类入口的权限/版本/同步真实行为未知 | CLI/文件见 test-plan §8；MCP/REST 待执行 |
| P1-2 | MCP resources/prompts 未用真实客户端验证 | 仅完成协议接线 | 客户端兼容性未知 | `mcp/protocol.rs`、`mcp/bridge.rs` 已实现；待 M10 |
| P1-3 | 任务投影缺 `revision`（已修复） | `task_markdown` 未接收版本号 | 外部 Agent 无法从文件取得 `base_revision`，文件更新不可用 | 已补 `revision` 并由 `sync export` 实测输出 `- revision: 1` |

### P2

| # | 现象 | 根因 | 影响 | 证据/状态 |
|---|---|---|---|---|
| P2-1 | 文件监听为 20s 轮询 | 避免无差别双向监听回环 | 导入有延迟 | `agent_access/watch.rs`；设计如此 |
| P2-2 | Context 仅关键词检索 | 阶段一不引入向量库 | 语义召回有限 | `agent_access/context.rs`；已在文档标注阶段二 |
| P2-3 | CLI 新 bin 与 Tauri 主二进制识别 | 打包器默认寻找 `task-dock` | 安装包内 CLI 可能缺失 | `Cargo.toml` 已设 `default-run`；回退方案 `task-dock --cli` 未实现 |
| P2-4 | REST 端口 47911 未实测冲突 | 未运行 | 可能与用户环境冲突 | `rest.rs` 启动失败仅记录错误，不回滚设置 |
| P2-5 | `sync.rs` 扫描结束更新时间戳失败会返回错误 | 本轮改为 `?` 传播 | 极端 IO 失败会让 scan 报错（此前是静默忽略） | 已修复为显式传播 |
| P2-6 | `task get` / `task list` 不返回 `revision` | 直接序列化 `Task`，版本在 `agent_resource_revisions` | CLI 调用方需靠错误或投影文件反推 `base_revision` | 待补字段；本轮未改 |
| P2-7 | 文档 `target_id` 与实现 `payload.task_id` 不一致 | 文档表格按服务层输入命名，未同步导入解析 | 按文档写 JSON 信封会被 `VALIDATION` 拒绝 | 需统一命名并补契约测试 |
| P2-8 | Markdown `task.update` 未实现 | 解析器只映射 create/knowledge/decision | 文档宣称的 Markdown 更新不可用 | 需补 `taskdock_id` → `task_id` 映射或收窄文档 |
| P2-9 | 非法信封会反复扫描（已修复） | 解析失败后未移动文件 | `pending_imports` 卡住、事件重复 | 已归档 `inbox/_rejected/`，复测 `scanned=0` |

### P3

| # | 现象 | 影响 | 状态 |
|---|---|---|---|
| P3-1 | 审计日志未记录完整上下文正文 | 隐私优先 | 设计如此，见 [security.md](security.md) |
| P3-2 | UI 表格窄窗隐藏第 4 列以后 | 320/400 窄窗可读性 | `agent-access.css` 容器查询；未真机走查 |
| P3-3 | 新增 21 个 MCP 工具名与旧 47 个并存 | 客户端工具列表变长 | 已避开重名；`mcp-tools` 注册一致性测试存在但未运行 |

## 5. 修改文件与关键位置

**新增（后端）**：`src-tauri/src/agent_access/` 下 `mod.rs`、`schema.rs`、`store.rs`、`permissions.rs`、
`service.rs`、`workspace.rs`、`handoff.rs`、`context.rs`、`projection.rs`、`sync.rs`、`watch.rs`、`cli.rs`、
`rest.rs`、`mcp_tools.rs`、`commands.rs`；`src-tauri/src/bin/taskdock.rs`。

**修改（后端接线）**：`db/mod.rs`（v76 迁移 + 4 设置项）、`lib.rs`（模块、19 命令、启动 watch/rest）、
`commands/backup.rs`（11 表）、`commands/settings.rs`（键/校验/钩子）、`mcp/permissions.rs`（16 能力）、
`mcp/tools.rs`（注册 + 分发）、`mcp/protocol.rs`（resources/prompts 方法）、`mcp/bridge.rs`（extras 注入）、
`Cargo.toml`（`[[bin]] taskdock` + `default-run`）。

**新增（前端）**：`src/components/capability/AgentAccessSection.tsx`、`agent-access.css`；
`src/components/capability/CapabilityCenterPanel.tsx` 增加 `agent` 子页；`src/lib/bridge.ts` 增加 19 个封装；
`src/locales/zh-CN/index.ts`、`en-US/index.ts` 增加约 70 条文案。

**文档**：`docs/agent-workspace/` 全套（含本报告、进度与测试计划）。

## 6. 已验证 / 未验证

**已验证**

- Rust 全库 `cargo check` 通过（0 error；本轮新增代码无错误）。
- 前端 `tsc --noEmit` 通过。
- 迁移仅追加 v76，不改已发布迁移；11 张新表登记备份；设置键加入白名单与校验。
- 四入口均调用 `agent_access::service` / `store` / `handoff`，未各自写 SQL；未新建第二套 Task/Knowledge/Project。

**未验证**

- 场景 A–F、权限拒绝、版本冲突、文件冲突、幂等、限流、并发写、性能基线。
- MCP 真实客户端、REST curl、CLI 独立启动、UI 真机视觉与窄窗。
- 安装包内 CLI 是否存在、端口冲突、CLI 与 UI 并发写 WAL。

## 7. 遗留风险

1. **运行时行为未知**：所有入口仅通过编译，未证明真实读写与审计链。
2. **内存敏感**：共享机器可用内存曾低至 1.2 GB，rustc 在 metadata 阶段 OOM；正式构建需空闲窗口。
3. **CLI 打包**：Tauri 安装包默认只带主二进制，`taskdock.exe` 需要额外打包配置或回退包装脚本。
4. **REST 常驻**：设置开启后随应用启动；端口占用失败只记日志，UI 会显示“未运行”，需人工换端口。
5. **文件同步边界**：只接受 `inbox/` 三类目录与白名单 kind；任何“改投影文件回写”的尝试都会被拒绝，
   这是设计约束，不是缺陷。

## 8. 结论

**部分通过（代码级）**：Phase 0–7 的实现与文档已落盘，Rust 与前端静态检查通过；但任务书要求的
“每个阶段真实测试 + 端到端验收”尚未执行，不能宣称整体验收通过。下一步按 [test-plan.md](test-plan.md)
在独立数据目录逐项执行，并以 `buildId + taskId` 记录真实验收结论。

## 9. 证据路径

- `tmp/agent-workspace-check.log`（cargo check 输出）
- `.git/taskdock-build-sched/logs/m-mwly1u9c-fff525.log`（最终调度任务日志）；`m-mwlxxth5-042e91.log`（首次通过记录）
- `tmp/agent-workspace-tsc.log`（tsc 输出）
- 本文档与 `docs/agent-workspace/` 其余设计文档

> 未执行项一律标注“未执行”，未使用“应该/理论上”替代证据；环境导致的 OOM 单独记录为资源阻塞，未计为代码缺陷。

## 10. 运行时验收更新（2026-11-18）

本节推翻 §6/§8 中“REST/CLI/交接完全未验证”的旧结论，保留原文作为历史记录。

**已真实执行并通过**

- CLI：`status`、任务 CRUD/完成、项目/计划/知识/决策查询、`search`、`context`、`sync` 全链路；
  版本冲突 exit 5、缺参 exit 2、不存在 exit 3、只读 exit 6、未初始化 exit 7。
- 文件协议：`inbox` 合法导入归档、非法信封归档 `_rejected`、冲突写入与 `resolved_db`、
  `sync export` 后 `scan` 防回环 `scanned=0`。
- REST：认证 401/Origin 403、`/status` 身份与入口、列表分页、任务详情、创建 + `Idempotency-Key`
  重放、`PATCH` 版本更新、旧 base 409 冲突、只读 403、撤销 Token 401、1.1 MiB 413、第 121 次 429、
  OpenAPI 30 条路径。
- 交接与报告：`smoke-rest → smoke-rest` create→accept→complete，revision 1→2→3，
  `status=completed`；目标不匹配接收被拒绝；关联 handoff 提交报告成功；活动日志含 `interface=rest`
  的 `task.create` / `task.update` / `rest.failed`。

**修复**

- `rest::start` 持有 `slot()` 锁后调用 `status()`，`status()` 再锁同一非重入 Mutex，启动自死锁；
  改为写入监听槽位后 `drop(guard)` 再取状态，并补 setup 阶段日志（提交 `66899ea`）。修复前 REST
  日志已出现但 setup 永不返回，MCP bridge 因此从未执行。
- REST 详情/更新路由 `seg(0)` → `seg(1)`（14 处），`PATCH` 支持从请求体读 `base_revision`；
  由外部定时提交 `f7c3eae` 一并入库（该提交同时包含其他任务改动，非本任务单独提交）。
- MCP 生命周期补充启动/设置/监听日志（`mcp/bridge.rs`），用于区分“未执行”与“启动失败”。

**未通过 / 阻塞**

- MCP 传输层：修复 REST 死锁后，setup 已越过 REST、恢复、剪贴板、暂存架与 AgentHub；随后在主窗口
  `WebviewWindowBuilder::build()` / 窗口辅助模块初始化处发生主线程栈溢出
  （`thread 'main' has overflowed its stack`，见 `tmp/agent-workspace-app-stderr5.log`、`-stderr8.log`）。
  使用独立 `WEBVIEW2_USER_DATA_FOLDER` 可走到托盘初始化，但仍在辅助窗口处溢出（`-stderr9.log`）。
  因此 bridge 未监听、无 `mcp-transport.json`；不是写文件失败，而是启动流程尚未执行到写文件。
- MCP 协议单测：测试二进制编译时系统分页文件不足（`os error 1455` / OOM），未执行。
- REST 响应缺 `revision` 字段；知识/决策 PATCH、并发双写、端口冲突未测。
- UI 真机视觉、安装包、性能基线未执行。

**结论**：**部分通过**。四入口中 CLI、文件、REST 已取得真实读写与冲突/权限证据，MCP 传输层与 UI/
安装包/性能仍未验收；不满足“整体端到端验收通过”。

## 11. MCP 端到端验收更新（2026-11-18 晚）

本节修正 §10「MCP 传输层未监听」的历史结论：用测试专用 `TASKDOCK_TEST_HEADLESS=1` 启动后端后，
MCP bridge 真实监听 `127.0.0.1:6946` 并生成 transport；stdio 客户端完成完整协议与业务闭环。

**已真实执行并通过**

- `initialize`：`protocolVersion=2025-06-18`、`serverInfo=task-dock/0.5.0`。
- `tools/list` 94 个、`resources/list` 10 个、`prompts/list` 5 个。
- `resources/read taskdock://manifest`：`capabilities` 16 项；`interfaces.mcp=true`、`rest=true`。
- 创建/读取/完成：`taskdock_create_task` → `d794e49f-…` revision 1；`taskdock_get_task` revision 1；
  `taskdock_complete_task(expected_revision=1)` → `status=completed`、revision 2、`completed_at` 写入。
- 统一活动：`taskdock_agent_activity(interface=mcp)` 返回 `task.create`、`task.complete` 两条，
  `agent_id=smoke-rest`、`resource_kind=task`。
- 权限：`smoke-readonly` 调用 `taskdock_create_task` → `-32002`；未知工具 → `-32602`；
  缺 `TASKDOCK_MCP_TOKEN` → 修复后 `-32001`（不可重试），修复前误为 `-32000 retryable=true`。
- `resources/read taskdock://tasks` 返回 5 条任务，均含 `revision`。
- 回归：REST GET/PATCH revision=2→3、旧 base 409；CLI `task get` revision=3、`task list` 每条含
  `revision`；`cargo check` exit 0，桌面/CLI 构建 exit 0。

**本轮修复**

- `Task` 增加可选 `revision`，由 `agent_access::service` 统一填充；旧 MCP 任务写工具补
  `bump_revision` 与 `agent_activity_logs`；manifest 能力从硬编码 12 项改为完整 16 项。
- `mcp/protocol.rs` 按 HTTP 状态映射 JSON-RPC 错误：401→`-32001`、403→`-32002`、400→`-32600`。

**仍未通过 / 阻塞**

- 正常 GUI 启动（不设置 headless）仍在主窗口 `WebviewWindowBuilder::build()` 处
  `thread 'main' has overflowed its stack`；headless 是测试开关，不能替代产品启动路径。
- UI 真机、安装包、`buildId` 正式验收、性能基线仍未执行；REST 知识/决策 PATCH、并发双写、
  端口冲突未测；CLI/文件 F8–F10 等未测。

## 12. GUI 运行与 UI 验收更新（2026-11-18 20:25）

本节修正 §11「正常 GUI 启动仍栈溢出」的历史结论；旧记录保留。

**已通过**

- 完整正常启动（不设置 headless、不跳过辅助窗口）：PID 96464，20s 后仍在运行、`Responding=True`、
  窗口标题 `Task Dock`、stderr 为空；日志含 `setup: 主窗口已创建`、窗口恢复、快捷键、托盘、
  MCP bridge 生命周期与 `Task Dock 启动完成`。旧 `thread 'main' has overflowed its stack` 未复现。
- 设置 `TASKDOCK_TEST_SKIP_AUX_WINDOWS=1` 的启动（PID 46284）同样通过。
- WebView2 CDP 真实窗口：主工作台、能力中心、`Agent 共享` 页与 5 个子页签均渲染；主页面 DOM
  可见导航、任务/资源概览与窗口控制。
- 能力中心首次动态 chunk 失败后「重试」成功；chunk 文件存在且 HTTP 200，属开发服务器瞬态。

**部分通过 / 不计为干净证据**

- `Agent 共享` 的「初始化共享空间」按钮真实触发并返回成功，但因多实例共用 WebView2 用户数据，
  命令落到了另一个实例的数据目录 `tmp\acceptance\files-workspace\round8\data`，创建了
  `ws_178919e0…` 与 `TaskDock-Agent-Workspace/`。这是测试隔离事故，不是本任务的验收数据；
  后续必须使用独立 `WEBVIEW2_USER_DATA_FOLDER`。误写目录保留待负责人确认。
- 500×700 窄窗截图发现键值表值列逐字换行；已改 `agent-access.css` 窄窗上下排列，未复验。
- 一次 CDP 会话进程于 20:21:22 崩溃（`0xc0000374` 堆损坏，WER APPCRASH）；隔离会话未复现。

**环境阻塞**

- 隔离 WebView2 UI 复测未执行：桌面二进制被失败构建移除，随后 3 次重建均因系统提交内存不足
  失败（`memory allocation failed` / exit 101 / 0xc0000409）。
- 全量 `cargo test --lib` 未完成：`src-tauri/src/project_hub/commands.rs:16` 在 test cfg 下
  `tauri::async_runtime::JoinError` 找不到（非本任务模块），随后 rustc 再次 OOM。
- CU 桌面控制 `PIP SDK SdkNotInitialized`，系统级视觉、DPI、托盘、通知、剪贴板未走查。
- 安装包、`buildId`、性能基线仍未开始。
