// 移动端工作台入口注册表（唯一元数据源，2026-11-15）。
//
// 为什么单独建这一份：入口的显示/隐藏/排序必须有稳定的唯一 ID 和可用性判定，
// 而页面里以前是写死的数组（HomeScreen.quickEntries）。写死数组无法表达
// 「暂不可用」「默认是否显示」「默认顺序」，也没法在新增功能时区分
// 「用户主动隐藏」与「从来没出现过」。
//
// 与桌面端的关系：桌面端 src/lib/navigationRegistry.ts 是它的等价物（同一套
// id/label/icon/defaults/locked 语义），但两端是**独立配置**：桌面端配置落在
// SQLite settings.navigation_layout，移动端落在本机 kv('workbench_entries')，
// 共享的只有「稳定 ID + 元数据 + 默认规则 + 归一化思路」，不共享运行时状态。
//
// 约束：本文件是纯数据 + 纯函数，不得 import react / react-native / db。
import type { RouteKey, TabKey } from "./nav";

export type EntryCategory = "capture" | "task" | "device" | "system";

/**
 * available = 移动端已有真实页面或真实能力，可加入工作台；
 * unavailable = 移动端没有这条能力（或只有桌面端数据链路），只能出现在「暂不可用」区。
 *
 * 注意：unavailable 不等于「用户隐藏」。前者是能力缺失，用户无法把它加进来；
 * 后者是用户选择，随时可以加回来。两者在管理器里必须是两个分开的区域。
 */
export type EntryAvailability = "available" | "unavailable";

/** 入口打开方式：跳推送页 / 切底部栏 / 打开新建任务面板 */
export type EntryLaunch =
  | { kind: "route"; route: RouteKey }
  | { kind: "tab"; tab: TabKey }
  | { kind: "createTask" };

export interface MobileEntry {
  /** 稳定 ID：一旦发布不得改名（配置里存的就是它） */
  id: string;
  label: string;
  /** 语义图标名，必须存在于 components/icons/iconMap.json（由单测守住） */
  icon: string;
  /** 一行功能简介，管理器里作为副标题展示 */
  description: string;
  category: EntryCategory;
  availability: EntryAvailability;
  /** unavailable 的原因；available 不填 */
  reason?: string;
  /**
   * available 必填；unavailable 不填。
   * 暂不可用入口没有 launch——移动端没有这条链路时不允许跳任何页面，
   * 否则就会出现「点了没反应」或「跳进空白页」。
   */
  launch?: EntryLaunch;
  /** 默认是否出现在工作台 */
  defaultVisible: boolean;
  /** 默认排序（越小越靠前），用于首次安装与「新功能插入到默认位置」 */
  order: number;
}

/**
 * 注册表。id 与 label 是用户可见契约，改动前必须同步 docs/mobile/17-workbench-entries.md。
 *
 * 默认可见集合刻意保持与改造前的工作台一致（采集 / 新建任务 / 工作区 / 本机素材暂存 / 工具面板），
 * 只把两个「未接入占位」磁贴移出工作台：它们没有真实能力，按新模型属于「暂不可用」。
 * 其余能力默认隐藏，由用户自己加到工作台，避免首页一上来就被入口塞满。
 */
