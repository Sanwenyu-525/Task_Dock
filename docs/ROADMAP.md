# 功能规划目录（v0.7 起统一维护）

> **唯一事实源**：[src/lib/featureCatalog.ts](../src/lib/featureCatalog.ts)。
> 本文档与其同源；应用内入口为完整工作台左侧导航「**规划中心**」（Ctrl+7，Tab 身份仍为 `roadmap`）。
> v0.7 起「规划中心」为双数据源：本目录（Task Dock 自身规划，只读）+ 用户自建项目
> （SQLite `planning_*` 表，可创建/编辑/归档/删除，见 docs/ARCHITECTURE.md 数据模型）。
> **用户项目不写回本目录与 featureCatalog.ts；两者互不影响。**
> 12 项核心功能使用固定 ID 并由自动化测试锁定数量（`featureCatalog.test.ts` / `featureRoadmapContract.test.ts`），
> 防止遗漏或重命名。**「核心 12 项」是固定 ID 集合，不等于某个展示分区的条目数**。

**状态口径**（实现状态 ≠ 验收状态）：

- implemented 已实现 —— 用户当前可用，卡片/表格给出现有入口
- partial 部分实现 —— 已具备能力与剩余缺口分别登记；必须给出真实可用入口
- planned 待开发 —— 仅登记规划，**不代表功能可用**
- blocked 受阻 —— 等待外部接口或平台条件，注明原因

**验证口径**：verified = 该功能当前范围内有自动化测试或历史真机验收证据；unverified = 未充分验证。
**「已实现」不等于「已通过验收」**。按目录契约，`partial` 不标 verified（缺口的验收尚未完成）；
子链路的真机证据写入条目 `detail`，不外推为整体通过。

**当前计数（2026-11-16，按 `featureCatalog.ts` 实测）**：

共 **49** 项（核心 **12** 项）· 7 个展示分区
——已实现 **22** · 部分实现 **22** · 待开发 **5** · 受阻 **0**；已验证 **10** · 未验证 **39**。

> 统计由 `featureCatalogSummary()` 生成，测试锁定总数、状态与验证计数；不要手工改数字而不改目录。

---

## 核心效率功能（P0，8 项）

> 本节是 P0 展示分区；12 项核心 ID 中的文件暂存架、一键工作流、通知聚合、专注与休息、
> 全局搜索、快速笔记、生活例行事项分别登记在「工作流与效率增强」「信息管理与生活效率」分区。

| 功能 | 状态 | 已具备 / 缺口摘要 |
|---|---|---|
| 全局快速捕获 `core.quick-capture` | implemented | 独立捕获窗（Ctrl+Shift+Space / 托盘右键），五类型分别进任务或收集箱；草稿防抖保存与唤起恢复；client_id 单事务幂等；唤起前焦点尽力恢复。真机热键/焦点/DPI 未验证 |
| 场景工作区 `core.scenario-workspace` | partial | 独立场景实体（v38）、创建/编辑/删除/复制、应用+网址+目录+现场+工作流+暂存软关联、一键进入与逐项回执；进入取消/整体超时/后端互斥/删除守卫已交付（2026-11-08）。缺口：「退出场景」动作、场景专属设置与任务关联、多显示器/DPI/前台争用真机验收 |
| Agent 行动中心 `core.agent-action-center` | implemented ✅已验证 | 需介入/通知/历史三层分类、幂等确认、去重、全局 SQL 计数、跳转会话。入口：导航「行动」、胶囊 Agent 面板。**禁止重复开发第二套** |
| 工作现场恢复 `core.workspace-restore` | partial | 保存/恢复/取消/任务关联、逐项验证级别与失败降级；v40 窗口几何捕获与恢复（矩形/显示器/DPI、60% 可见安全网、不落 HWND/PID）。缺口：浏览器多标签恢复、恢复前预览、几何真机验收 |
| 智能日程提醒 `core.smart-reminders` | partial | 自然语言创建、重复规则引擎、提醒与场景/现场联动（用户点击才执行）、延后/补触发。缺口：法定节假日/调休（按设计不接）、真机双主题与窄窗 |
| 开发工作台 `core.dev-workbench` | partial | 当前任务锚点（显式设置键）、任务优先四区域、复用 task_context / agent_snapshot / 行动中心 / 现场恢复。缺口：项目目录、Git 与测试结果归集（P1）；帮助教程为 draft |
| 智能剪贴板 `capture.clipboard` | implemented ✅已验证 | 五类采集与哈希去重、自动分组（45s 默认/可配）、历史检索、整组复制、目标窗口逐项粘贴（失败停止）、本机 OCR、任务关联与 Agent 导入包；敏感过滤 fail-closed。五轮 GUI 联合验收 + 真机证据；边界见 `docs/clipboard/` |
| 应用启动与窗口切换 `core.app-launcher` | partial | 本机应用扫描与真实图标、网格排序、导航目标、四级导航（启动→唤醒→工作区→会话，缺接口如实降级）、批量启动。缺口：L3 未逐项核验、L4 以 Codex 为主、多窗口实例无法精确锁定、未登记应用不参与应用搜索 |

