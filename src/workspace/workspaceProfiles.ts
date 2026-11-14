//! 工作空间 Profile / Capability 注册中心（P1-01，2026-11-13）。
//!
//! ## 为什么需要这一层
//! 上一轮四种工作空间类型只是同一个面板换个徽标：导航、首页、可用动作完全一样。
//! 本轮把「类型 → 导航 / 首页卡片 / 专业能力」收敛成**静态声明**，页面只消费声明，
//! 不再各自 `if (kind === ...)` 拼装。新增一种工作空间 = 在这里加一条 Profile，
//! 不改窗口状态机、不改项目数据接口。
//!
//! ## 两条硬规则
//! 1. **能力状态必须诚实**：`available` 只能给已接入且本轮可验证的实现；
//!    只有登记没有适配器的能力一律 `planned` / `unavailable`，UI 不得渲染可点击的
//!    「生成 / 构建」按钮，否则等于假装执行成功。
//! 2. **未知类型安全降级**：`resolveWorkspaceProfile` 对空值/旧版本/未知枚举回落到
//!    `general`，不抛错、不显示空白页；旧数据库里未来类型的登记仍可打开。
//!
//! 本模块是纯数据 + 纯函数（不依赖 React / Tauri / DOM），便于单测锁定
//! 「能力声明与真实实现一致」「四种类型的导航与首页不同」。

import type { WorkspaceKind } from "../lib/bridge";

/** 工作空间模块 ID：页面路由单位，Profile 决定顺序与标题。 */
export type WorkspaceModuleId = "overview" | "items" | "links" | "settings";

/** 稳定能力 ID（跨版本不可改名；新增能力只能追加）。 */
export type WorkspaceCapabilityId =
  | "core.project"
  | "core.items"
  | "core.taskLinks"
  | "core.layout"
  | "dev.project"
  | "dev.git"
  | "dev.agents"
  | "dev.acceptance"
  | "game.items"
  | "game.assets"
  | "game.build"
  | "comic.episodes"
  | "comic.shots"
  | "comic.characters"
  | "comic.assets"
  | "comic.generate";

/**
 * 能力实现状态（四态，互斥）：
 * - available：本轮已接入且可验证；
 * - limited：有部分实现，能力边界见 `fallback`；
 * - planned：只有登记，没有适配器；
 * - unavailable：本平台/本轮明确不提供（不是「以后再补」，而是当前不该有入口）。
 */
export type WorkspaceCapabilityState = "available" | "limited" | "planned" | "unavailable";

export interface WorkspaceCapability {
  id: WorkspaceCapabilityId;
  /** 用户可见名称（能力清单/降级提示用）。 */
  label: string;
  /** 一句话说明「做什么」。 */
  summary: string;
  state: WorkspaceCapabilityState;
  /** 真实实现提供者：写清楚复用了哪个既有系统，禁止写「内置」。 */
  provider: string;
  /** 可用条件（为空表示无额外条件）。 */
  condition?: string;
  /** 平台限制（为空表示全平台）。 */
  platforms?: Array<"windows" | "macos" | "linux">;
  /** 不可用/受限时的降级说明（UI 必须展示，不能静默隐藏）。 */
  fallback?: string;
  /** 可调用动作：只允许指向真实存在的入口。 */
  action?: { kind: "module" | "main-window" | "system-open"; target: string };
}

/**
 * 能力注册表：ID → 声明。
 *
 * `provider` 必须指向仓库里真实存在的实现层，写错等于给用户假承诺，测试会核对
 * 关键能力（见 `profiles.test.ts`）。
 */
