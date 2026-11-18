# 历史规划 → 功能目录映射索引

> **本文件不维护功能状态与计数**。唯一事实源是 [src/lib/featureCatalog.ts](../../src/lib/featureCatalog.ts)，
> 面向读者的路线图是 [docs/ROADMAP.md](../ROADMAP.md)。本文件只记录「历史需求从哪来、归到哪个
> 功能 ID、做了什么决策」，用于回答「这个需求是不是已经做了 / 被合并了 / 被取消了」。

## 0. 证据分类方法（2026-11-06 更正）

三个维度**彼此正交**，不得混用：

| 维度 | 可选值 | 说明 |
|---|---|---|
| 需求来源 | 历史聊天原文 / 历史聊天摘要 / 正式需求文档 / 当前用户明确要求 / 来源不可确认 | 只回答「谁在什么时候提出了这个方向」 |
| 实现证据 | 当前源代码 / 自动化测试 / 正式技术文档 / 历史验收报告 / Windows 真实操作证据 | 只回答「现在做到什么程度、有没有验证」 |
| 决策状态 | 归入现有功能 / 独立保留 / 暂缓 / 取消 / 待决策 | 只回答「这件事怎么处理」 |

**本轮更正**：上一版把 `src-tauri/src/commands/scenario.rs`、`src-tauri/src/mcp/`、`src/help/` 等
标为「来源等级：原文」，属于错误分类——这些文件只能证明**当前实现存在**，不能证明历史聊天消息
的原始内容或措辞。本轮统一改为「实现证据」列，需求来源列不再用源码充数。

**HISTORY_SOURCE_INCOMPLETE**：本轮可取得的「功能 | 规划（长期）」历史上下文为主题摘要，
未取得原聊天逐字归档。因此下表中除明确标注「当前用户明确要求」者外，需求来源一律为
**历史聊天摘要**；只能确认方向存在，不能据此推断当时的完整方案、优先级或验收标准。

## 1. 历史需求映射

