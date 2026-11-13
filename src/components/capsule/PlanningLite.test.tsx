/**
 * @vitest-environment jsdom
 */
//! 规划中心胶囊面板（PlanningLite）行为测试：真实 store + mock 后端命令。
//!
//! 覆盖：
//! - 首屏读取项目并选择第一个未归档项目，渲染真实功能与进度；
//! - 空项目只请求一次（v0.7「空项目 effect 无限重发 IPC」回归）；
//! - 步骤勾选走真实 `planningUpdateStep`，失败不伪造完成；
//! - 项目切换走二级视图，不弹会被 Win32 区域裁掉的下拉浮层；
//! - 读取失败显示重试且不冒充「还没有项目」；完整入口仍可用。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const planningListProjects = vi.fn();
const planningListFeatures = vi.fn();
const planningListMilestones = vi.fn();
const planningUpdateStep = vi.fn();
const onPlanningChanged = vi.fn(async (_cb: () => void) => () => {});
const openFullApp = vi.fn();
const requestRoadmapFocus = vi.fn();

vi.mock("../../lib/bridge", () => ({
  planningListProjects: (...a: unknown[]) => planningListProjects(...a),
  planningListFeatures: (...a: unknown[]) => planningListFeatures(...a),
  planningListMilestones: (...a: unknown[]) => planningListMilestones(...a),
  planningUpdateStep: (...a: unknown[]) => planningUpdateStep(...a),
  planningCreateProject: vi.fn(),
  planningUpdateProject: vi.fn(),
  planningArchiveProject: vi.fn(),
  planningDeleteProject: vi.fn(),
  planningReorderProjects: vi.fn(),
  planningCreateFeature: vi.fn(),
  planningUpdateFeature: vi.fn(),
  planningDeleteFeature: vi.fn(),
  planningReorderFeatures: vi.fn(),
  planningAddStep: vi.fn(),
  planningDeleteStep: vi.fn(),
  planningReorderSteps: vi.fn(),
  planningCreateMilestone: vi.fn(),
  planningUpdateMilestone: vi.fn(),
  planningDeleteMilestone: vi.fn(),
  planningActivityPage: vi.fn(),
  planningAddNote: vi.fn(),
  onPlanningChanged: (cb: () => void) => onPlanningChanged(cb),
}));

vi.mock("./actions", () => ({
  openFullApp: (...a: unknown[]) => openFullApp(...a),
  // openRoadmapFocus = openFullApp("roadmap") + 导航成功后下发一次性定位意图。
  // mock 记录意图参数：断言「切页」与「定位目标」两件事。
  openRoadmapFocus: (target: { projectId: string; featureId?: string }) =>
    openFullApp("roadmap", () => requestRoadmapFocus(target)),
}));

vi.mock("../roadmap/PlanningBits", () => ({
  PlanningFeatureStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="status">{status}</span>
  ),
  PlanningProgressBar: ({ value }: { value: number }) => (
    <span data-testid="progress">{value}%</span>
  ),
}));

import type { PlanningFeature, PlanningProject } from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import PlanningLite from "./PlanningLite";

function project(over: Partial<PlanningProject> = {}): PlanningProject {
  return {
    id: "p1",
    name: "产品路线",
    description: "",
    status: "in_progress",
    archived: false,
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    stats: {
      feature_total: 2,
      feature_completed: 0,
      feature_in_progress: 1,
      feature_blocked: 0,
      feature_planned: 1,
      feature_review: 0,
      feature_paused: 0,
      has_features: true,
      progress_percent: 0,
    },
    ...over,
  };
}

function feature(over: Partial<PlanningFeature> = {}): PlanningFeature {
  return {
    id: "f1",
    project_id: "p1",
    title: "登录流程",
    description: "支持邮箱登录",
    acceptance_criteria: "输入合法邮箱可以登录",
    status: "in_progress",
    priority: "P0",
    milestone_id: null,
    milestone_name: null,
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    completed_at: null,
    revision: 1,
    steps: [
      {
        id: "s1",
        feature_id: "f1",
        title: "设计表单",
        done: false,
        sort_order: 0,
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
        completed_at: null,
      },
    ],
    step_total: 1,
    step_done: 0,
    ...over,
  };
}

function resetStore() {
  usePlanningStore.setState({
    projects: [],
    projectsLoading: false,
    projectsError: null,
    activeProjectId: null,
    features: [],
    featuresLoading: false,
    featuresError: null,
    loadedForProject: null,
    milestones: [],
    milestonesLoading: false,
    milestonesError: null,
    activity: [],
    activityHasMore: false,
    activityLoading: false,
    activityError: null,
    activityScope: null,
  });
}