export const WORKSPACE_CAPABILITIES: Record<WorkspaceCapabilityId, WorkspaceCapability> = {
  "core.project": {
    id: "core.project",
    label: "项目登记",
    summary: "工作空间项目与状态（进行中/已归档），数据在本地 SQLite。",
    state: "available",
    provider: "workspace_projects / workspace_project_*",
  },
  "core.items": {
    id: "core.items",
    label: "事项与阶段",
    summary: "项目内事项的增删、状态轮转与阶段标记，跨项目隔离。",
    state: "available",
    provider: "workspace_items",
  },
  "core.taskLinks": {
    id: "core.taskLinks",
    label: "任务关联",
    summary: "关联/解除关联既有任务；只建弱引用，不复制、不删除原任务。",
    state: "available",
    provider: "workspace_task_links + list_tasks",
    condition: "任务仍存在（被删除后关联行随数据库约束清理）",
  },
  "core.layout": {
    id: "core.layout",
    label: "模块布局持久化",
    summary: "每个项目独立保存当前模块与布局结构；损坏 JSON 安全回退默认布局。",
    state: "limited",
    provider: "workspace_instances.layout_json",
    // 诚实边界：解析器已支持 moduleOrder / hiddenModules，但当前 UI 没有排序/隐藏
    // 编辑器，只有 activeModule 会被用户操作写回。不能宣称「可自定义布局」。
    fallback: "当前只持久化「上次所在模块」；模块排序与隐藏尚无编辑入口，字段已预留且向后兼容",
  },
  "dev.project": {
    id: "dev.project",
    label: "开发项目与工作台",
    summary: "把工作空间项目关联到已登记的开发项目，并在主窗口开发工作台打开。",
    state: "available",
    provider: "dev_projects + DevWorkbench（复用既有开发工作台，不建第二套）",
    condition: "已关联 dev_projects 且登记未被删除",
    action: { kind: "main-window", target: "workbench" },
  },
  "dev.git": {
    id: "dev.git",
    label: "Git 只读摘要",
    summary: "按开发项目根目录探测分支与状态（只读，不执行写操作）。",
    state: "available",
    provider: "devwork::git::probe（dev_project_probe）",
    condition: "开发项目根目录存在且是 Git 仓库",
    fallback: "目录失效 / 非 Git 仓库 / 未安装 git 时只显示登记状态，不伪造分支",
  },
  "dev.agents": {
    id: "dev.agents",
    label: "Agent 运行状态",
    summary: "复用 AgentHub 实时快照展示运行/等待/失败计数（只读）。",
    state: "available",
    provider: "AgentHub::snapshot（agent_snapshot）",
    fallback: "主窗口未运行时快照可能为空，展示为 0 并注明来源",
  },
  "dev.acceptance": {
    id: "dev.acceptance",
    label: "验收入口",
    summary: "验收记录维护与结论展示在主窗口开发工作台。",
    state: "limited",
    provider: "dev_acceptance_records（主窗口验收工作台）",
    fallback: "本窗口只提供跳转，不在专业窗口内重复实现验收录入",
    action: { kind: "main-window", target: "workbench" },
  },
  "game.items": {
    id: "game.items",
    label: "制作事项",
    summary: "用事项的阶段字段承载关卡/系统/美术等制作阶段。",
    state: "available",
    provider: "workspace_items.stage",
  },
  "game.assets": {
    id: "game.assets",
    label: "游戏资源关联",
    summary: "资源库/资产管线登记。",
    state: "planned",
    provider: "未接入（本轮没有资源索引与导入适配器）",
    fallback: "不显示资源关联按钮；只在首页注明计划中",
  },
  "game.build": {
    id: "game.build",
    label: "构建与测试",
    summary: "调用 Unity/Unreal/自研构建脚本并回传结果。",
    state: "planned",
    provider: "未接入（没有构建适配器与产物登记）",
    fallback: "禁止渲染可点击的构建按钮，避免假成功",
  },
  "comic.episodes": {
    id: "comic.episodes",
    label: "剧集",
    summary: "用事项阶段（episode）承载剧集拆分。",
    state: "limited",
    provider: "workspace_items.stage=episode",
    fallback: "没有独立剧集表；集数统计来自事项阶段，改名/改阶段会改变统计",
  },
  "comic.shots": {
    id: "comic.shots",
    label: "镜头",
    summary: "用事项阶段（shot）承载镜头清单与进度。",
    state: "limited",
    provider: "workspace_items.stage=shot",
    fallback: "没有分镜/画幅元数据；镜头顺序按 sortOrder 线性展示",
  },
  "comic.characters": {
    id: "comic.characters",
    label: "角色参考",
    summary: "角色设定与参考图库。",
    state: "planned",
    provider: "未接入（没有图片资产库与角色档案）",
    fallback: "不显示上传/引用按钮",
  },
  "comic.assets": {
    id: "comic.assets",
    label: "素材关联",
    summary: "分镜素材与生成产物的关联。",
    state: "planned",
    provider: "未接入（没有产物登记）",
    fallback: "不显示素材入口",
  },
  "comic.generate": {
    id: "comic.generate",
    label: "生成工具",
    summary: "调用图像/视频生成管线。",
    state: "unavailable",
    provider: "本轮明确不提供（生成管线尚未接入工作空间）",
    fallback: "不显示生成按钮；需要生成请在既有创作工具中进行",
  },
};

