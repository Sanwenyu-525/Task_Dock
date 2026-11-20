# TaskDock Agent 时代产品战略与功能架构规划

| 项目 | 内容 |
|---|---|
| 文档状态 | **事实核对完成、待产品战略确认**（第二轮架构审计整改后；v1.0 的「生效/冻结」状态已撤销） |
| 版本 | v1.1（第二轮：跨模块审计、数据所有权核对、事实订正、矩阵重构） |
| 日期 | 2026-11-20（v1.0：2026-11-19） |
| 适用范围 | 桌面端 `src/`、Rust 后端 `src-tauri/src/`、移动端 `apps/mobile/`、Agent 接入、Relay 集成、个人目标推进 |
| 事实优先级 | 代码与可复现输出 > 测试/真机证据 > 文档。本文中标注 **[核对]** 的位置为 2026-11-19 源码实测核对结果；标注 **[核对²]** 的为 2026-11-20 第二轮审计实测结果 |
| 核对报告 | [AGENT_ERA_STRATEGY_FACTCHECK.md](AGENT_ERA_STRATEGY_FACTCHECK.md)（第一轮逐项证据 + 第二轮追加节） |
| 相关文档 | [ROADMAP.md](ROADMAP.md)、[RELAY_INTEGRATION.md](RELAY_INTEGRATION.md)、[AGENT_ADAPTERS.md](AGENT_ADAPTERS.md)、[../src/lib/featureCatalog.ts](../src/lib/featureCatalog.ts)、[project-hub/](project-hub/README.md)、[collab-center/](collab-center/README.md)、[developer-efficiency/](developer-efficiency/README.md)、[agent-workspace/](agent-workspace/README.md)、[../docs/adr/README.md](adr/README.md) |

> **第二轮审计说明（2026-11-20）**：本轮不是重新规划，而是跨模块审计、重复功能消除、架构边界
> 修订与文档同步。只处理架构、产品规划、数据所有权和文档，未开发新业务功能、未修改数据库
> 迁移、未执行大规模构建。v1.0 曾标注「生效（Phase 0 战略冻结基线）」——其中「Phase 0」与
> §9 的 S0–S6 阶段轴是两套编号（第一轮遗留冲突，现已统一为 S0–S6），且「冻结」宣告超出了
> 用户实际确认范围，故 v1.1 状态改为「事实核对完成、待产品战略确认」。§12 的 ADR-A01–A12
> 同步调整为 Proposed（见 [adr/README.md](adr/README.md)）。

---

## 0. 核心战略结论

### 0.1 产品定位

TaskDock 的长期定位：

**面向个人的 Agent 协作、目标管理与持续推进中枢。**

TaskDock 不应该成为又一个通用 Agent，也不应该成为一个简单的 Agent 监控面板。

它需要解决的是：

当一个人同时使用多个 Agent、模型、工具和项目时，如何让这些能力围绕人的目标持续、有序、可靠地工作。

### 0.2 核心分工

| 参与者 | 核心职责 |
|---|---|
| 人 | 制定目标、提供判断、处理关键决策 |
| TaskDock | 管理目标、上下文、授权、协调、验收和监督 |
| Relay | 负责跨 Agent 任务交接、执行协调、持久化执行与恢复 |
| 外部 Agent | 执行专业工作 |
| 本地操作系统 | 提供文件、应用、设备和本地执行环境 |

核心工作链：

目标提出 → 目标理解 → 任务拆解 → Agent 选择 → 任务执行 → 状态接续 → 结果验证 → 人工决策 → 目标完成。

### 0.3 最重要的产品原则

1. 不重复建设已经存在的模块。
2. 不创建第二套任务、项目和知识库系统。
3. 不在 TaskDock 内重写 Relay 的执行引擎。
4. 不要求用户只能使用 TaskDock 内置 Agent。
5. 不以 Agent 自己的完成声明作为最终验收依据。
6. 所有重要操作具备权限控制、审计和可追溯性。
7. 优先解决跨模块协作，而不是继续增加孤立功能。

---

## 1. Agent 时代的核心问题

本项目的产品设计围绕六种稀缺资源展开。

| 稀缺资源 | 人面临的问题 | TaskDock 应提供的能力 |
|---|---|---|
| 注意力 | Agent 太多，信息和通知太多 | 统一工作摘要、智能提醒、决策收件箱 |
| 上下文 | 不同 Agent 不知道历史背景 | 个人上下文中心、动态上下文装配 |
| 判断力 | 不知道什么事情值得做 | 目标管理、优先级、方案比较 |
| 信任 | 不知道 Agent 是否正确执行 | 权限、审计、证据、独立验收 |
| 持续性 | 会话结束后任务中断 | 持久化状态、任务接续、断点恢复 |
| 协调能力 | 不同 Agent 之间不能有效协作 | 能力路由、任务分配、交接和冲突仲裁 |

最终产品价值不是让用户管理更多 Agent，而是让用户需要管理的事情更少。

---

## 2. 现有项目能力审计

本节以 TaskDock 当前仓库文档和代码结构为依据。实现状态与验收状态分开记录，不把静态检查等同于真实环境验收。

### 2.1 已有基础设施

| 模块 | 当前实现 | 实现位置 **[核对]** | 主要缺口 |
|---|---|---|---|
| Agent 监控中心 | Agent 发现、Hooks、事件管线、实例/会话/运行监控 | `src/components/agents/`、`src-tauri/src/agents/`（28 文件）、`docs/AGENT_ADAPTERS.md` | 全功能适配器 10 个中真实联调仅 5 个（5/10），详见 §2.4 |
| Agent 行动中心 | Agent 事件聚合成「需人处理的动作」，支持需介入/通知/历史三层 | `src/components/actions/`、`src-tauri/src/actions/mod.rs`、`src-tauri/src/commands/actions.rs` | 是事件聚合视图而非审批数据库；与 Agent 监控面板分属不同目录与导航项，勿混为一处 |
| Agent 共享工作空间 | CLI、MCP、REST、文件投影、受控导入（v81 修订轮后权限边界、冲突契约、导入审核已闭环） | `src-tauri/src/agent_access/`、`src/components/capability/AgentAccessSection.tsx`、`docs/agent-workspace/` | 端到端 A–F 36/36 已通过（2026-11-19 v81）；UI 真机走查、`buildId` 正式安装包验收、性能基线仍为未验收，详见 §2.5 |
| Context Engine | 任务、规划、知识、决策、Skill、交接检索及预算控制 | `src-tauri/src/agent_access/context.rs`（入口 `context::build`） | 语义检索和更多上下文来源待扩展；与能力中心 `capability::context` 是两套装配系统，边界见 §3.2 |
| Agent Handoff | 交接状态机（五态 + revision 乐观并发）、工作报告、版本控制 | `src-tauri/src/agent_access/handoff.rs`、`src-tauri/src/agent_access/schema.rs` | 交接已入端到端验收（场景 E 5/5）；自动分工与冲突仲裁不存在，属 agent.builtin 长期方向 |
| Agent 权限系统 | 身份、Token、能力授权、项目范围、导入审核（v81 起 `Identity` 四类显式可信身份） | `src-tauri/src/agent_access/permissions.rs`、`src-tauri/src/mcp/` | 需要进一步形成统一人工决策流程；HTTP 接入 Token 仍明文存储，详见 §8.1 |
| Agent 审计 | 活动记录、访问记录、同步记录 | `src-tauri/src/agent_access/store.rs` + `schema.rs` | 跨模块操作链和统一查询体验仍可增强（三表无跨表 JOIN；v82 安全审计日志由其他任务在途，不重复建设） |
| 能力中心 | 知识库、Skill、MCP、上下文（配置化装配）、配方 | `src-tauri/src/capability/`、`src/components/capability/` | 尚未形成统一能力调度闭环；「Agent 能力目录」（调度元数据）不存在，见 §5 A07 |
| 项目中枢（Project Hub） | 项目根收敛（v78）、目标/能力/交付物/版本/事件 11 张新表、最小读写闭环（3 命令）、四视图 UI、自然语言创建 | `src-tauri/src/project_hub/`（4 文件）、`src/components/roadmap/ProjectHubPanel.tsx`、`docs/project-hub/` | S5 既有命令切服务（写路径统一）未开始；局部修订/版本回滚落库、真实旧库升级、五模式验收未做；结论「部分通过」 |
| 规划中心（计划容器） | 用户项目 CRUD、功能/里程碑/看板、进度（v78 起 `planning_projects` 收敛为计划容器） | `src-tauri/src/db/mod.rs`（`planning_*` 五张表，v18）、`src/components/roadmap/` | 旧写路径与 `project_hub_*` 并存未统一；MCP 授权仍直接用 `planning_projects.id` |
| 协作中心（Collab Center） | 需求/Bug/方案/审批（`plans.review` 本机用户）/可视化/证据/版本/AI 任务/审计 9 表 + 47 IPC + 26 MCP 工具 | `src-tauri/src/collab/`（14 模块，v77）、`src/components/collab/`、`docs/collab-center/` | CLI/REST 对等接入受阻；真实 UI 边界/错误态走查未完成；featureCatalog 无对应条目（见 §5 目录覆盖缺口） |
| 开发效率中枢（Dev Workbench） | 交接包（`dev_handoff_packs`）、验收记录（`dev_acceptance_records` 只追加）、Agent 完成轮次待验收 | `src/components/workbench/DevWorkbenchPanel.tsx`、`src-tauri/src/commands/dev_workbench.rs`、`docs/developer-efficiency/` | 真机验收（R2-1）未执行；verification=unverified；与 agent_access 交接是两套系统（见 §2.6 矩阵） |
| 工作流 | 白名单动作编排、执行状态、历史记录 | `src-tauri/src/workflows/`、`src/components/workflows/` | 不是通用多 Agent 编排器 |
| 移动端 | 采集、同步、文件互传、设备配对 | `src-tauri/src/mobile_sync/`、`apps/mobile/` | Agent 任务接续和审批协同待扩展 |

