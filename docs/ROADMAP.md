# 功能规划目录（v0.7 起统一维护）

> **唯一事实源**：[src/lib/featureCatalog.ts](../src/lib/featureCatalog.ts)。
> 本文档与其同源；应用内入口为完整工作台左侧导航「**规划中心**」（Ctrl+9，Tab 身份仍为 `roadmap`）。
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

**当前计数（2026-11-20 更正，按 `featureCatalog.ts` 实测与 `featureCatalog.test.ts` 锁定）**：

共 **62** 项（核心 **12** 项）· 7 个展示分区
——已实现 **33** · 部分实现 **24** · 待开发 **5** · 受阻 **0**；已验证 **10** · 未验证 **52**。

> 更正记录（2026-11-20，第二轮架构审计）：2026-11-18 统计为 61/33/23/5/0 与 10/51；同日
> `security.secure-vault`（partial / unverified）已按用户要求登记为第 62 项（见下方
> 2026-11-18 变更记录），但本计数行与「设备、系统与数据」分区表漏更。现按目录实测与测试
> 断言（62 = 33 + 24 + 5 + 0；verified 10 / unverified 52；分区计数 system = 9）同步更正，
> 历史数字不改写、保留于 2026-11-18 记录。

> 统计由 `featureCatalogSummary()` 生成，测试锁定总数、状态与验证计数；不要手工改数字而不改目录。

---

## 核心效率功能（P0，9 项）

> 本节是 P0 展示分区；12 项核心 ID 中的文件暂存架、一键工作流、通知聚合、专注与休息、
> 全局搜索、快速笔记、生活例行事项分别登记在「工作流与效率增强」「信息管理与生活效率」分区。

| 功能 | 状态 | 已具备 / 缺口摘要 |
|---|---|---|
| 任务管理与提醒闭环 `core.tasks` | implemented | 任务 CRUD（三态可空字段避免编辑误清提醒/截止）、中文自然语言录入、优先级/分类/标签、全部/今天/明天/本周/逾期视图、完成/删除/页内编辑、重复任务与完成推进、稍后提醒与撤销、任务关联 Agent/现场/剪贴板/专注/笔记/场景。提醒、统计、生活例行的专项缺口见各自条目。入口：导航「任务」（Ctrl+1）、快速录入（Ctrl+K）、胶囊任务面板、收集箱转任务 |
| 全局快速捕获 `core.quick-capture` | implemented | 独立捕获窗（Ctrl+Shift+Space / 托盘右键），五类型分别进任务或收集箱；草稿防抖保存与唤起恢复；client_id 单事务幂等；唤起前焦点尽力恢复。真机热键/焦点/DPI 未验证 |
| 场景工作区 `core.scenario-workspace` | partial | 独立场景实体（v38）、创建/编辑/删除/复制、应用+网址+目录+现场+工作流+暂存软关联、一键进入与逐项回执；进入取消/整体超时/后端互斥/删除守卫已交付（2026-11-08）。缺口：「退出场景」动作、场景专属设置与任务关联、多显示器/DPI/前台争用真机验收 |
| Agent 行动中心 `core.agent-action-center` | implemented ✅已验证 | 需介入/通知/历史三层分类、幂等确认、去重、全局 SQL 计数、跳转会话。入口：导航「行动」、胶囊 Agent 面板。**禁止重复开发第二套** |
| 工作现场恢复 `core.workspace-restore` | partial | 保存/恢复/取消/任务关联、逐项验证级别与失败降级；v40 窗口几何捕获与恢复（矩形/显示器/DPI、60% 可见安全网、不落 HWND/PID）。缺口：浏览器多标签恢复、恢复前预览、几何真机验收 |
| 智能日程提醒 `core.smart-reminders` | partial | 自然语言创建、重复规则引擎、提醒与场景/现场联动（用户点击才执行）、延后/补触发。缺口：法定节假日/调休（按设计不接）、真机双主题与窄窗 |
| 开发工作台 `core.dev-workbench` | partial | 当前任务锚点（显式设置键）、任务优先四区域、复用 task_context / agent_snapshot / 行动中心 / 现场恢复。缺口：项目目录、Git 与测试结果归集（P1）；帮助教程为 draft |
| 智能剪贴板 `capture.clipboard` | implemented ✅已验证 | 五类采集与哈希去重、自动分组（45s 默认/可配）、历史检索、整组复制、目标窗口逐项粘贴（失败停止）、本机 OCR、任务关联与 Agent 导入包；敏感过滤 fail-closed。五轮 GUI 联合验收 + 真机证据；边界见 `docs/clipboard/` |
| 应用启动与窗口切换 `core.app-launcher` | partial | 本机应用扫描与真实图标、网格排序、导航目标、四级导航（启动→唤醒→工作区→会话，缺接口如实降级）、批量启动。缺口：L3 未逐项核验、L4 以 Codex 为主、多窗口实例无法精确锁定、未登记应用不参与应用搜索 |

