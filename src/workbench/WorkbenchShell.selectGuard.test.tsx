/**
 * @vitest-environment jsdom
 */
//! WorkbenchShell 真实 selectProject 守卫链：顶部选择器 → workspaceLeaveGuardRef。
//! 工作空间面板用最小替身注册守卫，正文面板自身行为由 NovelManuscriptPanel 测试覆盖。

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
  onSettingsChanged: vi.fn(),
  listTasks: vi.fn(),
  taskStats: vi.fn(),
  agentSnapshot: vi.fn(),
  actionsFeed: vi.fn(),
  fetchTask: vi.fn(),
  novelVolumeList: vi.fn(),
  novelVolumeSave: vi.fn(),
  novelVolumeDelete: vi.fn(),
  novelChapterList: vi.fn(),
  novelChapterGet: vi.fn(),
  novelChapterSave: vi.fn(),
  novelChapterSaveContent: vi.fn(),
  novelChapterDelete: vi.fn(),
}));

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return { ...actual, ...bridge };
});

vi.mock("../components/tasks/TasksPanel", () => ({ default: () => <div data-testid="tasks-panel" /> }));
vi.mock("../components/agents/AgentPanel", () => ({ default: () => <div /> }));
vi.mock("../components/actions/ActionCenterPanel", () => ({ default: () => null }));
vi.mock("../components/clipboard/ClipboardPanel", () => ({ default: () => null }));
vi.mock("../components/clipboard/ClipboardDrawer", () => ({ default: () => null }));
vi.mock("../components/collection/CollectionPanel", () => ({ default: () => null }));
vi.mock("../components/workbench/DevWorkbenchPanel", () => ({ default: () => null }));
vi.mock("../components/apps/AppsPanel", () => ({ default: () => null }));
vi.mock("../components/widgets/WidgetsPanel", () => ({ default: () => null }));
vi.mock("../components/mobile/MobileTransferPanel", () => ({ default: () => null }));
vi.mock("../components/workflows/WorkflowsPanel", () => ({ default: () => null }));
vi.mock("../components/history/HistoryPanel", () => ({ default: () => null }));
vi.mock("../components/roadmap/PlanningCenterPanel", () => ({ default: () => null }));
vi.mock("../components/settings/SettingsPanel", () => ({ default: () => null }));
vi.mock("../components/help/HelpCenterPanel", () => ({ default: () => null }));
vi.mock("../components/diagnostics/DiagnosticsCenterPanel", () => ({ default: () => null }));
vi.mock("../components/resource/ResourceManagementPanel", () => ({ default: () => null }));
vi.mock("../components/global-search/GlobalSearchDialog", () => ({
  GlobalSearchDialog: () => null,
}));
vi.mock("../components/mobile/MobilePairingDialog", () => ({ default: () => null }));
vi.mock("../components/context/TaskContextDrawer", () => ({ default: () => null }));
vi.mock("../components/Toast", () => ({ default: () => null }));
vi.mock("../components/ui/TooltipLayer", () => ({ default: () => null }));
vi.mock("../components/widgets/liveSources", () => ({ WIDGET_SOURCES: [] }));
vi.mock("../store/useHotkeysStore", () => ({ useHotkeysRuntime: () => undefined }));

vi.mock("../workspace/useWorkspaceProjectContext", () => ({
  useWorkspaceProjectContext: () => ({
    projectId: "p1",
    status: "ready",
    error: null,
    items: [],
    links: [],
    instance: null,
    layout: {
      version: 1,
      moduleOrder: ["overview", "manuscript", "items", "links", "settings"],
      hiddenModules: [],
      activeModule: "manuscript",
    },
    layoutRepaired: false,
    reload: async () => {},
    saveModule: async () => "ok",
    addItem: async () => "ok",
    cycleItemStatus: async () => "ok",
    removeItem: async () => "ok",
    addTaskLink: async () => "ok",
    removeTaskLink: async () => "ok",
    lastStaleNotice: null,
    clearStaleNotice: () => {},
  }),
  useWorkspaceDevContext: () => ({
    status: "idle",
    devProject: null,
    probe: null,
    error: null,
    reason: null,
    refresh: async () => {},
  }),
  useWorkspaceTaskPicker: () => ({
    tasks: [],
    loading: false,
    error: null,
    query: "",
    setQuery: () => {},
    status: "all",
    setStatus: () => {},
    limit: 40,
    canLoadMore: false,
    atWindowLimit: false,
    loadMore: () => {},
    reload: () => {},
  }),
}));

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
  workspace_active_project: "p1",
  navigation_layout: undefined,
  workbench_layout: undefined,
};

