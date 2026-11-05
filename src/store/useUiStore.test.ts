//! Toast 队列策略测试：去重、容量上限、关键提示保留、清除。
//!
//! 验收点（通知系统整改 E）：
//! - 同文案同类型 2s 内重复推送只保留一条，避免重复操作刷屏；
//! - 队列超过上限时先挤掉最早的普通提示，错误/警告优先保留；
//! - 重要错误不会被后续普通成功提示覆盖；
//! - showToast(null) 与 dismissToast 能清空队列，不留下幽灵提示。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_QUEUE_MAX, useUiStore } from "./useUiStore";
import { registerTabGuard } from "../lib/tabGuard";

const NOW = 1_000_000;

function reset() {
  useUiStore.setState({ toast: null, toasts: [] });
}

function messages() {
  return useUiStore.getState().toasts.map((t) => t.message);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  reset();
});

afterEach(() => {
  reset();
  vi.useRealTimers();
});

describe("useUiStore · Toast 队列", () => {
  it("同文案同类型 2s 内去重，超过窗口后可再次入队", () => {
    useUiStore.getState().showToast("已复制", { kind: "success" });
    useUiStore.getState().showToast("已复制", { kind: "success" });
    expect(messages()).toEqual(["已复制"]);

    // 同文案不同状态不算重复
    useUiStore.getState().showToast("已复制", { kind: "error" });
    expect(messages()).toEqual(["已复制", "已复制"]);

    vi.advanceTimersByTime(2001);
    useUiStore.getState().showToast("已复制", { kind: "success" });
    expect(messages()).toEqual(["已复制", "已复制", "已复制"]);
  });

  it("超过容量上限时挤掉最早的普通提示", () => {
    for (let i = 0; i < TOAST_QUEUE_MAX + 2; i += 1) {
      vi.advanceTimersByTime(2001);
      useUiStore.getState().showToast(`提示 ${i}`, { kind: "info" });
    }
    const list = messages();
    expect(list).toHaveLength(TOAST_QUEUE_MAX);
    expect(list[0]).toBe("提示 2");
    expect(list.at(-1)).toBe(`提示 ${TOAST_QUEUE_MAX + 1}`);
  });

  it("关键错误不被普通成功提示挤掉", () => {
    useUiStore.getState().showToast("保存失败", { kind: "error" });
    vi.advanceTimersByTime(2001);
    useUiStore.getState().showToast("已保存", { kind: "success" });
    vi.advanceTimersByTime(2001);
    useUiStore.getState().showToast("已复制", { kind: "success" });
    vi.advanceTimersByTime(2001);
    useUiStore.getState().showToast("已删除", { kind: "success" });

    const list = messages();
    expect(list).toHaveLength(TOAST_QUEUE_MAX);
    expect(list).toContain("保存失败");
    // 错误仍在队列中，且不会被普通成功覆盖为最新项
    expect(useUiStore.getState().toasts.some((t) => t.kind === "error")).toBe(true);
  });

  it("showToast(null) 清空队列，dismissToast(id) 只移除对应一条", () => {
    useUiStore.getState().showToast("A", { kind: "info" });
    useUiStore.getState().showToast("B", { kind: "success" });
    const first = useUiStore.getState().toasts[0];
    useUiStore.getState().dismissToast(first.id);
    expect(messages()).toEqual(["B"]);

    useUiStore.getState().showToast(null);
    expect(messages()).toEqual([]);
    expect(useUiStore.getState().toast).toBeNull();
  });
});

describe("收集与暂存合并入口子页状态（v0.8）", () => {
  it("setTab(inbox|shelf) 幂等同步 collectionSub；其他 Tab 不改动上次子页", () => {
    const ui = useUiStore.getState();
    ui.setTab("shelf");
    expect(useUiStore.getState().collectionSub).toBe("shelf");
    useUiStore.getState().setTab("inbox");
    expect(useUiStore.getState().collectionSub).toBe("inbox");
    useUiStore.getState().setTab("tasks");
    expect(useUiStore.getState().collectionSub).toBe("inbox");
    useUiStore.getState().setTab("shelf");
    expect(useUiStore.getState().tab).toBe("shelf");
  });
});

describe("导航事务结果（TabSwitchResult）", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    useUiStore.setState({ tab: "tasks", pendingTab: null, toast: null, toasts: [] });
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    useUiStore.setState({ tab: "tasks", pendingTab: null });
  });

  it("无守卫：返回 switched 并同步执行 after", () => {
    const after = vi.fn();
    expect(useUiStore.getState().setTab("clipboard", { after })).toBe("switched");
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("未保存草稿：返回 pending，after 只在确认后执行；取消不执行", () => {
    const after = vi.fn();
    const discard = vi.fn();
    cleanups.push(
      registerTabGuard({
        id: "ui-store-dirty",
        label: () => "笔记",
        isDirty: () => true,
        isBusy: () => false,
        discard,
      }),
    );

    expect(useUiStore.getState().setTab("clipboard", { after })).toBe("pending");
    expect(after).not.toHaveBeenCalled();
    expect(useUiStore.getState().pendingTab?.tab).toBe("clipboard");

    useUiStore.getState().cancelPendingTab();
    expect(after).not.toHaveBeenCalled();
    expect(useUiStore.getState().tab).toBe("tasks");

    expect(useUiStore.getState().setTab("clipboard", { after })).toBe("pending");
    useUiStore.getState().confirmPendingTab();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().pendingTab).toBeNull();
  });

  it("保存中：返回 blocked，不排队、不执行 after", () => {
    const after = vi.fn();
    cleanups.push(
      registerTabGuard({
        id: "ui-store-busy",
        label: () => "笔记",
        isDirty: () => false,
        isBusy: () => true,
        discard: vi.fn(),
      }),
    );

    expect(useUiStore.getState().setTab("clipboard", { after })).toBe("blocked");
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().pendingTab).toBeNull();
    expect(after).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      "正在保存，请等待完成后再切换页面",
    );
  });
});