## 工作台与专业创作（9 项）

| 功能 | 状态 | 已具备 / 缺口摘要 |
|---|---|---|
| 统一大型工作台 `workbench.unified` | implemented | U0（2026-11-14）：胶囊 / 快捷工具面板 / 独立大型工作台三层职责；20 条路由；统一导航复用 navigationRegistry + navVisibility；workbench_layout 恢复路由/项目/右栏/分栏宽度；ModuleRunControl + useLifecycleStore 管理模块启停；workbenchOnly 与 workspaceProfiles 构成专业模块接入协议。20 路由验收为部分通过（Windows 原生通道未执行） |
| 窗口形态与贴边胶囊 `workbench.shell` | implemented | 极简悬浮/快捷工具面板/独立完整工作台三形态（另保留紧凑模式旧版兼容）；四边贴边吸附用 SetWindowRgn 在「轨道」与「轨道∪面板」间切换，停靠期间窗口不动；分类胶囊轨道承载任务/收集箱/剪贴板/应用/规划中心，Agent 由顶部状态球直达；几何记忆与重启恢复、多显示器收敛、失败回滚与有界重试。真实吸附手感与多显示器/混合 DPI 桌面合成待原生真机验收 |
| 规划中心（我的项目 + 内置路线图）`workbench.planning-center` | implemented | 双数据源严格隔离：内置目录只读 + 用户项目（planning_*）可编辑；用户项目 CRUD/归档/删除、总览/功能列表/看板/里程碑、状态/优先级/目标日期/进度；内置目录七分区筛选、搜索与详情；MCP 仅可写用户项目。用户项目暂无跨设备同步与导入导出 |
| 知识与 AI 能力中心 `capability.center` | implemented | 五个子页：知识库（引用/导入、索引、搜索、关联）、Skill（扫描/导入/风险标注、只读不执行）、外部 MCP（stdio、工具清单、高风险确认、调用日志）、上下文装配、能力配方；默认关闭或只读。PDF/DOCX 解析、向量嵌入、HTTP MCP、移动端编辑与云同步未实现（P2） |
| 专业项目工作空间 `workbench.projects` | partial | 五种项目类型、项目 CRUD/归档、事项与阶段树、任务与暂存关联、开发型 Git/Agent 快照、独立窗口状态、三层入口；2026-11-17 新增 v69 项目级笔记/Agent 会话/产物关联后端与只读进度接口，同日接入布局编辑、进度卡与资源关联卡。缺口：跨设备项目同步、真实 Tauri 窗口下的布局/资源端到端验收、多显示器/DPI 真机走查 |
| 多目录文件工作区 `workbench.files` | implemented | 递归分割树（12 窗格/深度 6/每窗格 12 标签）、自由打开目录与四方向分栏、布局持久化、标签管理、复制/移动/重命名/新建/删除（回收站与永久删除独立确认）、跨窗格拖拽、外部 OS 拖入复制语义、冲突整批一次决策、类型图标与缩略图、搜索排序；已接入多目录联合搜索、批量重命名、目录对比、快速预览与重复文件查找（大小预筛 + 显式哈希），复制/移动/批量重命名已转统一文件任务服务（逐条报告、条目间取消）。真实拖拽/回收站/缩略图与 4 万/10 万条压测待原生真机验收 |
| 小说创作工作台 `create.novel` | partial | v58 卷→章树、纯文本正文、自动保存、字数统计、8 MiB 单章上限、备份；项目概览/写作事项/任务关联。缺口：人物、世界观、大纲、版本记录、Markdown/导入导出/全文搜索、AI 辅助（均为 planned，无假入口）；长篇原生走查未执行 |
| 游戏开发工作台 `create.game` | partial | 游戏项目类型、概览/制作事项/任务关联/设置、以事项阶段承载关卡/系统/美术阶段。缺口：GDD、角色/场景/资源库、构建与测试流水线、产物登记、引擎跳转、测试与缺陷跟踪；构建/资源能力为 planned |
| AI 漫剧工作台 `create.ai-comic` | partial | 漫剧项目类型、剧集与镜头导航、以事项阶段承载 episode/shot（limited）、任务关联。缺口：剧本、分镜元数据与镜头-场景关联、角色与素材库、生成管线、版本比较与采用、制作看板与 Agent 协作；生成能力为 unavailable |

