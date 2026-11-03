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
      "场景是可反复进入的预设组合：一组应用、窗口布局、网址、文件目录、关联任务与场景专属设置。与「工作现场恢复」的区别：" +
      "现场 = 某个任务此刻环境的快照；场景 = 预先定义、可一键进入的标准工作组合。实现应复用现有 workspace 快照、统一导航与窗口管理能力，不另起炉灶。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "工作现场快照：按任务捕获窗口组合 / 手动勾选，可命名保存多条",
      "批量启动器：应用唤醒复用 / 网页 / 目录 / Agent 会话，逐项成败反馈，可取消未执行项",
      "任务关联导航目标 + 窗口身份记忆（类名 + 标题，不存 HWND）",
    ],
    missingFeatures: [
      "独立于任务的「场景」实体与场景管理界面（创建 / 编辑 / 删除）",
      "场景保存应用清单、窗口布局、网址、文件目录、关联任务与专属设置",
      "一键进入 / 恢复场景（不依赖某个具体任务）",
      "自定义场景命名与图标",
    ],
    dependencies: [
      "复用 workspace 快照与 nav 导航启动链路",
      "场景数据模型（新表或扩展现有快照）",
    ],
    acceptanceCriteria: [
      "可创建、编辑、删除场景",
      "一键进入场景后应用 / 网页 / 目录按序打开并给出逐项结果",
      "场景与任务现场快照互不混淆",
      "重复进入场景不重复启动已运行应用",
    ],
    verification: "unverified",
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
      "多选批量操作：移动分组、收藏、删除（保护收藏/置顶）",
      "过期清理：自动清理默认关闭、可预览候选、收藏/置顶永不被自动清理、绝不删除用户原文件",
      "图片缩略图懒加载与灯箱预览；文本/HTML 安全只读预览；未知格式展示元数据",
      "任务关联（幂等；删除任务不删暂存资源）",
      "纳入正式备份/恢复（托管副本全量打包、路径安全校验）",
      "删除条目不误删剪贴板/原文件；系统级拖出前的替代：复制路径 / 复制文件（CF_HDROP）/ 所在文件夹",
    ],
    missingFeatures: [
      "系统级拖出到资源管理器（WebView2/OLE 通道未实现，见 docs/shelf/）",
      "与场景工作区的 scene_id 联动（等场景接口稳定）",
      "真机拖入验收（无头环境不可模拟 OS 拖放，待真机复验）",
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
      "第一版采用预设动作组合（打开应用 / 网页 / 目录 / 创建任务 / 进入场景），不引入任意脚本执行系统。涉及文件、命令和外部程序时必须有明确的权限与安全边界（仅使用用户在应用与快捷方式中确认过的启动配置）。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "工作流实体与步骤编排界面（增删步骤、调整顺序）",
      "执行引擎：顺序执行、暂停 / 取消、逐步骤状态反馈",
      "失败后明确提示失败步骤与原因",
      "示例工作流模板（开发 / 办公）",
    ],
    dependencies: ["场景工作区（进入场景作为工作流步骤）", "统一导航 nav_navigate", "任务创建命令"],
    acceptanceCriteria: [
      "工作流可创建、编辑、排序、一键执行、取消",
      "执行状态与失败步骤清晰可见",
      "不执行任何未经用户确认的外部命令",
    ],
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
      "轻量专注管理：番茄钟、自定义专注时长、休息计时、久坐提醒、工作时长统计与任务关联专注。约束：计时状态可靠（后台运行不依赖高频轮询，复用现有 1s 调度器）、休息提醒可关闭、不打断重要 Agent 操作、支持深浅主题、不增加长期后台资源负担。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "番茄钟计时器与状态持久化",
      "休息 / 久坐提醒（可关闭）",
      "每日专注记录与历史统计",
      "任务关联专注（专注时段归属任务）",
    ],
    dependencies: ["任务调度器复用（避免新增长驻线程）", "通知系统"],
    acceptanceCriteria: [
      "计时跨窗口隐藏 / 恢复保持正确",
      "专注统计按日可查",
      "关闭休息提醒后不再打扰",
      "Agent 关键操作期间不弹出打断",
    ],
    verification: "unverified",
  },
  {
    id: "core.global-search",
    category: "workflow",
    title: "全局搜索",
    description: "一处搜索任务、剪贴板、应用、Agent 会话、现场与笔记。",
    detail:
      "统一搜索入口：全局快捷键唤起、实时搜索、分类筛选、结果快速跳转、最近搜索记录。复用现有各面板数据查询能力（任务 LIKE 查询、剪贴板标题搜索、历史过滤、应用扫描缓存），不复制数据建立第二套数据库；必要时仅建轻量索引并限制查询规模。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "全局搜索入口与快捷键",
      "跨模块实时搜索与分类筛选（任务 / 剪贴板 / 暂存架 / 应用 / Agent / 会话 / 现场 / 笔记）",
      "搜索结果快速跳转到对应面板与条目",
      "最近搜索记录",
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
      "第一版采用本地轻量存储（新表或复用设置存储），支持快速新建、自动保存、编辑删除、收藏置顶、搜索、常用文本模板、关联任务与工作现场；快速捕获的内容可转为笔记。明确不做复杂知识管理系统（无双向链接、无富文本编辑器）。",
    status: "planned",
    priority: "P2",
    existingFeatures: [],
    missingFeatures: [
      "笔记实体与编辑界面（自动保存）",
      "收藏置顶与搜索",
      "常用文本模板",
      "关联任务 / 现场；快速捕获转笔记",
    ],
    dependencies: ["SQLite 新表（登记 BACKUP_TABLES）", "全局快速捕获（转换来源）"],
    acceptanceCriteria: [
      "新建 / 编辑 / 删除 / 置顶 / 搜索可用",
      "输入自动保存，无丢失",
      "可关联任务并从任务上下文查看",
    ],
    verification: "unverified",
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
    description: "基于 ~/.claude/settings.json Hooks 的专用接入（格式已勘明）。",
    detail:
      "Claude Code 的 Hooks 配置格式已在本机勘明（~/.claude/settings.json，v2.1.186），当前未实现检测 / 安装 / 卸载与事件核验，暂走通用桥接。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "检测 / 安装 / 卸载 / 验证命令",
      "事件名核验与真实链路联调",
      "接入向导与覆盖矩阵登记",
    ],
    dependencies: ["本机 Claude Code 环境联调"],
    acceptanceCriteria: [
      "安装后真实事件进入管线",
      "卸载还原配置且不影响用户已有 hooks",
    ],
    verification: "unverified",
  },
  {
    id: "agent.cursor-adapter",
    category: "agent",
    title: "Cursor 专用适配器",
    description: "基于 ~/.cursor/hooks.json 的专用接入（格式已勘明）。",
    detail: "Cursor hooks 配置格式已勘明（version:1 + camelCase 事件名），待实现适配器并真实联调。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "检测 / 安装 / 卸载命令",
      "camelCase 事件到统一事件模型的映射",
      "真实链路联调",
    ],
    dependencies: ["本机 Cursor 环境联调"],
    acceptanceCriteria: ["安装后真实事件进入管线", "事件字段与覆盖矩阵一致"],
    verification: "unverified",
  },
  {
    id: "agent.gemini-cli",
    category: "agent",
    title: "Gemini CLI 接入",
    description: "基于 Google Gemini CLI 官方 Hooks 的专用接入（官方事件接口已存在，适配器待开发）。",
    detail:
      "官方 Hooks 已存在并文档化（https://geminicli.com/docs/hooks/ 与 /docs/hooks/reference/ ，2026-11-03 核对）：settings.json 的 hooks 定义支持 11 个生命周期事件（SessionStart / SessionEnd / BeforeAgent / AfterAgent / BeforeModel / AfterModel / BeforeToolSelection / BeforeTool / AfterTool / PreCompress / Notification），handler 目前仅支持 command，默认超时 60000ms；事件经 stdin JSON 传入（session_id、hook_event_name、timestamp、cwd、transcript_path 等），stdout 返回 JSON 决策，退出码 / 超时 / 失败语义与 Claude Code 不同，不能套用其配置格式。现有缺口是适配器本身，以及 SessionEnd 为 best-effort（CLI 不等待）且无进程退出码 / 失败专用事件，结束与失败状态需进程兜底。需完成配置发现、事件解析、状态映射与真实联调。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "多层配置发现（Project .gemini > User ~/.gemini > System > Extensions）",
      "11 个生命周期事件到统一事件模型的映射（含 BeforeTool / AfterTool 工具上下文）",
      "事件到 Agent 运行状态映射及 SessionEnd 缺失时的进程兜底",
      "本机 Gemini CLI 真实联调与覆盖率矩阵更新",
    ],
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
    verification: "unverified",
  },
  {
    id: "agent.zcode-integration",
    category: "agent",
    title: "ZCode 自动接入完善",
    description: "完善 ZCode 的发现、桥接与插件自动注册验证。",
    detail:
      "ZCode 当前支持发现（~/.zcode + Programs + 进程检测）与通用桥接（HTTP / 文件投递，source_id=zcode）。因无公开 hooks 文档且第三方本地注册插件风险高，采取不自动安装策略；真实执行状态无法读取时如实显示「未知」。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "发现：配置根 + Programs 目录 + 进程检测",
      "通用桥接：HTTP / 文件投递（source_id=zcode）",
    ],
    missingFeatures: [
      "插件市场自动注册的验证链路",
      "真实执行状态读取（当前显示「未知」）",
    ],
    dependencies: ["ZCode 插件机制公开文档或稳定接口"],
    acceptanceCriteria: ["真实事件经桥接进入管线并验证", "不自动写入第三方配置"],
    verification: "unverified",
  },
  {
    id: "agent.work-time-stats",
    category: "agent",
    title: "Agent 工作时间统计",
    description: "按来源 / 会话统计运行时长、等待时长与失败率。",
    detail: "基于 agent_runs / agent_events 聚合统计：按来源、会话维度统计运行时长、等待时长、失败率，帮助评估各 Agent 的实际效率。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: ["时长聚合查询", "统计视图与图表", "失败率口径定义"],
    dependencies: ["agent_runs 时间水位（last_event_at / ingest_seq）已具备"],
    acceptanceCriteria: ["统计口径可解释、可复核", "大数据量下查询有上限"],
    verification: "unverified",
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

  // ─── 任务与交互增强 ────────────────────────────────────────────────
  {
    id: "tasks.stats-trends",
    category: "workflow",
    title: "任务统计与效率分析",
    description: "完成率趋势、分类效率分析与日 / 周 / 月统计图表。",
    detail: "当前统计为概览卡（待完成 / 今日到期 / 逾期 / 今日完成）。本项扩展为趋势型分析：按日 / 周 / 月统计、完成率趋势、分类效率分析。",
    status: "planned",
    priority: "P1",
    existingFeatures: ["统计概览卡：待完成 / 今日到期 / 逾期（可点击跳转）/ 今日完成"],
    missingFeatures: ["按日 / 周 / 月统计", "完成率与逾期率趋势", "分类效率分析", "图表呈现（轻量、可关）"],
    dependencies: ["tasks 表时间字段查询", "轻量图表方案（避免引入重型依赖）"],
    acceptanceCriteria: ["统计口径与概览卡一致", "时间范围可切换"],
    verification: "unverified",
  },
  {
    id: "ux.custom-hotkeys",
    category: "workflow",
    title: "自定义全局快捷键",
    description: "设置界面录制全局与应用内快捷键，含冲突检测。",
    detail: "当前全局热键固定为 Ctrl+Alt+T（显示 / 隐藏主窗）与 Ctrl+Shift+Space（快速录入），应用内快捷键固定。目标是设置界面可录制自定义组合并检测冲突。",
    status: "planned",
    priority: "P1",
    existingFeatures: [
      "固定全局热键 + set_hotkeys_enabled 开关",
      "应用内快捷键：Ctrl+1…8 / Ctrl+K / Ctrl+Shift+C（顺序取自 TAB_ORDER 单一事实源）",
    ],
    missingFeatures: ["快捷键录制控件", "冲突检测与系统占用提示", "与后端热键注册的双向同步"],
    dependencies: ["tauri_plugin_global_shortcut 重新注册能力已具备"],
    acceptanceCriteria: ["录制冲突时明确提示", "改键后立即生效且重启保持"],
    verification: "unverified",
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

  // ─── 长期生态 ───────────────────────────────────────────────────────
  {
    id: "eco.i18n",
    category: "ecosystem",
    title: "多语言 i18n",
    description: "界面文案抽取与英文支持。",
    detail: "将界面文案抽取为语言资源，支持英文；默认简体中文不变。",
    status: "planned",
    priority: "P2",
    existingFeatures: [],
    missingFeatures: ["文案抽取与语言资源层", "设置项语言切换", "日期时间本地化复核"],
    dependencies: ["全量文案盘点（一次性成本较高）"],
    acceptanceCriteria: ["切换语言即时生效", "不破坏现有语义 Token 与布局"],
    verification: "unverified",
  },
  {
    id: "eco.widgets",
    category: "ecosystem",
    title: "桌面微件库",
    description: "迷你图表、今日进度环等可选桌面微件。",
    detail: "在悬浮胶囊之外提供可选的桌面微件（迷你图表、今日进度环等），按需开关，不增加常驻资源负担。",
    status: "planned",
    priority: "P2",
    existingFeatures: ["悬浮胶囊（任务 / Agent / 剪贴板 / 应用四分类）作为形态参照"],
    missingFeatures: ["微件宿主窗口与布局", "微件注册机制", "资源占用约束"],
    dependencies: ["窗口管理能力（独立小窗、DPI、多显示器）已具备"],
    acceptanceCriteria: ["微件可独立开关", "隐藏后不留后台轮询"],
    verification: "unverified",
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
