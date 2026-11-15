// 导航迁移表：旧五个入口 → 新五栏结构。这里只描述「去哪」，不持有 UI 状态。
// 目的：重构前先固定映射，避免某个旧页面在新导航里失去入口（验收时逐条核对）。
export type LegacyEntry = "tasks" | "inbox" | "notes" | "device" | "settings";
export type NewTab = "home" | "tasks" | "workspace" | "tools" | "profile";

export interface NavigationMapping {
  legacy: LegacyEntry;
  /** 新结构中的主入口位置 */
  primary: NewTab;
  /** 直达方式：同栏 / 从该栏进入二级页 */
  via: "tab" | "push";
  /** 首页/工作区是否另有快捷入口 */
  shortcuts: NewTab[];
  note: string;
}

export const NAVIGATION_MAP: NavigationMapping[] = [
  {
    legacy: "tasks",
    primary: "tasks",
    via: "tab",
    shortcuts: ["home", "workspace"],
    note: "任务仍是独立一级栏；首页今日专注与工作区置顶工具可直接回到任务",
  },
  {
    legacy: "inbox",
    primary: "workspace",
    via: "push",
    shortcuts: ["home", "profile"],
    note: "第二轮去重后收集箱的主归属回到「工作区 · 内容管理」；首页最近动态与我的最近内容只是快捷入口",
  },
  {
    legacy: "notes",
    primary: "workspace",
    via: "push",
    shortcuts: ["home", "profile", "tools"],
    note: "笔记的主归属同样在「工作区 · 内容管理」；工具页只保留「快速笔记」这一个新建动作，不再列笔记目录",
  },
  {
    legacy: "device",
    primary: "profile",
    via: "push",
    shortcuts: [],
    note: "设备页整体进入「我的」的设备与连接区，配对/同步/互传/冲突/小组件入口全部保留",
  },
  {
    legacy: "settings",
    primary: "profile",
    via: "push",
    shortcuts: [],
    note: "设置页整体进入「我的」；主题/提醒/本地数据/关于不拆分、不改语义",
  },
];

/** 旧入口是否在新结构中有可达位置（任何映射缺失都视为导航倒退） */
export function isLegacyEntryReachable(entry: LegacyEntry): boolean {
  return NAVIGATION_MAP.some((mapping) => mapping.legacy === entry);
}
