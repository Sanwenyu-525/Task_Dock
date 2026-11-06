//! 统一功能规划目录（v0.7）。
//!
//! 所有规划功能（含 12 项核心功能与历史规划）的唯一事实源：
//! 「规划中心」页面（components/roadmap/FeatureRoadmapPanel.tsx）与 docs/ROADMAP.md
//! 均从此处派生，避免路线图、UI、代码三处功能清单互相脱节。
//!
//! 状态口径（与验收口径严格区分）：
//! - implemented：已实现（用户当前可用的能力，附现有入口）
//! - partial：部分实现（existingFeatures = 已具备能力；missingFeatures = 剩余缺口）
//! - planned：待开发（目录登记 + 页面提示，不代表可以开发）
//! - blocked：受外部接口或平台条件限制（blockedReason 说明原因）
//! verification 字段：verified = 该功能当前范围内有自动化测试或历史真机验收证据；
//! unverified = 未充分验证。**「已实现」不等于「已通过验收」**。
//!
//! 12 项核心功能使用固定 ID（CORE_FEATURE_IDS），自动化测试锁定数量与唯一性，
//! 防止后续迭代遗漏；改动任何 id 视为公开契约破坏。

export type FeatureStatus = "implemented" | "partial" | "planned" | "blocked";
export type FeaturePriority = "P0" | "P1" | "P2";
export type FeatureVerification = "verified" | "unverified";

/** 五个展示分区：核心效率 / 工作流与效率增强 / 信息管理与生活效率 / Agent 扩展 / 长期生态 */
export type FeatureCategory = "core" | "workflow" | "info" | "agent" | "ecosystem";

export interface FeatureEntry {
  /** 稳定唯一 ID；12 项核心功能登记在 CORE_FEATURE_IDS 中受测试锁定 */
  id: string;
  category: FeatureCategory;
  title: string;
  /** 一句话说明（卡片直接展示） */
  description: string;
  /** 详细说明（展开详情展示） */
  detail: string;
  status: FeatureStatus;
  priority: FeaturePriority;
  /** 已实现 / 部分实现：当前已有能力（implemented 必填非空） */
  existingFeatures: string[];
  /** 部分实现 / 待开发：尚未完成的部分（partial 必填非空） */
  missingFeatures: string[];
  /** 依赖条件（现有模块、外部接口、前置功能） */
  dependencies: string[];
  /** 未来验收标准（开发前登记，不作为已完成依据） */
  acceptanceCriteria: string[];
  verification: FeatureVerification;
  /** implemented / partial：现有能力的使用入口 */
  entryPoints?: string[];
  /** blocked：阻塞原因 */
  blockedReason?: string;
}

export const CATEGORY_META: Record<
  FeatureCategory,
  { label: string; description: string }
> = {
  core: { label: "核心效率功能", description: "P0：日常使用的核心闭环" },
  workflow: { label: "工作流与效率增强", description: "P1：把重复操作变成一次点击" },
  info: { label: "信息管理与生活效率", description: "P2：信息收纳与生活事项" },
  agent: { label: "Agent 扩展", description: "更多 Agent 接入与执行洞察" },
  ecosystem: { label: "长期生态", description: "跨平台、插件、同步等长期方向" },
};

export const CATEGORY_ORDER: readonly FeatureCategory[] = [
  "core",
  "workflow",
  "info",
  "agent",
  "ecosystem",
] as const;

export const STATUS_META: Record<
  FeatureStatus,
  { label: string; action: string }
> = {
  implemented: { label: "已实现", action: "已实现" },
  partial: { label: "部分实现", action: "功能待完善" },
  planned: { label: "待开发", action: "功能待开发" },
  blocked: { label: "受阻", action: "等待接口或平台条件确认" },
};

/** 12 项核心功能的固定 ID（顺序即 P0 → P1 → P2 登记顺序，受测试锁定） */
export const CORE_FEATURE_IDS: readonly string[] = [
  "core.quick-capture",
  "core.scenario-workspace",
  "core.agent-action-center",
  "core.workspace-restore",
  "core.smart-reminders",
  "core.file-shelf",
  "core.one-click-workflow",
  "core.notification-aggregation",
  "core.focus-timer",
  "core.global-search",
  "core.quick-notes",
  "core.life-routines",
] as const;

/** 核心功能总数：测试锁定为 12 */
export const CORE_FEATURE_COUNT = CORE_FEATURE_IDS.length;