## 工作台与专业创作（6 项）

| 功能 | 状态 | 已具备 / 缺口摘要 |
|---|---|---|
| 统一大型工作台 `workbench.unified` | implemented | U0（2026-11-14）：胶囊 / 快捷工具面板 / 独立大型工作台三层职责；20 条路由；统一导航复用 navigationRegistry + navVisibility；workbench_layout 恢复路由/项目/右栏/分栏宽度；ModuleRunControl + useLifecycleStore 管理模块启停；workbenchOnly 与 workspaceProfiles 构成专业模块接入协议。20 路由验收为部分通过（Windows 原生通道未执行） |
| 专业项目工作空间 `workbench.projects` | partial | 五种项目类型（development / game / ai_comic / general / novel）、项目 CRUD/归档、事项与阶段树、任务与暂存弱关联、开发型复用 dev_projects（Git/Agent 快照）、每项目独立窗口状态、三层入口、能力四态声明。缺口：core.layout 只有当前模块写回；项目级笔记/Agent/产物关联；项目进度字段；跨设备项目同步；多显示器/DPI 真机走查 |
| 多目录文件工作区 `workbench.files` | implemented | 递归分割树（12 窗格/深度 6/每窗格 12 标签）、自由打开目录与四方向分栏、布局持久化、标签管理、复制/移动/重命名/新建/删除（回收站与永久删除独立确认）、跨窗格拖拽、外部 OS 拖入复制语义、冲突整批一次决策、类型图标与缩略图、搜索排序；已接入多目录联合搜索、批量重命名、目录对比、快速预览与重复文件查找（大小预筛 + 显式哈希）。真实拖拽/回收站/缩略图待原生真机验收 |
| 小说创作工作台 `create.novel` | partial | v58 卷→章树、纯文本正文、自动保存、字数统计、8 MiB 单章上限、备份；项目概览/写作事项/任务关联。缺口：人物、世界观、大纲、版本记录、Markdown/导入导出/全文搜索、AI 辅助（均为 planned，无假入口）；长篇原生走查未执行 |
| 游戏开发工作台 `create.game` | partial | 游戏项目类型、概览/制作事项/任务关联/设置、以事项阶段承载关卡/系统/美术阶段。缺口：GDD、角色/场景/资源库、构建与测试流水线、产物登记、引擎跳转、测试与缺陷跟踪；构建/资源能力为 planned |
| AI 漫剧工作台 `create.ai-comic` | partial | 漫剧项目类型、剧集与镜头导航、以事项阶段承载 episode/shot（limited）、任务关联。缺口：剧本、分镜元数据与镜头-场景关联、角色与素材库、生成管线、版本比较与采用、制作看板与 Agent 协作；生成能力为 unavailable |

