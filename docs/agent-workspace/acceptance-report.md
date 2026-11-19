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

---

# 验收报告（v81 修订轮 · 代码级缺陷修复与协议统一）

- 日期：2026-11-19
- 范围：P0 文件导入权限边界、P1 冲突/Context/REST/Handoff、P2 文件协议/前端/CLI 一致性修复与真实验收
- 基线：`f7b999c`；交付提交：`fabdec6`（外部agent访问）、`db0d398`（文件工作区）、`ae7edda`（零散问题）、`1e8817c`（共享文件补丁修正）
- 构建：干净工作区 `D://Develop//task_dock-agent-snapshot`（checkout `1e8817c`）执行 `npm run tauri build`，**exit 0**；
  产物 `Task Dock_0.5.0_x64-setup.exe`（12.6MB，NSIS）、`task-dock.exe`、`taskdock.exe`
  （副本见 `tmp/acceptance/agent-access-v81-run4/artifacts/`）
- 端到端验收：`node scripts/acceptance-agent-access-v81.mjs`（独立数据目录与工作空间）→ **36/36 通过**
  （日志 `tmp/acceptance/agent-access-v81-run4/acceptance.log`）
- 结论：**PASS（功能链路）**；集成快照路径 BLOCKED（见第 6 节），Rust 全量单测仍被其他模块阻塞（见第 7 节）

## 1. 真实发现的问题（逐条核对源码确认存在）

| 编号 | 严重度 | 问题 | 证据位置（修复前） |
|---|---|---|---|
| F1 | P0 | `watch::start()` 用 `Principal::local(Source::File)`，而 `permissions::require()` 以 `!is_agent()` 判可信 → 文件来源等价本机用户 | `agent_access/watch.rs:60`、`permissions.rs:44` |
| F2 | P0 | 文件导入未按 kind 映射真实写能力，未授权文件直接落库 | `sync.rs::import_document`（无能力预检） |
| F3 | P0 | 文件自称的 `agent_id` 无校验即可被当作身份 | 旧 `ImportEnvelope` 无 `agent_id` 字段 |
| F4 | P1 | 前端传 `keep_local`/`accept_external`，后端只接受 `db`/`file`/`dismiss` → 冲突按钮必失败 | `AgentAccessSection.tsx:666` vs `sync.rs::resolve_conflict` |
| F5 | P1 | 冲突解决固定要求 `TasksWrite`，与真实资源类型无关；解决固定用 `conflicts[0]` | `sync.rs:634`、`AgentAccessSection.tsx:681` |
| F6 | P1 | Context 先 `require_any_read` 再逐类型 `require`，部分权限 Agent 整次请求失败 | `context.rs:188/290/348/408/444/469` |
| F7 | P1 | 近期变更用 `resource_id = project_id` 近似匹配，遗漏项目内任务/知识/交接 | `context.rs:609` |
| F8 | P1 | 中文关键词按空白切分，整句中文变成一个词，检索几乎不命中 | `context.rs::keywords` |
| F9 | P1 | REST 先 `spawn` 再登记句柄，端口占用时仍报 `running=true`；`apply()` 不处理端口变更 | `rest.rs::start/apply` |
| F10 | P1 | `reject_handoff`/`complete_handoff` 无操作者约束，无关 Agent 可拒绝/完成他人交接 | `handoff.rs::transition` |
| F11 | P2 | Markdown `task.update` 不解析任务 ID | `sync.rs::parse_external_document` |
| F12 | P2 | 导入幂等仅按内容 Hash 去重；「业务成功但归档失败」会重复写入 | `sync.rs::scan` 的 seen 判断 |
| F13 | P2 | 工作报告前端取自活动流（`agentAccessActivity`），数据源错误 | `AgentAccessSection.tsx:160` |
| F14 | P2 | CLI 文档与实现漂移（`sync pull/push`、`--action keep-db`），未知参数被静默忽略 | `cli-specification.md`、`cli.rs` |

## 2. 修复方法与关键函数