/** 首页卡片形态：决定渲染哪些真实数据，避免每个类型复制一套页面。 */
export type WorkspaceCardBody =
  | "project"
  | "items"
  | "links"
  | "devProject"
  | "git"
  | "agents"
  | "acceptance"
  | "build"
  | "assets"
  | "progress"
  | "characters"
  | "generate";

export interface WorkspaceCard {
  id: string;
  title: string;
  body: WorkspaceCardBody;
  /** 关联能力；planned/unavailable 时卡片只显示状态说明，不渲染动作。 */
  capability: WorkspaceCapabilityId;
}

export interface WorkspaceModule {
  id: WorkspaceModuleId;
  label: string;
}

export interface WorkspaceProfile {
  kind: WorkspaceKind;
  label: string;
  /** 图标 token，由 UI 映射到 lucide 组件（保持本模块为纯数据）。 */
  icon: "code" | "gamepad" | "clapperboard" | "layers";
  /** 导航布局：顺序即渲染顺序；不同类型标题不同。 */
  modules: WorkspaceModule[];
  /** 旧项目没有布局配置时的默认模块。 */
  defaultModule: WorkspaceModuleId;
  /** 首页卡片（顺序即渲染顺序）。 */
  homeCards: WorkspaceCard[];
  /** 该类型声明具备的能力（未列出的能力即使在注册表里也不得调用）。 */
  capabilities: WorkspaceCapabilityId[];
  /** 推荐工具（纯文案，供首页提示，不自动执行）。 */
  recommendedTools: string[];
}

const DEV_MODULES: WorkspaceModule[] = [
  { id: "overview", label: "概览" },
  { id: "items", label: "开发事项" },
  { id: "links", label: "任务关联" },
  { id: "settings", label: "设置" },
];

const GAME_MODULES: WorkspaceModule[] = [
  { id: "overview", label: "概览" },
  { id: "items", label: "制作事项" },
  { id: "links", label: "任务关联" },
  { id: "settings", label: "设置" },
];

const COMIC_MODULES: WorkspaceModule[] = [
  { id: "overview", label: "概览" },
  { id: "items", label: "剧集与镜头" },
  { id: "links", label: "任务关联" },
  { id: "settings", label: "设置" },
];

const GENERAL_MODULES: WorkspaceModule[] = [
  { id: "overview", label: "概览" },
  { id: "items", label: "事项" },
  { id: "links", label: "任务关联" },
  { id: "settings", label: "设置" },
];

