//! 极简标签右键菜单的动作桥。
//!
//! 契约：菜单只发命令，主窗引擎执行 —— 这里锁定三类动作分别落到
//! `restoreTab({ reveal: true })` / `formSwitch("full")` / `undock()`，
//! 且引擎未注入时返回 false（不假装成功），订阅在卸载时成对释放。

// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unlisten = vi.fn();
let handler: ((event: { payload: string }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (event: { payload: string }) => void) => {
    handler = cb;
    return unlisten;
  }),
}));

import { runTabMenuAction, useEdgeTabMenuActions, TAB_MENU_ACTION_EVENT } from "./useEdgeTabMenuActions";
import { listen } from "@tauri-apps/api/event";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";

describe("runTabMenuAction", () => {
  const restoreTab = vi.fn();
  const formSwitch = vi.fn();
  const undock = vi.fn();

  beforeEach(() => {
    restoreTab.mockReset();
    formSwitch.mockReset();
    undock.mockReset();
    useEdgeSnapStore.setState({ restoreTab, formSwitch, undock });
  });

  it("expand：恢复轨道并展开面板（同一事务入口）", () => {
    expect(runTabMenuAction("expand")).toBe(true);
    expect(restoreTab).toHaveBeenCalledTimes(1);
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });
    expect(formSwitch).not.toHaveBeenCalled();
  });

  it("full：本次会话的形态切换，不写持久化偏好", () => {
    expect(runTabMenuAction("full")).toBe(true);
    expect(formSwitch).toHaveBeenCalledWith("full");
    expect(restoreTab).not.toHaveBeenCalled();
  });

  it("undock：走既有解除吸附事务", () => {
    expect(runTabMenuAction("undock")).toBe(true);
    expect(undock).toHaveBeenCalledTimes(1);
  });

  it("引擎未注入时返回 false（不静默假装成功）", () => {
    useEdgeSnapStore.setState({ restoreTab: null, formSwitch: null, undock: null });
    expect(runTabMenuAction("expand")).toBe(false);
    expect(runTabMenuAction("full")).toBe(false);
    expect(runTabMenuAction("undock")).toBe(false);
  });

  it("未知动作不做任何事", () => {
    expect(runTabMenuAction("quit")).toBe(false);
    expect(restoreTab).not.toHaveBeenCalled();
    expect(formSwitch).not.toHaveBeenCalled();
    expect(undock).not.toHaveBeenCalled();
  });
});

describe("useEdgeTabMenuActions", () => {
  afterEach(() => {
    cleanup();
    handler = null;
    unlisten.mockReset();
  });

  it("订阅 edge-tab-action，卸载时释放", async () => {
    const restoreTab = vi.fn();
    useEdgeSnapStore.setState({ restoreTab });
    const view = renderHook(() => useEdgeTabMenuActions());

    expect(listen).toHaveBeenCalledWith(TAB_MENU_ACTION_EVENT, expect.any(Function));
    // 让 listen 的 Promise 落地
    await Promise.resolve();
    expect(handler).not.toBeNull();

    handler?.({ payload: "expand" });
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });

    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
