/**
 * @vitest-environment jsdom
 */
//! 胶囊 / Edge Tab 的拖拽光标语义回归。
//!
//! 光标本身是视觉交互，jsdom 只能证明「状态类何时加、何时摘」以及 CSS 契约；
//! 真实 WebView2 的系统光标仍需原生证据（见验收报告的 UNVERIFIED 项）。
//!
//! 锁定四件事：
//! 1. 轨道空白处（事件 target 自身带 `data-tauri-drag-region`）按下才进入
//!    `is-dragging`，功能按钮按下不进入，单击分类仍只触发一次 onSelect；
//! 2. 任一结束信号（pointerup / pointercancel / blur / visibilitychange /
//!    恢复后 buttons=0 的 pointermove）都会复位，且一次会话只装一组监听；
//! 3. Edge Tab 单击（位移 < 4px）全程不点亮 grabbing，且照常恢复胶囊；
//! 4. CSS：轨道空白 grab → 拖动 grabbing；标签悬停 grab → 拖动 grabbing。

import { act, fireEvent, render } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CapsuleRail from "./CapsuleRail";
import EdgeTab from "./EdgeTab";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import type { RailStatus } from "../../lib/capsuleModel";
import type { SnapEdge } from "../../lib/edgeSnap";
import stylesCss from "../../styles.css?raw";
import uiCss from "../../styles-ui.css?raw";

const STATUS: RailStatus = {
  agentTone: "idle",
  agentAttention: 0,
  agentRunning: 0,
  agentsLoaded: true,
  taskBadge: null,
  pending: 0,
  overdue: 0,
  tasksLoaded: true,
  inboxBadge: null,
  inboxCount: null,
};

function renderRail(edge: SnapEdge = "left") {
  const onSelect = vi.fn();
  const view = render(
    <CapsuleRail
      edge={edge}
      status={STATUS}
      active="tasks"
      expanded={false}
      onSelect={onSelect}
      onCollapse={() => {}}
    />
  );
  const rail = view.container.querySelector(".capsule-rail") as HTMLDivElement;
  return { view, rail, onSelect };
}

