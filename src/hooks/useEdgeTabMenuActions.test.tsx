//! 极简标签右键菜单的动作桥。
//!
//! 契约：菜单只发命令，主窗引擎执行 —— 这里锁定
//! 1. 三类动作分别落到 `restoreTab({ reveal: true })` / `formSwitch("full")` / `undock()`；
//! 2. **只有事务真实成功才回 ok**：入口缺失、事务失败、异常都返回失败原因；
//! 3. 事件带请求 id 时把结果回传 `tab_menu_action_result`，重复 id 不执行两次；
//! 4. 订阅在卸载时成对释放。

// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unlisten = vi.fn();
let handler: ((event: { payload: unknown }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (event: { payload: unknown }) => void) => {
    handler = cb;
    return unlisten;
  }),
}));
vi.mock("../lib/errors", () => ({
  invokeCommand: vi.fn(async () => true),
}));

import {
  runTabMenuAction,
  useEdgeTabMenuActions,
  TAB_MENU_ACTION_EVENT,
  TAB_MENU_RESULT_COMMAND,
} from "./useEdgeTabMenuActions";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand } from "../lib/errors";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";

const invokeMock = vi.mocked(invokeCommand);

describe("runTabMenuAction", () => {
  const restoreTab = vi.fn(async () => true);
  const formSwitch = vi.fn(async () => true);
  const undock = vi.fn(async () => true);

  beforeEach(() => {
    restoreTab.mockReset();
    formSwitch.mockReset();
    undock.mockReset();
    restoreTab.mockResolvedValue(true);
    formSwitch.mockResolvedValue(true);
    undock.mockResolvedValue(true);
    useEdgeSnapStore.setState({ restoreTab, formSwitch, undock });
  });

  it("expand：恢复轨道并展开面板（同一事务入口）", async () => {
    await expect(runTabMenuAction("expand")).resolves.toEqual({ ok: true });
    expect(restoreTab).toHaveBeenCalledTimes(1);
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });
    expect(formSwitch).not.toHaveBeenCalled();
  });

  it("full：本次会话的形态切换，不写持久化偏好", async () => {
    await expect(runTabMenuAction("full")).resolves.toEqual({ ok: true });
    expect(formSwitch).toHaveBeenCalledWith("full");
    expect(restoreTab).not.toHaveBeenCalled();
  });

  it("undock：走既有解除吸附事务", async () => {
    await expect(runTabMenuAction("undock")).resolves.toEqual({ ok: true });
    expect(undock).toHaveBeenCalledTimes(1);
  });

  it("事务返回 false 时回传可重试的失败原因（不假装成功）", async () => {
    restoreTab.mockResolvedValue(false);
    const r = await runTabMenuAction("expand");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("展开失败");

    formSwitch.mockResolvedValue(false);
    expect((await runTabMenuAction("full")).ok).toBe(false);

    undock.mockResolvedValue(false);
    const u = await runTabMenuAction("undock");
    expect(u.ok).toBe(false);
    expect(u.error).toContain("退出吸附失败");
  });

  it("事务抛异常时回传失败，不产生未处理的 rejection", async () => {
    restoreTab.mockRejectedValue(new Error("boom"));
    const r = await runTabMenuAction("expand");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("引擎未注入时返回失败（不静默假装成功）", async () => {
    useEdgeSnapStore.setState({ restoreTab: null, formSwitch: null, undock: null });
    for (const action of ["expand", "full", "undock"]) {
      const r = await runTabMenuAction(action);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("窗口引擎未就绪");
    }
  });

  it("未知动作不做任何事", async () => {
    const r = await runTabMenuAction("quit");
    expect(r.ok).toBe(false);
    expect(restoreTab).not.toHaveBeenCalled();
    expect(formSwitch).not.toHaveBeenCalled();
    expect(undock).not.toHaveBeenCalled();
  });
});

describe("useEdgeTabMenuActions", () => {
  beforeEach(() => {
    handler = null;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(true);
    unlisten.mockReset();
    useEdgeSnapStore.setState({
      restoreTab: vi.fn(async () => true),
      formSwitch: vi.fn(async () => true),
      undock: vi.fn(async () => true),
    });
  });

  afterEach(() => {
    cleanup();
    handler = null;
  });

  it("订阅 edge-tab-action，执行后回传真实结果，卸载时释放", async () => {
    const restoreTab = vi.fn(async () => true);
    useEdgeSnapStore.setState({ restoreTab });
    const view = renderHook(() => useEdgeTabMenuActions());

    expect(listen).toHaveBeenCalledWith(TAB_MENU_ACTION_EVENT, expect.any(Function));
    await Promise.resolve();
    expect(handler).not.toBeNull();

    handler?.({ payload: { id: 41, action: "expand" } });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(TAB_MENU_RESULT_COMMAND, {
        id: 41,
        ok: true,
        error: null,
      }),
    );
    expect(restoreTab).toHaveBeenCalledWith({ reveal: true });

    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("事务失败时回执 ok=false + 原因（菜单保留并显示反馈）", async () => {
    const restoreTab = vi.fn(async () => false);
    useEdgeSnapStore.setState({ restoreTab });
    renderHook(() => useEdgeTabMenuActions());
    await Promise.resolve();

    handler?.({ payload: { id: 42, action: "expand" } });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const args = invokeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(args.id).toBe(42);
    expect(args.ok).toBe(false);
    expect(String(args.error)).toContain("展开失败");
  });

  it("重复/迟到 id 不重复执行", async () => {
    const restoreTab = vi.fn(async () => true);
    useEdgeSnapStore.setState({ restoreTab });
    renderHook(() => useEdgeTabMenuActions());
    await Promise.resolve();

    handler?.({ payload: { id: 7, action: "expand" } });
    await vi.waitFor(() => expect(restoreTab).toHaveBeenCalledTimes(1));
    handler?.({ payload: { id: 7, action: "expand" } });
    handler?.({ payload: { id: 6, action: "expand" } });
    await Promise.resolve();

    expect(restoreTab).toHaveBeenCalledTimes(1);
  });

  it("旧版纯字符串载荷可执行但不回执（没有请求 id）", async () => {
    const restoreTab = vi.fn(async () => true);
    useEdgeSnapStore.setState({ restoreTab });
    renderHook(() => useEdgeTabMenuActions());
    await Promise.resolve();

    handler?.({ payload: "expand" });
    await vi.waitFor(() => expect(restoreTab).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("非法对象载荷（缺 id/action）不执行", async () => {
    const restoreTab = vi.fn(async () => true);
    useEdgeSnapStore.setState({ restoreTab });
    renderHook(() => useEdgeTabMenuActions());
    await Promise.resolve();

    handler?.({ payload: { action: "expand" } });
    handler?.({ payload: { id: 9 } });
    handler?.({ payload: null });
    await Promise.resolve();

    expect(restoreTab).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
