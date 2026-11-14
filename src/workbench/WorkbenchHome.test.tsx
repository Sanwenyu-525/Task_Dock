// @vitest-environment jsdom
//! 工作台首页：无项目可用、真实计数、快捷入口与项目打开。不依赖任何主窗口状态。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

vi.mock("../store/useTasksStore", () => ({
  useTasksStore: (selector: (state: unknown) => unknown) =>
    selector({ stats: { pending: 4, overdue: 1 } }),
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
vi.mock("../store/useCaptureStore", () => ({
  useCaptureStore: (selector: (state: unknown) => unknown) =>
    selector({ inboxCount: 3, refreshInboxCount: vi.fn() }),
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

describe("WorkbenchHome", () => {
  it("没有项目也能显示通用入口与真实计数", () => {
    const onNavigate = vi.fn();
    render(
      <WorkbenchHome
        projects={[]}
        projectsLoading={false}
        onNavigate={onNavigate}
        onSelectProjectAndOpen={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByText("工作台首页")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText(/还没有工作空间项目/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("项目行点击后交给 shell 选择并打开项目页", () => {
    const onSelectProjectAndOpen = vi.fn();
    render(
      <WorkbenchHome
        projects={[project()]}
        projectsLoading={false}
        onNavigate={vi.fn()}
        onSelectProjectAndOpen={onSelectProjectAndOpen}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByText("示例项目")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /示例项目/ }));
    expect(onSelectProjectAndOpen).toHaveBeenCalledWith("p1");
  });

  it("新建项目按钮调用 shell 的唯一创建入口", () => {
    const onCreateProject = vi.fn();
    render(
      <WorkbenchHome
        projects={[]}
        projectsLoading={false}
        onNavigate={vi.fn()}
        onSelectProjectAndOpen={vi.fn()}
        onCreateProject={onCreateProject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });
});
