# 战略文档事实核对报告（Agent 时代战略 v1.0）

| 项目 | 内容 |
|---|---|
| 文档状态 | 事实核对完成、待产品战略确认（v1.0 曾标「生效」，随战略文档 v1.1 一并撤销） |
| 日期 | 2026-11-19（第一轮）；2026-11-20 追加第二轮核对（§11） |
| 核对对象 | 《TaskDock Agent 时代产品战略与功能架构规划 v1.0》初稿（用户提供） |
| 核对基准 | 仓库 HEAD `1e8817c`（main 分支） |
| 核对方式 | 2 路只读子 Agent 并行核对 + 主架构师逐项抽查复核；全程未修改业务代码、未执行 git 写操作、未运行构建 |
| 产出 | [AGENT_ERA_STRATEGY.md](AGENT_ERA_STRATEGY.md)（第一轮按核对结果订正；第二轮追加跨模块审计修订） |
| 事实优先级 | 代码与可复现输出 > 测试/真机证据 > 文档 |

---

## 1. 核对方法

- 引用存在性：27 项代码路径 / 文档路径 / 表名 / 函数名逐条定位。
- 描述准确性：9 个业务模块逐个核对「实现了什么」「缺口是否成立」。
- 抽查复核：主架构师对 8 个关键结论二次独立验证（下表列出）。
- 未执行任何构建、测试、真机操作；结论均为静态代码与既有文档证据。

主架构师复核的 8 项关键结论：

| 复核项 | 复核命令 | 复核结论 |
|---|---|---|
| `build_agent_context` 是否存在于代码 | `grep -rn "build_agent_context" --include=*.rs --include=*.ts --include=*.tsx --include=*.md` | 仅 `docs/agent-workspace/architecture.md:90` 一处命中，Rust/TS 源码 0 命中 |
| Context Engine 真实入口签名 | `grep -n "pub fn build" src-tauri/src/agent_access/context.rs` | `context.rs:1022` `pub fn build(db, principal, req: ContextRequest)` |
| `agent_handoffs` / `agent_work_reports` DDL 位置 | `grep -rn "CREATE TABLE.*agent_handoffs"` | 在 `src-tauri/src/agent_access/schema.rs:129/:161`，**不在** `db/mod.rs` |
| 功能目录条目数 | `grep -c "^    id: \"" src/lib/featureCatalog.ts` | 62，与 `featureCatalog.test.ts:318` `expect(s.total).toBe(62)` 一致 |
| 行动中心真实位置 | `ls src/components/actions/` | `ActionCenterPanel.tsx` 等，**不在** `src/components/agents/` |
| 全功能适配器数量 | `sed -n '605,635p' src-tauri/src/agents/managed.rs` | 注册表 10 个全功能 + `discovery_only` 11 个 = 21 |
| 两类 Token 存储方式 | 读 `db/mod.rs:2477-2480` 与 `mcp/auth.rs:278-288` | HTTP 接入明文；MCP 身份 SHA-256 哈希 |
| 阶段轴撞车 | `grep -c "Phase [0-9]" docs/ROADMAP.md` = **0**；`docs/agent-workspace/development-progress.md` 有 Phase 0–7 | ROADMAP 无阶段轴；agent-workspace 已有一套 Phase 0–7 |

---

## 2. 结论概览

初稿整体**准确度高**：绝大多数代码路径、表名、模块职责、职责边界描述经核对属实，R0–R3 的语义定义与 `RELAY_INTEGRATION.md` 逐条一致，`agent.builtin` / `agent.relay` 为 `planned` 的判断与真源相符。

但存在 **8 处必须订正的事实偏差**（其中 3 处为「代码符号/路径不存在或错位」，可能被代码审查直接推翻）和 **2 处结构性缺口**（阶段轴撞车、目录覆盖不足）。这些偏差已在冻结版中逐条订正并以 `[核对]` 标记。

| 严重度 | 数量 | 性质 |
|---|---|---|
| 🔴 严重 | 3 | 事实错误：符号不存在、路径错位、阶段轴定义错误 |
| 🟠 中等 | 5 | 需精确化：定位、覆盖面、状态口径 |
| 🟡 轻微 | 4 | 措辞与量化补充 |