### 2.2 三个必须区分的现有模块

#### A. Agent 监控中心

代码主要涉及：

- `src/components/agents/`
- `src-tauri/src/agents/`
- `docs/AGENT_ADAPTERS.md`

职责：观察外部 Agent 正在做什么、处于什么状态、是否需要人工介入。

它不是 Agent 执行调度器。

**[核对]** 管线确为有界管线：队列容量 1024（`pipeline.rs:30`）、信号量背压（`pipeline.rs:400`）、过载返回 `AppError::Overloaded`（`pipeline.rs:933-960`），HTTP 层对应 503 + `Retry-After`（`http_ingest.rs:244,252`）。`waiting`/`failed`/`completed` 等关键状态不合并（`pipeline.rs:376-378`，测试 `pipeline.rs:1763-1784`）；`origin` 由服务端依据 `agent_sources.category` 与 transport 判定，客户端声明不采信（`agents/mod.rs:564-574`）。

#### B. Agent 共享工作空间

主要涉及：

- `src-tauri/src/agent_access/`
- `src/components/capability/AgentAccessSection.tsx`
- `docs/agent-workspace/`

职责：让外部 Agent 通过统一接口访问 TaskDock 的项目、任务、知识、决策、上下文和交接数据。

这是 Agent 与 TaskDock 共享信息的基础设施。

已有 CLI、MCP、REST、文件协议，不应再创建另一套类似接口。

**[核对]** 四种入口均真实存在：CLI 为独立 Cargo bin（`src-tauri/Cargo.toml:15-17` → `src/bin/taskdock.rs`）、MCP 工具集（`agent_access/mcp_tools.rs:45`）、REST 30 条路由（`agent_access/rest.rs:42-79`）、文件投影（`agent_access/projection.rs:188`）。受控导入的权限判定在后端（`permissions.rs:113-141`、`551-641`），未授权一律拒绝并进入待审核队列，不因来源是文件而放行。

当前需要继续验证第三方 Agent 的真实客户端兼容性、完整交接、多入口稳定性和长时间运行表现。

#### C. Relay

主要涉及：

- `docs/RELAY_INTEGRATION.md`
- 未来的 Relay Adapter。

职责：外部执行系统之间的任务协调、执行状态管理、任务接续和恢复。

当前集成文档属于预研设计，不能将已有 MCP 或 Agent 监控功能算作 Relay 集成。

**[核对]** 全仓 `src-tauri/src/` 与 `src/` 内**无任何 Relay 服务端、客户端连接器或协议实现**；`docs/RELAY_INTEGRATION.md` 自述为「预研稿 R0–R3」，且 R0–R3 当前均为目标态设计，尚未实施。

### 2.3 现有功能状态的重要判断

当前有两个长期方向尚未真正实现：

1. `agent.builtin`：内置 Agent 的目标推进与任务接续，当前没有完整执行循环。
2. `agent.relay`：Relay 集成，目前以预研为主。

这两项不应立即开始独立开发。

应先完善已有的上下文、交接、权限和验收基础，再决定执行能力由 Relay 还是内部协调器承担。

**[核对]** 两项在 `docs/ROADMAP.md`（Agent 扩展分区）与 `featureCatalog.ts`（`agent.builtin` / `agent.relay` 条目）中均为 `planned`，与本文判断一致（2026-11-20 复测仍为 planned；目录计数 62 = 33 + 24 + 5 + 0）。`docs/ROADMAP.md`「近期推荐开发顺序」另有明确约束：「先冻结协议、审批与信任模型，再做最小执行闭环；**不得以行动中心或 MCP 的现状宣称已完成**」。

### 2.4 适配器真实联调状态 **[核对²]**

已实现 **21 个**适配器：10 个全功能（Codex、Trae、WorkBuddy、Qoder、OpenCode、DSH、ZCode、Claude Code、Cursor、Gemini CLI，`managed.rs` `all_adapters()` 注册表）+ 11 个仅发现型（Windsurf、Cline、Roo Code、Continue、Augment、Copilot、Antigravity、Kiro、Aider、OpenHands、OpenClaw，`discovery_only.rs`）。

**真实联调通过 5 / 10**（Codex、WorkBuddy、Qoder、DSH、OpenCode），通用桥接 bridge 亦有真实事件。

> **统计口径更正（2026-11-20）**：第一轮及 `AGENT_COVERAGE_MATRIX.md` 旧版写「5 / 7」。分母 7
> 是 Claude Code / Cursor / Gemini CLI 落地前的全功能适配器数，属**历史统计**；当前注册表为
> 10 个全功能适配器，分子不变，故现行口径为 **5 / 10**。两个数字都真实，只是统计时点不同；
> 现行引用一律用 5/10，历史记录保留于矩阵与第一轮核对报告。

未真实联调的全功能适配器 **5 个**：Trae（库内仅 `taskdock-selftest-trae` 自测事件，2026-11-04 判假阳性）、ZCode、Claude Code、Cursor、Gemini CLI。

判定口径以 `AGENT_COVERAGE_MATRIX.md` 为准；代码层同样严格——`managed.rs` 的 `source_health` SQL 强制 `e.origin = 'real'`，仅凭 `verified` 位而无 `origin=real` 证据时判为假阳性。**不得以适配器文件已落地宣称接入完成。**

### 2.5 Agent 共享工作空间验收证据分项 **[核对²]**

依据 `docs/agent-workspace/acceptance-report.md`（含 v81 修订轮，2026-11-19）逐项划分，**不得将局部通过扩大为整体通过**：

| 验收项 | 状态 | 证据 |
|---|---|---|
| CLI 真实验收 | ✅ 通过 | §10（status/CRUD/项目/知识/决策/search/context/sync、错误码 2/3/5/6/7）+ v81 场景 A 7/7 |
| REST 真实验收 | ✅ 通过 | §10（401/403/413/429/幂等/409/撤销、OpenAPI 30 路径）+ v81 场景 D 8/8 |
| 文件投影真实验收 | ✅ 通过 | §10（inbox 导入/冲突/防回环）+ v81 场景 B 6/6；v81 起默认待审核，业务表零写入 |
| MCP 协议端到端测试 | ✅ 通过 | §11（`TASKDOCK_TEST_HEADLESS=1` 首验：tools 94 / resources 10 / prompts 5）+ v81 场景 C 7/7（Release 二进制 `--mcp-server` 模式，非 headless） |
| GUI 正常启动 | ✅ 通过 | §12（2026-11-18 20:25：完整正常启动 PID 96464、主窗口 + 托盘 + MCP bridge 生命周期；旧栈溢出未复现） |
| 第三方客户端兼容性 | ❌ 未执行 | test-plan M10（Claude Code / Codex / Cursor / Trae 真实客户端）未跑 |
| 正式安装包 | ⚠️ 部分 | v81 干净工作区 `npm run tauri build` exit 0 产出 NSIS 安装包（基于交付提交 `1e8817c`）；**安装/升级/卸载与 `buildId` 正式验收未执行**；集成快照路径 BLOCKED（integration 分支与 main 深度分叉） |
| 性能基线 | ❌ 未执行 | — |
| 真机 UI 验收 | ❌ 未执行 | 隔离 WebView2 复测被环境阻塞（内存不足）；§12 的 CDP 窗口渲染仅是部分证据 |

