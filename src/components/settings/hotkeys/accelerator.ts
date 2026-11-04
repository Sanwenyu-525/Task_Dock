/**
 * 快捷键组合的前端规范化与录制工具。
 *
 * 必须与 `src-tauri/src/hotkeys/model.rs` 的 `normalize_accelerator` 保持一致：
 * 修饰键固定按 Ctrl → Alt → Shift → Meta 排序，主键只接受字母、数字、F1-F24
 * 与常用控制键。后端仍是最终裁判，这里只负责录制即时反馈与内部冲突预检。
 */

import { getLocale, translate } from "../../../i18n";
import type { MessageKey } from "../../../i18n";
import type { HotkeyBindingView } from "./types";

/** 纯函数内取当前语言文案（录制/校验即时反馈跟随语言设置）。 */
function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(getLocale(), key, params);
}

export interface KeyLikeEvent {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");
const FUNCTION_KEYS = Array.from({ length: 24 }, (_, index) => `F${index + 1}`);

const NAMED_CODES: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const NAMED_ALIASES: Record<string, string> = {
  SPACE: "Space",
  TAB: "Tab",
  ENTER: "Enter",
  RETURN: "Enter",
  ESC: "Escape",
  ESCAPE: "Escape",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  DEL: "Delete",
  INSERT: "Insert",
  INS: "Insert",
  HOME: "Home",
  END: "End",
  PAGEUP: "PageUp",
  PGUP: "PageUp",
  PAGEDOWN: "PageDown",
  PGDN: "PageDown",
  UP: "Up",
  ARROWUP: "Up",
  DOWN: "Down",
  ARROWDOWN: "Down",
  LEFT: "Left",
  ARROWLEFT: "Left",
  RIGHT: "Right",
  ARROWRIGHT: "Right",
};

/** 与后端一致的系统保留组合；值是对应原因的本地化文案键。 */
export const RESERVED_ACCELERATORS: Record<string, MessageKey> = {
  "Ctrl+Alt+Delete": "hotkeys.reserved.ctrlAltDelete",
  "Ctrl+Shift+Escape": "hotkeys.reserved.ctrlShiftEscape",
  "Alt+Tab": "hotkeys.reserved.altTab",
  "Alt+F4": "hotkeys.reserved.altF4",
  "Ctrl+Escape": "hotkeys.reserved.ctrlEscape",
  "Meta+L": "hotkeys.reserved.metaL",
  "Meta+D": "hotkeys.reserved.metaD",
  "Meta+E": "hotkeys.reserved.metaE",
  "Meta+R": "hotkeys.reserved.metaR",
  "Meta+Tab": "hotkeys.reserved.metaTab",
  "Ctrl+Shift+F": "hotkeys.reserved.ctrlShiftF",
};

export function isModifierCode(code: string): boolean {
  return /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code);
}

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }
  return NAMED_CODES[code] ?? null;
}

function isImeComposing(event: KeyLikeEvent): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229;
}

/**
 * 把一次按键事件转成规范组合；返回 null 表示当前按键不能作为快捷键
 * （仅修饰键、输入法组合中、重复事件或不支持的按键）。
 */
export function acceleratorFromEvent(event: KeyLikeEvent): string | null {
  if (event.repeat || isImeComposing(event)) {
    return null;
  }
  const key = keyFromCode(event.code);
  if (!key) {
    return null;
  }
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Meta");
  if (modifiers.length === 0) {
    return null;
  }
  return [...modifiers, key].join("+");
}

function normalizeKey(token: string): string | null {
  const upper = token.toUpperCase();
  if (LETTERS.includes(upper)) return upper;
  if (DIGITS.includes(upper)) return upper;
  if (FUNCTION_KEYS.includes(upper)) return upper;
  return NAMED_ALIASES[upper] ?? null;
}

/** 文本组合规范化；非法时抛错，供录制之外的入口（如未来支持手输）复用。 */
export function normalizeAccelerator(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(t("hotkeys.error.empty"));
  }
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key: string | null = null;
  for (const part of trimmed.split("+")) {
    const token = part.trim();
    if (!token) {
      throw new Error(t("hotkeys.error.unparsable", { raw }));
    }
    const upper = token.toUpperCase();
    if (upper === "CTRL" || upper === "CONTROL") {
      ctrl = true;
    } else if (upper === "ALT" || upper === "OPTION") {
      alt = true;
    } else if (upper === "SHIFT") {
      shift = true;
    } else if (
      upper === "META" ||
      upper === "SUPER" ||
      upper === "CMD" ||
      upper === "COMMAND" ||
      upper === "WIN"
    ) {
      meta = true;
    } else {
      if (key !== null) {
        throw new Error(t("hotkeys.error.multipleKeys", { raw }));
      }
      key = normalizeKey(token);
      if (!key) {
        throw new Error(t("hotkeys.error.unsupportedKey", { token }));
      }
    }
  }
  if (!ctrl && !alt && !shift && !meta) {
    throw new Error(t("hotkeys.hint.needModifier"));
  }
  if (!key) {
    throw new Error(t("hotkeys.error.missingKey"));
  }
  const modifiers: string[] = [];
  if (ctrl) modifiers.push("Ctrl");
  if (alt) modifiers.push("Alt");
  if (shift) modifiers.push("Shift");
  if (meta) modifiers.push("Meta");
  return [...modifiers, key].join("+");
}

/** 保留组合的原因文案键；非保留组合返回 null。 */
export function reservedReasonKey(accelerator: string): MessageKey | null {
  return RESERVED_ACCELERATORS[accelerator] ?? null;
}

/** 应用内冲突预检：跨作用域也算冲突，避免系统级与应用级同时触发。 */
export function findConflictingBinding(
  bindings: HotkeyBindingView[],
  action: string,
  accelerator: string,
): HotkeyBindingView | null {
  return (
    bindings.find(
      (binding) =>
        binding.action !== action &&
        binding.enabled &&
        binding.accelerator === accelerator,
    ) ?? null
  );
}

export function isSupportedKeyCode(code: string): boolean {
  return keyFromCode(code) !== null;
}

export function isImeEvent(event: KeyLikeEvent): boolean {
  return isImeComposing(event);
}