## 工作流与效率增强（16 项，P1 为主，含 5 项 P2）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 主题与外观 `ux.theme-system` | implemented | 视觉预设 / 明暗 / 材质三个正交维度；语义 Token 与 html[data-preset|data-theme|data-material]；原生 Mica/Acrylic 不可用或高对比度/减少透明时回退 solid 并标注 data-native-glass；设置/标题栏/托盘同一 store。原生圆角与材质像素验收仍 UNVERIFIED |
| 导航自定义 `ux.navigation-customization` | implemented | navVisibility 版本化配置按稳定 ID 显示/隐藏与排序；锁定入口不可隐藏；新增入口自动合并；主窗与统一工作台共用；恢复默认与实时预览；非法配置回退默认。仅控制可见性，不做权限控制 |
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
| 事件历史与通知中心 `ux.history-center` | implemented | 通知 + Agent 事件统一时间轴、按日分组、重复聚合、来源/类型/时间筛选、keyset 分页与同口径 has_more/filtered_total、全库未读统计、标已读/清空二次确认、实时订阅与缺口提示。按 run 可视化仍属 agent.execution-timeline 缺口 |

## 信息管理与生活效率（3 项，P1–P2）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 快速笔记 `core.quick-notes` | implemented ✅已验证 | notes 表 + 11 个命令、自动保存、收藏置顶、搜索、模板、任务/现场关联、捕获转笔记、全局搜索。真机 2026-11-04 走查与备份恢复 |
| 生活例行事项 `core.life-routines` | partial | 复用周期任务引擎（每日/每周多日/每月+间隔）、到期提醒与自动推进。缺口：今日待办视图、打卡与连续记录、历史与延后、自定义分类。**不建第二套任务系统** |
| 生活购买记录与票据 `life.purchases` | partial | 物品目录、购买记录/历史、生活事件、票据图片/PDF、生活待办复用任务、life 检索分类、桌面与手机同步。缺口：真实双设备同步、票据上传链路、桌面/移动真机走查、正式集成包验收；购物清单/OCR/保修/AI 比价不在 v1 |

## Agent 扩展（11 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| Agent 监控与接入中心 `agent.monitoring` | implemented | 本机 Agent 发现、状态树 Agent→实例→会话→运行、实时快照 + keyset 历史、接入向导（Hooks/插件/HTTP Bridge/文件投递）与备份回滚、自定义来源、模拟/真实隔离、行动中心与任务/规划关联。各适配器真实会话覆盖不同，系统级托盘/通知/任务组合未整体真机走查 |
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

