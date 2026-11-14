// @vitest-environment jsdom
//! 工作台外壳：无项目启动、单一导航来源、路由切换与布局持久化。
//!
//! 业务面板全部用轻量替身：本测试只验证外壳契约，不重复测各页面自身行为。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  workspaceProjectList: vi.fn(),
  devProjectList: vi.fn(),
  workspaceSetActiveProject: vi.fn(),
  workspaceProjectSave: vi.fn(),
  onWorkbenchNavigate: vi.fn(),
  workbenchTakeNav: vi.fn(),
  workbenchNavAck: vi.fn(),
  onProjectWorkspaceProjectSelected: vi.fn(),
  onSettingsChanged: vi.fn(),
  // 外壳挂载时的一次性业务读取（不启动后台调度）。
  listTasks: vi.fn(),
  taskStats: vi.fn(),
  agentSnapshot: vi.fn(),
  actionsFeed: vi.fn(),
}));

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return { ...actual, ...bridge };
});

vi.mock("../components/tasks/TasksPanel", () => ({
  default: () => <div data-testid="tasks-panel" />,
}));
vi.mock("../components/agents/AgentPanel", () => ({
  default: () => <div data-testid="agents-panel" />,
}));
vi.mock("../components/actions/ActionCenterPanel", () => ({ default: () => null }));
vi.mock("../components/clipboard/ClipboardPanel", () => ({ default: () => null }));
vi.mock("../components/clipboard/ClipboardDrawer", () => ({ default: () => null }));
vi.mock("../components/collection/CollectionPanel", () => ({ default: () => null }));
vi.mock("../components/workbench/DevWorkbenchPanel", () => ({ default: () => null }));
vi.mock("../components/apps/AppsPanel", () => ({ default: () => null }));
vi.mock("../components/widgets/WidgetsPanel", () => ({ default: () => null }));
vi.mock("../components/widgets/liveSources", () => ({ WIDGET_SOURCES: [] }));
vi.mock("../components/mobile/MobileTransferPanel", () => ({ default: () => null }));
vi.mock("../components/workflows/WorkflowsPanel", () => ({ default: () => null }));
vi.mock("../components/history/HistoryPanel", () => ({ default: () => null }));
vi.mock("../components/roadmap/PlanningCenterPanel", () => ({ default: () => null }));
vi.mock("../components/settings/SettingsPanel", () => ({ default: () => null }));
vi.mock("../components/help/HelpCenterPanel", () => ({ default: () => null }));
vi.mock("../components/diagnostics/DiagnosticsCenterPanel", () => ({ default: () => null }));
vi.mock("../components/resource/ResourceManagementPanel", () => ({ default: () => null }));
vi.mock("./ProjectWorkspacePanel", () => ({ default: () => null }));
vi.mock("../components/global-search/GlobalSearchDialog", () => ({
  GlobalSearchDialog: () => null,
}));
vi.mock("../components/mobile/MobilePairingDialog", () => ({ default: () => null }));
vi.mock("../components/context/TaskContextDrawer", () => ({ default: () => null }));
vi.mock("../components/Toast", () => ({ default: () => null }));
vi.mock("../components/ui/TooltipLayer", () => ({ default: () => null }));
vi.mock("../store/useHotkeysStore", () => ({ useHotkeysRuntime: () => undefined }));

import WorkbenchShell from "./WorkbenchShell";
import { useSettingsStore } from "../store/useSettingsStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { useUiStore } from "../store/useUiStore";

const SETTINGS = {
  mode: "full",
  actions_paused: false,
  workbench_current_task: "",
  workbench_current_project: "",
  workspace_active_project: "",
  navigation_layout: undefined,
  workbench_layout: undefined,
};

function unlisten(): Promise<() => void> {
  return Promise.resolve(() => {});
}