| # | 历史需求（主题） | 需求来源 | 实现证据 | 归属功能 ID / 落点 | 决策状态 |
|---|---|---|---|---|---|
| 1 | 后续功能规划 | 历史聊天摘要 | 正式技术文档 `docs/ROADMAP.md` + 自动化测试 `featureCatalog.test.ts` | 目录本体（`featureCatalog.ts`） | 归入现有功能（单一事实源） |
| 2 | 工作与生活效率功能扩展 | 历史聊天摘要 | 当前源代码 `tasks/` `notes/` + 自动化测试 | `core.life-routines`、`core.smart-reminders`、`core.quick-notes` | 归入现有功能（拆分） |
| 3 | 产品规划中心 | 历史聊天摘要 | 当前源代码 `commands/planning.rs` + 自动化测试 + 正式技术文档 `docs/roadmap/planning-center.md` | 用户项目 `planning_*` + 内置目录 `workbench.planning-center` | 独立保留（双数据源隔离） |
| 4 | 场景工作区 | 历史聊天摘要 | 当前源代码 `commands/scenario.rs` + v38 迁移 + 自动化测试（5 个深度/循环用例） | `core.scenario-workspace` | 独立保留（不并入现场恢复） |
| 5 | 智能日程提醒 | 历史聊天摘要 | 当前源代码 `nlp.rs` + 重复规则 + 自动化测试 | `core.smart-reminders` | 归入现有功能（复用任务/提醒） |
| 6 | 文件暂存架与文件夹投递 | 历史聊天摘要 | 当前源代码 `shelf/` + 80 单测 + 历史验收报告 `tmp/acceptance/file-shelf/` | `core.file-shelf` | 独立保留（独立资产） |
| 7 | 快速收集与笔记 | 历史聊天摘要 | 当前源代码 `capture/` `notes` + 自动化测试 | `core.quick-capture`（收集箱）+ `core.quick-notes`（笔记） | 归入现有功能（两实体） |
| 8 | Agent 如何接入 task_dock | 历史聊天摘要 | 当前源代码 `agents/` + 正式技术文档 `docs/AGENT_ADAPTERS.md` + 真实联调记录 | `agent.*` 适配器条目 | 归入现有功能 |
| 9 | Agent 如何修改规划中心内容 | 历史聊天摘要 | 当前源代码 `mcp/` + 自动化测试 + `tests/mcp_e2e.rs` | `agent.mcp-server` | 独立保留（权限/审计边界） |
| 10 | 首次使用引导与帮助教程 | 历史聊天摘要 | 当前源代码 `src/help/` + 自动化测试 + 正式技术文档 `docs/help/README.md` | `ux.onboarding`、`ux.help-center` | 归入现有功能（两 ID） |
| 11 | 功能变化后自动识别教程过期 | 历史聊天摘要 | 当前源代码 `operationContracts.ts` / `health.ts` + 自动化测试 | `ux.help-center`（缺口项） | 待决策（只做契约/版本/源文件变化，不做全仓扫描） |
| 12 | 最多三个 Subagent 并行开发 | 历史聊天摘要 + **当前用户明确要求** | 正式技术文档 `AGENTS.md` §3 | 开发协作规范，非产品功能 | 归入现有规范 |
| 13 | 多轮代码验收及修复提示词 | 历史聊天摘要 | 当前仓库 `.agents/skills/taskdock-acceptance` / `taskdock-remediation-prompt` | 开发流程规范，非产品功能 | 归入现有流程 |
| 14 | Agent 与应用的统一管理 | 历史聊天摘要 | 当前源代码 `agents` 行动中心 + 导航「应用」 | `core.agent-action-center` + 导航「应用」 | 归入现有功能 |
| 15 | 统一大型工作台 / 专业工作台入口 | 历史聊天摘要 + **当前用户明确要求（2026-11-16）** | 当前源代码 `src/workbench/WorkbenchShell.tsx`、`workbenchLayout.ts`、20 路由；`tmp/acceptance/workbench-final-20261115/` | `workbench.unified` | 独立保留（产品宿主，不并入开发工作台） |
| 16 | 专业项目工作空间（五种项目类型） | 历史聊天摘要 + **当前用户明确要求** | 正式技术文档 `docs/WORKSPACE_PROJECTS.md` + 当前源代码 `src/workspace/workspaceProfiles.ts` + v49/v57/v58 迁移 | `workbench.projects` | 独立保留（项目容器，不并入专业工作台） |
| 17 | 单窗口多目录文件工作区 | 历史聊天摘要 + **当前用户明确要求** | 当前源代码 `src/components/files/` + 布局树测试 + 验收报告 | `workbench.files` | 独立保留（文件系统工作区，不并入文件暂存架） |
| 18 | 智能剪贴板本体（采集/分组/粘贴/隐私） | 历史聊天摘要 | 当前源代码 `clipboard/platform.rs` + 五轮 GUI 验收 `docs/clipboard/` + README §4 | `capture.clipboard` | 独立保留（查看器作为子能力） |
| 19 | 应用发现 / 应用中心 / 快捷启动 | 历史聊天摘要 | 当前源代码 launcher 模块 + README §3 + 导航「应用」 | `core.app-launcher` | 独立保留（补齐原 §4 边界） |
| 20 | 内置 Agent：目标推进与任务接续 | 历史聊天摘要 + **当前用户明确要求** | 现状证据仅行动中心/MCP/开发工作台；无执行循环代码 | `agent.builtin` | 独立保留（planned，不以现有能力冒充） |
| 21 | Relay Agent 中转与协作 | 历史聊天摘要 | 仅有预研 `docs/RELAY_INTEGRATION.md`（2026-11-14），无服务端/协议/连接器 | `agent.relay` | 独立保留（planned） |
| 22 | 移动端伴随应用（配对/同步/互传/采集） | 历史聊天摘要 | 正式技术文档 `docs/mobile/README.md` + `apps/mobile/` + 物理机证据 2026-11-09/13/14 | `mobile.companion` | 独立保留（跨设备能力集合） |
| 23 | Android 屏幕镜像与独立虚拟屏 | 历史聊天摘要 | 正式技术文档 `docs/mobile/13-android-screen-control.md` + `vd_*` 命令 + 2026-11-13/14 实现记录 | `mobile.virtual-display` | 独立保留（不并入伴随应用） |
| 24 | 资源管理 / 诊断中心 / 备份恢复 | 历史聊天摘要 | `docs/RESOURCE_CLEANUP.md`、`docs/DIAGNOSTICS.md`、`docs/PERFORMANCE_FINAL_ACCEPTANCE.md` + 当前源代码 | `system.resources`、`system.diagnostics`、`system.backup` | 拆为三个独立 ID（不同生命周期与安全边界） |
| 25 | 小说 / 游戏 / AI 漫剧专业工作台 | 历史聊天摘要 + **当前用户明确要求** | `docs/WORKSPACE_PROJECTS.md` + `workspaceProfiles.ts` 能力四态 + v58 小说迁移 | `create.novel`、`create.game`、`create.ai-comic` | 拆为三个 ID（不同制作流程与缺口） |
| 26 | 将现有全部功能整理进内置路线图 | **当前用户明确要求（2026-11-18）** | `featureCatalog.ts` 本轮 12 项 + 导航 / 设置 / README 核对 | `core.tasks`、`workbench.shell`、`workbench.planning-center`、`capability.center`、`life.purchases`、`agent.monitoring`、`ux.theme-system`、`ux.navigation-customization`、`ux.history-center`、`system.audio`、`system.tray-autostart`、`system.settings` | 独立保留（全部登记，状态以目录为准） |