## 设备、系统与数据（9 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 移动端伴随应用 `mobile.companion` | partial | Android 端本地 SQLite；扫码/深链配对（TLS-only + SPKI 固定）、任务/收集箱/笔记双向增量同步（rev/outbox/冲突页/墓碑）、文件互传 v1、统一采集中心、分享接收、小组件与入口自定义。物理机证据 2026-11-09/13/14。缺口：后台自动同步仅设计、无 workspace_projects 同步与跨设备接续、无 iOS、墓碑日志保留期清理 |
| Android 屏幕镜像与独立虚拟屏 `mobile.virtual-display` | implemented | ADB/scrcpy 会话管理：mirror / virtual 两种模式、状态机与阶段、25s 超时回收、WM_CLOSE→强杀→Job Object、应用选择、窗口定位/截图/诊断、多屏实验默认关闭（最多 2 会话）。2026-11-18 新增每 Session 独立投屏控制栏（普通窗口外置、最大化/全屏内置、全屏底部触发、不抢焦点）与 scrcpy 品牌化；控制栏原生窗口/多显示器/DPI 完整链路 ENVIRONMENT BLOCKED |
| 设置中心 `system.settings` | implemented | 六个一级分类、17 个稳定分组；设置页内搜索与分类跳转；模块启停、应用/剪贴板/通知/语音/备份/资源/诊断/Agent/MCP/开发者/帮助入口；ALLOWED_KEYS 白名单与版本化迁移，非法值拒绝。开发者分组面向排障 |
| 提示音、语音播报与语音包 `system.audio` | implemented | 事件驱动唯一音频服务：eventId 去重、完成 600ms 合并、优先级、24 条有界队列、串行播放；Web Audio 合成提示音；WinRT 本地 TTS 常驻线程；白名单短语持久缓存；自定义 MP3/WAV 语音包；设置页试听同通道。仅 Windows WinRT，云端 TTS 不做 |
| 托盘、开机自启与单实例 `system.tray-autostart` | implemented | 托盘图标随 Agent 状态切换与未处理摘要 tooltip；托盘菜单与主窗同源；开机自启注册表与 --autostart 静默启动；单实例 argv 转交、SendTo 优先；退出确认与挂起写库保护。真实托盘点击/通知/多实例转交需原生真机验收 |
| 资源管理与智能清理 `system.resources` | implemented | 应用缓存（TTS/暂存架残留/无引用缩略图）与用户级垃圾（回收站/临时/崩溃转储）两套独立能力；预览只读 + previewId 一次性消费 + 归属/身份/年龄复核 + 作业闸 + 暂存架互斥；资源占用与只读进程诊断。真机 Tauri 窗口高 DPI 走查未执行 |
| 诊断中心 `system.diagnostics` | implemented | 脱敏 DiagnosticEvent、有界队列 + 单写线程 + JSONL 轮转/聚合；异常列表与 operationId 操作链、摘要/导出/清理；页面可见才查询，不做后台轮询。预览夹具缺 IPC handler，真实数据链未验收 |
| 备份与恢复 `system.backup` | implemented ✅已验证 | 完整/快速备份、流式 JSONL bundle + 完整性校验、恢复状态机可续跑/回滚、preferences.json、BACKUP_TABLES；P1-04 PASS（100k 夹具 61.9MB 往返、真机 78.44MB 恢复 14.28s、25 表一致、21 个故障测试）。多 GB 包未测 |
| 安全保险箱 `security.secure-vault` | partial | 独立 `secure-vault.db`（不进 BACKUP_TABLES）、AES-256-GCM + 每载荷 HKDF 子密钥、Argon2id 主密码 + 20B 恢复密钥双信封、`vault_*` 命令在 MCP/CLI/REST/全局搜索结构性不可达、`.tdvault` 独立加密备份。P1 代码完成（2026-11-18：cargo check 0、23 项单测、typecheck 0）；P1 Gate 未过（真机验收未执行）。移动端/同步/TOTP/自动填充等不在 P1。设计见 docs/features/secure-vault/ |

---

## 变更记录（2026-11-16 数据治理）

- **审计范围**：`featureCatalog.ts` 原 34 项逐字段核对 + 仓库全局扫描未登记模块 + 导航入口映射。
- **补登 15 项**：统一工作台、专业项目工作空间、多目录文件工作区、小说/游戏/AI 漫剧工作台、
  智能剪贴板、应用启动与窗口切换、内置 Agent、Relay、移动端伴随应用、Android 虚拟屏、
  资源管理、诊断中心、备份与恢复。