**运行环境区分**：§11 的 MCP 首验使用 `TASKDOCK_TEST_HEADLESS=1`（测试开关，**不是产品能力**，不能替代产品启动路径）；§12 为正常桌面运行环境；v81 端到端为 Release 二进制 + 独立数据目录 + 真实 GUI/`--mcp-server` 进程。引用验收结论时必须注明所依据的运行环境。

**当前总结论：功能链路部分通过。** 四入口的业务链路与权限边界已有真实证据；整体端到端验收、第三方客户端、正式安装包、性能、真机 UI 仍未闭环。

### 2.6 模块职责矩阵（第二轮审计修订）**[核对²]**

第一轮审计遗漏了项目中枢、协作中心、开发效率中枢三个模块。本轮逐模块核对文档与代码后，全量职责矩阵如下（实现位置与缺口均有 `文件:行号` 级证据，见核对报告第二轮追加节）：

| 模块 | 唯一职责 | 已有能力 | 缺失能力 | 是否与其他模块重叠 |
|---|---|---|---|---|
| 项目中枢 | 目标与项目管理：项目唯一根（`workspace_projects`）+ 计划容器（`planning_projects`）+ 目标（`project_goals`） | v78 迁移（11 张新表 + 3 张旧表加列 + collab 兼容列）、3 个 `project_hub_*` 命令、四视图 UI、自然语言/模板/手动创建、四项进度分列、能力准备度双指标；TS 领域层 9 文件 | S5 既有命令切服务（写路径统一）、局部修订/版本回滚落库、能力缺口写入、任务同步、交付物反馈、真实旧库升级、五模式验收 | 与规划中心同表族（收敛不重复）；能力资源引用能力中心；工作空间是执行环境。**不得另建 Agent 目标数据库**（`project_goals` 已是目标归属） |
| 协作中心 | 需求→方案→审批→任务→证据→验收 的可追溯业务链路 | 9 张 `collab_*` 表（v77）、47 IPC、26 MCP 工具、`plans.review` 本机用户审批（MCP 不暴露审批工具，服务端硬约束）、可视化引擎（白名单渲染）、证据附件（sha256 幂等）、版本只增不减 | `workspace_project_id` 仅落 DDL + 回填，**服务层未接线**（半迁移）；CLI/REST 对等接入（受阻）、UI 边界/错误态走查、10 个已注册 IPC 无前端调用方、目录登记 | 审批 ≠ 行动中心（事件聚合视图）≠ `dev_acceptance_records`（开发验收）：三类「审批/验收」对象不同，不合并也不复制 |
| 开发效率中枢 | 开发现场、交接包、验收工作台（人类开发者视角） | `dev_handoff_packs`（12 节模板 + 版本追加 + secret scan）、`dev_acceptance_records`（只追加）、Agent 完成轮次待验收（只读候选）、`dws_*`（v63）、git 只读探测 | 真机验收（R2-1 自 2026-11-13 未执行）、Git/测试结果归集、Worktree 协调中心（未开始） | 交接包 ≠ `agent_handoffs`（五态状态机，Agent↔Agent）；验收记录 ≠ `tmp/integration` 台账（唯一集成是 `dws_build_trace` 只读解析） |
| Agent 监控 | Agent 状态观测（不做调度） | 有界管线（1024 队列 + 背压）、21 适配器、会话/运行监控、origin 服务端判定 | 5 个全功能适配器真实联调；App Server 路线 | 身份体系与 Agent Access 分离（`agent_sources` vs `mcp_agents`，未混用）；行动中心是它的消费方 |
| Agent 共享工作空间 | 外部 Agent 数据访问：四入口 + 权限 + 审计 + 交接 + 上下文 | CLI/MCP/REST/文件投影、权限五要素、审计三表、交接状态机、Context Engine、导入审核（v81）、端到端 36/36 | UI 真机走查、`buildId` 正式安装包验收、性能基线、第三方客户端兼容性 | `AgentAccessSection` 管理面寄宿能力中心页面（UI 层复用，数据层独立）；`context::build` 与 `capability::context` 边界见 §3.2 |
| 行动中心 | 跨模块「需人处理事项」聚合入口 | 三层分类（失败/授权+等待输入/完成）、幂等确认、去重、全局 SQL 计数、跳转 | 不承载审批决定本身（审批在各业务模块） | 开发工作台、Agent 面板复用其数据；**不是另一套审批数据库**（无独立表，SQL 分类自 `agent_events`/`agent_runs`） |
| 能力中心 | 知识、Skill、外部 MCP、配置化上下文、配方 | 10 张 `capability_*` 表、五个子页、`taskdock_get_task_context` MCP 工具、配方执行 | 统一能力调度闭环、「Agent 能力目录」（调度元数据）不存在 | `capability_contexts`（配置化装配，maxChars 截断）与 `agent_access::context`（权限+预算装配）是两套系统，见 §3.2；配方 ≠ 工作流（白名单编排） |
| Relay | 外部执行协调的权威状态与执行恢复 | 预研设计（R0–R3 目标态设计，未实施） | 全部实施（无任何协议/连接器代码） | 与 TaskDock 执行层边界见 §4.5；**不得因预研文档存在而宣称集成开始** |---

## 3. 产品功能体系

将 Agent 时代的功能分成六个业务域。

### 3.1 目标与规划域

核心问题：人想做什么，为什么做，下一步做什么？

主要功能：

- 长期目标管理。
- 目标拆解。
- 阶段与里程碑。
- 任务依赖。
- 目标优先级。
- 进度追踪。
- 阻塞识别。
- 目标偏离检测。
- 目标调整建议。

设计要求：

复用现有规划中心、任务系统、项目工作空间。

不新建一套独立的任务数据库。

长期目标应当能够关联现有项目、里程碑、功能和任务。

对于没有项目属性的个人目标，可以在后续评估是否需要轻量目标实体，但必须先证明现有规划模型无法承载。

**[核对]** 规划中心现有五层实体齐全：`planning_projects` / `planning_milestones` / `planning_features` / `planning_feature_steps` / `planning_activity`（`db/mod.rs:685-757`）。功能状态与步骤进度相互独立，**不由步骤完成率推断状态**（`commands/planning.rs:9`）。

### 3.2 上下文与知识域

核心问题：Agent 如何知道事情的背景？

主要功能：

- 个人偏好。
- 项目背景。
- 技术约束。
- 关键决策。
- 历史任务。
- 工作现场。
- 当前进度。
- 历史问题及解决方案。
- Skill 和工具使用规范。
- 动态上下文包。

重点扩展 Context Engine。

**[核对]** 现有装配入口为 `agent_access::context::build(db, principal, req)`（`context.rs:1022`），入参为 `ContextRequest { task, task_id, project_id, agent_id, session_id, budget_tokens, kinds, format }`。当前已支持的来源共 7 类：`plan` / `task` / `knowledge` / `decision` / `skill` / `handoff` + 近期变更；预算控制真实（`DEFAULT_BUDGET=6000`、`MAX_BUDGET=24000`、`apply_context_budget`），输出含 `truncated` / `estimated_tokens` / `kept_items`。

> 注：设计稿 `docs/agent-workspace/architecture.md:90` 记法为 `build_agent_context(...)`，该名称在 Rust 源码中**不存在**（全仓仅该文档一处命中）。引用真实符号时请用 `agent_access::context::build`。

扩展方向（逐步支持）：

1. 根据目标、项目、任务识别上下文范围。
2. 检索相关任务、规划、知识和决策。
3. 获取当前 Agent 的工作状态。
4. 获取相关交接与历史报告。
5. 提取有效约束和已经确认的决策。
6. 识别过期、冲突和不确定的信息。
7. 根据 Token 预算排序和裁剪。
8. 输出带来源和版本信息的上下文包。

上下文必须有来源、更新时间、适用范围和可信状态。

不允许把模型推测的内容直接当成个人事实或项目决策。

**[核对²] 两套装配系统的边界（必须区分，不得合并也不得混称）**：仓库当前存在两个「上下文装配」实现——
① `agent_access::context::build`（本文所指 Context Engine）：面向**外部 Agent**，按身份权限过滤、按
token 预算（6000–24000）裁剪，来源 7 类，输出带 `truncated/estimated_tokens/kept_items`；
② `capability::context`（能力中心「上下文装配」子页）：面向**用户配置**，`capability_contexts` 表存
配置化 Profile（`context.rs` `assemble_impl`），按 maxChars（默认 12000）截断，经 MCP 工具
`taskdock_get_task_context`（`mcp/capability_tools.rs:50`）也可被 Agent 消费。两者目标不同：
前者是「按 Agent 身份自动装配」，后者是「按用户配方装配」。A06 的扩展对象是 ①；② 的配方化能力
可作为 ① 未来 `kinds` 扩展的输入来源，但**不建第三套装配引擎**。