> 表中「自动化测试」只表示存在对应测试文件与用例，不代表真机行为已验证；真机状态以各功能
> `verification` 字段与验收报告为准。

> 更正（2026-11-13）：第 12 项「最多三个 Subagent 并行开发」已被 `AGENTS.md` §3.4 取代——
> 并行数量按任务独立性、依赖关系与 CPU/内存/磁盘余量动态决定，不设固定上限；Worktree 改为
> 风险驱动按需使用（§3.3）。原历史要求保留在本表，不再作为当前执行规则。

## 2. 需求去重判定

判定规则：**操作同一业务对象、共享数据模型与生命周期，仅 UI 入口不同 → 合并为同一功能；
数据所有权、安全边界或生命周期不同 → 保持独立**（不按名字相似合并）。
下表两侧需求来源均为历史聊天摘要级；判定依据为实现证据（数据模型与代码归属）。

| 原始需求 A | 原始需求 B | 判定 | 依据 |
|---|---|---|---|
| 快速捕获 | 收集箱 | 合并（同一功能两个入口） | 同为 `core.quick-capture`；收集箱是其列表视图 |
| 快速捕获 | 快速笔记 | 独立 | 收集箱条目是待处理输入，笔记是长期文档；`notes_*` 独立表 |
| 剪贴板历史 | 文件暂存架 | 独立 | 被动记录 vs 主动管理；暂存架有独立托管目录与配额 |
| 文件暂存架 | 文件夹投递（收件箱拖放） | 独立入口 + 共享落点 | 投递是「外部文件进入」的入口，最终落到暂存架条目 |
| 场景工作区 | 工作现场恢复 | 独立 | 场景=可复用预设；现场=某任务快照；场景只软引用现场 |
| 场景工作区 | 一键工作流 | 独立 | 场景是资源组合；工作流是动作编排；互为步骤与被调用方 |
| Agent 状态历史 | Agent 执行时间轴 | 合并目标 | 时间轴是历史页的呈现升级，同属 `agent.execution-timeline` |
| Agent 行动中心 | 智能通知聚合 | 独立（有交叉） | 行动中心按「需介入」处理；通知聚合是跨来源收件箱 |
| Agent MCP Server | 多 Agent 消息中转 | 独立，后者暂缓 | 前者是外部客户端读写规划数据；后者是运行期消息路由，未立项 |
| 导航隐藏 | 功能按需卸载 | 独立 | 隐藏是 UI 可见性；卸载涉及模块启停与数据保留 |
| 微件库 | 独立桌面微件 | 合并 | 同一 `eco.widgets` 的两种宿主（主窗看板 / 桌面窗口） |
| 任务智能提醒 | 生活例行事项 | 独立 | 同一数据层，视图与打卡语义不同（`core.life-routines`） |
| 帮助中心 | 首次使用引导 | 独立 | 常驻查阅 vs 一次性流程；互相提供入口 |
| 资源清理 | 开发构建缓存清理 | 独立 | 前者面向用户数据目录；后者是仓库构建治理（`scripts/build-guard.mjs`） |
| 统一大型工作台 | 开发工作台 | 独立 | 前者是 20 路由的统一宿主与模块协议；后者是「当前开发任务」的专注视图，不是同一功能 |
| 专业项目工作空间 | 小说/游戏/AI 漫剧工作台 | 独立 | 前者是项目容器与上下文（类型、事项、阶段、关联、窗口状态）；后者是各类型的专业制作流程 |
| 智能剪贴板 | 剪贴板多类型查看器 | 父子关系（不合并） | 查看器是采集本体的专项呈现层；`ux.clipboard-viewers` 保留用于查看器验收 |
| 移动端伴随应用 | Android 虚拟屏 | 独立 | 前者是跨设备数据协作；后者是运行期设备控制会话，权限与生命周期不同 |
| 诊断中心 | 资源管理与智能清理 | 独立 | 前者是可观测性（日志/异常/操作链）；后者是用户数据清理与配额治理 |
| 备份与恢复 | 资源清理 | 独立 | 备份是数据安全与可恢复性契约；清理是磁盘回收，二者不可互替 |
| Relay Agent 集成 | Agent MCP Server | 独立 | MCP 是外部客户端读写规划数据的工具协议；Relay 是运行期 Agent 间消息中转与任务交接 |

