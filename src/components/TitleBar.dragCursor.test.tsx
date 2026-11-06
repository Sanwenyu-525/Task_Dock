/** @vitest-environment jsdom */
//! 标题栏拖拽光标契约：可拖区 grab、拖动中 grabbing、操作区不误示可拖。
//! 原生 Tauri 拖拽期间 WebView2 收不到指针事件（见 useEdgeSnap 实测结论），
//! 因此结束信号取「指针事件恢复」；这里逐条模拟复位路径并校验监听成对摘除。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import uiCss from "../styles-ui.css?raw";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";
import TitleBar from "./TitleBar";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), hide: vi.fn() }),
}));
vi.mock("../lib/bridge", () => ({ applyMode: vi.fn() }));

const DRAG_TYPES = ["pointermove", "pointerup", "pointercancel", "blur"] as const;

beforeEach(() => {
  useSettingsStore.setState({
    settings: { mode: "full", theme: "light", visual_preset: "aurora" } as never,
  });
  useUiStore.setState({ clipboardOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const view = render(<TitleBar />);
  const bar = view.container.querySelector(".titlebar") as HTMLElement;
  const orb = view.container.querySelector(".brand-orb") as HTMLElement;
  return { view, bar, orb };
}

function dragging(bar: HTMLElement) {
  return bar.classList.contains("is-dragging");
}

describe("标题栏拖拽光标语义", () => {
  it("标题栏与品牌球/标题是拖拽热区，操作区不是", () => {
    const { view, bar } = setup();
    expect(bar.dataset.tauriDragRegion).toBeDefined();
    expect(bar.classList.contains("ui-drag-surface")).toBe(true);
    expect(bar.classList.contains("ui-drag-session")).toBe(true);

    for (const selector of [".brand-orb", ".titlebar-title"]) {
      const el = view.container.querySelector(selector) as HTMLElement;
      expect(el.dataset.tauriDragRegion).toBeDefined();
      expect(el.classList.contains("ui-drag-surface")).toBe(true);
    }

    const actions = view.container.querySelector(".titlebar-actions") as HTMLElement;
    expect(actions.dataset.tauriDragRegion).toBeUndefined();
    expect(actions.classList.contains("ui-drag-surface")).toBe(false);
    // 窗口操作按钮由全局 button 规则给 pointer，不属于拖拽热区
    const buttons = actions.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) expect(btn.dataset.tauriDragRegion).toBeUndefined();
  });

  it("按下拖拽区进入 grabbing，松手复位", () => {
    const { bar, orb } = setup();
    fireEvent.pointerDown(orb, { button: 0, pointerId: 1 });
    expect(dragging(bar)).toBe(true);

    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(dragging(bar)).toBe(false);
  });

  it("按住时的 pointermove 不提前复位，松开后的 pointermove 才复位", () => {
    const { bar, orb } = setup();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fireEvent.pointerDown(orb, { button: 0, pointerId: 1 });

    // 原生移动循环真正开始前的最后几毫秒仍可能收到按住状态的移动事件
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1 });
    expect(dragging(bar)).toBe(true);

    // 起始 120ms 内的 buttons=0 合成移动是启动扰动，不结束会话
    fireEvent.pointerMove(window, { buttons: 0, pointerId: 1 });
    expect(dragging(bar)).toBe(true);

    // 守卫期之后，循环内无事件→恢复收到且按键已放开 = 拖拽结束
    now = 1300;
    fireEvent.pointerMove(window, { buttons: 0, pointerId: 1 });
    expect(dragging(bar)).toBe(false);
  });

  it("取消与页面隐藏立即复位；起始内 blur 不结束，守卫期后真实失焦才复位", () => {
    const { bar, orb } = setup();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    fireEvent.pointerDown(orb, { button: 0 });
    fireEvent.pointerCancel(window);
    expect(dragging(bar)).toBe(false);

    // 起始扰动：原生拖动启动激活窗口引发的即时 blur 不切断会话
    fireEvent.pointerDown(orb, { button: 0 });
    fireEvent.blur(window);
    expect(dragging(bar)).toBe(true);

    // 守卫期后：真实切走失焦可靠清理
    now = 1300;
    fireEvent.blur(window);
    expect(dragging(bar)).toBe(false);

    now = 2000;
    fireEvent.pointerDown(orb, { button: 0 });
    fireEvent(document, new Event("visibilitychange"));
    expect(dragging(bar)).toBe(false);
  });

  it("按钮、操作区空白与非主键按下都不会进入 grabbing", () => {
    const { view, bar } = setup();
    const minimize = view.container.querySelector<HTMLButtonElement>('button[aria-label="最小化"]')!;

    fireEvent.pointerDown(minimize, { button: 0 });
    expect(dragging(bar)).toBe(false);

    const actions = view.container.querySelector(".titlebar-actions") as HTMLElement;
    fireEvent.pointerDown(actions, { button: 0 });
    expect(dragging(bar)).toBe(false);

    fireEvent.pointerDown(view.container.querySelector(".brand-orb")!, { button: 2 });
    expect(dragging(bar)).toBe(false);
  });

  it("一次拖拽只装一组监听，结束即全部摘除，无残留", () => {
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");

    const { orb } = setup();
    const count = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((call) => call[0] === type).length;
    const active = (type: string) => count(winAdd, type) - count(winRemove, type);

    const winBefore = DRAG_TYPES.map((t) => active(t));
    const docBefore = count(docAdd, "visibilitychange") - count(docRemove, "visibilitychange");

    fireEvent.pointerDown(orb, { button: 0 });

    for (const [i, type] of DRAG_TYPES.entries()) {
      expect(active(type) - winBefore[i]).toBe(1);
    }
    expect(count(docAdd, "visibilitychange") - count(docRemove, "visibilitychange") - docBefore).toBe(1);

    fireEvent.pointerUp(window);

    for (const [i, type] of DRAG_TYPES.entries()) {
      expect(active(type) - winBefore[i]).toBe(0);
      expect(count(winRemove, type)).toBeGreaterThanOrEqual(1);
    }
    expect(count(docAdd, "visibilitychange") - count(docRemove, "visibilitychange") - docBefore).toBe(0);
    expect(count(docRemove, "visibilitychange")).toBeGreaterThanOrEqual(1);
  });

  it("卸载时如果拖拽会话仍在，监听同样被摘除", () => {
    const winRemove = vi.spyOn(window, "removeEventListener");
    const { view, orb } = setup();
    fireEvent.pointerDown(orb, { button: 0 });
    view.unmount();
    expect(
      winRemove.mock.calls.some((call) => call[0] === "pointerup"),
    ).toBe(true);
  });
});

describe("styles-ui.css 拖拽光标契约", () => {
  it("可拖区给 grab，会话中给 grabbing", () => {
    expect(uiCss).toMatch(/\.ui-drag-surface\s*\{[^}]*cursor:\s*grab/);
    expect(uiCss).toMatch(
      /\.ui-drag-session\.is-dragging\s*,\s*\.ui-drag-session\.is-dragging\s+\.ui-drag-surface\s*\{[^}]*cursor:\s*grabbing/,
    );
  });

  it("标题栏操作区空白保持默认箭头", () => {
    expect(uiCss).toMatch(/\.titlebar-actions\s*\{[^}]*cursor:\s*default/);
  });

  it("暂存架灯箱平移中给 grabbing", () => {
    expect(uiCss).toMatch(/\.shelf-lightbox-stage\.is-dragging[^{]*\{[^}]*cursor:\s*grabbing/);
  });
});