## 工作流与效率增强（13 项，P1 为主，含 3 项 P2）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 文件暂存架 `core.file-shelf` | partial | 独立界面、四种添加方式、引用/托管双存储、搜索筛选、批量操作、过期清理（dry-run + 二次确认）、任务关联、备份、场景软关联；2026-11-09 接入系统级拖出（OLE DoDragDrop + CF_HDROP）。缺口：真机拖入/拖出验收、暂存架侧场景归属展示 |
| 一键工作流 `core.one-click-workflow` | partial | 白名单动作编排、暂停/继续/取消、逐步骤反馈、单运行槽 + 操作 ID 幂等、开发/办公模板、运行历史、场景步骤（三层允许/第四层拒绝）。缺口：LiveExecutor 无自动化测试、真机窗口跳转未验证 |
| 智能通知聚合 `core.notification-aggregation` | partial | 双额度限流、完成合并摘要、静音、历史持久化。缺口：跨来源聚合视图、逐条优先级、通知摘要视图 |
| 专注与休息 `core.focus-timer` | implemented ✅已验证 | focus_* 12 个命令、番茄钟/正计时、休息与久坐提醒、每日记录与历史、任务关联、胶囊徽标。真机 2026-11-04 走查开始→暂停→继续→取消与重启恢复 |
| 全局搜索 `core.global-search` | partial | 统一检索层与八类跳转、分类筛选、确定性排序、最近搜索、SQL 参数绑定与 limit+1。缺口：已发现未登记应用、FTS5 索引 |
| 任务统计与效率分析 `tasks.stats-trends` | implemented ✅已验证 | 日/周/月统计、完成率/逾期率/分类效率、history_complete 不伪造分母。真机 2026-11-04 走查 |
| 自定义全局快捷键 `ux.custom-hotkeys` | implemented ✅已验证 | hotkeys_snapshot/change/reset、录制控件、冲突与系统占用降级、即时生效与重启保持、随备份迁移。真机 2026-11-04 走查 |
| 图片放大及全屏预览 `ux.image-fullscreen` | implemented ✅已验证 | 图片灯箱：缩放/平移/双击/另存为，弹层栈隔离 |
| 剪贴板多类型专用查看器 `ux.clipboard-viewers` | implemented ✅已验证 | HTML 白名单只读、图片灯箱、文件预览、URL 详情；是 `capture.clipboard` 的子能力，单独登记用于查看器专项 |
| 全局命令面板 `ux.command-palette` | implemented | 全局搜索内建命令层：打开页面/新建任务/创建提醒/打开设置/进入场景/运行工作流；命令派生自 NAV_ENTRIES 与设置分组；白名单拦截危险操作。缺口：独立快捷键、跳转子页高亮、真机走查 |
| 帮助与教程中心 `ux.help-center` | partial | 8 分类 **28 篇**教程（24 verified / 1 needs_review / 3 draft：句式命令、开发工作台、能力导览）；搜索/分类/最近浏览/状态徽标/功能跳转；help:check 0 blocker。缺口：语义漂移无自动检测、3 篇 draft 待人工核对、mcp-authorization 待转 verified、真机走查 |
| 句式命令 `ux.command-phrases` | implemented | 封闭帧表（完成/改期/优先级/本周完成/逾期/今天/Agent 失败）、复用 nlp.rs、两段式确认、状态复核防反开、帧表外零损失回退搜索。缺口：CDP/真机走查与全量回归 |
| 首次使用引导 `ux.onboarding` | implemented | 三步引导、页内卡片、可跳过/返回、Escape 走 overlayStack、localStorage 持久化、帮助中心与设置可重开。缺口：真机双主题/窄窗/DPI |

## 信息管理与生活效率（P2，2 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 快速笔记 `core.quick-notes` | implemented ✅已验证 | notes 表 + 11 个命令、自动保存、收藏置顶、搜索、模板、任务/现场关联、捕获转笔记、全局搜索。真机 2026-11-04 走查与备份恢复 |
| 生活例行事项 `core.life-routines` | partial | 复用周期任务引擎（每日/每周多日/每月+间隔）、到期提醒与自动推进。缺口：今日待办视图、打卡与连续记录、历史与延后、自定义分类。**不建第二套任务系统** |

## Agent 扩展（10 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| Agent MCP Server `agent.mcp-server` | partial | stdio JSON-RPC + loopback bridge、scope 与逐项目授权、mcp_audit_log 审计、原始 18 个规划工具 + 23 个任务/笔记/工作流/工作区工具、能力授权与工作区根边界、7 步连接诊断、审计保留策略、expected_revision/expected_updated_at 乐观并发、Agent 不可置 completed。2026-11-16：mcp 单测 51 passed，设置页 vitest 11 passed。缺口：真实客户端联调（本机未安装 → ENVIRONMENT BLOCKED）、长时间/性能数据、桌面 UI 真机走查、工作流执行与文件写入本轮不开放 |
| Codex App Server 深度接入 `agent.codex-app-server` | partial | 已有 hooks 7 事件 + codex resume。缺口：app-server stdio JSON-RPC（线程恢复、中断回合、完整对话事件）、App/CLI 来源区分 |
| Claude Code 专用适配器 `agent.claude-code-adapter` | implemented | 官方 Hooks 安装/卸载、多文件事务、二进制能力线索。真实会话未触发 → unverified |
| Cursor 专用适配器 `agent.cursor-adapter` | implemented | 用户级 hooks.json、camelCase 事件映射。真实会话未触发 → unverified |
| Gemini CLI 接入 `agent.gemini-cli` | implemented | 11 个生命周期事件基线、AfterAgent/SessionEnd 映射。真实会话未触发；SessionEnd 为 best-effort |
| ZCode 官方 Hooks 接入 `agent.zcode-integration` | partial | 配置根/可执行文件/进程发现、7 事件自动安装与卸载、保留第三方条目、写入前备份。缺口：真实 ZCode 会话端到端验证 |
| Agent 工作时间统计 `agent.work-time-stats` | implemented ✅已验证 | 执行/等待时长、失败率、按来源与会话、真实/模拟隔离、空态口径。真机 2026-11-04 走查 |
| Agent 执行时间轴 `agent.execution-timeline` | partial | 历史页统一事件时间轴（按日分组、重复聚合）。缺口：按 run 可视化、时长统计 |
| 内置 Agent：目标推进与任务接续 `agent.builtin` | planned | **尚未实现执行循环**。现有行动中心/MCP/开发工作台只提供观测、读写与任务锚点，不等于内置 Agent。规划：目标拆解、持续执行、跨会话接续、多 Agent 交接、结果归集、风险发现、人工审批、完成判定 |
| Relay Agent 集成 `agent.relay` | planned | 仅有预研（docs/RELAY_INTEGRATION.md，2026-11-14），无协议/服务端/连接器。规划：协议与信任模型、配对鉴权重连、任务交接与结果回传、失败恢复、权限审计；**不得把 MCP 冒充 Relay** |

