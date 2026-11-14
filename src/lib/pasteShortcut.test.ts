/**
 * @vitest-environment jsdom
 */
//! 暂存架 Ctrl+V 守卫：只测「该不该消费」，不触碰系统剪贴板。

import { afterEach, describe, expect, it } from "vitest";
import {
  isEditablePasteTarget,
  shouldHandleShelfPaste,
} from "./pasteShortcut";
import { registerOverlay, resetOverlayStack } from "./overlayStack";

type PasteEvent = Parameters<typeof shouldHandleShelfPaste>[0];

function event(over: Partial<PasteEvent> = {}): PasteEvent {
  return {
    key: "v",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 86,
    defaultPrevented: false,
    target: null,
    ...over,
  };
}

afterEach(() => resetOverlayStack());

describe("shouldHandleShelfPaste", () => {
  it("普通 Ctrl+V 消费", () => {
    expect(shouldHandleShelfPaste(event())).toBe(true);
  });

  it("Ctrl+Shift+V / Ctrl+Alt+V / Ctrl+Win+V 放行", () => {
    expect(shouldHandleShelfPaste(event({ shiftKey: true }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ altKey: true }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ metaKey: true }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ ctrlKey: false }))).toBe(false);
  });

  it("输入法组合、repeat、已被消费的事件不重复触发", () => {
    expect(shouldHandleShelfPaste(event({ isComposing: true }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ keyCode: 229 }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ repeat: true }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ defaultPrevented: true }))).toBe(false);
  });

  it("busy 时不消费", () => {
    expect(shouldHandleShelfPaste(event(), { busy: true })).toBe(false);
  });

  it("非 V 键不消费", () => {
    expect(shouldHandleShelfPaste(event({ key: "c" }))).toBe(false);
  });

  it("输入框 / textarea / select / contenteditable 内不消费", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editable.appendChild(child);
    document.body.append(input, textarea, select, editable);

    expect(isEditablePasteTarget(input)).toBe(true);
    expect(isEditablePasteTarget(textarea)).toBe(true);
    expect(isEditablePasteTarget(select)).toBe(true);
    expect(isEditablePasteTarget(child)).toBe(true);
    expect(shouldHandleShelfPaste(event({ target: input }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ target: textarea }))).toBe(false);
    expect(shouldHandleShelfPaste(event({ target: child }))).toBe(false);

    input.remove();
    textarea.remove();
    select.remove();
    editable.remove();
  });

  it("普通按钮/空白处不阻断", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(isEditablePasteTarget(button)).toBe(false);
    expect(shouldHandleShelfPaste(event({ target: button }))).toBe(true);
    button.remove();
  });

  it("菜单/对话框等弹层阻断；胶囊自身的 drawer 层不阻断", () => {
    const releaseDrawer = registerOverlay({
      kind: "drawer",
      onEscape: () => {},
      blocksAutoHide: false,
    });
    expect(shouldHandleShelfPaste(event())).toBe(true);
    releaseDrawer();

    const releaseMenu = registerOverlay({ kind: "menu", onEscape: () => {} });
    expect(shouldHandleShelfPaste(event())).toBe(false);
    releaseMenu();

    const releaseDialog = registerOverlay({ kind: "dialog", onEscape: () => {} });
    expect(shouldHandleShelfPaste(event())).toBe(false);
    releaseDialog();
  });
});