const volume = {
  id: "v1",
  projectId: "p1",
  title: "第一卷",
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

const chapter = {
  id: "c1",
  projectId: "p1",
  volumeId: "v1",
  title: "第一章",
  wordCount: 4,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

function unlisten(): Promise<() => void> {
  return Promise.resolve(() => {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function saved(content: string) {
  return {
    chapter: { ...chapter, content, wordCount: content.replace(/\s/g, "").length },
  };
}

beforeEach(() => {
  bridge.workspaceProjectList.mockResolvedValue({
    projects: [
      { id: "p1", name: "项目一", kind: "novel", status: "active", rootPath: "D:/p1" },
      { id: "p2", name: "项目二", kind: "development", status: "active", rootPath: "D:/p2" },
      { id: "p3", name: "项目三", kind: "general", status: "active", rootPath: "D:/p3" },
    ],
  });
  bridge.devProjectList.mockResolvedValue({ projects: [] });
  bridge.workspaceSetActiveProject.mockResolvedValue({ ok: true });
  bridge.workspaceProjectSave.mockResolvedValue({ project: { id: "p1", name: "项目一" } });
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
  bridge.novelVolumeList.mockResolvedValue({ volumes: [volume] });
  bridge.novelChapterList.mockResolvedValue({ chapters: [chapter] });
  bridge.novelChapterGet.mockResolvedValue({ chapter: { ...chapter, content: "初稿正文" } });
  bridge.novelChapterSaveContent.mockImplementation(async (id: string, content: string) => ({
    chapter: { ...chapter, id, content, wordCount: content.replace(/\s/g, "").length },
  }));
  bridge.novelChapterSave.mockResolvedValue({ chapter });
  bridge.novelVolumeSave.mockResolvedValue({ volume });
  bridge.novelChapterDelete.mockResolvedValue(undefined);
  bridge.novelVolumeDelete.mockResolvedValue(undefined);

  useSettingsStore.setState({
    settings: SETTINGS as never,
    loadError: null,
    load: vi.fn(async () => {}),
    update: vi.fn(async (patch: Record<string, unknown>) => ({ ...SETTINGS, ...patch })) as never,
  });
  useTasksStore.setState({ stats: null, tasks: [] });
  useActionsStore.setState({ feed: null });
  useCaptureStore.setState({ inboxCount: 0, refreshInboxCount: vi.fn() as never });
  useUiStore.setState({
    tab: "tasks",
    pendingTab: null,
    context: { open: false, task: null },
  });
});

afterEach(cleanup);

async function openWorkspace() {
  render(<WorkbenchShell />);
  await screen.findByRole("heading", { name: "工作台首页", level: 2 });
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "工作台功能导航" })).getByRole("button", {
      name: "工作空间",
    }),
  );
  // 真实 ProjectWorkspacePanel：mock 的项目上下文把 activeModule 设为 manuscript，
  // 因此这里会挂载真实 NovelManuscriptPanel，而不是替身。
  await waitFor(() => expect(bridge.novelVolumeList).toHaveBeenCalled(), { timeout: 5000 });
  await screen.findByText("第一卷", undefined, { timeout: 5000 });
  await screen.findByLabelText("第一章正文", undefined, { timeout: 5000 });
  // 隔离挂载期的 hydration 写入；本组只断言用户选择后的守卫结果。
  bridge.workspaceSetActiveProject.mockClear();
}

async function chooseProject(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "工作空间项目" }));
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

