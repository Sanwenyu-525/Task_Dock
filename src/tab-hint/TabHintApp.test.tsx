//! 悬停提示窗口的显示会话（2026-11-06 · edge-tab-round2；2026-11-07 round3 补就绪握手）。
//!
//! 回归点：
//! 1. **同文案重复悬停也必须重新走一遍显示事务**（后端代次 `id` 驱动）；
//! 2. **ready 必须在显示事件订阅建立之后发送**：`listen()` 是异步的，旧顺序
//!    会在监听器建立前 emit 首次 show，事件静默丢失（首次提示不显示）；
//! 3. 订阅失败/组件卸载/StrictMode 重挂载都不得留下错误的 ready 或监听泄漏。

// @vitest-environment jsdom
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const listen = vi.fn();
const invokeCommand = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...(a as [])) }));
vi.mock("../lib/bridge", () => ({
  getSettings: async () => ({ theme: "light", visual_preset: "default" }),
}));
vi.mock("../lib/errors", () => ({ invokeCommand: (...a: unknown[]) => invokeCommand(...(a as [])) }));
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

function readyCalls(): unknown[][] {
  return invokeCommand.mock.calls.filter(([cmd]) => cmd === "tab_hint_ready");
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

  it("显示事件订阅兑现之前不上报 ready（启动早期 show 不得静默丢失）", async () => {
    // 模拟 listen() 的注册 Promise 尚未兑现：此时后端即使收到 ready 也不会
    // 发生任何事；必须等显示事件订阅真正建立后才允许声明就绪。
    let resolveListen: ((fn: () => void) => void) | null = null;
    listen.mockImplementation((event: string) => {
      if (event === "tab-hint-show") {
        return new Promise((resolve) => {
          resolveListen = resolve;
        });
      }
      return Promise.resolve(() => {});
    });

    render(<TabHintApp />);
    await act(async () => {});
    expect(invokeCommand).not.toHaveBeenCalledWith("tab_hint_ready");

    await act(async () => {
      resolveListen?.(() => {});
    });
    expect(invokeCommand).toHaveBeenCalledWith("tab_hint_ready");
  });

  it("显示事件订阅失败时不声明就绪（不产生空提示条）", async () => {
    listen.mockImplementation((event: string) =>
      event === "tab-hint-show"
        ? Promise.reject(new Error("ipc down"))
        : Promise.resolve(() => {}),
    );
    render(<TabHintApp />);
    await act(async () => {});
    expect(invokeCommand).not.toHaveBeenCalledWith("tab_hint_ready");
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

  it("重复投递/乱序旧代次不会回退到旧会话", async () => {
    render(<TabHintApp />);
    await act(async () => {});
    const onShow = showHandler();

    await act(async () => {
      onShow({ payload: { id: 8, text: "最新" } });
    });
    expect(invokeCommand).toHaveBeenCalledWith("fit_tab_hint", {
      width: 122,
      height: 28,
      id: 8,
    });

    const fitsBefore = invokeCommand.mock.calls.filter(([c]) => c === "fit_tab_hint").length;
    await act(async () => {
      onShow({ payload: { id: 8, text: "最新" } }); // 重复投递
      onShow({ payload: { id: 7, text: "旧会话" } }); // 乱序迟到
    });
    const fitsAfter = invokeCommand.mock.calls.filter(([c]) => c === "fit_tab_hint").length;
    expect(fitsAfter).toBe(fitsBefore);
  });

  it("订阅期间组件卸载：不晚发 ready，迟到的 unlisten 立即执行（不泄漏）", async () => {
    let resolveListen: ((fn: () => void) => void) | null = null;
    const unlisten = vi.fn();
    listen.mockImplementation((event: string) => {
      if (event === SHOW_EVENT) {
        return new Promise((resolve) => {
          resolveListen = resolve;
        });
      }
      return Promise.resolve(() => {});
    });
    const view = render(<TabHintApp />);
    await act(async () => {});
    view.unmount();

    await act(async () => {
      resolveListen?.(unlisten);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeCommand).not.toHaveBeenCalledWith("tab_hint_ready");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 双挂载只上报一次 ready（首次订阅已清理，不误报就绪）", async () => {
    render(
      <StrictMode>
        <TabHintApp />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readyCalls()).toHaveLength(1);
  });

  it("窗口重建（卸载后重新挂载）会重新订阅并再次握手", async () => {
    const first = render(<TabHintApp />);
    await act(async () => {});
    first.unmount();

    const second = render(<TabHintApp />);
    await act(async () => {});
    expect(listen.mock.calls.filter(([event]) => event === SHOW_EVENT)).toHaveLength(2);
    expect(readyCalls()).toHaveLength(2);
    second.unmount();
  });
});
