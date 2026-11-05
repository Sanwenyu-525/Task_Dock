/**
 * @vitest-environment jsdom
 */
//! 停靠态外壳（App 根节点）测试。
//!
//! 锁住「停靠时只存在胶囊」这条可见性契约的 DOM 侧：
//! - `phase=docked-*` 且停靠边已知 → 根节点带 `is-capsule`、`.dock-app` 隐藏并
//!   `inert`，`CapsuleDock` 挂载；
//! - 只有相位没有边 → **不**进入胶囊模式（主界面保持可见，也不会挂载空胶囊）；
//! - 未停靠 → 根节点没有 `is-capsule`，胶囊不挂载。
//!
//! 原生区域（Win32 `SetWindowRgn`）不在这里断言：那是
//! `window_shape.rs` 与 `useEdgeSnap.integration.test.tsx` 的职责。
//! CSS 侧（根容器透明、装饰伪元素不绘制）由 `styles-themes.test.ts` 守卫。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { act } from "react";

// Tauri 事件订阅桩：保留真实的「注册 → 反订阅」语义，测试可手动派发事件，
// 也可断言卸载后监听是否真正释放（App 依赖 scope.dispose 释放全部订阅）。
const bridgeMock = vi.hoisted(() => {
  const handlers = new Map<string, (payload?: unknown) => void>();
  const subscriptions: string[] = [];
  const unlistened: string[] = [];
  return {
    handlers,
    subscriptions,
    unlistened,
    /** 生成与 bridge.onXxx 同签名的订阅函数。 */
    listener:
      (event: string) =>
      (cb: (payload?: unknown) => void): Promise<() => void> => {
        subscriptions.push(event);
        handlers.set(event, cb);
        return Promise.resolve(() => {
          unlistened.push(event);
          if (handlers.get(event) === cb) handlers.delete(event);
        });
      },
    emit(event: string, payload?: unknown) {
      const cb = handlers.get(event);
      if (!cb) throw new Error(`事件 ${event} 没有订阅者`);
      cb(payload);
    },
    reset() {
      handlers.clear();
      subscriptions.length = 0;
      unlistened.length = 0;
    },
  };
});

// 设置 store 最小替身：syncExternal 记录入参，供「后端事件 → store 同步」断言。
const settingsMock = vi.hoisted(() => {
  const syncCalls: Array<Record<string, unknown>> = [];
  const state = {
    settings: {
      mode: "full",
      snap_enabled: true,
      actions_enabled: true,
      material: "solid",
      snap_display_mode: "capsule",
    },
    materialInfo: { resolved: "solid" },
    load: () => undefined,
    syncExternal: (patch: Record<string, unknown>) => {
      syncCalls.push(patch);
    },
  };
  return {
    state,
    syncCalls,
    reset() {
      syncCalls.length = 0;
    },
  };
});

// 重视图与副作用钩子全部替身：本测试只关心 App 的停靠外壳结构。
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: async () => undefined,
    outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: 400, height: 560 }),
  }),
}));

vi.mock("./lib/bridge", () => ({
  notifyUiReady: async () => true,
  onAgentChanged: bridgeMock.listener("agent-changed"),
  onAppReady: bridgeMock.listener("app-ready"),
  onFocusQuickAdd: bridgeMock.listener("focus-quick-add"),
  onModeChanged: bridgeMock.listener("mode-changed"),
  onNotification: bridgeMock.listener("notification"),
  onNotificationNavigate: bridgeMock.listener("notification-navigate"),
  onQuickCaptureCreated: bridgeMock.listener("quick-capture-created"),
  onReminderFired: bridgeMock.listener("reminder-fired"),
  onReminderSnoozed: bridgeMock.listener("reminder-snoozed"),
  onSnapFormChanged: bridgeMock.listener("snap-form-changed"),
  onThemeChanged: bridgeMock.listener("theme-changed"),
  undoSnooze: async () => [0, 0],
}));

vi.mock("./hooks/useEdgeSnap", () => ({
  useEdgeSnap: () => undefined,
  useWindowPersistence: () => undefined,
}));

vi.mock("./store/useHotkeysStore", () => ({ useHotkeysRuntime: () => undefined }));
// 外壳测试不覆盖音频通知：避免其真实订阅（useSettingsStore.subscribe / getState）
// 在最小 store 替身上抛错，污染停靠态断言。
vi.mock("./lib/audioNotification", () => ({ useAudioNotifications: () => undefined }));

