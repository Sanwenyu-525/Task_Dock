//! 悬停提示窗口的显示会话（2026-11-06 · edge-tab-round2）。
//!
//! 回归点：**同文案重复悬停也必须重新走一遍显示事务**。
//! 旧实现把「渲染/测量」挂在 `[text]` 上——提示窗隐藏后再次悬停、文案没变时
//! React 直接跳过，`fit_tab_hint` 永远不来，第二次悬停静默失败。
//! 现在由后端代次 `id` 驱动：同文案 + 新 id 也必须重新测量并回传。

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const listen = vi.fn();
const invokeCommand = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...(a as [])) }));
vi.mock("../lib/bridge", () => ({
  getSettings: async () => ({ theme: "light", visual_preset: "default" }),
}));
vi.mock("../lib/errors", () => ({ invokeCommand: (...a: unknown[]) => invokeCommand(...(a as [])) }));
vi.mock("../lib/subscriptions", () => ({
  createSubscriptionScope: () => ({ add: () => {}, dispose: () => {} }),
}));
vi.mock("../lib/theme", () => ({
  resolveSecondaryPreset: (v: string) => v,
  resolveTheme: () => "light",
  resolveVisualPreset: (v: string) => v,
}));

import TabHintApp from "./TabHintApp";

const SHOW_EVENT = "tab-hint-show";

function showHandler(): (e: { payload: unknown }) => void {
  const call = listen.mock.calls.find(([event]) => event === SHOW_EVENT);
  if (!call) throw new Error("tab-hint-show 未被订阅");
  return call[1] as (e: { payload: unknown }) => void;
}

beforeEach(() => {
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  invokeCommand.mockReset();
  invokeCommand.mockResolvedValue(true);
  // jsdom 不做布局：提示条的自然尺寸按 120×26 固定（+2px 口径由组件负责）
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 120,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 26,
  });
});

describe("TabHintApp 显示会话", () => {
  it("挂载即上报 ready", async () => {
    render(<TabHintApp />);
    await act(async () => {});
    expect(invokeCommand).toHaveBeenCalledWith("tab_hint_ready");
  });

  it("同文案 + 新代次必须重新测量回传（重复悬停修复点）", async () => {
    render(<TabHintApp />);
    await act(async () => {});
    const onShow = showHandler();

    await act(async () => {
      onShow({ payload: { id: 7, text: "任务：空闲" } });
    });
    expect(invokeCommand).toHaveBeenCalledWith("fit_tab_hint", {
      width: 122,
      height: 28,
      id: 7,
    });

    // 隐藏后再次悬停：文案不变、代次推进 → 仍然要回传 fit
    await act(async () => {
      onShow({ payload: { id: 8, text: "任务：空闲" } });
    });
    expect(invokeCommand).toHaveBeenLastCalledWith("fit_tab_hint", {
      width: 122,
      height: 28,
      id: 8,
    });
  });

  it("过期/非法载荷不驱动测量", async () => {
    render(<TabHintApp />);
    await act(async () => {});
    const onShow = showHandler();
    const callsBefore = invokeCommand.mock.calls.filter(([c]) => c === "fit_tab_hint").length;

    await act(async () => {
      onShow({ payload: { text: "没有 id" } });
      onShow({ payload: "纯字符串" });
      onShow({ payload: { id: 0, text: "代次 0 不是有效请求" } });
    });
    const callsAfter = invokeCommand.mock.calls.filter(([c]) => c === "fit_tab_hint").length;
    expect(callsAfter).toBe(callsBefore);
  });
});
