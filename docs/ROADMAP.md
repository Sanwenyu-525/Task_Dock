# 功能规划目录（v0.7 起统一维护）

> **唯一事实源**：[src/lib/featureCatalog.ts](../src/lib/featureCatalog.ts)。
> 本文档与其同源；应用内入口为完整模式左侧导航「**规划中心**」（Ctrl+7，Tab 身份仍为 `roadmap`）。
> v0.7 起「规划中心」为双数据源：本目录（Task Dock 自身规划，只读）+ 用户自建项目
> （SQLite `planning_*` 表，可创建/编辑/归档/删除，见 docs/ARCHITECTURE.md 数据模型）。
> **用户项目不写回本目录与 featureCatalog.ts；两者互不影响。**
> 12 项核心功能使用固定 ID 并由自动化测试锁定数量（`featureCatalog.test.ts`），防止遗漏。

**状态口径**（实现状态 ≠ 验收状态）：

- implemented 已实现 —— 用户当前可用，卡片/表格给出现有入口
- partial 部分实现 —— 已具备能力与剩余缺口分别登记
- planned 待开发 —— 仅登记规划，**不代表功能可用**
- blocked 受阻 —— 等待外部接口或平台条件，注明原因

**验证口径**：verified = 该功能当前范围内有自动化测试或历史真机验收证据；unverified = 未充分验证。**「已实现」不等于「已通过验收」**。

当前计数：共 32 项（核心 12 项）——已实现 14 · 部分实现 15 · 待开发 3 · 受阻 0；已验证 8，未验证 24。
（2026-11-08 v0.11 第三轮按 `featureCatalog.ts` 同步：新增全局命令面板（implemented·unverified），
场景工作区 / 工作现场恢复补记 v40 窗口几何捕获与恢复；2026-11-06 v0.11 第一轮新增 Agent MCP Server（partial）、
帮助与教程中心（partial）、首次使用引导（implemented·unverified）；此前 2026-11-05 的"28 项 = 12 + 13 + 3 + 0 / 已验证 8"为上一轮统计。）

---

## 核心效率功能（P0，5 项）