- **新增 2 个展示分区**：「工作台与专业创作」「设备、系统与数据」；分区类型、顺序、元数据、测试同步。
- **修正既有条目**：帮助教程计数 25 → 28（初审实测 27，补「能力导览」后 24/1/3）；为文件暂存架、全局搜索、生活例行事项、
  Codex App Server 补 `entryPoints`；补登 `capture.clipboard` 与两个查看器的父子关系说明。
- **未合并的方向（2026-11-18 更正，见下节）**：任务 CRUD 本体、产品规划中心（我的项目）、胶囊/窗口外壳、构建调度器属于
  产品底座或开发基础设施，不单独立项；移动端专属能力归属 `mobile.companion`，不拆分。
- **未改**：12 个核心 ID、用户项目数据结构、规划中心 UI、任何业务功能实现。

## 变更记录（2026-11-18 全量补登）

- **触发**：用户明确要求「将现在所有功能都整理一份到内置路线图中」，推翻 2026-11-06 / 2026-11-16
  「产品底座不单独立项」的范围判定。
- **补登 12 项**：任务管理与提醒闭环 `core.tasks`、窗口形态与贴边胶囊 `workbench.shell`、
  规划中心 `workbench.planning-center`、知识与 AI 能力中心 `capability.center`、
  生活购买记录与票据 `life.purchases`、Agent 监控与接入中心 `agent.monitoring`、
  主题与外观 `ux.theme-system`、导航自定义 `ux.navigation-customization`、
  事件历史与通知中心 `ux.history-center`、提示音/语音播报/语音包 `system.audio`、
  托盘/开机自启/单实例 `system.tray-autostart`、设置中心 `system.settings`。
- **计数**：49 → 61；implemented 22 → 33、partial 22 → 23、planned 5、blocked 0；
  verified 10 不变，unverified 39 → 51（新增条目未做新的真机走查，不虚报已验证）。
- **同步修正既有条目**：全局搜索由 8 类扩为 11 类（补 life / knowledge）；通知聚合补登
  独立通知窗口/原生通知双通道与通知操作；Android 虚拟屏补登 2026-11-18 投屏控制栏与品牌化边界。
- **未改**：12 个核心 ID、用户项目数据结构、规划中心 UI、任何业务功能实现；构建调度器仍为
  开发基础设施，不登记为用户功能；移动端专属小工具仍归属 `mobile.companion`。

> 历史过程（保留）：2026-11-05 Claude/Cursor/Gemini 适配器 planned→implemented；2026-11-06 规划纠偏
> 修正场景/工作流/MCP/帮助四项描述；2026-11-08 新增全局命令面板、场景取消/互斥、v40 窗口几何；
> 2026-11-11 新增句式命令；2026-11-12 新增开发工作台 P0；2026-11-15 工作台 20 路由与项目工作空间验收；
> 2026-11-16 数据治理补登 15 项。这些记录只说明演变，当前计数一律以上方 2026-11-18 统计为准。

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

## 2026-11-17 收敛进展

- 已完成：回收站批量恢复/永久删除结果与输入同序等长（P0）；任务注册表不再淘汰运行中任务（P0）；
  统一文件操作任务模型与固定 worker 池；删除改走任务服务；回收站节流/缓存/分页统计修正；
  资源管理回收站发现去重；磁盘分析会话缓存。
- 待下一轮：复制/移动前端仍走阻塞 IPC（后端 `fs_copy_job_start` / `fs_move_job_start` 已就绪，
  切换需保留逐条 `FsOpReport` 语义）；批量重命名纳入任务模型；4 万 / 10 万条真机压测。

同日后端补充：增加 `fs_job_report` 供复制/移动按需读取完整逐项报告，前端转任务服务时
不再需要从失败展示名反推源路径；修复排队取消竞态、同步重复准入、空卷选择扩大清空范围、
项目布局省略丢失/删除非原子及剪贴板工作现场引用清理。前端接线、原生回收站/拖放与大数据
压测仍待完成；不据此提升模块的正式验收状态。

同日第二轮后端功能补齐：批量重命名已进入任务模型；复制/移动/重命名提供条目进度及顶层
条目间取消；回收站枚举可取消、失败保留旧索引；多选粘贴保留失效项并返回 skipped；
项目资源关联 v69 与进度读模型已提供 IPC。复制/移动/重命名的前端入口仍待统一接线，
单个大文件/目录内部即时取消、跨重启文件作业恢复和跨设备项目同步仍未实现。