describe("WorkbenchShell · 项目切换正文守卫", () => {
  it("有脏稿时等待 flush 成功后才切换项目", async () => {
    await openWorkspace();
    const d = deferred<ReturnType<typeof saved>>();
    bridge.novelChapterSaveContent.mockReturnValue(d.promise);
    const textarea = screen.getByLabelText("第一章正文") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "真实壳层脏稿" } });

    await chooseProject("项目二");
    await waitFor(() =>
      expect(bridge.novelChapterSaveContent).toHaveBeenCalledWith("c1", "真实壳层脏稿"),
    );
    expect(bridge.workspaceSetActiveProject).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "工作空间项目" }).textContent).toContain("项目一");

    d.resolve(saved("真实壳层脏稿"));
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenCalledWith("p2"));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "工作空间项目" }).textContent).toContain("项目二"),
    );
  });

  it("正文保存失败时取消切换，保留原项目与草稿", async () => {
    await openWorkspace();
    bridge.novelChapterSaveContent.mockRejectedValue(new Error("磁盘只读"));
    const textarea = screen.getByLabelText("第一章正文") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "不能丢的草稿" } });

    await chooseProject("项目二");
    await waitFor(() => expect(screen.getByText("保存失败，可重试")).toBeTruthy());
    expect(bridge.workspaceSetActiveProject).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "工作空间项目" }).textContent).toContain("项目一");
    expect((screen.getByLabelText("第一章正文") as HTMLTextAreaElement).value).toBe("不能丢的草稿");
  });

  it("没有脏稿时快速切换（正文守卫直接放行）", async () => {
    await openWorkspace();
    await chooseProject("项目二");
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenCalledWith("p2"));
  });

  it("快速两次选择：旧守卫完成后不得覆盖最后一次选择", async () => {
    await openWorkspace();
    const firstSave = deferred<ReturnType<typeof saved>>();
    bridge.novelChapterSaveContent.mockReturnValue(firstSave.promise);
    const textarea = screen.getByLabelText("第一章正文") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "切换中的草稿" } });

    await chooseProject("项目二");
    await waitFor(() =>
      expect(bridge.novelChapterSaveContent).toHaveBeenCalledWith("c1", "切换中的草稿"),
    );
    // 第一次守卫尚未完成时再选 p3；两次选择共享同一在途保存。
    await chooseProject("项目三");
    firstSave.resolve(saved("切换中的草稿"));
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenCalledWith("p3"));
    expect(bridge.workspaceSetActiveProject).not.toHaveBeenCalledWith("p2");
  });
});