### 3.3 Agent 能力与调度域

核心问题：应该让哪个 Agent 做这项工作？

功能：

- Agent 能力目录。
- Agent 能力描述。
- 接入方式识别。
- 可用状态。
- 任务类型匹配。
- 项目访问权限。
- 运行成本统计。
- 历史完成率。
- 任务执行时间。
- 失败与返工情况。
- 人工指定与自动推荐。

特别注意：

现有 `mcp_agents` 是访问身份体系，`agent_sources` 是监控来源体系。

两者不能直接合并为同一张业务表。

后续应在不破坏现有身份和来源模型的基础上，增加统一的能力描述和调度元数据。

Agent 必须区分三种能力：

- Observe：只能观察运行状态。
- Invoke：可以向 Agent 提交任务或调用能力。
- Control：可以控制执行、暂停或恢复。

不能因为某个 Agent 可以被监控，就认为它可以被 TaskDock 调度。

**[核对]** `mcp_agents`（接入身份 + Token + scope + 撤销）位于 `db/mod.rs:1212`，由 `mcp_agent_grants` / `mcp_agent_capabilities` 及交接、工作报告、审计表以外键引用；`agent_sources`（监控来源注册表）位于 `db/mod.rs:73`，被 `agent_sessions` / `agent_runs` / `agent_events` 以 `source_id` 引用。两者主键空间与外键方向完全独立，`agent_sources` 无任何 relay 字段，**确认未混用**。

**[核对²] 三种能力与现有实现的映射（明确不存在的能力不得推断存在）**：

| 能力 | 现有承载 | 现状 |
|---|---|---|
| Observe | `agent_sources` + `agent_sessions` / `agent_runs` / `agent_events`（Hooks/插件/HTTP 事件） | ✅ 已实现；**在线 ≠ 可调度**：`agent_sessions` 的存在只证明事件曾上报 |
| Invoke | `mcp_agents` + `mcp_agent_capabilities`（数据访问与写入授权）；Relay `DELEGATE_AI`（R1 目标态，未实施） | 部分实现：数据读写与任务创建/交接可 Invoke；「向 Agent 提交任务让其为用户执行」的通道不存在 |
| Control | （无） | ❌ **不存在任何实现**：暂停/恢复/中断外部 Agent 执行的能力在 TaskDock 与现有代码中均没有；Relay control-requests 属 R2 目标态。不得从监控在线状态或 Invoke 授权推断 Control 可用 |

A07 建立能力目录时必须显式登记三能力的判定依据（来源表 + 授权记录 + 用户确认），不允许运行时推断升级。

### 3.4 持续执行与任务接续域

核心问题：任务如何跨越会话、Agent 和时间持续进行？

功能：

- 任务持久化。
- 工作进度检查点。
- 上下文快照。
- 交接包。
- 任务接收和拒绝。
- 工作报告。
- Agent 切换。
- 失败恢复。
- 多 Agent 协作。
- 执行结果归集。

现有 `agent_handoffs` 和 `agent_work_reports` 是基础。

**[核对²] 交接能力的已有/未有必须准确区分（不得把已有功能登记成待开发）**：

- **已有**：交接状态机（`agent_handoffs` 五态 + `authorize_handoff_transition` 操作者约束 + `base_revision` 乐观并发）、工作报告（`agent_work_reports`，须挂在可访问交接上且项目一致）、版本控制（`agent_resource_revisions` + 全部外部写 `expected_revision`）、四入口暴露（MCP `taskdock_create_handoff`/`taskdock_list_handoffs`、CLI、REST `POST /api/v1/agents/handoffs/{id}/accept`、Tauri）。双 Agent 交接已入端到端验收（v81 场景 E 5/5）。
- **未有**（属 `agent.builtin` 长期方向，不在本模块冒进）：自主执行循环、自动分工、冲突仲裁、失败后自动重新分配。
- **消歧**：仓库存在三种「交接」实体——`agent_handoffs`（Agent↔Agent 状态机）、`dev_handoff_packs`（人类开发者→Agent 的内容包，无状态机）、collab 方案审批（`plans.review`）。三者对象与语义不同，不得混用名称；跨系统桥接（如「Agent 侧打开交接包」）立项前需先定义桥接策略。

**[核对]** 两表 DDL 位于 `src-tauri/src/agent_access/schema.rs:129` 与 `:161`（迁移 v76，经 `db/mod.rs:2119` 挂载到主迁移链），而非 `db/mod.rs` 的 MIGRATIONS 正文。交接状态机 `pending → accepted | rejected | completed | cancelled`，迁移合法性由 `authorize_handoff_transition`（`handoff.rs:227-271`）校验：仅目标 Agent 可 accept/reject/complete，仅创建方可 cancel，并发以 `base_revision` 做乐观校验。

TaskDock 负责管理协作信息和业务目标；Relay 负责其自身执行任务的权威状态和恢复机制。

两者不能重复实现同一个执行状态机。

### 3.5 信任与验收域

核心问题：Agent 做的事情是否正确，能否安全地继续？

功能：

- Agent 权限分级。
- 项目和资源级授权。
- 操作前确认。
- 待审批事项。
- 结果证据。
- 独立验收。
- 文件版本记录。
- 操作审计。
- 异常追踪。
- 回滚与补偿。

核心原则：

执行成功 ≠ 验收通过 ≠ 业务目标完成。

Agent 自己不能决定自己是否通过验收。

Relay 的 Review 与 Verification 仍由 Relay 持有权威；TaskDock 的本地操作审批与验收由 TaskDock 管理。

TaskDock 不能通过复制审批数据建立第二套权威。

### 3.6 主动服务域

核心问题：能否减少用户主动管理 Agent 的负担？

功能：

- 项目停滞检测。
- Agent 长时间无响应检测。
- 任务阻塞提醒。
- 目标偏离提醒。
- 任务条件满足提醒。
- 每日工作简报。
- 自动汇总工作成果。
- 生活事务辅助。
- 重要事项追踪。

所有主动监测必须具有范围、频率、授权、暂停和停止机制。

不允许无边界后台扫描。

---

## 4. 目标架构

### 4.1 总体架构

```text
                  人
                  │
        ┌─────────┴──────────┐
        │                   │
      桌面端               移动端
        │                   │
        └─────────┬─────────┘
                  │
           TaskDock 控制中枢
                  │
    ┌─────────────┼─────────────┐
    │             │             │
  目标管理      上下文管理     能力目录
    │             │             │
    └─────────────┼─────────────┘
                  │
           任务协调与接续
                  │
    ┌─────────────┼─────────────┐
    │             │             │
 权限与审批     验收与证据     运行审计
    │             │             │
    └─────────────┼─────────────┘
                  │
             执行连接层
                  │
    ┌─────────────┼─────────────┐
    │             │             │
 外部 Agent     Relay       本地工具
    │             │             │
    └─────────────┴─────────────┘
```

### 4.2 四种不同的 Agent 交互通道

必须明确区分：

| 通道 | 方向 | 作用 |
|---|---|---|
| Agent Monitor / Hooks | Agent → TaskDock | 状态观测 |
| Agent Access / MCP / CLI / REST | Agent ↔ TaskDock | 访问 TaskDock 数据和能力 |
| Relay Adapter | TaskDock ↔ Relay | 任务委托、执行状态与控制 |
| 内部协调器 | TaskDock 内部 | 目标推进和决策协调 |

MCP 是能力访问协议，不是完整的多 Agent 执行引擎。

Hooks 是状态采集方式，不是任务调度协议。

Relay 是执行协作系统，不是 TaskDock 的另一个界面。

### 4.3 数据所有权

| 数据 | 唯一权威 |
|---|---|
| TaskDock 本地项目、规划和任务 | TaskDock |
| TaskDock 知识、决策和上下文 | TaskDock |
| Agent 接入身份与权限 | TaskDock |
| 外部 Agent 原始会话 | 对应 Agent 平台 |
| TaskDock 的 Agent 观测数据 | TaskDock |
| TaskDock 交接包和本地工作报告 | TaskDock |
| Relay 执行任务、Run、Step、Attempt | Relay |
| Relay 审批、验证和完成记录 | Relay |
| Relay 产物及版本 | Relay |
| 本机文件和操作系统资源 | 操作系统 |

跨系统数据采用引用、投影和受控同步，不复制整套数据库。