## 长期生态（P2，5 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 多语言 i18n `eco.i18n` | partial | 语言资源层、设置切换、日期/错误码本地化、主导航与设置页中英覆盖、备份迁移。缺口：Agent 向导、任务/工作流/规划编辑器、剪贴板详情等内部文案 |
| 桌面微件库 `eco.widgets` | partial | 6 类微件、看板与独立 widget.html 宿主、尺寸/置顶/拖动保存、随备份迁移。缺口：多显示器插拔、100–200% DPI、重启恢复与资源回收真机验证；注册机制未开放 |
| 第三方插件系统及沙箱 `eco.plugins` | planned | Adapter/视图插件；沙箱与权限设计先行 |
| WebDAV / 文件同步 `eco.sync` | planned | 用户显式开启的自托管同步，默认永不开启；凭据不入日志 |
| macOS / Linux 适配 `eco.cross-platform` | planned | 平台抽象已预留；需补 Vibrancy/AppIndicator/剪贴板平台层 |

## 设备、系统与数据（5 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 移动端伴随应用 `mobile.companion` | partial | Android 端本地 SQLite；扫码/深链配对（TLS-only + SPKI 固定）、任务/收集箱/笔记双向增量同步（rev/outbox/冲突页/墓碑）、文件互传 v1、统一采集中心、分享接收、小组件与入口自定义。物理机证据 2026-11-09/13/14。缺口：后台自动同步仅设计、无 workspace_projects 同步与跨设备接续、无 iOS、墓碑日志保留期清理 |
| Android 屏幕镜像与独立虚拟屏 `mobile.virtual-display` | implemented | ADB/scrcpy 会话管理：mirror / virtual 两种模式、状态机与阶段、25s 超时回收、WM_CLOSE→强杀→Job Object、应用选择、窗口定位/截图/诊断、多屏实验默认关闭（最多 2 会话）。运行期身份不落库。本地化应用名未启动过时回退包名 |
| 资源管理与智能清理 `system.resources` | implemented | 应用缓存（TTS/暂存架残留/无引用缩略图）与用户级垃圾（回收站/临时/崩溃转储）两套独立能力；预览只读 + previewId 一次性消费 + 归属/身份/年龄复核 + 作业闸 + 暂存架互斥；资源占用与只读进程诊断。真机 Tauri 窗口高 DPI 走查未执行 |
| 诊断中心 `system.diagnostics` | implemented | 脱敏 DiagnosticEvent、有界队列 + 单写线程 + JSONL 轮转/聚合；异常列表与 operationId 操作链、摘要/导出/清理；页面可见才查询，不做后台轮询。预览夹具缺 IPC handler，真实数据链未验收 |
| 备份与恢复 `system.backup` | implemented ✅已验证 | 完整/快速备份、流式 JSONL bundle + 完整性校验、恢复状态机可续跑/回滚、preferences.json、BACKUP_TABLES；P1-04 PASS（100k 夹具 61.9MB 往返、真机 78.44MB 恢复 14.28s、25 表一致、21 个故障测试）。多 GB 包未测 |

---

## 变更记录（2026-11-16 数据治理）