export const MOBILE_ENTRIES = [
  {
    id: "capture",
    label: "采集",
    icon: "camera",
    description: "拍照、扫描、导入与本机素材统一入口",
    category: "capture",
    availability: "available",
    launch: { kind: "route", route: "capture_home" },
    defaultVisible: true,
    order: 10,
  },
  {
    id: "create-task",
    label: "新建任务",
    icon: "add",
    description: "打开任务编辑器，快速记一条待办",
    category: "task",
    availability: "available",
    launch: { kind: "createTask" },
    defaultVisible: true,
    order: 20,
  },
  {
    id: "workspace",
    label: "工作区",
    icon: "workspace",
    description: "项目空间与本机内容资源",
    category: "task",
    availability: "available",
    launch: { kind: "tab", tab: "workspace" },
    defaultVisible: true,
    order: 30,
  },
  {
    id: "stash",
    // 第二轮验收：首页磁贴统一叫「本机素材暂存」，与工作区「文件集合」口径一致，
    // 避免被误读成桌面端的「文件暂存架」。仍指向 capture_stash（应用私有目录素材）。
    label: "本机素材暂存",
    icon: "fileStack",
    description: "本机采集素材（应用私有目录），不是桌面端文件暂存架",
    category: "capture",
    availability: "available",
    launch: { kind: "route", route: "capture_stash" },
    defaultVisible: true,
    order: 40,
  },
  {
    id: "tools",
    label: "工具面板",
    icon: "tools",
    description: "全部工具与本机自检入口",
    category: "system",
    availability: "available",
    launch: { kind: "tab", tab: "tools" },
    defaultVisible: true,
    order: 50,
  },
  {
    id: "tasks",
    label: "任务",
    icon: "tasks",
    description: "任务清单、筛选与提醒",
    category: "task",
    availability: "available",
    launch: { kind: "tab", tab: "tasks" },
    defaultVisible: false,
    order: 60,
  },
  {
    id: "inbox",
    label: "收集箱",
    icon: "inbox",
    description: "桌面端与系统分享收进来的速记",
    category: "task",
    availability: "available",
    launch: { kind: "route", route: "inbox" },
    defaultVisible: false,
    order: 70,
  },
  {
    id: "notes",
    label: "笔记",
    icon: "note",
    description: "本机笔记，可与电脑双向同步",
    category: "task",
    availability: "available",
    launch: { kind: "route", route: "notes" },
    defaultVisible: false,
    order: 80,
  },
  {
    id: "quick-note",
    label: "快速笔记",
    icon: "noteNew",
    description: "直接新建一条笔记",
    category: "capture",
    availability: "available",
    launch: { kind: "route", route: "note_editor" },
    defaultVisible: false,
    order: 90,
  },
  {
    id: "camera",
    label: "拍照",
    icon: "camera",
    description: "相机拍摄后进入处理页，不改动相册",
    category: "capture",
    availability: "available",
    launch: { kind: "route", route: "capture_camera" },
    defaultVisible: false,
    order: 100,
  },
  {
    id: "scan",
    label: "扫描文档",
    icon: "docScan",
    description: "多页扫描并整理成本地素材",
    category: "capture",
    availability: "available",
    launch: { kind: "route", route: "capture_scan" },
    defaultVisible: false,
    order: 110,
  },
  {
    id: "import-media",
    label: "相册/文件导入",
    icon: "gallery",
    description: "从相册或系统文件选择器导入素材",
    category: "capture",
    availability: "available",
    launch: { kind: "route", route: "capture_import" },
    defaultVisible: false,
    order: 120,
  },
  {
    id: "files",
    label: "文件互传",
    icon: "transfer",
    description: "与已配对桌面端互传文件",
    category: "device",
    availability: "available",
    launch: { kind: "route", route: "files" },
    defaultVisible: false,
    order: 130,
  },
  {
    id: "sync",
    label: "同步中心",
    icon: "sync",
    description: "手动同步、待发数量与解除配对",
    category: "device",
    availability: "available",
    launch: { kind: "route", route: "sync" },
    defaultVisible: false,
    order: 140,
  },
  {
    id: "pairing",
    label: "扫码配对",
    icon: "qr",
    description: "扫描桌面端二维码或输入配对码",
    category: "device",
    availability: "available",
    launch: { kind: "route", route: "pairing" },
    defaultVisible: false,
    order: 150,
  },
  {
    id: "device",
    label: "设备详情",
    icon: "desktop",
    description: "连接地址、上次连接时间与连接动作",
    category: "device",
    availability: "available",
    launch: { kind: "route", route: "device" },
    defaultVisible: false,
    order: 160,
  },
  {
    id: "notifications",
    label: "通知",
    icon: "bell",
    description: "提醒权限、提醒动作与后台限制",
    category: "device",
    availability: "available",
    launch: { kind: "route", route: "notifications" },
    defaultVisible: false,
    order: 170,
  },
  {
    id: "diagnostics",
    label: "诊断中心",
    icon: "gauge",
    description: "本机自检、冲突与待发操作",
    category: "system",
    availability: "available",
    launch: { kind: "route", route: "diagnostics" },
    defaultVisible: false,
    order: 180,
  },
  {
    id: "settings",
    label: "偏好设置",
    icon: "settings",
    description: "主题、本地数据与关于",
    category: "system",
    availability: "available",
    launch: { kind: "route", route: "settings" },
    defaultVisible: false,
    order: 190,
  },
  // —— 暂不可用：能力缺失，只能出现在「暂不可用」区，不允许加入工作台 ——
  {
    id: "dev-workbench",
    label: "开发工作台",
    icon: "terminal",
    description: "以当前开发任务为核心的工作台",
    category: "system",
    availability: "unavailable",
    reason: "Agent 运行态与任务交接走桌面端管线，移动端没有读取通道。",
    defaultVisible: false,
    order: 200,
  },
  {
    id: "scene-workspace",
    label: "场景工作区",
    icon: "scene",
    description: "一键进入预设的应用与网址组合",
    category: "system",
    availability: "unavailable",
    reason: "场景配置存放在桌面端，移动端没有对应数据通道。",
    defaultVisible: false,
    order: 210,
  },
  {
    id: "project-space",
    label: "项目空间",
    icon: "project",
    description: "项目、成员与事项协作",
    category: "task",
    availability: "unavailable",
    reason: "项目数据只在桌面端维护，移动端还没有项目同步链路。",
    defaultVisible: false,
    order: 220,
  },
  {
    id: "feature-board",
    label: "功能看板",
    icon: "list",
    description: "项目功能与看板状态",
    category: "task",
    availability: "unavailable",
    reason: "看板数据来自桌面端项目空间，移动端尚未同步。",
    defaultVisible: false,
    order: 230,
  },
  {
    id: "workflow",
    label: "工作流",
    icon: "workflow",
    description: "把重复操作编排成一键流程",
    category: "system",
    availability: "unavailable",
    reason: "工作流执行引擎在桌面端，移动端没有执行通道。",
    defaultVisible: false,
    order: 240,
  },
  {
    id: "ai-assistant",
    label: "AI 助手",
    icon: "sparkles",
    description: "对话式任务与内容处理",
    category: "system",
    availability: "unavailable",
    reason: "移动端没有 AI 对话与执行链路。",
    defaultVisible: false,
    order: 250,
  },
  {
    id: "clipboard",
    label: "剪贴板",
    icon: "clipboard",
    description: "跨设备复制历史与收藏",
    category: "capture",
    availability: "unavailable",
    reason: "剪贴板采集只在桌面端运行，移动端未接入。",
    defaultVisible: false,
    order: 260,
  },
  {
    id: "cast",
    label: "投屏",
    icon: "smartphone",
    description: "把手机内容投到电脑",
    category: "device",
    availability: "unavailable",
    reason: "投屏依赖桌面端接收能力，移动端未实现。",
    defaultVisible: false,
    order: 270,
  },
] as const satisfies readonly MobileEntry[];

