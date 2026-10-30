/**
 * @vitest-environment jsdom
 */
//! 弹层栈 Escape 优先级测试。
//!
//! 验收点（用户要求）：
//! - 一次 Escape 只执行**一个**最高优先级的关闭动作；
//! - 优先级：最上层确认框 → 子弹层 → 下拉菜单 → 临时抽屉 → 主窗口；
//! - 栈里还有任何一层时，主窗口不会被隐藏（不会被顺手藏进托盘）；
//! - 同类嵌套时，DOM 上更内层的那个优先（不看注册顺序）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerOverlay,
  resetOverlayStack,
  setWindowEscapeHandler,
  topOverlay,
} from "./overlayStack";

function pressEscape() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

describe("弹层栈 Escape 优先级", () => {
  beforeEach(() => {
    resetOverlayStack();
  });

  afterEach(() => {
    resetOverlayStack();
    setWindowEscapeHandler(null);
  });

  it("栈里有层时：Escape 只关这一层，主窗口不被隐藏", () => {
    const hide = vi.fn();
    const close = vi.fn();
    setWindowEscapeHandler(hide);
    registerOverlay({ kind: "menu", onEscape: close });

    pressEscape();

    expect(close).toHaveBeenCalledTimes(1);
    expect(hide).not.toHaveBeenCalled();
  });

  it("栈空时：Escape 交给窗口级动作（隐藏到托盘）", () => {
    const hide = vi.fn();
    setWindowEscapeHandler(hide);

    pressEscape();

    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("优先级链：确认框 → 子弹层 → 下拉菜单 → 临时抽屉", () => {
    const calls: string[] = [];
    setWindowEscapeHandler(() => calls.push("window"));
    registerOverlay({ kind: "drawer", onEscape: () => calls.push("drawer") });
    registerOverlay({ kind: "menu", onEscape: () => calls.push("menu") });
    registerOverlay({ kind: "sublayer", onEscape: () => calls.push("sublayer") });
    registerOverlay({ kind: "dialog", onEscape: () => calls.push("dialog") });

    pressEscape();
    expect(calls).toEqual(["dialog"]);

    pressEscape();
    expect(calls).toEqual(["dialog", "sublayer"]);

    pressEscape();
    expect(calls).toEqual(["dialog", "sublayer", "menu"]);

    pressEscape();
    expect(calls).toEqual(["dialog", "sublayer", "menu", "drawer"]);

    pressEscape();
    expect(calls).toEqual(["dialog", "sublayer", "menu", "drawer", "window"]);
  });

  it("一次 Escape 只关闭一层：连续按不会连关", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    registerOverlay({ kind: "drawer", onEscape: outer });
    registerOverlay({ kind: "dialog", onEscape: inner });

    pressEscape();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("同类嵌套：DOM 更内层的优先（React effect 是子先于父执行的，注册顺序相反）", () => {
    const outerEl = document.createElement("div");
    const innerEl = document.createElement("div");
    outerEl.appendChild(innerEl);
    document.body.appendChild(outerEl);

    const calls: string[] = [];
    // 内层先注册、外层后注册——与 React 的 effect 执行顺序一致
    registerOverlay({ kind: "dialog", onEscape: () => calls.push("inner"), root: innerEl });
    registerOverlay({ kind: "dialog", onEscape: () => calls.push("outer"), root: outerEl });

    expect(topOverlay()?.onEscape).toBeDefined();

    pressEscape();

    expect(calls).toEqual(["inner"]);
  });

  it("同类同级（兄弟）：最后注册的那个优先", () => {
    const calls: string[] = [];
    registerOverlay({ kind: "menu", onEscape: () => calls.push("first") });
    registerOverlay({ kind: "menu", onEscape: () => calls.push("second") });

    pressEscape();

    expect(calls).toEqual(["second"]);
  });

  it("关闭后该层出栈：下一次 Escape 命中下一层", () => {
    const calls: string[] = [];
    const release = registerOverlay({ kind: "dialog", onEscape: () => calls.push("dialog") });
    registerOverlay({ kind: "drawer", onEscape: () => calls.push("drawer") });

    release();
    pressEscape();

    expect(calls).toEqual(["drawer"]);
  });
});
