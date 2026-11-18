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
import { defaultWorkbenchLayout, shouldCompactWorkbenchNavLabels } from "../lib/workbenchLayout";
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

/** 拖拽手柄是整行拖拽面上的视觉提示，仍可用于明确的坐标断言。 */
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

/** 按下并移动超过 6px 阈值：与真实鼠标「按下—拖出」顺序一致。 */
function startDrag(element: HTMLElement, fromY: number, toY: number, fromX = 24): number {
  pointerSeq += 1;
  const pointerId = pointerSeq;
  fireEvent.pointerDown(element, {
    pointerId,
    button: 0,
    pointerType: "mouse",
    clientX: fromX,
    clientY: fromY,
  });
  fireEvent.pointerMove(window, {
    pointerId,
    pointerType: "mouse",
    clientX: fromX,
    clientY: fromY + 10,
  });
  fireEvent.pointerMove(window, {
    pointerId,
    pointerType: "mouse",
    clientX: fromX,
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

function savedLeftGroups(): Record<string, string> | undefined {
  const layout = useSettingsStore.getState().settings?.navigation_layout as
    | { leftGroups?: Record<string, string> }
    | undefined;
  return layout?.leftGroups;
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
  // 只认行首选择器：图标轨里也有 `[data-nav-compact] .wb-nav-grip`，
  // 按子串找会把宽态契约读成图标态规则。
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  return end < 0 ? "" : css.slice(start + 1, end);
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

  it("位移未超过 6px 阈值时不进入拖拽：没有落点线，也不写库", async () => {
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
    // 4px：纵向未达到 6px 阈值，仍是点击而不是拖拽。
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

  it("纵向 6px 且纵向主导才启动排序；横向移动不会触发垂直排序", async () => {
    await renderShell();
    await openTasks();
    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    const page = filesRow?.querySelector<HTMLElement>(".wb-nav-page");
    if (!filesRow || !page) throw new Error("文件入口未渲染");
    const y = rowCenterY(navIds().indexOf("files"));
    pointerSeq += 1;
    const pointerId = pointerSeq;

    fireEvent.pointerDown(page, {
      pointerId,
      button: 0,
      pointerType: "mouse",
      clientX: 80,
      clientY: y,
    });
    // 横向 20px、纵向 3px：未达到纵向阈值，不能启动垂直排序。
    fireEvent.pointerMove(window, {
      pointerId,
      pointerType: "mouse",
      clientX: 100,
      clientY: y + 3,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    // 纵向 5px、横向 0：仍差 1px，不启动。
    fireEvent.pointerMove(window, {
      pointerId,
      pointerType: "mouse",
      clientX: 80,
      clientY: y + 5,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    // 纵向 6px 且纵向主导：进入拖拽。
    fireEvent.pointerMove(window, {
      pointerId,
      pointerType: "mouse",
      clientX: 80,
      clientY: y + 6,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId, pointerType: "mouse" });
    expect(navWriteCalls()).toHaveLength(0);
  });

  it("横向主导的移动即使纵向过了 6px 也不启动垂直排序", async () => {
    await renderShell();
    await openTasks();
    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    const page = filesRow?.querySelector<HTMLElement>(".wb-nav-page");
    if (!filesRow || !page) throw new Error("文件入口未渲染");
    const y = rowCenterY(navIds().indexOf("files"));
    pointerSeq += 1;
    const pointerId = pointerSeq;

    fireEvent.pointerDown(page, {
      pointerId,
      button: 0,
      pointerType: "mouse",
      clientX: 80,
      clientY: y,
    });
    fireEvent.pointerMove(window, {
      pointerId,
      pointerType: "mouse",
      clientX: 120,
      clientY: y + 7,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();

    // 未进入拖拽，松手后的普通 click 仍然正常打开页面。
    fireEvent.pointerUp(window, { pointerId, pointerType: "mouse" });
    fireEvent.click(page);
    expect(useUiStore.getState().tab).toBe("files");
    expect(navWriteCalls()).toHaveLength(0);
  });

  it("触屏上下滑动优先保留列表滚动，不误触排序", async () => {
    await renderShell();
    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    const page = filesRow?.querySelector<HTMLElement>(".wb-nav-page");
    if (!filesRow || !page) throw new Error("文件入口未渲染");
    const y = rowCenterY(navIds().indexOf("files"));

    fireEvent.pointerDown(page, {
      pointerId: 301,
      button: 0,
      pointerType: "touch",
      clientX: 80,
      clientY: y,
    });
    fireEvent.pointerMove(window, {
      pointerId: 301,
      pointerType: "touch",
      clientX: 80,
      clientY: y + 24,
    });
    expect(navList().querySelector(".wb-nav-item.is-dragging")).toBeNull();
    expect(navList().querySelector(".wb-nav-drop-line")).toBeNull();

    fireEvent.pointerUp(window, { pointerId: 301, pointerType: "touch" });
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

describe("整行拖拽面", () => {
  const surfaces: Array<{
    name: string;
    pick: (row: HTMLElement) => HTMLElement | null;
    x: number;
  }> = [
    { name: "功能图标", pick: (row) => row.querySelector<HTMLElement>(".wb-nav-icon"), x: 52 },
    { name: "名称", pick: (row) => row.querySelector<HTMLElement>(".wb-nav-label"), x: 96 },
    { name: "原手柄位置", pick: (row) => row.querySelector<HTMLElement>("[data-nav-grip]"), x: 24 },
    { name: "行首空白", pick: (row) => row, x: 2 },
  ];

  it.each(surfaces)("从$name起拖可以完成排序", async ({ pick, x }) => {
    await renderShell();
    const rows = navRows();
    const filesIndex = rows.findIndex((row) => row.dataset.navEntry === "files");
    const target = pick(rows[filesIndex]);
    if (!target) throw new Error("拖拽目标未渲染");

    const pointerId = startDrag(target, rowCenterY(filesIndex), 2, x);
    // 真正进入拖拽后，整行都是拖拽面，不要求命中手柄。
    expect(navList().querySelector(".wb-nav-item.is-dragging")?.getAttribute("data-nav-entry")).toBe(
      "files",
    );
    finishDrag(pointerId, 2);

    expect(navIds()[0]).toBe("files");
    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
  });

  it("从宽导航行尾的非操作空白起拖可以完成排序", async () => {
    useSettingsStore.setState({
      settings: {
        ...baseSettings(),
        workbench_layout: { ...defaultWorkbenchLayout(), navWidth: 320 },
      } as never,
    });
    await renderShell();
    const rows = navRows();
    const filesIndex = rows.findIndex((row) => row.dataset.navEntry === "files");
    const pointerId = startDrag(rows[filesIndex], rowCenterY(filesIndex), 2, 300);
    finishDrag(pointerId, 2);
    expect(navIds()[0]).toBe("files");
  });

  it("从数量徽标起拖可以完成排序", async () => {
    useCaptureStore.setState({ inboxCount: 4, inboxCountLoaded: true });
    await renderShell();
    const row = navList().querySelector<HTMLElement>('[data-nav-entry="collection"]');
    if (!row) throw new Error("收集入口未渲染");
    await waitFor(() => expect(row.querySelector(".wb-nav-badge")).toBeTruthy());
    const badge = row.querySelector<HTMLElement>(".wb-nav-badge");
    if (!badge) throw new Error("数量徽标未渲染");
    const index = navIds().indexOf("collection");
    const pointerId = startDrag(badge, rowCenterY(index), 2, 120);
    finishDrag(pointerId, 2);

    expect(navIds()[0]).toBe("collection");
    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
  });
});

describe("跨分组排序", () => {
  it("把「历史」拖到顶部后归入落点分组，顺序与分组一起持久化，标题不再重复", async () => {
    await renderShell();

    dragNavRowToTop("history");

    expect(navIds()[0]).toBe("history");
    expect(navIds()[1]).toBe("workbench");
    // 历史原本属于 planning(flow)，拖到 core 段顶部后归入 core；侧栏每个
    // 分组标题只出现一次，不能为了消除重复而改变用户排序。
    expect(
      [...document.querySelectorAll<HTMLElement>(".wb-nav-group")].map((node) => node.textContent),
    ).toEqual(["工作协同", "自动化与内容", "项目与系统"]);

    await waitFor(() => expect(navWriteCalls()).toHaveLength(1));
    expect(savedLeft()[0]).toBe("history");
    // 成员集合不变：排序不增删入口。
    expect(new Set(savedLeft())).toEqual(new Set(defaultNavigationLayout().left));
    // 分组归属与排序写在同一份 navigation_layout。
    expect(savedLeftGroups()?.history).toBe("core");
    // 只改被拖入口；其他入口的既有归属不能被标题收敛顺手改写。
    expect(savedLeftGroups()?.workbench).toBe("core");
    expect(savedLeftGroups()?.actions).toBe("capture");
  });

  it("旧配置的重复标题段只在渲染层抑制，不重写其他入口归属", async () => {
    const base = defaultNavigationLayout();
    const layout = {
      ...base,
      left: ["actions", "workbench", "history", "settings"],
      leftGroups: {
        ...base.leftGroups,
        actions: "capture",
        workbench: "core",
        history: "planning",
        settings: "system",
      },
    };
    useSettingsStore.setState({
      settings: { ...baseSettings(), navigation_layout: layout } as never,
    });

    await renderShell();

    expect(navIds()).toEqual(["actions", "workbench", "history"]);
    expect(
      [...document.querySelectorAll<HTMLElement>(".wb-nav-group")].map((node) => node.textContent),
    ).toEqual(["自动化与内容", "工作协同"]);
    // 数据层归属保持原样：旧配置不会因为视觉去批量合并其他入口。
    const groups = (
      useSettingsStore.getState().settings?.navigation_layout as
        | { leftGroups?: Record<string, string> }
        | undefined
    )?.leftGroups;
    expect(groups?.actions).toBe("capture");
    expect(groups?.workbench).toBe("core");
    expect(groups?.history).toBe("planning");
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

    const clipboard = navList()
      .querySelector<HTMLElement>('[data-nav-entry="clipboard"]')
      ?.querySelector<HTMLElement>(".wb-nav-page");
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
    // 焦点按稳定 ID 回到同一逻辑入口的页面切换按钮。
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.dataset.navPage).toBeDefined();
    expect(focused?.closest("[data-nav-entry]")?.getAttribute("data-nav-entry")).toBe("tasks");
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

describe("拖拽手柄视觉与整行拖拽语义", () => {
  it("手柄图标 13px、操作轨道 24×32；手柄位于 Tab 左侧、× 位于最右侧，行高保持 36px", async () => {
    await renderShell();
    const row = navRows()[0];
    const grip = gripOf(row);
    expect(grip.querySelector("svg")?.getAttribute("width")).toBe("13");
    expect(grip.querySelector("svg")?.getAttribute("height")).toBe("13");
    // 宽导航下整行不挂名称 tooltip。
    expect(row.hasAttribute("data-tip")).toBe(false);

    const actions = row.querySelector<HTMLElement>(".wb-nav-actions");
    expect(actions).toBeTruthy();
    expect(actions?.querySelector("[data-nav-grip]")).toBeNull();
    expect(
      [...row.querySelectorAll<HTMLElement>("[data-nav-grip], .wb-nav-icon, .wb-nav-label, [data-nav-hide]")].map(
        (node) =>
          node.matches("[data-nav-grip]")
            ? "grip"
            : node.matches("[data-nav-hide]")
              ? "hide"
              : node.classList.contains("wb-nav-icon")
                ? "icon"
                : "label",
      ),
    ).toEqual(["grip", "icon", "label", "hide"]);

    const hide = within(row).getByRole("button", { name: /隐藏「.*」导航入口/ });
    expect(hide.querySelector("svg")?.getAttribute("width")).toBe("15");
    expect(hide.querySelector("svg")?.getAttribute("height")).toBe("15");

    // CSS 契约：13px 图标 / 24×32 操作轨道；默认可见但低干扰、无背景；行高不变。
    expect(cssRule(".wb-nav-grip")).toMatch(/width: 24px/);
    expect(cssRule(".wb-nav-grip")).toMatch(/height: 32px/);
    expect(cssRule(".wb-nav-grip")).toMatch(/background: transparent/);
    expect(cssRule(".wb-nav-grip")).toMatch(/opacity: 0\.72/);
    // 手柄已纯视觉化：不接收指针，整行才是拖拽入口。
    expect(cssRule(".wb-nav-grip")).toMatch(/pointer-events: none/);
    expect(cssRule(".wb-nav-grip")).not.toMatch(/pointer-events: auto/);
    expect(cssRule(".wb-nav-item.has-grip")).toMatch(/cursor: grab/);
    expect(cssRule(".wb-nav-hide")).toMatch(/width: 24px/);
    expect(cssRule(".wb-nav-hide")).toMatch(/height: 24px/);
    expect(cssRule(".wb-nav-hide")).toMatch(/opacity: 0;/);
    expect(cssRule(".wb-nav-item")).toMatch(/min-height: 36px/);
    // 宽态行网格抽成自定义属性：名称宽度实测要复用同一份几何。
    expect(cssRule(".wb-nav-item")).toContain(
      "--wb-nav-row-columns: 24px 20px minmax(0, 1fr) auto 24px",
    );
    expect(cssRule(".wb-nav-item")).toMatch(/grid-template-columns: var\(--wb-nav-row-columns\)/);
    expect(row.classList.contains("has-grip")).toBe(true);
    expect(cssRule(".wb-nav-actions")).toMatch(/display: inline-flex/);
  });

  it("外层行是普通布局容器，页面切换/隐藏是独立按钮，手柄只是视觉元素", async () => {
    await renderShell();
    const row = navRows()[0];
    const page = row.querySelector<HTMLElement>(".wb-nav-page");
    const grip = gripOf(row);
    const hide = row.querySelector<HTMLElement>("[data-nav-hide]");

    expect(row.getAttribute("role")).toBeNull();
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(page?.tagName).toBe("BUTTON");
    expect(page?.dataset.navPage).toBeDefined();
    expect(page?.querySelector(".wb-nav-icon")).toBeTruthy();
    expect(page?.querySelector(".wb-nav-label")).toBeTruthy();
    expect(grip.tagName).toBe("SPAN");
    expect(grip.getAttribute("aria-hidden")).toBe("true");
    expect(grip.hasAttribute("tabindex")).toBe(false);
    expect(hide?.tagName).toBe("BUTTON");
    // 行内没有任何 button 嵌 button；页面切换与隐藏是兄弟关系。
    expect(row.querySelectorAll("button button")).toHaveLength(0);
    expect([...row.querySelectorAll("button")]).toEqual([page, hide]);
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

  it("× 独立：按下移动不起拖、不切页；手柄与行内空白仍属于整行点击", async () => {
    await renderShell();
    await openTasks();
    const filesRow = navList().querySelector<HTMLElement>('[data-nav-entry="files"]');
    if (!filesRow) throw new Error("文件入口未渲染");
    const before = navIds();

    // 点原手柄位置现在也是整行点击，正常打开页面。
    fireEvent.click(gripOf(filesRow));
    expect(useUiStore.getState().tab).toBe("files");

    act(() => useUiStore.getState().setTab("tasks"));
    // 行内空白点击同样打开页面。
    fireEvent.click(filesRow);
    expect(useUiStore.getState().tab).toBe("files");

    act(() => useUiStore.getState().setTab("tasks"));
    // × 区域按下移动也不起拖，且顺序不变。
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
    // 只移动不点击 ×：仍是任务页，不因 × 区域起拖而跳页。
    expect(useUiStore.getState().tab).toBe("tasks");
  });
});

describe("导航宽度临界点与名称 tooltip", () => {
  it("181px（最小宽度以上）显示名称，不挂名称 tooltip", async () => {
    useSettingsStore.setState({
      settings: {
        ...baseSettings(),
        workbench_layout: { ...defaultWorkbenchLayout(), navWidth: 181 },
      } as never,
    });
    await renderShell();
    const root = document.querySelector<HTMLElement>(".wb-root");
    expect(root?.hasAttribute("data-nav-compact")).toBe(false);
    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    // 宽态名称可见，TooltipLayer 不应因为 aria-label 回退或显式 data-tip 弹名称提示。
    expect(nav.querySelectorAll("[data-tip]")).toHaveLength(0);
    const page = navRows()[0].querySelector<HTMLElement>(".wb-nav-page");
    expect(page?.hasAttribute("data-tip")).toBe(false);
    // 折叠规则只在名称放不下时生效，不能把名称永久隐藏。
    expect(cssRule('.wb-root[data-nav-compact="true"] .wb-nav-label')).toMatch(/display: none/);
  });

  it("180px 在兜底阈值下仍显示名称（jsdom 量不到名称宽度），不挂名称 tooltip", async () => {
    useSettingsStore.setState({
      settings: {
        ...baseSettings(),
        workbench_layout: { ...defaultWorkbenchLayout(), navWidth: 180 },
      } as never,
    });
    await renderShell();
    const root = document.querySelector<HTMLElement>(".wb-root");
    // 真实运行由实测的“名称所需宽度”决定；jsdom 无布局、量不到名称宽度时回退 180px。
    expect(root?.hasAttribute("data-nav-compact")).toBe(false);

    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    expect(nav.querySelectorAll("[data-tip]")).toHaveLength(0);
    const page = navRows()[0].querySelector<HTMLElement>(".wb-nav-page");
    expect(page?.hasAttribute("data-tip")).toBe(false);
    expect(page?.querySelector(".wb-nav-label")).toBeTruthy();
  });

  it("96px 图标轨：整列收窄为图标，名称/徽标隐藏并补名称 tooltip", async () => {
    useSettingsStore.setState({
      settings: {
        ...baseSettings(),
        workbench_layout: { ...defaultWorkbenchLayout(), navWidth: 96 },
      } as never,
    });
    await renderShell();
    const root = document.querySelector<HTMLElement>(".wb-root");
    expect(root?.hasAttribute("data-nav-compact")).toBe(true);
    expect(root?.style.getPropertyValue("--wb-nav-width")).toBe("96px");
    // 图标态靠 tooltip 补名称（TooltipLayer 在本文件是替身，只断言挂载数据）。
    const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
    expect(nav.querySelectorAll("[data-tip]").length).toBeGreaterThan(0);
    // 图标轨几何：24px 手柄轨道 / 32px 图标轨道 / 24px × 轨道，名称与徽标隐藏。
    expect(cssRule('.wb-root[data-nav-compact="true"] .wb-nav-item')).toContain(
      "24px minmax(0, 1fr) 24px",
    );
    expect(cssRule('.wb-root[data-nav-compact="true"] .wb-nav-label')).toMatch(/display: none/);
    expect(cssRule('.wb-root[data-nav-compact="true"] .wb-nav-badge')).toMatch(/display: none/);
    expect(cssRule('.wb-root[data-nav-compact="true"] .wb-nav-grip')).toContain("opacity: 0");
  });

  it("200 / 280 / 320px 以及窗口 700px + 320px 导航都显示名称", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 700,
    });
    try {
      for (const navWidth of [200, 280, 320]) {
        cleanup();
        useSettingsStore.setState({
          settings: {
            ...baseSettings(),
            workbench_layout: { ...defaultWorkbenchLayout(), navWidth },
          } as never,
        });
        await renderShell();
        const root = document.querySelector<HTMLElement>(".wb-root");
        expect(root?.hasAttribute("data-nav-compact")).toBe(false);
        expect(root?.style.getPropertyValue("--wb-nav-width")).toBe(`${navWidth}px`);
        const nav = screen.getByRole("navigation", { name: "工作台功能导航" });
        expect(nav.querySelectorAll("[data-tip]")).toHaveLength(0);
        const label = navRows()[0].querySelector<HTMLElement>(".wb-nav-label");
        expect(label).toBeTruthy();
        // 窗口只有 700px 也不能覆盖用户设置的 320px 导航宽度。
        expect(navRows()[0].querySelector(".wb-nav-page")).toBeTruthy();
      }
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
    }
    // 760px 导航媒体块已删除：不得再把导航压成 56px；宽度模式只由
    // data-nav-compact（实际导航宽度）控制。
    const css = readFileSync(resolve(process.cwd(), "src/workbench/workbench.css"), "utf8");
    expect(css).not.toContain("width: 56px");
    expect(css).not.toMatch(/\.wb-nav \{[\s\S]*?width: 56px/);
  });

  it("兜底判据按整像素：180 / 180.4 显示名称，179.4 与 56px 进入图标态", () => {
    // 正常运行时阈值是实测名称宽度（见 workbenchLayout.test.ts）；这里锁定回退语义。
    expect(shouldCompactWorkbenchNavLabels(181)).toBe(false);
    expect(shouldCompactWorkbenchNavLabels(180)).toBe(false);
    expect(shouldCompactWorkbenchNavLabels(180.4)).toBe(false);
    expect(shouldCompactWorkbenchNavLabels(179.4)).toBe(true);
    expect(shouldCompactWorkbenchNavLabels(56)).toBe(true);
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
    // 固定设置 Tab 也移除了 hover tooltip；「更多」是菜单入口，不属于 Tab。
    expect(
      within(nav).getByRole("button", { name: "设置" }).hasAttribute("data-tip"),
    ).toBe(false);
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
