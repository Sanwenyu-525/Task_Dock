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
  | "notifications";

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

/** 小组件点击深链允许直达的 Tab（推送页不在深链白名单里，避免无参打开） */
export type WidgetRouteTab = "tasks" | "inbox";

/**
 * 解析小组件点击深链：taskdock://route/<tab>。
 * 只放行白名单 Tab（冷启动与已运行都可用），其他链接返回 null 由调用方忽略。
 */
export function parseWidgetRouteUri(url: string | null | undefined): WidgetRouteTab | null {
  if (!url) return null;
  const prefix = "taskdock://route/";
  if (!url.startsWith(prefix)) return null;
  const tab = url.slice(prefix.length).split(/[?#]/, 1)[0];
  if (tab === "tasks" || tab === "inbox") return tab;
  return null;
}