- **审计范围**：`featureCatalog.ts` 原 34 项逐字段核对 + 仓库全局扫描未登记模块 + 导航入口映射。
- **补登 15 项**：统一工作台、专业项目工作空间、多目录文件工作区、小说/游戏/AI 漫剧工作台、
  智能剪贴板、应用启动与窗口切换、内置 Agent、Relay、移动端伴随应用、Android 虚拟屏、
  资源管理、诊断中心、备份与恢复。
- **新增 2 个展示分区**：「工作台与专业创作」「设备、系统与数据」；分区类型、顺序、元数据、测试同步。
- **修正既有条目**：帮助教程计数 25 → 28（初审实测 27，补「能力导览」后 24/1/3）；为文件暂存架、全局搜索、生活例行事项、
  Codex App Server 补 `entryPoints`；补登 `capture.clipboard` 与两个查看器的父子关系说明。
- **未合并的方向**：任务 CRUD 本体、产品规划中心（我的项目）、胶囊/窗口外壳、构建调度器属于
  产品底座或开发基础设施，不单独立项；移动端专属能力归属 `mobile.companion`，不拆分。
- **未改**：12 个核心 ID、用户项目数据结构、规划中心 UI、任何业务功能实现。

> 历史过程（保留）：2026-11-05 Claude/Cursor/Gemini 适配器 planned→implemented；2026-11-06 规划纠偏
> 修正场景/工作流/MCP/帮助四项描述；2026-11-08 新增全局命令面板、场景取消/互斥、v40 窗口几何；
> 2026-11-11 新增句式命令；2026-11-12 新增开发工作台 P0；2026-11-15 工作台 20 路由与项目工作空间验收。
> 这些记录只说明演变，当前计数一律以本节上方 2026-11-16 统计为准。

## 维护规则

1. 新增/修改功能规划：**先改 `featureCatalog.ts`，再同步本文档**；两处状态、ID、计数必须一致。
2. 12 项核心功能的固定 ID 是公开契约，测试锁定 `CORE_FEATURE_IDS` 数量为 12；不重命名、不复用。
3. 功能落地后：更新状态并补充 `entryPoints` 与验证证据；已验证才写 verified；partial 必须列缺口。
4. 新增分类必须同时改 `FeatureCategory`、`CATEGORY_META`、`CATEGORY_ORDER` 与目录测试，
   不允许只加数据导致页面无法展示。
5. 失效规划及时移除并在本文件保留一句移除说明；历史验收记录保留原数字，不改写为当前统计。

## 近期推荐开发顺序（2026-11-16 复审）

1. **P0 可靠性收口**：统一工作台 20 路由的 Windows 原生通道验收；文件工作区真实拖拽/回收站/
   缩略图；剪贴板与暂存架的真机拖放链路。
2. **项目工作空间补全（P0/P1）**：core.layout 排序/隐藏编辑入口、项目级笔记与 Agent 关联、
   项目进度字段；之后才考虑跨设备项目同步。
3. **专业创作纵深（P1）**：小说人物/世界观/大纲（需新迁移）→ 游戏资源与构建适配器 →
   漫剧分镜元数据与素材库；三者的 `planned/unavailable` 能力在接入前不得渲染可点击入口。
4. **移动端协作（P1）**：前台自动同步已有，下一步是后台同步与 `workspace_projects` 项目接续；
   先补墓碑日志保留期与多厂商保活验收，再谈 iOS。
5. **内置 Agent / Relay（P1，长期）**：先冻结协议、审批与信任模型，再做最小执行闭环；
   不得以行动中心或 MCP 的现状宣称已完成。

> 以上顺序为建议，不代表已排期；任何一项开发前以其 `acceptanceCriteria` 为验收基线。

## 历史推荐顺序（2026-11-06，保留）

1. **发布稳定性收尾（P0/P1）**：`cargo test --lib` 全量绿（1386 passed / 0 failed / 6 ignored）。
2. **核心功能真机验收（P1）**：场景一键进入、工作流「进入场景」、MCP 真实客户端联调。
3. **已有功能的价值缺口（P1/P2）**：场景取消/互斥（已完成）、工作流逐项回执（已完成）、
   提醒与场景/现场联动（已完成）、通知跨来源聚合、生活例行专用视图。
4. **长期候选（不排期）**：通用多 Agent 消息中转、插件沙箱、WebDAV、macOS/Linux。

## 已完成并从规划移除（避免失效条目）

- Qoder / WorkBuddy 专用适配器：hooks 接入已实现并真实联调，见 [AGENT_COVERAGE_MATRIX.md](../AGENT_COVERAGE_MATRIX.md)。
- Agent 人工介入收件箱：已落地为 Agent 行动中心 `core.agent-action-center`。