| 功能 | 状态 | 已具备 / 缺口摘要 |
|---|---|---|
| 全局快速捕获 `core.quick-capture` | implemented | v0.7 独立常驻捕获窗（Ctrl+Shift+Space / 托盘右键「快速捕获」，640×360、不展开主窗）；五类型（任务/想法/文字/待办/链接）分别进任务或收集箱；完整模式「收集箱」tab（Ctrl+5）；草稿防抖保存与唤起恢复；client_id 单事务幂等；唤起前窗口焦点尽力恢复。入口：全局热键、托盘/右键「快速捕获」、导航「收集箱」、任务页快速录入框（原有子集）。**真机热键/焦点/DPI 未验证** |
| 场景工作区 `core.scenario-workspace` | partial | v0.11 已交付场景实体（SQLite v38 `scenarios`）：工作流页「场景工作区」子视图、创建/编辑/删除/复制、应用+网址+目录+关联现场+关联工作流+暂存架文件软关联（`shelf_items.scene_id`）、一键进入（现场→应用→网址→目录→工作流，逐项 ok/skipped/failed 回执与进度事件）。窗口几何经关联现场恢复（2026-11-08 v40：快照条目保存矩形/显示器/DPI，恢复时映射或收敛，逐项 applied/converged/skipped/failed；确定性换算单测已覆盖、真机跨显示器落地未验证）。**进入取消/超时/互斥（2026-11-08 第二批）**：后端 `ScenarioEnterGate` 唯一操作槽（直接进入与工作流步骤共用，并发进入返回可重试 `Conflict`）；`scenario_enter_cancel` 幂等取消，整体预算 120s；取消/超时只在项间生效，已启动项不回滚，回执新增 `cancelled`/`timedOut`/`total`（items 只含已处理项）；取消按 operation_id 定向转发给本场景启动的现场恢复；删除在途场景先请求取消、最多等 2s、未退出返回冲突不删除；进入期间全卡片编辑/复制/删除禁用。gate/停止策略/删除守卫单测锁定；真机通道 C 已过（2026-11-08，隔离实例 + CDP：取消摘要「已处理 1/3 项」、在途全卡片禁用、取消后删除成功）。入口：完整模式导航「工作流」→「场景工作区」。缺口：「退出场景」动作、场景专属设置与任务关联、多显示器/DPI/前台争用真机未验收。**与「工作现场恢复」是两个功能，不互相替代** |
| Agent 行动中心 `core.agent-action-center` | implemented ✅已验证 | 需介入/通知/历史三层分类、幂等确认、去重、全局 SQL 计数、跳转会话。入口：导航「行动」、胶囊 Agent 面板。**已实现，禁止重复开发第二套** |
| 工作现场恢复 `core.workspace-restore` | partial | 已有：保存/恢复/取消/任务关联、逐项验证级别与失败降级；窗口几何捕获与恢复（2026-11-08 v40：保存矩形/显示器/DPI，恢复按显示器映射或收敛到工作区，60% 可见安全网，不落 HWND/PID；真机跨显示器落地未验证）。缺口：浏览器多标签恢复、恢复前预览、几何真机验收 |
| 智能日程提醒 `core.smart-reminders` | partial | 已有：自然语言创建（含「N 分钟后」相对时间、工作日与每月高级规则）、重复规则引擎（含每 N 月/每月第 N 个星期X/每月最后一个工作日，修复每两个月退化为每月）、任务页快捷提醒与页面级共享时钟倒计时、任务详情/任务卡/任务通知三处延后入口（可撤销、版本约束）、通知操作（查看/稍后/完成）、补触发。**提醒与场景/现场联动（2026-11-08 v41）**：`task_reminder_links` 一任务一关联（场景或工作现场，任务上下文抽屉设置/清除）；提醒触发时通知卡按联动提供「进入场景 / 恢复现场」动作，**只在用户点击时执行，绝不自动启动**；调度器每 tick 一次批量解析（目标已删除则不附加动作），场景/现场删除同事务清理联动、删任务外键级联；新表登记备份（完整/快速均含，恢复逐行还原）。缺口：法定节假日/调休跳过（按设计不接节假日 API）、真机双主题与窄窗走查 |

