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
import { cleanup, render } from "@testing-library/react";
import { act } from "react";

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
  onAgentChanged: async () => () => undefined,
  onAppReady: async () => () => undefined,
  onFocusQuickAdd: async () => () => undefined,
  onModeChanged: async () => () => undefined,
  onNotification: async () => () => undefined,
  onNotificationNavigate: async () => () => undefined,
  onQuickCaptureCreated: async () => () => undefined,
  onReminderFired: async () => () => undefined,
  onReminderSnoozed: async () => () => undefined,
  onThemeChanged: async () => () => undefined,
  undoSnooze: async () => [0, 0],
}));

vi.mock("./hooks/useEdgeSnap", () => ({
  useEdgeSnap: () => undefined,
  useWindowPersistence: () => undefined,
}));

vi.mock("./hooks/useGlobalShortcuts", () => ({ useGlobalShortcuts: () => undefined }));

vi.mock("./components/TitleBar", () => ({ default: () => <div data-testid="titlebar" /> }));
vi.mock("./components/MinimalView", () => ({ default: () => <div /> }));
vi.mock("./components/CompactView", () => ({ default: () => <div /> }));
vi.mock("./components/FullView", () => ({ default: () => <div /> }));
vi.mock("./components/tasks/TaskEditor", () => ({ default: () => null }));
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

// 业务 store 换成最小替身：避免真实 action 调后端（未 mock 的桥接函数会抛错）。
vi.mock("./store/useSettingsStore", () => {
  const state = {
    settings: { mode: "full", snap_enabled: true, actions_enabled: true, material: "solid" },
    materialInfo: { resolved: "solid" },
    load: () => undefined,
    syncExternal: () => undefined,
  };
  const useSettingsStore = (sel: (s: typeof state) => unknown) => sel(state);
  (useSettingsStore as unknown as { getState: () => typeof state }).getState = () => state;
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
import { useEdgeSnapStore } from "./store/useEdgeSnapStore";

function setSnap(p: {
  phase: "free" | "docked-visible" | "docked-hidden" | "docked-revealed";
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

beforeEach(() => {
  useEdgeSnapStore.getState().reset();
});

afterEach(() => {
  cleanup();
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
  });

  it("停靠展开：胶囊 + 面板同时存在", () => {
    const { container } = render(<App />);
    setSnap({ phase: "docked-revealed", dockedEdge: "top" });
    expect(container.querySelector(".dock-window.is-capsule")).toBeTruthy();
    expect(container.querySelector(".capsule-dock")).toBeTruthy();
    expect(container.querySelector(".capsule-panel")).toBeTruthy();
  });

  it("只有相位没有停靠边：不进入胶囊模式（主界面保持可见）", () => {
    const { container } = render(<App />);
    setSnap({ phase: "docked-hidden", dockedEdge: null });
    const root = container.querySelector(".dock-window")!;
    expect(root.className).not.toContain("is-capsule");
    expect(container.querySelector(".capsule-dock")).toBeNull();
    expect((container.querySelector(".dock-app") as HTMLElement).hasAttribute("inert")).toBe(false);
  });
});
