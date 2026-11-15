// @vitest-environment jsdom
//! 大型工作台左侧导航拖拽排序（2026-11-15）。
//!
//! 覆盖真实链路：
//! 指针拖拽（useNavDragSort）→ 顺序意图（useNavOrderDraft）→ `navigation_layout`
//! 合并落库（useSettingsStore.update）→ 重新挂载读回。
//!
//! 业务面板全部用轻量替身；本文件只验证导航排序契约，不重复测各页面自身行为。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  workspaceProjectList: vi.fn(),
  devProjectList: vi.fn(),
  workspaceSetActiveProject: vi.fn(),
  workspaceProjectSave: vi.fn(),
  onWorkbenchNavigate: vi.fn(),
  workbenchTakeNav: vi.fn(),
  workbenchNavAck: vi.fn(),
  onSettingsChanged: vi.fn(),
  listTasks: vi.fn(),
  taskStats: vi.fn(),
  agentSnapshot: vi.fn(),
  actionsFeed: vi.fn(),
  fetchTask: vi.fn(),
  // 只有设置写入需要真实往返：排序草稿依赖它拿到「后端设置完整快照」。
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
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
vi.mock("../components/ui/TooltipLayer", () => ({ default: () => null }));
vi.mock("../store/useHotkeysStore", () => ({ useHotkeysRuntime: () => undefined }));

import WorkbenchShell from "./WorkbenchShell";
import NavigationVisibilitySection from "../components/settings/NavigationVisibilitySection";
import { defaultNavigationLayout } from "../lib/navVisibility";
import { resetNavOrderIntents } from "../lib/navOrderIntent";
import { useSettingsStore } from "../store/useSettingsStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { useUiStore } from "../store/useUiStore";

/** 与 workbench.css 的行高一致：36px 行 + 1px gap。 */
const ROW_H = 36;
const ROW_STEP = 37;
/** 设置页行高只用于几何桩，不参与断言。 */
const SETTINGS_ROW_STEP = 45;

function makeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 240,
    width: 240,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function baseSettings() {
  return {
    mode: "full",
    actions_paused: false,
    workbench_current_task: "",
    workbench_current_project: "",
    workspace_active_project: "",
    navigation_layout: defaultNavigationLayout(),
    workbench_layout: undefined,
  };
}

function unlisten(): Promise<() => void> {
  return Promise.resolve(() => {});
}

function navList(): HTMLElement {
  const list = document.querySelector<HTMLElement>(".wb-nav-items");
  if (!list) throw new Error("导航列表尚未渲染");
  return list;
}

function navRows(): HTMLElement[] {
  return [...navList().querySelectorAll<HTMLElement>("[data-nav-entry]")];
}

function navIds(): string[] {
  return navRows().map((row) => row.dataset.navEntry ?? "");
}

function stubNavGeometry(): void {
  const list = navList();
  Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 0 });
  list.getBoundingClientRect = () => makeRect(0, 900);
  navRows().forEach((row, index) => {
    row.getBoundingClientRect = () => makeRect(index * ROW_STEP, ROW_H);
  });
}

function stubSettingsGeometry(): HTMLElement[] {
  const list = document.querySelector<HTMLElement>(".nav-visibility-list");
  if (!list) throw new Error("设置页排序列表尚未渲染");
  Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 0 });
  list.getBoundingClientRect = () => makeRect(0, 900);
  const rows = [...list.querySelectorAll<HTMLElement>(".nav-visibility-row")];
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => makeRect(index * SETTINGS_ROW_STEP, SETTINGS_ROW_STEP - 1);
  });
  return rows;
}

let pointerSeq = 0;

