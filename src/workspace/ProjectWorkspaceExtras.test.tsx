/**
 * @vitest-environment jsdom
 */
//! 项目进度/资源卡：空态、错误态与归档只读。只做前端渲染与命令接线，
//! 后端数据口径由 Rust 侧测试保证。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  workspaceProjectProgress: vi.fn(),
  workspaceResourceList: vi.fn(),
  workspaceResourceSave: vi.fn(),
  workspaceResourceRemove: vi.fn(),
  notesList: vi.fn(),
}));

vi.mock("../lib/bridge", () => bridge);

import { ProjectProgressCard, ProjectResourcesCard } from "./ProjectWorkspaceExtras";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const progress = (over: Record<string, unknown> = {}) => ({
  itemsTotal: 4,
  itemsTodo: 1,
  itemsDoing: 1,
  itemsBlocked: 0,
  itemsDone: 2,
  itemsArchived: 0,
  itemsPercent: 50,
  linkedTasksTotal: 2,
  linkedTasksCompleted: 1,
  linkedTasksPercent: 50,
  ...over,
});

describe("ProjectProgressCard", () => {
  it("事项与关联任务分开显示，进度条可读", async () => {
    bridge.workspaceProjectProgress.mockResolvedValue(progress());
    render(<ProjectProgressCard projectId="p1" archived={false} />);

    expect((await screen.findAllByText("50%")).length).toBe(2);
    expect(screen.getByRole("progressbar", { name: "事项完成度" }).getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByRole("progressbar", { name: "关联任务完成度" }).getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText(/完成 2 · 待办 1 · 进行 1/)).toBeTruthy();
  });

  it("分母为 0 时显示「暂无可计算进度」，不伪装成 0% 或 100%", async () => {
    bridge.workspaceProjectProgress.mockResolvedValue(
      progress({
        itemsTotal: 0,
        itemsTodo: 0,
        itemsDoing: 0,
        itemsDone: 0,
        itemsPercent: null,
        linkedTasksTotal: 0,
        linkedTasksCompleted: 0,
        linkedTasksPercent: null,
      }),
    );
    render(<ProjectProgressCard projectId="p1" archived={false} />);

    expect((await screen.findAllByText("暂无可计算进度")).length).toBe(2);
  });

  it("读取失败保留错误提示，不显示假进度", async () => {
    bridge.workspaceProjectProgress.mockRejectedValue(new Error("后端不可用"));
    render(<ProjectProgressCard projectId="p1" archived={false} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("后端不可用");
  });
});

describe("ProjectResourcesCard", () => {
  it("没有关联时显示空态", async () => {
    bridge.workspaceResourceList.mockResolvedValue({ links: [], total: 0, offset: 0, limit: 50, hasMore: false });
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);

    expect(await screen.findByText("还没有登记项目资源")).toBeTruthy();
    expect(bridge.workspaceResourceList).toHaveBeenCalledWith("p1", null, 0, 50);
  });

  it("读取失败显示错误，不静默清空", async () => {
    bridge.workspaceResourceList.mockRejectedValue(new Error("读取资源失败"));
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("读取资源失败");
    expect(screen.getByText("还没有登记项目资源")).toBeTruthy();
  });

  it("归档项目只读：不能新增关联", async () => {
    bridge.workspaceResourceList.mockResolvedValue({ links: [], total: 0, offset: 0, limit: 50, hasMore: false });
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived />);

    expect(await screen.findByText(/项目已归档：资源只读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /关联$/ })).toBeNull();
  });
});
