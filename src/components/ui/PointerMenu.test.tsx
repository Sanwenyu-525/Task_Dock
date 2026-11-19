/**
 * @vitest-environment jsdom
 */
//! 指针右键菜单基元：几何落位、四边翻转、动态尺寸、Escape 不隐藏窗口、焦点策略。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PointerMenu from "./PointerMenu";
import { resetOverlayStack, setWindowEscapeHandler } from "../../lib/overlayStack";

const hideWindow = vi.fn();
const onClose = vi.fn();
let menuSize = { width: 200, height: 120 };
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockRect() {
  rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const isMenu = this.classList.contains("ui-pointer-menu");
    const width = isMenu ? menuSize.width : 0;
    const height = isMenu ? menuSize.height : 0;
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      toJSON: () => ({ width, height }),
    } as DOMRect;
  });
}

function renderMenu(x: number, y: number, trapFocus = true) {
  return render(
    <PointerMenu open x={x} y={y} label="测试菜单" onClose={onClose} trapFocus={trapFocus}>
      <button type="button" role="menuitem" data-autofocus>
        第一项
      </button>
      <button type="button" role="menuitem">
        第二项
      </button>
    </PointerMenu>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOverlayStack();
  setWindowEscapeHandler(hideWindow);
  menuSize = { width: 200, height: 120 };
  mockRect();
});

afterEach(() => {
  cleanup();
  rectSpy?.mockRestore();
  rectSpy = null;
  resetOverlayStack();
  setWindowEscapeHandler(null);
});

describe("PointerMenu 定位", () => {
  it("空间足够时从指针右下展开", () => {
    renderMenu(100, 100);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("100px");
  });

  it("靠近右下角时向左、向上翻转，菜单不越出窗口", () => {
    renderMenu(1000, 700);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe(`${1000 - 200}px`);
    expect(menu.style.top).toBe(`${700 - 120}px`);
    expect(parseInt(menu.style.left, 10)).toBeGreaterThanOrEqual(8);
    expect(parseInt(menu.style.left, 10) + 200).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(parseInt(menu.style.top, 10) + 120).toBeLessThanOrEqual(window.innerHeight - 8);
  });

  it("内容尺寸变化后重新收敛（禁用项/字体加载）", async () => {
    renderMenu(700, 300);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("700px");

    menuSize = { width: 400, height: 120 };
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(menu.style.left).toBe(`${700 - 400}px`));
  });
});

describe("PointerMenu 生命周期", () => {
  it("Escape 只关闭菜单，不会触发窗口级隐藏", async () => {
    renderMenu(100, 100);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeNull());

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("点击菜单外部关闭，点击内部不关闭", () => {
    renderMenu(100, 100);
    fireEvent.pointerDown(screen.getByText("第二项"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("默认把焦点移到第一项并圈在菜单内", async () => {
    renderMenu(100, 100);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("第一项")));
  });

  it("trapFocus=false 时绝不抢焦点（分割线比例菜单）", async () => {
    renderMenu(100, 100, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.activeElement).not.toBe(screen.getByText("第一项"));
  });

  it("方向键在菜单项之间移动", async () => {
    renderMenu(100, 100);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("第一项")));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("第二项"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("第一项"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(document.activeElement).toBe(screen.getByText("第二项"));
  });
});