vi.mock("./components/TitleBar", () => ({ default: () => <div data-testid="titlebar" /> }));
vi.mock("./components/MinimalView", () => ({ default: () => <div /> }));
vi.mock("./components/CompactView", () => ({ default: () => <div /> }));
vi.mock("./components/FullView", () => ({ default: () => <div /> }));
vi.mock("./components/navigation/WorkspaceLauncher", () => ({ default: () => null }));
vi.mock("./components/clipboard/ClipboardDrawer", () => ({ default: () => null }));
vi.mock("./components/context/TaskContextDrawer", () => ({ default: () => null }));
vi.mock("./components/Toast", () => ({ default: () => null }));
vi.mock("./components/ui/TooltipLayer", () => ({ default: () => null }));
vi.mock("./components/SnapOverlay", () => ({ default: () => null }));

// 面板内容会读任务/剪贴板/应用数据：本测试只验证外壳结构，面板内容用空实现。
vi.mock("./components/capsule/TasksLite", () => ({ default: () => <div /> }));
vi.mock("./components/capsule/AgentsLite", () => ({ default: () => <div /> }));
vi.mock("./components/capsule/ClipboardLite", () => ({ default: () => <div /> }));
vi.mock("./components/capsule/AppsLite", () => ({ default: () => <div /> }));
// 胶囊里的专注徽标会订阅 Tauri 事件：jsdom 无 IPC，隔离掉避免真实 listen。
vi.mock("./components/focus/FocusCapsuleBadge", () => ({ default: () => null }));

// 业务 store 换成最小替身：避免真实 action 调后端（未 mock 的桥接函数会抛错）。
vi.mock("./store/useSettingsStore", () => {
  const useSettingsStore = (sel: (s: typeof settingsMock.state) => unknown) =>
    sel(settingsMock.state);
  (useSettingsStore as unknown as { getState: () => typeof settingsMock.state }).getState = () =>
    settingsMock.state;
  return { useSettingsStore };
});

vi.mock("./store/useTasksStore", () => {
  const state = { stats: null, refresh: () => undefined, loadStats: () => undefined };
  const useTasksStore = (sel: (s: typeof state) => unknown) => sel(state);
  (useTasksStore as unknown as { getState: () => typeof state }).getState = () => state;
  return { useTasksStore };
});

vi.mock("./store/useAgentsStore", () => {
  const state = { snapshot: null, load: () => undefined };
  const useAgentsStore = (sel: (s: typeof state) => unknown) => sel(state);
  (useAgentsStore as unknown as { getState: () => typeof state }).getState = () => state;
  return { useAgentsStore, scheduleAgentRefresh: () => undefined };
});

vi.mock("./store/useActionsStore", () => ({
  useActionsStore: (sel: (s: { feed: null; load: () => undefined }) => unknown) =>
    sel({ feed: null, load: () => undefined }),
  scheduleActionsRefresh: () => undefined,
  cancelActionsRefresh: () => undefined,
  // App 的启动/事件路径按消费者门控调度聚合刷新；外壳测试统一返回 true，
  // 保证既有「启动即加载」断言语义不变（门控矩阵在 useActionsStore.test 单测）。
  shouldRefreshActions: () => true,
}));

vi.mock("./store/useUiStore", () => ({
  useUiStore: (sel: (s: { bumpQuickAdd: () => undefined }) => unknown) =>
    sel({ bumpQuickAdd: () => undefined }),
}));

vi.mock("./store/useNavigationStore", () => ({
  useNavigationStore: (sel: (s: { loadTaskLinks: () => undefined; loadTargets: () => undefined }) => unknown) =>
    sel({ loadTaskLinks: () => undefined, loadTargets: () => undefined }),
}));

import App from "./App";
import DeferredView from "./components/DeferredView";
import { useEdgeSnapStore } from "./store/useEdgeSnapStore";

function setSnap(p: {
  phase: "free" | "docked-visible" | "docked-hidden" | "docked-revealed" | "docked-full";
  dockedEdge: "left" | "right" | "top" | "bottom" | null;
}) {
  act(() => {
    useEdgeSnapStore.setState({
      phase: p.phase,
      dockedEdge: p.dockedEdge,
      candidateEdge: null,
      magnetized: false,
    });
  });
}

/** 渲染 App 并等待桥接订阅全部兑现（listen 返回 Promise<UnlistenFn>）。 */
async function renderApp() {
  const utils = render(<App />);
  await waitFor(() => expect(bridgeMock.handlers.has("snap-form-changed")).toBe(true));
  return utils;
}