export const WORKSPACE_PROFILES: Record<WorkspaceKind, WorkspaceProfile> = {
  development: {
    kind: "development",
    label: "开发",
    icon: "code",
    modules: DEV_MODULES,
    defaultModule: "overview",
    homeCards: [
      { id: "dev-project", title: "开发项目", body: "devProject", capability: "dev.project" },
      { id: "dev-git", title: "Git 摘要", body: "git", capability: "dev.git" },
      { id: "dev-agents", title: "Agent 状态", body: "agents", capability: "dev.agents" },
      { id: "dev-acceptance", title: "验收入口", body: "acceptance", capability: "dev.acceptance" },
      { id: "dev-items", title: "开发事项", body: "items", capability: "core.items" },
      { id: "dev-links", title: "关联任务", body: "links", capability: "core.taskLinks" },
    ],
    capabilities: [
      "core.project",
      "core.items",
      "core.taskLinks",
      "core.layout",
      "dev.project",
      "dev.git",
      "dev.agents",
      "dev.acceptance",
    ],
    recommendedTools: ["在开发工作台打开", "打开开发项目根目录"],
  },
  game: {
    kind: "game",
    label: "游戏",
    icon: "gamepad",
    modules: GAME_MODULES,
    defaultModule: "overview",
    homeCards: [
      { id: "game-project", title: "游戏项目", body: "project", capability: "core.project" },
      { id: "game-items", title: "制作事项", body: "items", capability: "game.items" },
      { id: "game-build", title: "构建与测试", body: "build", capability: "game.build" },
      { id: "game-assets", title: "资源关联", body: "assets", capability: "game.assets" },
      { id: "game-links", title: "关联任务", body: "links", capability: "core.taskLinks" },
    ],
    capabilities: ["core.project", "core.items", "core.taskLinks", "core.layout", "game.items", "game.assets", "game.build"],
    recommendedTools: ["用阶段字段记录关卡/系统制作进度"],
  },
  ai_comic: {
    kind: "ai_comic",
    label: "AI 漫剧",
    icon: "clapperboard",
    modules: COMIC_MODULES,
    defaultModule: "overview",
    homeCards: [
      { id: "comic-project", title: "漫剧项目", body: "project", capability: "core.project" },
      { id: "comic-progress", title: "制作进度", body: "progress", capability: "comic.shots" },
      { id: "comic-characters", title: "角色参考", body: "characters", capability: "comic.characters" },
      { id: "comic-assets", title: "素材关联", body: "assets", capability: "comic.assets" },
      { id: "comic-generate", title: "生成工具", body: "generate", capability: "comic.generate" },
      { id: "comic-links", title: "关联任务", body: "links", capability: "core.taskLinks" },
    ],
    capabilities: [
      "core.project",
      "core.items",
      "core.taskLinks",
      "core.layout",
      "comic.episodes",
      "comic.shots",
      "comic.characters",
      "comic.assets",
      "comic.generate",
    ],
    recommendedTools: ["用事项阶段 episode / shot 记录剧集与镜头"],
  },
  general: {
    kind: "general",
    label: "通用",
    icon: "layers",
    modules: GENERAL_MODULES,
    defaultModule: "overview",
    homeCards: [
      { id: "general-project", title: "项目信息", body: "project", capability: "core.project" },
      { id: "general-items", title: "事项进度", body: "items", capability: "core.items" },
      { id: "general-links", title: "关联任务", body: "links", capability: "core.taskLinks" },
    ],
    capabilities: ["core.project", "core.items", "core.taskLinks", "core.layout"],
    recommendedTools: [],
  },
};

/** 未知/旧版本类型安全降级到 general（不抛错、不留空白页）。 */
export function resolveWorkspaceProfile(kind: string | null | undefined): WorkspaceProfile {
  if (kind && Object.prototype.hasOwnProperty.call(WORKSPACE_PROFILES, kind)) {
    return WORKSPACE_PROFILES[kind as WorkspaceKind];
  }
  return WORKSPACE_PROFILES.general;
}

/** 某类型实际声明的能力清单（按 Profile 顺序）。 */
export function capabilitiesFor(kind: string | null | undefined): WorkspaceCapability[] {
  const profile = resolveWorkspaceProfile(kind);
  return profile.capabilities.map((id) => WORKSPACE_CAPABILITIES[id]);
}

/**
 * 能力是否「可调用」：只有 available / limited 且状态允许时，UI 才渲染动作按钮。
 * planned / unavailable 永远返回 false —— 这是「不能假装执行成功」的代码级闸门。
 */
export function canInvokeCapability(
  kind: string | null | undefined,
  id: WorkspaceCapabilityId,
): boolean {
  const profile = resolveWorkspaceProfile(kind);
  if (!profile.capabilities.includes(id)) return false;
  const state = WORKSPACE_CAPABILITIES[id]?.state;
  return state === "available" || state === "limited";
}

/** 能力状态文案（四态必须可区分，不能都写成「可用」）。 */
export const CAPABILITY_STATE_LABEL: Record<WorkspaceCapabilityState, string> = {
  available: "可用",
  limited: "受限",
  planned: "计划中",
  unavailable: "未接入",
};

