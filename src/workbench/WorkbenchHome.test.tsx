// @vitest-environment jsdom
//! 工作台首页 v2：无项目可用、真实数据区块、快速操作分发与项目卡打开。
//! 不依赖任何主窗口状态；不测具体问候语（随时间变化）。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

vi.mock("../store/useTasksStore", () => ({
  useTasksStore: (selector: (state: unknown) => unknown) =>
    selector({ stats: { pending: 4, overdue: 1 }, tasks: [] }),
}));
vi.mock("../store/useAgentsStore", () => ({
  useAgentsStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: {
        live_summary: { running: 2, waiting: 1, failed: 0 },
        runs: [],
        sessions: [],
      },
      snapshotError: null,
      load: vi.fn(),
    }),
}));
vi.mock("../store/useWorkflowsStore", () => ({
  useWorkflowsStore: (selector: (state: unknown) => unknown) =>
    selector({
      workflows: null,
      activeRunDetail: null,
      loadWorkflows: vi.fn(() => Promise.resolve()),
      refreshActive: vi.fn(() => Promise.resolve()),
    }),
}));

import WorkbenchHome from "./WorkbenchHome";
import type { WorkspaceProject } from "../lib/bridge";

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: "p1",
    name: "示例项目",
    kind: "development",
    status: "active",
    rootPath: "D:\\Projects\\demo",
    rootExists: true,
    devProjectId: null,
    devProjectExists: false,
    devProjectName: null,
    note: "",
    itemCount: 3,
    taskLinkCount: 2,
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-14T00:00:00Z",
    ...overrides,
  };
}

function renderHome(overrides: {
  onNavigate?: ReturnType<typeof vi.fn>;
  onSelectProjectAndOpen?: ReturnType<typeof vi.fn>;
  onCreateProject?: ReturnType<typeof vi.fn>;
  onQuickAddTask?: ReturnType<typeof vi.fn>;
  projects?: WorkspaceProject[];
} = {}) {
  return render(
    <WorkbenchHome
      projects={overrides.projects ?? []}
      projectsLoading={false}
      onNavigate={overrides.onNavigate ?? vi.fn()}
      onSelectProjectAndOpen={overrides.onSelectProjectAndOpen ?? vi.fn()}
      onCreateProject={overrides.onCreateProject ?? vi.fn()}
      onQuickAddTask={overrides.onQuickAddTask ?? vi.fn()}
    />,
  );
}

describe("WorkbenchHome", () => {
  it("没有项目也能渲染问候、空态与真实 Agent 计数", () => {
    renderHome();

    expect(screen.getByText(/上午好|下午好|晚上好/)).toBeTruthy();
    expect(screen.getByText(/还没有工作空间项目/)).toBeTruthy();
    expect(screen.getByText(/等待 1/)).toBeTruthy();
    expect(screen.getByText(/失败 0/)).toBeTruthy();
    expect(screen.getByText(/今天没有待办任务/)).toBeTruthy();
    expect(screen.getByText(/还没有登记工作流/)).toBeTruthy();
  });

  it("项目卡点击后交给 shell 选择并打开项目页", () => {
    const onSelectProjectAndOpen = vi.fn();
    renderHome({ onSelectProjectAndOpen, projects: [project()] });

    expect(screen.getByText("示例项目")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /示例项目/ }));
    expect(onSelectProjectAndOpen).toHaveBeenCalledWith("p1");
  });

  it("快速操作宫格分别分发新建任务与新建项目", () => {
    const onQuickAddTask = vi.fn();
    const onCreateProject = vi.fn();
    renderHome({ onQuickAddTask, onCreateProject });

    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));
    expect(onQuickAddTask).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it("导航类宫格与面板「查看全部」走 onNavigate", () => {
    const onNavigate = vi.fn();
    renderHome({ onNavigate });

    fireEvent.click(screen.getByRole("button", { name: /启动工作流/ }));
    expect(onNavigate).toHaveBeenCalledWith("workflows");

    fireEvent.click(screen.getByRole("button", { name: /创建 Agent/ }));
    expect(onNavigate).toHaveBeenCalledWith("agents");
  });
});
