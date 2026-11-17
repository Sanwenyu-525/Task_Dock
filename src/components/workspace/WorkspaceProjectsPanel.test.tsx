/**
 * @vitest-environment jsdom
 */
//! 遗留项目列表面板结构测试（A03 响应式收口）：
//! - 空列表给出可用的「新建 / 打开工作台」入口，不渲染巨型空白卡片；
//! - 项目行保留名称、类型徽标与计数，名称走省略号容器（CSS 截断在真机/预览复核）；
//! - 打开项目与新建项目仍走原有 IPC 与导航入口，布局改动不丢业务行为。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  workspaceProjectList: vi.fn(),
  workspaceProjectSave: vi.fn(),
}));
const nav = vi.hoisted(() => ({
  openWorkbench: vi.fn(),
}));

vi.mock("../../lib/bridge", () => api);
vi.mock("../../lib/workbenchNav", () => nav);

import WorkspaceProjectsPanel from "./WorkspaceProjectsPanel";

const fixture = [
  {
    id: "p1",
    name: "示例项目 Alpha",
    kind: "general",
    rootPath: null,
    devProjectId: null,
    note: null,
    status: "active",
    itemCount: 3,
    taskLinkCount: 1,
    rootExists: false,
    createdAt: "2026-11-17T00:00:00+08:00",
    updatedAt: "2026-11-17T00:00:00+08:00",
  },
  {
    id: "p2",
    name: "长篇小说创作线",
    kind: "novel",
    rootPath: "D:\\novel\\long-project",
    devProjectId: null,
    note: null,
    status: "active",
    itemCount: 12,
    taskLinkCount: 4,
    rootExists: true,
    createdAt: "2026-11-16T00:00:00+08:00",
    updatedAt: "2026-11-17T01:00:00+08:00",
  },
];

afterEach(cleanup);

beforeEach(() => {
  api.workspaceProjectList.mockReset();
  api.workspaceProjectSave.mockReset();
  nav.openWorkbench.mockReset();
  api.workspaceProjectList.mockResolvedValue({ projects: [] });
  nav.openWorkbench.mockResolvedValue({ status: "succeeded", error: null });
});

describe("WorkspaceProjectsPanel", () => {
  it("空列表渲染入口区与「暂无项目」提示，不出现整屏空白卡片", async () => {
    render(<WorkspaceProjectsPanel />);
    expect(await screen.findByText("暂无项目")).toBeTruthy();
    expect(screen.getByRole("button", { name: /打开工作台/ })).toBeTruthy();
    expect(screen.getByPlaceholderText("新建项目名称")).toBeTruthy();
  });

  it("项目行展示名称、类型与计数，名称位于省略号容器内", async () => {
    api.workspaceProjectList.mockResolvedValue({ projects: fixture });
    render(<WorkspaceProjectsPanel />);
    await waitFor(() => expect(screen.getByText("示例项目 Alpha")).toBeTruthy());

    const items = document.querySelectorAll(".wsp-item");
    expect(items).toHaveLength(2);
    const firstName = document.querySelector(".wsp-item-name");
    expect(firstName?.textContent).toBe("示例项目 Alpha");
    expect(screen.getByText("事项 3 · 关联 1")).toBeTruthy();
    expect(screen.getByText("事项 12 · 关联 4")).toBeTruthy();
  });

  it("点击「打开」按项目 id 请求打开工作台", async () => {
    api.workspaceProjectList.mockResolvedValue({ projects: fixture });
    render(<WorkspaceProjectsPanel />);
    await waitFor(() => expect(screen.getByText("长篇小说创作线")).toBeTruthy());

    const openButtons = screen.getAllByRole("button", { name: "打开" });
    fireEvent.click(openButtons[1]);
    await waitFor(() =>
      expect(nav.openWorkbench).toHaveBeenCalledWith({ tab: "workspace", projectId: "p2" }),
    );
  });

  it("输入名称后「新建并打开」先落库再带新项目 id 打开工作台", async () => {
    api.workspaceProjectSave.mockResolvedValue({ project: { id: "p3" } });
    render(<WorkspaceProjectsPanel />);
    await screen.findByText("暂无项目");

    fireEvent.change(screen.getByPlaceholderText("新建项目名称"), {
      target: { value: "  新项目 Beta  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /新建并打开/ }));

    await waitFor(() =>
      expect(api.workspaceProjectSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: "新项目 Beta", kind: "general" }),
      ),
    );
    await waitFor(() =>
      expect(nav.openWorkbench).toHaveBeenCalledWith({ tab: "workspace", projectId: "p3" }),
    );
  });
});
