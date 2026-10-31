/**
 * @vitest-environment jsdom
 */
//! 吸附反馈层测试（v0.7：隐藏态短胶囊已由分类胶囊取代）。
//!
//! 验收点：
//! - 只有拖拽（candidate）相位才渲染光晕 / 停靠细线 / 「松开吸附」提示；
//! - 停靠相位不再渲染任何覆盖层（窗口已被区域裁成胶囊，覆盖层不可见）；
//! - 「已吸附」反馈 1.2s 后自动清除（不残留）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import SnapOverlay from "./SnapOverlay";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { SNAP_FEEDBACK_MS } from "../lib/edgeSnap";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEdgeSnapStore.getState().reset();
});

function setSnap(p: Partial<ReturnType<typeof useEdgeSnapStore.getState>>) {
  act(() => {
    useEdgeSnapStore.setState(p as never);
  });
}

describe("SnapOverlay · 拖拽反馈", () => {
  it("candidate 相位渲染光晕与高亮细线", () => {
    const { container } = render(<SnapOverlay />);
    setSnap({ phase: "candidate", candidateEdge: "left", magnetized: true });
    expect(container.querySelector(".snap-glow-left")).toBeTruthy();
    expect(container.querySelector(".snap-dock-line-left")).toBeTruthy();
    expect(container.querySelector(".snap-dock-line-hot")).toBeTruthy();
  });

  it("停靠相位不渲染覆盖层（区域裁剪后覆盖层不可见）", () => {
    const { container } = render(<SnapOverlay />);
    for (const phase of ["docked-visible", "docked-hidden", "docked-revealed"] as const) {
      setSnap({ phase, candidateEdge: null, dockedEdge: "left" });
      expect(container.querySelector(".snap-glow")).toBeNull();
      expect(container.querySelector(".snap-dock-line")).toBeNull();
      expect(container.querySelector(".snap-capsule")).toBeNull();
    }
  });

  it("free 相位什么都不渲染", () => {
    const { container } = render(<SnapOverlay />);
    setSnap({ phase: "free", candidateEdge: null });
    expect(container.innerHTML).toBe("");
  });

  it("停靠反馈 1.2s 后自动清除", async () => {
    vi.useFakeTimers();
    render(<SnapOverlay />);
    setSnap({ phase: "candidate", candidateEdge: "left" });
    act(() => {
      useEdgeSnapStore.getState().notifyDocked("left");
    });
    expect(screen.getByRole("status")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAP_FEEDBACK_MS + 50);
    });
    expect(useEdgeSnapStore.getState().feedback).toBeNull();
  });
});