/** 按下并移动超过 5px 阈值：与真实鼠标「按下—拖出」顺序一致。 */
function startDrag(element: HTMLElement, fromY: number, toY: number): number {
  pointerSeq += 1;
  const pointerId = pointerSeq;
  fireEvent.pointerDown(element, {
    pointerId,
    button: 0,
    pointerType: "mouse",
    clientX: 24,
    clientY: fromY,
  });
  fireEvent.pointerMove(window, {
    pointerId,
    pointerType: "mouse",
    clientX: 24,
    clientY: fromY + 10,
  });
  fireEvent.pointerMove(window, {
    pointerId,
    pointerType: "mouse",
    clientX: 24,
    clientY: toY,
  });
  return pointerId;
}

function finishDrag(pointerId: number, toY: number): void {
  fireEvent.pointerUp(window, {
    pointerId,
    pointerType: "mouse",
    clientX: 24,
    clientY: toY,
  });
}

function rowCenterY(index: number): number {
  return index * ROW_STEP + ROW_H / 2;
}

function dragNavRowBefore(id: string, beforeId: string): void {
  const rows = navRows();
  const fromIndex = rows.findIndex((row) => row.dataset.navEntry === id);
  const beforeIndex = rows.findIndex((row) => row.dataset.navEntry === beforeId);
  const toY = beforeIndex * ROW_STEP + 2;
  const pointerId = startDrag(rows[fromIndex], rowCenterY(fromIndex), toY);
  finishDrag(pointerId, toY);
}

function dragNavRowToTop(id: string): void {
  const rows = navRows();
  const fromIndex = rows.findIndex((row) => row.dataset.navEntry === id);
  const pointerId = startDrag(rows[fromIndex], rowCenterY(fromIndex), 2);
  finishDrag(pointerId, 2);
}

function dragSettingsRowToTop(id: string): void {
  const rows = stubSettingsGeometry();
  const index = rows.findIndex((row) => row.dataset.navEntry === id);
  const handle = within(rows[index]).getByRole("button", { name: /拖拽排序/ });
  const pointerId = startDrag(handle, index * SETTINGS_ROW_STEP + 20, 2);
  finishDrag(pointerId, 2);
}

function navWriteCalls(): Array<Record<string, unknown>> {
  return bridge.updateSettings.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((patch) => patch && "navigation_layout" in patch);
}

function savedLeft(): string[] {
  const layout = useSettingsStore.getState().settings?.navigation_layout;
  return layout?.left ?? [];
}

async function renderShell(): Promise<void> {
  render(<WorkbenchShell />);
  await screen.findByRole("heading", { name: "工作台首页", level: 2 });
  stubNavGeometry();
}

beforeEach(() => {
  // 调用记录不能跨用例累积：本文件多处按「本用例写了几次」断言。
  bridge.updateSettings.mockClear();
  bridge.getSettings.mockClear();
  bridge.workspaceProjectList.mockResolvedValue({ projects: [] });
  bridge.devProjectList.mockResolvedValue({ projects: [] });
  bridge.workspaceSetActiveProject.mockResolvedValue({ ok: true });
  bridge.workspaceProjectSave.mockResolvedValue({ project: { id: "p1", name: "新项目" } });
  bridge.onWorkbenchNavigate.mockImplementation(unlisten);
  bridge.workbenchTakeNav.mockResolvedValue(null);
  bridge.workbenchNavAck.mockResolvedValue(undefined);
  bridge.fetchTask.mockRejectedValue(new Error("任务不存在"));
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
  // 后端语义：返回「写入后的完整设置快照」。
  bridge.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
    const current = useSettingsStore.getState().settings ?? baseSettings();
    return { ...current, ...patch } as never;
  });
  bridge.getSettings.mockImplementation(async () => useSettingsStore.getState().settings as never);

  useSettingsStore.setState({
    settings: baseSettings() as never,
    loadError: null,
    load: vi.fn(async () => {}),
  });
  useTasksStore.setState({ stats: null, tasks: [] });
  useActionsStore.setState({ feed: null });
  useCaptureStore.setState({ inboxCount: 0, refreshInboxCount: vi.fn() as never });
  useUiStore.setState({
    tab: "tasks",
    pendingTab: null,
    context: { open: false, task: null },
    toast: null,
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  resetNavOrderIntents();
});