describe("CapsuleRail 拖拽光标", () => {
  it("轨道根节点是可拖表面，按钮不参与拖拽", () => {
    const { rail } = renderRail();
    expect(rail.dataset.tauriDragRegion).toBeDefined();
    expect(rail.classList.contains("ui-drag-surface")).toBe(true);
    expect(rail.classList.contains("ui-drag-session")).toBe(true);

    const buttons = Array.from(rail.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(btn.hasAttribute("data-tauri-drag-region")).toBe(false);
      expect(btn.classList.contains("ui-drag-surface")).toBe(false);
    }
  });

  it("空白处按下进入正在拖动，pointerup 复位", () => {
    const { rail } = renderRail();
    fireEvent.pointerDown(rail, { button: 0, buttons: 1 });
    expect(rail.classList.contains("is-dragging")).toBe(true);

    fireEvent.pointerUp(rail);
    expect(rail.classList.contains("is-dragging")).toBe(false);
  });

  it("pointermove 只在按键已松开且越过起始守卫时复位", () => {
    const { rail } = renderRail();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fireEvent.pointerDown(rail, { button: 0, buttons: 1 });
    fireEvent.pointerMove(rail, { buttons: 1 });
    expect(rail.classList.contains("is-dragging")).toBe(true);

    // 起始 120ms 内 buttons=0 是启动扰动，不结束
    fireEvent.pointerMove(rail, { buttons: 0 });
    expect(rail.classList.contains("is-dragging")).toBe(true);

    now = 1300;
    fireEvent.pointerMove(rail, { buttons: 0 });
    expect(rail.classList.contains("is-dragging")).toBe(false);
  });

  it("pointercancel / 页面隐藏立即复位；blur 起始内不复位，守卫期后复位", () => {
    const { rail } = renderRail();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    fireEvent.pointerDown(rail, { button: 0, buttons: 1 });
    fireEvent.pointerCancel(rail);
    expect(rail.classList.contains("is-dragging")).toBe(false);

    fireEvent.pointerDown(rail, { button: 0, buttons: 1 });
    fireEvent.blur(window);
    expect(rail.classList.contains("is-dragging")).toBe(true);

    now = 1300;
    fireEvent.blur(window);
    expect(rail.classList.contains("is-dragging")).toBe(false);

    now = 2000;
    fireEvent.pointerDown(rail, { button: 0, buttons: 1 });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(rail.classList.contains("is-dragging")).toBe(false);
  });

  it("按在分类按钮上不进入拖动，也不影响单击命中", () => {
    const { rail, onSelect } = renderRail();
    const btn = rail.querySelector(".cap-btn") as HTMLButtonElement;

    fireEvent.pointerDown(btn, { button: 0, buttons: 1 });
    expect(rail.classList.contains("is-dragging")).toBe(false);

    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(rail.classList.contains("is-dragging")).toBe(false);
  });

  it("会话结束后监听成对摘除，卸载不留监听", () => {
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const addDoc = vi.spyOn(document, "addEventListener");
    const removeDoc = vi.spyOn(document, "removeEventListener");

    const { rail, view } = renderRail();
    const docAddsBefore = addDoc.mock.calls.filter((c) => c[0] === "pointerdown").length;
    // 起拖判定是 document 捕获阶段的统一实现（Tauri drag.js 会在 mousedown 里
    // stopImmediatePropagation，pointerdown 先于它且捕获阶段不受影响），
    // 因此挂载后应新增一条 document 级 pointerdown 监听。
    expect(docAddsBefore).toBe(1);

    fireEvent.pointerDown(rail, { button: 0, buttons: 1 });
    fireEvent.pointerUp(rail);

    const active = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.length;
    // 会话期间挂 4 个 window 监听（move/up/cancel/blur）+ 1 个 document(visibilitychange)；
    // 复位后必须逐个摘除，不能只复位状态、留下监听。
    expect(active(addWindow)).toBeGreaterThanOrEqual(4);
    expect(active(removeWindow)).toBeGreaterThanOrEqual(4);
    expect(
      removeDoc.mock.calls.filter((c) => c[0] === "visibilitychange"),
    ).toHaveLength(1);
    // 起拖监听属于挂载期（document 捕获阶段），会话结束不摘、卸载才摘。
    expect(removeDoc.mock.calls.filter((c) => c[0] === "pointerdown")).toHaveLength(0);

    // 卸载时摘掉 document 上的 pointerdown 捕获监听（成对，不残留）
    view.unmount();
    const docRemoves = removeDoc.mock.calls.filter((c) => c[0] === "pointerdown");
    expect(docRemoves).toHaveLength(1);
    expect(docRemoves[0][2]).toBe(true);

    addWindow.mockRestore();
    removeWindow.mockRestore();
    addDoc.mockRestore();
    removeDoc.mockRestore();
  });

  it("CSS：轨道 grab、拖动 grabbing、分类组保持箭头", () => {
    expect(uiCss).toMatch(/\.ui-drag-surface\s*\{\s*cursor:\s*grab;/);
    expect(uiCss).toMatch(/\.ui-drag-session\.is-dragging[^{]*\{[^}]*cursor:\s*grabbing/);
    expect(stylesCss).toMatch(/\.capsule-rail\.is-dragging[^{]*\{[^}]*cursor:\s*grabbing/);
    expect(stylesCss).toMatch(/\.capsule-rail \.cap-nav[^{]*\{[^}]*cursor:\s*default/);
    // 功能按钮仍是 pointer（不被拖动状态覆盖）
    expect(stylesCss).toMatch(/\.cap-btn[^{]*\{[^}]*cursor:\s*pointer/);
  });
});

describe("EdgeTab 拖拽光标", () => {
  const restoreTab = vi.fn();
  const beginTabDrag = vi.fn();
  const dragTabBy = vi.fn();
  const endTabDrag = vi.fn();
  const captureMock = vi.fn();
  const releaseMock = vi.fn();
  const hasCaptureMock = vi.fn(() => true);

  beforeAll(() => {
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: captureMock,
    });
    Object.defineProperty(Element.prototype, "releasePointerCapture", {
      configurable: true,
      value: releaseMock,
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: hasCaptureMock,
    });
  });

  beforeEach(() => {
    restoreTab.mockReset();
    beginTabDrag.mockReset();
    dragTabBy.mockReset();
    endTabDrag.mockReset();
    captureMock.mockReset();
    releaseMock.mockReset();
    hasCaptureMock.mockReset();
    hasCaptureMock.mockReturnValue(true);
    useEdgeSnapStore.setState({
      restoreTab,
      beginTabDrag,
      dragTabBy,
      endTabDrag,
    });
  });

  function renderTab() {
    const { container } = render(<EdgeTab edge="left" tone="idle" />);
    const tab = container.querySelector(".capsule-tab") as HTMLButtonElement;
    return tab;
  }

  it("单击（位移小于阈值）不进入拖动并照常恢复胶囊", () => {
    const tab = renderTab();
    fireEvent.pointerDown(tab, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 10, clientY: 20, screenX: 10, screenY: 20 });
    fireEvent.pointerMove(tab, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 10, clientY: 22, screenX: 10, screenY: 22 });
    expect(tab.classList.contains("is-dragging")).toBe(false);

    fireEvent.pointerUp(tab, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 22, screenX: 10, screenY: 22 });
    expect(tab.classList.contains("is-dragging")).toBe(false);
    expect(restoreTab).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(1);
  });

  it("超过阈值后切入 grabbing，松手复位且不触发恢复", () => {
    const tab = renderTab();
    fireEvent.pointerDown(tab, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 10, clientY: 20, screenX: 10, screenY: 20 });
    fireEvent.pointerMove(tab, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 10, clientY: 23, screenX: 10, screenY: 23 });
    expect(tab.classList.contains("is-dragging")).toBe(false);

    fireEvent.pointerMove(tab, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 10, clientY: 27, screenX: 10, screenY: 27 });
    expect(tab.classList.contains("is-dragging")).toBe(true);

    // 松手后鼠标完全静止：类名必须在同一次 pointerup 里摘掉（Blink 据此重算 cursor），
    // 不能等下一次 pointermove —— 那正是「必须动一下鼠标才恢复」的来源。
    fireEvent.pointerUp(tab, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 27, screenX: 10, screenY: 27 });
    expect(tab.classList.contains("is-dragging")).toBe(false);
    expect(restoreTab).not.toHaveBeenCalled();
    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(1);
  });

  it("拖动中窗口失焦按取消处理：复位光标且不恢复形态", () => {
    const tab = renderTab();
    fireEvent.pointerDown(tab, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 10, clientY: 20, screenX: 10, screenY: 20 });
    fireEvent.pointerMove(tab, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 20, clientY: 20, screenX: 20, screenY: 20 });
    expect(tab.classList.contains("is-dragging")).toBe(true);

    fireEvent.blur(window);
    expect(tab.classList.contains("is-dragging")).toBe(false);
    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(restoreTab).not.toHaveBeenCalled();
  });

  it("pointerup 之后的 lostpointercapture 不重复收尾", () => {
    const tab = renderTab();
    fireEvent.pointerDown(tab, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 10, clientY: 20, screenX: 10, screenY: 20 });
    fireEvent.pointerMove(tab, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 10, clientY: 30, screenX: 10, screenY: 30 });
    fireEvent.pointerUp(tab, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 30, screenX: 10, screenY: 30 });

    // 浏览器在 releasePointerCapture 后仍会派发 lostpointercapture：
    // 会话已收尾，不得再 endDrag 一次（重复提交会让持久化/位置回写跑两遍）。
    fireEvent.lostPointerCapture(tab, { pointerId: 1, pointerType: "mouse" });
    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(tab.classList.contains("is-dragging")).toBe(false);
  });

  it("指针捕获已被系统释放时不再调用 releasePointerCapture", () => {
    const tab = renderTab();
    hasCaptureMock.mockReturnValue(false);
    fireEvent.pointerDown(tab, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 10, clientY: 20, screenX: 10, screenY: 20 });
    fireEvent.pointerUp(tab, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 20, screenX: 10, screenY: 20 });

    expect(releaseMock).not.toHaveBeenCalled();
    expect(restoreTab).toHaveBeenCalledTimes(1);
  });

  it("取消拖动后复位并释放指针捕获", () => {
    const tab = renderTab();
    fireEvent.pointerDown(tab, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 10, clientY: 20, screenX: 10, screenY: 20 });
    fireEvent.pointerMove(tab, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 10, clientY: 40, screenX: 10, screenY: 40 });
    expect(tab.classList.contains("is-dragging")).toBe(true);

    fireEvent.pointerCancel(tab, { pointerId: 1, pointerType: "mouse" });
    expect(tab.classList.contains("is-dragging")).toBe(false);
    expect(releaseMock).toHaveBeenCalledWith(1);
    expect(endTabDrag).toHaveBeenCalledTimes(1);
    expect(restoreTab).not.toHaveBeenCalled();
  });

  it("CSS：悬停 grab，拖动 grabbing", () => {
    // 标签是可拖动表面，不是普通按钮：`pointer` 会让人以为只能点。
    // 与 `.ui-drag-surface` 同一语义，且**只**由 WebView2 的 CSS 光标表达。
    expect(stylesCss).toMatch(/\.capsule-tab\s*\{[^}]*cursor:\s*grab/);
    expect(stylesCss).toMatch(/\.capsule-tab\.is-dragging[^{]*\{[^}]*cursor:\s*grabbing/);
  });
});
