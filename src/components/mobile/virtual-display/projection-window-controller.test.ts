//! 投屏窗口控制器：生命周期幂等、动作绑定 sessionId、可见性状态机单定时器。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/bridge", () => ({
  vdFocus: vi.fn(async () => ({ found: true, focused: true })),
  vdProjectionDispatch: vi.fn(async () => ({ action: "home", display_id: 17 })),
  vdScreenshot: vi.fn(async () => ({
    path: "C:\\tmp\\shot.png",
    width: 1080,
    height: 1920,
    captured_at: new Date().toISOString(),
    warning: null,
  })),
  vdStop: vi.fn(async () => true),
  vdToolbarAttach: vi.fn(async () => "ready"),
  vdToolbarDestroy: vi.fn(async () => true),
  vdToolbarDetach: vi.fn(async () => true),
  vdToolbarScreenshot: vi.fn(async () => ({
    path: "C:\\tmp\\shot.png",
    width: 1080,
    height: 1920,
    captured_at: new Date().toISOString(),
    warning: null,
  })),
  vdToolbarSetExpanded: vi.fn(async () => true),
  vdToolbarSetLocked: vi.fn(async () => true),
  vdToolbarUpdate: vi.fn(async () => true),
}));

import {
  vdFocus,
  vdProjectionDispatch,
  vdToolbarAttach,
  vdToolbarDestroy,
} from "../../../lib/bridge";
import {
  createToolbarVisibilityController,
  projectionWindowController,
  toolbarVisibilityFor,
} from "./projection-window-controller";

const attachMock = vi.mocked(vdToolbarAttach);
const destroyMock = vi.mocked(vdToolbarDestroy);
const navMock = vi.mocked(vdProjectionDispatch);
const focusMock = vi.mocked(vdFocus);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("projectionWindowController", () => {
  it("attach 幂等：ready 后重复调用不再创建窗口", async () => {
    await projectionWindowController.attach("controller-attach-A");
    await projectionWindowController.attach("controller-attach-A");
    expect(attachMock).toHaveBeenCalledTimes(1);
    await projectionWindowController.destroy("controller-attach-A");
    expect(destroyMock).toHaveBeenCalledWith("controller-attach-A");
  });

  it("destroy 可重复调用且不抛错", async () => {
    await expect(
      projectionWindowController.destroy("controller-destroy-A"),
    ).resolves.toBeUndefined();
    await expect(
      projectionWindowController.destroy("controller-destroy-A"),
    ).resolves.toBeUndefined();
  });

  it("导航只发送 sessionId + action，并在动作后恢复 scrcpy 焦点", async () => {
    const display = await projectionWindowController.navigate(
      "controller-nav-A",
      "home",
    );
    expect(navMock).toHaveBeenCalledWith("controller-nav-A", "home");
    expect(focusMock).toHaveBeenCalledWith("controller-nav-A");
    expect(display).toBe(17);
  });

  it("每个 Session 拥有独立可见性控制器", () => {
    const a = toolbarVisibilityFor("visibility-A");
    const b = toolbarVisibilityFor("visibility-B");
    expect(a).not.toBe(b);
    expect(toolbarVisibilityFor("visibility-A")).toBe(a);
  });
});

describe("createToolbarVisibilityController", () => {
  it("testToolbarVisibilityState：显示 → 计划隐藏 → 到期隐藏", () => {
    vi.useFakeTimers();
    const controller = createToolbarVisibilityController(1000);
    const states: string[] = [];
    controller.subscribe((state) => states.push(state));

    controller.showToolbar();
    controller.scheduleToolbarHide();
    expect(controller.getState()).toBe("visible");

    vi.advanceTimersByTime(999);
    expect(controller.getState()).toBe("visible");
    vi.advanceTimersByTime(1);
    expect(controller.getState()).toBe("hidden");
    expect(states).toEqual(["hidden"]);
    controller.dispose();
  });

  it("锁定后不自动隐藏，解锁恢复可见", () => {
    vi.useFakeTimers();
    const controller = createToolbarVisibilityController(500);
    controller.lockToolbar();
    controller.scheduleToolbarHide();
    vi.advanceTimersByTime(5000);
    expect(controller.getState()).toBe("locked");
    controller.unlockToolbar();
    expect(controller.getState()).toBe("visible");
    controller.dispose();
  });

  it("重复 schedule 只保留一个定时器，不会相互覆盖", () => {
    vi.useFakeTimers();
    const controller = createToolbarVisibilityController(1000);
    const states: string[] = [];
    controller.subscribe((state) => states.push(state));

    controller.scheduleToolbarHide();
    vi.advanceTimersByTime(600);
    controller.scheduleToolbarHide();
    vi.advanceTimersByTime(600);
    // 第二次重新计时：1200ms 时仍可见。
    expect(controller.getState()).toBe("visible");
    vi.advanceTimersByTime(400);
    expect(controller.getState()).toBe("hidden");
    expect(states).toEqual(["hidden"]);
    controller.dispose();
  });

  it("cancel 取消未决定时器；dispose 清理监听", () => {
    vi.useFakeTimers();
    const controller = createToolbarVisibilityController(300);
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.scheduleToolbarHide();
    controller.cancelToolbarHide();
    vi.advanceTimersByTime(1000);
    expect(listener).not.toHaveBeenCalled();
    controller.dispose();
    expect(controller.getState()).toBe("visible");
  });
});