describe("工作台侧栏鼠标拖拽", () => {
  it("拖拽「文件工作区」到「工作空间」之前：显示落点线、相邻行让位、松手立即生效并入 SQLite", async () => {
    await renderShell();
    const list = navList();
    const rows = navRows();
    const filesIndex = rows.findIndex((row) => row.dataset.navEntry === "files");
    const workspaceIndex = rows.findIndex((row) => row.dataset.navEntry === "workspace");
    const toY = workspaceIndex * ROW_STEP + 2;

    const pointerId = startDrag(rows[filesIndex], rowCenterY(filesIndex), toY);

    // 拖拽态：跟手的行、细线落点、相邻行按「行高 + 间距」让位。
    const dragging = list.querySelector<HTMLElement>(".wb-nav-item.is-dragging");
    expect(dragging?.dataset.navEntry).toBe("files");
    const line = list.querySelector<HTMLElement>(".wb-nav-drop-line");
    expect(line).toBeTruthy();
    expect(parseFloat(line?.style.top ?? "")).toBe(workspaceIndex * ROW_STEP);
    expect(rows[workspaceIndex].style.transform).toBe(`translateY(${ROW_STEP}px)`);
    // 二维拖拽：只有位移，没有缩放/旋转。
    expect(dragging?.style.transform).toBe(`translateY(${toY - rowCenterY(filesIndex)}px)`);

    finishDrag(pointerId, toY);

    // 松手后立即显示新顺序（意图层，不等落库）。
    expect(navIds().slice(0, 4)).toEqual(["workbench", "files", "workspace", "tasks"]);
    expect(list.querySelector(".wb-nav-drop-line")).toBeNull();
    expect(list.querySelector(".wb-nav-item.is-dragging")).toBeNull();

    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    expect(savedLeft()).toEqual([...navIds(), "settings"]);
  });
});

describe("跨分组排序", () => {
  it("把「历史」拖到顶部后位置严格跟随 navigation_layout.left，标题按连续分组分段（允许重复）", async () => {
    await renderShell();

    dragNavRowToTop("history");

    expect(navIds()[0]).toBe("history");
    expect(navIds()[1]).toBe("workbench");
    // 分段标题按「连续入口的静态分组」生成：历史(planning) 单独一段，
    // 随后回到 core，再回到 flow，最后 system——允许「自动化与内容」重复出现。
    expect(
      [...document.querySelectorAll<HTMLElement>(".wb-nav-group")].map((node) => node.textContent),
    ).toEqual(["自动化与内容", "工作协同", "自动化与内容", "项目与系统"]);

    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    expect(savedLeft()[0]).toBe("history");
    // 成员集合不变：排序不增删入口。
    expect(new Set(savedLeft())).toEqual(new Set(defaultNavigationLayout().left));
  });
});

describe("点击语义", () => {
  it("普通点击仍打开页面，且不触发排序写入", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    const tasksButton = within(nav).getByRole("button", { name: "任务" });

    // 真实点击 = pointerdown + pointerup + click（未越过阈值，不算拖拽）。
    fireEvent.pointerDown(tasksButton, {
      pointerId: 101,
      button: 0,
      pointerType: "mouse",
      clientX: 24,
      clientY: rowCenterY(3),
    });
    fireEvent.pointerUp(window, { pointerId: 101, pointerType: "mouse" });
    fireEvent.click(tasksButton);

    expect(await screen.findByTestId("tasks-panel")).toBeTruthy();
    expect(navWriteCalls()).toHaveLength(0);
  });

  it("拖拽松手后浏览器补发的 click 不会跳转页面", async () => {
    await renderShell();
    dragNavRowToTop("clipboard");

    const clipboard = navList().querySelector<HTMLElement>('[data-nav-entry="clipboard"]');
    expect(clipboard).toBeTruthy();
    fireEvent.click(clipboard as HTMLElement);

    // 仍在首页：拖拽后的 click 是补发事件，不是打开页面。
    expect(screen.getByRole("heading", { name: "工作台首页", level: 2 })).toBeTruthy();
    expect(screen.queryByTestId("tasks-panel")).toBeNull();
  });
});

