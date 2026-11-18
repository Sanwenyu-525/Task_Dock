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

- REST 详情/更新路由 `seg(0)` → `seg(1)`（14 处），`PATCH` 支持从请求体读 `base_revision`；
  由外部定时提交 `f7c3eae` 一并入库（该提交同时包含其他任务改动，非本任务单独提交）。
- MCP 生命周期补充启动/设置/监听日志（`mcp/bridge.rs`），用于区分“未执行”与“启动失败”。

**未通过 / 阻塞**

- MCP 传输层：桌面实例未执行到 `spawn_adapter`，无 `mcp-transport.json`，stdio 只能返回
  `-32000`；应用窗口 `Responding=False`。记为 `ENVIRONMENT BLOCKED`，不能宣称 MCP 端到端通过。
- MCP 协议单测：测试二进制编译时系统分页文件不足（`os error 1455` / OOM），未执行。
- REST 响应缺 `revision` 字段；知识/决策 PATCH、并发双写、端口冲突未测。
- UI 真机视觉、安装包、性能基线未执行。

**结论**：**部分通过**。四入口中 CLI、文件、REST 已取得真实读写与冲突/权限证据，MCP 传输层与 UI/
安装包/性能仍未验收；不满足“整体端到端验收通过”。
