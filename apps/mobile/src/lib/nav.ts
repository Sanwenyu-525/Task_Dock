// 轻量导航契约：本应用不用导航库，栈由 App.tsx 的 Shell 持有；
// 这里只定义屏幕与容器之间的类型，避免 screens 反向 import App 造成循环依赖。
export type RouteKey =
  | "pairing"
  | "sync"
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
