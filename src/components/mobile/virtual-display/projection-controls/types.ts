//! 投屏控制栏共享类型（从 ProjectionToolbar 迁移，供 projection-controls 各文件引用）。

export interface ProjectionCapabilities {
  back: boolean;
  home: boolean;
  recents: boolean;
  screenshot: boolean;
  close: boolean;
}

/** 一体化布局模式（与后端 `ProjectionToolbarState.layout_mode` 对齐）。 */
export type ProjectionLayoutModeUi = "side" | "bottom" | "compact";

/** 会话动作（导航/截屏/结束）统一经 controller 转发，组件不直接调 Rust。 */
export type ProjectionActionKind =
  | { kind: "navigate"; action: "back" | "home" | "recents" }
  | { kind: "screenshot" }
  | { kind: "end" };
