/**
 * @vitest-environment jsdom
 */
//! 共享时钟（智能日程提醒 2.0）：
//! - 全应用同一时刻只有一条 1s setInterval（首个订阅启动）；
//! - 全部退订后计时器释放（无悬挂定时器）；
//! - 快照按秒推进。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { clockRunning, resetSharedClockForTest, useSharedClock } from "./sharedClock";

function Probe() {
  const now = useSharedClock();
  const baseRef = useRef<number | null>(null);
  if (baseRef.current === null) baseRef.current = now;
  // 以首次渲染的快照为基准，展示经过的秒数（避免跨真实/假时钟的基准漂移）
  return <span data-testid="tick">{Math.floor((now - baseRef.current) / 1000)}</span>;
}

/** 保活页面用：enabled=false 时仍挂载，但不再是时钟消费者。 */
function GatedProbe({ enabled }: { enabled: boolean }) {
  const now = useSharedClock(enabled);
  return <span data-testid="gated">{now}</span>;
}

describe("sharedClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSharedClockForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("订阅启动单条计时器，退订后释放", () => {
    expect(clockRunning()).toBe(false);
    const { unmount } = render(<Probe />);
    expect(clockRunning()).toBe(true);

    // 1 秒后快照推进（useSyncExternalStore 触发重渲染）
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector('[data-testid="tick"]')?.textContent).toBe("1");

    unmount();
    expect(clockRunning()).toBe(false);
  });

  it("整个窗口隐藏时释放计时器，恢复可见后重新对齐", () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const { unmount } = render(<Probe />);
    expect(clockRunning()).toBe(true);
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(clockRunning()).toBe(false);
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(clockRunning()).toBe(true);
    unmount();
    expect(clockRunning()).toBe(false);
  });

  it("隐藏页面退出消费者后释放计时器，恢复可见后重新启动", () => {
    const { rerender, unmount } = render(<GatedProbe enabled={false} />);
    expect(clockRunning()).toBe(false);
    rerender(<GatedProbe enabled={true} />);
    expect(clockRunning()).toBe(true);
    // 切走 Tab/进入停靠：组件仍挂载，但不再为不可见倒计时每秒唤醒
    rerender(<GatedProbe enabled={false} />);
    expect(clockRunning()).toBe(false);
    unmount();
  });

  it("多个订阅者共用同一条计时器", () => {
    const a = render(<Probe />);
    const b = render(<Probe />);
    expect(clockRunning()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(a.container.querySelector('[data-testid="tick"]')?.textContent).toBe("2");
    expect(b.container.querySelector('[data-testid="tick"]')?.textContent).toBe("2");
    a.unmount();
    expect(clockRunning()).toBe(true);
    b.unmount();
    expect(clockRunning()).toBe(false);
  });
});
