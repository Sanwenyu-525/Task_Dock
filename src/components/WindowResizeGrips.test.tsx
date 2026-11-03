/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// 热区边长与四角 cursor 是 Rust 端口命中/光标判定的跨端契约
// （`src-tauri/src/window_cursor.rs` 的 GRIP_CSS 与 cursor 方向）。
import css from "../styles-themes.css?raw";

const { startResizeDragging } = vi.hoisted(() => ({
  startResizeDragging: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startResizeDragging }),
}));

import WindowResizeGrips from "./WindowResizeGrips";

afterEach(() => {
  cleanup();
  startResizeDragging.mockClear();
});

describe("WindowResizeGrips · 四角缩放命中层", () => {
  it("四个角各渲染一个热区", () => {
    const { container } = render(<WindowResizeGrips />);
    expect(container.querySelectorAll(".resize-grip")).toHaveLength(4);
    for (const corner of ["tl", "tr", "bl", "br"]) {
      expect(container.querySelector(`.grip-${corner}`)).toBeTruthy();
    }
  });

  it("主键按下按角调用原生缩放方向", () => {
    const { container } = render(<WindowResizeGrips />);
    const cases = [
      ["tl", "NorthWest"],
      ["tr", "NorthEast"],
      ["bl", "SouthWest"],
      ["br", "SouthEast"],
    ] as const;
    for (const [corner, direction] of cases) {
      fireEvent.pointerDown(container.querySelector(`.grip-${corner}`)!, { button: 0 });
      expect(startResizeDragging).toHaveBeenLastCalledWith(direction);
    }
    expect(startResizeDragging).toHaveBeenCalledTimes(4);
  });

  it("非主键按下不触发缩放", () => {
    const { container } = render(<WindowResizeGrips />);
    fireEvent.pointerDown(container.querySelector(".grip-br")!, { button: 2 });
    expect(startResizeDragging).not.toHaveBeenCalled();
  });

  it("pointerdown 后手柄仍挂载（不依赖 hover，也不随拖拽状态卸载）", () => {
    const { container } = render(<WindowResizeGrips />);
    const tl = container.querySelector<HTMLElement>(".grip-tl")!;
    fireEvent.pointerDown(tl, { button: 0, pointerId: 1 });
    expect(startResizeDragging).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".resize-grip")).toHaveLength(4);
    expect(tl.isConnected).toBe(true);
    expect(tl.className).toBe("resize-grip grip-tl");
  });

  it("拖拽结束（pointerup / pointercancel / 失焦 / Esc）后手柄仍挂载且类名不变", () => {
    const { container } = render(<WindowResizeGrips />);
    const grips = Array.from(container.querySelectorAll<HTMLElement>(".resize-grip"));
    const classesBefore = grips.map((g) => g.className);

    for (const grip of grips) {
      fireEvent.pointerDown(grip, { button: 0, pointerId: 2 });
      // 缩放循环退出后指针仍停在角落：手柄不得被卸载，也不得有拖拽态类名残留。
      fireEvent.pointerUp(grip, { pointerId: 2 });
      fireEvent.pointerCancel(grip, { pointerId: 2 });
    }
    fireEvent.blur(window);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(container.querySelectorAll(".resize-grip")).toHaveLength(4);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".resize-grip")).map(
        (g) => g.className,
      ),
    ).toEqual(classesBefore);
    for (const grip of grips) {
      expect(grip.isConnected).toBe(true);
    }
  });

  it("CSS 契约：热区 12px，四角 cursor 方向正确", () => {
    expect(css).toMatch(/\.resize-grip\s*\{\s*position: absolute;\s*width: 12px;\s*height: 12px;/);
    expect(css).toMatch(/\.resize-grip\.grip-tl\s*\{\s*top: 0;\s*left: 0;\s*cursor: nwse-resize;/);
    expect(css).toMatch(/\.resize-grip\.grip-tr\s*\{\s*top: 0;\s*right: 0;\s*cursor: nesw-resize;/);
    expect(css).toMatch(/\.resize-grip\.grip-bl\s*\{\s*bottom: 0;\s*left: 0;\s*cursor: nesw-resize;/);
    expect(css).toMatch(/\.resize-grip\.grip-br\s*\{\s*bottom: 0;\s*right: 0;\s*cursor: nwse-resize;/);
  });
});
