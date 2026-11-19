// 轻量导航契约：本应用不用导航库，栈由 App.tsx 的 Shell 持有；
// 这里只定义屏幕与容器之间的类型，避免 screens 反向 import App 造成循环依赖。
//
// 路由键同时以运行时常量导出（2026-11-15 工作台入口自定义）：
// 入口注册表需要「声明的路由确实在路由表里」这条可断言契约，纯类型做不到运行期校验。
export const ROUTE_KEYS = [
  "pairing",
  // Personal Hub（基线 §6.2）：扫码加入电脑 Hub，与局域网同步配对是两条独立链路。
  "hub_pairing",
  "sync",
  "files",
  "conflict",
  "note_editor",
  "widget",
  "notifications",
  // 统一采集中心（照片 / 语音 / 文件 / 文本），系统分享与快捷方式都进入这里
  "capture",
  // 蓝青专业版导航重构（2026-11-13）：收集箱/笔记/设备/设置不再是底部一级栏，
  // 但页面本身、数据与交互完全保留，改为从「工具」「我的」进入的二级页。
  "inbox",
  "notes",
  "device",
  "settings",
  // 移动采集中心（2026-11-15）：相机 → 处理页（多目的地）→ 本机素材库。
  // 不新增底部 Tab：入口在首页快捷区与工具页「采集与整理」。
  "capture_camera",
  "capture_scan",
  "capture_review",
  "capture_stash",
  "capture_import",
  // 采集中心入口（状态一：采集）：拍照 / 扫描 / 导入 / 语音 / 一句话
  "capture_home",
  // 开发验收专用（无导航入口，长按「我的」页版本号进入），不进正式信息架构
  "icon_gallery",
  // 2026-11-15 全页面统一：任务详情（真实数据）与诊断中心（真实本地自检）。
  // 项目详情/功能看板/场景工作区/开发工作台等未接入能力不再保留推送路由，
  // 入口统一降级为不可点击的中性图标占位（FeatureIconPlaceholder），不新造页面与假数据。
  "task_detail",
  // 生活效率系统（2026-11-16）：购买记录、生活待办、票据资料。
  "life",
  // 生活同步待处理：延后/拒绝变更的单条与批量恢复（2026-11-17 验收修复）。
  "sync_deferred",
  "diagnostics",
  // 工作台入口自定义：同一屏幕的两个入口各用一条路由，避免给 push 增加第 5 个参数
  "entry_manager",
  "all_features",
  // 效率工具（2026-11-16 产品整改）：API 调试 / 正则 / 代码对比退出普通工具体系，
  // 页面代码保留为非可见模块，不再注册路由；文本与资料通过聚合页进入。
  "tool_snippets",
  "tool_json",
  "tool_timestamp",
  "tool_text_codec",
  "tool_image_compress",
  "tool_color_picker",
  "tool_docs",
  "tool_github",
  "tool_text",
  "tool_resources",
] as const;

export type RouteKey = (typeof ROUTE_KEYS)[number];

/** 采集中心打开时的初始状态：普通采集 / 直接开相机 / 直接录音 / 直接写任务 */
export type CaptureIntent = "capture" | "camera" | "voice" | "task";

/** 底部五栏：顺序即 TabBar 渲染顺序（首页 / 任务 / 工作区 / 工具 / 我的） */
export type TabKey = "home" | "tasks" | "workspace" | "tools" | "profile";

export const TAB_ORDER: TabKey[] = ["home", "tasks", "workspace", "tools", "profile"];

/** 栈内路由；编辑器带笔记 id，采集中心带初始意图 */
export interface Route {
  key: RouteKey;
  noteId?: string;
  /** 任务详情页的任务 id（只在这一个路由使用） */
  taskId?: string;
  intent?: CaptureIntent;
  /**
   * 采集意图的非零信号：采集中心已打开时再次收到快捷动作/深链，
   * 只更新 intent 不会触发 React 状态变化（字符串可能相同），
   * 用递增序号让屏幕能「重启到用户这次选择的模式」而不是静默忽略。
   */
  intentNonce?: number;
}

/** 下发给屏幕的导航能力：只开 push/back，不让屏幕直接操作栈数组 */
export interface Nav {
  /**
   * 第 4 个参数只为任务详情服务：沿用既有三参签名不动，避免改动十余处历史调用。
   * 新页面统一 `nav.push("task_detail", undefined, undefined, task.id)`。
   */
  push: (key: RouteKey, noteId?: string, intent?: CaptureIntent, taskId?: string) => void;
  back: () => void;
}

/**
 * 一级页面额外需要的能力：切到指定 Tab、直接打开新建任务面板。
 * 这样首页/工作区的快捷入口复用同一套 Shell 状态，而不是各自造导航。
 */
export interface AppNav extends Nav {
  openTab: (tab: TabKey) => void;
  openCreateTask: () => void;
  /**
   * 首页放大镜 → 任务页并聚焦搜索框。
   * 单独一条能力而不是给 openTab 加参数：五个一级页常驻挂载，openTab 只切可见性，
   * 无法表达"这一次进入要聚焦"这种一次性信号。
   */
  openTaskSearch: () => void;
}

/** 小组件点击深链允许直达的入口（推送页不在深链白名单里，避免无参打开） */
export type WidgetRouteTab = "tasks" | "inbox";

/**
 * 解析小组件点击深链：taskdock://route/<tab>。
 * 只放行白名单入口（冷启动与已运行都可用），其他链接返回 null 由调用方忽略。
 * `inbox` 在新导航里是二级页：由 Shell 打开「工具」栏并推入收集箱。
 */
export function parseWidgetRouteUri(url: string | null | undefined): WidgetRouteTab | null {
  if (!url) return null;
  const prefix = "taskdock://route/";
  if (!url.startsWith(prefix)) return null;
  const tab = url.slice(prefix.length).split(/[?#]/, 1)[0];
  if (tab === "tasks" || tab === "inbox") return tab;
  return null;
}

/**
 * 一次性导航信号是否应被当前页面实例消费（新建任务 / 聚焦搜索共用）。
 * 只认「非 0 且没消费过」的 id；Shell 在消费后会把信号归零，组件重挂载不会再次触发。
 */
export function shouldConsumeSignal(signal: number, lastConsumed: number): boolean {
  return signal > 0 && signal !== lastConsumed;
}

/**
 * 首页新建任务信号是否应被当前任务页实例消费。
 * @deprecated 使用 shouldConsumeSignal；保留导出避免历史调用与测试断裂。
 */
export function shouldConsumeCreateSignal(signal: number, lastConsumed: number): boolean {
  return shouldConsumeSignal(signal, lastConsumed);
}
