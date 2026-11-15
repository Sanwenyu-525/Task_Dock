// @vitest-environment jsdom
//! 工作台自绘标题栏的窗口控制：无障碍名称、三按钮行为、最大化状态图标。
//!
//! 只测组件契约（真实窗口行为由原生验收覆盖）：非 Tauri 环境下注入窗口替身，
//! 不依赖 `window.__TAURI_INTERNALS__`。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkbenchWindowControls, {
  type WorkbenchWindowHandle,
} from "./WorkbenchWindowControls";

type FakeWindow = WorkbenchWindowHandle & {
  setMaximized: (value: boolean) => void;
  fireResize: () => void;
};

function fakeWindow(): FakeWindow {
  let maximized = false;
  let resizeHandler: (() => void) | null = null;
  return {
    isMaximized: vi.fn(async () => maximized),
    onResized: vi.fn(async (handler: () => void) => {
      resizeHandler = handler;
      return () => {
        resizeHandler = null;
      };
    }),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {
      maximized = !maximized;
    }),
    close: vi.fn(async () => {}),
    setMaximized: (value: boolean) => {
      maximized = value;
    },
    fireResize: () => resizeHandler?.(),
  };
}

afterEach(cleanup);

describe("WorkbenchWindowControls", () => {
  it("三个按钮都有清晰的名称，且整簇显式排除在拖动区之外", () => {
    render(<WorkbenchWindowControls window={fakeWindow()} />);

    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭工作台" })).toBeTruthy();

    const group = screen.getByRole("group", { name: "窗口控制" });
    // Tauri 拖动脚本对 `data-tauri-drag-region="false"` 直接拒绝拖动：
    // 按钮之间的间隙也不会把点击吞成窗口移动。
    expect(group.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("最小化/最大化/关闭点击落到对应的窗口 API", () => {
    const win = fakeWindow();
    render(<WorkbenchWindowControls window={win} />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(win.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台" }));
    // 关闭走窗口 close()（Rust 侧保存几何后销毁），不是隐藏窗口或退出进程。
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("最大化图标跟随真实窗口状态，并随 resize 事件更新", async () => {
    const win = fakeWindow();
    render(<WorkbenchWindowControls window={win} />);

    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();

    await act(async () => {
      win.setMaximized(true);
      win.fireResize();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();

    await act(async () => {
      win.setMaximized(false);
      win.fireResize();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
  });
});
