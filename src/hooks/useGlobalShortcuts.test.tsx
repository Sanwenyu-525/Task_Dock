/**
 * @vitest-environment jsdom
 */
//! 全局快捷键契约（v0.6）：
//! - Ctrl+1…6 依次切到六个侧边栏入口，顺序与左侧导航一致；
//! - Ctrl+K 触发快速添加；输入框里不抢按键；
//! - Ctrl+Shift+C 完整模式进剪贴板页面，紧凑/极简模式开关临时抽屉；
//! - 非完整模式不响应 Ctrl+数字（避免极简窗口被切到隐藏页面）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";

import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useUiStore, TAB_ORDER, type Tab } from "../store/useUiStore";
import { useSettingsStore } from "../store/useSettingsStore";

function press(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

function setMode(mode: "full" | "compact" | "minimal") {
  useSettingsStore.setState({
    settings: { mode, theme: "system", visual_preset: "dream-gradient", material: "solid" } as never,
  });
}

beforeEach(() => {
  useUiStore.setState({ tab: "tasks", quickAddToken: 0, clipboardOpen: false, clipboardLinkTask: null });
  setMode("full");
});

afterEach(cleanup);

describe("全局快捷键", () => {
  it("Ctrl+1…6 依次切到六个侧边栏入口", () => {
    renderHook(() => useGlobalShortcuts());
    const expected: Tab[] = ["tasks", "agents", "actions", "clipboard", "history", "settings"];
    expect([...TAB_ORDER]).toEqual(expected);
    for (let i = 0; i < expected.length; i++) {
      press({ code: `Digit${i + 1}`, ctrlKey: true });
      expect(useUiStore.getState().tab).toBe(expected[i]);
    }
  });

  it("Ctrl+7 及以上没有对应入口，不切页", () => {
    renderHook(() => useGlobalShortcuts());
    press({ code: "Digit7", ctrlKey: true });
    expect(useUiStore.getState().tab).toBe("tasks");
  });

  it("Ctrl+K 触发快速添加", () => {
    renderHook(() => useGlobalShortcuts());
    const before = useUiStore.getState().quickAddToken;
    press({ code: "KeyK", ctrlKey: true });
    expect(useUiStore.getState().quickAddToken).toBe(before + 1);
  });

  it("输入框里 Ctrl+K / Ctrl+1 不抢按键", () => {
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const token = useUiStore.getState().quickAddToken;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit3", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(useUiStore.getState().quickAddToken).toBe(token);
    expect(useUiStore.getState().tab).toBe("tasks");
    input.remove();
  });

  it("Ctrl+Shift+C：完整模式进入剪贴板页面并关闭临时抽屉", () => {
    renderHook(() => useGlobalShortcuts());
    useUiStore.setState({ clipboardOpen: true });
    press({ code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });

  it("Ctrl+Shift+C：紧凑 / 极简模式开关临时剪贴板抽屉", () => {
    renderHook(() => useGlobalShortcuts());
    setMode("compact");

    press({ code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().clipboardOpen).toBe(true);
    expect(useUiStore.getState().tab).toBe("tasks");

    press({ code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });

  it("紧凑 / 极简模式不响应 Ctrl+数字", () => {
    renderHook(() => useGlobalShortcuts());
    setMode("minimal");
    press({ code: "Digit4", ctrlKey: true });
    expect(useUiStore.getState().tab).toBe("tasks");
  });

  it("卸载后不再响应按键", () => {
    const { unmount } = renderHook(() => useGlobalShortcuts());
    unmount();
    press({ code: "Digit2", ctrlKey: true });
    expect(useUiStore.getState().tab).toBe("tasks");
  });
});