## 工作流与效率增强（12 项，P1 为主，含 3 项 P2）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 文件暂存架 `core.file-shelf` | partial | v0.8 已交付基础暂存架：独立界面、四种添加方式、引用/托管双存储、搜索筛选、批量操作、过期清理、任务关联与备份；支持与场景的软关联（`shelf_items.scene_id`，删除场景只解绑）。过期清理已保护收藏/置顶/场景引用条目，删除事务内复核（扫描后被关联的条目不会误删）；手动「立即清理过期」先 dry-run 预览并二次确认，确认后才删除，结果按报告区分保留项、文件残留与同步失败并提供重试同步（2026-11-06）。缺口：系统级拖出到资源管理器（OLE 通道未实现）、真机拖入验收、暂存架侧场景归属展示 |
| 一键工作流 `core.one-click-workflow` | partial | v0.9 已交付：白名单动作编排（打开应用/网页/文件目录、创建任务、恢复工作现场、进入场景）、顺序执行引擎（暂停/继续/取消、逐步骤反馈、失败策略）、幂等（单运行槽 + 操作 ID 回执 + 异常退出标 interrupted 不重放）、开发/办公模板、运行历史分页；SQLite v23 + 备份登记。「进入场景」已接入类型/编辑器/保存校验/执行调用/循环检测。嵌套层数口径：一层 = 「场景 → 场景关联工作流」边，工作流进入场景不计层；三层允许、第四层拒绝，保存与运行前共用同一校验，由 5 个回归用例锁定（2026-11-06）。入口：导航「工作流」（Ctrl+7）。场景步骤逐项回执已交付（2026-11-08：成功/部分失败/取消均保留 items 明细与原因，取消注明剩余未执行数，运行详情逐项展示）。缺口：LiveExecutor 无自动化测试、真机窗口跳转未验证 |
| 智能通知聚合 `core.notification-aggregation` | partial | 已有：双额度限流、完成合并摘要、静音、历史持久化。缺口：跨来源聚合视图、逐条优先级、通知摘要视图 |
| 专注与休息 `core.focus-timer` | implemented ✅已验证 | v0.10 已交付：focus_* 12 个命令、番茄钟/正计时开始暂停继续完成取消、休息与久坐提醒（可关/可延后）、每日专注记录与历史（v27 focus_sessions/focus_daily_stats，纳入备份）、任务关联专注、胶囊徽标同步。入口：任务页右上「专注与休息」、完整模式胶囊徽标。真机 2026-11-04 走查开始→暂停→继续→取消，以及杀掉进程重启后「已暂停（app_restart）」恢复 |
| 全局搜索 `core.global-search` | partial | v0.9 统一检索层与八类跳转：一次只读查询覆盖任务、剪贴板、收集箱、暂存架、应用（已保存导航目标）、Agent、工作现场、规划中心。缺口：已发现但未登记应用的搜索、FTS5 索引（万级数据实测达标前不引入） |
| 任务统计与效率分析 `tasks.stats-trends` | implemented ✅已验证 | v0.10 已交付：task_analytics（日/周/月）、完成率/逾期率/趋势/分类效率、v24 task_completion_events（纳入备份）、任务页「任务统计」子视图与空态。2026-11-04 起返回 `history_complete`：自动推进/补偿跳期/改期导致无法还原的重复期次会明确标注「不完整统计」，不伪造分母；提前完成未来期次不会误报。真机 2026-11-04 走查日→周→月、重复任务推进与提前完成边界 |
| 自定义全局快捷键 `ux.custom-hotkeys` | implemented ✅已验证 | v0.10 已交付：hotkeys_snapshot/change/reset、录制控件（应用内/全局分组）、冲突与系统占用提示、无修饰键拒绝、hotkeys.json 即时生效并重启保持。入口：设置 → 窗口与快捷键。配置随完整/快速备份迁移（bundle header 可选 config），恢复时逐项重新注册校验；冲突/占用会降级或禁用并保留原配置，不伪装恢复成功。真机 2026-11-04 走查录制、无修饰键拒绝、系统级改键 Ctrl+Alt+F12、组合冲突提示与重置 |
| 图片放大及全屏预览 `ux.image-fullscreen` | implemented ✅已验证 | 图片灯箱：缩放/平移/双击/另存为，弹层栈隔离。入口：剪贴板图片详情 |
| 剪贴板多类型专用查看器 `ux.clipboard-viewers` | implemented ✅已验证 | HTML 白名单只读阅读器、图片灯箱、文件预览、URL 详情。入口：剪贴板条目详情 |
| 全局命令面板 `ux.command-palette` | implemented | v0.11 第三轮已交付（2026-11-08）：全局搜索弹窗（Ctrl+Shift+F）内建命令能力层——打开页面/新建任务/创建提醒（草稿类导航）/打开设置分组/进入场景/运行工作流（直接执行+单槽反馈）；静态命令派生自 NAV_ENTRIES 与设置分组元数据，动态场景/工作流打开时水合；动作白名单拦截危险操作（契约测试双重锁定）；命令与数据结果分组区分、键盘优先、i18n 双语、59 用例。不建第二弹窗/第二索引。缺口：独立快捷键、跳转子页高亮、真机双主题/窄窗走查。入口：全局搜索弹窗 → 命令组 |
| 帮助与教程中心 `ux.help-center` | partial | v0.11 已交付并两轮收口：src/help 注册中心（结构化 TS 正文，零新依赖）+ 8 分类 **25 篇**教程（24 verified / 1 needs_review / 0 draft，2026-11-08 复核 7 篇并按代码更正过时表述、en-US 全覆盖）、第 13 个 rail 入口（不占 Ctrl+数字）；搜索/分类/最近浏览/状态徽标（未实现/受阻/隐藏/停用分别如实提示）/功能跳转/返回来源页/复制步骤；`npm run help:check` 契约校验（19 用例）0 blocker，剩余 warning 仅在途源文件变化触发的人工复核提示（几何合入后消解）；ContextHelpButton 已接入 8 个页面共 9 处。缺口：正文语义漂移无自动检测（契约只校验引用/版本）、mcp-authorization 待在途改动合入后转 verified、真机双主题与窄窗走查 |
| 首次使用引导 `ux.onboarding` | implemented（待真机验证） | v0.11 已交付：三步引导（认识 task_dock → 完成第一个任务 → 按需启用功能），页内卡片形态（非全屏 Modal）、可跳过/返回、Escape 经 overlayStack、键盘可操作、不创建业务数据；localStorage 持久化，升级不自动重播（「有新内容」由帮助中心呈现）；可从**帮助中心与设置页「重新打开引导」**两处重开。缺口：真机双主题/窄窗/DPI 走查 |

