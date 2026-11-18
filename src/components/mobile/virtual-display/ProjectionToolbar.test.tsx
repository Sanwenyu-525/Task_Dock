/**
 * @vitest-environment jsdom
 */
//! 投屏控制栏组件：会话绑定、能力禁用、锁定与可见性。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectionToolbar, {
  capabilitiesForSession,
  type ProjectionCapabilities,
} from "./ProjectionToolbar";

function capabilities(
  overrides: Partial<ProjectionCapabilities> = {},
): ProjectionCapabilities {
  return {
    back: true,
    home: true,
    recents: true,
    screenshot: true,
    close: true,
    ...overrides,
  };
}

function renderToolbar(
  overrides: Partial<ComponentProps<typeof ProjectionToolbar>> = {},
) {
  const onNavigate = vi.fn();
  const onScreenshot = vi.fn();
  const onClose = vi.fn();
  const onToggleLock = vi.fn();
  const onMore = vi.fn();
  const view = render(
    <ProjectionToolbar
      sessionId="session-A"
      deviceId="UID-A"
      displayId={17}
      capabilities={capabilities()}
      mode="normal"
      visible
      locked={false}
      onNavigate={onNavigate}
      onScreenshot={onScreenshot}
      onClose={onClose}
      onToggleLock={onToggleLock}
      onMore={onMore}
      {...overrides}
    />,
  );
  return {
    view,
    onNavigate,
    onScreenshot,
    onClose,
    onToggleLock,
    onMore,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectionToolbar", () => {
  it("testToolbarNavigationUsesSessionId：动作只通过 Session 层回调发送", () => {
    const { view, onNavigate } = renderToolbar();
    const root = view.container.querySelector(".vd-toolbar");
    expect(root?.getAttribute("data-session")).toBe("session-A");

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "最近任务" }));

    expect(onNavigate.mock.calls).toEqual([["back"], ["home"], ["recents"]]);
  });

  it("testDisabledRecentsDoesNotSendCommand：能力不支持时不发送 IPC", () => {
    const { onNavigate } = renderToolbar({
      capabilities: capabilities({ recents: false }),
    });
    const recents = screen.getByRole("button", {
      name: /虚拟屏的最近任务/,
    }) as HTMLButtonElement;
    expect(recents.disabled).toBe(true);
    fireEvent.click(recents);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("testToolbarLockState：锁定状态可见且可切换", () => {
    const { onToggleLock } = renderToolbar({ locked: true });
    const lock = screen.getByRole("button", { name: "取消锁定" });
    expect(lock.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(lock);
    expect(onToggleLock).toHaveBeenCalledTimes(1);
  });

  it("全屏模式使用横向布局，普通窗口使用竖向布局", () => {
    const { view } = renderToolbar();
    expect(view.container.querySelector(".vd-toolbar.is-normal")).toBeTruthy();
    cleanup();
    const fullscreen = renderToolbar({ mode: "fullscreen" });
    expect(
      fullscreen.view.container.querySelector(".vd-toolbar.is-fullscreen"),
    ).toBeTruthy();
  });

  it("截图与关闭都走注入回调，不直接调用后端", () => {
    const { onScreenshot, onClose } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "截屏" }));
    expect(onScreenshot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭投屏" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("capabilitiesForSession 与后端拒绝规则一致", () => {
    expect(
      capabilitiesForSession({ status: "running", mode: "virtual", display_id: 17 }),
    ).toEqual({
      back: true,
      home: true,
      recents: false,
      screenshot: true,
      close: true,
    });
    expect(
      capabilitiesForSession({ status: "running", mode: "virtual", display_id: null }),
    ).toMatchObject({ back: false, home: false, recents: false });
    expect(
      capabilitiesForSession({ status: "running", mode: "mirror", display_id: 0 }),
    ).toMatchObject({ back: true, home: true, recents: true });
    expect(
      capabilitiesForSession({ status: "stopping", mode: "mirror", display_id: 0 }),
    ).toMatchObject({ back: false, screenshot: false, close: false });
  });
});
