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

/**
 * 七个展示分区：核心效率 / 工作台与专业创作 / 工作流与效率增强 /
 * 信息管理与生活效率 / Agent 扩展 / 长期生态 / 设备、系统与数据。
 * 新增分区必须同时登记 CATEGORY_META 与 CATEGORY_ORDER，并被目录测试锁定。
 */
export type FeatureCategory =
  | "core"
  | "workbench"
  | "workflow"
  | "info"
  | "agent"
  | "ecosystem"
  | "system";

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
  workbench: {
    label: "工作台与专业创作",
    description: "P0–P1：统一宿主、项目容器与专业创作能力",
  },
  workflow: { label: "工作流与效率增强", description: "P1：把重复操作变成一次点击" },
  info: { label: "信息管理与生活效率", description: "P2：信息收纳与生活事项" },
  agent: { label: "Agent 扩展", description: "更多 Agent 接入与执行洞察" },
  ecosystem: { label: "长期生态", description: "跨平台、插件、同步等长期方向" },
  system: {
    label: "设备、系统与数据",
    description: "P1–P2：跨设备协作、本机资源、诊断与数据安全",
  },
};

export const CATEGORY_ORDER: readonly FeatureCategory[] = [
  "core",
  "workbench",
  "workflow",
  "info",
  "agent",
  "ecosystem",
  "system",
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
      "场景只软引用 workspace_snapshots（不复制快照），窗口几何经关联现场快照间接获得（v40：快照条目已含窗口矩形/显示器/DPI，" +
      "恢复时按显示器映射或收敛到工作区）；2026-11-08 已交付进入取消/整体超时/后端互斥（取消与超时只在项间生效，" +
      "已启动项不回滚），剩余缺口为「退出场景」动作与场景专属设置，" +
      "因此登记为 partial（嵌套深度校验不属于缺口：三层允许、第四层拒绝，保存与运行前共用同一校验，已由 5 个回归用例锁定）。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "场景实体与独立管理界面：SQLite v38 scenarios 表（FK ON DELETE SET NULL），工作流页「场景工作区」子视图，数量上限 32",
      "场景创建 / 编辑（整体覆盖清单）/ 删除 / 复制；删除只解除引用，不删现场、工作流、暂存条目或用户原文件",
      "场景内容：应用、网址、文件目录 + 关联工作现场 + 关联工作流 + 暂存架文件/文件夹软关联（shelf_items.scene_id）",
      "一键进入：现场恢复 → 应用 → 网址 → 目录 → 关联工作流，逐项 ok/skipped/failed 回执 + 进度事件",
      "进入取消与整体超时（2026-11-08）：后端 ScenarioEnterGate 唯一操作槽，并发进入返回可重试冲突；scenario_enter_cancel 可取消，整体预算 120s；取消/超时只阻止未执行项，结果回执含 cancelled/timedOut/total；进入期间全卡片编辑/复制/删除禁用",
      "删除守卫（2026-11-08）：删除在途场景先请求取消并最多等 2s，未退出返回冲突且不删除；其他场景删除不受影响",
      "保存时校验引用完整性（工作流 / 现场真实存在，暂存条目只能属于本场景）",
      "与工作现场恢复互不混淆：独立表、独立命令，场景不复制快照（窗口几何经关联现场间接恢复）",
    ],
    missingFeatures: [
      "「退出场景」动作：关闭/回收由本次进入启动的应用集合（当前取消只阻止未执行项，不回滚已启动项）",
      "场景专属设置与任务关联（当前内容仅应用 / 网址 / 目录 / 现场 / 工作流 / 暂存引用）",
      "真机验收：多显示器、DPI、前台争用；取消/互斥/删除守卫已过真机通道 C（2026-11-08，隔离实例 + CDP，见 tmp/acceptance/scenario-enter-control/）",
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
    id: "core.dev-workbench",
    category: "core",
    title: "开发工作台",
    description:
      "以「当前开发任务」为核心的工作台：任务、Agent 状态、待处理事项、快速继续，以及开发现场 / 任务交接包 / 验收工作台。",
    detail:
      "面向 AI 辅助开发的任务优先布局：用户显式把一个开发任务设为「当前」，工作台集中展示它的关联 Agent 会话、工作现场与下一步动作；Agent 运行状态与需要处理的事项直接复用既有监控与行动中心数据（不建第二套事件系统）；最近待办任务及其现场支持一键恢复并逐项反馈真实结果。当前任务锚点是显式设置键（workbench_current_task），不按标题相似度自动绑定；Agent 完成一轮不改变任务状态，完成必须用户确认。Round 1（2026-11）新增：开发现场（当前项目 + 只读 Git 摘要，显式设置键 workbench_current_project）、任务交接包（12 节模板、敏感扫描、追加式版本）与验收工作台（派生状态 + 追加式验收记录，无更新/删除入口）。U2（2026-11-14）：交接包版本可绑定真实 Agent 会话（弱引用，服务端校验）；验收工作台列出该任务关联会话中已完成的 Agent 轮次供人工登记结论，Agent 完成仍不自动改变任务状态或验收结果。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "完整模式「工作台」入口（默认可见、不占 Ctrl+数字）与四区域任务优先布局",
      "当前开发任务：显式设置/清除/失效如实展示，关联 Agent 会话与工作现场聚合展示（复用 task_context）",
      "继续工作：有现场则一键恢复（逐项回执），无现场但有关联会话则定位真实会话（外部 ID，失败如实回执），否则打开任务上下文",
      "Agent 运行摘要：等待/失败/运行/断连/最近完成计数 + 需关注会话一键定位；只统计真实上报事件，不把已安装推断为在线",
      "需要处理：行动中心 intervention 分区 + 当前任务未读重要提醒（同一数据源，消费者门控已纳入工作台）",
      "快速继续：最近待办 + 现场摘要 + 单项恢复与结果反馈",
      "工作台头部「快速记录」直接唤起既有快速捕获窗口（不要求先进任务页）",
      "任务卡与上下文抽屉「设为当前任务」；胶囊任务面板当前任务置顶条",
      "开发现场（Round 1）：显式选择开发项目（dev_project_*）+ 只读 Git 摘要（分支 / 未提交数 / worktree，非 ok 按状态降级），目录失效只显示徽标；胶囊任务面板当前项目 chip",
      "任务交接包（Round 1）：12 节固定模板（空节不输出）、任务/项目/验收标准初始预填（不覆盖已编辑内容）、敏感扫描（只显示位置与类型，不回传原文）、复制 Markdown、追加式版本记录",
      "交接包绑定 Agent 会话（U2，2026-11）：保存版本时可选择真实会话（身份为 source + external id，服务端校验存在），版本列表展示会话与被删除后的失效状态；不自动执行",
      "验收工作台（Round 1）：派生状态徽章（验收判定 > 功能状态 > 任务状态）、验收标准只读清单、手工证据登记、四个验收动作（summary 必填）、追加式历史记录（无更新/删除入口）、返工提示词与返工任务（仅最新判定为 fail 时）",
      "Agent 完成轮次待验收（U2，2026-11）：列出本任务关联会话（含交接包绑定会话）中已完成的真实轮次并标注来源；结论仍必须人工选择 verdict + summary，Agent 完成不会自动通过",
      "上下文抽屉「生成交接包」跨页入口：切到工作台并滚动定位交接区（复用 setTab 门禁）",
      "统一大型工作台宿主（U0，2026-11-14）：完整功能页已迁移到唯一 workspace 工作台窗口；胶囊 → 工作台导航带请求回执，工作台内「开发工作台」与「项目工作空间」同窗口路由，不再跨窗口跳转",
    ],
    missingFeatures: [
      "P1 Git 状态摘要补充：最近提交列表（当前只有分支 / 未提交数 / worktree 标记）",
      "P1 测试与构建结果归集（以真实执行记录为准，不用 Agent 文案冒充）",
    ],
    dependencies: [
      "task_agent_links / workspace_snapshots.task_id / task_reminder_links（既有任务关联数据）",
      "agent_snapshot + actions feed（既有监控与行动中心读模型）",
      "设置键 workbench_current_task / workbench_current_project（application_settings，随备份迁移）",
      "dev_project_* / dev_handoff_* / dev_acceptance_* 命令（Round 1 后端契约）",
    ],
    acceptanceCriteria: [
      "选择开发任务后，工作台首屏可见任务、下一步动作、Agent 状态与待处理事项",
      "Agent 真实上报 waiting 时，工作台与胶囊同步反映，可一键定位对应会话",
      "Agent 上报 completed 后任务保持原状态，由用户确认完成",
      "从最近任务恢复现场时，每个恢复操作反馈成功/失败/已在恢复中，不伪造成功",
      "旧任务、旧入口、胶囊与完整/极简/紧凑模式行为不受影响",
    ],
    verification: "unverified",
    entryPoints: [
      "统一工作台左侧导航「工作台」",
      "主窗口完整面板左侧导航「工作台」（兼容快捷入口）",
      "任务卡「设为当前任务」",
      "胶囊任务面板置顶条",
    ],
  },
  {
    id: "core.workspace-restore",
    category: "core",
    title: "工作现场恢复",
    description: "保存并恢复任务关联的工作环境：窗口、文件、网页与上下文。",
    detail:
      "围绕任务保存完整工作现场并在需要时恢复。现有实现基于身份元数据（窗口类名 + 标题 + EXE，不落 HWND），恢复时优先唤醒已有窗口、绝不重复启动，逐项给出验证级别与结果。v40 起快照条目保存窗口矩形/显示器/DPI，恢复时应用几何（同名显示器相对映射、断连时收敛到工作区、60% 可见安全网，逐项反馈 applied/converged/skipped/failed）；剩余缺口集中在浏览器多标签等细粒度恢复。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "保存现场：从任务关联目标一键捕获 / 手动勾选当前可见窗口，可命名多条",
      "恢复现场：串行恢复槽防并发、逐项执行、进度事件推送、恢复统计",
      "取消恢复：项间生效，剩余项如实记为 cancelled",
      "应用无法启动 / 路径失效时逐项失败标注（verification_level），不中断整体",
      "任务删除不销毁现场（降级为手动快照）；现场可与剪贴板素材互相关联",
      "窗口几何捕获与恢复（v40）：保存时记录矩形/显示器/DPI，恢复时映射或收敛，逐项 applied/converged/skipped/failed",
    ],
    missingFeatures: [
      "浏览器多标签页恢复（当前每个 URL 条目恢复为单个页面）",
      "可恢复的工作进度信息（如文档内位置、滚动状态）",
      "恢复前预览与逐项勾选确认",
      "几何恢复真机验收：多显示器断连/换序/DPI 变化的真实 SetWindowPos 落地未验证（确定性换算单测已覆盖）",
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
      "任务可关联一个场景或工作现场（任务上下文抽屉设置/清除），提醒通知提供「进入场景 / 恢复现场」动作——只在点击时执行，目标删除后动作随之消失",
    ],
    missingFeatures: [
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

  {
    id: "capture.clipboard",
    category: "core",
    title: "智能剪贴板",
    description: "采集文本、图片、文件与网址，自动分组历史，支持整组复制、逐项粘贴与 Agent 交接包。",
    detail:
      "剪贴板是本产品的高频核心能力，但此前目录只登记了「多类型查看器」这一个子能力，整体缺席。" +
      "本轮按代码与五轮验收证据补登为独立条目：三线程采集（平台层唯一入口 + 有界队列，丢弃计数）、" +
      "按内容哈希去重、来源应用/窗口/时间/大小、自动分组（默认 45s，可配 5–600s）、" +
      "历史检索与分页、整组富文本/文件复制、选择目标窗口后逐项粘贴（队列进度/取消/失败停止并报告）、" +
      "本机 OCR、任务关联与 Agent 导入包。图片落盘为独立资源，列表不传输二进制。" +
      "隐私侧：采集总开关、敏感标记与高置信特征过滤、来源未知时保守凭据模式、配置异常 fail-closed，" +
      "日志与事件不记录正文、完整图片、路径或密钥。已知边界：敏感过滤是启发式防线而非防泄漏产品；" +
      "采集仅在 Task Dock 运行时生效；分组与保留按本地配额执行，收藏条目不自动清理。" +
      "已知边界：超长历史的原生内存平台期、更多目标窗口的兼容性矩阵与长期运行稳定性尚无独立证据；当前 verified 仅覆盖已执行的五轮联合验收范围。",
    status: "implemented",
    priority: "P0",
    existingFeatures: [
      "采集纯文本、URL、HTML 富文本、截图/图片、文件列表（含多文件）与混合内容；内容哈希去重，重复复制只更新时间与使用次数",
      "来源信息：类型、时间、大小、来源应用与窗口标题、识别方式、预览；图片独立落盘",
      "自动分组：连续截图在默认 45s 窗口（5–600s 可配）归入同组，文字条目按发生顺序插入；支持重命名、重排、拆分、合并",
      "历史管理：正文/来源/文件名搜索、类型与收藏筛选、分页加载",
      "查看器：HTML 白名单只读阅读器、图片灯箱（缩放/平移/双击/另存为）、文件预览、URL 详情",
      "整组富文本或文件一键复制；选择目标窗口后逐项粘贴，带队列进度与取消，失败停止并报告；胶囊截图组复用同一状态机",
      "本机 Windows.Media.Ocr 按需识别图片文字，超时/像素/内存上限，缓存随条目清理失效",
      "条目或分组关联任务；导出 Markdown + 图片 + manifest 的本地 Agent 导入包，由用户自行交付，不自动发送",
      "隐私保护：总开关、系统/应用敏感标记、高置信特征过滤、保守凭据模式、配置异常 fail-closed，日志不含正文/图片/路径/密钥",
    ],
    missingFeatures: [],
    dependencies: [
      "剪贴板平台层（Win32 + 三线程有界队列）与图片资源目录",
      "Win32 前台窗口身份（来源应用/窗口标题，仅运行期）",
      "暂存架拖放与 copy switch 目标窗口链路",
    ],
    acceptanceCriteria: [
      "五类内容均可采集且去重后不丢历史",
      "自动分组窗口可配置，分组重排/拆分/合并后顺序正确",
      "逐项粘贴在失败时停止并保留可恢复状态，不重复粘贴",
      "重启后历史与图片可读，条目删除后图片资源随之回收",
      "敏感配置异常时停止采集而不是明文落库",
    ],
    verification: "verified",
    entryPoints: [
      "完整工作台左侧导航「剪贴板」",
      "胶囊剪贴板面板与截图组",
      "条目详情内的任务关联与 Agent 导出",
    ],
  },
  {
    id: "core.app-launcher",
    category: "core",
    title: "应用启动与窗口切换",
    description: "扫描本机应用、登记导航目标，按四级导航启动软件并尽量唤醒原窗口、工作区或会话。",
    detail:
      "Task Dock 的启动器本体此前只在 README 与导航矩阵中维护，路线图缺席。" +
      "已实现：从开始菜单、卸载注册表、常见安装路径与 UWP 目录发现应用并合并去重，读取真实图标；" +
      "胶囊应用网格支持拖动/Alt+方向键排序与连续添加；导航目标可登记应用、文件、目录、网页与 Agent 会话；" +
      "四级导航按「启动软件 → 唤醒已有窗口 → 打开工作区/目录 → 恢复会话」逐级尝试，只在目标 Agent 有公开接口时启用，" +
      "否则如实降级并标注；工作现场快照可批量启动一组目标并逐项反馈。" +
      "登记为 partial 的原因是可验证边界而非入口缺失：L3 仅对提供 CLI 目录参数的 Agent 尝试且未逐项核验帮助文本，" +
      "L4 目前以 Codex 为主要验证对象，多窗口应用无法精确锁定原实例，未登记应用不进入应用搜索。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "本机应用扫描：开始菜单 / 卸载注册表 / 常见安装路径 / UWP 目录合并去重，读取真实图标",
      "胶囊应用网格：拖动或 Alt+左右方向键排序、顺序本机持久化、连续添加与自动触发扫描",
      "导航目标：应用、文件、目录、网页、Agent 会话；收藏项优先出现在胶囊「应用」面板",
      "四级导航：启动软件 → 唤醒已有窗口 → 打开工作区/目录 → 恢复会话，逐级按真实接口能力降级并标注",
      "批量启动：工作现场快照保存一组导航目标，按序启动并逐项反馈成功/跳过/失败，可取消未执行项",
    ],
    missingFeatures: [
      "L3「打开工作区」仅对提供 CLI 目录参数的 Agent（Trae / Qoder 等）尝试，属约定推断，未逐项核验帮助文本",
      "L4「恢复会话」以 Codex 为主要验证对象（codex resume），其他 Agent 仅按运行时探测动态启用",
      "同一应用多窗口时只能唤醒其中一个窗口，无法精确锁定原实例",
      "未登记应用不参与应用搜索与统一网格",
    ],
    dependencies: [
      "统一导航 nav_navigate 链路",
      "Win32 窗口身份匹配（HWND/PID 仅运行期）",
      "Agent 适配器的会话恢复能力声明",
    ],
    acceptanceCriteria: [
      "扫描结果去重且图标真实，不出现占位图",
      "四级导航每一级的结果可解释，缺接口时如实降级而不是报成功",
      "批量启动逐项反馈并可取消未执行项",
      "多窗口应用不误唤醒无关进程",
    ],
    verification: "unverified",
    entryPoints: [
      "胶囊「应用」面板与网格",
      "完整工作台左侧导航「应用」",
      "工作现场恢复中的批量启动",
    ],
  },

  // ─── 工作台与专业创作 ────────────────────────────────────────────────
  {
    id: "workbench.unified",
    category: "workbench",
    title: "统一大型工作台",
    description: "胶囊、快捷工具面板与独立大型工作台三层形态，统一承载全部完整功能页与专业模块。",
    detail:
      "U0（2026-11-14）已把完整功能页迁到唯一的大型工作台窗口（workspace.html），" +
      "与胶囊常驻入口、快捷键工具面板（CompactView）形成三层职责，极简悬浮（MinimalView）保留：" +
      "胶囊负责唤起与状态，工具面板负责短流程，大型工作台负责完整页面。" +
      "统一导航直接复用 navigationRegistry 与 navVisibility，不维护第二份入口清单；" +
      "工作台外壳布局用版本化协议 workbench_layout 恢复上次路由、当前项目、右栏显隐与分栏宽度；" +
      "模块启停由 ModuleRunControl + useLifecycleStore 串行管理，意图写回 SQLite 设置，胶囊/设置/资源管理共享同一份状态；" +
      "专业模块接入协议为「tabs 注册 → 工作台路由；workspaceProfiles 声明类型/模块/能力；仅工作台可见的页面标 workbenchOnly」。" +
      "注意：本条目是产品架构，不等于某个具体开发工作台（后者见 core.dev-workbench）。" +
      "2026-11-15 的 20 路由验收矩阵结论为部分通过（Windows 原生通道未执行），因此验证状态保持 unverified。",
    status: "implemented",
    priority: "P0",
    existingFeatures: [
      "三层形态：胶囊常驻入口 / 快捷工具面板（CompactView）/ 独立大型工作台（workspace.html）；极简悬浮（MinimalView）保留",
      "唯一大型工作台窗口承载 20 条路由（工作台首页 + 19 个逻辑页），普通装饰、任务栏可见、可缩放并记忆几何",
      "统一导航：左侧导航与胶囊共用 navigationRegistry + navVisibility 配置，不另建入口数组",
      "跨页面状态恢复：workbench_layout 版本化协议恢复上次路由、当前项目、右栏显隐与分栏宽度，非法字段逐项回默认",
      "模块状态管理：ModuleRunControl + useLifecycleStore 串行暂停/恢复，意图写回 SQLite 设置，多入口同步",
      "专业模块接入协议：tabs 注册 → 工作台路由；workspaceProfiles 声明类型/模块/能力；仅工作台页面用 workbenchOnly 标记",
      "每个路由有独立 RouteBoundary，单页异常不拖垮外壳；关闭工作台不影响胶囊",
    ],
    missingFeatures: [],
    dependencies: [
      "workspace.html 独立窗口与工作台路由契约（workbenchRoutes）",
      "navigationRegistry / navVisibility 统一入口清单",
      "workbench_layout 设置键（ALLOWED_KEYS 已登记）",
    ],
    acceptanceCriteria: [
      "三层形态职责可区分：胶囊不展开完整页，工具面板不承载长流程",
      "20 条路由均可从工作台导航到达并正确渲染",
      "关闭重开工作台后恢复上次路由、项目、右栏状态与分栏宽度",
      "单个页面异常不影响其他路由与窗口外壳",
    ],
    verification: "unverified",
    entryPoints: [
      "胶囊轨道「工作台」入口",
      "托盘 / 右键菜单「完整模式」",
      "独立工作台窗口（workspace.html）",
    ],
  },
  {
    id: "workbench.projects",
    category: "workbench",
    title: "专业项目工作空间",
    description: "跨工具的长期工作容器：五种项目类型、事项与阶段、任务/文件关联、项目状态恢复。",
    detail:
      "项目工作空间不是任务、场景或现场快照的替代品：它是以弱引用串联这些对象的长期容器，" +
      "不移动、不删除、不复制外部文件（v49 数据模型，v57 扩展五种类型，v58 增加小说卷/章）。" +
      "已实现项目 CRUD/归档/删除、事项与阶段树、任务弱关联、暂存条目弱关联、开发型复用 dev_projects 的 Git 只读摘要与 Agent 快照、" +
      "每个项目独立窗口状态（active_module / layout_json / last_opened_at）以及胶囊/导航/工作台三层入口。" +
      "类型差异由 workspaceProfiles 静态声明驱动：导航标题、首页卡片、能力四态（available/limited/planned/unavailable）不同，" +
      "未接入的能力不渲染可点击入口；未知类型回落 general。" +
      "登记为 partial 的真实缺口：core.layout 只写回「上次所在模块」，模块排序/隐藏无编辑入口；" +
      "项目级笔记、Agent 会话与产物关联尚未接入；游戏/漫剧的专业资源与构建流程、小说人物/世界观/AI 辅助均在各自条目中待补；" +
      "没有项目进度/健康度字段，首页不画进度；没有跨设备项目同步与项目级交接包。",
    status: "partial",
    priority: "P0",
    existingFeatures: [
      "项目实体 CRUD / 归档 / 删除：kind 限定 development / game / ai_comic / general / novel；root_path 只登记不写入；删除不删外部文件、任务或开发项目",
      "事项与阶段树：workspace_items 自引用 parent_id、状态轮转与 metadata，承载集数、镜头、角色、构建、测试、问题等阶段",
      "任务弱关联（workspace_task_links）与暂存条目弱关联（shelf_project_links），只建引用，不复制内容",
      "开发型复用 dev_projects：Git 只读摘要、Agent 快照、验收入口跳转，不建第二套开发工作台",
      "每项目独立窗口状态 workspace_instances（active_module / layout_json / last_opened_at），三种入口可打开同一项目页",
      "能力声明注册中心 workspaceProfiles：四态能力、首页卡片、推荐工具；未接入能力不渲染可点击入口",
      "项目、事项、任务关联、暂存关联均进入备份表清单",
    ],
    missingFeatures: [
      "core.layout 只有「上次所在模块」会被写回，模块排序与隐藏尚无编辑入口",
      "项目级笔记、Agent 会话与产物关联未接入（当前只有任务、暂存、开发项目弱引用）",
      "项目进度/健康度字段缺失，首页无法显示项目进度条",
      "游戏/漫剧的资源索引、构建登记、角色/素材库与生成流程仍待各自工作台补齐",
      "跨设备/移动端项目同步与项目级交接包未实现",
      "多显示器/DPI 与项目切换并发的真机走查未执行",
    ],
    dependencies: [
      "workspace_* 迁移 v49 / v57 / v58（已发布不可修改）",
      "统一大型工作台窗口与 workbenchLayout 路由",
      "dev_projects、agents AgentHub 快照、shelf_project_links",
    ],
    acceptanceCriteria: [
      "五种类型的导航标题、首页卡片与可用动作确实不同",
      "删除项目只删除登记与本地元数据，不删除仓库、文件、任务或开发项目",
      "重启后恢复每个项目的当前模块",
      "未接入能力没有可点击的假入口，边界文案与能力状态一致",
      "归档/恢复/删除后项目列表与工作台状态一致",
    ],
    verification: "unverified",
    entryPoints: [
      "完整工作台左侧导航「工作空间」",
      "胶囊轨道项目按钮（打开/唤醒工作台项目页）",
      "统一工作台内的项目模块",
    ],
  },
  {
    id: "workbench.files",
    category: "workbench",
    title: "多目录文件工作区",
    description: "单窗口多目录、可嵌套分栏的文件工作台，面向跨目录整理、批量搬运与项目资料查看。",
    detail:
      "文件工作区是独立于「文件暂存架」的常驻工作台：暂存架负责跨会话收纳，文件工作区负责对真实目录做多窗格浏览与操作。" +
      "分割树模型为递归结构：窗格 ≤ 12、树深 ≤ 6、每窗格标签 ≤ 12，超限归一化裁剪而不白屏；" +
      "支持横向/纵向分栏、四方向新分栏、布局持久化与恢复（设置晚到会补恢复，避免空布局覆盖已存布局）。" +
      "文件操作走真实文件系统：复制/移动（F5/F6 与右键「复制到/移动到」）、重命名、新建、粘贴、回收站删除与永久删除（独立确认）、" +
      "隐藏文件开关；同窗格/跨窗格拖拽与外部 OS 拖入共用 fileDrop 仲裁，外部来源默认复制、不删源文件；" +
      "同名冲突整批只弹一次并统一策略，冲突检测失败时中止而不是静默改名覆盖。" +
      "进阶工具已接入同一面板：多目录联合搜索、批量重命名、目录对比、快速预览与重复文件查找（大小预筛 + 显式哈希，删除二次确认）。" +
      "边界：不做 Windows 资源管理器的替代品（不接管 Shell 命名空间/文件关联），页面级页头与缩略图、真实拖拽和回收站尚未完成原生真机验收。",
    status: "implemented",
    priority: "P0",
    existingFeatures: [
      "单窗口多目录：递归分割树，横向/纵向分栏，最多 12 窗格、树深 6，每窗格最多 12 标签",
      "自由打开目录：原生选择器 / 手输路径 / 最近 / 固定 / 项目根，落点支持新标签、替换当前目录与四方向新分栏",
      "布局保存与恢复：树形、标签、视图、排序与搜索状态持久化；设置晚到补恢复，损坏/超限安全回退",
      "标签管理与窗格交换/拖动排序，窗格间导航状态互不影响",
      "文件操作：复制/移动、重命名（F2）、新建、粘贴、删除（回收站/永久删除独立确认）、隐藏文件",
      "拖拽移动/复制：同窗格与跨窗格、外部 OS 拖入（复制语义，不删源文件），取消通道覆盖 Esc/失焦/离开窗口",
      "批量冲突处理：整批一次决策并统一策略；冲突检测失败中止，不静默覆盖",
      "多目录联合搜索：按所选窗格递归，支持扩展名/类别/修改时间过滤，深度、结果与目录数均有上限，可中止并标记截断",
      "批量重命名：前缀/后缀/替换/删除/序号/大小写，预览拦截非法名、重复目标与已存在目标，后端逐项校验执行",
      "目录对比：双目录差异（仅左/仅右/类型/大小/时间/哈希）与复制方向确认，默认不删除",
      "快速预览：Space 打开图片/视频/音频/文本代码，方向键切换；媒体走短期 token + Range，不扩大 asset 协议",
      "重复文件查找：大小预筛 + 显式 SHA-256 确认，组内保留项校验后才进回收站，默认只报告",
      "文件类型差异化：类型图标、图片/视频缩略图（并发 ≤3、有界缓存）、列表/网格视图",
      "批量选择、全选、搜索与排序（目录优先），空态/加载态/读取失败分别呈现",
    ],
    missingFeatures: [],
    dependencies: [
      "文件系统命令（列目录、复制/移动、回收站、重命名）",
      "fileDrop 仲裁（priority 20 > 暂存架 10）",
      "settings store 与布局持久化协议",
    ],
    acceptanceCriteria: [
      "分栏/标签超限时归一化而不白屏",
      "跨窗格拖拽只执行一次操作，取消不产生文件变更",
      "同名冲突按选定策略统一应用，失败可解释",
      "重启后恢复布局与各窗格目录/标签",
      "外部拖入默认复制，不删除用户源文件",
    ],
    verification: "unverified",
    entryPoints: [
      "统一工作台左侧导航「文件工作区」（workbenchOnly）",
      "其他模块 / Agent 通过 openFilesWorkspacePath 显式打开目录",
    ],
  },
  {
    id: "create.novel",
    category: "workbench",
    title: "小说创作工作台",
    description: "小说项目内的卷→章树、纯文本正文编辑、自动保存与字数统计，向人物/世界观/AI 辅助演进。",
    detail:
      "B1（2026-11-15/16，迁移 v58）已把小说从「只有项目类型」推进到可用编辑器：" +
      "node novel_volumes / novel_chapters 两级结构，章节可挂在卷下或作为未分卷章节；" +
      "内置纯文本编辑器支持新建/重命名/删除章节、自动保存、字数统计，单章正文上限 8 MiB；" +
      "项目还复用工作空间的概览、写作事项、任务关联与项目设置模块。" +
      "这是真实可用的基础编辑能力，不是完整专业创作闭环：人物档案、世界观、大纲、版本历史、导入导出、全文搜索与 AI 辅助均未接入，" +
      "对应能力在 workspaceProfiles 中登记为 planned，UI 不渲染生成/续写按钮。" +
      "B1 验收报告结论为部分通过：自动化与预览通道通过，原生窗口长篇输入走查未执行。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "小说项目类型（v57）与独立「正文」模块：概览 / 正文 / 写作事项 / 任务关联 / 项目设置",
      "卷→章树：卷与章的增删改、排序、未分卷章节归属",
      "章节正文纯文本编辑、自动保存与字数统计；单章 8 MiB 上限，保存失败可重试",
      "小说卷/章数据进入备份表清单，恢复后正文与结构保留",
      "首页只展示真实数据，planned 能力（人物/世界观/AI 辅助）不渲染可点击入口",
    ],
    missingFeatures: [
      "人物档案、关系与出场章节（novel.characters 仍为 planned）",
      "世界观设定集与引用关系（novel.worldview 仍为 planned）",
      "AI 创作辅助：续写、改写、灵感提示（需独立授权与上下文装配，novel.aiAssist 仍为 planned）",
      "大纲/章节梗概与结构视图",
      "版本记录、历史对比与撤销",
      "Markdown/富文本、导入导出（TXT/Word）与全文搜索",
      "长篇连续写作的原生真机走查与性能基线",
    ],
    dependencies: [
      "迁移 v58（novel_volumes / novel_chapters）与 workspace_projects novel kind",
      "workspaceProfiles 能力注册表与备份表清单",
      "后续人物/世界观需要新表与迁移（append-only）",
    ],
    acceptanceCriteria: [
      "创建卷/章并保存正文，重启后结构、正文与字数一致",
      "超过 8 MiB 时给出可解释错误且不丢已有正文",
      "删除章节/卷只影响本项目数据，不影响其他项目",
      "未接入的 AI/人物/世界观能力不出现可点击的假入口",
    ],
    verification: "unverified",
    entryPoints: [
      "工作空间 → 新建「小说」项目 →「正文」模块",
      "完整工作台左侧导航「工作空间」",
    ],
  },
  {
    id: "create.game",
    category: "workbench",
    title: "游戏开发工作台",
    description: "游戏项目类型、制作事项/阶段与任务关联；资源、构建与引擎流程仍待接入。",
    detail:
      "游戏项目已具备真实容器能力：kind=game 的专用导航（概览 / 制作事项 / 任务关联 / 设置）与首页卡片，" +
      "以 workspace_items.stage 承载关卡、系统、美术等制作阶段，事项树、状态轮转与任务弱关联均复用工作空间层。" +
      "尚未接入的能力在 workspaceProfiles 中如实登记：game.assets（资源关联）与 game.build（构建与测试）为 planned，" +
      "UI 不显示可点击的构建按钮，避免假成功。当前没有游戏设计文档、角色/场景库、引擎跳转、构建产物登记、测试计划与缺陷跟踪，" +
      "也没有面向游戏项目的 Agent 上下文装配。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "游戏项目类型与专用导航/首页（概览 / 制作事项 / 任务关联 / 设置）",
      "制作事项：用事项阶段字段记录关卡、系统、美术等制作阶段，支持事项树、状态轮转与排序",
      "任务弱关联：关联既有任务，不复制任务内容",
      "项目归档 / 删除 / 恢复与备份；删除不触碰外部资源目录",
      "未接入的资源关联与构建能力不渲染可点击入口",
    ],
    missingFeatures: [
      "游戏设计文档（GDD）与模板",
      "角色、场景、关卡与资源库/导入适配器",
      "构建与测试流水线（Unity / Unreal / 自研脚本）及结果回传",
      "版本与构建产物登记、引擎跳转",
      "测试计划、缺陷跟踪与验收入口",
      "游戏项目上下文装配与 Agent 协作",
    ],
    dependencies: [
      "workspace_items.stage（已具备）",
      "资源索引与构建适配器（未接入）",
      "项目工作空间的类型 Profile 与备份表清单",
    ],
    acceptanceCriteria: [
      "创建游戏项目后可记录关卡/系统制作阶段并关联任务",
      "未接入构建/资源能力时没有可点击的假入口",
      "接入构建后能回传成功/失败与产物路径，失败可解释",
      "删除项目不影响仓库与美术资源",
    ],
    verification: "unverified",
    entryPoints: [
      "工作空间 → 新建「游戏」项目",
      "完整工作台左侧导航「工作空间」",
    ],
  },
  {
    id: "create.ai-comic",
    category: "workbench",
    title: "AI 漫剧工作台",
    description: "漫剧项目类型、剧集/镜头事项与任务关联；剧本、分镜元数据、素材与生成流程仍待接入。",
    detail:
      "AI 漫剧目前是「项目入口 + 基础数据结构」，不是完整制作流水线：" +
      "kind=ai_comic 的专用导航为概览 / 剧集与镜头 / 任务关联 / 设置；" +
      "comic.episodes 与 comic.shots 为 limited —— 剧集与镜头用事项阶段承载，没有独立剧集表、分镜画幅/时长/台词等元数据，" +
      "镜头顺序仅按 sortOrder 线性展示；comic.characters 与 comic.assets 为 planned，comic.generate 为 unavailable，" +
      "首页明确标注计划中且不渲染上传/生成按钮。当前没有剧本管理、镜头与场景关联、角色设定/参考图库、素材与生成产物库、" +
      "版本比较与采用、制作流程看板与 Agent 协作。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "AI 漫剧项目类型与「剧集与镜头」专用导航（概览 / 剧集与镜头 / 任务关联 / 设置）",
      "用事项阶段 episode / shot 承载剧集拆分与镜头清单，支持线性排序与状态轮转",
      "项目事项树、任务弱关联、归档/删除/备份",
      "首页只列 planned/unavailable 能力，不出现上传或生成按钮",
    ],
    missingFeatures: [
      "剧本/台本管理与版本",
      "分镜元数据（景别、画幅、时长、台词）与镜头-场景关联",
      "角色设定、关系与参考图库",
      "素材库与生成产物登记、导入",
      "图像/视频生成管线接入与失败恢复",
      "版本比较、采用与回滚",
      "制作流程看板与 Agent 协作",
    ],
    dependencies: [
      "workspace_items.stage（已具备，但只是阶段占位）",
      "独立的剧集/镜头/角色/素材数据模型（未设计）",
      "生成管线与产物存储（未接入）",
    ],
    acceptanceCriteria: [
      "创建漫剧项目后可拆分剧集与镜头并关联任务",
      "未接入生成能力时不显示可点击的生成入口",
      "接入分镜元数据后镜头顺序、画幅与时长可稳定保存",
      "生成失败可解释且不产生半成品引用",
    ],
    verification: "unverified",
    entryPoints: [
      "工作空间 → 新建「AI 漫剧」项目",
      "完整工作台左侧导航「工作空间」",
    ],
  },

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
      "系统级拖出：按住卡片拖到资源管理器/其他应用（OLE DoDragDrop + CF_HDROP）；引用文件允许 Windows 默认复制/移动，托管副本只复制",
      "删除条目不误删剪贴板/原文件；复制路径 / 复制文件（CF_HDROP）/ 所在文件夹作为键盘与回退入口",
    ],
    missingFeatures: [
      "真机拖入验收（无头环境不可模拟 OS 拖放，待真机复验）",
      "暂存架侧的场景归属展示与筛选（当前只有场景编辑器单向关联，暂存架看不到被谁占用）",
    ],
    dependencies: ["独立托管目录与配额策略", "Tauri 拖放事件（拖入）", "Windows OLE DoDragDrop/CF_HDROP（拖出）"],
    acceptanceCriteria: [
      "剪贴板历史与暂存架数据互不混淆",
      "暂存文件可拖出到资源管理器",
      "过期清理可配置且清理前有确认",
    ],
    verification: "unverified",
    entryPoints: [
      "完整工作台左侧导航「收集与暂存」→「暂存架」",
      "外部文件 / 文件夹 / 图片 / 链接拖入暂存架",
    ],
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
    entryPoints: ["全局 Ctrl+Shift+F 搜索弹窗"],
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
    entryPoints: ["任务页新建重复任务（以重复规则承载）", "任务卡完成 / 延后（现有任务操作）"],
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
    entryPoints: ["设置 → Agent 接入 → Codex 会话钩子", "Agent 会话详情「恢复会话」（codex resume）"],
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

  {
    id: "agent.builtin",
    category: "agent",
    title: "内置 Agent：目标推进与任务接续",
    description: "在 Task Dock 内部持续执行目标、拆解任务、跨会话接续工作现场，而不只是观测外部 Agent。",
    detail:
      "这是长期方向，当前没有内置执行循环，因此登记为 planned：" +
      "Agent 行动中心只聚合外部 Agent 的需介入状态，MCP Server 只让外部客户端读写规划数据，" +
      "开发工作台只提供任务锚点与快速继续入口，三者都不能等同于完整内置 Agent。" +
      "本条目定义的目标是「目标的持续推进、任务的接续、工作现场的恢复」：" +
      "用户给出目标后由 Task Dock 拆解为可执行任务，按计划推进，跨会话恢复上下文，" +
      "在执行受阻或需要危险操作时请求人工审批，最终以可复核证据判定完成。" +
      "现有可复用的地基：Agent 事件有界管线与适配器、工作现场快照/恢复、任务与项目数据模型、Agent 导入包与验收工作台；" +
      "缺少的是执行循环、状态机、审批策略与完成判定本身。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "长期目标与关键结果管理（目标拆解、依赖、优先级）",
      "可持续的执行循环（计划 → 执行 → 验证 → 复盘），不是一次性会话",
      "任务中断恢复与工作现场接续（跨重启、跨窗口、后续跨设备）",
      "多 Agent 分工、交接与冲突仲裁",
      "执行结果归集、进度追踪与风险发现",
      "人工审批策略（权限分级、危险动作确认、可撤销）",
      "完成判定与失败重试策略（以证据而非自述为准）",
    ],
    dependencies: [
      "Agent 事件管线 + 各适配器（提供状态与动作回执）",
      "工作现场快照/恢复与任务、项目数据模型",
      "审批、权限与审计模型（尚未设计）",
      "内置执行器与调度器（尚未设计）",
    ],
    acceptanceCriteria: [
      "目标可拆解为任务并保留依赖关系",
      "进程重启后任务从断点继续，不重复执行已确认步骤",
      "危险动作在执行前进入人工审批，拒绝后状态可回退",
      "完成判定有可复核证据，未达条件不标记完成",
      "多 Agent 交接不丢上下文，冲突有明确仲裁结果",
    ],
    verification: "unverified",
  },
  {
    id: "agent.relay",
    category: "agent",
    title: "Relay Agent 集成",
    description: "与独立 Relay 中转服务协作，实现 Agent 间通信、任务交接与执行结果回传。",
    detail:
      "Relay 是独立的中转与协作方向，当前只有预研文档（docs/RELAY_INTEGRATION.md，2026-11-14），" +
      "仓库中没有 Relay 服务端、客户端连接器或协议实现，因此登记为 planned，不能把 MCP Server 的已有能力冒充为 Relay 集成。" +
      "职责边界：MCP Server 是外部客户端读写 Task Dock 规划数据的本地接口；Relay 负责 Agent 之间的消息路由、任务交接与结果回传，" +
      "两者信任模型、生命周期与失败语义不同，不合并。立项前必须先确定协议、身份与权限模型、幂等与失败恢复策略，" +
      "以及与行动中心/任务系统的边界，缺少安全设计与验收方案时不得直接排期。",
    status: "planned",
    priority: "P1",
    existingFeatures: [],
    missingFeatures: [
      "Relay 协议与信任模型（消息格式、身份、授权）",
      "Task Dock 侧连接器：配对、鉴权、重连与断线补偿",
      "任务交接与执行结果回传（幂等、可追溯）",
      "失败恢复与重试策略（不重复执行、不丢结果）",
      "权限分级与审计日志",
      "与 MCP Server、Agent 行动中心的职责边界与去重",
    ],
    dependencies: [
      "Relay 独立立项与协议冻结",
      "TLS/身份与凭据存储（复用既有安全边界）",
      "任务/项目模型与 Agent 事件管线",
    ],
    acceptanceCriteria: [
      "交接任务在断线重连后不重复执行且结果可追溯",
      "未授权 Agent 无法读取或改写任务",
      "失败有明确回执与恢复路径，不静默丢弃",
      "MCP 与 Relay 的能力边界在文档与代码中一致",
    ],
    verification: "unverified",
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
      "已交付（v0.11，2026-11-08 第二轮收口）：src/help 教程注册中心（结构化 TS 正文，heading/paragraph/steps/tip/note/callout，零新依赖）" +
      "+ 8 分类 28 篇教程（24 verified / 1 needs_review / 3 draft），全部 zh 正文、en-US 全覆盖" +
      "（缺失时明确显示「暂无英文版」徽标并回退中文的回退 UI 由测试 fixture 保留验证），不伪称国际化完成；完整模式第 13 个 rail 入口（help，不占 Ctrl+数字）；" +
      "搜索（标题/关键词/正文）、分类浏览、最近浏览（上限 8）、文章头显示适用版本/最近更新/翻译状态；" +
      "相关功能跳转对 planned / blocked / hidden / 停用分别给出状态提示而非死链接；复制操作步骤；" +
      "npm run help:check 契约校验（19 用例 = registry-contract 13 + health 6，覆盖 featureId / routeId / 正文完整性 / " +
      "en 结构平行 / 核心功能覆盖 / 内容版本 / 操作契约版本），引用失效即报错；0 blocker。" +
      "ContextHelpButton（? 弹出轻量说明）已接入 8 个业务页面共 9 处；帮助中心与设置页均可重新打开首次引导。" +
      "剩余 warning 仅「在途源文件变化触发的人工复核提示」（mcp-authorization 届时转 verified）；" +
      "2026-11-16 复核：教程实际为 28 篇，其中 3 篇 draft（句式命令、开发工作台、能力导览）待人工界面核对。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "8 分类 28 篇教程（24 verified / 1 needs_review / 3 draft）+ 搜索 / 分类 / 最近浏览（上限 8）",
      "en-US 正文全覆盖；状态徽标：功能未实现 / 受阻 / 导航隐藏 / 停用 / 翻译缺失分别如实提示",
      "help:check 契约校验阻断引用失效（featureId / routeId / 翻译 / 版本 / 操作契约），当前 0 blocker",
      "第 13 个 rail 入口 + 从教程跳转实际功能 + 返回来源页面",
      "ContextHelpButton 已接入 Agent / 剪贴板 / 规划中心 / 设置（MCP 与备份）/ 暂存架 / 任务 / 场景 / 工作流编辑器 9 处",
      "帮助中心与设置页均提供「重新打开引导」入口；新增通知聚合 / 帮助中心 / 引导 / 微件 / 命令面板教程",
    ],
    missingFeatures: [
      "教程正文语义漂移无自动检测：契约层只校验引用/版本，不校验语义（2026-11-08 已人工复核 7 篇并按代码更正，如暂存架「剪贴板添加默认复制」过时表述）",
      "2 篇 draft 待人工界面核对：句式命令（help.quickstart.command-phrases）、开发工作台（help.tasks.dev-workbench）",
      "mcp-authorization 待相关契约源稳定后转 verified（当前保持 needs_review）",
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
  {
    id: "ux.command-palette",
    category: "workflow",
    title: "全局命令面板",
    description: "全局搜索弹窗内建命令层：键盘直达页面、新建与运行，命令与数据结果分组区分。",
    detail:
      "已交付（v0.11 第三轮）：不新建第二个弹窗、不建第二套索引——命令能力层挂在全局搜索弹窗" +
      "（Ctrl+Shift+F）内，命令组仅在「全部」分类展示；静态命令派生自导航注册表与设置分组元数据" +
      "（不复制第二份入口清单），动态实体（场景/工作流）弹窗打开时从既有 store 水合（加载失败静默降级为静态命令）；" +
      "动作白名单只含打开/跳转/新建草稿/运行工作流/进入场景，删除、覆盖、批量、停用类永不进面板" +
      "（EXECUTABLE_ACTION_KINDS 白名单 + 契约测试双重拦截）；运行工作流直接执行并复用工作流页单槽反馈，" +
      "创建提醒为草稿类导航（不静默写默认时间）；纯前端连续子串匹配（与数据搜索同口径），上限 12 条。" +
      "测试 59 用例（契约 19 + store 10 + 弹窗 8 等）；i18n 双语。剩余事项：独立快捷键未注册（共用 Ctrl+Shift+F）、" +
      "跳转子页并高亮的外部定位意图未做、真机双主题/窄窗走查未执行。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "全局搜索弹窗命令组：打开页面 / 新建任务 / 创建提醒 / 打开设置分组 / 进入场景 / 运行工作流",
      "静态命令派生自 NAV_ENTRIES 与 SETTINGS_SECTION_META；动态场景/工作流列表水合",
      "动作白名单 + 契约测试拦截危险操作；命令与数据结果分组区分",
    ],
    missingFeatures: [],
    dependencies: ["navigationRegistry（NAV_ENTRIES 唯一入口清单）", "settingsCategories", "useGlobalSearchStore", "overlayStack"],
    acceptanceCriteria: ["命令与数据搜索结果明确区分", "危险操作不能通过模糊命令执行", "空查询有默认命令列表且键盘可完成全部操作"],
    verification: "unverified",
    entryPoints: ["全局搜索弹窗（Ctrl+Shift+F）→ 命令组"],
  },
  {
    id: "ux.command-phrases",
    category: "workflow",
    title: "句式命令",
    description: "全局搜索内的确定性短语层：任务域只读查询与单步修改，帧表外零损失回退搜索。",
    detail:
      "已交付（2026-11-11）：不接模型、不做多轮——Rust 封闭帧表解析（完成 / 改期 / 优先级 / " +
      "本周完成 / 逾期 / 今日到期 / Agent 失败），时间复用 nlp.rs 既有确定性解析；候选与查询在数据库侧完成，" +
      "写意图最多 5 个未完成任务候选，第一次 Enter 只展示差异预览、第二次才落库，Esc 取消确认；" +
      "执行前复核状态（完成前若任务已完成则不反开），改期/优先级先读全量任务再只写目标字段，" +
      "不清空描述、提醒与重复规则。整句精确命中任务标题时回退普通搜索；帧表外说法同样回退，" +
      "由空输入示例与近似命中提示承担可发现性。独立于 commandRegistry 的第二通道（注册表白名单禁止写入，契约不变）。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "单步写句式：完成 / 改期 / 优先级（两段式确认 + 差异预览）",
      "只读查询：本周完成汇总、逾期任务、今日到期、失败的 Agent",
      "候选匹配在数据库侧完成（排除已完成，最多 5 条）；整句标题冲突与帧表外输入回退普通搜索",
      "执行安全：完成前状态复核；改期/优先级先取全量任务再局部更新",
    ],
    missingFeatures: [],
    dependencies: ["command_phrases.rs（帧表解析）", "nlp.rs（时间解析）", "任务命令与 task_analytics", "useGlobalSearchStore", "overlayStack"],
    acceptanceCriteria: [
      "帧表内句式给出候选或查询结果，帧表外与无法解析的时间回退普通搜索且不报错",
      "写意图必须二次确认，确认时展示将发生的差异",
      "执行只改目标字段，不清空描述、提醒与重复规则",
    ],
    verification: "unverified",
    entryPoints: ["全局搜索弹窗（Ctrl+Shift+F）→ 输入句式"],
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

  // ─── 设备、系统与数据 ────────────────────────────────────────────────
  {
    id: "mobile.companion",
    category: "system",
    title: "移动端伴随应用",
    description: "Android 伴随端：配对、任务/收集箱/笔记增量同步、文件互传、统一采集与主屏入口。",
    detail:
      "桌面端与手机端不是 UI 复制关系：手机端以本地 SQLite 为主，通过用户显式发起的局域网配对与桌面端同步，" +
      "并保留手机独有能力（系统分享接收、拍照/相册采集、语音速记、主屏小组件、快捷方式）。" +
      "已实现：扫码/深链配对（TLS-only + 叶证书 SPKI 指纹固定、缺指纹 fail-closed、设备列表与撤销）、" +
      "任务/收集箱/笔记双向增量同步（载荷加密、rev + outbox、字段级自动合并、冲突页、墓碑）、" +
      "文件互传 v1（双向分块加密、SAF 接收目录）、统一采集中心、系统分享（文本/图片/文件/多选）、" +
      "主屏小组件与工作台入口自定义、移动端本地任务/提醒/笔记/设置。" +
      "物理机证据（vivo V2323A，2026-11-09 / 11-13 / 11-14）覆盖配对、双向同步、文件互传、分享接收与采集；" +
      "但整体仍登记为 partial：后台自动同步只有设计（前台自动同步已落地），" +
      "没有 workspace_projects 项目空间同步与跨设备工作接续，没有 iOS 端，收集箱/笔记墓碑日志保留期清理未实现。",
    status: "partial",
    priority: "P1",
    existingFeatures: [
      "配对与连接：应用内扫码/深链、SPKI 指纹固定、TLS-only、连接测试、桌面设备列表与撤销、强停重启后配对保持",
      "任务同步：手动 pull/push、载荷加密、rev/outbox、冲突页与字段级自动合并、墓碑",
      "收集箱与笔记同步：笔记整篇双向、收集箱仅 inbox（handled 为墓碑）",
      "文件互传 v1：双向分块加密、SAF 接收目录、打开预览与删除清理",
      "统一采集中心：拍照/相册/文件/文本/语音速记，单事务保存到收集箱/任务/笔记，clientId 幂等，附件与实体稳定关联",
      "系统分享接收：text/图片/文件/多选，流式复制、上限与逐项失败隔离、签名去重",
      "主屏小组件 2×2 / 4×2、系统快捷方式、工作台入口自定义（两端隔离）",
      "移动端本地任务/重复任务/提醒/笔记/设置；SQLite 迁移与 outbox 同事务",
    ],
    missingFeatures: [
      "后台/自动同步仅完成设计（前台自动同步已落地），无 WorkManager 定期同步与系统级保活",
      "没有 workspace_projects / 专业工作台项目同步，跨设备工作接续未实现",
      "iOS 端未规划、未实现",
      "收集箱/笔记墓碑日志保留期清理未实现",
      "TLS v2 真机复验在无连接设备时未执行；部分厂商后台限制与图片分享取消空态未覆盖",
    ],
    dependencies: [
      "TLS + SPKI 传输层（协议 v2，fail-closed）",
      "桌面端 mobile_sync / 文件互传服务与设备身份表",
      "apps/mobile SQLite（v5）与 outbox 机制",
    ],
    acceptanceCriteria: [
      "配对后强停重启仍保持，撤销后立即拒绝访问",
      "双向同步在冲突时可解释，不静默覆盖任一端",
      "文件互传内容哈希一致，断线可续",
      "采集/分享落库幂等，重复提交不产生重复条目",
      "后台同步接入后不重复拉取、不无限轮询",
    ],
    verification: "unverified",
    entryPoints: [
      "完整工作台左侧导航「手机」",
      "Android 应用（配对后使用）",
    ],
  },
  {
    id: "mobile.virtual-display",
    category: "system",
    title: "Android 屏幕镜像与独立虚拟屏",
    description: "桌面端通过 ADB/scrcpy 启停镜像与独立虚拟屏会话，让不同 Agent 使用各自的手机工作界面。",
    detail:
      "2026-11-13 完成技术预研，2026-11-14 已交付实现：UI 在手机页「屏幕控制」，" +
      "命令层提供 vd_probe / vd_devices / vd_list_apps / vd_start / vd_stop / vd_sessions / vd_focus / " +
      "vd_screenshot / vd_screenshot_export / vd_diagnostics / vd_reconnect；" +
      "两种模式：mirror（与手机实体屏同画面）与 virtual（--new-display + --start-app，手机可继续使用自己的应用）。" +
      "会话有完整状态机（starting/running/stopping/stopped/error/disconnected）与阶段（process→display→app→video→ready），" +
      "不允许仅凭 PID 判成功；25s 无视频流转 error 并回收；停止先 WM_CLOSE，5s 有界等待后强杀，Job Object 兜底。" +
      "多屏实验默认关闭，开启后最多 2 个会话，同一设备+模式+应用只允许一个活动会话；" +
      "截图按用户点击触发，残留虚拟屏可诊断并重连清理。明确不做：自研编码/WebRTC、MediaProjection 冒充、root/刷机、自动装 APK、嵌入 Tauri 窗口、云端远控。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "屏幕镜像（mirror）与独立虚拟屏（virtual）共用同一 SessionManager，不另建投屏服务",
      "设备探测、去重与工具链定位（TASK_DOCK_ADB / TASK_DOCK_SCRCPY → PATH → 常见路径）",
      "会话状态机与阶段推进：启动超时、早退、断连、主动关闭分别给出可读状态",
      "应用选择与启动入口校验（cmd package query-activities）",
      "窗口定位（按会话 PID 找 scrcpy 顶层窗口并前置）、PrintWindow 截图、截图存暂存架/另存",
      "残留虚拟屏诊断（dumpsys display）与重连 ADB 清理",
      "多屏实验（默认关闭，开启后最多 2 个会话，每个会话独立关闭）",
      "运行期身份只存内存（serial/package/session 不写 SQLite、不新增设置键）；与自有 TLS 配对身份分离",
    ],
    missingFeatures: [],
    dependencies: [
      "adb / scrcpy 外部工具链（缺失时 fail-closed 并给出安装提示）",
      "Windows 进程与 Job Object 回收能力",
      "Android 设备的开发者选项与 USB 调试授权",
    ],
    acceptanceCriteria: [
      "启动 25s 内无视频流必须转 error 并回收，不显示假成功",
      "关闭只回收本进程创建的 scrcpy，不影响用户手动启动的实例",
      "强杀 Task Dock 后 Job Object 回收全部会话",
      "虚拟屏应用未启动时明确警告而不是宣称 ready",
      "同一设备+模式+应用不会出现两个活动会话",
    ],
    verification: "unverified",
    entryPoints: [
      "完整工作台左侧导航「手机」→「屏幕控制」",
      "会话列表中的定位 / 截图 / 诊断 / 关闭",
    ],
  },
  {
    id: "system.resources",
    category: "system",
    title: "资源管理与智能清理",
    description: "诚实的资源占用视图与可证明安全的清理：应用缓存、孤儿文件、用户级系统垃圾与进程诊断。",
    detail:
      "资源管理与系统资源监控分开：这里管理 Task Dock 自身的文件资源、可证明归属的缓存/孤儿文件，以及用户显式选择的系统垃圾，" +
      "不做常驻监控、不替代任务管理器。实现要点：预览只读、执行只接受服务端 previewId（5 分钟、一次性消费、最多 32 个）；" +
      "后端对每个候选重新校验根目录归属、文件身份、大小、修改时间与年龄，占用中或已变化的文件跳过；" +
      "应用缓存清理与用户级磁盘清理是两套独立能力，类别、扫描根、预览记录与作业闸都不共享；" +
      "与暂存架 producer/maintenance 互斥，Agent spool、备份恢复与其他无法证明可安全删除的文件不纳入扫描。" +
      "另有应用自身 CPU/内存/运行时长、系统内存、磁盘概览、只读进程诊断与可测量的应用内存缓存释放；所有采样由进入页面或手动刷新触发。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "应用缓存清理：TTS 缓存、超过 24h 的暂存架原子写入残留、确认无引用的剪贴板/暂存架缩略图（扫描/预览/清理）",
      "用户级磁盘清理：回收站、用户/系统临时文件、崩溃转储；默认不勾选，扫描只读，执行需二次确认",
      "安全删除：单次消费预览、根目录归属复核、文件身份/大小/时间/年龄复核、占用中跳过、父目录重命名防护、并发作业闸",
      "与暂存架维护互斥（producer/maintenance），不清理无法证明归属的目录",
      "资源占用分析：自身 CPU/内存/运行时长、系统内存、所在磁盘概览、应用数据占用分布",
      "只读进程诊断与可测量的应用内存缓存释放；非 Windows 平台如实提示不支持",
      "清理结果按类别报告保留项、失败原因与实际释放量；回收站清空按前后文件系统口径测量，失败显示「无法复核」",
    ],
    missingFeatures: [],
    dependencies: [
      "resource_cleanup 服务层（previewId / 作业闸 / 归属分级）",
      "fs_safety 与 audio/cache、shelf 维护互斥",
      "Windows Shell（回收站清空）与进程采样",
    ],
    acceptanceCriteria: [
      "未预览或预览过期时不能执行清理",
      "执行时文件已变化/被占用则跳过并如实报告，不按预览结果盲删",
      "应用缓存与用户级垃圾的删除范围互不扩大",
      "不清理 Agent spool、备份恢复等无法证明归属的文件",
      "清理失败不静默，保留可复核原因",
    ],
    verification: "unverified",
    entryPoints: [
      "完整工作台左侧导航「资源」",
      "设置 → 数据与资源 → 资源管理",
    ],
  },
  {
    id: "system.diagnostics",
    category: "system",
    title: "诊断中心",
    description: "脱敏诊断日志的异常聚合、操作链追踪、报告导出与清理，用于故障定位而非业务审计。",
    detail:
      "诊断日志绝不进入 SQLite，也不替代任何业务记录：清理诊断日志不影响任务、Agent 事件、剪贴板、工作流回执、备份与文件投递恢复记录。" +
      "链路：前端有界队列批量 IPC + Rust tracing Layer → 统一 DiagnosticEvent → 有界队列（1024）→ 单写线程 → JSONL 轮转/保留 + 指纹窗口聚合；" +
      "诊断中心是薄视图，查询/摘要/导出/清理全部复用 diagnostics* 命令，页面只在可见时请求一次，不做后台轮询。" +
      "两种查询模式：异常列表（最低 WARN）与按 operationId 的操作链（DEBUG/INFO 全量事件按时间升序）；读取失败显示失败原因并可重试，不把失败当空态。" +
      "清理需二次确认，CONFLICT/TIMEOUT 原样展示、不自动重试。入口默认隐藏在导航自定义中，可由用户显式开启。",
    status: "implemented",
    priority: "P2",
    existingFeatures: [
      "统一 DiagnosticEvent 字段与脱敏规则（不记录正文、路径、密钥）",
      "有界队列 + 单写线程 + JSONL 轮转/保留，异常按指纹窗口聚合",
      "诊断中心页面：异常列表、按 operationId 的操作链、级别/时间筛选、分页",
      "摘要统计、脱敏报告导出、打开日志目录、二次确认清理",
      "失败可解释（读取失败/冲突/超时分别展示），页面隐藏时丢弃在途响应",
      "设置页「诊断与日志」分级与详细日志开关",
    ],
    missingFeatures: [],
    dependencies: [
      "diagnostics 写入层与本地 JSONL 目录",
      "bridge.ts diagnostics* 命令与事件队列",
    ],
    acceptanceCriteria: [
      "关闭详细日志后不再写 DEBUG/INFO，但 WARN/ERROR 仍可定位",
      "操作链查询只按 operationId，不混入列表筛选条件",
      "导出报告不含正文、路径或密钥",
      "清理不影响任何业务表与备份",
      "读取失败不显示为空列表",
    ],
    verification: "unverified",
    entryPoints: [
      "完整工作台左侧导航「诊断中心」（默认隐藏，可在导航自定义开启）",
      "设置 → 诊断与日志",
    ],
  },
  {
    id: "system.backup",
    category: "system",
    title: "备份与恢复",
    description: "完整/快速备份、原子导出与可续跑恢复，覆盖业务表、设置、剪贴板图片与暂存文件。",
    detail:
      "备份基于流式 JSONL bundle + 完整性校验：完整备份覆盖 BACKUP_TABLES 登记的业务表（含 Clipboard / Shelf / Notes / Focus / Workflows / Planning）、设置、" +
      "剪贴板图片与暂存文件；快速备份按约定裁剪。用户偏好（语言、微件布局、应用网格排序）写入 preferences.json 随备份迁移，" +
      "旧备份缺字段时保留本机值而不是清空。恢复有状态机：异常退出可续跑或回滚，恢复点/manifest 版本参与兼容判断。" +
      "性能验收 P1-04 为 PASS（有边界）：100k 夹具 61.9MB 往返、真机 78.44MB 全量恢复 14.28s、25 表一致、21 个恢复故障测试；" +
      "多 GB 包、恢复非常量内存未测。",
    status: "implemented",
    priority: "P1",
    existingFeatures: [
      "完整 / 快速备份与导出；业务表、设置、剪贴板图片与暂存文件纳入同一 bundle",
      "恢复状态机：失败可续跑或回滚，异常退出的中间态可识别",
      "备份 manifest / 版本兼容校验与 BACKUP_TABLES 表清单",
      "用户偏好随 preferences.json 迁移，旧备份缺字段保留本机值",
      "恢复故障测试 21 项；100k 夹具 61.9MB 往返与真机 78.44MB 全量恢复 14.28s、25 表一致",
    ],
    missingFeatures: [],
    dependencies: [
      "BACKUP_TABLES 登记与迁移版本",
      "数据目录隔离（TASK_DOCK_DATA_DIR）与磁盘空间预检",
      "恢复状态机与备份 manifest 格式",
    ],
    acceptanceCriteria: [
      "完整/快速备份均可导出并在另一实例恢复",
      "恢复中断后可续跑或回滚，不留下半恢复状态",
      "旧版本备份恢复后缺失字段保留本机值",
      "敏感信息不进入备份 header 或可提交文件",
    ],
    verification: "verified",
    entryPoints: [
      "设置 → 数据与资源 → 备份与恢复",
      "托盘 / 设置中的快速备份入口",
    ],
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