beforeEach(() => {
  bridgeMock.reset();
  settingsMock.reset();
  useEdgeSnapStore.getState().reset();
});

afterEach(() => {
  cleanup();
  bridgeMock.reset();
  useEdgeSnapStore.getState().reset();
});

describe("App · 停靠态外壳", () => {
  it("未停靠：主界面可见，不挂载胶囊", () => {
    const { container } = render(<App />);
    const root = container.querySelector(".dock-window")!;
    expect(root.className).not.toContain("is-capsule");
    const app = container.querySelector(".dock-app") as HTMLElement;
    expect(app).toBeTruthy();
    expect(app.hasAttribute("inert")).toBe(false);
    expect(container.querySelector(".capsule-dock")).toBeNull();
    // 圆角区域裁掉了原生角热区：非停靠态需要四角缩放命中层
    expect(container.querySelectorAll(".resize-grip")).toHaveLength(4);
  });

  it("停靠折叠：根节点 is-capsule、主界面 inert、胶囊挂载", () => {
    const { container } = render(<App />);
    setSnap({ phase: "docked-hidden", dockedEdge: "left" });
    const root = container.querySelector(".dock-window")!;
    expect(root.className).toContain("is-capsule");
    const app = container.querySelector(".dock-app") as HTMLElement;
    expect(app.hasAttribute("inert")).toBe(true);
    expect(container.querySelector(".capsule-dock")).toBeTruthy();
    expect(container.querySelector(".capsule-panel")).toBeNull();
    // 胶囊期窗口区域只剩轨道，四角热区必须不参与命中
    expect(container.querySelector(".resize-grip")).toBeNull();
  });

  it("停靠展开：胶囊 + 面板同时存在", () => {
    const { container } = render(<App />);
    setSnap({ phase: "docked-revealed", dockedEdge: "top" });
    expect(container.querySelector(".dock-window.is-capsule")).toBeTruthy();
    expect(container.querySelector(".capsule-dock")).toBeTruthy();
    expect(container.querySelector(".capsule-panel")).toBeTruthy();
  });

  it("只有相位没有停靠边：外壳仍按停靠收起，且不挂载空胶囊", () => {
    const { container } = render(<App />);
    setSnap({ phase: "docked-hidden", dockedEdge: null });
    const root = container.querySelector(".dock-window")!;
    // 缺边是停靠期的不变量破损瞬时态：宁可短暂空白，也不让完整界面落进 Win32 残留裁剪区
    //（右侧曾出现只露一条翼片却带着完整控件）。CapsuleDock 无 edge 时返回 null，不产生空胶囊。
    expect(root.className).toContain("is-capsule");
    expect(container.querySelector(".capsule-dock")).toBeNull();
    expect((container.querySelector(".dock-app") as HTMLElement).hasAttribute("inert")).toBe(true);
  });

  it("完整面板停靠：主界面保持可见，显示「收缩为胶囊」入口", () => {
    const { container } = render(<App />);
    setSnap({ phase: "docked-full", dockedEdge: "left" });
    const root = container.querySelector(".dock-window")!;
    expect(root.className).not.toContain("is-capsule");
    const app = container.querySelector(".dock-app") as HTMLElement;
    expect(app.hasAttribute("inert")).toBe(false);
    expect(container.querySelector(".capsule-dock")).toBeNull();
    // 完整面板停靠态：贴边悬浮一个收缩入口；停靠几何由引擎维持，四角热区不参与命中。
    expect(container.querySelector(".cap-form-toggle")).toBeTruthy();
    expect(container.querySelector(".resize-grip")).toBeNull();
  });

  it("停靠形态切换：完整面板 ↔ 胶囊随相位原地更新", () => {
    const { container } = render(<App />);
    setSnap({ phase: "docked-full", dockedEdge: "right" });
    expect(container.querySelector(".cap-form-toggle")).toBeTruthy();
    expect(container.querySelector(".capsule-dock")).toBeNull();

    setSnap({ phase: "docked-hidden", dockedEdge: "right" });
    expect(container.querySelector(".dock-window")!.className).toContain("is-capsule");
    expect(container.querySelector(".capsule-dock")).toBeTruthy();
    expect(container.querySelector(".cap-form-toggle")).toBeNull();

    setSnap({ phase: "docked-full", dockedEdge: "right" });
    expect(container.querySelector(".dock-window")!.className).not.toContain("is-capsule");
    expect(container.querySelector(".cap-form-toggle")).toBeTruthy();
    expect(container.querySelector(".capsule-dock")).toBeNull();
  });
});