---

## 3. 严重度 3（必须订正）

### 🔴-1 `build_agent_context()` 在代码中不存在

- **初稿表述**：§3.2「`build_agent_context()` 应逐步支持……」
- **代码事实**：真实入口是 `agent_access::context::build(db: &Db, principal: &Principal, req: ContextRequest) -> AppResult<AgentContext>`（`src-tauri/src/agent_access/context.rs:1022`）。入参是结构体 `ContextRequest { task, task_id, project_id, agent_id, session_id, budget_tokens, kinds, format }`（`context.rs:35-54`），**没有** `query`/`project`/`plan`/`agent` 位置参数。
- **全仓检索**：`build_agent_context` 仅在 `docs/agent-workspace/architecture.md:90`（设计稿记法）出现，Rust/TS 源码 0 命中。
- **风险**：这是一条可被代码审查直接推翻的硬事实，且上游设计稿本身就用了这个记法——若不订正，冻结文档会与仓库既有文档一起固化错误。
- **订正方式**：冻结版改为引用真实符号 `agent_access::context::build`，并显式加注「设计稿记法非代码符号」。

### 🔴-2 行动中心路径归属错误

- **初稿表述**：§2.1 表格把「行动中心」列在 Agent 监控中心行，代码路径写作 `src/components/agents/` + `src-tauri/src/agents/`。
- **代码事实**：行动中心是**独立模块**——前端 `src/components/actions/ActionCenterPanel.tsx`（797 行）+ `actions-workspace.css`，后端 `src-tauri/src/actions/mod.rs`（1984 行）+ `src-tauri/src/commands/actions.rs`（4 个 `#[tauri::command]`，已在 `lib.rs:1736-1739` 注册）。导航上是独立项 `actions`（label「行动」，`navigationRegistry.ts:279`）。`docs/ROADMAP.md:41` 将其登记为独立特性 `core.agent-action-center`。
- **风险**：`src/components/agents/` 实际只有 `AgentPanel.tsx` / `AgentPlanningLinks.tsx` / `MockControls.tsx` / `stats/`。按初稿路径找不到行动中心实现。
- **订正方式**：冻结版把行动中心拆为独立表格行，标注真实路径。

### 🔴-3 阶段轴与仓库既有编号体系冲突

- **初稿表述**：§9 用「Phase 0–Phase 6」划分阶段，§5 矩阵用 P0–P3。
- **代码/文档事实**：
  1. `docs/ROADMAP.md` **完全没有 Phase 划分**（`grep -c "Phase [0-9]" = 0`）。它用的是 P0–P3 优先级 + 7 个功能分类 + 「近期推荐开发顺序」5 条建议（`ROADMAP.md:31,48,62,83,91,107,117,176-189`）。
  2. `docs/agent-workspace/development-progress.md` **已有一套 Phase 0–7**（架构审计 → 共享数据基础 → CLI → Context Engine → MCP → REST API → Identity/Handoff/工作报告 → UI 管理面），与初稿编号语义完全不同。
  3. `featureCatalog.ts` 的 `FeaturePriority` 枚举只有 `P0 | P1 | P2`（`featureCatalog.ts:19`），**无 P3**。初稿矩阵的 A19 / A20 标 P3，在目录中无法原样登记。
- **风险**：出现两个语义不同的「Phase 3」和一个语义冲突的「Phase 6」，后续协作与验收会产生歧义。
- **订正方式**：冻结版把战略阶段改名为 **S0–S6**（S = Strategy），并在文档内显式说明与既有 Phase 编号无关；同时标注 P3 需先决定归入 P2 还是扩展目录优先级枚举。

---

## 4. 严重度 5（需精确化）

### 🟠-1 `agent_handoffs` / `agent_work_reports` 的代码定位

