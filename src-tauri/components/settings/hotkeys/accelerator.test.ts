import { describe, expect, it } from "vitest";

import {
  acceleratorFromEvent,
  findConflictingBinding,
  isImeEvent,
  isModifierCode,
  isSupportedKeyCode,
  normalizeAccelerator,
  reservedReasonKey,
} from "./accelerator";
import { translate } from "../../../i18n";
import type { HotkeyBindingView } from "./types";

function binding(
  overrides: Partial<HotkeyBindingView> & Pick<HotkeyBindingView, "action">,
): HotkeyBindingView {
  return {
    label: overrides.action,
    description: "",
    scope: "app_local",
    accelerator: "Ctrl+K",
    default_accelerator: "Ctrl+K",
    enabled: true,
    is_default: true,
    state: "active",
    message: null,
    ...overrides,
  };
}

describe("acceleratorFromEvent", () => {
  it("按 Ctrl → Alt → Shift → Meta 固定顺序生成组合", () => {
    expect(
      acceleratorFromEvent({
        code: "KeyK",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        metaKey: true,
      }),
    ).toBe("Ctrl+Alt+Shift+Meta+K");
    expect(
      acceleratorFromEvent({
        code: "Digit1",
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
      }),
    ).toBe("Ctrl+Shift+1");
    expect(
      acceleratorFromEvent({
        code: "F5",
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe("Alt+F5");
    expect(
      acceleratorFromEvent({
        code: "ArrowUp",
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe("Ctrl+Up");
  });

  it("拒绝单独修饰键、无修饰键、重复事件与输入法组合", () => {
    expect(
      acceleratorFromEvent({
        code: "ControlLeft",
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBeNull();
    expect(
      acceleratorFromEvent({
        code: "KeyK",
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBeNull();
    expect(
      acceleratorFromEvent({
        code: "KeyK",
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        repeat: true,
      }),
    ).toBeNull();
    const composing = {
      code: "KeyK",
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      isComposing: true,
    };
    expect(acceleratorFromEvent(composing)).toBeNull();
    expect(isImeEvent(composing)).toBe(true);
    expect(
      acceleratorFromEvent({
        code: "KeyK",
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        keyCode: 229,
      }),
    ).toBeNull();
  });

  it("不支持的按键返回 null 且可被预检识别", () => {
    expect(
      acceleratorFromEvent({
        code: "AudioVolumeUp",
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBeNull();
    expect(isSupportedKeyCode("AudioVolumeUp")).toBe(false);
    expect(isSupportedKeyCode("KeyA")).toBe(true);
  });

  it("识别修饰键 code", () => {
    for (const code of ["ControlLeft", "AltRight", "ShiftLeft", "MetaRight", "OSLeft"]) {
      expect(isModifierCode(code)).toBe(true);
    }
    expect(isModifierCode("KeyK")).toBe(false);
  });
});

describe("normalizeAccelerator", () => {
  it("大小写、别名与空格都归一", () => {
    expect(normalizeAccelerator("shift+ctrl+k")).toBe("Ctrl+Shift+K");
    expect(normalizeAccelerator("Alt + F5")).toBe("Alt+F5");
    expect(normalizeAccelerator("win+space")).toBe("Meta+Space");
    expect(normalizeAccelerator("cmd+pgdn")).toBe("Meta+PageDown");
  });

  it("拒绝非法组合", () => {
    expect(() => normalizeAccelerator("")).toThrow("不能为空");
    expect(() => normalizeAccelerator("Ctrl")).toThrow("缺少主键");
    expect(() => normalizeAccelerator("Ctrl+Shift")).toThrow("缺少主键");
    expect(() => normalizeAccelerator("K")).toThrow("修饰键");
    expect(() => normalizeAccelerator("Ctrl+K+L")).toThrow("多个主键");
    expect(() => normalizeAccelerator("Ctrl+é")).toThrow("不支持");
  });
});

describe("保留组合与冲突检测", () => {
  it("系统保留组合映射到本地化原因键", () => {
    expect(reservedReasonKey("Alt+F4")).toBe("hotkeys.reserved.altF4");
    expect(translate("zh-CN", reservedReasonKey("Alt+F4")!)).toContain("关闭窗口");
    expect(translate("zh-CN", reservedReasonKey("Ctrl+Shift+F")!)).toContain("全局搜索");
    expect(translate("en-US", reservedReasonKey("Ctrl+Shift+F")!)).toContain(
      "global search",
    );
    expect(reservedReasonKey("Ctrl+Alt+T")).toBeNull();
  });

  it("跨作用域算冲突，禁用项不参与", () => {
    const bindings = [
      binding({ action: "toggle_main_window", scope: "system_global", accelerator: "Ctrl+Alt+T" }),
      binding({ action: "quick_add_task", accelerator: "Ctrl+K" }),
      binding({ action: "open_clipboard", accelerator: "Ctrl+K", enabled: false }),
    ];
    expect(findConflictingBinding(bindings, "quick_add_task", "Ctrl+Alt+T")?.action).toBe(
      "toggle_main_window",
    );
    expect(findConflictingBinding(bindings, "quick_add_task", "Ctrl+K")).toBeNull();
    expect(findConflictingBinding(bindings, "switch_tab_tasks", "Ctrl+K")?.action).toBe(
      "quick_add_task",
    );
  });
});