## 3. 明确暂缓 / 取消

来源均为历史聊天摘要（或按设计排除），决策状态与需求来源独立。

| 方向 | 决策状态 | 理由 | 记录位置 |
|---|---|---|---|
| 通用多 Agent 消息中转 | 暂缓（长期候选） | 需要跨进程信任模型与消息可靠性设计；无验收方案前不开发 | `docs/ROADMAP.md` 近期推荐开发顺序第 4 条 |
| 第三方插件系统及沙箱 | 待开发（`eco.plugins`） | 沙箱与权限模型先行 | `featureCatalog.ts` |
| WebDAV / 文件同步 | 待开发（`eco.sync`） | 默认关闭，冲突策略未定 | `featureCatalog.ts` |
| macOS / Linux 适配 | 待开发（`eco.cross-platform`） | 仅 Windows 有真机验收环境 | `featureCatalog.ts` |
| 双向链接 / 富文本笔记 | 取消 | 与「轻量」定位冲突，明确不做 | `core.quick-notes` detail |
| 节假日 / 调休 API | 取消（按设计） | 不接第三方节假日接口，工作日仅自然周语义 | `core.smart-reminders` |
| 任意脚本执行工作流 | 取消（按设计） | 只保留白名单动作，不引入脚本引擎 | `core.one-click-workflow` |

## 4. 已交付但未登记为目录条目的子系统（边界说明）

### 4.1 2026-11-06 判定（保留原文，作为历史决策）

以下能力已在产品中交付并有独立入口，但 `featureCatalog.ts` 未为其建立独立条目。当时按
「不以功能数量作为进步指标」的原则**不新增条目**，只在验收报告登记为目录覆盖边界：

