/** 快捷键前端视图类型，字段与 Rust 侧序列化保持一致。 */

export type HotkeyScope = "app_local" | "system_global";

export type HotkeyState = "active" | "disabled" | "conflict" | "invalid" | "unavailable";

export interface HotkeyBindingView {
  action: string;
  label: string;
  description: string;
  scope: HotkeyScope;
  accelerator: string;
  default_accelerator: string;
  enabled: boolean;
  is_default: boolean;
  state: HotkeyState;
  message: string | null;
}

export interface HotkeySnapshot {
  bindings: HotkeyBindingView[];
  load_error: string | null;
}

export type HotkeyErrorKind =
  | "invalid"
  | "conflict"
  | "occupied"
  | "register_failed"
  | "persist_failed"
  | "unregister_failed";

export interface HotkeyChangeOutcome {
  ok: boolean;
  action: string;
  binding: HotkeyBindingView;
  previous_accelerator: string;
  persisted: boolean;
  rolled_back: boolean;
  rollback_ok: boolean | null;
  error: string | null;
  error_kind: HotkeyErrorKind | null;
}

export interface HotkeyResetOutcome {
  ok: boolean;
  results: HotkeyChangeOutcome[];
  error: string | null;
}
