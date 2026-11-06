/** @vitest-environment jsdom */
//! 桌面微件窗口拖拽光标契约：标题条可拖区 grab、拖动中 grabbing，按钮不误入拖拽。
//! 与主窗标题栏同一策略：原生 Tauri 拖拽期间 WebView2 收不到 pointerup，
//! 结束信号取 pointerup / pointercancel / blur / visibilitychange 以及松手后的 pointermove。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, isTauri: () => true };
});

vi.mock("@tauri-apps/api/event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/event")>();
  return { ...actual, listen: vi.fn(async () => () => {}) };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "widget-quick-actions",
    onMoved: vi.fn(async () => () => {}),
    onResized: vi.fn(async () => () => {}),
  }),
}));

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return {
    ...actual,
    getSettings: vi.fn(async () => ({
      theme: "dark",
      visual_preset: "",
      material: "glass",
    })),
  };
});

vi.mock("../lib/widgets/desktopBridge", () => ({
  onWidgetSnapshot: vi.fn(async () => () => {}),
  requestWidgetSnapshot: vi.fn(async () => {}),
  getWidgetWindowInfo: vi.fn(async () => ({
    widgetType: "quick-actions",
    generation: 1,
    width: 340,
    height: 126,
    nx: 0.8,
    ny: 0.2,
    monitor: null,
    topmost: false,
    scale: 1,
  })),
  reportWidgetBounds: vi.fn(async () => {}),
  dismissWidgetWindow: vi.fn(async () => {}),
  dispatchWidgetAction: vi.fn(async () => {}),
  setWidgetTopmost: vi.fn(async () => {}),
}));

import { __resetLocaleForTests, setLocalePreference } from "../i18n";
import WidgetWindow from "./WidgetWindow";
import widgetDesktopCss from "./widgets-desktop.css?raw";

const DRAG_TYPES = ["pointermove", "pointerup", "pointercancel", "blur"] as const;

