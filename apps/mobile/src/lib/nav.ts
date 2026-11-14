// 轻量导航契约：本应用不用导航库，栈由 App.tsx 的 Shell 持有；
// 这里只定义屏幕与容器之间的类型，避免 screens 反向 import App 造成循环依赖。
export type RouteKey =
  | "pairing"
  | "sync"
  | "files"
  | "conflict"
  | "note_editor"
  | "widget"
  | "share"
  | "notifications"
  // 蓝青专业版导航重构（2026-11-13）：收集箱/笔记/设备/设置不再是底部一级栏，
  // 但页面本身、数据与交互完全保留，改为从「工具」「我的」进入的二级页。
  | "inbox"
  | "notes"
  | "device"
  | "settings";

/** 底部五栏：顺序即 TabBar 渲染顺序（首页 / 任务 / 工作区 / 工具 / 我的） */
export type TabKey = "home" | "tasks" | "workspace" | "tools" | "profile";

export const TAB_ORDER: TabKey[] = ["home", "tasks", "workspace", "tools", "profile"];

/** 栈内路由；目前只有编辑器需要参数（要打开的笔记 id，缺省=新建） */
export interface Route {
  key: RouteKey;
  noteId?: string;
}

/** 下发给屏幕的导航能力：只开 push/back，不让屏幕直接操作栈数组 */
export interface Nav {
  push: (key: RouteKey, noteId?: string) => void;
  back: () => void;
}

/**
 * 一级页面额外需要的能力：切到指定 Tab、直接打开新建任务面板。
 * 这样首页/工作区的快捷入口复用同一套 Shell 状态，而不是各自造导航。
 */
export interface AppNav extends Nav {
  openTab: (tab: TabKey) => void;
  openCreateTask: () => void;
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
 * 首页新建任务信号是否应被当前任务页实例消费。
 * 只认「非 0 且没消费过」的 id；Shell 在消费后会把信号归零，组件重挂载不会再次打开弹层。
 */
export function shouldConsumeCreateSignal(signal: number, lastConsumed: number): boolean {
  return signal > 0 && signal !== lastConsumed;
}
