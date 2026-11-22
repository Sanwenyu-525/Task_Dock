/**
 * @vitest-environment jsdom
 */
//! 规划中心精确定位意图（roadmapFocusRequest）消费端测试：
//! 成功定位功能 / 项目不存在 / 功能不存在 / 里程碑不存在 / 过期意图静默跳过。
//! bridge planning 命令全部 mock，store 用真实实例（与 PlanningCenterPanel.test 同模式）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  planningListProjects: vi.fn(),
  planningListFeatures: vi.fn(),
  planningListMilestones: vi.fn(),
  planningActivityPage: vi.fn(async () => ({ items: [], has_more: false })),
}));

vi.mock("../../lib/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bridge")>()),
  ...bridge,
}));

import PlanningWorkspace from "./PlanningWorkspace";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";
import type { PlanningFeature, PlanningMilestone, PlanningProject } from "../../lib/bridge";

function proj(id: string, name: string): PlanningProject {
  return {
    id,
    name,
    description: "",
    status: "in_progress",
    archived: false,
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
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
  };
}

function feat(id: string, title: string): PlanningFeature {
  return {
    id,
    project_id: "p1",
    title,
    description: "",
    acceptance_criteria: "",
    status: "planned",
    priority: "P1",
    milestone_id: null,
    milestone_name: null,
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    completed_at: null,
    steps: [],
    step_total: 0,
    step_done: 0,
  };
}

function ms(id: string, name: string): PlanningMilestone {
  return {
    id,
    project_id: "p1",
    name,
    description: "",
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    feature_total: 0,
    feature_completed: 0,
  };
}

const P1 = proj("p1", "项目一");
const P2 = proj("p2", "项目二");
const F1 = feat("f1", "已有功能");

function seedStore(projects: PlanningProject[]) {
  // 项目列表按「已加载」预置：自动选中第一个项目的 selectProject 立即发出，
  // 意图的 selectProject 随后发出（代际更新），执行顺序确定、无加载竞态。
  usePlanningStore.setState({
    projects,
    projectsLoading: false,
    projectsError: null,
    activeProjectId: null,
    loadedForProject: null,
    features: [],
    featuresLoading: false,
    featuresError: null,
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

function setIntent(target: {
  projectId: string;
  featureId?: string;
  milestoneId?: string;
}, expired = false) {
  useUiStore.setState({
    toasts: [],
    toast: null,
    roadmapFocusRequest: {
      token: 1,
      projectId: target.projectId,
      featureId: target.featureId,
      milestoneId: target.milestoneId,
      expiresAt: expired ? Date.now() - 1000 : Date.now() + 15_000,
    },
  });
}

function intentToast(message: string): boolean {
  return useUiStore.getState().toasts.some((t) => t.message === message);
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.planningActivityPage.mockResolvedValue({ items: [], has_more: false });
  useUiStore.setState({ toasts: [], toast: null, roadmapFocusRequest: null, tab: "roadmap" });
});

afterEach(cleanup);

async function renderWorkspace() {
  render(<PlanningWorkspace />);
  // 自动选中第一个项目触发一次功能加载
  await waitFor(() => expect(bridge.planningListFeatures).toHaveBeenCalledWith("p1"));
}

describe("PlanningWorkspace 精确定位意图", () => {
  it("定位功能成功：切换项目 → 打开功能视图并聚焦该功能", async () => {
    bridge.planningListProjects.mockResolvedValue([P1, P2]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [feat("f9", "目标功能九")] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([P1, P2]);
    setIntent({ projectId: "p2", featureId: "f9" });

    await renderWorkspace();

    // 功能列表视图被选中，目标功能卡片出现且属于项目二
    const tab = await screen.findByRole("tab", { name: "功能列表" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(await screen.findByText("目标功能九")).toBeTruthy();
    expect(bridge.planningListFeatures).toHaveBeenCalledWith("p2");
    expect(usePlanningStore.getState().activeProjectId).toBe("p2");
    expect(intentToast("项目不存在或已删除")).toBe(false);
    // 意图消费即清除
    expect(useUiStore.getState().roadmapFocusRequest).toBeNull();
  });

  it("项目不存在或已删除：明确反馈并停在当前视图，不切换项目", async () => {
    bridge.planningListProjects.mockResolvedValue([P1]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([P1]);
    setIntent({ projectId: "p-gone" });

    await renderWorkspace();
    await waitFor(() => expect(intentToast("项目不存在或已删除")).toBe(true));

    // 停在项目总览；不存在 projects 的列表请求从未发出
    const tab = screen.getByRole("tab", { name: "项目总览" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p-gone");
    expect(usePlanningStore.getState().activeProjectId).toBe("p1");
  });

  it("功能不存在：落到该项目功能列表并反馈，不伪装定位成功", async () => {
    bridge.planningListProjects.mockResolvedValue([P1]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([P1]);
    setIntent({ projectId: "p1", featureId: "f-missing" });

    await renderWorkspace();
    await waitFor(() =>
      expect(intentToast("功能不存在或已被删除，已定位到项目功能列表")).toBe(true),
    );

    const tab = screen.getByRole("tab", { name: "功能列表" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(await screen.findByText("已有功能")).toBeTruthy();
  });

  it("里程碑不存在：落到该项目里程碑列表并反馈", async () => {
    bridge.planningListProjects.mockResolvedValue([P1]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([P1]);
    setIntent({ projectId: "p1", milestoneId: "m-gone" });

    await renderWorkspace();
    await waitFor(() =>
      expect(intentToast("里程碑不存在或已被删除，已定位到项目里程碑列表")).toBe(true),
    );

    const tab = screen.getByRole("tab", { name: "里程碑" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  });

  it("定位到存在的里程碑：进入功能视图并按里程碑过滤", async () => {
    bridge.planningListProjects.mockResolvedValue([P1]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([ms("m1", "M1 里程碑")]);
    seedStore([P1]);
    setIntent({ projectId: "p1", milestoneId: "m1" });

    await renderWorkspace();
    const tab = await screen.findByRole("tab", { name: "功能列表" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(intentToast("里程碑不存在或已被删除，已定位到项目里程碑列表")).toBe(false);
  });

  it("仅项目级定位：切换项目并停在项目总览", async () => {
    bridge.planningListProjects.mockResolvedValue([P1, P2]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([P1, P2]);
    setIntent({ projectId: "p2" });

    await renderWorkspace();
    await waitFor(() => expect(usePlanningStore.getState().activeProjectId).toBe("p2"));

    const tab = screen.getByRole("tab", { name: "项目总览" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("过期意图（TTL）：静默跳过，不切换项目也不反馈", async () => {
    bridge.planningListProjects.mockResolvedValue([P1, P2]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([P1, P2]);
    setIntent({ projectId: "p2", featureId: "f9" }, true);

    await renderWorkspace();

    await waitFor(() => expect(usePlanningStore.getState().activeProjectId).toBe("p1"));
    // 意图已消费但不产生任何定位动作
    expect(useUiStore.getState().roadmapFocusRequest).toBeNull();
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p2");
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});