- **初稿表述**：§3.4 称「现有 `agent_handoffs` 和 `agent_work_reports` 是基础」。
- **代码事实**：两表 DDL 在 `src-tauri/src/agent_access/schema.rs:129` 与 `:161`，属迁移 **v76**，以常量引用挂载到主迁移链（`db/mod.rs:2119` `crate::agent_access::schema::MIGRATION_76,`）。`db/mod.rs` 正文 `grep 'CREATE TABLE agent_handoffs'` **零命中**。同批共 11 张表（`schema.rs:23-182`）+ v81 的 3 张导入审核表。
- **结论**：表确实存在且会建库（`MIGRATIONS` 数组元素即被 `apply_migrations` 执行，`db/mod.rs:2401`），审计结论成立；错的是**代码定位**。
- **订正方式**：冻结版标注 `agent_access/schema.rs`（迁移 v76，经 `db/mod.rs:2119` 挂载）。

### 🟠-2 `featureCatalog.ts` 的性质描述

- **初稿表述**：§13 称为「内置功能目录及状态真源」。
- **代码事实**：它是**全量功能规划目录**，62 条 / 7 分区（`core` / `workbench` / `workflow` / `info` / `agent` / `ecosystem` / `system`，`featureCatalog.ts:27-35`）。其中「核心 12 项」是受测试锁定的固定 ID 集合（`CORE_FEATURE_IDS`，`featureCatalog.ts:102-116`，`CORE_FEATURE_COUNT` 测试锁定为 12），**不等于某个展示分区的条目数**（`ROADMAP.md:11` 明示）。
- **「真源」定性成立**：目录与 `ROADMAP.md:3` 双向声明唯一事实源，ROADMAP 条目确由目录派生。
- **订正方式**：改为「全量功能规划目录（62 条 / 7 分区），其中核心 12 项为受测试锁定的固定 ID 集合」。

### 🟠-3 R3 实际覆盖面大于初稿列举

- **初稿表述**：§9「R3 | 文件、暂存架、工作空间和诊断联动」。
- **文档事实**：`RELAY_INTEGRATION.md:399` 实际标题为「R3 工作台联动（**文件、任务、暂存、诊断、工作现场**）」，另含任务双向定位（`:406`）与工作现场入口互跳（`:408`）。
- **订正方式**：R3 列举补全为五项，避免照抄初稿时漏验。

### 🟠-4 R0–R3 当前均为目标态设计

- **文档事实**：`RELAY_INTEGRATION.md:312` 明示「**本轮（预研）不实施 R1–R3；以下为目标态设计**」，R0 亦为设计态。全仓 `src-tauri/src/` 与 `src/` 内无任何 Relay 服务端、客户端连接器或协议实现。
- **订正方式**：冻结版在 S4 增加前提说明——验收依据是目标态设计而非已实现。

### 🟠-5 两类 Token 存储行为相反

- **初稿表述**：§8.1「Token 明文不得写入日志或备份」——**要求本身正确**，但初稿未区分现状。
- **代码事实**：
  | Token | 存储 | 证据 |
  |---|---|---|
  | MCP / Agent 身份 | SHA-256 哈希，明文仅创建时返回一次 | `mcp/auth.rs:4-5,114,282-284`；`mcp/audit.rs:26` 明确不存 token |
  | Agent HTTP 接入 | **明文**存 `application_settings.http_token` | `db/mod.rs:2477-2480`；`constant_time_eq` 比对（`http_ingest.rs:291-296`） |
- 保护侧已到位：`db/mod.rs:3468` 只记键名不打印值；`commands/data.rs:2422` 断言导出数据不含 `http_token`。
- **订正方式**：冻结版如实分列两类 Token，并将其列为 Phase 1 的真实技术债项——写「Token 已哈希」会掩盖 HTTP 侧风险，写「Token 明文存储」会抹平 MCP 侧已做好的设计。

---

## 5. 严重度 4（措辞与量化补充）

### 🟡-1 适配器数量与真实联调需量化

初稿称「部分适配器真实事件仍待验证」——措辞准确但不可执行。量化后：