describe("App · 形态按钮只切换本次停靠会话", () => {
  it("胶囊「完整面板」走会话级 formSwitch，不触碰设置更新", () => {
    const formSwitch = vi.fn();
    const { container } = render(<App />);
    act(() => useEdgeSnapStore.setState({ formSwitch }));
    setSnap({ phase: "docked-revealed", dockedEdge: "left" });
    const button = container.querySelector(".cap-form") as HTMLButtonElement;
    expect(button).toBeTruthy();
    fireEvent.click(button);
    // 入口只表达「本次停靠会话切到完整面板」；长期偏好由设置页/右键菜单负责。
    expect(formSwitch).toHaveBeenCalledWith("full");
    expect(settingsMock.syncCalls).toHaveLength(0);
  });

  it("完整面板「收缩为胶囊」走会话级 formSwitch，不触碰设置更新", () => {
    const formSwitch = vi.fn();
    const { container } = render(<App />);
    act(() => useEdgeSnapStore.setState({ formSwitch }));
    setSnap({ phase: "docked-full", dockedEdge: "right" });
    const button = container.querySelector(".cap-form-toggle") as HTMLButtonElement;
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(formSwitch).toHaveBeenCalledWith("capsule");
    expect(settingsMock.syncCalls).toHaveLength(0);
  });
});

describe("App · 吸附形态事件同步", () => {
  it("snap-form-changed=full：同步 snap_display_mode=full", async () => {
    await renderApp();
    act(() => bridgeMock.emit("snap-form-changed", "full"));
    expect(settingsMock.syncCalls).toEqual([{ snap_display_mode: "full" }]);
  });

  it("snap-form-changed=capsule：同步 snap_display_mode=capsule", async () => {
    await renderApp();
    act(() => bridgeMock.emit("snap-form-changed", "capsule"));
    expect(settingsMock.syncCalls).toEqual([{ snap_display_mode: "capsule" }]);
  });

  it("未知取值按胶囊归一，避免写入非法形态", async () => {
    await renderApp();
    act(() => bridgeMock.emit("snap-form-changed", "bogus"));
    expect(settingsMock.syncCalls).toEqual([{ snap_display_mode: "capsule" }]);
  });

  it("每次事件只同步一次（订阅不重复、不叠加）", async () => {
    await renderApp();
    expect(bridgeMock.subscriptions.filter((e) => e === "snap-form-changed")).toHaveLength(1);
    act(() => {
      bridgeMock.emit("snap-form-changed", "full");
      bridgeMock.emit("snap-form-changed", "capsule");
    });
    expect(settingsMock.syncCalls).toEqual([
      { snap_display_mode: "full" },
      { snap_display_mode: "capsule" },
    ]);
  });

  it("卸载时释放订阅：unlisten 被调用且事件不再送达", async () => {
    const { unmount } = await renderApp();
    expect(bridgeMock.handlers.has("snap-form-changed")).toBe(true);
    unmount();
    // 传输层已完成反订阅：unlisten 被调用，事件路由里不再有该监听。
    expect(bridgeMock.unlistened).toContain("snap-form-changed");
    expect(bridgeMock.handlers.has("snap-form-changed")).toBe(false);
    expect(() => bridgeMock.emit("snap-form-changed", "full")).toThrow(/没有订阅者/);
    expect(settingsMock.syncCalls).toHaveLength(0);
  });
});

describe("DeferredView · 延迟首次挂载", () => {
  it("非激活视图在首次激活前不挂载子节点", () => {
    const { container, rerender } = render(
      <DeferredView active={false}>
        <div data-testid="deferred-child" />
      </DeferredView>,
    );
    expect(container.querySelector('[data-testid="deferred-child"]')).toBeNull();
    rerender(
      <DeferredView active>
        <div data-testid="deferred-child" />
      </DeferredView>,
    );
    expect(container.querySelector('[data-testid="deferred-child"]')).not.toBeNull();
  });

  it("首次激活后切回非激活：子树保持挂载（内容状态不丢）", () => {
    const view = (active: boolean) => (
      <DeferredView active={active}>
        <div data-testid="deferred-child" />
      </DeferredView>
    );
    const { container, rerender } = render(view(false));
    expect(container.querySelector('[data-testid="deferred-child"]')).toBeNull();
    rerender(view(true));
    expect(container.querySelector('[data-testid="deferred-child"]')).not.toBeNull();
    rerender(view(false));
    expect(container.querySelector('[data-testid="deferred-child"]')).not.toBeNull();
  });
});
