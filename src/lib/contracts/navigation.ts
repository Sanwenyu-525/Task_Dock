//! 导航目标数据契约。从 `navigation.ts` 收进契约层，保持 contracts 自包含。
//!
//! 约束：纯类型，不 import 业务模块；`navigation.ts` 仍对外 re-export 这些类型。

export type NavigationTargetType =
  | "application"
  | "url"
  | "file"
  | "directory"
  | "agent_session";

export interface NavTarget {
  id: string;
  display_name: string;
  target_type: NavigationTargetType;
  app_key: string;
  exe_path: string;
  launch_args: string;
  working_dir: string;
  app_user_model_id: string;
  url: string;
  path: string;
  agent_source_id: string;
  agent_session_id: string;
  window_title_hint: string;
  icon: string;
  category: string;
  favorite: boolean;
  hidden: boolean;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
  /** app = 普通应用快捷方式（按程序去重）；window = 指定窗口快捷方式（按稳定身份去重） */
  shortcut_kind?: "app" | "window";
  /** 指定窗口快捷方式绑定的稳定身份（类名+标题+exe，不含 HWND） */
  bound_window_identity?: WindowMemory | null;
}

export interface WindowMemory {
  class_name: string;
  title: string;
  exe_path: string;
  origin: "user" | "auto";
}

export interface TaskNavLink {
  id: string;
  task_id: string;
  target_id: string;
  display_order: number;
  is_default: boolean;
  launch_behavior: string;
  created_at: string;
  window_identity?: WindowMemory | null;
  window_fallback?: "reselect" | "focus_app" | "launch";
  target: NavTarget;
  /** not_running | process_only | has_window | always | unavailable | agent */
  running_state: string;
}