export type EntryId = (typeof MOBILE_ENTRIES)[number]["id"];

/** 按 id 取元数据；未知 id 返回 undefined（旧配置里的已删除功能靠这里安全丢弃） */
const BY_ID = new Map<string, MobileEntry>(
  MOBILE_ENTRIES.map((entry) => [entry.id, entry]),
);

export function entryById(id: string): MobileEntry | undefined {
  return BY_ID.get(id);
}

export function isEntryAvailable(entry: MobileEntry | undefined): boolean {
  return entry !== undefined && entry.availability === "available";
}

/** 可用入口，按默认顺序 */
export function availableEntries(): readonly MobileEntry[] {
  return MOBILE_ENTRIES.filter(isEntryAvailable);
}

/** 暂不可用入口，按默认顺序 */
export function unavailableEntries(): readonly MobileEntry[] {
  return MOBILE_ENTRIES.filter((entry) => entry.availability === "unavailable");
}

/** 当前全部可用入口 id（写入配置时作为「已知快照」） */
export function availableEntryIds(): EntryId[] {
  return availableEntries().map((entry) => entry.id as EntryId);
}

/** 首次安装的默认工作台（按 order） */
export function defaultVisibleEntryIds(): EntryId[] {
  return availableEntries()
    .filter((entry) => entry.defaultVisible)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.id as EntryId);
}

/** 把 id 列表解析成入口（跳过已删除的 id），保持输入顺序 */
export function entriesForIds(ids: readonly EntryId[]): MobileEntry[] {
  const result: MobileEntry[] = [];
  for (const id of ids) {
    const entry = entryById(id);
    if (entry && entry.availability === "available") result.push(entry);
  }
  return result;
}

/** 分类标题（管理器「全部功能」按分类分组时使用） */
export const CATEGORY_LABELS: Record<EntryCategory, string> = {
  capture: "采集与记录",
  task: "任务与内容",
  device: "设备与连接",
  system: "系统与工具",
};

/** 分类展示顺序 */
export const CATEGORY_ORDER: readonly EntryCategory[] = [
  "capture",
  "task",
  "device",
  "system",
];

/** 入口是否可点开：只有可用入口有落点；暂不可用一律返回 null（只展示原因） */
export function entryTargetOf(entry: MobileEntry): EntryLaunch | null {
  if (entry.availability === "available" && entry.launch) return entry.launch;
  return null;
}
