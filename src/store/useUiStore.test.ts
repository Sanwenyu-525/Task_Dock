//! Toast 队列策略测试：去重、容量上限、关键提示保留、清除。
//!
//! 验收点（通知系统整改 E）：
//! - 同文案同类型 2s 内重复推送只保留一条，避免重复操作刷屏；
//! - 队列超过上限时先挤掉最早的普通提示，错误/警告优先保留；
//! - 重要错误不会被后续普通成功提示覆盖；
//! - showToast(null) 与 dismissToast 能清空队列，不留下幽灵提示。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_QUEUE_MAX, useUiStore } from "./useUiStore";

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