- 已实现 **21 个**：10 个全功能（Codex / Trae / WorkBuddy / Qoder / OpenCode / DSH / ZCode / Claude Code / Cursor / Gemini CLI，`managed.rs:613-623`）+ 11 个仅发现型（`discovery_only.rs`）。
- **真实联调通过 5/7**：Codex、WorkBuddy、Qoder、DSH、OpenCode（`AGENT_COVERAGE_MATRIX.md:21`），通用桥接 bridge 亦有真实事件（`:19`）。
- ❌ 未真实联调：Trae（`:8`，仅 `taskdock-selftest-trae` 自测事件，此前「✅」为假阳性）、ZCode（`:13`）、Claude Code（`:14`）、Cursor（`:15`）、Gemini CLI（`:16`）。
- 代码层同口径：`managed.rs:705-708` SQL 强制 `e.origin = 'real'`；`managed.rs:783` 仅凭 `verified` 位而无 `origin=real` 证据时判为假阳性。

### 🟡-2 共享工作空间验收证据比初稿假设的更靠后

初稿称「多入口综合稳定性和第三方客户端兼容性仍需验收」——**结论正确**，但仓库已有比初稿所假设更靠后的证据（`docs/agent-workspace/acceptance-report.md` §10–§12，2026-11-18）：

- CLI、文件、REST 已取得真实读写与冲突/权限证据。
- MCP 端到端已完成：bridge 真实监听 `127.0.0.1:6946`，`tools/list` 94 个、`resources/list` 10 个、`prompts/list` 5 个，`taskdock://manifest` 暴露 16 项能力（`:182-183`）。
- **仍未验收**：MCP 传输层真机、UI 真机走查、安装包 / `buildId`、性能基线、REST 知识/决策 PATCH、并发双写、端口冲突（`:171-172, 200-205`）。
- 第三方客户端兼容性：`test-plan.md:73` M10（Claude Code / Codex / Cursor / Trae 真实客户端）未执行。

### 🟡-3 「跨模块操作链统一查询」缺口成立

初稿称审计缺「跨模块操作链和统一查询体验」。核对确认**缺口成立**：

- 三张审计表各自独立：`agent_activity_logs`（`schema.rs:185`）、`agent_sync_events`（`:212`）、`agent_context_access_logs`（`:251`）。
- 全库**无** `agent_activity_logs` 与其他审计表的 JOIN / UNION；`agent_context_access_logs` 只有写入点（`store.rs:1008`），无联合查询。
- 另有独立 `mcp_audit_log`（`db/mod.rs:1255`），与三表不互通。

### 🟡-4 `commands/audit.rs` 命名易误导

`src-tauri/src/commands/audit.rs` 是**测试/压测数据审计与清理**（文件首行自述），与「操作链审计」无关。引用审计能力时需消歧。

---

## 6. 结构性缺口（2 项）

### 缺口 1：功能目录未覆盖 4 类已落地能力

现有 62 条目录条目中，**没有**以下能力的独立条目：

| 能力 | 实际实现 | 目录覆盖情况 |
|---|---|---|
| Agent 共享工作空间（CLI/REST/文件投影） | `src-tauri/src/agent_access/` 17 文件 | 仅 `agent.mcp-server` 部分覆盖 |
| Context Engine | `agent_access/context.rs` | 无 |
| Agent Handoff 状态机 | `agent_access/handoff.rs` | 无 |
| Agent 能力目录 | 待建 | 无 |

按 `docs/ROADMAP.md:169` 的维护规则「先改 `featureCatalog.ts`，再同步本文档；两处状态、ID、计数必须一致」，A02 / A03 / A04 / A06 / A07 的登记需在 Phase 1 前补齐，否则战略矩阵与真源无法对账。

### 缺口 2：优先级枚举无 P3

`FeaturePriority` 只有 `P0 | P1 | P2`。A19（内部目标协调 Agent）、A20（高级语义检索）标 P3，登记前需决定归入 P2 还是扩展枚举——后者是目录契约变更，应单独提出（`featureCatalog.ts:14-16` 注释亦强调「改动任何 id 视为公开契约破坏」）。

---

