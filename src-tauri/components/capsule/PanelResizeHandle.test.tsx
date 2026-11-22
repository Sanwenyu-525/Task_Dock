/**
 * @vitest-environment jsdom
 */
//! 工具面板宽度拖拽手柄：方向映射、收敛、键盘与无障碍契约。
//!
//! 只测手势 → `resizePanel(width, commit)` 的调用；区域重写与持久化由
//! `useEdgeSnap.integration.test.tsx` 覆盖。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PanelResizeHandle, { widthFromDragDelta, widthFromKey } from "./PanelResizeHandle";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";

/** rAF 在 jsdom 里可能被 fake timers 接管：用微任务把一帧推完。 */
async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("宽度映射（纯函数）", () => {
  it("左停靠 +dx、右停靠 −dx、上/下停靠 +2×dx", () => {
    expect(widthFromDragDelta("left", 340, 50)).toBe(390);
    expect(widthFromDragDelta("right", 340, 50)).toBe(290);
    expect(widthFromDragDelta("top", 340, 50)).toBe(440);
    expect(widthFromDragDelta("bottom", 340, 50)).toBe(440);
  });

  it("键盘方向按视觉方向：← 收窄、→ 加宽（右停靠相反）", () => {
    expect(widthFromKey("left", 340, -8)).toBe(332);
    expect(widthFromKey("left", 340, 8)).toBe(348);
    expect(widthFromKey("right", 340, 8)).toBe(332);
    expect(widthFromKey("top", 340, 8)).toBe(348);
  });

  it("收敛到 280–480", () => {
    expect(widthFromDragDelta("left", 340, 999)).toBe(480);
    expect(widthFromDragDelta("left", 340, -999)).toBe(280);
    expect(widthFromKey("left", 478, 8)).toBe(480);
  });
});

describe("PanelResizeHandle", () => {
  const resizePanel = vi.fn();

  beforeEach(() => {
    resizePanel.mockReset();
    useEdgeSnapStore.setState({ panelWidth: 340, resizePanel });
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
    useEdgeSnapStore.getState().reset();
  });

  function mount(edge: "left" | "right" | "top" | "bottom" = "left") {
    return render(<PanelResizeHandle edge={edge} />);
  }

  function drag(fromX: number, toX: number) {
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, screenX: fromX });
    fireEvent.pointerMove(window, { pointerId: 1, screenX: toX });
    fireEvent.pointerUp(window, { pointerId: 1, screenX: toX });
  }

  it("左停靠拖拽：逐帧更新不提交，松手提交最终宽度", async () => {
    mount("left");
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, screenX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, screenX: 160 });
    await nextFrame();
    expect(resizePanel).toHaveBeenLastCalledWith(400, false);
    fireEvent.pointerUp(window, { pointerId: 1, screenX: 160 });
    expect(resizePanel).toHaveBeenLastCalledWith(400, true);
  });

  it("右停靠：手柄在面板左侧，向右拖 = 收窄（面板锚定在右侧）", async () => {
    mount("right");
    drag(50, 100);
    expect(resizePanel).toHaveBeenLastCalledWith(290, true);
  });

  it("上/下停靠：面板居中对称展开，宽度按 2×dx 变化", async () => {
    mount("bottom");
    drag(100, 140);
    expect(resizePanel).toHaveBeenLastCalledWith(420, true);
  });

  it("拖过上下限按 280–480 收敛；rAF 只提交最后一帧", async () => {
    mount("left");
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, screenX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, screenX: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, screenX: 900 });
    await nextFrame();
    // 同一帧内只发一次（rAF 合并），值已收敛到上限
    expect(resizePanel).toHaveBeenCalledTimes(1);
    expect(resizePanel).toHaveBeenLastCalledWith(480, false);
    fireEvent.pointerUp(window, { pointerId: 1, screenX: 900 });
    expect(resizePanel).toHaveBeenLastCalledWith(480, true);
  });

  it("键盘 ←/→、Shift 大步长、Home/End 与双击恢复默认", () => {
    mount("left");
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(resizePanel).toHaveBeenLastCalledWith(348, true);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(resizePanel).toHaveBeenLastCalledWith(340, true);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(resizePanel).toHaveBeenLastCalledWith(372, true);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(resizePanel).toHaveBeenLastCalledWith(280, true);
    fireEvent.keyDown(handle, { key: "End" });
    expect(resizePanel).toHaveBeenLastCalledWith(480, true);
    fireEvent.doubleClick(handle);
    expect(resizePanel).toHaveBeenLastCalledWith(340, true);
  });

  it("无障碍：separator + 数值范围 + 提示；未注入 resizePanel 时不渲染", () => {
    mount("left");
    const handle = screen.getByRole("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("调整工具面板宽度");
    expect(handle.getAttribute("aria-valuemin")).toBe("280");
    expect(handle.getAttribute("aria-valuemax")).toBe("480");
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    expect(handle.getAttribute("aria-valuetext")).toBe("340 像素");
    expect(handle.getAttribute("data-tip")).toContain("双击恢复默认");
    expect(handle.tabIndex).toBe(0);

    cleanup();
    useEdgeSnapStore.setState({ resizePanel: null });
    render(<PanelResizeHandle edge="left" />);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
