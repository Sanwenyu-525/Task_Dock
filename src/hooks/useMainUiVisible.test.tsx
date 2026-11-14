/**
 * @vitest-environment jsdom
 */
//! useMainUiVisible / useFullViewVisible：页面活跃状态派生的契约测试。
//!
//! 这两个钩子是「导航显隐与资源生命周期」的消费者门控判据：
//! - 停靠胶囊期（display:none + inert）主界面不可见；
//! - docked-full 是完整面板停靠态，主界面仍完整可见；
//! - useFullViewVisible 还要求 mode=full（DeferredView 保活下其他模式的
//!   FullView 子树仍是挂载态，但不可见）。
//! 只从既有 store 派生：断言相位/模式矩阵，不引入新状态源。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  isMainUiVisible,
  isFullViewVisible,
  useFullViewVisible,
  useMainUiVisible,
} from "./useMainUiVisible";
import {
  WorkbenchPageActiveContext,
  __resetWindowHostForTests,
  setWindowHostRole,
} from "../lib/windowHost";

describe("useMainUiVisible / useFullViewVisible", () => {
  beforeEach(() => {
    useEdgeSnapStore.setState({ phase: "free", dockedEdge: null });
    useSettingsStore.setState({ settings: null });
    __resetWindowHostForTests();
  });
  afterEach(() => {
    cleanup();
    __resetWindowHostForTests();
  });

  it("默认（free 相位、无设置）两个钩子都可见", () => {
    const main = renderHook(() => useMainUiVisible());
    expect(main.result.current).toBe(true);
    const full = renderHook(() => useFullViewVisible());
    expect(full.result.current).toBe(true);
    expect(isMainUiVisible()).toBe(true);
  });

  it("停靠胶囊相位：主界面不可见（docked-full 除外）", () => {
    for (const phase of ["docked-visible", "docked-hidden", "docked-revealed", "docked-tab"]) {
      act(() => useEdgeSnapStore.setState({ phase: phase as never }));
      expect(isMainUiVisible()).toBe(false);
    }
    // docked-full：完整面板停靠态，主界面仍完整可见
    act(() => useEdgeSnapStore.setState({ phase: "docked-full" }));
    expect(isMainUiVisible()).toBe(true);
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
    expect(isMainUiVisible()).toBe(true);
  });

  it("useFullViewVisible 要求 mode=full", () => {
    act(() =>
      useSettingsStore.setState({ settings: { mode: "compact" } as never }),
    );
    const { result } = renderHook(() => useFullViewVisible());
    expect(result.current).toBe(false);
    // mode=full 时恢复可见；但停靠仍压住
    act(() => useSettingsStore.setState({ settings: { mode: "full" } as never }));
    expect(result.current).toBe(true);
    act(() => useEdgeSnapStore.setState({ phase: "docked-revealed" }));
    expect(result.current).toBe(false);
    act(() => useEdgeSnapStore.setState({ phase: "docked-full" }));
    expect(result.current).toBe(true);
  });

  it("非法 mode 归一为 full（读侧归一化，不产生第三态）", () => {
    act(() =>
      useSettingsStore.setState({ settings: { mode: "bogus" } as never }),
    );
    const { result } = renderHook(() => useFullViewVisible());
    expect(result.current).toBe(true);
  });

  it("工作台宿主：主窗口模式/停靠相位不再影响页面可见性", () => {
    setWindowHostRole("workbench");
    act(() => {
      useSettingsStore.setState({ settings: { mode: "minimal" } as never });
      useEdgeSnapStore.setState({ phase: "docked-hidden" });
    });
    expect(isMainUiVisible()).toBe(true);
    expect(isFullViewVisible()).toBe(true);
    const main = renderHook(() => useMainUiVisible());
    expect(main.result.current).toBe(true);
    const full = renderHook(() => useFullViewVisible());
    expect(full.result.current).toBe(true);
  });

  it("工作台内隐藏路由（已访问但被切换走）按页面活跃上下文暂停消费者", () => {
    setWindowHostRole("workbench");
    const hidden = renderHook(() => useFullViewVisible(), {
      wrapper: ({ children }) => (
        <WorkbenchPageActiveContext.Provider value={false}>
          {children}
        </WorkbenchPageActiveContext.Provider>
      ),
    });
    expect(hidden.result.current).toBe(false);
    const shown = renderHook(() => useMainUiVisible(), {
      wrapper: ({ children }) => (
        <WorkbenchPageActiveContext.Provider value={true}>
          {children}
        </WorkbenchPageActiveContext.Provider>
      ),
    });
    expect(shown.result.current).toBe(true);
  });
});
