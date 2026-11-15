// @vitest-environment jsdom
//! 大型工作台左侧导航拖拽排序（2026-11-15）。
//!
//! 覆盖真实链路：
//! 指针拖拽（useNavDragSort）→ 顺序意图（useNavOrderDraft）→ `navigation_layout`
//! 合并落库（useSettingsStore.update）→ 重新挂载读回。
//!
//! 业务面板全部用轻量替身；本文件只验证导航排序契约，不重复测各页面自身行为。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTabGuard } from "../lib/tabGuard";

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

/** 拖拽只允许从手柄启动：所有拖拽用例必须命中 `[data-nav-grip]`。 */
function gripOf(row: HTMLElement): HTMLElement {
  const grip = row.querySelector<HTMLElement>("[data-nav-grip]");
  if (!grip) throw new Error(`入口 ${row.dataset.navEntry ?? "?"} 没有拖拽手柄`);
  return grip;
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
  const pointerId = startDrag(gripOf(rows[fromIndex]), rowCenterY(fromIndex), toY);
  finishDrag(pointerId, toY);
}

function dragNavRowToTop(id: string): void {
  const rows = navRows();
  const fromIndex = rows.findIndex((row) => row.dataset.navEntry === id);
  const pointerId = startDrag(gripOf(rows[fromIndex]), rowCenterY(fromIndex), 2);
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
  const layout = useSettingsStore.getState().settings?.navigation_layout as
    | { left: string[] }
    | undefined;
  return layout?.left ?? [];
}

async function renderShell(): Promise<void> {
  render(<WorkbenchShell />);
  await screen.findByRole("heading", { name: "工作台首页", level: 2 });
  stubNavGeometry();
}

async function openTasks(): Promise<void> {
  const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
  fireEvent.click(within(nav).getByRole("button", { name: "任务" }));
  await screen.findByTestId("tasks-panel");
}