**[核对²] 本地「项目根与数据所有权」已由 v78 落地（2026-11-18 提交 `e68d1e7`），本轮逐项核对结论**：

| 问题 | 核对结论 | 证据 |
|---|---|---|
| 1. 项目唯一根 | **`workspace_projects`（A 方案，2026-11-18 用户已确认）**。v49 创建、v57 重建、v78 加 `description/goal/target_date/active_plan_id` 四列 | `db/mod.rs:1611`；`project_hub/schema.rs:13-16` |
| 2. 规划容器与项目的关系 | `planning_projects`（v18）降为**计划容器**：v78 加 `workspace_project_id`（计划→项目）+ `is_active` + 单 active 部分唯一索引；反向 `workspace_projects.active_plan_id`（项目→当前计划）。**双向弱引用，无真实外键**（避免备份恢复顺序违例）。回填：同 ID 建项目行，UUID 冲突用 `plan-` 前缀 | `project_hub/schema.rs:18-21,210-242,260-262`；`project_hub_schema.rs` 集成测试 4/4 |
| 3. 协作中心的项目关联 | v77 的 6 张 collab 表保留 `project_id`（计划 ID 语义，外键仍指 `planning_projects`），v78 加 `workspace_project_id` 兼容列 + 回填。**DDL 已落地、collab 服务层未接线（`grep workspace_project_id` 于 `src-tauri/src/collab/` 零命中）——半迁移状态，接线完成前不得宣称已统一** | `project_hub/schema.rs:190-207,264-298`；`collab/actor.rs:167-176` |
| 4. 任务的唯一数据源 | `tasks` 表唯一；v78 `task_plan_links` 关联任务与计划、`task_capability_links` 关联任务与能力；项目创建单事务写同一 `tasks` 表，无第二套任务表 | `project_hub/schema.rs:171-188`；`project_hub/service.rs:849,857` |
| 5. Agent 的项目授权范围 | MCP 规划工具仍接收 `planning_projects.id`，服务层先解析 `workspace_project_id` 再做项目授权（对外 ID 不变）；`agent_access` 侧以 `mcp_agent_grants` 项目级授权。**MCP 直查 `planning_projects` 的旧路径尚未切服务层** | `project-hub/04-数据模型与迁移.md` §12.3 配套 3；`mcp/auth.rs:339` |
| 6. Relay 项目与本地项目的映射 | **未实现**（无 Relay 代码）。目标态：R1 链接表（TaskDock task ↔ Relay task/run）+ 显式确认映射；禁止标题相似度自动关联 | `RELAY_INTEGRATION.md` R1、§4.4 红线 5 |
| 7. 删除、归档、解除关联 | 删除 workspace 项目级联 v78 子表与 collab 兼容列；`planning_projects` 只级联计划域（features/milestones）；共享能力/知识库/Skill/MCP **只解绑不删除**；任务永不随项目删除；归档不删除 | `project-hub/04` §12.3 配套 6；`project_hub_schema.rs` 级联测试；`collab/05:229` |

### 4.4 关键架构红线

1. 不在 TaskDock 重写 Relay Worker、租约、围栏和执行恢复。
2. 不让 TaskDock 与 Relay 同时成为同一 Run 的写入权威。
3. 不将 Agent 会话结束自动转换成任务完成。
4. 不把 `agent_sources`、`mcp_agents` 和 Relay 执行身份混为一谈。
5. 不通过标题相似度自动关联不同系统中的项目或任务。
6. 所有跨系统写入必须有幂等键、版本校验和回执。
7. 所有权限判断必须在后端完成。
8. 不将未经授权的本地文件访问暴露给 Agent。

### 4.5 两层协调边界：TaskDock 目标层 vs Relay 执行层

**[核对²]** 现状：Relay 仅有 R0–R3 目标态设计（预研），无任何代码；下表是集成时的**边界契约**，两边不得同时成为同一执行过程的写入权威：

| | TaskDock 目标层协调（权威：TaskDock） | Relay 执行层协调（权威：Relay） |
|---|---|---|
| 协调对象 | 用户目标、项目规划、任务分配决策、Agent 能力选择、人工审批、业务验收 | Run 生命周期、Step / Attempt、Worker、执行租约、执行恢复、跨 Agent 执行交接 |
| 数据 | `project_goals` / `planning_*` / `tasks` / `dev_acceptance_records` / `agent_handoffs` | Relay 侧 Task / Run / Review / Artifact（TaskDock 只持可重建只读投影） |
| 状态转换 | 交接五态（`agent_handoffs`）、任务两态（pending/completed）、验收结论（人工 verdict） | 控制请求 PENDING/APPLIED/REJECTED/SUPERSEDED、Run 状态迁移 |
| 写入规则 | TaskDock 不写 Relay 的 Run/Review/Artifact | Relay 不写 TaskDock 的目标/任务/验收记录；TaskDock 任务不因 Relay 事件自动置完成 |
| 恢复语义 | UI 现场恢复（`workspace_snapshots`）是 TaskDock 本地能力 | 执行恢复（`POST /runs/:run_id/recovery`、围栏、UNKNOWN 操作）归 Relay 运维诊断，两者互不调用 |

内部协调 Agent（S6 候选）只能负责目标理解、规划建议和调度决策，**不重新实现 Relay Worker、租约、围栏或执行恢复**。`RELAY_INTEGRATION.md` R2 已明确「控制请求、Run 状态迁移、审批决定全部由 Relay 提交；TaskDock 只展示与发起，不本地改 Run 状态」，本节将其上升为战略边界：违反即双重写入权威（红线 2）。

---

## 5. 功能矩阵与开发优先级

状态分类：

- REUSE：复用现有功能。
- EXTEND：在现有功能上扩展。
- NEW：新增能力。
- VERIFY：优先补齐真实验收。

> **[核对²] 第二轮归属重定（A03 / A05 / A06 / A09 / A10）**：战略初稿曾把 A03 归 `core.dev-workbench`、
> A05/A08 归 `agent.builtin`、A06 归 `capability.center`、A10 归 `core.dev-workbench`——经代码核对
> 均有偏差：交接状态机在 `agent_access/handoff.rs`（dev-workbench 的交接包是另一个对象）；目标管理
> 已由项目中枢 v78 `project_goals` 承载（`agent.builtin` 只保留执行循环定位）；动态上下文是
> `agent_access::context` 的扩展（能力中心的上下文是另一套配置化装配）；人工决策中心以行动中心为
> 聚合入口、审批仍在各业务模块；证据验收的权威落点是 `dev_acceptance_records` + 集成台账。

