// @vitest-environment jsdom
//! 工作台标题栏「置顶 / 取消置顶」按钮：名称、状态反馈、真实状态校准。
//!
//! 只测组件契约（真实 alwaysOnTop 行为由原生真机验收覆盖）：注入窗口替身，
//! 不依赖 `window.__TAURI_INTERNALS__`。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkbenchPinButton, { type WorkbenchPinHandle } from "./WorkbenchPinButton";

type FakeWindow = WorkbenchPinHandle & {
  setPinnedExternally: (value: boolean) => void;
  fireFocus: (focused: boolean) => void;
  setAlwaysOnTopFails: (value: boolean) => void;
};

function fakeWindow(initial = false): FakeWindow {
  let pinned = initial;
  let focusHandler: ((event: { payload: boolean }) => void) | null = null;
  let fail = false;
  return {
    isAlwaysOnTop: vi.fn(async () => pinned),
    setAlwaysOnTop: vi.fn(async (value: boolean) => {
      if (fail) throw new Error("denied");
      pinned = value;
    }),
    onFocusChanged: vi.fn(
      async (handler: (event: { payload: boolean }) => void) => {
        focusHandler = handler;
        return () => {
          focusHandler = null;
        };
      },
    ),
    setPinnedExternally: (value: boolean) => {
      pinned = value;
    },
    fireFocus: (focused: boolean) => focusHandler?.({ payload: focused }),
    setAlwaysOnTopFails: (value: boolean) => {
      fail = value;
    },
  };
}

afterEach(cleanup);

describe("WorkbenchPinButton", () => {
  it("默认显示「置顶窗口」，并显式排除在拖动区之外", () => {
    const win = fakeWindow();
    render(<WorkbenchPinButton window={win} />);

    const button = screen.getByRole("button", { name: "置顶窗口" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("点击切换 alwaysOnTop，并用真实状态更新激活态与文案", async () => {
    const win = fakeWindow();
    render(<WorkbenchPinButton window={win} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置顶窗口" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true);
    const pinned = screen.getByRole("button", { name: "取消置顶" });
    expect(pinned.getAttribute("aria-pressed")).toBe("true");
    expect(pinned.className).toContain("is-on");

    await act(async () => {
      fireEvent.click(pinned);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "置顶窗口" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("图标不用斜线：未置顶空心、置顶实心（2026-11-17 用户反馈）", async () => {
    const win = fakeWindow();
    render(<WorkbenchPinButton window={win} />);

    const offSvg = screen.getByRole("button", { name: "置顶窗口" }).querySelector("svg");
    expect(offSvg).toBeTruthy();
    // 空心：无填充。
    expect(offSvg?.getAttribute("fill")).toBe("none");
    // 不带斜线：`PinOff` 的斜线路径（d = "m2 2 20 20"）不得出现，只剩图钉本体 + 针杆。
    const offPaths = Array.from(offSvg?.querySelectorAll("path") ?? []);
    expect(offPaths).toHaveLength(2);
    expect(offPaths.some((p) => (p.getAttribute("d") ?? "").includes("2 2 20 20"))).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置顶窗口" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // 实心：同一形状换成填充，不换图标。
    const onSvg = screen.getByRole("button", { name: "取消置顶" }).querySelector("svg");
    expect(onSvg?.getAttribute("fill")).toBe("currentColor");
    expect(Array.from(onSvg?.querySelectorAll("path") ?? [])).toHaveLength(2);
  });

  it("窗口重新获得焦点时回读真实状态，避免 UI 与窗口不一致", async () => {
    const win = fakeWindow();
    render(<WorkbenchPinButton window={win} />);

    await act(async () => {
      win.setPinnedExternally(true);
      win.fireFocus(true);
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "取消置顶" })).toBeTruthy();
  });

  it("切换失败时回读真实状态，不保留假激活态", async () => {
    const win = fakeWindow();
    win.setAlwaysOnTopFails(true);
    render(<WorkbenchPinButton window={win} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置顶窗口" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "置顶窗口" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});
