# 功能规划目录（v0.7 起统一维护）

> **唯一事实源**：[src/lib/featureCatalog.ts](../src/lib/featureCatalog.ts)。
> 本文档与其同源；应用内入口为完整模式左侧导航「**规划中**」（Ctrl+7）。
> 12 项核心功能使用固定 ID 并由自动化测试锁定数量（`featureCatalog.test.ts`），防止遗漏。

**状态口径**（实现状态 ≠ 验收状态）：

- implemented 已实现 —— 用户当前可用，卡片/表格给出现有入口
- partial 部分实现 —— 已具备能力与剩余缺口分别登记
- planned 待开发 —— 仅登记规划，**不代表功能可用**
- blocked 受阻 —— 等待外部接口或平台条件，注明原因

**验证口径**：verified = 该功能当前范围内有自动化测试或历史真机验收证据；unverified = 未充分验证。**「已实现」不等于「已通过验收」**。

当前计数：共 28 项（核心 12 项）——已实现 3 · 部分实现 9 · 待开发 15 · 受阻 1；已验证 3。

---

## 核心效率功能（P0，5 项）

| 功能 | 状态 | 已具备 / 缺口摘要 |
|---|---|---|
| 全局快速捕获 `core.quick-capture` | partial | 已有：Ctrl+Shift+Space 全局热键聚焦任务快速录入、中文 NLP 解析。缺口：独立轻量捕获窗（不展开主窗）、想法/链接等捕获类型、临时收集箱 |
| 场景工作区 `core.scenario-workspace` | partial | 已有：工作现场快照、批量启动器（可取消、逐项反馈）。缺口：独立于任务的场景实体、场景管理界面、一键进入场景。**与「工作现场恢复」是两个功能，不互相替代** |
| Agent 行动中心 `core.agent-action-center` | implemented ✅已验证 | 需介入/通知/历史三层分类、幂等确认、去重、全局 SQL 计数、跳转会话。入口：导航「行动」、胶囊 Agent 面板。**已实现，禁止重复开发第二套** |
| 工作现场恢复 `core.workspace-restore` | partial | 已有：保存/恢复/取消/任务关联、逐项验证级别与失败降级。缺口：窗口位置尺寸恢复、浏览器多标签恢复、恢复前预览 |
| 智能日程提醒 `core.smart-reminders` | partial | 已有：自然语言创建（含「N 分钟后」相对时间）、重复规则引擎、补触发。缺口：延后 UI 入口（snooze API 已有）、倒计时体验、更复杂周期规则 |

## 工作流与效率增强（P1，8 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 文件暂存架 `core.file-shelf` | planned | 独立临时资料收纳区，与剪贴板历史严格区分；复用 clipboard_assets 存储 |
| 一键工作流 `core.one-click-workflow` | planned | 预设动作组合编排；第一版不做任意脚本执行；执行需用户确认过的启动配置 |
| 智能通知聚合 `core.notification-aggregation` | partial | 已有：双额度限流、完成合并摘要、静音、历史持久化。缺口：跨来源聚合视图、逐条优先级、通知摘要视图 |
| 专注与休息 `core.focus-timer` | planned | 番茄钟/久坐提醒/专注记录；复用 1s 调度器，不新增高频轮询 |
| 任务统计与效率分析 `tasks.stats-trends` | planned | 已有概览卡；缺按日/周/月统计、完成率趋势、分类效率分析 |
| 自定义全局快捷键 `ux.custom-hotkeys` | planned | 当前固定热键；缺录制控件与冲突检测 |
| 图片放大及全屏预览 `ux.image-fullscreen` | implemented ✅已验证 | 图片灯箱：缩放/平移/双击/另存为，弹层栈隔离。入口：剪贴板图片详情 |
| 剪贴板多类型专用查看器 `ux.clipboard-viewers` | implemented ✅已验证 | HTML 白名单只读阅读器、图片灯箱、文件预览、URL 详情。入口：剪贴板条目详情 |

## 信息管理与生活效率（P2，3 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 全局搜索 `core.global-search` | planned | 跨模块统一搜索 + 快捷键唤起；复用各面板现有查询，不建第二套数据库 |
| 快速笔记 `core.quick-notes` | planned | 本地轻量笔记：自动保存、置顶、模板、关联任务/现场；不做知识管理系统 |
| 生活例行事项 `core.life-routines` | partial | 已有：周期任务引擎可覆盖。缺口：今日待办视图、打卡与连续记录、延后处理、自定义分类。**复用任务与重复规则，不建第二套任务系统** |

## Agent 扩展（P1，7 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| Codex App Server 深度接入 `agent.codex-app-server` | partial | 已有：hooks 接入（7 事件、真实联调）+ codex resume。缺口：app-server stdio JSON-RPC 通道（线程恢复、中断回合、完整对话事件） |
| Claude Code 专用适配器 `agent.claude-code-adapter` | planned | ~/.claude/settings.json Hooks 格式已勘明（v2.1.186），待实现与联调 |
| Cursor 专用适配器 `agent.cursor-adapter` | planned | ~/.cursor/hooks.json 格式已勘明（version:1 + camelCase），待实现与联调 |
| Gemini CLI 接入 `agent.gemini-cli` | blocked | **未见官方 hooks/事件接口**，等待可靠接口确认 |
| ZCode 自动接入完善 `agent.zcode-integration` | partial | 已有：发现 + 通用桥接（HTTP/文件）。缺口：插件自动注册验证、真实执行状态读取（当前如实显示「未知」） |
| Agent 工作时间统计 `agent.work-time-stats` | planned | 按来源/会话统计运行时长、等待时长、失败率 |
| Agent 执行时间轴 `agent.execution-timeline` | partial | 已有：历史页统一事件时间轴（按日分组、重复聚合）。缺口：按 run 可视化、时长统计 |

> 已完成并从规划移除（避免失效条目）：Qoder / WorkBuddy 专用适配器（hooks 接入已实现并真实联调，见 [AGENT_COVERAGE_MATRIX.md](../AGENT_COVERAGE_MATRIX.md)）；Agent 人工介入收件箱（已落地为 Agent 行动中心 `core.agent-action-center`）。

## 长期生态（P2，5 项）

| 功能 | 状态 | 摘要 |
|---|---|---|
| 多语言 i18n `eco.i18n` | planned | 文案抽取 + 英文支持，默认简体中文不变 |
| 桌面微件库 `eco.widgets` | planned | 迷你图表、进度环等可选微件；不增加常驻资源负担 |
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

## 近期推荐开发顺序

1. **全局快速捕获补齐**（core.quick-capture）：热键与录入链路已通，补轻量窗口与收集箱性价比最高。
2. **智能提醒收尾**（core.smart-reminders）：snooze API 已有，补 UI 入口与倒计时，工作量小。
3. **生活例行事项**（core.life-routines）：复用周期任务引擎，主要工作量在视图层。
4. **场景工作区**（core.scenario-workspace）：依赖现场快照与批量启动器（均已就绪），需先定场景数据模型。
5. **专注与休息**（core.focus-timer）：独立性强，可与 4 并行。

> 以上顺序为建议，不代表已排期；任何一项开发前以其 `acceptanceCriteria` 为验收基线。