describe("取消与固定入口", () => {
  it("Esc 取消：顺序不变、不写库、播报取消", async () => {
    await renderShell();
    const before = navIds();
    const rows = navRows();
    const filesIndex = rows.findIndex((row) => row.dataset.navEntry === "files");

    const pointerId = startDrag(rows[filesIndex], rowCenterY(filesIndex), 2);
    fireEvent.keyDown(document.body, { key: "Escape" });
    finishDrag(pointerId, 2);

    expect(navIds()).toEqual(before);
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    expect(screen.getByText("已取消排序")).toBeTruthy();
    expect(navWriteCalls()).toHaveLength(0);
  });

  it("工作台首页 / 设置 / 更多菜单都不在可拖拽列表里，也不产生排序", async () => {
    await renderShell();
    const list = navList();
    const before = navIds();
    expect(list.querySelector('[data-nav-entry="settings"]')).toBeNull();

    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    const fixed = [
      within(nav).getByRole("button", { name: "工作台首页" }),
      within(nav).getByRole("button", { name: "设置" }),
      within(nav).getByRole("button", { name: "更多功能入口" }),
    ];

    for (const button of fixed) {
      fireEvent.pointerDown(button, {
        pointerId: 111,
        button: 0,
        pointerType: "mouse",
        clientX: 24,
        clientY: 300,
      });
      fireEvent.pointerMove(window, {
        pointerId: 111,
        pointerType: "mouse",
        clientX: 24,
        clientY: 40,
      });
      expect(list.querySelector(".wb-nav-item.is-dragging")).toBeNull();
      expect(list.querySelector(".wb-nav-drop-line")).toBeNull();
      fireEvent.pointerUp(window, { pointerId: 111, pointerType: "mouse" });
    }

    expect(navIds()).toEqual(before);
    expect(navWriteCalls()).toHaveLength(0);
  });
});

describe("键盘排序与播报", () => {
  it("Alt+↑ 移动一格并保持焦点，aria-live 播报最终位置", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    const tasksButton = within(nav).getByRole("button", { name: "任务" });
    tasksButton.focus();

    fireEvent.keyDown(tasksButton, { key: "ArrowUp", altKey: true });

    expect(navIds().indexOf("tasks")).toBe(navIds().indexOf("files") - 1);
    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    // 焦点按稳定 ID 回到同一逻辑入口。
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.dataset.navEntry).toBe("tasks");
    expect(await screen.findByText(/「任务」已移到第 3 位/)).toBeTruthy();
    expect(savedLeft().indexOf("tasks")).toBe(savedLeft().indexOf("files") - 1);
  });

  it("没有 Alt 的上下键不触发排序", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    const tasksButton = within(nav).getByRole("button", { name: "任务" });
    const before = navIds();

    fireEvent.keyDown(tasksButton, { key: "ArrowUp" });
    fireEvent.keyDown(tasksButton, { key: "ArrowDown" });

    expect(navIds()).toEqual(before);
    expect(navWriteCalls()).toHaveLength(0);
  });
});