/** 读取 workbench.css 中某个类的基础声明块，用于尺寸/命中区契约断言。 */
function cssRule(selector: string): string {
  const css = readFileSync(resolve(process.cwd(), "src/workbench/workbench.css"), "utf8");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  return end < 0 ? "" : css.slice(start, end);
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

    const pointerId = startDrag(gripOf(rows[filesIndex]), rowCenterY(filesIndex), toY);

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

  it("位移未超过 5px 阈值时不进入拖拽：没有落点线，也不写库", async () => {
    await renderShell();
    const rows = navRows();
    const filesIndex = rows.findIndex((row) => row.dataset.navEntry === "files");
    const before = navIds();
    const pointerId = pointerSeq + 1;

    fireEvent.pointerDown(gripOf(rows[filesIndex]), {
      pointerId,
      button: 0,
      pointerType: "mouse",
      clientX: 24,
      clientY: rowCenterY(filesIndex),
    });
    // 4px：两个轴都未达到 5px 阈值，仍是点击而不是拖拽。
    fireEvent.pointerMove(window, {
      pointerId,
      pointerType: "mouse",
      clientX: 26,
      clientY: rowCenterY(filesIndex) + 4,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    expect(navList().querySelector(".wb-nav-drop-line")).toBeNull();

    fireEvent.pointerUp(window, { pointerId, pointerType: "mouse" });
    expect(navIds()).toEqual(before);
    expect(navWriteCalls()).toHaveLength(0);
  });

  it("指针移出侧边栏后在窗口外松手：拖拽正常结束并按松手位置落位", async () => {
    await renderShell();
    const rows = navRows();
    const filesIndex = rows.findIndex((row) => row.dataset.navEntry === "files");
    const pointerId = startDrag(gripOf(rows[filesIndex]), rowCenterY(filesIndex), 320);

    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeTruthy();
    // 侧边栏高度只有 900px，1200 在列表外：窗口级 pointerup 必须仍能收尾。
    finishDrag(pointerId, 1200);

    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    expect(navList().querySelector(".wb-nav-drop-line")).toBeNull();
    expect(navIds().at(-1)).toBe("files");
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

    const pointerId = startDrag(gripOf(rows[filesIndex]), rowCenterY(filesIndex), 2);
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

  it("设置页切显隐时不重复写侧栏拥有的排序意图", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    stubNavGeometry();
    render(<NavigationVisibilitySection />);

    // 侧栏先拖拽：意图的所有者是侧栏实例，落库由它负责。
    dragNavRowBefore("files", "workspace");
    fireEvent.click(screen.getByRole("switch", { name: "Agent导航入口显示" }));

    await waitFor(() => expect(navIds()).not.toContain("agents"), { timeout: 3000 });
    const orders = navWriteCalls()
      .map((patch) => (patch.navigation_layout as { left?: string[] })?.left)
      .filter((left): left is string[] => Array.isArray(left));

    // 侧栏顺序只落一次（此时仍含 agents）；显隐写入是另一份且已不含 agents。
    expect(orders.filter((left) => left.includes("agents"))).toHaveLength(1);
    expect(orders.at(-1)?.includes("agents")).toBe(false);
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

describe("拖拽手柄放大与命中区", () => {
  it("手柄图标 18px、命中区 28×28；行高保持 36px，操作区固定占位且手柄在 × 左侧", async () => {
    await renderShell();
    const row = navRows()[0];
    const grip = gripOf(row);
    expect(grip.querySelector("svg")?.getAttribute("width")).toBe("18");
    expect(grip.querySelector("svg")?.getAttribute("height")).toBe("18");

    const actions = row.querySelector<HTMLElement>(".wb-nav-actions");
    expect(actions).toBeTruthy();
    expect(
      [...(actions?.querySelectorAll<HTMLElement>("[data-nav-grip], [data-nav-hide]") ?? [])].map(
        (node) => (node.matches("[data-nav-grip]") ? "grip" : "hide"),
      ),
    ).toEqual(["grip", "hide"]);

    const hide = within(row).getByRole("button", { name: /隐藏「.*」导航入口/ });
    expect(hide.querySelector("svg")?.getAttribute("width")).toBe("15");
    expect(hide.querySelector("svg")?.getAttribute("height")).toBe("15");

    // CSS 契约：视觉图标 18 / 命中区 28×28（不是只放大图标），行高不变。
    expect(cssRule(".wb-nav-grip")).toMatch(/width: 28px/);
    expect(cssRule(".wb-nav-grip")).toMatch(/height: 28px/);
    expect(cssRule(".wb-nav-grip")).toMatch(/flex: 0 0 28px/);
    expect(cssRule(".wb-nav-grip")).not.toMatch(/position: absolute/);
    expect(cssRule(".wb-nav-hide")).toMatch(/width: 24px/);
    expect(cssRule(".wb-nav-hide")).toMatch(/height: 24px/);
    expect(cssRule(".wb-nav-item")).toMatch(/min-height: 36px/);
    expect(cssRule(".wb-nav-actions")).toMatch(/display: inline-flex/);
  });

  it("拖拽进行中隐藏按钮禁用，取消拖拽后恢复可用", async () => {
    await renderShell();
    const filesIndex = navIds().indexOf("files");
    const filesRow = navRows()[filesIndex];
    const hide = within(filesRow).getByRole("button", {
      name: "隐藏「文件工作区」导航入口",
    }) as HTMLButtonElement;

    const pointerId = startDrag(gripOf(filesRow), rowCenterY(filesIndex), 2);
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeTruthy();
    expect(hide.disabled).toBe(true);

    fireEvent.keyDown(document.body, { key: "Escape" });
    finishDrag(pointerId, 2);
    await waitFor(() => expect(hide.disabled).toBe(false));
  });

  it("只有手柄能起拖：行体与 × 的指针位移不进入拖拽，点击手柄不导航", async () => {
    await renderShell();
    await openTasks();
    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    if (!filesRow) throw new Error("文件入口未渲染");
    const before = navIds();

    // 行体按下并移动：新交互只允许手柄起拖。
    fireEvent.pointerDown(filesRow, {
      pointerId: 201,
      button: 0,
      pointerType: "mouse",
      clientX: 80,
      clientY: rowCenterY(navIds().indexOf("files")),
    });
    fireEvent.pointerMove(window, {
      pointerId: 201,
      pointerType: "mouse",
      clientX: 80,
      clientY: 2,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 201, pointerType: "mouse" });
    expect(navIds()).toEqual(before);

    // 点手柄不触发导航（仍在任务页）。
    fireEvent.click(gripOf(filesRow));
    expect(screen.getByTestId("tasks-panel")).toBeTruthy();

    // 操作区空白（两个按钮之间的间隙）也不触发整行导航。
    fireEvent.click(filesRow.querySelector(".wb-nav-actions") as HTMLElement);
    expect(screen.getByTestId("tasks-panel")).toBeTruthy();

    // × 区域按下移动也不起拖。
    const hide = within(filesRow).getByRole("button", { name: "隐藏「文件工作区」导航入口" });
    fireEvent.pointerDown(hide, {
      pointerId: 202,
      button: 0,
      pointerType: "mouse",
      clientX: 180,
      clientY: rowCenterY(navIds().indexOf("files")),
    });
    fireEvent.pointerMove(window, {
      pointerId: 202,
      pointerType: "mouse",
      clientX: 180,
      clientY: 2,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 202, pointerType: "mouse" });
    expect(navIds()).toEqual(before);
  });
});

describe("点击 × 隐藏入口", () => {
  it("非当前页：立即从侧栏消失、不切页、写入 navigation_layout，隐藏后仍可被路由打开", async () => {
    await renderShell();
    await openTasks();
    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    if (!filesRow) throw new Error("文件入口未渲染");
    const hide = within(filesRow).getByRole("button", { name: "隐藏「文件工作区」导航入口" });
    const before = navIds();

    fireEvent.click(hide);

    await waitFor(() => expect(navIds()).not.toContain("files"));
    // 点击 × 不触发页面切换：仍在任务页。
    expect(screen.getByTestId("tasks-panel")).toBeTruthy();
    // 隐藏只移除目标入口，其余入口的相对顺序不变。
    expect(navIds()).toEqual(before.filter((id) => id !== "files"));
    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    expect(savedLeft()).not.toContain("files");
    expect(savedLeft()).toEqual([...navIds(), "settings"]);
    expect(await screen.findByText(/已隐藏「文件工作区」/)).toBeTruthy();

    // 隐藏 ≠ 删除：逻辑 Tab 仍可被快捷键/通知/深链打开。
    act(() => useUiStore.getState().setTab("files"));
    expect(useUiStore.getState().tab).toBe("files");
  });

  it("固定入口（首页 / 设置 / 更多）没有隐藏按钮；分组标题也没有", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    for (const button of [
      within(nav).getByRole("button", { name: "工作台首页" }),
      within(nav).getByRole("button", { name: "设置" }),
      within(nav).getByRole("button", { name: "更多功能入口" }),
    ]) {
      expect(button.querySelector("[data-nav-hide]")).toBeNull();
      expect(button.querySelector("[data-nav-grip]")).toBeNull();
    }
    expect(
      document.querySelectorAll(".wb-nav-group [data-nav-hide]"),
    ).toHaveLength(0);
    // 每个可排序入口都有独立的 ×，且不与手柄合并。
    for (const row of navRows()) {
      expect(row.querySelector("[data-nav-grip]")).toBeTruthy();
      expect(row.querySelector("[data-nav-hide]")).toBeTruthy();
    }
  });

  it("隐藏当前页走未保存门禁：取消不写配置不丢页面，确认后才隐藏并切到安全页", async () => {
    await renderShell();
    await openTasks();
    const tasksRow = navList().querySelector<HTMLElement>('[data-nav-entry="tasks"]');
    if (!tasksRow) throw new Error("任务入口未渲染");
    const hide = within(tasksRow).getByRole("button", { name: "隐藏「任务」导航入口" });

    const unregister = registerTabGuard({
      id: "test-task-editor",
      label: () => "任务草稿",
      isDirty: () => true,
      isBusy: () => false,
      discard: vi.fn(),
    });
    try {
      fireEvent.click(hide);
      expect(await screen.findByText(/有未保存的修改/)).toBeTruthy();
      expect(navIds()).toContain("tasks");
      expect(useUiStore.getState().tab).toBe("tasks");
      expect(navWriteCalls()).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
      expect(navIds()).toContain("tasks");
      expect(screen.getByTestId("tasks-panel")).toBeTruthy();
      expect(navWriteCalls()).toHaveLength(0);

      fireEvent.click(hide);
      expect(await screen.findByText(/有未保存的修改/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "放弃修改并切换" }));

      await waitFor(() => expect(navIds()).not.toContain("tasks"));
      await waitFor(() => expect(savedLeft()).not.toContain("tasks"));
      expect(useUiStore.getState().tab).toBe("workbench");
    } finally {
      unregister();
    }
  });

  it("设置页同步：侧栏 × 隐藏后开关为关，重新开启后侧栏入口恢复", async () => {
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    stubNavGeometry();
    render(<NavigationVisibilitySection />);

    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    if (!filesRow) throw new Error("文件入口未渲染");
    fireEvent.click(
      within(filesRow).getByRole("button", { name: "隐藏「文件工作区」导航入口" }),
    );
    await waitFor(() => expect(navIds()).not.toContain("files"));

    const toggle = screen.getByRole("switch", { name: "文件工作区导航入口显示" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(navIds()).toContain("files"));
    expect(savedLeft()).toContain("files");
    expect(navIds()).toEqual(
      defaultNavigationLayout().left.filter((id) => id !== "settings"),
    );
  });

  it("重新挂载后隐藏状态从 SQLite 配置保留", async () => {
    const first = render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    stubNavGeometry();
    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    if (!filesRow) throw new Error("文件入口未渲染");
    fireEvent.click(
      within(filesRow).getByRole("button", { name: "隐藏「文件工作区」导航入口" }),
    );
    await waitFor(() => expect(navIds()).not.toContain("files"));
    first.unmount();

    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    expect(navIds()).not.toContain("files");
    expect(savedLeft()).not.toContain("files");
  });

  it("快速拖拽后立即隐藏：隐藏写入不覆盖排序，迟到写入也不会把已隐藏入口带回来", async () => {
    await renderShell();

    dragNavRowBefore("files", "workspace");
    const clipboardRow = navList().querySelector<HTMLElement>('[data-nav-entry="clipboard"]');
    if (!clipboardRow) throw new Error("剪贴板入口未渲染");
    fireEvent.click(
      within(clipboardRow).getByRole("button", { name: "隐藏「剪贴板」导航入口" }),
    );

    await waitFor(() => expect(savedLeft()).not.toContain("clipboard"), { timeout: 3000 });
    expect(savedLeft().indexOf("files")).toBe(savedLeft().indexOf("workspace") - 1);
    const finalOrder = [...navIds(), "settings"];
    expect(savedLeft()).toEqual(finalOrder);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    });
    expect(savedLeft()).toEqual(finalOrder);
    expect(savedLeft()).not.toContain("clipboard");
  });
});