## 信息管理与生活效率（P2，2 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 快速笔记 `core.quick-notes` | implemented ✅已验证 | v0.10 已交付：notes 表（v25，纳入备份）+ 11 个 notes_* 命令、自动保存、收藏置顶、搜索、内置模板、关联任务/工作现场、捕获转笔记、全局搜索笔记分类。入口：收集与暂存 → 笔记；收集箱「转为笔记」。真机 2026-11-04 走查新建→保存→搜索与空态，并验证完整备份→删除→恢复后笔记正文与标题回来、重启仍在 |
| 生活例行事项 `core.life-routines` | partial | 已有：周期任务引擎可覆盖。缺口：今日待办视图、打卡与连续记录、延后处理、自定义分类。**复用任务与重复规则，不建第二套任务系统** |

## Agent 扩展（P1，8 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| Agent MCP Server `agent.mcp-server` | partial | v0.11 已交付后端最小安全闭环 + 设置页管理界面：`taskdock.exe --mcp-server` stdio 子命令（手写 JSON-RPC 2.0 + MCP 最小子集，不引入 SDK）→ 127.0.0.1 loopback bridge（独立端口/token、256KB 上限、20s 超时、并发上限）→ 规划服务层 → SQLite；agent 身份 SHA-256、scope=disabled/readonly/project_rw + 逐项目授权、撤销即时生效；mcp_audit_log 审计 + requestId 幂等；18 个规划读写工具复用 planning 服务层，强制 expected_revision 乐观并发，Agent 不可置 completed、submit_for_review 只置 review；planning-changed 事件前端局部刷新；mcp_server_enabled 默认关闭；v37 迁移 + 备份登记；设置 → Agent 接入 → MCP 提供开关/身份/轮换/撤销/授权/配置片段/分页审计。缺口：**设置页连接测试、真实 MCP 客户端联调、审计保留期、任务/笔记/工作流扩展工具**；单测 `feature_completed_is_user_only_and_submit_for_review_flow` 已于 2026-11-06 拆为 A–F 并通过（生产代码未改，2000 上限与 completed 权限边界不变）。内置路线图与用户项目仍严格隔离 |
| Codex App Server 深度接入 `agent.codex-app-server` | partial | 已有：hooks 接入（7 事件、真实联调）+ codex resume。缺口：app-server stdio JSON-RPC 通道（线程恢复、中断回合、完整对话事件） |
| Claude Code 专用适配器 `agent.claude-code-adapter` | implemented（待本轮真实验证） | 已实现：~/.claude/settings.json 官方 Hooks 安装/卸载、多文件事务、二进制能力线索检查。缺口：本轮未在真实 Claude 会话触发事件，真实验证标 UNVERIFIED |
| Cursor 专用适配器 `agent.cursor-adapter` | implemented（待本轮真实验证） | 已实现：用户级 ~/.cursor/hooks.json（保留 version 等字段）、camelCase 事件映射。缺口：本轮未在真实 Cursor 会话触发事件 |
| Gemini CLI 接入 `agent.gemini-cli` | implemented（待本轮真实验证） | 已实现：~/.gemini/settings.json、11 个生命周期事件基线、AfterAgent/SessionEnd 映射完成态。缺口：本轮未在真实 Gemini CLI 会话触发事件；SessionEnd 为 best-effort，结束/失败仍以事件为准 |
| ZCode 官方 Hooks 接入 `agent.zcode-integration` | partial | 已有：配置根/可执行文件/进程发现；用户级 `~/.zcode/cli/config.json` 的 `hooks.events` 自动安装 7 个事件（SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop）与一键卸载，安装时自动启用 `hooks.enabled`，保留 mcp/plugins/第三方条目，写入前备份、失败回滚。缺口：真实 ZCode 会话事件端到端验证（需安装后新开会话）；无事件时如实显示「未知」 |
| Agent 工作时间统计 `agent.work-time-stats` | implemented ✅已验证 | v0.10 已交付：agent_work_time_stats 聚合（执行/等待时长、失败率、按来源与会话）、Agent 面板「统计」tab（近 7/30 天、真实/模拟来源隔离）、空态与口径说明；集成测试 23 用例。真机 2026-11-04 走查范围切换与来源隔离 |
| Agent 执行时间轴 `agent.execution-timeline` | partial | 已有：历史页统一事件时间轴（按日分组、重复聚合）。缺口：按 run 可视化、时长统计 |