| 问题 | 修复 | 关键函数/文件 |
|---|---|---|
| F1 | 身份与来源解耦：`Identity::{LocalHuman, RegisteredAgent, FileImport, SystemInternal}`；`require()` 只对显式可信身份放行 | `agent_access/mod.rs`、`permissions.rs` |
| F2 | 目录策略 `agent_import_policies`（off/review/trusted）+ `authorize_file_import()` 三态判定；默认待审核、业务表零写入 | `permissions.rs`、`sync.rs::scan` |
| F3 | 文件 `agent_id` 仅为声明；目录绑定 Agent 时不一致直接拒绝 | `permissions.rs::authorize_file_import` |
| F4 | 统一枚举 `db|file|dismiss`，前端类型 `ConflictResolution`，CLI 保留旧写法兼容映射 | `bridge.ts`、`cli.rs`、`sync.rs` |
| F5 | 按冲突资源类型映射能力；解决前校验工作空间归属、文件 hash、目标存在、当前 revision，并重新鉴权 | `sync.rs::capability_for_conflict/resolve_conflict` |
| F6 | 拆分为 scope/授权类型/收集/过滤/排序/去重/预算/序列化；默认返回已授权部分，显式请求未授权类型报错 | `context.rs` |
| F7 | 近期变更按任务/知识/决策/交接/规划的业务关联求交集，再按权限过滤 | `context.rs::retrieve_recent_changes` |
| F8 | 中文按双字切片（2-gram）抽词，英文仍按空白切词 | `context.rs::keywords` |
| F9 | 先 `std::net::TcpListener::bind` 成功再登记 listening；新增 `RestRuntimeStatus`（stopped/starting/listening/failed/stopping）与真实状态上报 | `rest.rs::start/apply/stop/status` |
| F10 | 新增 `authorize_handoff_transition()`；报告必须挂在可访问交接上且项目一致 | `handoff.rs` |
| F11 | front matter 统一 `taskdock_id`（`task_id` 唯一别名，冲突报错），更新类必须带 `base_revision` | `sync.rs::parse_external_document/validate_envelope` |
| F12 | 导入前占幂等声明（路径+kind+内容 hash+主体），成功后置 `ok`，失败释放 | `sync.rs::claim_import/finish_claim`、迁移 v81 `agent_import_claims` |
| F13 | 工作报告改用 `agent_access_reports` | `AgentAccessSection.tsx` |
| F14 | 新增命令注册表 `COMMANDS`、`describe_cli_commands()`、`check_cli_documentation_contract()`、`validate_cli_arguments()`；`sync pull/push` 与 `--action keep-db|keep-file` 保留别名 | `cli.rs`、`cli-specification.md` |

新增迁移 **v81**：`agent_import_policies`、`agent_import_requests`、`agent_import_claims`（只追加）。

## 3. 修改文件

- Rust：`src-tauri/src/agent_access/{mod,permissions,sync,watch,commands,context,rest,handoff,cli,schema}.rs`、新增 `agent_access/tests.rs`；
  `src-tauri/src/db/mod.rs`（登记 v81）、`src-tauri/src/lib.rs`（注册 7 个新命令）。
- 前端：`src/components/capability/AgentAccessSection.tsx`、`agent-access.css`、新增 `AgentAccessSection.test.tsx`、
  `src/lib/bridge.ts`、`src/locales/{zh-CN,en-US}/index.ts`。
- 文档：`docs/agent-workspace/{permission-model,security,synchronization,handoff-protocol,context-engine,cli-specification,development-progress,acceptance-report}.md`。
- 验收脚本：`scripts/acceptance-agent-access-v81.mjs`（A–F 全场景，可重复执行）。

## 4. 实际执行的检查（命令 / 退出码 / 证据）

| 检查 | 命令 | 退出码 | 证据 |
|---|---|---|---|
| Rust 编译检查 | `npm run cargo -- check --lib` | 0 | `.git/taskdock-build-sched/logs/`（2026-11-19 21:13） |
| 前端类型检查 | `npm run typecheck` | 0 | 2026-11-19 21:10:55（42s） |
| 前端契约测试 | `npx vitest run src/components/capability/AgentAccessSection.test.tsx` | 0（9/9） | 2026-11-19 21:10:02 |
| 隔离工作区验收 | `npm run integrate -- task verify --id agent-shared-workspace --commit 1e8817c --cmd "npm run typecheck && npx vitest run src/components/capability/AgentAccessSection.test.tsx"` | 0（215.1s） | `tmp/integration/logs/verify-agent-shared-workspace-20261119T134847.log` |
| Release 构建 | `npm run tauri build`（工作区 checkout `1e8817c`） | 0 | 调度日志 `h-mwnm9au5-2106b9`；产物 `tmp/acceptance/agent-access-v81-run4/artifacts/` |
| 端到端验收 A–F | `node scripts/acceptance-agent-access-v81.mjs` | 0（36/36） | `tmp/acceptance/agent-access-v81-run4/acceptance.log` |