beforeEach(() => {
  bridge.workspaceProjectList.mockResolvedValue({ projects: [] });
  bridge.devProjectList.mockResolvedValue({ projects: [] });
  bridge.workspaceSetActiveProject.mockResolvedValue({ ok: true });
  bridge.workspaceProjectSave.mockResolvedValue({ project: { id: "p1", name: "新项目" } });
  bridge.onWorkbenchNavigate.mockImplementation(unlisten);
  bridge.workbenchTakeNav.mockResolvedValue(null);
  bridge.workbenchNavAck.mockResolvedValue(undefined);
  bridge.onProjectWorkspaceProjectSelected.mockImplementation(unlisten);
  bridge.onSettingsChanged.mockImplementation(unlisten);
  bridge.listTasks.mockResolvedValue([]);
  bridge.taskStats.mockResolvedValue({
    pending: 0,
    overdue: 0,
    due_today: 0,
    completed_today: 0,
    next_due_at: null,
  });
  bridge.agentSnapshot.mockResolvedValue({
    live: [],
    live_summary: { running: 0, waiting: 0, failed: 0, disconnected: 0 },
  });
  bridge.actionsFeed.mockResolvedValue({
    enabled: false,
    generated_at: "2026-11-14T00:00:00Z",
    counts: { total: 0, intervention: 0, running: 0, reminder: 0 },
    items: [],
  });

  useSettingsStore.setState({
    settings: SETTINGS as never,
    loadError: null,
    load: vi.fn(async () => {}),
    update: vi.fn(async (patch: Record<string, unknown>) => ({
      ...SETTINGS,
      ...patch,
    })) as never,
  });
  useTasksStore.setState({ stats: null });
  useActionsStore.setState({ feed: null });
  useCaptureStore.setState({ inboxCount: 0, refreshInboxCount: vi.fn() as never });
  useUiStore.setState({ tab: "tasks", pendingTab: null });
});

afterEach(cleanup);

describe("WorkbenchShell", () => {
  it("没有项目也能启动到首页，并从唯一注册中心渲染侧栏", async () => {
    render(<WorkbenchShell />);
    expect(await screen.findByRole("heading", { name: "工作台首页", level: 2 })).toBeTruthy();

    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    for (const label of ["任务", "Agent", "工作空间", "设置"]) {
      expect(within(nav).getByRole("button", { name: label })).toBeTruthy();
    }
    // 项目选择器降级为「未选择项目」，不是空白/假项目。
    expect(screen.getByRole("combobox").textContent).toContain("未选择项目");
    // 首页通用入口可用（不需要先建项目）：快速操作宫格含「新建任务」。
    expect(screen.getByText("新建任务", { selector: ".wb-quick-tile span" })).toBeTruthy();
  });

  it("点击侧栏切换到任务页并持久化工作台路由", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });

    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    fireEvent.click(within(nav).getByRole("button", { name: "任务" }));

    expect(await screen.findByTestId("tasks-panel")).toBeTruthy();
    await waitFor(() => {
      expect(useSettingsStore.getState().update).toHaveBeenCalledWith(
        expect.objectContaining({
          workbench_layout: expect.objectContaining({ route: "tasks" }),
        }),
      );
    });
  });

  it("切换路由不卸载已访问页面（保活以保留草稿与滚动位置）", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    fireEvent.click(within(nav).getByRole("button", { name: "任务" }));
    expect(await screen.findByTestId("tasks-panel")).toBeTruthy();

    fireEvent.click(within(nav).getByRole("button", { name: "Agent" }));
    expect(await screen.findByTestId("agents-panel")).toBeTruthy();
    // 任务页仍在 DOM 中，只是被 hidden 槽位隐藏。
    const tasks = screen.getByTestId("tasks-panel");
    const slot = tasks.closest(".wb-route") as HTMLElement;
    expect(slot.hidden).toBe(true);
  });

  it("Tauri 事件丢失时，Rust 页面 ping 仍能拉取队列并回执", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });

    bridge.workbenchTakeNav.mockResolvedValue({
      requestId: 9001,
      target: { tab: "agents" },
    });
    window.dispatchEvent(new Event("taskdock-workbench-nav-ping"));

    expect(await screen.findByTestId("agents-panel")).toBeTruthy();
    expect(bridge.workbenchNavAck).toHaveBeenCalledWith({
      requestId: 9001,
      status: "succeeded",
      error: null,
    });
  });

  it("一次 ping 拉空积压队列：页面重载期间错过的请求也会被处理并回执", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });

    bridge.workbenchTakeNav
      .mockResolvedValueOnce({ requestId: 9101, target: { tab: "tasks" } })
      .mockResolvedValueOnce({ requestId: 9102, target: { tab: "agents" } })
      .mockResolvedValue(null);
    window.dispatchEvent(new Event("taskdock-workbench-nav-ping"));

    expect(await screen.findByTestId("agents-panel")).toBeTruthy();
    expect(bridge.workbenchNavAck).toHaveBeenCalledWith({
      requestId: 9101,
      status: "succeeded",
      error: null,
    });
    expect(bridge.workbenchNavAck).toHaveBeenCalledWith({
      requestId: 9102,
      status: "succeeded",
      error: null,
    });
  });
});