> 参考资料：Gemini CLI 官方 Hooks 文档 [https://geminicli.com/docs/hooks/](https://geminicli.com/docs/hooks/)（事件参考 [https://geminicli.com/docs/hooks/reference/](https://geminicli.com/docs/hooks/reference/)），2026-11-03 实际核验；与 Claude Code 的 Hooks 事件名、配置格式和退出码语义不同，不得套用。
>
> **目录已同步（2026-11-05）**：`featureCatalog.ts` 中 Claude / Cursor / Gemini 三项已由 planned 改为 implemented，与上表一致；三者 `verification` 仍为 unverified，只有真实会话事件入库后才可改为 verified。
>
> **目录已同步（2026-11-08，v0.11 第三轮）**：新增全局命令面板（implemented·unverified，59 用例）；场景工作区与工作现场恢复补记 v40 窗口几何捕获/恢复（真机跨显示器落地未验证）；MCP 真实客户端联调经官方 MCP Inspector 全链路通过（`tmp/acceptance/mcp-inspector-e2e/`）。此前 2026-11-06（规划纠偏）以代码为准修正了场景/工作流/暂存架/MCP/帮助/引导六项过期描述。当前总数统计以 `featureCatalog.ts` 为准（implemented 14 / partial 15 / planned 3 / blocked 0；已验证 8 / 未验证 24）。
>
> 已完成并从规划移除（避免失效条目）：Qoder / WorkBuddy 专用适配器（hooks 接入已实现并真实联调，见 [AGENT_COVERAGE_MATRIX.md](../AGENT_COVERAGE_MATRIX.md)）；Agent 人工介入收件箱（已落地为 Agent 行动中心 `core.agent-action-center`）。

## 长期生态（P2，5 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 多语言 i18n `eco.i18n` | partial | v0.10 已交付：语言资源层（zh-CN/en-US + MessageKey）、设置「语言」切换（简中/English/跟随系统）、localStorage 持久化与非法值回落、日期/错误码本地化；七项功能面板与胶囊/紧凑/极简/剪贴板/通知等已接入。2026-11-04 补：主导航 11 个入口（labelKey + aria/data-tip）、设置页全部分区标题/设置项/选项/确认/Toast、任务/Agent/应用/工作流/历史页面骨架已中英覆盖；切换语言即时生效且不重建根组件。语言偏好经 preferences.json 随备份迁移。缺口：Agent 接入向导、任务/工作流/规划编辑器、剪贴板详情等页面内部文案仍为中文（保持 partial，不虚报全量） |
| 桌面微件库 `eco.widgets` | partial | v0.10 已交付：主窗「微件」页 6 类（今日任务/下一条提醒/Agent 状态/快捷操作/专注倒计时/今日效率）、微件库开关与尺寸、计数与空态、只读复用选择器不新增 IPC、localStorage 持久化。2026-11-04 补：效率微件在任务数据变化时按需重查（合并 120ms、单在途、代际防旧响应），失败保留旧值并显示「可能已过期/重试」；布局经 preferences.json 随完整/快速备份迁移，恢复时过滤未知类型与重复 ID。同日第二轮：6 类微件支持独立桌面窗口（专用 `widget.html` 宿主不挂载 `App.tsx`、独立 capability、普通层级/可选置顶、关闭即销毁、拖动结束保存、归一化锚点+显示器名+逻辑尺寸随备份迁移）；看板启用与桌面显示独立。缺口：独立窗口的多显示器插拔/100–200% DPI/重启恢复/资源回收尚未真机验证；复杂磁吸与自动隐藏明确不在首版范围；注册机制未开放。真机 2026-11-04 走查（主窗内看板）停用全部→空态→重新启用，以及完成任务后效率微件数字即时更新 |
| 第三方插件系统及沙箱 `eco.plugins` | planned | Adapter/视图插件，沙箱与权限设计先行 |
| WebDAV / 文件同步 `eco.sync` | planned | 用户显式开启的自托管同步，默认永不开启；凭据不入日志 |
| macOS / Linux 适配 `eco.cross-platform` | planned | 平台抽象已预留；需补 Vibrancy/AppIndicator/剪贴板平台层 |

---

## 维护规则

1. 新增/修改功能规划：**先改 `featureCatalog.ts`，再同步本文档**；两处状态、ID、计数必须一致。
2. 12 项核心功能的固定 ID 是公开契约，测试锁定 `CORE_FEATURE_IDS` 数量为 12；不重命名、不复用。
3. 功能落地后：更新状态为 implemented 并补充 `entryPoints` 与验证证据；已验证才写 verified。
4. 失效规划及时移除并在本文件保留一句移除说明（如上节「已完成并从规划移除」）。
5. 历史版本过程记录不进本文件；验收细节见 `tmp/acceptance/<task>/report.md` 与各模块 docs/。

## 近期推荐开发顺序（2026-11-06 按代码证据重排）

1. **发布稳定性收尾（P0/P1）**：`cargo test --lib` 中 workflow 深度、MCP 提交验收、planning 来源隔离三类失败已于 2026-11-06 定位修复（前两者为测试契约错误，实现语义正确）；shelf junction 3 项的环境阻塞已解除（19:26 全量 / 19:28 定向复跑通过）；`fs_safety` 唯一红项已按「测试夹具改用独立分类目录」修复（19:45 定向 5/5），并已达成全量绿（20:11 `cargo test --lib` 1386 passed / 0 failed / 6 ignored）。不新增功能，保持全量绿。
2. **核心功能真机验收（P1）**：场景一键进入（多显示器 / DPI / 前台争用 / 进入中删除）、工作流「进入场景」真实窗口执行、MCP 真实客户端联调与设置页连接测试。验收口径见各功能 `acceptanceCriteria`。
3. **已有功能的价值缺口（P1/P2）**：~~场景进入的取消与后端互斥~~（2026-11-08 第二批已交付：取消/超时/互斥/删除守卫，见 `core.scenario-workspace`）、~~工作流回执逐项明细~~（2026-11-08 已交付：场景步骤回执 outcome/items，见 `core.one-click-workflow`）、提醒与场景/现场联动、通知跨来源聚合视图、生活例行专用视图。
4. **长期候选（不排期，先做可行性评估）**：通用多 Agent 消息中转、第三方插件沙箱、WebDAV 同步、macOS / Linux 适配。这些方向不得在缺少安全设计与验收方案时直接排期。

> 以上顺序为建议，不代表已排期；任何一项开发前以其 `acceptanceCriteria` 为验收基线。
