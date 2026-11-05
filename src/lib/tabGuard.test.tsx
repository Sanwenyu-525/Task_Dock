/**
 * @vitest-environment jsdom
 */
//! 跨页面导航保护：验证门禁在 store 入口统一生效，而不是只测编辑器自己的返回按钮。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useTabGuard } from "./tabGuard";
import { useUiStore } from "../store/useUiStore";

function resetUi() {
  useUiStore.setState({ tab: "tasks", pendingTab: null });
}

beforeEach(() => {
  resetUi();
});
afterEach(() => {
  cleanup();
  resetUi();
});

describe("tabGuard", () => {
  it("脏编辑器切页只记录待决目标，不卸载、不丢草稿", () => {
    const discard = vi.fn();
    renderHook(() =>
      useTabGuard({ id: "ed", label: "编辑任务", dirty: true, discard }),
    );

    act(() => useUiStore.getState().setTab("workflows"));

    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().pendingTab).toMatchObject({ tab: "workflows", guardId: "ed" });
    expect(discard).not.toHaveBeenCalled();
  });

  it("继续编辑：清除待决目标，当前页与草稿不变", () => {
    renderHook(() => useTabGuard({ id: "ed", label: "编辑", dirty: true, discard: vi.fn() }));
    act(() => useUiStore.getState().setTab("workflows"));
    act(() => useUiStore.getState().cancelPendingTab());

    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().pendingTab).toBeNull();
  });

  it("明确放弃：先收尾编辑器，再完成导航", () => {
    const discard = vi.fn();
    renderHook(() => useTabGuard({ id: "ed", label: "编辑", dirty: true, discard }));
    act(() => useUiStore.getState().setTab("workflows"));
    act(() => useUiStore.getState().confirmPendingTab());

    expect(discard).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().tab).toBe("workflows");
    expect(useUiStore.getState().pendingTab).toBeNull();
  });

  it("保存中切页：拒绝切换并给出明确提示，不进入待决态", () => {
    renderHook(() =>
      useTabGuard({ id: "ed", label: "编辑", dirty: true, busy: true, discard: vi.fn() }),
    );
    act(() => useUiStore.getState().setTab("workflows"));

    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().pendingTab).toBeNull();
  });

  it("无未保存改动时正常导航", () => {
    renderHook(() => useTabGuard({ id: "ed", label: "编辑", dirty: false, discard: vi.fn() }));
    act(() => useUiStore.getState().setTab("workflows"));

    expect(useUiStore.getState().tab).toBe("workflows");
    expect(useUiStore.getState().pendingTab).toBeNull();
  });

  it("打开任务编辑器的程序化导航也受门禁约束", () => {
    renderHook(() => useTabGuard({ id: "ed", label: "编辑", dirty: true, discard: vi.fn() }));
    act(() => useUiStore.getState().openEditor());

    expect(useUiStore.getState().editor.open).toBe(false);
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().pendingTab?.tab).toBe("tasks");
  });
});
