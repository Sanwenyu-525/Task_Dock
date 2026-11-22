/**
 * @vitest-environment jsdom
 */
//! 规划工作区精确定位意图消费端测试（ADR-0010 契约）：
//! - roadmapFocusRequest 的 projectId 是**项目根**：先对齐全局上下文，
//!   再由项目根快照解析 activePlanId，最后校验 feature/milestone 归属；
//! - 全局搜索 planning 意图：parentId 是计划 ID，workspaceProjectId 才是项目根；
//! - 项目不存在 / 计划缺失 / 对象不存在 / 过期意图：明确反馈，不伪装成功。
//! bridge planning 命令全部 mock，store 用真实实例；ProjectContext 用受控替身。

import { useCallback, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  projectHubGetProject: vi.fn(),
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
import { ProjectContextProvider, type ProjectContextValue } from "../../workbench/ProjectContext";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import type {
  PlanningFeature,
  PlanningMilestone,
  PlanningProject,
  WorkspaceProject,
} from "../../lib/bridge";

function plan(id: string, name: string, rootId: string | null): PlanningProject {
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
    workspace_project_id: rootId,
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

function feat(id: string, planId: string, title: string): PlanningFeature {
  return {
    id,
    project_id: planId,
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

const PLAN_A = plan("p1", "计划一", "root-a");
const PLAN_B = plan("p2", "计划二", "root-b");
const F1 = feat("f1", "p1", "已有功能");

function wsProject(id: string): WorkspaceProject {
  return {
    id,
    name: id === "root-a" ? "项目一" : "项目二",
    kind: "general",
    status: "active",
    rootPath: "",
    rootExists: false,
    devProjectId: null,
    devProjectExists: false,
    devProjectName: null,
    note: "",
    itemCount: 0,
    taskLinkCount: 0,
    createdAt: "",
    updatedAt: "",
  };
}

/** 项目根 → 计划的解析 mock：projectHubGetProject(root) 返回该根的 activePlanId。 */
function mockPlanResolve(mapping: Record<string, string | null | "error">) {
  bridge.projectHubGetProject.mockImplementation(async (rootId: string) => {
    const planId = mapping[rootId];
    if (planId === "error") throw new Error("项目不存在: " + rootId);
    return { project: { id: rootId, name: wsProject(rootId)?.name ?? rootId }, planId: planId ?? null };
  });
}

function seedStore(plans: PlanningProject[]) {
  usePlanningStore.setState({
    plans,
    plansLoading: false,
    plansError: null,
    activePlanId: null,
    loadedForPlan: null,
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

function setIntent(
  target: { projectId: string; featureId?: string; milestoneId?: string },
  expired = false,
) {
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

function intentToast(prefix: string): boolean {
  return useUiStore.getState().toasts.some((t) => t.message.startsWith(prefix));
}

/**
 * 受控全局上下文：selectProject 按项目列表校验并真实切换渲染中的 projectId，
 * 与 WorkbenchShell 的「校验存在 → 提交选择」语义一致。
 */
function WorkspaceHarness({
  initialProjectId,
  projects,
  extra,
  children,
}: {
  initialProjectId: string | null;
  projects: WorkspaceProject[];
  extra?: Partial<ProjectContextValue>;
  children?: ReactNode;
}) {
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const selectProject = useCallback(
    async (id: string | null): Promise<boolean> => {
      if (id && !projects.some((p) => p.id === id)) return false;
      setProjectId(id);
      return true;
    },
    [projects],
  );
  const value: ProjectContextValue = {
    projectId,
    selectedProject: projectId ? wsProject(projectId) : null,
    projects,
    projectsLoading: false,
    projectsError: null,
    selectProject,
    refreshProjects: vi.fn().mockResolvedValue([]),
    ...extra,
  };
  return <ProjectContextProvider value={value}>{children ?? <PlanningWorkspace />}</ProjectContextProvider>;
}

const ROOTS = [wsProject("root-a"), wsProject("root-b")];

beforeEach(() => {
  vi.clearAllMocks();
  bridge.planningActivityPage.mockResolvedValue({ items: [], has_more: false });
  useUiStore.setState({ toasts: [], toast: null, roadmapFocusRequest: null, tab: "roadmap" });
  useGlobalSearchStore.setState({ pendingLocate: null });
});

afterEach(cleanup);

describe("PlanningWorkspace 精确定位意图（roadmapFocus）", () => {
  it("定位功能成功：切换项目根 → 解析计划 → 打开功能视图并聚焦", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [feat("f9", "p2", "目标功能九")] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    setIntent({ projectId: "root-b", featureId: "f9" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    const tab = await screen.findByRole("tab", { name: "功能列表" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(await screen.findByText("目标功能九")).toBeTruthy();
    expect(bridge.planningListFeatures).toHaveBeenCalledWith("p2");
    expect(usePlanningStore.getState().activePlanId).toBe("p2");
    expect(intentToast("无法精确定位")).toBe(false);
    expect(useUiStore.getState().roadmapFocusRequest).toBeNull();
  });

  it("项目不存在：明确反馈并停在当前视图，不切换项目", async () => {
    mockPlanResolve({ "root-a": "p1" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A]);
    setIntent({ projectId: "root-gone" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );
    await waitFor(() => expect(intentToast("切换项目未完成，无法精确定位")).toBe(true));

    const tab = screen.getByRole("tab", { name: "项目总览" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p-gone");
    expect(usePlanningStore.getState().activePlanId).toBe("p1");
  });

  it("项目根没有可用计划：明确反馈，不伪装定位成功", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": null });
    bridge.planningListProjects.mockResolvedValue([PLAN_A]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A]);
    setIntent({ projectId: "root-b", featureId: "f9" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );
    await waitFor(() => expect(intentToast("该项目尚无可用计划，无法定位")).toBe(true));
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p2");
  });

  it("功能不存在：落到当前计划功能列表并反馈，不伪装定位成功", async () => {
    mockPlanResolve({ "root-a": "p1" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A]);
    setIntent({ projectId: "root-a", featureId: "f-missing" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );
    await waitFor(() =>
      expect(intentToast("功能不存在或已被删除，已定位到功能列表")).toBe(true),
    );

    const tab = screen.getByRole("tab", { name: "功能列表" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(await screen.findByText("已有功能")).toBeTruthy();
  });

  it("定位到存在的里程碑：进入功能视图并按里程碑过滤", async () => {
    mockPlanResolve({ "root-a": "p1" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([ms("m1", "M1 里程碑")]);
    seedStore([PLAN_A]);
    setIntent({ projectId: "root-a", milestoneId: "m1" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );
    const tab = await screen.findByRole("tab", { name: "功能列表" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(intentToast("里程碑不存在或已被删除")).toBe(false);
  });

  it("仅项目级定位：切换项目根并停在项目总览", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    setIntent({ projectId: "root-b" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );
    await waitFor(() => expect(usePlanningStore.getState().activePlanId).toBe("p2"));

    const tab = screen.getByRole("tab", { name: "项目总览" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("过期意图（TTL）：静默跳过，不切换项目也不反馈", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    setIntent({ projectId: "root-b", featureId: "f9" }, true);

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    await waitFor(() => expect(usePlanningStore.getState().activePlanId).toBe("p1"));
    expect(useUiStore.getState().roadmapFocusRequest).toBeNull();
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p2");
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});

describe("PlanningWorkspace 全局搜索定位（planning 分类）", () => {
  function setSearchIntent(intent: {
    kind: string;
    id: string;
    parentId: string | null;
    workspaceProjectId?: string | null;
  }) {
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "planning",
        id: intent.id,
        kind: intent.kind,
        parentId: intent.parentId,
        workspaceProjectId: intent.workspaceProjectId ?? null,
        keyword: "",
        token: 1,
      },
    });
  }

  it("feature 意图：parentId 是计划 ID，workspaceProjectId 是项目根 → 切项目定位功能", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [feat("f9", "p2", "搜索目标功能")] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    setSearchIntent({ kind: "feature", id: "f9", parentId: "p2", workspaceProjectId: "root-b" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    expect(await screen.findByText("搜索目标功能")).toBeTruthy();
    expect(usePlanningStore.getState().activePlanId).toBe("p2");
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();
  });

  it("feature 意图缺 workspaceProjectId：从计划列表归属解析项目根", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockResolvedValue([feat("f9", "p2", "解析根后定位")]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    setSearchIntent({ kind: "feature", id: "f9", parentId: "p2", workspaceProjectId: null });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    expect(await screen.findByText("解析根后定位")).toBeTruthy();
    expect(usePlanningStore.getState().activePlanId).toBe("p2");
  });

  it("孤儿计划（未关联项目根）：明确反馈，不把计划 ID 当项目 ID", async () => {
    mockPlanResolve({ "root-a": "p1" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, plan("p-orphan", "孤儿计划", null)]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, plan("p-orphan", "孤儿计划", null)]);
    setSearchIntent({ kind: "feature", id: "f-x", parentId: "p-orphan", workspaceProjectId: null });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );
    await waitFor(() => expect(intentToast("该计划未关联项目")).toBe(true));
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p-orphan");
    expect(usePlanningStore.getState().activePlanId).toBe("p1");
  });
});

describe("PlanningWorkspace 空态（ADR-0010 §5.5）", () => {
  it("全局无项目：不自动选任何项目，显示无项目空态", async () => {
    mockPlanResolve({});
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    seedStore([PLAN_A, PLAN_B]);

    render(
      <WorkspaceHarness initialProjectId={null} projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    expect(await screen.findByText(/尚未选择项目/)).toBeTruthy();
    // 不发任何计划数据请求，也不自动选中
    expect(bridge.planningListFeatures).not.toHaveBeenCalled();
    expect(usePlanningStore.getState().activePlanId).toBeNull();
  });

  it("当前项目没有可用计划：显示明确空态而不是别的项目的计划", async () => {
    mockPlanResolve({ "root-a": null });
    bridge.planningListProjects.mockResolvedValue([PLAN_A]);
    seedStore([PLAN_A]);

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    expect(await screen.findByText(/当前项目尚无可用计划/)).toBeTruthy();
    expect(bridge.planningListFeatures).not.toHaveBeenCalled();
  });

  it("兼容深链 initialPlanId：归属当前项目时优先查看该计划", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [feat("f9", "p2", "深链计划功能")] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);

    render(
      <WorkspaceHarness initialProjectId="root-b" projects={ROOTS}>
        <PlanningWorkspace initialPlanId="p2" />
      </WorkspaceHarness>,
    );

    // 深链只切换查看的计划，不改变视图：数据加载完成、选中态正确即可
    await waitFor(() =>
      expect(bridge.planningListFeatures).toHaveBeenCalledWith("p2"),
    );
    await waitFor(() => expect(usePlanningStore.getState().activePlanId).toBe("p2"));
    await waitFor(() => expect(usePlanningStore.getState().loadedForPlan).toBe("p2"));
    const overview = screen.getByRole("tab", { name: "项目总览" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
  });
});
