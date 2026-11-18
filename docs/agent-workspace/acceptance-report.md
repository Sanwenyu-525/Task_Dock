# 验收报告（v76 · Agent 共享工作空间）

- 日期：2026-11-18
- 范围：Phase 0–7 的代码落地与静态检查；运行时/真机验收未执行
- 构建版本：共享工作区（非集成快照）；未生成正式安装包
- 结论：**部分通过（代码级）；运行时验收证据不足**

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

补充事实：首次 `cargo check` 在类型检查已通过、写 metadata 阶段因机器可用内存不足被 rustc OOM 终止
（exit 101 / `STATUS_STACK_BUFFER_OVERRUN`），属运行期资源问题；内存恢复后同一命令通过。未发现代码错误。

未执行：Rust 单测、`cargo test`、前端单测、`npm run build`、Tauri 安装包、真机 UI 走查、场景 A–F、性能基线。

## 4. 代码审查问题清单

### P0

无。

### P1

| # | 现象 | 根因 | 影响 | 证据/状态 |
|---|---|---|---|---|
| P1-1 | 四入口运行时未验证 | 本轮只做静态检查 | 权限/版本/同步真实行为未知 | 见 [test-plan.md](test-plan.md) §8；待执行 |
| P1-2 | MCP resources/prompts 未用真实客户端验证 | 仅完成协议接线 | 客户端兼容性未知 | `mcp/protocol.rs`、`mcp/bridge.rs` 已实现；待 M10 |

### P2

| # | 现象 | 根因 | 影响 | 证据/状态 |
|---|---|---|---|---|
| P2-1 | 文件监听为 20s 轮询 | 避免无差别双向监听回环 | 导入有延迟 | `agent_access/watch.rs`；设计如此 |
| P2-2 | Context 仅关键词检索 | 阶段一不引入向量库 | 语义召回有限 | `agent_access/context.rs`；已在文档标注阶段二 |
| P2-3 | CLI 新 bin 与 Tauri 主二进制识别 | 打包器默认寻找 `task-dock` | 安装包内 CLI 可能缺失 | `Cargo.toml` 已设 `default-run`；回退方案 `task-dock --cli` 未实现 |
| P2-4 | REST 端口 47911 未实测冲突 | 未运行 | 可能与用户环境冲突 | `rest.rs` 启动失败仅记录错误，不回滚设置 |
| P2-5 | `sync.rs` 扫描结束更新时间戳失败会返回错误 | 本轮改为 `?` 传播 | 极端 IO 失败会让 scan 报错（此前是静默忽略） | 已修复为显式传播 |

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