| ID | 功能 | 归属业务模块 | Feature ID 与状态 **[核对²]** | 已有代码 / 已有测试 | 尚缺（是否新建） | 依赖 | 优先级 | 验收条件 |
|---|---|---|---|---|---|---|---|---|
| A01 | Agent 监控与适配器验收 | Agent 监控 | `agent.monitoring`（implemented/unverified）+ 5 个适配器条目 | 管线与 21 适配器代码；`origin='real'` 判定；配置层自动化测试 | Trae / ZCode / Claude Code / Cursor / Gemini CLI 真实联调（5/10）；**不新建功能** | 各宿主产品安装 | P0 | 每个待验适配器在真实宿主会话产生 `origin=real` 事件入库；`AGENT_COVERAGE_MATRIX.md` 与 featureCatalog 同步 |
| A02 | Agent 共享工作空间完整验收 | Agent 共享工作空间 | `agent.mcp-server`（partial/unverified；无整体条目） | 四入口代码；v81 端到端 36/36；Release 构建产物 | 第三方客户端 M10、`buildId` 正式安装包验收、性能基线、真机 UI；**不新建（验收型）** | 集成负责人解决快照分叉 | P0 | §2.5 分项表全部 ✅；分项结论不得扩大为整体 |
| A03 | 多 Agent 完整交接验收 | Agent 共享工作空间（第一轮误归 dev-workbench） | 无独立 ID（`agent.mcp-server` 部分覆盖；`dev_handoff_packs` 是另一对象，不得顶替） | `handoff.rs` 状态机 + 操作者约束 + 乐观并发；v81 场景 E 5/5（A→B + 无关 C 拒收） | A→B→C 三 Agent 链、跨会话后交接续接、真实客户端；**不新建（验收型）** | A02 环境 | P0 | 三 Agent 链 create→accept→complete→报告→C 接手全程留痕（activity + revision） |
| A04 | 权限与审计完整性 | Agent 共享工作空间 | `agent.mcp-server` | 权限五要素、`Identity` 四类、导入审核三态、审计三表；v81 场景 D 权限用例 | HTTP 接入 Token 明文技术债（需迁移哈希）；跨模块操作链统一查询；**技术债偿还 + 增强，不新建模块** | settings + 迁移（哈希改造） | P0 | 越权拒绝 / 撤销 401 / 审计留痕（已有）；补齐 Token 哈希迁移与兼容回执 |
| A05 | 目标推进引擎 | 项目中枢（目标管理归 `project_goals`，不归 agent.builtin） | `workbench.planning-center`（implemented/unverified）+ 项目中枢无独立条目 | v78 目标/版本/事件表；TS 领域层用例；自然语言创建 | S5 写路径统一、局部修订/版本回滚落库、持续推进引擎；**EXTEND 项目中枢** | 项目中枢 S5–S8 | P1 | 一个长期目标关联多任务、跨会话恢复不丢背景；推进有 `project_events` 留痕 |
| A06 | 动态上下文包 | Agent 共享工作空间（Context Engine） | `capability.center` 为另一套配置化装配；Context Engine 无独立条目 | `context::build` 七类来源 + 预算 + 中文 2-gram；v81 修复 F6/F7/F8 | 打分排序、语义检索、更多来源；**EXTEND `agent_access/context.rs`**（不建第三套装配引擎） | A02 | P1 | 按 Agent 身份与预算装配；来源 / 更新时间 / 可信状态齐全 |
| A07 | Agent 能力目录 | Agent 共享工作空间 + 能力中心 | 无独立 ID，需新建（**待确认**：新条目或 `agent.mcp-server` 子能力） | `mcp_agents`（身份）+ `agent_sources`（来源）两体系、`capability_skills` | 统一能力描述 / 匹配 / 成本统计；**NEW**（登记前先确认非现有子能力） | 身份与来源两体系不合并 | P1 | 能力可描述、可匹配、可查询；不改动现有两表语义 |
| A08 | 统一任务协调 | Agent 共享工作空间 + 行动中心 | `agent.builtin`（planned）+ `core.agent-action-center`（implemented/verified） | 交接体系、行动中心聚合、任务关联（`task_plan_links`） | 统一任务分配入口；**EXTEND**（复用交接，不重建） | A03 / A07 / A09 | P1 | 一个任务可分配、交接、失败重分配且全程可追溯 |
| A09 | 人工决策中心 | 行动中心（聚合入口）+ 各业务审批（agent_access 导入审核 / collab `plans.review` / `dev_acceptance_records` verdict） | `core.agent-action-center`（implemented/verified） | 三层聚合；审批权在各业务模块（UI-only 服务端硬约束、MCP 无审批工具） | 跨模块「决策收件箱」聚合视图；**EXTEND 行动中心，不建审批数据库** | 行动中心 + 协作中心 | P1 | 一次按键只处理一层；每类审批留各自模块证据；Agent 无法自批 |
| A10 | 证据驱动验收 | 开发效率中枢（权威落点）+ 集成台账 | `core.dev-workbench`（partial/unverified） | `dev_acceptance_records` 只追加、Agent 完成轮次候选、secret scan、`dws_build_trace` 只读解析 | 真机验收 R2-1、Git / 测试结果归集、`agent_work_reports` 与验收记录打通；**EXTEND** | dev-workbench + 集成台账 | P1 | 已执行 / 执行成功 / 验收通过 / 人工确认四层可查；结论只能人工给出 |
| A11 | Relay 只读集成 | Relay（执行层投影） | `agent.relay`（planned） | R0 目标态设计（真实端点契约） | 全部实施；**EXTEND `agent.relay`** | Relay 服务可用 | P1 | R0 清单：零写入断言、错误码映射、SSE 续传、投影可清空 |
| A12 | Relay 受控委托 | Relay | `agent.relay` | R1 目标态设计 | 全部实施 | A11 | P1 | R1 清单：确认闸门、`command_id` 幂等、链接回填 |
| A13 | Relay 执行接续 | Relay | `agent.relay` | R2 目标态设计 | 全部实施 | A12 | P2 | R2 清单：控制请求 / 审批 `target_hash` / 恢复围栏 |
| A14 | Relay 工作台联动 | Relay + 工作台 | `agent.relay` | R3 目标态设计（五项联动含任务互链与现场互跳） | 全部实施 | A13 | P2 | R3 清单：双向定位、悬空引用、窄窗主题不溢出 |
| A15 | 主动监测 | Agent 监控 + 通知 | `core.smart-reminders`（partial）、`core.notification-aggregation`（partial） | 提醒引擎、通知聚合 | 停滞 / 失联 / 阻塞检测；**NEW 能力挂现有条目** | 管线事件 | P2 | 具备范围、频率、授权、暂停与停止机制 |
| A16 | 每日工作简报 | 通知 + 规划 | `core.notification-aggregation`（partial） | 通知聚合 | 摘要生成与推送；**NEW** | A05 / A09 | P2 | 减少用户主动检查次数，不增加通知负担 |
| A17 | 个人事务 Agent | 生活效率 + 移动端 | `core.life-routines`（partial）、`life.purchases`（partial） | 生活数据模型 | 事务辅助联动；**EXTEND** | 生活模块 | P2 | 与生活系统共享数据，不另建生活数据库 |
| A18 | Agent 能力评测 | Agent 监控 | `agent.work-time-stats`（implemented/verified）、`agent.execution-timeline`（partial） | 真实时长 / 失败率统计 | 历史完成率 / 返工率评测；**NEW 挂现有条目** | 真实事件数据 | P2 | 不以 Agent 自评作排名依据 |
| A19 | 内部目标协调 Agent | （S6 候选，待战略确认） | 无独立 ID（候选，不进目录） | 无 | 全部；**NEW（长期候选）** | 前序全部稳定 | P3（长期候选） | S0–S5 稳定后才立项 |
| A20 | 高级语义检索 | Agent 共享工作空间（Context Engine） | 无独立 ID（候选，不进目录） | 关键词 / 中文 2-gram 检索 | 向量检索 / 重排序；**EXTEND（长期候选）** | 检索质量指标依据 | P3（长期候选） | 有指标依据再引入，不为 AI 而先上向量库 |

P0 的目标是让已有功能可靠，而不是继续扩张。

P1 的目标是形成真正的人机协作闭环。

P2 的目标是让 TaskDock 能主动服务用户。

P3 才考虑更复杂的自主协调和智能调度。

**[核对²] 优先级口径**：`featureCatalog.ts` 的 `FeaturePriority` 枚举只有 `P0 | P1 | P2` 三值，**不含 P3**。A19 / A20 在本矩阵中标注为「长期候选」，**本轮与后续登记前都不向目录写入 P3**；若未来要登记，需先决策归入 P2 还是扩展枚举（后者是目录公开契约变更，单独提出）。

**[核对²] 目录覆盖缺口（本轮只登记事实，不改计数）**：现有 62 条目录条目中**没有**以下 6 类能力的独立条目——「Agent 共享工作空间（整体）」「Context Engine」「Agent Handoff」「Agent 能力目录」「协作中心（collab）」「项目中枢（project_hub）」，仅 `agent.mcp-server` 部分覆盖前两类；另有 `workbench.planning-center` 描述滞后（代码已是四数据源 hub/mine/builtin/collab，条目仍写「双数据源」）。按 `docs/ROADMAP.md` 维护规则「先改 `featureCatalog.ts`，再同步 ROADMAP」，**是否为这 6 类新增条目、如何拆分（独立条目还是现有条目子能力）属目录契约决策，列入待用户确认清单；确认前不改目录计数（62）**。

---

## 6. 核心产品交互设计

不建议为了这些功能新增大量一级 Tab。

### 6.1 现有模块职责调整

| 现有页面 | 导航 ID **[核对]** | 未来职责 |
|---|---|---|
| Agent | `agents` | Agent 状态、会话、运行和异常监控 |
| 行动 | `actions` | 需要用户处理的 Agent 事项 |
| 能力中心 | `capability` | Agent 接入、权限、Skill、MCP、知识和上下文能力 |
| 项目中枢 | `roadmap` | 目标、计划、阶段、里程碑和任务分解 |
| 工作空间 | `workspace` | 项目实际工作与成果 |
| 工作流 | `workflows` | 可重复的安全白名单操作 |
| 历史 | `history` | 执行时间轴、审计和结果追踪 |
| 诊断中心 | `diagnostics` | 系统诊断（与历史分列） |
| 手机互传 | `mobile` | 快速采集、审批、状态监控和任务控制 |
| 统一大型工作台 | `workbench` | 跨模块聚合视图的天然宿主 |

**[核对]** 导航标签与 §6.1 原始用词有出入：目录中「规划中心」实为「项目中枢」、「行动中心」实为「行动」、「历史与日志」实为「历史」与「诊断中心」两项、「移动端」实为「手机互传」。此处以导航 ID 为准，避免后续实现找不到对应页面。