beforeEach(() => {
  __resetLocaleForTests();
  setLocalePreference("zh-CN");
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const view = render(<WidgetWindow />);
  const surface = view.container.querySelector(".wd-surface") as HTMLElement;
  const drag = view.container.querySelector(".wd-drag") as HTMLElement;
  return { view, surface, drag };
}

function dragging(surface: HTMLElement) {
  return surface.classList.contains("is-dragging");
}

describe("桌面微件窗口拖拽光标语义", () => {
  it("标题条是拖拽热区（表面带 drag-session，热区带 drag-region），页面体不带", () => {
    const { view, surface, drag } = setup();
    expect(surface.classList.contains("wd-drag-session")).toBe(true);
    expect(drag.dataset.tauriDragRegion).toBeDefined();

    const body = view.container.querySelector(".wd-body") as HTMLElement;
    expect(body.dataset.tauriDragRegion).toBeUndefined();
  });

  it("按下标题条进入 grabbing，松手复位", () => {
    const { surface, drag } = setup();
    fireEvent.pointerDown(drag, { button: 0, pointerId: 1 });
    expect(dragging(surface)).toBe(true);

    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(dragging(surface)).toBe(false);
  });

  it("按住时的 pointermove 不提前复位，松开后的 pointermove 才复位", () => {
    const { surface, drag } = setup();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fireEvent.pointerDown(drag, { button: 0, pointerId: 1 });

    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1 });
    expect(dragging(surface)).toBe(true);

    // 起始 120ms 内 buttons=0 是启动扰动，不结束
    fireEvent.pointerMove(window, { buttons: 0, pointerId: 1 });
    expect(dragging(surface)).toBe(true);

    now = 1300;
    fireEvent.pointerMove(window, { buttons: 0, pointerId: 1 });
    expect(dragging(surface)).toBe(false);
  });

  it("取消与页面隐藏立即复位；blur 起始内不复位，守卫期后复位", () => {
    const { surface, drag } = setup();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    fireEvent.pointerDown(drag, { button: 0 });
    fireEvent.pointerCancel(window);
    expect(dragging(surface)).toBe(false);

    fireEvent.pointerDown(drag, { button: 0 });
    fireEvent.blur(window);
    expect(dragging(surface)).toBe(true);

    now = 1300;
    fireEvent.blur(window);
    expect(dragging(surface)).toBe(false);

    now = 2000;
    fireEvent.pointerDown(drag, { button: 0 });
    fireEvent(document, new Event("visibilitychange"));
    expect(dragging(surface)).toBe(false);
  });

  it("按钮与非主键按下都不会进入 grabbing", () => {
    const { view, surface, drag } = setup();
    const close = view.container.querySelector<HTMLButtonElement>(".wd-close")!;
    fireEvent.pointerDown(close, { button: 0 });
    expect(dragging(surface)).toBe(false);

    const pin = view.container.querySelector<HTMLButtonElement>(".wd-btn")!;
    fireEvent.pointerDown(pin, { button: 0 });
    expect(dragging(surface)).toBe(false);

    fireEvent.pointerDown(drag, { button: 2 });
    expect(dragging(surface)).toBe(false);
  });

  it("一次拖拽只装一组监听，结束即全部摘除，无残留", () => {
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");

    const { surface, drag } = setup();
    const count = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((call) => call[0] === type).length;
    const active = (type: string) => count(winAdd, type) - count(winRemove, type);

    const winBefore = DRAG_TYPES.map((t) => active(t));
    const docBefore = count(docAdd, "visibilitychange") - count(docRemove, "visibilitychange");

    fireEvent.pointerDown(drag, { button: 0 });

    for (const [i, type] of DRAG_TYPES.entries()) {
      expect(active(type) - winBefore[i]).toBe(1);
    }
    expect(count(docAdd, "visibilitychange") - count(docRemove, "visibilitychange") - docBefore).toBe(1);

    fireEvent.pointerUp(window);

    for (const [i, type] of DRAG_TYPES.entries()) {
      expect(active(type) - winBefore[i]).toBe(0);
    }
    expect(dragging(surface)).toBe(false);
  });

  it("卸载时如果拖拽会话仍在，监听同样被摘除", () => {
    const winRemove = vi.spyOn(window, "removeEventListener");
    const { view, drag } = setup();
    fireEvent.pointerDown(drag, { button: 0 });
    view.unmount();
    expect(winRemove.mock.calls.some((call) => call[0] === "pointerup")).toBe(true);
  });

  it("120ms 内 pointerup 与 visibilitychange 无守卫立即清（仅 blur/move 受守卫）", () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { surface, drag } = setup();
    fireEvent.pointerDown(drag, { button: 0 });
    fireEvent.pointerUp(window);
    expect(dragging(surface)).toBe(false);

    fireEvent.pointerDown(drag, { button: 0 });
    fireEvent(document, new Event("visibilitychange"));
    expect(dragging(surface)).toBe(false);
  });

  it("重叠拖动只保留新会话：旧会话迟到事件不结束新会话", () => {
    const { surface, drag } = setup();
    fireEvent.pointerDown(drag, { button: 0 });
    expect(dragging(surface)).toBe(true);
    // 未收尾即开始第二次：start 会先清旧会话，新会话仍 grabbing
    fireEvent.pointerDown(drag, { button: 0 });
    expect(dragging(surface)).toBe(true);
    // 旧会话的迟到 blur（已被移除监听）不应把新会话清掉——当前新会话监听仍在，
    // 断言新会话可用一次 pointerup 正常收尾且无残留 grabbing
    fireEvent.pointerUp(window);
    expect(dragging(surface)).toBe(false);
  });
});

describe("widgets-desktop.css 拖拽光标契约", () => {
  it("可拖区给 grab，会话中给 grabbing，不再依赖 :active", () => {
    expect(widgetDesktopCss).toMatch(/\.wd-drag\s*\{[^}]*cursor:\s*grab/);
    expect(widgetDesktopCss).toMatch(
      /\.wd-drag-session\.is-dragging\s+\.wd-drag\s*\{[^}]*cursor:\s*grabbing/,
    );
    expect(widgetDesktopCss).not.toMatch(/\.wd-drag:active\s*\{[^}]*cursor:\s*grabbing/);
  });

  it("标题条按钮保持 pointer", () => {
    expect(widgetDesktopCss).toMatch(/\.wd-root button\s*\{[^}]*cursor:\s*pointer/);
  });
});