// ── 模块布局（layout_json 的唯一解析入口）───────────────────────────────

export interface WorkspaceLayoutConfig {
  version: 1;
  /** 用户显式调整过的模块顺序（可能缺项，渲染时与 Profile 合并）。 */
  moduleOrder: WorkspaceModuleId[];
  /** 用户隐藏的模块（概览不可隐藏，保证有落点）。 */
  hiddenModules: WorkspaceModuleId[];
  /** 专业窗口的当前模块（与 workspace_instances.active_module 保持一致）。 */
  activeModule: WorkspaceModuleId;
}

export const WORKSPACE_LAYOUT_VERSION = 1;

export function defaultLayout(profile: WorkspaceProfile): WorkspaceLayoutConfig {
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    moduleOrder: profile.modules.map((m) => m.id),
    hiddenModules: [],
    activeModule: profile.defaultModule,
  };
}

function isModuleId(value: unknown): value is WorkspaceModuleId {
  return value === "overview" || value === "items" || value === "links" || value === "settings";
}

/**
 * 解析 `layout_json`：损坏 / 旧版本 / 非对象一律回退默认布局，**绝不抛错**。
 * 旧版（本轮之前）存的是 `"{}"` 或空串——视为「未配置」，返回默认布局。
 */
export function parseWorkspaceLayout(
  json: string | null | undefined,
  profile: WorkspaceProfile,
): { layout: WorkspaceLayoutConfig; repaired: boolean } {
  const fallback = defaultLayout(profile);
  if (!json || !json.trim()) return { layout: fallback, repaired: false };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { layout: fallback, repaired: true };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { layout: fallback, repaired: true };
  }
  const obj = raw as Partial<WorkspaceLayoutConfig> & { version?: unknown };
  if (obj.version !== WORKSPACE_LAYOUT_VERSION) {
    // 旧版 / 未来版本：不猜测字段语义，回默认并标记 repaired
    return { layout: fallback, repaired: obj.version !== undefined };
  }
  const order: WorkspaceModuleId[] = [];
  if (Array.isArray(obj.moduleOrder)) {
    for (const value of obj.moduleOrder) {
      // 非法值与重复项都剔除：布局是「用户偏好」，不是可信输入
      if (isModuleId(value) && !order.includes(value)) order.push(value);
    }
  }
  const hidden = Array.isArray(obj.hiddenModules)
    ? obj.hiddenModules.filter((m): m is WorkspaceModuleId => isModuleId(m) && m !== "overview")
    : [];
  const active = isModuleId(obj.activeModule) ? obj.activeModule : profile.defaultModule;
  return {
    layout: {
      version: WORKSPACE_LAYOUT_VERSION,
      moduleOrder: order,
      hiddenModules: hidden,
      activeModule: active,
    },
    repaired: false,
  };
}

/**
 * 切换模块时保存布局：**只改 activeModule，保留 order/hidden**。
 * 历史缺陷：`switchModule` 传入固定 `"{}"`，把用户已有的 layoutJson 覆盖成空对象。
 */
export function withActiveModule(
  current: WorkspaceLayoutConfig,
  activeModule: WorkspaceModuleId,
): WorkspaceLayoutConfig {
  return { ...current, version: WORKSPACE_LAYOUT_VERSION, activeModule };
}

/**
 * 布局 → 实际渲染的模块清单：Profile 顺序为底，用户顺序覆盖，隐藏项剔除，
 * Profile 新增的模块自动追加（旧配置不会吞掉新导航）。
 */
export function resolveModuleOrder(
  profile: WorkspaceProfile,
  layout: WorkspaceLayoutConfig,
): WorkspaceModule[] {
  const base = profile.modules;
  const byId = new Map(base.map((m) => [m.id, m]));
  const ordered: WorkspaceModule[] = [];
  for (const id of layout.moduleOrder) {
    const m = byId.get(id);
    if (m && !ordered.some((x) => x.id === id)) ordered.push(m);
  }
  for (const m of base) {
    if (!ordered.some((x) => x.id === m.id)) ordered.push(m);
  }
  return ordered.filter((m) => !layout.hiddenModules.includes(m.id));
}