### 6.2 建议新增的跨模块体验

不一定是独立页面，可以先做成统一工作台中的聚合视图。

#### 今日工作摘要

只显示：

- 今日最重要的目标。
- 当前正在执行的任务。
- 已完成的成果。
- 等待人工处理的事项。
- 当前阻塞。
- 下一步建议。

#### 决策收件箱

集中显示：

- Agent 请求批准。
- 需要用户补充的信息。
- 不同 Agent 的方案冲突。
- 验收失败。
- 需要重新分配的任务。
- 高风险操作。

#### 目标详情

能够查看：

- 目标本身。
- 关联项目。
- 里程碑。
- 任务依赖。
- Agent 执行情况。
- 关键决策。
- 历史成果。
- 风险与下一步。

用户可以从目标进入任务，也可以从任务回到目标。

---

## 7. 典型使用场景

### 场景一：独立游戏开发

用户提出目标：三个月完成一款可以发布的独立游戏。

TaskDock：

1. 在规划中心建立目标及阶段。
2. 关联游戏项目工作空间。
3. 读取项目技术架构和历史决策。
4. 拆解美术、程序、剧情和测试任务。
5. 根据能力目录推荐 Agent。
6. 通过 Relay 委托执行任务。
7. 持续接收执行状态。
8. 遇到技术冲突时请求人工决策。
9. 由独立验收流程检查成果。
10. 更新目标进度并生成下一步计划。

用户主要负责方向、审美和关键取舍。

### 场景二：开发一个新的软件功能

用户提出需求后：

1. 规划 Agent 分析需求。
2. 编码 Agent 实现功能。
3. 文档 Agent 更新文档。
4. 测试 Agent 执行测试。
5. 验收流程检查证据。
6. 发现问题后重新分配任务。
7. 最终由人确认完成。

任何 Agent 都不能仅凭自己的完成声明关闭整个业务任务。

### 场景三：工作中断后恢复

用户关闭电脑，第二天重新打开。

TaskDock 应能够恢复：

- 昨天正在做什么。
- 哪个 Agent 正在执行。
- 哪些任务已经完成。
- 哪些任务处于等待状态。
- 哪些任务需要恢复。
- 哪些操作结果未知。
- 下一步应该做什么。

不能因为应用重启就自动重放具有副作用的操作。

### 场景四：生活事务管理

用户拍摄一张购物票据。

TaskDock：

1. 识别商家、日期、金额和商品。
2. 关联已有物品或购买记录。
3. 更新生活记录。
4. 提醒保质期或库存问题。
5. 将需要人工确认的信息放入决策收件箱。

与现有生活效率系统共享数据，不另建生活数据库。

---

## 8. 安全与可信执行规范

安全不是后期补充功能，而是整个 Agent 系统的基础。

### 8.1 权限

- 默认拒绝。
- 按 Agent 身份授权。
- 按项目和资源授权。
- 读写权限分离。
- 删除、发送、支付等高风险操作必须人工确认。
- 授权具有有效范围和撤销机制。
- Token 明文不得写入日志或备份。

**[核对]** 两类 Token 的存储方式不同，必须分别对待：

| Token | 存储 | 证据 |
|---|---|---|
| MCP / Agent 身份 Token | SHA-256 哈希，明文仅创建时返回一次 | `mcp/auth.rs:4-5,114,282-284`；`mcp/audit.rs:26` 明确不存 token |
| Agent HTTP 接入 Token | **明文**存于 `application_settings.http_token` | `db/mod.rs:2477-2480`；比对用 `constant_time_eq`（`http_ingest.rs:291-296`） |

现状是：MCP 侧哈希设计已达标，HTTP 接入侧仍为明文。日志与备份侧已做保护（`db/mod.rs:3468` 只记键名不打印值；`commands/data.rs:2422` 断言导出数据不含 `http_token`）。**「Token 明文存储」是一个尚未偿还的真实技术债**，应在 Phase 1 明确处理，不得因 MCP 侧已哈希就认为整体安全。

### 8.2 执行

- 每个外部写操作必须有幂等标识。
- 修改数据必须进行版本校验。
- 任务状态转换必须合法。
- 失败必须有明确回执。
- 不确定的副作用不能盲目重试。
- Agent 不能修改自己的审计记录。

### 8.3 验收

每项任务应区分：

- 已执行。
- 执行成功。
- 验收通过。
- 人工确认完成。

证据包括测试结果、文件变更、版本信息、操作记录和实际运行结果。

### 8.4 隐私

- 上下文按任务最小化装配。
- 不将所有个人资料默认提供给所有 Agent。
- 凭据只通过受控接口使用。
- 外部 Agent 的数据访问范围可查询、可撤销。
- 远程访问必须独立设计安全模型，不能因为本地接口已经可用就直接暴露公网。

---

## 9. 分阶段实施路线

> **[核对] 阶段轴说明**：`docs/ROADMAP.md` **没有** Phase 划分，使用的是 P0–P3 优先级 + 7 个功能分类 + 「近期推荐开发顺序」；同时 `docs/agent-workspace/development-progress.md` 已有一套 Phase 0–7（架构审计 → CLI → Context Engine → MCP → REST → Identity/Handoff → UI）。为避免三套编号撞车，本文件的阶段统一以 **S0–S6** 命名，S 表示 Strategy，与既有 Phase 编号无关。

### S0：战略与架构冻结

本阶段只进行规划，不改业务代码。

交付：

- 本战略文档。
- 功能矩阵。
- 现有模块复用关系。
- TaskDock / Relay 职责边界。
- 关键数据所有权。
- 后续开发依赖关系。

验收：

- 不存在明显功能重复。
- 所有新功能都能对应一个真实用户问题。
- 不与已有文档的安全约束冲突。

**[核对²] S0 当前状态（2026-11-20）**：两轮事实核对均已完成（第一轮 2026-11-19、第二轮 2026-11-20，
见核对报告）；模块职责矩阵、功能映射矩阵、数据所有权结论、两层协调边界均已产出。**待办：用户对
战略方向（含 ADR-A01–A12 草案、目录覆盖缺口 6 类能力的登记方案、A19/A20 长期候选定位）做出确认
后，S0 才算通过**；在此之前本文不作为开发排期依据。

### S1：Agent 基础能力收口

优先级：P0。

任务：

1. 完整验证 Agent Monitor 真实事件（目标：Trae / ZCode / Claude Code / Cursor / Gemini CLI 补齐或明确记为不支持；现口径 5/10）。
2. 验证 Agent Workspace 剩余验收项（第三方客户端 M10、`buildId` 正式安装包验收、性能基线、真机 UI）。
   **[核对²]** 已完成部分：CLI / REST / 文件 / MCP 四入口真实链路（v81 端到端 36/36）、正常 GUI 启动、交接场景 E——见 §2.5，不得重验已完成项。
3. 扩展交接验收至 A→B→C 三 Agent 链（A→B 双 Agent 已由 v81 场景 E 覆盖）。
4. 验证权限撤销和项目隔离（v81 已覆盖越权/撤销/导入审核，剩余：项目隔离的多项目矩阵）。
5. 验证审计与异常记录。
6. 处理 HTTP 接入 Token 明文存储问题（仍未偿还的技术债，需迁移把 `application_settings.http_token` 改哈希并设计兼容）。
7. 检查 Agent 面板、行动中心和能力中心的数据一致性。
8. 更新 featureCatalog 与验收报告（含第二轮确认后的目录覆盖缺口登记）。

验收：所有关键链路均有真实证据，不以代码存在代替功能完成。

### S2：目标与上下文闭环

优先级：P1。

任务：

1. 复用规划中心完善长期目标管理。
2. 建立目标与任务的关联。
3. 扩展动态上下文包。
4. 纳入决策、约束和近期变化。
5. 增加下一步建议。
6. 支持任务中断后的上下文恢复。
7. 建立目标进度和阻塞检测。

验收：一个长期目标能够关联多个任务，跨会话恢复后不丢失关键背景。

### S3：可信协作与调度

优先级：P1。

任务：

1. 建立 Agent 能力描述。
2. 支持 Agent 能力匹配。
3. 建立统一任务分配入口。
4. 完善交接状态和工作报告。
5. 建立决策收件箱。
6. 建立证据驱动的验收流程。
7. 支持 Agent 失败后的重新分配。

验收：多个 Agent 可以协作完成一个任务，人能够查看、授权和验收整个过程。

### S4：Relay 集成

严格沿用 `docs/RELAY_INTEGRATION.md` 的 R0–R3 路线。