beforeEach(() => {
  cleanup();
  planningListProjects.mockReset();
  planningListFeatures.mockReset();
  planningListMilestones.mockReset();
  planningUpdateStep.mockReset();
  onPlanningChanged.mockClear();
  openFullApp.mockReset();
  requestRoadmapFocus.mockReset();
  resetStore();
});

afterEach(() => cleanup());

describe("PlanningLite", () => {
  it("读取项目并选择第一个未归档项目，渲染功能与步骤进度", async () => {
    planningListProjects.mockResolvedValue([project()]);
    planningListFeatures.mockResolvedValue([feature()]);
    planningListMilestones.mockResolvedValue([]);

    render(<PlanningLite />);

    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());
    expect(planningListProjects).toHaveBeenCalledTimes(1);
    expect(planningListFeatures).toHaveBeenCalledWith("p1");
    expect(screen.getByText(/产品路线 · 0\/1 完成 · 0%/)).toBeTruthy();
    expect(screen.getByText("0/1 步骤")).toBeTruthy();
  });

  it("空项目只请求一次：项目/功能都不会被 effect 反复重发", async () => {
    planningListProjects.mockResolvedValue([
      project({
        stats: {
          feature_total: 0,
          feature_completed: 0,
          feature_in_progress: 0,
          feature_blocked: 0,
          feature_planned: 0,
          feature_review: 0,
          feature_paused: 0,
          has_features: false,
          progress_percent: 0,
        },
      }),
    ]);
    planningListFeatures.mockResolvedValue([]);
    planningListMilestones.mockResolvedValue([]);

    render(<PlanningLite />);

    await waitFor(() => expect(screen.getByText("这个项目还没有功能")).toBeTruthy());
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    expect(planningListProjects).toHaveBeenCalledTimes(1);
    expect(planningListFeatures).toHaveBeenCalledTimes(1);
  });

  it("没有任何用户项目时默认展示内置路线图，而不是空态", async () => {
    planningListProjects.mockResolvedValue([]);

    render(<PlanningLite />);

    await waitFor(() => expect(screen.getByText("全局快速捕获")).toBeTruthy());
    expect(
      screen.getByRole("tab", { name: "内置路线图" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText(/内置路线图 · \d+ 项 · 已实现 \d+/)).toBeTruthy();
    expect(screen.queryByText("还没有规划项目")).toBeNull();
    expect(screen.queryByText("去完整规划中心创建")).toBeNull();
    expect(planningListFeatures).not.toHaveBeenCalled();
    expect(planningListMilestones).not.toHaveBeenCalled();

    // 只读目录也能就地展开详情，不需要额外 IPC。
    fireEvent.click(screen.getByRole("button", { name: "查看「全局快速捕获」详情" }));
    expect(screen.getByRole("button", { name: "收起「全局快速捕获」详情" })).toBeTruthy();
  });

  it("来源开关：内置路线图与我的项目互不影响，切回恢复用户功能", async () => {
    planningListProjects.mockResolvedValue([project()]);
    planningListFeatures.mockResolvedValue([feature()]);
    planningListMilestones.mockResolvedValue([]);

    render(<PlanningLite />);
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: "内置路线图" }));
    expect(await screen.findByText("全局快速捕获")).toBeTruthy();
    expect(screen.queryByText("登录流程")).toBeNull();
    expect(screen.getByText("只读 · 来自功能目录")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "我的项目" }));
    expect(await screen.findByText("登录流程")).toBeTruthy();
    expect(screen.queryByText("全局快速捕获")).toBeNull();
  });

  it("步骤勾选调用真实命令；成功后使用后端权威实体更新勾选态", async () => {
    const initial = feature();
    const updated = feature({
      step_done: 1,
      steps: [{ ...initial.steps[0], done: true, completed_at: "2026-11-07T00:00:00Z" }],
    });
    planningListProjects.mockResolvedValue([project()]);
    planningListFeatures.mockResolvedValue([initial]);
    planningListMilestones.mockResolvedValue([]);
    planningUpdateStep.mockResolvedValue(updated);

    render(<PlanningLite />);
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "查看「登录流程」详情" }));
    fireEvent.click(screen.getByRole("button", { name: "完成步骤「设计表单」" }));

    await waitFor(() => expect(planningUpdateStep).toHaveBeenCalledWith("s1", { done: true }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重新打开步骤「设计表单」" })).toBeTruthy(),
    );
    expect(screen.getByText("1/1 步骤")).toBeTruthy();
  });

  it("步骤更新失败：保留未完成态并提示，不伪装成功", async () => {
    planningListProjects.mockResolvedValue([project()]);
    planningListFeatures.mockResolvedValue([feature()]);
    planningListMilestones.mockResolvedValue([]);
    planningUpdateStep.mockRejectedValue(new Error("db busy"));

    render(<PlanningLite />);
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "查看「登录流程」详情" }));
    fireEvent.click(screen.getByRole("button", { name: "完成步骤「设计表单」" }));

    await waitFor(() => expect(screen.getByText("步骤更新失败，请重试")).toBeTruthy());
    expect(screen.getByRole("button", { name: "完成步骤「设计表单」" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新打开步骤「设计表单」" })).toBeNull();
  });

  it("项目切换走面板内二级视图：选择后加载对应项目功能", async () => {
    const second = project({ id: "p2", name: "增长实验", sort_order: 1 });
    planningListProjects.mockResolvedValue([project(), second]);
    planningListFeatures.mockImplementation(async (id: string) =>
      id === "p2" ? [feature({ id: "f2", project_id: "p2", title: "邀请码实验" })] : [feature()],
    );
    planningListMilestones.mockResolvedValue([]);

    render(<PlanningLite />);
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "切换规划项目" }));
    fireEvent.click(screen.getByRole("button", { name: "打开项目「增长实验」" }));

    await waitFor(() => expect(planningListFeatures).toHaveBeenCalledWith("p2"));
    await waitFor(() => expect(screen.getByText("邀请码实验")).toBeTruthy());
  });

  it("项目读取失败：显示重试，不冒充「还没有规划项目」", async () => {
    planningListProjects.mockRejectedValue(new Error("network down"));

    render(<PlanningLite />);

    await waitFor(() => expect(screen.getByText("项目列表读取失败")).toBeTruthy());
    expect(screen.queryByText("还没有规划项目")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(planningListProjects).toHaveBeenCalledTimes(2));
  });

  it("底栏「完整规划」跳转完整规划中心", async () => {
    planningListProjects.mockResolvedValue([project()]);
    planningListFeatures.mockResolvedValue([feature()]);
    planningListMilestones.mockResolvedValue([]);

    render(<PlanningLite />);
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());

    // 已选择项目：完整规划按当前项目下发一次性定位意图（仍是同一导航事务）
    fireEvent.click(screen.getByRole("button", { name: /完整规划/ }));
    expect(openFullApp).toHaveBeenCalledWith("roadmap", expect.any(Function));
  });

  it("功能详情的「完整规划」按项目+功能下发定位意图（openRoadmapFocus）", async () => {
    planningListProjects.mockResolvedValue([project()]);
    planningListFeatures.mockResolvedValue([feature()]);
    planningListMilestones.mockResolvedValue([]);

    render(<PlanningLite />);
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());

    // 展开功能详情 → 点详情里的「完整规划」（底栏同名按钮之外，取详情内的 cap-mini）
    fireEvent.click(screen.getByRole("button", { name: /查看「登录流程」详情/ }));
    const detailBtn = screen
      .getAllByRole("button", { name: "完整规划" })
      .find((el) => el.className.includes("cap-mini"));
    expect(detailBtn).toBeTruthy();
    fireEvent.click(detailBtn!);
    expect(openFullApp).toHaveBeenCalledWith("roadmap", expect.any(Function));
    // 真实契约：定位意图绑定在导航事务上，只在导航成功后下发一次（consume-once）。
    // mock 的 openFullApp 不会自己执行 after，这里模拟「导航成功」触发它。
    const after = openFullApp.mock.calls
      .filter((c) => c[0] === "roadmap" && typeof c[1] === "function")
      .map((c) => c[1] as () => void)
      .pop();
    after?.();
    expect(requestRoadmapFocus).toHaveBeenCalledTimes(1);
    expect(requestRoadmapFocus).toHaveBeenCalledWith({ projectId: "p1", featureId: "f1" });
  });

  it("快速查找：客户端过滤已加载功能（含内置目录），不新增 IPC", async () => {
    planningListProjects.mockResolvedValue([project()]);
    planningListFeatures.mockResolvedValue([
      feature(),
      feature({ id: "f2", title: "导出报表", description: "按周导出" }),
    ]);
    planningListMilestones.mockResolvedValue([]);

    render(<PlanningLite />);
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy());
    const callsBefore = planningListFeatures.mock.calls.length;

    fireEvent.change(screen.getByLabelText("查找规划功能"), {
      target: { value: "导出" },
    });
    // 250ms 防抖后过滤生效：未命中的「登录流程」从列表消失
    await waitFor(() => expect(screen.queryByText("登录流程")).toBeNull(), { timeout: 1000 });
    expect(screen.getByText("导出报表")).toBeTruthy();
    // 客户端过滤：不重发功能查询
    expect(planningListFeatures.mock.calls.length).toBe(callsBefore);

    // 清空搜索恢复完整列表
    fireEvent.change(screen.getByLabelText("查找规划功能"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("登录流程")).toBeTruthy(), { timeout: 1000 });
    expect(screen.getByText("导出报表")).toBeTruthy();
  });
});