## 7. 核对通过、无需订正的表述

| 初稿断言 | 结论 | 关键证据 |
|---|---|---|
| 事件管线是有界管线、有背压、过载返回可重试错误 | ✅ 准确 | `pipeline.rs:30,107-109,400,933-960,970-1010`；测试 `pipeline.rs:1813-1865` |
| waiting/failed/completed 分开不合并 | ✅ 准确 | `pipeline.rs:8,376-378,1368-1394`；测试 `pipeline.rs:1763-1784`；`actions/mod.rs:253-257` |
| origin 由服务端判定 | ✅ 准确 | `agents/mod.rs:552-574,1464`；测试 `mod.rs:2673`（伪造被改判） |
| 四入口（CLI/MCP/REST/文件）真实存在 | ✅ 准确 | `Cargo.toml:15-17`；`agent_access/cli.rs:1178`；`mcp_tools.rs:45`；`rest.rs:42-79`；`projection.rs:188` |
| 受控导入权限在后端判定 | ✅ 准确 | `permissions.rs:10,68,112-141,551-641` |
| 权限五要素（身份/Token/能力授权/项目范围/导入审核）齐备 | ✅ 准确 | `mcp/auth.rs:18,84`；`mcp/permissions.rs:37-54`；`permissions.rs:23,505,525` |
| 缺「跨模块操作链」统一查询 | ✅ 准确 | 三表独立查询（`store.rs:228,853`），无跨表 JOIN |
| 规划中心五层实体 | ✅ 准确 | `db/mod.rs:685,700,712,731,747` |
| 能力中心有「配方」 | ✅ 准确 | `capability/schema.rs:152,163`；`capability/recipes.rs:26,265,303,425`；前端 `RecipesSection.tsx` |
| 工作流是白名单动作编排，非通用 shell 执行器 | ✅ 准确 | `workflows/mod.rs:27-40`（6 型白名单）、`:176-195`；`workflows/` 目录 `Command::new` 零命中 |
| 移动端有采集/同步/文件互传/设备配对 | ✅ 准确 | `features/capture/`；`lib/sync/`；`lib/sync/attachmentTransfer.ts`；`lib/sync/pairing.ts` |
| 移动端无 Agent 接续/审批 | ✅ 准确（无夸大） | `entryRegistry.ts:296,351`；`HomeScreen.tsx:5`；`RELAY_INTEGRATION.md:104` |
| `agent.builtin` / `agent.relay` 为未实现的长期方向 | ✅ 准确 | `ROADMAP.md:104-105`；`featureCatalog.ts:1578,1619` |
| R0–R3 四阶段语义定义 | ✅ 逐条一致 | `RELAY_INTEGRATION.md:316,345,371,399` |
| `agent_sources` / `mcp_agents` 两套体系未混用 | ✅ 确认 | 表空间与外键方向独立；`agent_sources` 无 relay 字段 |

---

## 8. 冻结版相对初稿的改动清单

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| 1 | §2.1 表格 | 新增「实现位置」列，标注各模块真实路径 | 严重度 3-2、4-1 |
| 2 | §2.1 表格 | 行动中心拆为独立行，路径改为 `src/components/actions/` | 严重度 3-2 |
| 3 | §2.1 表格 | Context Engine / Handoff 行修正代码定位 | 严重度 4-1 |
| 4 | §2.1 / §2.4 | 新增「适配器真实联调状态」小节，量化 21 个 / 5-7 | 严重度 5-1 |
| 5 | §3.2 | `build_agent_context()` → `agent_access::context::build`，附真实签名与 7 类来源 | 严重度 3-1 |
| 6 | §3.4 | 补 `agent_access/schema.rs` 迁移 v76 定位与交接状态机迁移规则 | 严重度 4-1 |
| 7 | §3.1 / §3.3 | 补规划中心五层表名与「进度不由完成率推断」口径 | 增强准确性 |
| 8 | §5 矩阵 | 新增「现有目录 ID」列，20 项逐条对齐真源 | 缺口 1 |
| 9 | §5 下方 | 补 P3 枚举缺口与目录覆盖缺口说明 | 严重度 3-3、缺口 1/2 |
| 10 | §6.1 表格 | 补「导航 ID」列，页面名改为导航真实标签 | 增强准确性 |
| 11 | §8.1 | 两类 Token 分列表格，标明 HTTP 侧明文为待偿技术债 | 严重度 4-5 |
| 12 | §9 | 阶段 Phase 0–6 → **S0–S6**，加阶段轴说明 | 严重度 3-3 |
| 13 | §9 S4 | R3 补全为五项；补「R0–R3 均为目标态设计」前提 | 严重度 4-3、4-4 |
| 14 | §12 | 补与既有 ADR（0002/0004/0005）的一致性说明 | 增强准确性 |
| 15 | §13 | `featureCatalog.ts` 描述改为「62 条 / 7 分区」；补 `AGENT_COVERAGE_MATRIX.md` 一行 | 严重度 4-2 |