同日第三轮前端接线（2026-11-17）：

- 文件工作区复制/移动/批量重命名已改走 `fs*JobStart` + 统一任务事件/状态轮询；复制/移动按
  `FsOpReport` 逐条确认成功，只移除 `ok` 项，取消/部分完成/报告缺失均保留未处理项。粘贴只由
  面板执行一次，FilePane 不再保留第二套 IPC 流；批量重命名新增任务取消与逐条结果展示。
- 回收站视图补齐任务引用、pending/running/cancelling 轮询、防重复取消、终态文案与失联提示；
  清空范围与磁盘勾选一致，partial/offline 索引明确提示。修复 `.rc-view` 在 `.fw-workarea`
  中宽度为 0 的真实布局缺陷（此前统计/工具栏/列表被压成竖排）。
- 项目空间补齐布局串行保存与编辑器、事项/关联任务双进度卡、项目资源关联卡（含 `targetExists`
  标注和解除不删目标）；修复 `saveLayout` 与 `saveModule` 并发时 `hiddenModules` 丢失的竞态。
- 剪贴板组删除反馈改用后端真实 `deleted / retained_shared`，不再写死 0。
- 定向 Vitest 10 文件 138 条通过；`npm run build:raw`（含 `tsc --noEmit`）经调度器两次
  succeeded。仍未验证：原生拖放/回收站/剪贴板真实操作、真实 Tauri 窗口下的布局与资源
  CRUD、回收站任务事件的真实后端端到端、4 万/10 万条压测；预览走查数据为 CDP 临时夹具。
  因此文件工作区与项目空间仍保持 `implemented` / `partial`，不据此提升为正式验收通过。

## 2026-11-18 安全保险箱（Secure Vault）P1 本地 MVP 实现

**状态：P1 代码完成，P1 Gate 未通过（待真机验收）**。已登记 `featureCatalog.ts` 第 62 项
（`security.secure-vault`，`partial` / `unverified`），更新 `featureCatalog.test.ts` 与
`featureRegistry` 的 `page:vault` 路由；`cargo check` exit 0、23 项 Rust 单测通过、
`npm run typecheck` exit 0、前端目标测试通过。未提交 Git、未登记集成台账、未出正式构建包。

- 定位：保存不常用但不能忘的敏感凭据（账号密码、API Key、软件许可证、恢复码、设备凭据、
  私密备忘），**独立库、独立密钥、独立安全边界**，不属于笔记/任务/生活记录的任何一类。
- 已定架构：独立 `secure-vault.db`（不进 `BACKUP_TABLES`）；AES-256-GCM + 每载荷独立 HKDF
  子密钥；Argon2id 主密码派生 + 20B 恢复密钥双信封；`meta_blob` / `secret_blob` 两级载荷；
  后端 ticker 锁定；`vault_*` 命令在 MCP/CLI/REST/全局搜索中结构性不可达；`.tdvault` 独立
  加密备份；多设备（P2）P-256 ECDH 设备信封。
- 明确不在 P1：移动端、同步、TOTP、自动填充、浏览器扩展、Agent 凭据租约、明文导出。
- 文档入口：[docs/features/secure-vault/](features/secure-vault/README.md)（13 篇，含
  25 项功能矩阵、F-01..F-08 现状结论、T-01..T-15 威胁、D-01..D-13 决策、P-01..P-08 待决）。
- 依赖前置：新增 `argon2` / `aes-gcm` / `hkdf` / `hmac` / `base32` / `unicode-normalization`
  六个 crate 与 `windows-sys` 的 `Win32_System_RemoteDesktop` feature，**P-01 已批准并接入**。

### 2026-11-19 构建基础设施简化

- 已按用户要求移除构建调度器，开发、测试与构建命令直接执行；保留集成快照与磁盘保护。
- 本文此前提及构建调度器的记录为移除前历史，不代表当前仍存在。决策见 [ADR-0007](adr/0007-remove-build-scheduler.md)。
