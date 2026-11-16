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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