---

## 9. 遗留与建议

> **编号订正（2026-11-20）**：本节原文的「Phase 1 开工前」指本文档初稿遗留的阶段编号冲突（战略
> 文档 v1.0 元数据写 Phase 0、本报告写 Phase 1，而 §9 阶段轴已改名 S0–S6）。第二轮整改已统一为
> S0–S6，本节「Phase 1」一律读作「**S1**」，原始措辞保留于下文以追溯。

1. **Phase 1 开工前**需在 `featureCatalog.ts` 补登记：Agent 共享工作空间、Context Engine、Agent Handoff、Agent 能力目录四个条目，并同步 `docs/ROADMAP.md`（两处状态/ID/计数必须一致）。`docs/ROADMAP.md:186-187` 另有明确约束：「不得以行动中心或 MCP 的现状宣称已完成」。
2. **A19 / A20 的 P3 归属**需单独决策（归 P2 或扩展 `FeaturePriority` 枚举），后者属目录公开契约变更。
3. **HTTP 接入 Token 明文存储**建议作为独立技术债条目处理，与 MCP 侧哈希设计保持一致。
4. **R0–R3 验收**须以 `RELAY_INTEGRATION.md` 的目标态设计为基线，并补验「任务互链」与「工作现场入口互跳」两项。
5. **适配器真实联调**若补齐 Trae / ZCode / Claude Code / Cursor / Gemini CLI，须同步更新 `AGENT_COVERAGE_MATRIX.md` 与 `featureCatalog.ts` 的 `verification` 字段（现为 `unverified`）。
6. 本报告未执行任何构建、测试或真机验证；所有结论为静态代码与既有文档证据。

---

## 10. 交付物

| 文件 | 说明 |
|---|---|
| [AGENT_ERA_STRATEGY.md](AGENT_ERA_STRATEGY.md) | 战略文档 v1.0（第一轮已按核对结果订正，`[核对]` 标记处为实测结论） |
| 本报告 | 事实核对与偏差清单 |

---

## 11. 第二轮核对追加（2026-11-20，跨模块架构审计）

> 第一轮审计遗漏了项目中枢、协作中心、开发效率中枢三个模块，且部分结论已被后续开发（v78 / v81）
> 推进或推翻。本轮按用户要求做全面跨模块审计与整改，**只处理架构、产品规划、数据所有权和文档，
> 未开发新业务功能、未修改数据库迁移**。战略文档已升版 v1.1，标注 `[核对²]` 处为本轮实测结论。

### 11.1 核对方式

- 3 路只读子 Agent 并行/串行审计：项目中枢（docs/project-hub/ 8 文档 + src/lib/projectHub/ + db/mod.rs + project_hub/）、协作中心（docs/collab-center/ 8 文档 + src-tauri/src/collab/ 16 文件 + 前端）、开发效率中枢（docs/developer-efficiency/ 7 文档 + dev_workbench + dws + handoff 交叉）。
- 主架构师自查：agent-workspace 验收报告全文与 acceptance 脚本、`agent_access/context.rs`、适配器注册表（`managed.rs` / `discovery_only.rs`）、RELAY_INTEGRATION.md 全文、featureCatalog 实测、行动中心 `actions/mod.rs`、能力中心 `capability/`。
- 真实执行的检查：`npx vitest run src/lib/featureCatalog.test.ts`（两次，编辑前后均 24/24 通过）；其余为静态证据。