describe("持久化、回滚与快速连续排序", () => {
  it("保存失败：界面回滚到上次保存的顺序，并给出明确错误", async () => {
    await renderShell();
    const before = navIds();
    bridge.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      if ("navigation_layout" in patch) throw new Error("disk full");
      const current = useSettingsStore.getState().settings ?? baseSettings();
      return { ...current, ...patch } as never;
    });

    dragNavRowBefore("files", "workspace");
    expect(navIds().slice(0, 3)).toEqual(["workbench", "files", "workspace"]);

    await waitFor(() => expect(navIds()).toEqual(before), { timeout: 2500 });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("disk full");
    expect(savedLeft()).toEqual(defaultNavigationLayout().left);
  });

  it("连续快速拖拽只落最后一次结果，不出现旧快照覆盖", async () => {
    await renderShell();

    dragNavRowToTop("roadmap");
    stubNavGeometry();
    dragNavRowToTop("history");

    const finalOrder = [...navIds(), "settings"];
    await waitFor(() => expect(savedLeft()).toEqual(finalOrder), { timeout: 2500 });

    // 收尾后不再有迟到的旧写入把顺序覆盖回去。
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    });
    expect(savedLeft()).toEqual(finalOrder);
    const lastNavWrite = navWriteCalls().at(-1);
    expect((lastNavWrite?.navigation_layout as { left: string[] }).left).toEqual(finalOrder);
  });

  it("重新挂载后从 SQLite 配置恢复顺序", async () => {
    const first = render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    stubNavGeometry();

    dragNavRowBefore("files", "workspace");
    const order = navIds();
    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    expect(savedLeft()).toEqual([...order, "settings"]);
    first.unmount();

    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    expect(navIds()).toEqual(order);
    // 未落库意图不得残留：重新挂载后读的是已提交配置。
    expect(navWriteCalls()).toHaveLength(1);
  });
});

describe("设置页与大型工作台同步", () => {
  it("侧栏拖拽立即同步到设置页；设置页卸载不会重复保存或丢掉侧栏排序", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    stubNavGeometry();

    const settingsRender = render(<NavigationVisibilitySection />);
    const settingsList = document.querySelector<HTMLElement>(".nav-visibility-list");
    expect(settingsList).toBeTruthy();

    dragNavRowBefore("files", "workspace");
    const moved = navIds();

    // 侧栏松手后设置页立即看到同一份意图（未落库也同步）。
    expect(
      [...(settingsList as HTMLElement).querySelectorAll<HTMLElement>("[data-nav-entry]")]
        .map((row) => row.dataset.navEntry)
        .slice(0, 3),
    ).toEqual(["workbench", "files", "workspace"]);

    // 设置页先卸载：它只是订阅者，不能抢先落库或清掉侧栏的意图。
    settingsRender.unmount();
    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    expect(savedLeft()).toEqual([...moved, "settings"]);
    expect(navIds()).toEqual(moved);
  });

  it("设置页拖拽立即同步回侧栏，且只由设置页写一次", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    stubNavGeometry();
    render(<NavigationVisibilitySection />);

    dragSettingsRowToTop("clipboard");

    // 侧栏顺序即时跟随（不需要等落库）。
    expect(navIds()[0]).toBe("clipboard");
    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    expect(savedLeft()).toEqual([...navIds(), "settings"]);
  });
});

describe("显隐与恢复默认不回归", () => {
  it("隐藏入口后侧栏不再渲染，恢复默认后回到默认顺序", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    stubNavGeometry();
    render(<NavigationVisibilitySection />);

    fireEvent.click(screen.getByRole("switch", { name: "文件工作区导航入口显示" }));
    await waitFor(() => expect(navIds()).not.toContain("files"));
    // 隐藏不影响顺序意图：其余入口相对顺序不变（设置入口固定、不在此列表）。
    expect(navIds()).toEqual(
      defaultNavigationLayout().left.filter((id) => id !== "files" && id !== "settings"),
    );

    fireEvent.click(screen.getByRole("button", { name: "恢复完整面板默认导航配置" }));
    await waitFor(() => expect(navIds()).toContain("files"));
    expect(navIds()).toEqual(
      defaultNavigationLayout().left.filter((id) => id !== "settings"),
    );
    expect(savedLeft()).toEqual(defaultNavigationLayout().left);
  });
});
