/**
 * @vitest-environment jsdom
 */
//! ClipboardWorkspace / ClipboardPanel 页面活跃门控（导航显隐与资源生命周期）：
//! - 页面级活跃 = mode=full && tab=clipboard && 未开抽屉 && 主界面未停靠；
//! - 停靠/模式切换的隐藏期：不加载、不订阅实时事件、不读监听状态；
//! - 恢复可见：uiActive 依赖变化驱动自动补一次加载（组件保持挂载，状态不丢）；
//! - 抽屉变体在停靠期同样挂起（抽屉随主界面一起隐藏）。
//!
//! 边界：后端采集线程与本组件无关 —— 这里停的是 UI 刷新消费，不是采集。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { resetClipboardRequestState } from "../../store/useClipboardStore";

const { clipboardView, clipboardStatus, onClipboardChanged } = vi.hoisted(() => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, clipboardView, clipboardStatus, onClipboardChanged };
});

import ClipboardWorkspace from "./ClipboardWorkspace";
import ClipboardPanel from "./ClipboardPanel";
import type { Tab } from "../../store/useUiStore";

function emptyView() {
  return {
    items: [],
    groups: [],
    stats: { items: 0, groups: 0, images: 0, files: 0, favorites: 0, bytes: 0, asset_bytes: 0 },
    total_items: 0,
  } as never;
}

function env(opts: { mode?: string; docked?: boolean; tab?: Tab } = {}) {
  useSettingsStore.setState({ settings: { mode: opts.mode ?? "full" } as never });
  useEdgeSnapStore.setState({
    phase: opts.docked ? "docked-revealed" : "free",
    dockedEdge: null,
  });
  useUiStore.setState({ tab: opts.tab ?? "clipboard", clipboardOpen: false });
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("ClipboardWorkspace 页面活跃门控", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardView.mockResolvedValue(emptyView());
    clipboardStatus.mockResolvedValue({ monitoring: true } as never);
    onClipboardChanged.mockResolvedValue(vi.fn());
    resetClipboardRequestState();
  });
  afterEach(() => {
    cleanup();
    resetClipboardRequestState();
    useSettingsStore.setState({ settings: null });
    useEdgeSnapStore.setState({ phase: "free", dockedEdge: null });
    useUiStore.setState({ tab: "tasks", clipboardOpen: false });
  });

  it("页面活跃（完整模式+剪贴板页+未停靠）：挂载即加载并建立实时订阅", async () => {
    env();
    render(<ClipboardWorkspace variant="page" active />);
    await vi.waitFor(() => expect(clipboardView).toHaveBeenCalled());
    expect(clipboardStatus).toHaveBeenCalled();
    expect(onClipboardChanged).toHaveBeenCalledTimes(1);
  });

  it("页面挂载但主界面停靠：不加载、不订阅、不读状态", async () => {
    env({ docked: true });
    render(<ClipboardWorkspace variant="page" active />);
    await flush();
    expect(clipboardView).not.toHaveBeenCalled();
    expect(clipboardStatus).not.toHaveBeenCalled();
    expect(onClipboardChanged).not.toHaveBeenCalled();
  });

  it("停靠后恢复可见：uiActive 依赖变化驱动自动补一次加载", async () => {
    env({ docked: true });
    const view = render(<ClipboardWorkspace variant="page" active />);
    await flush();
    expect(clipboardView).not.toHaveBeenCalled();
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
    await vi.waitFor(() => expect(clipboardView).toHaveBeenCalledTimes(1));
    expect(clipboardStatus).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("抽屉变体：停靠期挂起，解除停靠后恢复并重新订阅实时", async () => {
    env();
    const view = render(
      <ClipboardWorkspace variant="drawer" active onClose={() => {}} />,
    );
    await vi.waitFor(() => expect(clipboardView).toHaveBeenCalledTimes(1));
    expect(onClipboardChanged).toHaveBeenCalledTimes(1);
    act(() => useEdgeSnapStore.setState({ phase: "docked-revealed" }));
    await flush();
    expect(clipboardView).toHaveBeenCalledTimes(1);
    // liveFullRefs 归零（无胶囊消费者）→ 全局监听随消费者计数拆除
    await vi.waitFor(() => expect(onClipboardChanged).toHaveBeenCalledTimes(1));
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
    await vi.waitFor(() => expect(clipboardView).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onClipboardChanged).toHaveBeenCalledTimes(2));
    view.unmount();
  });

  it("ClipboardPanel 按模式门控：compact 下即使 tab=clipboard 也不活跃", async () => {
    env({ mode: "compact" });
    render(<ClipboardPanel />);
    await flush();
    expect(clipboardView).not.toHaveBeenCalled();
    // 切回完整模式：面板重新活跃并加载
    act(() => useSettingsStore.setState({ settings: { mode: "full" } as never }));
    await vi.waitFor(() => expect(clipboardView).toHaveBeenCalledTimes(1));
  });
});