export const FEATURE_CATALOG: FeatureEntry[] = [
  // ─── 核心效率功能（P0）──────────────────────────────────────────────
  {
    id: "core.quick-capture",
    category: "core",
    title: "全局快速捕获",
    description: "任意界面按全局快捷键打开独立轻量捕获窗口，随手记想法、待办与链接，提交后主界面不展开。",
    detail:
      "已交付独立捕获窗口（v0.7）：Ctrl+Shift+Space 或托盘/右键菜单「快速捕获」唤起常驻隐藏的 640×360 " +
      "无边框窗口，记录唤起前前台窗口并在隐藏时尽力恢复焦点；任务/待办在提交事务内直接建任务，" +
      "想法/文字/链接进入收集箱。草稿 600ms 防抖自动保存并可跨重启恢复，提交以 client_id 单事务幂等，" +
      "重试不重复建任务。注意：现有剪贴板监听与页面导航快捷键不承担本职能；任务页快速录入框是原有子集。",
    status: "implemented",
    priority: "P0",
    existingFeatures: [
      "Ctrl+Shift+Space 打开/聚焦独立捕获窗口（已可见且聚焦时再按隐藏；不展开主窗、不改胶囊状态）",
      "托盘/右键菜单「快速捕获」第二入口；任务页顶部快速录入框保留为原有子集",
      "五种类型：快速任务（NLP 解析时间/重复/提前提醒）、简单待办、想法、文字片段、临时链接",
      "临时收集箱：完整模式共 8 个导航 tab，新增「收集箱」（Ctrl+5），默认只看未处理，可复制、转任务、标记已处理、删除，徽标显示未处理数",
      "草稿 600ms 防抖自动保存、重启/再次唤起恢复、提交成功在事务内清除",
      "提交幂等：client_id 唯一索引 + 单事务，重试/重复提交不重复建任务",
      "唤起定位（前台窗口显示器 → 光标显示器 → 主显示器 work_area 居中）与隐藏时尽力恢复原前台窗口",
    ],
    missingFeatures: [],
    dependencies: [
      "Tauri 静态窗口 capture 与多页构建入口（capture.html）",
      "SQLite v17：quick_capture_items / quick_capture_draft（已登记 BACKUP_TABLES）",
      "任务创建事务 create_task_tx 与中文自然语言解析 nlp.rs",
    ],
    acceptanceCriteria: [
      "任意界面下全局热键可唤起捕获输入",
      "键盘完成类型选择与提交",
      "捕获内容自动保存，进程异常退出不丢已输入内容",
      "提交后主界面保持不展开（若从隐藏状态唤起）",
    ],
    verification: "unverified",
    entryPoints: [
      "全局 Ctrl+Shift+Space（打开/聚焦独立捕获窗口）",
      "托盘 / 右键菜单「快速捕获」",
      "完整模式左侧导航「收集箱」tab（Ctrl+5）",
      "任务页顶部快速录入框（原有子集）",
    ],
  },
  {
    id: "core.scenario-workspace",
    category: "core",
    title: "场景工作区",
    description: "开发 / 办公 / 娱乐 / 学习等场景一键切换，保存并恢复整组环境。",
    detail:
      "场景是可反复进入的预设组合（v38 已落地独立实体）：一组应用、网址、文件目录、关联工作现场 / 工作流与暂存架文件。" +
      "与「工作现场恢复」的区别：现场 = 某个任务此刻环境的快照；场景 = 预先定义、可一键进入的标准工作组合。" +
      "场景只软引用 workspace_snapshots（不复制快照），自身不保存窗口几何；直接进入无取消能力、后端无并发互斥，" +
      "因此登记为 partial（嵌套深度校验不属于缺口：三层允许、第四层拒绝，保存与运行前共用同一校验，已由 5 个回归用例锁定）。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "场景实体与独立管理界面：SQLite v38 scenarios 表（FK ON DELETE SET NULL），工作流页「场景工作区」子视图，数量上限 32",
      "场景创建 / 编辑（整体覆盖清单）/ 删除 / 复制；删除只解除引用，不删现场、工作流、暂存条目或用户原文件",
      "场景内容：应用、网址、文件目录 + 关联工作现场 + 关联工作流 + 暂存架文件/文件夹软关联（shelf_items.scene_id）",
      "一键进入：现场恢复 → 应用 → 网址 → 目录 → 关联工作流，逐项 ok/skipped/failed 回执 + 进度事件",
      "保存时校验引用完整性（工作流 / 现场真实存在，暂存条目只能属于本场景）",
      "与工作现场恢复互不混淆：独立表、独立命令，场景不复制快照、不保存窗口矩形与 DPI",
    ],
    missingFeatures: [
      "直接进入的取消与超时：当前无法中止（最坏需等待现场恢复完成），也没有「退出场景」动作",
      "后端并发互斥：直接进入只有前端单飞，绕过前端可并发进入同一或不同场景",
      "场景专属设置与任务关联（当前内容仅应用 / 网址 / 目录 / 现场 / 工作流 / 暂存引用）",
      "场景自身的窗口布局与几何（只能经关联现场间接恢复，现场本身不存窗口矩形 / DPI）",
      "进入途中删除场景无显式中断：finish 写库 0 行不报错，回执可能落到已删除场景",
      "真机验收：多显示器、DPI、前台争用、进入中删除（无 CDP / 原生证据）",
    ],
    dependencies: [
      "复用 workspace 快照与 nav 导航启动链路（软引用，不复制）",
      "scenarios 表与工作流单运行槽（v38 迁移，已发布不可修改）",
    ],
    acceptanceCriteria: [
      "可创建、编辑、删除场景",
      "一键进入场景后应用 / 网页 / 目录按序打开并给出逐项结果",
      "场景与任务现场快照互不混淆",
      "重复进入场景不重复启动已运行应用",
    ],
    verification: "unverified",
    entryPoints: ["完整模式导航「工作流」→「场景工作区」"],
  },
  {
    id: "core.agent-action-center",
    category: "core",
    title: "Agent 行动中心",
    description: "统一处理 Agent 需介入事项：失败、等待授权、等待输入与历史。",
    detail:
      "把分散的 Agent 状态聚合成一个可处理的工作台：需介入（失败 / 等待授权 / 等待输入）、通知、历史三层分类，支持确认、跳转与会话恢复。现有实现已覆盖，本项登记用于验收现有能力、避免重复开发第二套行动中心。",
    status: "implemented",
    priority: "P0",
    existingFeatures: [
      "三层分类（需介入 / 通知 / 历史）+ 类型二级筛选，计数来自后端全局 SQL",
      "waiting / failed 聚合为「需介入」，幂等确认（ack/unack）与「显示已确认」回看",
      "事件去重（分页按 id 去重、通知与需介入不重复计数）",
      "一键跳转 Agent 会话 / 查看关联任务",
      "模块可在设置中整体启停，关闭时导航徽标同步归零",
    ],
    missingFeatures: [],
    dependencies: ["Agent 事件管线（有界队列 + 关键状态不合并）"],
    acceptanceCriteria: [
      "waiting/failed/completed 状态不合并、不静默丢弃",
      "确认操作幂等，刷新后状态稳定",
      "计数口径与导航徽标一致",
    ],
    verification: "verified",
    entryPoints: ["完整模式左侧导航「行动」", "悬浮胶囊 Agent 面板"],
  },
  {
    id: "core.workspace-restore",
    category: "core",
    title: "工作现场恢复",
    description: "保存并恢复任务关联的工作环境：窗口、文件、网页与上下文。",
    detail:
      "围绕任务保存完整工作现场并在需要时恢复。现有实现基于身份元数据（窗口类名 + 标题 + EXE，不落 HWND），恢复时优先唤醒已有窗口、绝不重复启动，逐项给出验证级别与结果。剩余缺口集中在窗口几何与浏览器多标签等细粒度恢复。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "保存现场：从任务关联目标一键捕获 / 手动勾选当前可见窗口，可命名多条",
      "恢复现场：串行恢复槽防并发、逐项执行、进度事件推送、恢复统计",
      "取消恢复：项间生效，剩余项如实记为 cancelled",
      "应用无法启动 / 路径失效时逐项失败标注（verification_level），不中断整体",
      "任务删除不销毁现场（降级为手动快照）；现场可与剪贴板素材互相关联",
    ],
    missingFeatures: [
      "窗口位置与大小恢复（当前只恢复「哪个窗口」，不恢复几何）",
      "浏览器多标签页恢复（当前每个 URL 条目恢复为单个页面）",
      "可恢复的工作进度信息（如文档内位置、滚动状态）",
      "恢复前预览与逐项勾选确认",
    ],
    dependencies: ["统一导航 nav_navigate 链路", "窗口身份匹配（Win32 运行时身份）"],
    acceptanceCriteria: [
      "保存 / 恢复 / 取消 / 删除全流程可用",
      "恢复结果逐项可见：成功 / 跳过 / 失败 + 验证级别",
      "同一时刻仅一个恢复任务，新恢复可安全抢占",
      "应用无法启动时降级处理并如实报告",
    ],
    verification: "unverified",
    entryPoints: ["任务卡「打开工作区」批量启动", "任务上下文抽屉「现场」分区"],
  },
  {
    id: "core.smart-reminders",
    category: "core",
    title: "智能日程提醒",
    description: "自然语言建提醒，支持周期、倒计时、延后与任务关联。",
    detail:
      "用一句话创建提醒（如「明天下午三点提醒我开会」「每周一早上整理工作」「30 分钟后提醒我休息」「每月 5 日提醒我缴费」），由现有任务、重复规则与通知系统承接；重点补齐倒计时体验、延后操作的界面入口与更复杂的周期规则，不重复开发提醒能力。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "中文自然语言解析创建：日期 / 时刻 / 相对时间（N 分钟后）/ 重复 / 提前提醒",
      "自然语言覆盖工作日、每 N 周、每 N 月、每月第 N 个星期X、每月最后一个工作日（不接节假日 API）",
      "重复规则引擎：每日 / 每 N 日 / 每周多日 / 每 N 周 / 每月几日 / 每 N 月 / 每月第 N 个星期X / 每月最后一个星期X / 每月最后一个工作日；完成自动推进下一期",
      "到期提醒 + 提前 N 分钟；休眠 / 重启后按挂钟补触发并标注",
      "快速提醒与倒计时：任务页 5/10/15/30 分钟、1 小时与自定义时分，页面级共享时钟按绝对时间换算",
      "延后提醒三处入口（任务详情、任务卡、任务通知），5/10/30 分钟、1 小时与自定义；延后后可撤销且旧撤销不覆盖后续编辑",
      "任务提醒通知提供查看任务 / 稍后提醒 / 完成任务真实操作",
    ],
    missingFeatures: [
      "提醒与场景 / 现场的联动",
      "法定节假日 / 调休跳过（按设计不接节假日 API，工作日仅自然周语义）",
      "真机双主题、窄窗与系统通知操作走查（自动化测试已覆盖逻辑，未做真机验收）",
    ],
    dependencies: ["任务调度器（1s 粒度后台循环）", "通知系统（限流 + 摘要）"],
    acceptanceCriteria: [
      "四类示例语句均可正确解析并创建",
      "重复提醒按规则推进，不错报不漏报",
      "延后操作有界面入口且生效可撤销",
      "倒计时可见、可取消",
      "延后与调度领取竞争不重复触发、旧撤销不覆盖新状态",
      "每两个月规则真正隔两月，2 月 28/29 与每月 31 日不跳过月份",
    ],
    verification: "unverified",
    entryPoints: [
      "任务页快速录入（自然语言）",
      "任务页快捷提醒与倒计时卡片",
      "任务编辑器重复规则（基础 / 自定义 / 高级每月，带中文预览）",
      "任务卡与任务详情「稍后提醒」",
      "任务提醒通知操作（查看任务 / 稍后提醒 / 完成任务）",
    ],
  },

  // ─── 工作流与效率增强（P1）─────────────────────────────────────────
  {
    id: "core.file-shelf",
    category: "workflow",
    title: "文件暂存架",
    description: "独立的临时文件收纳区：拖入拖出、批量整理、自动过期清理。",
    detail:
      "为「临时资料」建立独立收纳空间：文件、截图、图片、文档、链接、文件夹都可暂存，支持拖入、批量整理、一键清理与自动过期，并可关联任务。" +
      "与剪贴板的边界：剪贴板被动记录复制历史；暂存架是用户主动管理。" +
      "资源策略：不共享 clipboard_assets（删除按路径反查、无跨模块引用计数），暂存架建独立托管目录，「从剪贴板添加」复制字节生成独立副本，两边删除与备份互不影响。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "暂存架实体与完整界面（完整模式侧边栏入口）",
      "四种添加方式：文件选择器（多选/文件夹）、OS 拖入、链接、文本片段",
      "从剪贴板条目添加（复制为独立副本，剪贴板清空不影响）",
      "引用 / 托管副本双存储模式（默认引用不复制；托管受配额与磁盘余量约束）",
      "搜索、类型筛选、分组筛选、收藏筛选、置顶排序、分页",
      "多选批量操作：移动分组、收藏、删除（保护收藏/置顶/场景引用）",
      "过期清理：自动清理默认关闭、可预览候选、收藏/置顶/已被场景引用的条目永不被自动清理、绝不删除用户原文件",
      "手动过期清理先自动 dry-run 预览并二次确认，确认前不执行删除；结果按后端报告区分保留项、托管文件残留与同步失败，并提供重试同步",
      "图片缩略图懒加载与灯箱预览；文本/HTML 安全只读预览；未知格式展示元数据",
      "任务关联（幂等；删除任务不删暂存资源）",
      "暂存条目与场景的软关联：shelf_items.scene_id，场景保存/删除时维护，删除场景只解绑不删文件",
      "纳入正式备份/恢复（托管副本全量打包、路径安全校验）",
      "删除条目不误删剪贴板/原文件；系统级拖出前的替代：复制路径 / 复制文件（CF_HDROP）/ 所在文件夹",
    ],
    missingFeatures: [
      "系统级拖出到资源管理器（WebView2/OLE 通道未实现，见 docs/shelf/）",
      "真机拖入验收（无头环境不可模拟 OS 拖放，待真机复验）",
      "暂存架侧的场景归属展示与筛选（当前只有场景编辑器单向关联，暂存架看不到被谁占用）",
    ],
    dependencies: ["独立托管目录与配额策略", "Tauri 拖放事件（拖入）", "系统级文件拖出需 OLE/IDataObject 原生通道"],
    acceptanceCriteria: [
      "剪贴板历史与暂存架数据互不混淆",
      "暂存文件可拖出到资源管理器",
      "过期清理可配置且清理前有确认",
    ],
    verification: "unverified",
  },
  {
    id: "core.one-click-workflow",
    category: "workflow",
    title: "一键工作流",
    description: "把重复的应用与任务操作编排为可重复执行的一键流程。",
    detail:
      "v0.9 已交付白名单动作编排（打开应用/网页/文件目录、创建任务、恢复工作现场），顺序执行引擎支持暂停/继续/取消、逐步骤状态反馈与失败策略；幂等由全局单运行槽 + 持久化操作 ID 保证，异常退出标记 interrupted 且不自动重放。不引入任意脚本执行系统。「进入场景」步骤已接入：类型 / 前端选择器 / 保存校验 / 执行调用 / 循环与深度保护均已落地（v0.11）。嵌套层数口径：一层 = 一条「场景 → 场景关联工作流」边，工作流步骤「进入场景」不计层；三层允许、第四层在保存与运行前均拒绝（2026-11-06 由回归测试锁定）。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "工作流与步骤 CRUD（SQLite 迁移 v23，完整/快速备份登记）",
      "步骤编排：白名单动作 + 单步启停 + 失败策略（停止/继续）+ 上下移排序",
      "「进入场景」步骤：场景下拉取真实场景列表，保存时校验场景存在与循环引用，执行时调用场景进入（工作流内不递归启动场景关联工作流）",
      "场景/工作流图保护：直接与间接循环独立拒绝；嵌套三层允许、第四层拒绝，保存与运行前共用同一校验；覆盖多入口共享子图与删除关联后的恢复（5 个回归用例）",
      "执行引擎：顺序执行、暂停/继续/取消、逐步骤状态与失败原因、事件推送",
      "幂等与恢复：同一时刻单运行、操作 ID 回执、异常退出标 interrupted 不重放副作用",
      "示例模板（开发/办公，应用目标由用户选择）",
      "运行历史分页与保留（每工作流最近 50 条）",
    ],
    missingFeatures: [
      "工作流回执只保留场景步骤的 kind/status，丢失逐项 label 与失败原因，运行历史看不到场景内哪个应用失败",
      "「进入场景」真实执行（LiveExecutor）无自动化测试；窗口跳转与现场恢复联动未真机验收",
    ],
    dependencies: ["场景工作区（进入场景作为工作流步骤）", "统一导航 nav_navigate", "任务创建命令"],
    acceptanceCriteria: [
      "工作流可创建、编辑、排序、一键执行、取消",
      "执行状态与失败步骤清晰可见",
      "不执行任何未经用户确认的外部命令",
    ],
    entryPoints: ["完整模式左侧导航「工作流」（Ctrl+7）"],
    verification: "unverified",
  },
  {
    id: "core.notification-aggregation",
    category: "workflow",
    title: "智能通知聚合",
    description: "任务、Agent 与系统通知统一聚合：合并、优先级、摘要与已读。",
    detail:
      "在现有通知治理（双额度限流、完成合并摘要、静音、历史持久化）之上，补齐跨来源聚合视图与优先级策略：同一来源合并、按优先级排序、重要异常突出、低优先级折叠、按来源筛选与频率控制。不重复开发已有合并与限流机制。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "双额度限流：关键通知（waiting/failed/disconnected）保底额度 + 可合并类独立额度",
      "高频完成合并为一条摘要 + 窗口尾摘要（每窗口最多一条）",
      "全局静音 + 分类开关 + 限流窗口设置",
      "通知历史全量持久化：已读 / 全部已读 / 清空（二次确认）",
      "行动中心三层优先呈现（需介入 > 通知 > 历史）",
    ],
    missingFeatures: [
      "跨来源统一聚合视图（任务 / Agent / 系统混合流单一收件箱）",
      "逐条优先级字段与排序策略（当前仅按分类分层）",
      "通知摘要视图（一段时间内发生了什么）",
      "按来源筛选的聚合面板与更细的频率控制",
    ],
    dependencies: ["通知系统 NotifyGate", "行动中心数据链路"],
    acceptanceCriteria: [
      "相同来源重复消息合并展示",
      "重要异常在聚合视图中突出显示",
      "已读 / 未读状态跨视图一致",
      "限流与静音行为不因聚合改变",
    ],
    verification: "unverified",
    entryPoints: ["历史页（通知 + Agent 事件时间轴）", "设置 → 通知"],
  },
  {
    id: "core.focus-timer",
    category: "workflow",
    title: "专注与休息",
    description: "轻量番茄钟与休息提醒：自定义时长、久坐提醒、每日专注记录。",
    detail:
      "已交付（v0.10）：独立专注域与 12 个 focus_* 命令，会话历史与按本地日期聚合落库（迁移 v27，" +
      "focus_sessions / focus_daily_stats 纳入 BACKUP_TABLES）；复用 1s 调度器派生剩余时间，不新增常驻线程；" +
      "任务关联专注保存任务标题快照，任务删除后历史仍可展示；完整模式胶囊徽标同步阶段与剩余时间；" +
      "久坐提醒可关闭、可稍后提醒。真机走查（2026-11-04）覆盖开始→暂停→继续→取消与历史记录，" +
      "以及杀掉进程重启后按 app_restart 自动暂停（不补记退出区间）。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "番茄钟 / 正计时：开始、暂停、继续、完成、取消；状态由 1s 调度器派生，快照可恢复",
      "休息与久坐提醒：会话结束自动进入休息，可延长 / 跳过；久坐可稍后提醒，均可在偏好中关闭",
      "每日专注记录与历史：focus_sessions + focus_daily_stats（v27，纳入备份），按本地日期聚合、最近记录可查",
      "任务关联专注：绑定任务并保存标题快照，完成后历史保留",
      "完整模式胶囊徽标展示当前阶段与剩余时间（FocusCapsuleBadge）",
    ],
    missingFeatures: [],
    dependencies: ["任务调度器复用（避免新增长驻线程）", "通知系统", "悬浮胶囊徽标"],
    acceptanceCriteria: [
      "计时跨窗口隐藏 / 恢复保持正确",
      "专注统计按日可查",
      "关闭休息提醒后不再打扰",
      "Agent 关键操作期间不弹出打断",
    ],
    verification: "verified",
    entryPoints: ["任务页右上「专注与休息」（FocusWorkspace）", "完整模式悬浮胶囊专注徽标"],
  },
  {
    id: "core.global-search",
    category: "workflow",
    title: "全局搜索",
    description: "一处搜索任务、剪贴板、应用、Agent 会话、现场与笔记。",
    detail:
      "统一搜索入口：全局快捷键唤起、实时搜索、分类筛选、结果快速跳转、最近搜索记录。复用现有各面板数据查询能力（任务 LIKE 查询、剪贴板标题搜索、历史过滤、应用扫描缓存），不复制数据建立第二套数据库；必要时仅建轻量索引并限制查询规模。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "统一命令 global_search：单只读连接一次查询任务/剪贴板/收集箱/暂存架/应用/Agent/现场/规划中心八类数据（v0.9）",
      "Ctrl+Shift+F 应用内快捷键 + 居中搜索弹窗（overlayStack dialog 层、焦点陷阱、防抖 220ms、乱序防护）",
      "分类筛选（全部/任务/剪贴板/收集箱/文件暂存/应用/Agent/工作现场/规划中心）",
      "确定性排序：匹配等级（精确>前缀>包含>元数据）→ 待办/置顶优先 → 时间新优先",
      "结果跳转：任务滚动高亮、剪贴板条目详情、收集箱定位、暂存架详情、应用 navNavigate、Agent focusAgent、现场开上下文抽屉并展开快照、规划中心定位功能/里程碑/项目",
      "最近搜索本地保存（≤10 条，去重、可清除，仅 localStorage 不出网）",
      "SQL 全参数绑定 + LIKE 转义 + limit+1 探测 has_more；Agent 数据强制 origin=real 且来源 hidden=0",
    ],
    missingFeatures: [
      "已发现（未登记）应用的搜索：需只读应用扫描缓存访问器与 AppPicker 登记链路，当前仅搜索已保存导航目标",
      "FTS5 索引：LIKE 全表扫描在万级数据实测达标前不引入",
    ],
    dependencies: ["各面板现有查询命令", "防抖与查询上限（避免大库卡顿）"],
    acceptanceCriteria: [
      "快捷键唤起，输入实时出结果",
      "分类筛选准确，跳转直达条目",
      "大数据量下有查询限制且不阻塞界面",
    ],
    verification: "unverified",
  },

  // ─── 信息管理与生活效率（P2）───────────────────────────────────────
  {
    id: "core.quick-notes",
    category: "info",
    title: "快速笔记",
    description: "轻量临时笔记：快速新建、自动保存、置顶搜索、关联任务。",
    detail:
      "已交付（v0.10）：notes 表（迁移 v25，纳入 BACKUP_TABLES）与 11 个 notes_* 命令；面板支持新建 / 编辑 / " +
      "删除、自动保存（防抖）、收藏置顶、搜索、内置常用模板、关联任务与工作现场；收集箱条目可直接转为笔记；" +
      "统一搜索已接入笔记分类。明确不做双向链接与富文本。真机走查（2026-11-04）覆盖新建→自动保存→搜索命中→无结果空态，" +
      "并验证完整备份→删除→恢复后标题与正文回来、重启仍在。",
    status: "implemented",
    priority: "P2",
    existingFeatures: [
      "笔记实体与编辑界面：notes 表（v25 迁移，纳入备份），编辑自动保存",
      "收藏 / 置顶与搜索（notes_set_flags / notes_search）",
      "常用文本模板（notes_templates 内置模板）",
      "关联任务与工作现场（notes_set_task / notes_set_workspace）",
      "快速捕获转笔记（notes_convert_capture）",
      "全局搜索已覆盖笔记分类",
    ],
    missingFeatures: [],
    dependencies: ["SQLite 新表（已登记 BACKUP_TABLES）", "全局快速捕获（转换来源）", "全局搜索适配"],
    acceptanceCriteria: [
      "新建 / 编辑 / 删除 / 置顶 / 搜索可用",
      "输入自动保存，无丢失",
      "可关联任务并从任务上下文查看",
    ],
    verification: "verified",
    entryPoints: ["收集与暂存 → 笔记", "收集箱条目「转为笔记」", "全局搜索 → 笔记"],
  },
  {
    id: "core.life-routines",
    category: "info",
    title: "生活例行事项",
    description: "喝水、缴费、订阅续费等周期事项：打卡、今日待办与历史。",
    detail:
      "管理日常生活中的周期性事项（喝水、吃饭、缴费、订阅续费、家庭待办、定期整理、个人习惯）。原则：复用现有任务与重复规则引擎，绝不为生活事项另建一套独立任务系统；缺的是「例行」视角的专用界面与打卡记录。",
    status: "partial",
    priority: "P2",
    existingFeatures: [
      "周期任务引擎可覆盖典型场景：每日 / 每周多日 / 每月几日 + 间隔",
      "到期提醒、完成自动推进下一期、补触发",
    ],
    missingFeatures: [
      "例行事项专用视图：今日待办清单",
      "完成打卡与连续完成记录",
      "历史记录与延后处理（今天没做，明早再提醒）",
      "自定义分类（习惯 / 家庭 / 订阅续费 / 采购）",
    ],
    dependencies: ["任务与重复规则（数据层复用）", "通知系统"],
    acceptanceCriteria: [
      "例行事项与普通任务在同一数据层但视图分离",
      "打卡操作不触发重复任务的错误推进",
      "延后处理有记录、可追溯",
    ],
    verification: "unverified",
  },

  // ─── Agent 扩展 ─────────────────────────────────────────────────────
  {
    id: "agent.codex-app-server",
    category: "agent",
    title: "Codex App Server 深度接入",
    description: "经 codex app-server stdio JSON-RPC 获得线程恢复与完整对话事件。",
    detail:
      "当前 Codex 走 hooks 接入（7 个事件、真实联调通过），会话恢复用 codex resume。深度接入指 App Server 的 stdio JSON-RPC 通道：线程恢复、中断回合、完整对话事件（参考 mxyhi/AgentMonitor，MIT）。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "Codex hooks 接入：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PermissionRequest / Stop / Notification（二进制核验 + 真实联调）",
      "会话恢复：codex resume <id>（新终端进程打开）",
    ],
    missingFeatures: [
      "app-server stdio JSON-RPC 通道（线程恢复、中断回合）",
      "完整对话事件流（当前仅有状态类事件）",
      "App 形态与 CLI 形态的来源区分",
    ],
    dependencies: ["真实 Codex 环境联调", "app-server 接口稳定性确认"],
    acceptanceCriteria: [
      "经 app-server 恢复指定线程且不产生重复事件",
      "中断回合在 UI 正确呈现",
      "hooks 链路不受影响（两通道可并存）",
    ],
    verification: "unverified",
  },
  {
    id: "agent.claude-code-adapter",
    category: "agent",
    title: "Claude Code 专用适配器",
    description: "基于 ~/.claude/settings.json Hooks 的专用接入（已实现，真实会话待验证）。",
    detail:
      "Claude Code 适配器已落地：检测配置根 / 可执行文件 / 运行进程，向 ~/.claude/settings.json 的 hooks 字段安装 9 个官方基线事件（二进制实扫命中时以实扫结果为准），支持安装前备份、原子写入、失败回滚、第三方 hooks 原样保留与一键卸载；Hook 信任/权限确认仍由 Claude Code 自身把关。实现状态为已实现，真实会话事件尚未联调（verification=unverified）。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "发现：~/.claude 配置根 + claude 可执行文件 + 进程检测",
      "官方 Hooks：9 个基线事件自动安装 / 卸载，支持能力实扫覆盖",
      "备份、原子写入、失败回滚与第三方 hooks 条目保留",
      "链路自测（nonce 入库）与接入向导；不绕过 Claude Code 自身授权",
    ],
    missingFeatures: [],
    dependencies: ["Claude Code 官方 Hooks 机制"],
    acceptanceCriteria: [
      "安装后真实事件进入管线",
      "卸载还原配置且不影响用户已有 hooks",
    ],
    entryPoints: ["Agent → Claude Code 卡片 → 接入 / 验证 / 卸载"],
    verification: "unverified",
  },
  {
    id: "agent.cursor-adapter",
    category: "agent",
    title: "Cursor 专用适配器",
    description: "基于 ~/.cursor/hooks.json 的专用接入（已实现，真实会话待验证）。",
    detail:
      "Cursor 适配器已落地：只写用户级 ~/.cursor/hooks.json（保留 version 等既有字段），安装 8 个官方 camelCase 事件（二进制实扫命中时以实扫结果为准），支持备份、回滚、第三方条目保留与一键卸载；项目级 .cursor/hooks.json 不由 Task Dock 修改，Hook 授权确认由 Cursor 自身完成。实现状态为已实现，真实会话事件尚未联调（verification=unverified）。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "发现：~/.cursor 配置根 + Cursor 可执行文件 + 进程检测",
      "用户级官方 Hooks：8 个 camelCase 事件自动安装 / 卸载",
      "保留 version 与第三方 hooks 条目，写入前备份、失败回滚",
      "链路自测（nonce 入库）与接入向导；不修改项目级 hooks",
    ],
    missingFeatures: [],
    dependencies: ["Cursor 官方 Hooks 机制"],
    acceptanceCriteria: ["安装后真实事件进入管线", "事件字段与覆盖矩阵一致"],
    entryPoints: ["Agent → Cursor 卡片 → 接入 / 验证 / 卸载"],
    verification: "unverified",
  },
  {
    id: "agent.gemini-cli",
    category: "agent",
    title: "Gemini CLI 接入",
    description: "基于 Google Gemini CLI 官方 Hooks 的专用接入（已实现，真实会话待验证）。",
    detail:
      "Gemini CLI 适配器已落地：官方 Hooks（https://geminicli.com/docs/hooks）在 ~/.gemini/settings.json 的 hooks 字段定义 11 个生命周期事件（SessionStart / SessionEnd / BeforeAgent / AfterAgent / BeforeModel / AfterModel / BeforeToolSelection / BeforeTool / AfterTool / PreCompress / Notification），Task Dock 自动安装 / 卸载并支持备份、失败回滚与第三方条目保留；事件经 stdin JSON 上报，由统一模型映射。已知限制：SessionEnd 为 best-effort（CLI 不等待）、无进程退出码 / 失败专用事件，结束与失败状态以进程旁路与事件证据为准，不虚构状态。实现状态为已实现，真实会话事件尚未联调（verification=unverified）。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "发现：~/.gemini 配置根 + gemini 可执行文件 + 进程检测",
      "官方 Hooks：11 个生命周期事件自动安装 / 卸载，支持能力实扫覆盖",
      "备份、原子写入、失败回滚与第三方 hooks 条目保留",
      "链路自测（nonce 入库）与接入向导；缺失事件时如实显示未知",
    ],
    missingFeatures: [],
    dependencies: [
      "本机安装 Gemini CLI（官方文档对应 v0.66.0 起）",
      "settings.json Hooks 配置在目标版本生效",
    ],
    acceptanceCriteria: [
      "安装后 SessionStart / SessionEnd / BeforeTool / AfterTool 等事件进入有界管线",
      "工具调用前后与回合结束状态在 UI 如实显示，无法获取时显示「未知」",
      "SessionEnd best-effort 未触发时由进程旁路兜底，不虚构状态",
      "事件字段与 AGENT_COVERAGE_MATRIX.md 记录一致",
    ],
    entryPoints: ["Agent → Gemini CLI 卡片 → 接入 / 验证 / 卸载"],
    verification: "unverified",
  },
  {
    id: "agent.zcode-integration",
    category: "agent",
    title: "ZCode 官方 Hooks 接入",
    description: "通过 ZCode 用户级配置式 Hooks 读取真实执行状态。",
    detail:
      "ZCode 支持用户级配置式 hooks（~/.zcode/cli/config.json → hooks.events，需 hooks.enabled=true）。Task Dock 在 Agent 页安装时写入 7 个生命周期事件（SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop），并保留用户已有的 mcp / plugins / 第三方 hooks；卸载只移除自身条目。首次安装后需新开 ZCode 会话，已打开的会话不会热加载。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "发现：配置根 ~/.zcode/cli + Programs(ZCode) + 进程检测",
      "官方配置式 Hooks：7 个事件自动安装/卸载，安装时自动启用 hooks.enabled",
      "嵌套 hooks.events 写入、备份、失败回滚与第三方条目保留",
    ],
    missingFeatures: [
      "真实 ZCode 会话事件的端到端真机验证（需安装后新开会话，当前尚未执行）",
    ],
    dependencies: ["ZCode 用户级 config.json hooks 机制"],
    acceptanceCriteria: [
      "安装后新开 ZCode 会话，SessionStart / UserPromptSubmit / Stop 等真实事件进入有界管线",
      "Agent 页显示真实执行状态，无事件时如实显示「未知」",
      "卸载后仅移除 Task Dock 条目，用户 hooks 与 mcp/plugins 配置保持原样",
    ],
    entryPoints: ["Agent → ZCode 卡片 → 接入 / 验证 / 卸载"],
    verification: "unverified",
  },
  {
    id: "agent.work-time-stats",
    category: "agent",
    title: "Agent 工作时间统计",
    description: "按来源 / 会话统计运行时长、等待时长与失败率。",
    detail:
      "已交付（v0.10）：只读聚合命令 agent_work_time_stats，按来源与会话统计执行时长、等待时长与失败率；" +
      "Agent 面板「统计」tab 支持近 7 / 30 天与真实 / 模拟来源隔离，并提供口径说明与空态；" +
      "集成测试 tests/agent_work_time_stats.rs（23 用例）。真机走查（2026-11-04）覆盖范围切换与真实数据来源。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "agent_work_time_stats 聚合：执行时长、等待时长、失败率，按来源与会话维度",
      "Agent 面板「统计」tab：近 7 / 30 天切换，真实 / 模拟数据来源隔离",
      "空态与统计口径说明；只读连接，不阻塞 Agent 实时管线",
    ],
    missingFeatures: [],
    dependencies: ["agent_runs 时间水位（last_event_at / ingest_seq）已具备"],
    acceptanceCriteria: ["统计口径可解释、可复核", "大数据量下查询有上限"],
    verification: "verified",
    entryPoints: ["Agent 面板 → 统计 tab"],
  },
  {
    id: "agent.execution-timeline",
    category: "agent",
    title: "Agent 执行时间轴",
    description: "按运行（run）可视化的执行时间轴与时长统计。",
    detail:
      "历史页已有统一时间轴（通知 + Agent 事件、按日分组、连续重复事件聚合、keyset 分页）。本项目标是从「事件流水」升级为「按运行可视化」：每个 agent_run 的时间轴、时长与轮次展开。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "统一时间轴：通知 + Agent 事件、按日分组",
      "连续重复事件聚合、来源 / 类型 / 时间过滤",
      "keyset 分页 + 实时订阅刷新",
    ],
    missingFeatures: ["按 agent_run 的时间轴可视化", "运行时长统计", "轮次内步骤展开"],
    dependencies: ["agent_runs / agent_events 数据模型已具备"],
    acceptanceCriteria: ["一次运行的首尾事件可定位且时长正确", "与历史页共存不重复加载"],
    verification: "unverified",
    entryPoints: ["历史页（现有事件时间轴）"],
  },
  {
    id: "agent.mcp-server",
    category: "agent",
    title: "Agent MCP Server",
    description: "外部 MCP 客户端经授权读写规划中心：身份、权限、审计与乐观并发。",
    detail:
      "已交付（v0.11 后端最小安全闭环 + 设置页管理界面）：taskdock.exe --mcp-server stdio 子命令（手写 JSON-RPC 2.0 + " +
      "MCP 最小子集 initialize / tools/list / tools/call，不引入 SDK）→ 127.0.0.1 HTTP loopback bridge" +
      "（独立端口与 token，256KB 体积上限、20s 超时、连接/在途并发上限，日志不含请求体与凭据）→ 规划服务层 → SQLite。" +
      "身份存 SHA-256（明文仅创建时返回一次）；scope = disabled / readonly / project_rw + 逐项目授权，撤销即时生效；" +
      "每次调用写 mcp_audit_log，写工具 requestId 幂等（重复返回原结果）。18 个规划读写工具全部复用 planning 服务层，" +
      "强制 expected_revision 乐观并发（冲突明确返回）；update_feature 拒绝置 completed，submit_for_review 只置 review。" +
      "写入成功 emit planning-changed，前端去抖合并 + 代际守卫局部刷新，无新增轮询。设置键 mcp_server_enabled 默认关闭。" +
      "设置 → Agent 接入 → MCP 已提供开关、身份/凭据、授权项目、配置片段与分页审计查询。" +
      "测试：mcp 单测 29 个 + tests/mcp_e2e.rs 3 个（真实子进程握手→发现→读→拒绝→授权写→幂等→冲突→审计→重连→不可用降级）；" +
      "其中 feature_completed_is_user_only_and_submit_for_review_flow 已拆为 A–F 并通过（planned 冲突 / 超长回滚 / 合法提交 / " +
      "completed 拒绝 / 过期 revision / 无残留；生产代码未改，2026-11-06）。" +
      "内置路线图（featureCatalog.ts）与用户项目（planning_*）是两个数据源，MCP 工具不能写内置目录。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "stdio MCP 子命令 + loopback bridge（按设置开关启停，关闭即释放）",
      "agent 身份 / scope / 逐项目授权 / 撤销即时生效 / 审计与幂等",
      "18 个规划读写工具 + 乐观并发控制 + 防越权（completed 不可由 Agent 判定）",
      "设置 → Agent 接入 → MCP：开关、身份创建（明文仅一次）、轮换、撤销、scope、逐项目授权与撤权、四家客户端配置片段、分页审计查询",
      "planning-changed 事件 → 前端局部刷新（去抖 + 代际守卫，无轮询）",
    ],
    missingFeatures: [
      "设置页连接测试：无法发起一次经 bridge 鉴权的 initialize / tools/list 探测（当前只显示端口与运行状态）",
      "真实 MCP 客户端端到端联调（本机未安装 Claude Code / Codex CLI / Cursor / Trae 客户端，未执行）",
      "审计保留期与容量策略：mcp_audit_log 无清理，result_json 随备份全量保存",
      "任务 / 笔记 / 工作流等扩展工具（复用同一套权限与审计）",
    ],
    dependencies: ["planning_* 服务层与 v37/v38 迁移", "http_ingest 的 hyper + Bearer 既有模式"],
    acceptanceCriteria: [
      "未授权请求被拒绝且不降级为无认证",
      "并发冲突明确返回，后写不无声覆盖",
      "撤销凭据后既有会话立即失效",
      "task_dock 未运行时子进程返回明确不可用错误",
    ],
    verification: "unverified",
    entryPoints: [
      "taskdock.exe --mcp-server（外部 MCP 客户端 stdio 接入）",
      "设置 → Agent 接入 → MCP（开关 / 凭据 / 授权 / 审计）",
    ],
  },

  // ─── 任务与交互增强 ────────────────────────────────────────────────
  {
    id: "tasks.stats-trends",
    category: "workflow",
    title: "任务统计与效率分析",
    description: "完成率趋势、分类效率分析与日 / 周 / 月统计图表。",
    detail:
      "已交付（v0.10）：task_analytics 只读统计命令 + v24 task_completion_events（纳入 BACKUP_TABLES）；" +
      "任务页「任务统计」子视图支持日 / 周 / 月切换，展示完成率、逾期率、完成与逾期趋势、分类效率；" +
      "空数据给出明确空态。2026-11-04 增加 history_complete：调度器自动推进、停机补偿跳期或主动改期" +
      "导致无法还原的重复期次会明确标注「不完整统计」，不伪造分母；提前完成未来期次、当前 due 在窗口外" +
      "不会被误判。真机走查（2026-11-04）覆盖日 → 周 → 月切换、空数据边界、重复任务推进与提前完成。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "task_analytics：日 / 周 / 月范围，待办、今日到期、逾期、完成计数与完成率 / 逾期率",
      "完成与逾期趋势、分类效率分析",
      "v24 task_completion_events 记录完成事实（纳入备份，旧备份缺表时按空表处理）",
      "history_complete：无法还原的重复期次显式标记不完整，分清实际统计与不完整统计",
      "任务页「任务统计」子视图：4 张概览卡 + 轻量图表，空数据显示空态",
    ],
    missingFeatures: [],
    dependencies: ["tasks 表时间字段查询", "轻量图表方案（避免引入重型依赖）"],
    acceptanceCriteria: ["统计口径与概览卡一致", "时间范围可切换"],
    verification: "verified",
    entryPoints: ["任务页右上「任务统计」（TaskAnalyticsPanel）"],
  },
  {
    id: "ux.custom-hotkeys",
    category: "workflow",
    title: "自定义全局快捷键",
    description: "设置界面录制全局与应用内快捷键，含冲突检测。",
    detail:
      "已交付（v0.10）：hotkeys_snapshot / hotkeys_change / hotkeys_reset 三个命令 + 设置页录制控件；" +
      "应用内与全局热键分组管理，录制时即时校验冲突与系统占用，无修饰键组合被拒绝；" +
      "配置持久化到 hotkeys.json，改键立即生效、重启保持。配置随完整/快速备份迁移（bundle header 可选 config），" +
      "恢复时逐项重新校验并注册；组合被占用/重复时降级或禁用并保留原配置，不伪装恢复成功。" +
      "真机走查（2026-11-04）覆盖录制 Ctrl+Shift+J 生效、无修饰键被拒、系统级改键 Ctrl+Alt+F12、" +
      "组合冲突提示与重置；完整备份→恢复后快捷键立即回来且重启保持。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "设置页「快捷键」录制控件：逐动作编辑 / 重置 / Esc 取消，应用内与全局分组",
      "冲突检测与系统占用提示；无修饰键组合拒绝保存",
      "后端热键即时重新注册，配置持久化 hotkeys.json，重启保持",
      "配置随完整/快速备份迁移；恢复时重新注册，冲突降级/禁用并给出警告",
      "快捷键总开关 set_hotkeys_enabled 保留",
    ],
    missingFeatures: [],
    dependencies: ["tauri_plugin_global_shortcut 重新注册能力已具备"],
    acceptanceCriteria: ["录制冲突时明确提示", "改键后立即生效且重启保持"],
    verification: "verified",
    entryPoints: ["设置 → 窗口与快捷键 → 快捷键"],
  },
  {
    id: "ux.image-fullscreen",
    category: "workflow",
    title: "图片放大及全屏预览",
    description: "剪贴板图片灯箱：缩放、平移、双击切换与另存为。",
    detail: "剪贴板图片的放大查看已实现为图片灯箱：滚轮缩放、拖拽平移、双击切换缩放、复制原图、另存为，并接入统一弹层栈（Escape 逐层关闭）。",
    status: "implemented",
    priority: "P2",
    existingFeatures: [
      "滚轮缩放 / 拖拽平移 / 双击切换",
      "复制原图 / 另存为",
      "弹层栈隔离，Escape 只关当前层",
    ],
    missingFeatures: [],
    dependencies: ["统一弹层栈 overlayStack"],
    acceptanceCriteria: ["大图不卡顿、不溢出", "Escape 正确关闭"],
    verification: "verified",
    entryPoints: ["剪贴板图片详情 → 放大查看"],
  },
  {
    id: "ux.clipboard-viewers",
    category: "workflow",
    title: "剪贴板多类型专用查看器",
    description: "文本 / HTML / 图片 / 文件 / 链接各有专属详情视图。",
    detail: "按内容类型提供专用查看器：HTML 白名单只读阅读器（防 XSS、不渲染可点击链接）、图片灯箱、文件路径预览与打开、URL 详情、文本完整正文；详情内支持收藏、置顶、任务关联与 Agent 导出。",
    status: "implemented",
    priority: "P2",
    existingFeatures: [
      "HTML 白名单只读预览（防 XSS）",
      "图片灯箱 + 缩略图缓存",
      "文件列表预览、路径存在性检查、打开 / 定位",
      "详情内收藏 / 置顶 / 任务关联 / Agent 导出",
    ],
    missingFeatures: [],
    dependencies: ["剪贴板多类型条目模型"],
    acceptanceCriteria: ["HTML 预览不执行脚本", "文件路径不泄露到日志"],
    verification: "verified",
    entryPoints: ["剪贴板条目详情"],
  },
  {
    id: "ux.help-center",
    category: "workflow",
    title: "帮助与教程中心",
    description: "可随功能演进校验失效的内置教程：搜索、分类、功能关联与状态提示。",
    detail:
      "已交付（v0.11）：src/help 教程注册中心（结构化 TS 正文，heading/paragraph/steps/tip/note/callout，零新依赖）" +
      "+ 8 分类 20 篇教程（14 verified / 6 needs_review / 0 draft，2026-11-06 按内容源重新统计），正文自备 translations，" +
      "en-US 缺失时明确显示「暂无英文版」徽标并回退中文，不伪称国际化完成；完整模式第 13 个 rail 入口（help，不占 Ctrl+数字）；" +
      "搜索（标题/关键词/正文）、分类浏览、最近浏览（上限 8）、文章头显示适用版本/最近更新/翻译状态；" +
      "相关功能跳转对 planned / blocked / hidden / 停用分别给出状态提示而非死链接；复制操作步骤；" +
      "npm run help:check 契约校验（19 用例 = registry-contract 13 + health 6，覆盖 featureId / routeId / 正文完整性 / " +
      "en 结构平行 / 核心功能覆盖 / 内容版本 / 操作契约版本），引用失效即报错。" +
      "ContextHelpButton（? 弹出轻量说明）已接入 8 个业务页面共 9 处；帮助中心与设置页均可重新打开首次引导。" +
      "测试 61 用例 + 预览截图 8 张（深浅主题 × 列表/文章/搜索/引导 × 320 窄窗）。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "8 分类 20 篇教程 + 搜索 / 分类 / 最近浏览（上限 8）",
      "状态徽标：功能未实现 / 受阻 / 导航隐藏 / 停用 / 翻译缺失分别如实提示",
      "help:check 契约校验阻断引用失效（featureId / routeId / 翻译 / 版本 / 操作契约）",
      "第 13 个 rail 入口 + 从教程跳转实际功能 + 返回来源页面",
      "ContextHelpButton 已接入 Agent / 剪贴板 / 规划中心 / 设置（MCP 与备份）/ 暂存架 / 任务 / 场景 / 工作流编辑器 9 处",
      "帮助中心与设置页均提供「重新打开引导」入口",
    ],
    missingFeatures: [
      "帮助中心与首次使用引导自身没有教程（help:check 已提示「可见功能尚未关联教程」）",
      "教程正文语义漂移无自动检测：verified 教程曾长期声称「进入场景步骤会被拒绝」，与代码冲突；本次已更正正文，契约层仍只校验引用/版本，不校验语义",
      "6 篇 needs_review 待复核；14 篇缺 en-US 翻译",
      "真实 WebView2 / 真机双主题与窄窗走查（现有证据为 A 自动化 + B 隔离预览）",
    ],
    dependencies: ["featureCatalog.ts（功能元数据事实源）", "navigationRegistry.ts（入口寻址）", "overlayStack 弹层栈"],
    acceptanceCriteria: [
      "引用不存在的功能或路由时校验报错",
      "功能隐藏 / 停用 / 未实现时教程入口不误导",
      "帮助中心不引入常驻后台且不要求主窗变大",
    ],
    verification: "unverified",
    entryPoints: ["完整模式左栏「帮助」（Ctrl 无绑定）", "npm run help:check（教程契约校验）"],
  },
  {
    id: "ux.onboarding",
    category: "workflow",
    title: "首次使用引导",
    description: "首次启动三步入门：认识界面、完成第一个任务、按需启用功能。",
    detail:
      "已交付（v0.11）：useOnboardingStore（localStorage taskdock.onboarding.v1）+ OnboardingOverlay 页内卡片" +
      "（非全屏 Modal），仅完整模式且未完成时显示；三步（认识 task_dock → 完成第一个任务 → 选择需要的功能）均可跳过 / 返回，" +
      "Escape 经 overlayStack，键盘可操作；不创建任何业务数据（步骤按钮只做页面跳转）；升级版本只置「有新内容」红点" +
      "由帮助中心呈现，不自动重播；可从帮助中心与设置页（「重新打开引导」）重新打开。测试覆盖步骤流转 / 跳过 / 持久化 / 不重播。" +
      "剩余事项：真机双主题 / 窄窗 / DPI 走查未执行。",
    status: "implemented",
    priority: "P2",
    existingFeatures: [
      "三步引导：可跳过、可返回、可从帮助中心与设置页重新打开",
      "状态持久化，升级版本不重复强制展示",
      "页内卡片形态 + overlayStack + 键盘操作 + 双主题 Token",
    ],
    missingFeatures: [],
    dependencies: ["useUiStore tab 调度", "overlayStack", "帮助中心与设置页（重新打开入口）"],
    acceptanceCriteria: ["首次启动出现且仅出现一次", "跳过后不再自动弹出", "不创建不可辨别的永久测试数据"],
    verification: "unverified",
    entryPoints: ["首次启动完整模式自动呈现", "帮助中心 → 重新打开引导", "设置 → 帮助与引导 → 重新打开引导"],
  },

  // ─── 长期生态 ───────────────────────────────────────────────────────
  {
    id: "eco.i18n",
    category: "ecosystem",
    title: "多语言 i18n",
    description: "界面文案抽取与英文支持。",
    detail:
      "已部分交付（v0.10）：语言资源层（zh-CN / en-US，MessageKey 类型约束）、useLocale 与「设置 → 语言」切换" +
      "（简体中文 / English / 跟随系统）；偏好写入 localStorage（taskdock.locale），即时生效、重启保留、非法值回落中文；" +
      "七项功能面板与胶囊 / 紧凑 / 极简 / 剪贴板 / 通知等已接入。2026-11-04 补：主导航 11 个入口（稳定 labelKey，" +
      "aria / data-tip / 计数同步）、设置页全部分区标题与设置项、任务 / Agent / 应用 / 工作流 / 历史页面骨架已完成中英覆盖；" +
      "切换语言不重建根组件、不丢输入与 Tab；语言偏好经 preferences.json 随备份迁移。真机走查（2026-11-04）显示" +
      "English 下导航与设置即时切换、切回中文正常。剩余 Agent 接入向导、任务 / 工作流 / 规划编辑器、剪贴板详情等" +
      "内部文案仍为中文，故整体保持 partial。",
    status: "partial",
    priority: "P2",
    existingFeatures: [
      "语言资源层与 MessageKey 类型约束（zh-CN / en-US）",
      "设置项语言切换（简体中文 / English / 跟随系统），localStorage 持久化、即时生效、重启保留、非法值回落",
      "日期 / 错误码本地化（i18n/format、i18n/errors）",
      "七项功能面板与胶囊 / 紧凑 / 极简 / 剪贴板 / 通知等已接入",
      "主导航 11 个入口（labelKey / aria / Tooltip）与设置页分区、设置项、选项、确认、Toast 已中英覆盖",
      "任务 / Agent / 应用 / 工作流 / 历史页面骨架已覆盖；切换语言即时生效且不重建根组件",
      "语言偏好镜像到 preferences.json，随完整/快速备份迁移，恢复后立即应用并回执",
    ],
    missingFeatures: [
      "Agent 接入管理向导 / 详情、任务编辑、工作流与规划编辑器、剪贴板详情等页面内部文案仍为中文硬编码",
      "部分深层空态、错误提示与动态拼接文案尚未逐条抽取",
    ],
    dependencies: ["全量文案盘点（一次性成本较高）"],
    acceptanceCriteria: ["切换语言即时生效", "不破坏现有语义 Token 与布局"],
    verification: "unverified",
    entryPoints: ["设置 → 外观与主题 → 语言"],
  },
  {
    id: "eco.widgets",
    category: "ecosystem",
    title: "桌面微件库",
    description: "迷你图表、今日进度环等可选桌面微件。",
    detail:
      "部分交付（v0.10）：主导航「微件」页提供 6 类微件（今日任务 / 下一条提醒 / Agent 状态 / 快捷操作 / " +
      "专注倒计时 / 今日效率），微件库按需开关并可选尺寸，数据只读复用各模块选择器、不新增 IPC，隐藏时不轮询；" +
      "启用状态与顺序存于 localStorage，并镜像到 preferences.json 随完整/快速备份迁移；恢复时按白名单过滤未知类型、" +
      "去重并保留支持项顺序。效率微件在任务数据变化时按需重查（120ms 合并、单在途、代际防旧响应），失败保留旧值并显示" +
      "「可能已过期 / 重试」，不做后台轮询。2026-11-04 补：6 类微件可独立放入桌面轻量窗口（专用 widget.html 宿主，不挂载完整 " +
      "App.tsx；独立 capability、普通层级/可选置顶、关闭即销毁），窗口尺寸/位置（归一化锚点 + 显示器名 + 逻辑尺寸）与" +
      "置顶偏好扩展现有布局 schema 并随备份迁移；看板启用与桌面显示相互独立。真机走查（2026-11-04）仍仅覆盖主窗内看板与" +
      "备份恢复；独立窗口拖动/多显示器/DPI 尚未真机验证（见验收报告）。",
    status: "partial",
    priority: "P2",
    existingFeatures: [
      "主导航「微件」页：6 类微件（今日任务 / 下一条提醒 / Agent 状态 / 快捷操作 / 专注倒计时 / 今日效率）",
      "微件库按需开关与尺寸（紧凑 / 标准 / 宽松），已启用计数与空态",
      "数据只读复用各模块现有选择器，不新增 IPC；未挂载时不轮询",
      "效率微件数据变更失效 + 合并刷新 + 失败过期提示与重试",
      "启用状态、顺序与尺寸持久化在 localStorage，并镜像到 preferences.json 随备份迁移",
      "独立桌面窗口宿主（widget.html + 专用 capability），支持桌面显示/移除、置顶、重置位置与拖动保存",
      "桌面窗口配置（尺寸/锚点/显示器/置顶）与看板启用独立，并随备份恢复",
    ],
    missingFeatures: [
      "独立窗口真机验证：多显示器插拔、100–200% DPI、重启恢复与资源回收（自动化未覆盖）",
      "复杂磁吸 / 自动隐藏编辑器（明确不在首版范围）",
      "微件注册机制未对外开放",
    ],
    dependencies: ["窗口管理能力（独立小窗、DPI、多显示器）已具备"],
    acceptanceCriteria: ["微件可独立开关", "隐藏后不留后台轮询"],
    verification: "unverified",
    entryPoints: ["主导航 → 微件"],
  },
  {
    id: "eco.plugins",
    category: "ecosystem",
    title: "第三方插件系统及沙箱",
    description: "第三方 Adapter / 视图插件，含沙箱与权限设计。",
    detail: "允许第三方扩展 Adapter 与视图（WASM 或动态库形态），必须先完成沙箱与权限设计：插件不可直接访问用户数据库与剪贴板正文，事件经统一管线进入。",
    status: "planned",
    priority: "P2",
    existingFeatures: ["Adapter 生命周期命令（安装 / 验证 / 卸载）可作为机制参照"],
    missingFeatures: ["插件清单与权限模型", "沙箱执行环境", "插件市场或手动安装流程"],
    dependencies: ["安全设计评审先行"],
    acceptanceCriteria: ["插件越权访问被拒绝", "卸载插件后无残留监听"],
    verification: "unverified",
  },
  {
    id: "eco.sync",
    category: "ecosystem",
    title: "WebDAV / 文件同步",
    description: "用户显式开启的自托管数据同步，默认永不开启。",
    detail: "基于现有本地备份引擎（流式 JSONL bundle + 完整性校验）提供可选同步：WebDAV 或文件目录，用户显式选择目标，默认永不开启。不含云服务。",
    status: "planned",
    priority: "P2",
    existingFeatures: ["本地每日自动备份 + 备份下载 / 恢复"],
    missingFeatures: ["WebDAV 客户端", "同步冲突策略", "同步状态与手动触发界面"],
    dependencies: ["备份 manifest 版本兼容", "凭据存储安全（不落可提交文件、不入日志）"],
    acceptanceCriteria: ["默认关闭", "冲突时不静默覆盖任一端", "凭据不入日志与备份"],
    verification: "unverified",
  },
  {
    id: "eco.cross-platform",
    category: "ecosystem",
    title: "macOS / Linux 适配",
    description: "补齐非 Windows 平台的窗口材质、托盘与剪贴板实现。",
    detail: "架构已预留跨平台抽象（窗口 / 托盘逻辑），需补齐 macOS Vibrancy、Linux AppIndicator、剪贴板平台层与真机验收。当前仅支持 Windows。",
    status: "planned",
    priority: "P2",
    existingFeatures: ["窗口 / 托盘 / 剪贴板的平台抽象边界已预留"],
    missingFeatures: ["macOS Vibrancy / 材质", "Linux AppIndicator 托盘", "剪贴板 platform 层实现", "真机验收"],
    dependencies: ["跨平台开发与验收环境"],
    acceptanceCriteria: ["核心流程在目标平台可用", "平台差异如实标注不降级为假实现"],
    verification: "unverified",
  },
];

/** 按 id 取功能项 */
export function getFeatureById(id: string): FeatureEntry | undefined {
  return FEATURE_CATALOG.find((f) => f.id === id);
}

/** 全目录状态计数（规划页统计行与文档同步使用） */
export interface CatalogSummary {
  total: number;
  coreTotal: number;
  implemented: number;
  partial: number;
  planned: number;
  blocked: number;
  verified: number;
  unverified: number;
}

export function featureCatalogSummary(): CatalogSummary {
  const s: CatalogSummary = {
    total: FEATURE_CATALOG.length,
    coreTotal: 0,
    implemented: 0,
    partial: 0,
    planned: 0,
    blocked: 0,
    verified: 0,
    unverified: 0,
  };
  for (const f of FEATURE_CATALOG) {
    s[f.status] += 1;
    if (CORE_FEATURE_IDS.includes(f.id)) s.coreTotal += 1;
    s[f.verification] += 1;
  }
  return s;
}

/** 按分类分组（保持 CATEGORY_ORDER 顺序，空分类不返回） */
export function featuresByCategory(): { category: FeatureCategory; items: FeatureEntry[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: FEATURE_CATALOG.filter((f) => f.category === category),
  })).filter((g) => g.items.length > 0);
}