### 11.2 第一轮结论的更新与修正

| # | 第一轮结论 | 第二轮实测 | 处置 |
|---|---|---|---|
| 1 | 适配器真实联调「5/7」 | 分母 7 为历史口径（Claude Code / Cursor / Gemini CLI 落地前）；注册表现为 10 全功能 + 11 仅发现型，现行口径 **5/10** | `AGENT_COVERAGE_MATRIX.md` 已更正并保留历史记录；战略文档 §2.4 同步 |
| 2 | 「MCP 传输层、真机 UI、安装包、性能基线仍未验收」 | 被 acceptance-report 后续章节部分推翻：MCP 端到端已通过（§11 headless + v81 场景 C）、正常 GUI 启动已通过（§12）、Release 构建已产出 NSIS 安装包（v81） | 战略文档新增 §2.5 分项验收表；`development-progress.md` 过时结论已加更正注 |
| 3 | 目录覆盖缺口 4 类 | 扩大为 **6 类**（补：协作中心 collab、项目中枢 project_hub 均无 featureCatalog 条目）；另 `workbench.planning-center` 描述滞后（代码四数据源，条目仍写「双数据源」） | 战略文档 §5 更新；登记方案列入待用户确认清单 |
| 4 | 「62 条目录」计数 | 实测确认：`featureCatalog.test.ts` 断言并运行通过 total=62 / implemented 33 / partial 24 / planned 5 / blocked 0 / verified 10 / unverified 52；分区 core 9 / workbench 9 / workflow 16 / info 3 / agent 11 / ecosystem 5 / system 9 | `docs/ROADMAP.md` 计数行 61/23/51 → 62/24/52 更正，补 `security.secure-vault` 行（目录已有、ROADMAP 漏登） |
| 5 | 「行动中心 implemented/verified」 | 确认；并核实行动中心无独立表（SQL 分类自 `agent_events`/`agent_runs`），是聚合视图而非审批数据库 | 写入 §2.6 矩阵 |
| 6 | `build_agent_context` 记法修正 | 保持；另发现**第二套装配系统** `capability::context`（配置化 Profile + `assemble_impl` + MCP 工具 `taskdock_get_task_context`），与 `agent_access::context` 边界此前无文档 | 战略文档 §3.2 增两套系统边界 |
| 7 | Handoff「A→B→C 完整交接场景仍需验证」 | 精确化：A→B 双 Agent 交接已入端到端验收（v81 场景 E 5/5）；三 Agent 链、跨会话续接未验；自动分工/冲突仲裁不存在 | §3.4 已有/未有区分 |
| 8 | —（第一轮未覆盖） | v78 已落地（提交 `e68d1e7` 等）：`MIGRATION_78` + 3 命令 + 最小 UI；`docs/project-hub/README.md` 状态区与 §5 表过时（称未实施） | README 已加带日期更正 |
| 9 | —（第一轮未覆盖） | 协作中心 `workspace_project_id` 仅落 DDL + 回填，服务层零接线（`grep` 于 `src-tauri/src/collab/` 零命中）——**半迁移状态**；`collab_*` 外键仍指 `planning_projects` | §4.3 数据所有权表如实记录；不得宣称已统一 |
| 10 | —（第一轮未覆盖） | 开发效率中枢 12 个命令（文档写 11）；`dev_handoff_packs` 与 `agent_handoffs` 与 collab 方案审批**三种交接实体并存**、`dev_acceptance_records` 与 collab verify **两套验收系统并存**，边界仅靠文档约定 | §2.6 / §3.4 消歧；取舍决策列入待确认清单 |
| 11 | —（第一轮未覆盖） | docs/collab-center/06 验收清单与 README/03/验收报告结论矛盾（06 未随第二轮回填）；10 个已注册 IPC 无前端调用方 | 列入遗留风险 |
| 12 | ADR-A01–A12「冻结」 | 用户尚未确认，应为 **Proposed** | `docs/adr/README.md` 与战略文档 §12 已改 |