- 产品规划中心本体（`planning_*`，导航 `roadmap`）
- 悬浮胶囊 / 磁吸 / 贴边吸附（`src-tauri/src/window*`、胶囊组件）
- 应用发现 / 应用中心 / 快捷启动（导航「应用」）
- 剪贴板历史本体（`ux.clipboard-viewers` 只登记查看器）
- 备份 / 恢复与资源清理（`commands/backup.rs`、`resource_cleanup`）

> 判断依据：这些子系统由各自模块文档（`docs/clipboard/`、`docs/shelf/`、`docs/workflows/` 等）
> 与导航矩阵 `APP_NAVIGATION_MATRIX.md` 维护，重复登记会形成第二份清单。

### 4.2 更正（2026-11-16，路线图数据治理）

上述判定中的三类已被本轮审计推翻——它们已达「独立产品能力」体量，且在多份文档/验收报告
中被当作独立对象讨论，不登记会让路线图系统性漏报：

- **应用发现 / 应用中心 / 快捷启动** → 新登记 `core.app-launcher`（partial，P0）。
- **剪贴板历史本体** → 新登记 `capture.clipboard`（implemented，P0）；`ux.clipboard-viewers` 保留为子能力。
- **备份 / 恢复与资源清理** → 拆为 `system.backup`、`system.resources` 两个 ID（不同生命周期与安全边界）；
  同批新增 `system.diagnostics`。

仍然**不新增**条目的边界（维持 2026-11-06 结论）：

- **产品规划中心本体**：用户项目是独立数据源与产品入口，不是 Task Dock 内置能力；其设计由
  `docs/roadmap/planning-center.md` 维护，路线图只登记内置目录（`FeatureRoadmapPanel`）。
- **悬浮胶囊 / 磁吸 / 贴边吸附**：属窗口外壳与交互基座，被统一工作台、快速捕获、专注计时等
  多条功能共用，单独立项会与宿主条目重复。
- **构建资源调度器**（`scripts/build-sched.mjs`）：开发基础设施，不是用户功能。
- **任务 CRUD 本体**：产品底座，被提醒、规划、工作台等复用，不单独立项。
- **移动端 UI 专属小工具**：归属 `mobile.companion`，不按单个页面拆分。

> 更正保留原判定与日期，不删除历史结论；当前规则以本节 4.2 为准。

### 4.3 更正（2026-11-18，用户要求「现有功能全部进入内置路线图」）

用户明确要求把当前全部功能整理进内置路线图，4.2 中以下「仍不新增条目」的边界被推翻并已登记：

- **任务 CRUD 本体** → `core.tasks`（任务管理与提醒闭环）。
- **产品规划中心本体** → `workbench.planning-center`（内置目录 + 用户项目双数据源）。
- **悬浮胶囊 / 磁吸 / 贴边吸附** → `workbench.shell`（窗口形态与贴边胶囊）。

同批补登 `capability.center`、`life.purchases`、`agent.monitoring`、`ux.theme-system`、
`ux.navigation-customization`、`ux.history-center`、`system.audio`、`system.tray-autostart`、
`system.settings`。

维持不登记：**构建资源调度器**（开发基础设施，不是用户功能）；移动端专属小工具仍归属
`mobile.companion`，不按单页拆分。历史判定原文保留，不回写。

> 当前规则以本节 4.3 为准；状态与计数仍只以 `featureCatalog.ts` 为唯一事实源。

## 5. 维护规则

1. 新增历史需求先在本文件登记「需求来源 + 实现证据 + 归属 ID + 决策状态」，再决定是否改 `featureCatalog.ts`。
2. 同一主题不重复生成正式报告；结论被推翻时保留旧记录并追加带日期的更正。
3. 本文件出现与 `featureCatalog.ts` 冲突的状态描述即视为错误——本文件不应出现状态字段。
4. **不得用实现证据倒推需求来源**：只有取得历史聊天原始消息才可标「历史聊天原文」；
   仅有主题级上下文时必须标「历史聊天摘要」并保留 `HISTORY_SOURCE_INCOMPLETE`。
5. 实现证据列只写可复核路径（文件/测试/报告）；真机未验证时不得写「已验证」。
