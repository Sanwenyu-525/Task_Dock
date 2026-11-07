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

const showTabHint = vi.fn(async () => true);
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

  it("按键仍按下时提前丢失捕获：不结束手势，窗口级移动继续，松手补齐末段位移", () => {
    // 真机序列：pointerdown → 拖动 → WebView2 因窗口 setPosition/提示窗隐藏
    // 提前 lostpointercapture（此时左键仍按下）→ 鼠标继续移动 → 用户松手。
    // 旧实现会在第 3 步直接 finish 并摘掉窗口兜底，拖动中途停住、末段位移丢失。
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
      screenY: 40,
    });
    expect(tab.classList.contains("is-dragging")).toBe(true);

    fireEvent.lostPointerCapture(tab, {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 1,
      screenX: 10,
      screenY: 40,
    });
    expect(endTabDrag).not.toHaveBeenCalled();
    expect(tab.classList.contains("is-dragging")).toBe(true);

    // 元素已无捕获：后续移动/松手只从 window 捕获阶段到达
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 1,
      screenX: 10,
      screenY: 60,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 60,
    });

    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(tab.classList.contains("is-dragging")).toBe(false);
    expect(restoreTab).not.toHaveBeenCalled();
    // 松手坐标（累计 40px）必须作为最后一段有效位移提交
    expect(dragTabBy).toHaveBeenCalledWith(40);
  });

  it("提前丢失捕获后 pointerup 也丢失（buttons=0 的移动）仍能收尾一次", () => {
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
      screenY: 42,
    });
    fireEvent.lostPointerCapture(tab, {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 1,
      screenX: 10,
      screenY: 42,
    });

    // 系统只再给了一次“已松开”的移动：不能把该坐标当成松手位置
    // （指针可能在标签外松开后又移回来，会误判为向内恢复）。
    // 只补交最后一次按键按下时的可信位移，然后无恢复地收尾。
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 0,
      screenX: 10,
      screenY: 50,
    });

    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(tab.classList.contains("is-dragging")).toBe(false);
    expect(restoreTab).not.toHaveBeenCalled();
    expect(dragTabBy).toHaveBeenCalledWith(22);
  });

  it("正常松手后的 lostpointercapture 与重复 pointerup 只收尾一次", () => {
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
      screenY: 40,
    });
    fireEvent.pointerUp(tab, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 40,
    });
    // 浏览器 releasePointerCapture 后仍派发 lostpointercapture；窗口兜底也可能
    // 收到同一个 pointerup。会话已收尾，不得重复 endDrag / 重复恢复。
    fireEvent.lostPointerCapture(tab, {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 0,
      screenX: 10,
      screenY: 40,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 40,
    });

    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(restoreTab).not.toHaveBeenCalled();
    expect(tab.classList.contains("is-dragging")).toBe(false);
  });

  it("其他 pointerId 的 lostpointercapture / cancel 不会结束当前手势", () => {
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
      screenY: 40,
    });

    fireEvent.lostPointerCapture(tab, { pointerId: 2, pointerType: "mouse", buttons: 0 });
    fireEvent.pointerCancel(tab, { pointerId: 2, pointerType: "mouse" });
    expect(endTabDrag).not.toHaveBeenCalled();
    expect(tab.classList.contains("is-dragging")).toBe(true);

    fireEvent.pointerUp(tab, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 40,
    });
    expect(endTabDrag).toHaveBeenCalledTimes(1);
  });

  it("丢失捕获时的单击仍只恢复一次（事件坐标判定）", () => {
    const { tab } = renderTab();
    fireEvent.pointerDown(tab, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      screenX: 10,
      screenY: 20,
    });
    // 未超过 4px：正常松手时捕获已由系统释放，lostpointercapture 带 buttons=0
    fireEvent.lostPointerCapture(tab, {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 0,
      screenX: 10,
      screenY: 21,
    });
    fireEvent.pointerUp(tab, {
      pointerId: 1,
      pointerType: "mouse",
      screenX: 10,
      screenY: 21,
    });

    expect(restoreTab).toHaveBeenCalledTimes(1);
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });
    expect(endTabDrag).toHaveBeenCalledTimes(1);
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

  // ── 悬停期间 Agent 状态变化（2026-11-07 round3）─────────────────

  function renderLiveTab(tone = "idle") {
    const view = render(<EdgeTab edge="left" tone={tone} />);
    const tab = view.container.querySelector(".capsule-tab") as HTMLButtonElement;
    return { ...view, tab };
  }

  /** 刷新 Promise 链（showTabHint 兑现 → 单飞队列补发）。 */
  async function flushPromises() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  describe("悬停期间状态变化", () => {
    it("提示已显示时文案变化：原地更新，不先 hide 再闪现", async () => {
      const { tab, rerender } = renderLiveTab("running");
      hover(tab);
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(showTabHint).toHaveBeenLastCalledWith("left", "Agent 运行中 · 点击展开 · 拖拽移动");
      await flushPromises();
      hideTabHint.mockClear();

      rerender(<EdgeTab edge="left" tone="waiting" />);
      await flushPromises();

      expect(showTabHint).toHaveBeenCalledTimes(2);
      expect(showTabHint).toHaveBeenLastCalledWith("left", "Agent 等待确认 · 点击展开 · 拖拽移动");
      expect(hideTabHint).not.toHaveBeenCalled();
    });

    it("350ms 延迟期间状态变化：最终显示最新文案", () => {
      const { tab, rerender } = renderLiveTab("running");
      hover(tab);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(showTabHint).not.toHaveBeenCalled();

      rerender(<EdgeTab edge="left" tone="failed" />);
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(showTabHint).toHaveBeenCalledTimes(1);
      expect(showTabHint).toHaveBeenCalledWith("left", "Agent 状态异常 · 点击展开 · 拖拽移动");
    });

    it("连续快速状态变化：合并为最新文案，不产生 IPC 洪泛", async () => {
      const { tab, rerender } = renderLiveTab("running");
      hover(tab);
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(showTabHint).toHaveBeenCalledTimes(1);

      rerender(<EdgeTab edge="left" tone="waiting" />);
      rerender(<EdgeTab edge="left" tone="failed" />);
      rerender(<EdgeTab edge="left" tone="idle" />);
      await flushPromises();

      // 首轮 + 在途合并后的一次补发；最终一定是「最后状态」的文案
      expect(showTabHint.mock.calls.length).toBeLessThanOrEqual(3);
      expect(showTabHint).toHaveBeenLastCalledWith("left", "点击展开 · 拖拽移动");
    });

    it("同一文案不产生重复 IPC（空闲/未知都回落到中性文案）", async () => {
      const { tab, rerender } = renderLiveTab("idle");
      hover(tab);
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(showTabHint).toHaveBeenCalledTimes(1);

      rerender(<EdgeTab edge="left" tone="idle" />);
      rerender(<EdgeTab edge="left" tone="unknown" />);
      await flushPromises();
      expect(showTabHint).toHaveBeenCalledTimes(1);
    });

    it("鼠标离开后状态变化不再显示提示", async () => {
      const { tab, rerender } = renderLiveTab("running");
      hover(tab);
      act(() => {
        vi.advanceTimersByTime(350);
      });
      fireEvent.pointerLeave(tab, { pointerId: 1, pointerType: "mouse" });
      showTabHint.mockClear();

      rerender(<EdgeTab edge="left" tone="failed" />);
      await flushPromises();
      expect(showTabHint).not.toHaveBeenCalled();
    });

    it("拖动期间状态变化不显示提示", async () => {
      const { tab, rerender } = renderLiveTab("running");
      hover(tab);
      fireEvent.pointerDown(tab, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        screenX: 10,
        screenY: 20,
      });
      showTabHint.mockClear();

      rerender(<EdgeTab edge="left" tone="failed" />);
      await flushPromises();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(showTabHint).not.toHaveBeenCalled();
    });

    it("形变过渡开始即收起提示，过渡期间状态变化不再显示", async () => {
      const { tab, rerender } = renderLiveTab("running");
      hover(tab);
      act(() => {
        vi.advanceTimersByTime(350);
      });
      hideTabHint.mockClear();

      rerender(<EdgeTab edge="left" tone="running" appear="out" />);
      expect(hideTabHint).toHaveBeenCalledTimes(1);

      showTabHint.mockClear();
      rerender(<EdgeTab edge="left" tone="failed" appear="out" />);
      await flushPromises();
      expect(showTabHint).not.toHaveBeenCalled();
    });
  });
});