### 端到端验收明细（36/36）

| 场景 | 用例 | 结果 |
|---|---|---|
| A CLI Agent | 创建任务 / 查 revision / 带 base-revision 更新 / 过期 revision 被拒(CONFLICT) / 完成任务 / 只读 Agent 写被拒(FORBIDDEN) / 审计留痕 | 7/7 通过 |
| B 文件 Agent | 初始化隔离工作空间 / 默认策略进入待审核且业务表零写入 / 受信任目录导入成功 / 目录策略只含 tasks.write 时决策导入被拒 / 重复扫描不重复写入 / 导出快照 | 6/6 通过 |
| C MCP Agent | bridge 就绪 / initialize / tools/list(94) / resources/list(10) / prompts/list(5) / 创建任务 / 只读 Agent 写操作被拒 | 7/7 通过 |
| D REST Agent | 真实端口监听 / 未认证 401 / 无权限 403 / 授权查询 200 / 创建 201 / 幂等重放 replayed=true / 版本冲突 409 / Token 撤销后 401 | 8/8 通过 |
| E 双 Agent 交接 | A 创建交接 / 无关 Agent C 不能接收 / 目标 Agent B 可接收 / B 提交报告 / 授权范围内可查报告 | 5/5 通过 |
| F 并发 | 两个 Agent 读同一 revision，先到者成功、后到者 CONFLICT，库中保留先到者版本 | 1/1 通过 |

## 5. 未解决风险

1. **同一 OS 用户下的文件隔离**：普通文件与 CLI 无法形成强隔离边界；本模块只保证「不因目录可写而越权
   修改 TaskDock 资源」。真正隔离需受限 OS 用户或沙箱。
2. **文件导入默认待审核**是行为变更：依赖「放文件即入库」的脚本需先授权目录或人工批准。
3. **远程访问仍未实现**：REST 仅环回 + Bearer Token。
4. UI 视觉走查（320/400/600/1024 宽度、浅深主题、100%/125%/150% DPI）本轮未执行，未计入通过。

## 6. 集成快照路径 BLOCKED（非本任务代码问题）

`npm run integrate -- snapshot create --tasks agent-shared-workspace` 在 `src-tauri/src/db/mod.rs`、
`src-tauri/src/lib.rs`、`src/locales/{zh-CN,en-US}/index.ts` 冲突；整体 3-way 合并产生 63 个冲突文件。
根因：`integration` 分支基线 `8516cc7`（含 deveff 等 13 个任务）与 `main`（`f7b999c` 之后的提交）已深度分叉，
且 `agent-shared-workspace` 声明的写入范围覆盖整个仓库。`batch plan` 亦显示多个任务因写入范围交集互相阻塞。
按规范不擅自合并他人任务内容 → 本轮改为「在干净工作区构建交付提交 + 直接功能验收」，
正式安装包验收仍需集成负责人先解决分叉。**不得**把本报告的结论当作 Release 正式验收结论。

## 7. Rust 全量单测仍被其他模块阻塞

`npm run cargo -- test --lib agent_access` 在共享工作区编译失败于**其他会话在途改动**
`src-tauri/src/diagnostics/panic_hook.rs`（test cfg，E0597）与 `src-tauri/src/diagnostics/tests.rs`
（`WriterConfig.max_age_days` 缺字段），非本任务模块；本任务自身编译错误已清零。
本任务 Rust 用例位于 `src-tauri/src/agent_access/tests.rs`（18 例），待该模块负责人修复后随全量运行。

## 8. 复现方式

```bash
# 干净构建（本轮实际路径）
git worktree add --detach D:/Develop/task_dock-agent-snapshot 1e8817c
cd D:/Develop/task_dock-agent-snapshot && npm run tauri build

# 端到端验收（独立数据目录与工作空间，不触碰真实用户数据）
node scripts/acceptance-agent-access-v81.mjs --bin <release 目录>
```
