/**
 * @vitest-environment jsdom
 */
//! 通用线 milestones 模块测试（U1）：真实统计零值、模板预览与应用、归档只读。
//! 只 mock 本目录 `./ipc.ts` 包装层，不 mock React/DOM。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  generalMilestoneList: vi.fn(),
  generalStats: vi.fn(),
  coreItemList: vi.fn(),
  coreTaskLinkList: vi.fn(),
  generalApplyTemplate: vi.fn(),
  generalMilestoneSave: vi.fn(),
  generalMilestoneDelete: vi.fn(),
}));

vi.mock("./ipc", () => api);

import MilestonesPanel from "./MilestonesPanel";
import { GENERAL_TEMPLATES, templateCounts } from "./templates";

const baseProps = {
  projectId: "p1",
  projectName: "通用项目",
  kind: "general" as const,
  archived: false,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  onNotice: vi.fn(),
  switchModule: vi.fn(),
};

const emptyStats = {
  totalItems: 0,
  todoItems: 0,
  doingItems: 0,
  blockedItems: 0,
  doneItems: 0,
  milestonesTotal: 0,
  milestonesOpen: 0,
  milestonesDone: 0,
  milestonesSkipped: 0,
  linkedTasks: 0,
  materialsTotal: 0,
  materialsAlive: 0,
  currentMilestone: null,
  recentActivity: [],
};

beforeEach(() => {
  api.generalMilestoneList.mockResolvedValue({ milestones: [] });
  api.generalStats.mockResolvedValue({ stats: emptyStats });
  api.coreItemList.mockResolvedValue({ items: [] });
  api.coreTaskLinkList.mockResolvedValue({ links: [] });
  api.generalApplyTemplate.mockResolvedValue({
    applied: true,
    itemsCreated: 4,
    milestonesCreated: 2,
    reason: null,
  });
  api.generalMilestoneSave.mockResolvedValue({ milestone: {} });
  api.generalMilestoneDelete.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MilestonesPanel 统计与空态", () => {
  it("空项目所有指标显示 0，不填充示例数字", async () => {
    render(<MilestonesPanel {...baseProps} />);
    await waitFor(() => expect(api.generalStats).toHaveBeenCalledWith("p1"));
    expect(screen.getAllByText("0/0").length).toBeGreaterThan(0);
    expect(screen.getByText("还没有里程碑；可应用模板初始化，或新建里程碑。")).toBeTruthy();
    expect(screen.getByText("暂无活动记录。")).toBeTruthy();
  });

  it("模板预览数量由常量派生，应用时下发真实阶段结构", async () => {
    // 纯函数：各模板事项/里程碑计数与预览口径一致。
    const study = GENERAL_TEMPLATES.find((t) => t.id === "study-plan")!;
    const counts = templateCounts(study);
    expect(counts.items).toBe(6);
    expect(counts.milestones).toBe(3);

    render(<MilestonesPanel {...baseProps} />);
    await waitFor(() => expect(api.generalStats).toHaveBeenCalled());

    // 默认空白模板：预览 0/0，应用下发空阶段。
    expect(screen.getByText(/将创建 0 个事项、0 个里程碑/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /应用模板/ }));
    await waitFor(() => expect(api.generalApplyTemplate).toHaveBeenCalled());
    const [projectId, templateId, stages] = api.generalApplyTemplate.mock.calls[0];
    expect(projectId).toBe("p1");
    expect(templateId).toBe("blank");
    expect(stages).toEqual([]);
  });

  it("渲染真实里程碑标题、状态与关联标题", async () => {
    api.generalMilestoneList.mockResolvedValue({
      milestones: [
        {
          id: "m1",
          projectId: "p1",
          title: "准备完成",
          targetDate: "2026-12-01",
          status: "open",
          note: "开工前检查",
          sortOrder: 0,
          linkedItemId: "i1",
          linkedItemExists: true,
          linkedItemTitle: "调研目标",
          linkedTaskId: "t1",
          linkedTaskExists: true,
          linkedTaskTitle: "关联任务",
          createdAt: "2026-11-16T09:00:00+08:00",
          updatedAt: "2026-11-16T09:00:00+08:00",
        },
      ],
    });
    render(<MilestonesPanel {...baseProps} />);
    await waitFor(() => expect(screen.getByText("准备完成")).toBeTruthy());
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText(/事项：调研目标/)).toBeTruthy();
    expect(screen.getByText(/任务：关联任务/)).toBeTruthy();
  });

  it("归档项目禁用新建与模板应用入口", async () => {
    render(<MilestonesPanel {...baseProps} archived />);
    await waitFor(() => expect(api.generalStats).toHaveBeenCalled());
    expect(
      (screen.getByRole("button", { name: /新建里程碑/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /应用模板/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText("项目已归档，阶段与里程碑为只读；恢复为进行中后才能修改。"),
    ).toBeTruthy();
  });
});