| 阶段 | 内容 | 安全级别 |
|---|---|---|
| R0 | 只读查看项目、任务、Run、Review | 零写入 |
| R1 | 用户确认后委托任务 | 受控写入 |
| R2 | 暂停、恢复、交接、审批 | 高风险受控操作 |
| R3 | 文件、任务、暂存、诊断、工作现场联动 | 跨模块联动 |

不重新设计 Relay 已有的执行引擎。

每个阶段单独验收，R0 未通过不得进入 R1。

**[核对]** R0–R3 的实际定义与上表一致（`RELAY_INTEGRATION.md:316/345/371/399`）。两点补充：① R3 实际范围还包含**任务互链**与**工作现场入口互跳**，验收时不可漏项；② `RELAY_INTEGRATION.md:312` 明示「本轮（预研）不实施 R1–R3；以下为目标态设计」，R0 亦为设计态——**验收依据是目标态设计，而非已实现**。

### S5：主动服务

优先级：P2。

任务：

1. Agent 失联监测。
2. 项目停滞检测。
3. 任务阻塞提醒。
4. 每日工作简报。
5. 目标偏离检测。
6. 个人事务 Agent。
7. 移动端审批和状态监控。

验收：系统能够减少用户主动检查的次数，而不是增加新的通知负担。

### S6：内部协调 Agent

优先级：P3。

只有在前面各阶段稳定后才考虑。

内部 Agent 主要负责：

- 理解目标。
- 整理上下文。
- 生成计划。
- 推荐 Agent。
- 检查任务状态。
- 发现阻塞。
- 提出重新规划建议。

优先调用外部 Agent 和 Relay 完成专业工作，不重新实现通用执行引擎。

---

## 10. 产品成功指标

不能仅以 Agent 数量、Token 消耗量和自动执行次数评价产品。

建议使用以下指标：

| 指标 | 评价目标 |
|---|---|
| 任务接续成功率 | 中断后能否恢复到正确状态 |
| 上下文有效率 | 提供给 Agent 的信息是否真正相关 |
| 交接成功率 | Agent 之间是否能够正确完成交接 |
| 验收通过率 | 首次交付的质量 |
| 返工率 | 失败后重复工作是否减少 |
| 人工介入频率 | 用户是否被无关事务打断 |
| 错误自动完成率 | 不应出现未经验证的完成判定 |
| 权限违规次数 | 应始终为零 |
| 目标推进率 | 长期目标是否真正取得进展 |
| 单位目标成本 | 时间、Token 和外部服务成本 |

特别关注：

**TaskDock 应当优化人的时间和注意力，而不只是优化 Agent 的执行速度。**

---

## 11. 明确不做的事情

为了控制产品边界，以下事项不列入近期开发：

1. 不再开发一个与现有 Agent 面板重复的 Agent 监控器。
2. 不开发第二套任务管理系统。
3. 不开发第二套项目管理系统。
4. 不重写 Relay 的 Worker 和执行恢复系统。
5. 不强制使用 TaskDock 自己的模型。
6. 不为了 AI 而立即引入向量数据库。
7. 不自动执行付款、发送消息、删除等高风险操作。
8. 不把普通工作流升级成不受限制的 Shell 执行器。
9. 不默认让所有 Agent 共享所有个人信息。
10. 不把 Agent 的自我评价当成客观能力排名。

---

## 12. 待确认的战略架构决策（ADR-A01–A12 草案）

> **状态更正（2026-11-20，第二轮整改）**：本节原名「需要冻结的架构决策」，v1.0 曾把这 12 条作为
> 「已冻结」约束——超出用户实际确认范围。现更名为**待确认的战略架构决策**，状态
> **Proposed（草案）**：用户确认战略方向前仅作方向参考，不作为验收依据、不据此开发。
> 确认后逐条拆入 `docs/adr/00xx-*.md` 并标 Accepted（见 [adr/README.md](adr/README.md)）。

| 编号 | 决策 | 状态 |
|---|---|---|
| ADR-A01 | TaskDock 定位为个人 Agent 协作与目标推进中枢 | Proposed |
| ADR-A02 | TaskDock 不重写 Relay 执行引擎 | Proposed |
| ADR-A03 | MCP、CLI、REST、文件是访问通道，不是执行调度器 | Proposed |
| ADR-A04 | Agent Monitor 与 Agent Access 分离 | Proposed |
| ADR-A05 | Agent 身份、监控来源和执行身份分离 | Proposed |
| ADR-A06 | TaskDock 与 Relay 各自维护业务事实，不双重写入 | Proposed |
| ADR-A07 | 现有规划中心和任务系统优先复用 | Proposed |
| ADR-A08 | Context Engine 采用按需装配，不默认提供完整个人资料 | Proposed |
| ADR-A09 | 高风险操作必须经过明确授权 | Proposed |
| ADR-A10 | 完成判定以可复核证据为基础 | Proposed |
| ADR-A11 | 内部协调 Agent 晚于基础设施建设 | Proposed |
| ADR-A12 | 移动端以采集、审批和监控为主，不复制桌面专业工作台 | Proposed |

> **[核对]** ADR-A01 至 ADR-A12 与现有治理记录一致：`docs/adr/0002-modular-monolith-no-rewrite.md`（A02 同向）、`docs/adr/0004-migration-redline.md`、`docs/adr/0005-architecture-guard-phased.md` 的约束均未被本文违反。本表作为战略草案清单，与正式 ADR（0001–0007，Accepted）分列管理。

---

## 13. 现有文档的维护与实施要求

本文件是产品战略上位文档，不替代现有详细技术规范。

后续涉及功能开发时，应遵循以下文档关系：

| 文档 | 职责 |
|---|---|
| 本文档 | 产品战略、边界和整体路线 |
| [ROADMAP.md](ROADMAP.md) | 功能规划目录（由 `featureCatalog.ts` 派生） |
| [docs/project-hub/](project-hub/README.md) | 项目中枢详细设计（唯一项目根、v78 数据模型、迭代状态） |
| [docs/collab-center/](collab-center/README.md) | 协作中心详细设计（需求→方案→审批→证据链路，v77） |
| [docs/developer-efficiency/](developer-efficiency/README.md) | 开发效率中枢详细设计（交接包、验收记录、迭代状态） |
| [docs/agent-workspace/](agent-workspace/) | Agent 共享工作空间详细设计 |
| [AGENT_ADAPTERS.md](AGENT_ADAPTERS.md) | Agent 状态接入和适配器规范 |
| [AGENT_SKILL_ROUTING.md](AGENT_SKILL_ROUTING.md) | Skill 使用规范 |
| [RELAY_INTEGRATION.md](RELAY_INTEGRATION.md) | Relay 集成详细设计 |
| [docs/ai-capability-center/](ai-capability-center/) | 知识、Skill、MCP、上下文能力中心 |
| [docs/workflows/](workflows/) | 本地安全工作流规范 |
| [adr/README.md](adr/README.md) | ADR 索引（正式 ADR 与战略草案分列） |
| [../AGENT_COVERAGE_MATRIX.md](../AGENT_COVERAGE_MATRIX.md) | 适配器真实联调状态真源 |
| [../src/lib/featureCatalog.ts](../src/lib/featureCatalog.ts) | 全量功能规划目录（62 条 / 7 分区）及状态真源 |

维护要求：

1. 不直接覆盖现有详细设计。
2. 发现文档冲突时先分析事实来源。
3. 不随意修改已经冻结的数据契约。
4. 新功能先进入功能矩阵，再进入内置路线图。
5. 每个功能都有独立验收标准。
6. 已实现、已验收、真实环境验证必须使用不同状态。
7. 开发完成后更新功能目录和对应验收报告。

---

## 14. 最终产品愿景

TaskDock 不应该只是一个可以调用 Agent 的工具。

它应该成为一个人管理自己全部 Agent 能力的工作中枢。

用户负责：

- 想清楚自己要什么。
- 决定哪些事情重要。
- 提供关键判断。
- 对重要结果负责。

TaskDock 负责：

- 记住目标。
- 组织上下文。
- 选择合适的 Agent。
- 组织任务。
- 维护工作连续性。
- 监督执行。
- 处理权限和风险。
- 验收最终结果。

Agent 负责：

- 专业执行。
- 产出成果。
- 汇报进度。
- 交接工作。

Relay 负责：

- 持久化执行协调。
- 跨 Agent 任务接续。
- 执行过程管理。
- 失败恢复。

**最终目标：让一个人能够有效管理和使用远超自身执行能力的 Agent 团队，同时不失去对目标、信息、安全和最终结果的控制。**