describe("WorkbenchShell · selectProject 持久化返回契约（ADR-0010）", () => {
  const switcher = () => screen.getByRole("combobox", { name: "工作空间项目" });

  /** 首页路由：项目卡片走 onSelectProjectAndOpen，返回 true 才放行 goRoute("workspace")。 */
  async function openHome() {
    // 默认路由即 home，无需改 Tab；渲染后隔离挂载期的 hydration 写入。
    render(<WorkbenchShell />);
    await screen.findByRole("heading", { name: "工作台首页", level: 2 });
    // 本组只断言用户选择后的落库结果。
    bridge.workspaceSetActiveProject.mockClear();
  }

  it("契约1：正常切换，workspace_active_project 落库成功后返回 true", async () => {
    await openHome();
    const persist = deferred<{ ok: boolean }>();
    bridge.workspaceSetActiveProject.mockReturnValueOnce(persist.promise);
    fireEvent.click(screen.getByRole("button", { name: /项目二/ }));

    // 乐观 UI 先行：落库未完成时选择器已显示新项目。
    await waitFor(() => expect(switcher().textContent).toContain("项目二"));
    // selectProject 尚未返回（await 落库中）：首页卡片回调不得提前放行导航。
    expect(screen.getByRole("heading", { name: "工作台首页", level: 2 })).toBeTruthy();
    expect(screen.queryByText("第一卷")).toBeNull();

    persist.resolve({ ok: true });
    // 返回 true → onSelectProjectAndOpen 放行 goRoute("workspace")：首页路由槽隐藏。
    // 目标项目是开发类，其领域模块不在本契约范围且 jsdom 未为其准备 bridge mock，
    // 因此只断言导航门控结果，不断言工作空间页内容。
    await waitFor(() =>
      expect((document.querySelector(".wb-home-slot") as HTMLElement | null)?.hidden).toBe(true),
    );
    expect(screen.queryByRole("heading", { name: "工作台首页", level: 2 })).toBeNull();
    expect(bridge.workspaceSetActiveProject).toHaveBeenCalledWith("p2");
  });

  it("契约2：正文守卫保存失败时返回 false，活跃项目零写入", async () => {
    await openWorkspace();
    const flushSave = deferred<ReturnType<typeof saved>>();
    bridge.novelChapterSaveContent.mockReturnValueOnce(flushSave.promise);
    const textarea = screen.getByLabelText("第一章正文") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "契约2的草稿" } });

    const persistCalls = bridge.workspaceSetActiveProject.mock.calls.length;
    await chooseProject("项目二");
    await waitFor(() =>
      expect(bridge.novelChapterSaveContent).toHaveBeenCalledWith("c1", "契约2的草稿"),
    );
    // 守卫仍在途：不得提前写活跃项目。
    expect(bridge.workspaceSetActiveProject.mock.calls.length).toBe(persistCalls);

    flushSave.reject(new Error("磁盘只读"));
    await waitFor(() => expect(screen.getByText("保存失败，可重试")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 守卫失败 → selectProject 返回 false：不落库、不切 UI、不丢草稿。
    expect(bridge.workspaceSetActiveProject.mock.calls.length).toBe(persistCalls);
    expect(switcher().textContent).toContain("项目一");
    expect((screen.getByLabelText("第一章正文") as HTMLTextAreaElement).value).toBe("契约2的草稿");
  });

  it("契约3：workspace_active_project 落库失败时返回 false 并回滚 UI", async () => {
    await openHome();
    bridge.workspaceSetActiveProject.mockRejectedValueOnce(new Error("设置写入失败"));
    fireEvent.click(screen.getByRole("button", { name: /项目二/ }));

    // 失败回执后回滚到原项目（仅最后一次意图回滚；此处无新选择）。
    await waitFor(() => expect(switcher().textContent).toContain("项目一"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 返回 false → 不放行路由：仍停留在首页，工作空间页未挂载。
    expect(screen.getByRole("heading", { name: "工作台首页", level: 2 })).toBeTruthy();
    expect(screen.queryByText("第一卷")).toBeNull();
  });

  it("契约4：A→B→C 快速切换，B 的落库不得覆盖 C（applied=false 不回滚 C）", async () => {
    await openWorkspace();
    const persistB = deferred<{ ok: boolean }>();
    bridge.workspaceSetActiveProject.mockReturnValueOnce(persistB.promise);
    await chooseProject("项目二");
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenCalledWith("p2"));

    // B 在途时选择 C：UI 乐观归 C；队列串行，B 完成后才发 C。
    await chooseProject("项目三");
    await waitFor(() => expect(switcher().textContent).toContain("项目三"));
    persistB.resolve({ ok: true });

    // B 落库完成但已被取代（applied=false）；C 随后串行落库成功。
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenLastCalledWith("p3"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // B 的 applied=false 不触发任何回滚/UI 覆盖，且没有对 p2 的第二次写入。
    expect(switcher().textContent).toContain("项目三");
    const p2Writes = bridge.workspaceSetActiveProject.mock.calls.filter(
      (call) => call[0] === "p2",
    ).length;
    expect(p2Writes).toBe(1);
  });

  it("契约5：旧请求落库失败（已被新选择取代）不回滚最后一次成功的选择", async () => {
    await openWorkspace();
    const persistB = deferred<{ ok: boolean }>();
    bridge.workspaceSetActiveProject.mockReturnValueOnce(persistB.promise);
    await chooseProject("项目二");
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenCalledWith("p2"));

    await chooseProject("项目三");
    persistB.reject(new Error("B 落库失败"));
    // B 失败已被 C 取代：不回滚 UI、不覆盖持久化；C 串行落库成功。
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenLastCalledWith("p3"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(switcher().textContent).toContain("项目三");
    expect(switcher().textContent).not.toContain("项目二");
  });

  it("契约6：切换被守卫取消时不改变持久化项目，取消后可重试成功", async () => {
    await openWorkspace();
    const flushSave = deferred<ReturnType<typeof saved>>();
    bridge.novelChapterSaveContent.mockReturnValueOnce(flushSave.promise);
    const textarea = screen.getByLabelText("第一章正文") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "契约6的草稿" } });

    const persistCalls = bridge.workspaceSetActiveProject.mock.calls.length;
    await chooseProject("项目二");
    await waitFor(() =>
      expect(bridge.novelChapterSaveContent).toHaveBeenCalledWith("c1", "契约6的草稿"),
    );
    // 守卫以失败收场（返回 false）：本次切换被取消，持久化保持原项目。
    flushSave.reject(new Error("守卫取消"));
    await waitFor(() => expect(screen.getByText("保存失败，可重试")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.workspaceSetActiveProject.mock.calls.length).toBe(persistCalls);
    expect(switcher().textContent).toContain("项目一");

    // 取消不破坏状态：重试同一目标，本次保存成功后切换完成。
    await chooseProject("项目二");
    await waitFor(() => expect(bridge.workspaceSetActiveProject).toHaveBeenCalledWith("p2"));
    await waitFor(() => expect(switcher().textContent).toContain("项目二"));
    await waitFor(() => expect(screen.queryByText("保存失败，可重试")).toBeNull());
  });
});
