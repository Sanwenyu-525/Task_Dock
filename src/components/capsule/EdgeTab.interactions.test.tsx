//! Edge Tab 交互（2026-11-06 · edge-tab-interactions）
//!
//! 覆盖本次新增/收紧的标签输入约定：
//! - 单击 = 一次「恢复 + 展开」事务（`restoreTab({ reveal: true })`），且只触发一次；
//! - 右键 = 独立 `context-menu` 窗口的 tab 变体，不触发恢复、不进入拖动；
//! - 悬停 350ms 才显示独立提示窗，离开 / 按下 / 拖动 / 失焦 / 卸载都要收起；
//! - 提示文案取自真实 tone（unknown/idle 回落到中性文案）。
//!
//! 拖动位移与光标类名由 `CapsuleDragCursor.test.tsx` 覆盖，这里不重复。

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showTabHint = vi.fn(async () => {});
const hideTabHint = vi.fn(async () => {});
const showTabMenu = vi.fn(async () => true);

vi.mock("../../lib/edgeTabActions", () => ({
  showTabHint: (...args: unknown[]) => showTabHint(...(args as [])),
  hideTabHint: () => hideTabHint(),
  showTabMenu: (...args: unknown[]) => showTabMenu(...(args as [])),
}));

import EdgeTab from "./EdgeTab";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";

describe("EdgeTab 交互", () => {
  const restoreTab = vi.fn();
  const beginTabDrag = vi.fn();
  const dragTabBy = vi.fn();
  const endTabDrag = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    restoreTab.mockReset();
    beginTabDrag.mockReset();
    dragTabBy.mockReset();
    endTabDrag.mockReset();
    showTabHint.mockReset();
    hideTabHint.mockReset();
    showTabMenu.mockReset();
    useEdgeSnapStore.setState({
      restoreTab,
      beginTabDrag,
      dragTabBy,
      endTabDrag,
    });
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => true),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderTab(tone = "idle") {
    const { container, unmount } = render(<EdgeTab edge="left" tone={tone} />);
    const tab = container.querySelector(".capsule-tab") as HTMLButtonElement;
    return { tab, unmount };
  }

  function hover(tab: HTMLElement) {
    fireEvent.pointerEnter(tab, { pointerId: 1, pointerType: "mouse" });
  }

  it("单击只触发一次「恢复 + 展开」事务", () => {
    const { tab } = renderTab();
    fireEvent.pointerDown(tab, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      screenX: 10,
      screenY: 20,
    });
    fireEvent.pointerUp(tab, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 21,
    });

    expect(restoreTab).toHaveBeenCalledTimes(1);
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });
  });

  it("指针 click（detail≠0）不重复恢复；键盘激活才恢复", () => {
    const { tab } = renderTab();
    fireEvent.click(tab, { detail: 1 });
    expect(restoreTab).not.toHaveBeenCalled();

    fireEvent.click(tab, { detail: 0 });
    expect(restoreTab).toHaveBeenCalledTimes(1);
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });
  });

  it("右键打开快捷菜单：阻止原生菜单、不触发恢复、不进入拖动", () => {
    const { tab } = renderTab();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    act(() => {
      tab.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(showTabMenu).toHaveBeenCalledWith("left");
    expect(restoreTab).not.toHaveBeenCalled();
    expect(beginTabDrag).not.toHaveBeenCalled();
    expect(tab.classList.contains("is-dragging")).toBe(false);
  });

  it("悬停 350ms 才显示提示，内容是真实状态 + 操作提示", () => {
    const { tab } = renderTab("running");
    hover(tab);
    expect(showTabHint).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(showTabHint).toHaveBeenCalledTimes(1);
    expect(showTabHint).toHaveBeenCalledWith("left", "Agent 运行中 · 点击展开 · 拖拽移动");
  });

  it("未加载 / 空闲状态不宣称具体 Agent 状态", () => {
    const { tab } = renderTab("unknown");
    hover(tab);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(showTabHint).toHaveBeenCalledWith("left", "点击展开 · 拖拽移动");
  });

  it("离开标签立即收起提示并取消未到点的计时", () => {
    const { tab } = renderTab("waiting");
    hover(tab);
    fireEvent.pointerLeave(tab, { pointerId: 1, pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(showTabHint).not.toHaveBeenCalled();
    expect(hideTabHint).toHaveBeenCalled();
  });

  it("按下即收起提示：拖动期间不会再弹", () => {
    const { tab } = renderTab("idle");
    hover(tab);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(showTabHint).toHaveBeenCalledTimes(1);
    hideTabHint.mockClear();

    fireEvent.pointerDown(tab, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      screenX: 10,
      screenY: 20,
    });
    expect(hideTabHint).toHaveBeenCalledTimes(1);

    // 拖动中即便跨过 350ms 也不再显示
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(showTabHint).toHaveBeenCalledTimes(1);
  });

  it("窗口失焦与卸载都会收起提示（不留悬空窗口）", () => {
    const { tab, unmount } = renderTab("failed");
    hover(tab);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    hideTabHint.mockClear();
    fireEvent.blur(window);
    expect(hideTabHint).toHaveBeenCalledTimes(1);

    unmount();
    expect(hideTabHint.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("指针捕获丢失（窗口移动/提示窗显隐）时，窗口级 pointerup 仍能收尾", () => {
    // 真机根因：拖动期间窗口被 setPosition 移动 + 悬停提示窗隐藏，WebView2 会丢
    // 元素级指针捕获，元素收不到 pointerup → `.is-dragging` 永久残留。
    // 窗口级兜底必须能结束会话，并且照常按屏幕坐标判定手势。
    const { tab } = renderTab();
    fireEvent.pointerDown(tab, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      screenX: 10,
      screenY: 20,
    });
    fireEvent.pointerMove(tab, {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 1,
      screenX: 10,
      screenY: 34,
    });
    expect(tab.classList.contains("is-dragging")).toBe(true);

    // 元素没收到 pointerup：只在 window 上派发（捕获阶段）
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 34,
    });

    expect(tab.classList.contains("is-dragging")).toBe(false);
    expect(endTabDrag).toHaveBeenCalledTimes(1);
    // 沿边 14px → 纯拖动，不触发恢复
    expect(restoreTab).not.toHaveBeenCalled();
  });

  it("窗口级 pointerup 的单击判定与元素一致（只恢复一次）", () => {
    const { tab } = renderTab();
    fireEvent.pointerDown(tab, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      screenX: 10,
      screenY: 20,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 21,
    });
    expect(restoreTab).toHaveBeenCalledTimes(1);
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });
  });

  it("窗口级 pointercancel 只收尾、不恢复形态", () => {
    const { tab } = renderTab();
    fireEvent.pointerDown(tab, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      screenX: 10,
      screenY: 20,
    });
    fireEvent.pointerCancel(window, { pointerId: 1, pointerType: "mouse" });
    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(restoreTab).not.toHaveBeenCalled();
    expect(tab.classList.contains("is-dragging")).toBe(false);
  });

  it("过渡态（appear≠idle）不弹提示", () => {
    const { container } = render(<EdgeTab edge="left" tone="running" appear="out" />);
    const tab = container.querySelector(".capsule-tab") as HTMLButtonElement;
    hover(tab);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(showTabHint).not.toHaveBeenCalled();
  });
});
