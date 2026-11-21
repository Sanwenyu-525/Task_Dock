/**
 * @vitest-environment jsdom
 */
//! 项目进度/资源卡：空态、错误态与归档只读。只做前端渲染与命令接线，
//! 后端数据口径由 Rust 侧测试保证。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
  const emptyPage = { links: [], total: 0, offset: 0, limit: 50, hasMore: false };

  const link = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    projectId: "p1",
    kind: "note" as const,
    target: "n1",
    label: "设定草稿",
    note: "",
    targetExists: true,
    createdAt: "2026-11-21T08:00:00+00:00",
    updatedAt: "2026-11-21T08:00:00+00:00",
    ...over,
  });

  it("没有关联时只给一行紧凑说明，不放大空态块", async () => {
    bridge.workspaceResourceList.mockResolvedValue(emptyPage);
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);

    expect(await screen.findByText(/还没有登记项目资源/)).toBeTruthy();
    // 旧的 16px 内边距居中大空态不再渲染，空态高度只占一行。
    expect(document.querySelector(".ws-empty")).toBeNull();
    expect(bridge.workspaceResourceList).toHaveBeenCalledWith("p1", null, 0, 50);
  });

  it("空集合仍保留类型选择、搜索、关联、总数与分页入口", async () => {
    bridge.workspaceResourceList.mockResolvedValue(emptyPage);
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);

    await screen.findByText(/还没有登记项目资源/);
    expect(screen.getByRole("combobox", { name: "资源类型" })).toBeTruthy();
    expect(screen.getByLabelText("搜索笔记")).toBeTruthy();
    expect(screen.getByRole("button", { name: "关联" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "筛选资源类型" })).toBeTruthy();
    expect(screen.getByText("共 0 条")).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一页" })).toBeTruthy();
  });

  it("筛选无结果时提示与空集合区分，不把筛选说成没有数据", async () => {
    bridge.workspaceResourceList.mockResolvedValue(emptyPage);
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);
    await screen.findByText(/还没有登记项目资源/);

    fireEvent.click(screen.getByRole("combobox", { name: "筛选资源类型" }));
    fireEvent.click(await screen.findByRole("option", { name: "产物" }));

    expect(await screen.findByText(/当前筛选下没有资源关联/)).toBeTruthy();
    expect(screen.queryByText(/还没有登记项目资源/)).toBeNull();
  });

  it("有数据时展示列表、失效提示与分页状态", async () => {
    bridge.workspaceResourceList.mockResolvedValue({
      links: [link(), link({ id: "r2", target: "D:\\产物\\报告.pdf", kind: "artifact", label: "报告", targetExists: false })],
      total: 120,
      offset: 0,
      limit: 50,
      hasMore: true,
    });
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);

    expect(await screen.findByText("设定草稿")).toBeTruthy();
    expect(screen.getByText("当前不可用")).toBeTruthy();
    expect(screen.getByText(/共 120 条/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/还没有登记项目资源/)).toBeNull();
  });

  it("读取失败显示错误，不把失败说成没有数据", async () => {
    bridge.workspaceResourceList.mockRejectedValue(new Error("读取资源失败"));
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("读取资源失败");
    expect(screen.queryByText(/还没有登记项目资源/)).toBeNull();
  });

  it("归档项目只读：不能新增关联", async () => {
    bridge.workspaceResourceList.mockResolvedValue(emptyPage);
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived />);

    expect(await screen.findByText(/项目已归档：资源只读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /关联$/ })).toBeNull();
  });

  it("切换项目：筛选回到全部、分页回到 0，请求带 null 类型", async () => {
    bridge.workspaceResourceList.mockResolvedValue(emptyPage);
    bridge.notesList.mockResolvedValue([]);
    const { rerender } = render(<ProjectResourcesCard projectId="p1" archived={false} />);
    await screen.findByText(/还没有登记项目资源/);

    fireEvent.click(screen.getByRole("combobox", { name: "筛选资源类型" }));
    fireEvent.click(await screen.findByRole("option", { name: "产物" }));

    await waitFor(() => expect(bridge.workspaceResourceList).toHaveBeenCalledWith("p1", "artifact", 0, 50));
    expect(screen.getByRole("combobox", { name: "筛选资源类型" }).textContent).toContain("产物");

    rerender(<ProjectResourcesCard projectId="p2" archived={false} />);

    await waitFor(() => expect(bridge.workspaceResourceList).toHaveBeenLastCalledWith("p2", null, 0, 50));
    expect(screen.getByRole("combobox", { name: "筛选资源类型" }).textContent).toContain("全部类型");
  });

  it("旧项目在途响应不会覆盖新项目资源", async () => {
    const p1 = deferred<Record<string, unknown>>();
    const pageB = {
      links: [link({ id: "b1", projectId: "p2", label: "B项目资源" })],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    };
    bridge.workspaceResourceList.mockImplementation((projectId: string) =>
      projectId === "p1" ? p1.promise : Promise.resolve(pageB),
    );
    bridge.notesList.mockResolvedValue([]);

    const { rerender } = render(<ProjectResourcesCard projectId="p1" archived={false} />);
    await waitFor(() => expect(bridge.workspaceResourceList).toHaveBeenCalledWith("p1", null, 0, 50));

    rerender(<ProjectResourcesCard projectId="p2" archived={false} />);
    expect(await screen.findByText("B项目资源")).toBeTruthy();

    // 旧项目请求最后返回，其代号已被作废，不应改写界面。
    await act(async () => {
      p1.resolve({
        links: [link({ id: "a1", projectId: "p1", label: "A项目资源" })],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
      });
    });

    expect(screen.queryByText("A项目资源")).toBeNull();
    expect(screen.getByText("B项目资源")).toBeTruthy();
  });

  it("有数据时两类条目与失效提示都渲染，下一页带上正确 offset", async () => {
    bridge.workspaceResourceList.mockResolvedValue({
      links: [
        link(),
        link({ id: "r2", kind: "artifact", label: "报告", targetExists: false }),
      ],
      total: 120,
      offset: 0,
      limit: 50,
      hasMore: true,
    });
    bridge.notesList.mockResolvedValue([]);
    render(<ProjectResourcesCard projectId="p1" archived={false} />);

    expect(await screen.findByText("设定草稿")).toBeTruthy();
    expect(screen.getByText("报告")).toBeTruthy();
    expect(screen.getByText("当前不可用")).toBeTruthy();
    expect(screen.getByText(/共 120 条/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(bridge.workspaceResourceList).toHaveBeenCalledWith("p1", null, 50, 50);
  });

  it("切换到归档项目后新增关联按钮消失", async () => {
    bridge.workspaceResourceList.mockResolvedValue(emptyPage);
    bridge.notesList.mockResolvedValue([]);
    const { rerender } = render(<ProjectResourcesCard projectId="p1" archived={false} />);
    expect(await screen.findByText(/还没有登记项目资源/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /关联$/ })).toBeTruthy();

    rerender(<ProjectResourcesCard projectId="p2" archived />);
    expect(await screen.findByText(/项目已归档：资源只读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /关联$/ })).toBeNull();
  });
});