### 11.3 第二轮实测证据表（关键项）

| 断言 | 证据 |
|---|---|
| 注册表 10 全功能 + 11 仅发现型 | `src-tauri/src/agents/managed.rs` `all_adapters()`（codex/trae/workbuddy/qoder/opencode/dsh/zcode/claude/cursor/gemini）；`discovery_only.rs`（windsurf/cline/roo-code/copilot/antigravity/kiro/continue/aider/augment/openhands/openclaw） |
| 目录计数 62/33/24/5/0、verified 10 | `npx vitest run src/lib/featureCatalog.test.ts` 24/24 通过（2026-11-20 两次执行，编辑 agent.builtin 前后各一次） |
| v78 已落地 | `db/mod.rs:2124` 挂载 `project_hub::schema::MIGRATION_78`；`lib.rs:1596-1598` 注册 3 命令；`project_hub_schema.rs` 4/4 集成测试（docs/project-hub/04 §12.5 与 07-迭代计划 §9 引用） |
| 项目根双向弱引用 | `planning_projects.workspace_project_id` + `workspace_projects.active_plan_id`（`project_hub/schema.rs:16,18-21`），无真实外键 |
| collab 半迁移 | `project_hub/schema.rs:190-207` 加列 + 回填；`grep workspace_project_id src-tauri/src/collab/` 零命中 |
| 两套上下文装配 | `agent_access/context.rs:1022` `pub fn build(db, principal, req)`（DEFAULT_BUDGET=6000/MAX_BUDGET=24000）；`capability/context.rs` `assemble_impl` + `capability/schema.rs:141` `capability_contexts`；`mcp/capability_tools.rs:50` `taskdock_get_task_context` |
| v81 端到端 36/36 | `docs/agent-workspace/acceptance-report.md` v81 修订轮（A 7/7、B 6/6、C 7/7、D 8/8、E 5/5、F 1/1）；脚本 `scripts/acceptance-agent-access-v81.mjs`（隔离 `TASK_DOCK_DATA_DIR`，非 headless） |
| 行动中心无独立表 | `src-tauri/src/actions/mod.rs`（单文件 SQL 分类，`AUTH_KEYWORDS` :33-38 为授权类型关键词） |
| Relay 无代码 | `grep -ri relay src-tauri/src/ src/` 无协议/连接器实现；`RELAY_INTEGRATION.md:312`「本轮（预研）不实施 R1–R3」 |

### 11.4 第二轮交付物

| 文件 | 说明 |
|---|---|
| [AGENT_ERA_STRATEGY.md](AGENT_ERA_STRATEGY.md) | v1.1：状态改「事实核对完成、待产品战略确认」；新增 §2.5 验收分项、§2.6 模块职责矩阵、§4.3 数据所有权核对、§4.5 两层协调边界；§5 矩阵重构为九列映射；§12 ADR 改 Proposed |
| 本报告 | 第一轮（§1–§10）+ 第二轮追加（§11） |
| `docs/adr/README.md` | 战略草案与正式 ADR 分列，ADR-A01–A12 改 Proposed |
| `docs/ROADMAP.md` | 计数更正 62/24/52 + secure-vault 行补登 |
| `AGENT_COVERAGE_MATRIX.md` | 真实联调口径更正 5/10（保留 5/7 历史） |
| `src/lib/featureCatalog.ts` | `agent.builtin` 已有/未有能力区分（不改状态/计数） |
| `docs/project-hub/README.md` | v78 实施状态更正（带日期） |
| `docs/agent-workspace/architecture.md` | `build_agent_context` 记法更正为真实符号 |
| `docs/agent-workspace/development-progress.md` | 「启动缺陷未修复」过时结论加更正注（被 acceptance-report §12 推翻） |
| 任务级整改报告 | `tmp/acceptance/agent-era-strategy-round2/report.md` |
