/**
 * @vitest-environment jsdom
 */
//! 暂存架拖出手势：阈值、单飞、data-no-drag、click 抑制与清理。

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointerEvent as ReactPointerEvent } from "react";

const dragOut = vi.fn();

vi.mock("../lib/bridge", () => ({
  shelfDragOut: (...args: unknown[]) => dragOut(...args),
}));

import { useShelfDragOut } from "./useShelfDragOut";

function pointerDownEvent(
  overrides: Partial<Record<string, unknown>> = {},
): ReactPointerEvent<HTMLElement> {
  return {
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    target: document.body,
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLElement>;
}

function dispatchPointer(type: string, init: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId: 1, buttons: 1, ...init });
  document.dispatchEvent(event);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
  dragOut.mockResolvedValue({ effect: "copy", count: 1, missing_ids: [] });
});

describe("useShelfDragOut", () => {
  it("低于阈值不发起拖出，点击仍是点击", () => {
    const { result } = renderHook(() =>
      useShelfDragOut({ enabled: true, resolveIds: () => ["a"] }),
    );

    act(() => {
      result.current.onPointerDown(pointerDownEvent());
      dispatchPointer("pointermove", { clientX: 13, clientY: 10 });
    });

    expect(dragOut).not.toHaveBeenCalled();
    expect(result.current.shouldSuppressClick()).toBe(false);
  });

  it("超过阈值只调用一次，并传入多选 ids", () => {
    const { result } = renderHook(() =>
      useShelfDragOut({ enabled: true, resolveIds: () => ["a", "b"] }),
    );

    act(() => {
      result.current.onPointerDown(pointerDownEvent());
      dispatchPointer("pointermove", { clientX: 30, clientY: 10 });
      dispatchPointer("pointermove", { clientX: 40, clientY: 10 });
    });

    expect(dragOut).toHaveBeenCalledTimes(1);
    expect(dragOut).toHaveBeenCalledWith(["a", "b"]);
    expect(result.current.shouldSuppressClick()).toBe(true);
  });

  it("data-no-drag 控件（勾选/更多菜单）不进入拖出", () => {
    const button = document.createElement("button");
    button.dataset.noDrag = "true";
    document.body.append(button);

    const { result } = renderHook(() =>
      useShelfDragOut({ enabled: true, resolveIds: () => ["a"] }),
    );

    act(() => {
      result.current.onPointerDown(pointerDownEvent({ target: button }));
      dispatchPointer("pointermove", { clientX: 40, clientY: 10 });
    });

    expect(dragOut).not.toHaveBeenCalled();
  });

  it("resolveIds 为空（link/text/missing）不发起拖出", () => {
    const { result } = renderHook(() =>
      useShelfDragOut({ enabled: true, resolveIds: () => [] }),
    );

    act(() => {
      result.current.onPointerDown(pointerDownEvent());
      dispatchPointer("pointermove", { clientX: 40, clientY: 10 });
    });

    expect(dragOut).not.toHaveBeenCalled();
  });

  it("pointercancel 后在阈值前的移动不会再触发", () => {
    const { result } = renderHook(() =>
      useShelfDragOut({ enabled: true, resolveIds: () => ["a"] }),
    );

    act(() => {
      result.current.onPointerDown(pointerDownEvent());
      dispatchPointer("pointercancel", {});
      dispatchPointer("pointermove", { clientX: 40, clientY: 10 });
    });

    expect(dragOut).not.toHaveBeenCalled();
  });

  it("click 抑制在窗口期后自动失效", async () => {
    const { result } = renderHook(() =>
      useShelfDragOut({
        enabled: true,
        resolveIds: () => ["a"],
        suppressMs: 100,
      }),
    );

    act(() => {
      result.current.onPointerDown(pointerDownEvent());
      dispatchPointer("pointermove", { clientX: 40, clientY: 10 });
    });
    expect(result.current.shouldSuppressClick()).toBe(true);

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(101);
    });
    expect(result.current.shouldSuppressClick()).toBe(false);
  });

  it("enabled=false 时不监听", () => {
    const { result } = renderHook(() =>
      useShelfDragOut({ enabled: false, resolveIds: () => ["a"] }),
    );

    act(() => {
      result.current.onPointerDown(pointerDownEvent());
      dispatchPointer("pointermove", { clientX: 40, clientY: 10 });
    });

    expect(dragOut).not.toHaveBeenCalled();
  });
});
