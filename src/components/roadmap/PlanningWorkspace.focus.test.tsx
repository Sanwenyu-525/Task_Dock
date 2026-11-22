/**
 * @vitest-environment jsdom
 */
//! 规划工作区精确定位意图消费端测试（ADR-0010 契约）：
//! - roadmapFocusRequest 的 projectId 是**项目根**：先对齐全局上下文，
//!   再由项目根快照解析 activePlanId，最后校验 feature/milestone 归属；
//! - 全局搜索 planning 意图：parentId 是计划 ID，workspaceProjectId 才是项目根；
//! - 项目不存在 / 计划缺失 / 对象不存在 / 过期意图：明确反馈，不伪装成功。
//! bridge planning 命令全部 mock，store 用真实实例；ProjectContext 用受控替身。

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 受控全局上下文：selectProject 按项目列表校验并真实切换渲染中的 projectId，
 *  与 WorkbenchShell 的「校验存在 → 提交选择」语义一致；controller 供模拟用户手动切换。 */
type HarnessController = { selectProject?: (id: string | null) => Promise<boolean> };

function WorkspaceHarness({
  initialProjectId,
  projects,
  extra,
  controller,
  children,
}: {
  initialProjectId: string | null;
  projects: WorkspaceProject[];
  extra?: Partial<ProjectContextValue>;
  controller?: HarnessController;
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
  useEffect(() => {
    if (controller) controller.selectProject = selectProject;
  }, [controller, selectProject]);
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

describe("PlanningWorkspace 归属校验与定位竞态（ADR-0010 收尾）", () => {
  it("快照归属不符：拒绝解析并明确报错，不加载任何计划", async () => {
    bridge.projectHubGetProject.mockResolvedValue({
      project: { id: "root-x", name: "错项目" },
      planId: "p1",
    });
    bridge.planningListProjects.mockResolvedValue([PLAN_A]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A]);

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    expect(await screen.findByText(/项目快照与请求的项目不一致/)).toBeTruthy();
    expect(bridge.planningListFeatures).not.toHaveBeenCalled();
    expect(usePlanningStore.getState().activePlanId).toBeNull();
  });

  it("快照加载失败：明确反馈解析失败，不误报「尚无可用计划」", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "error" });
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

    await waitFor(() => expect(intentToast("项目计划解析失败，无法定位")).toBe(true));
    expect(intentToast("该项目尚无可用计划")).toBe(false);
    // 切换后解析失败：不保留旧项目的计划数据。
    expect(usePlanningStore.getState().activePlanId).toBeNull();
  });

  it("搜索目标计划不是项目激活计划：拒绝打开，不切换项目", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    // root-b 的激活计划是 p2，却要求打开 p1（别的项目的计划）：必须拒绝。
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "planning",
        id: "f9",
        kind: "feature",
        parentId: "p1",
        workspaceProjectId: "root-b",
        keyword: "",
        token: 1,
      },
    });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    await waitFor(() => expect(intentToast("目标计划不是当前项目的激活计划")).toBe(true));
    expect(usePlanningStore.getState().activePlanId).toBe("p1");
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p2");
  });

  it("搜索项目根快照归属不符：取消定位并明确反馈", async () => {
    bridge.projectHubGetProject.mockImplementation(async (rootId: string) =>
      rootId === "root-b"
        ? { project: { id: "root-x", name: "错项目" }, planId: "p2" }
        : { project: { id: rootId, name: "项目一" }, planId: "p1" },
    );
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "planning",
        id: "f9",
        kind: "feature",
        parentId: "p2",
        workspaceProjectId: "root-b",
        keyword: "",
        token: 1,
      },
    });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    await waitFor(() => expect(intentToast("项目快照与目标项目不一致")).toBe(true));
    expect(usePlanningStore.getState().activePlanId).toBe("p1");
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p2");
  });

  it("计划列表加载失败：反馈解析失败，不误报孤儿计划", async () => {
    mockPlanResolve({ "root-a": "p1" });
    bridge.planningListProjects.mockRejectedValue(new Error("列表读取失败"));
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([]);
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "planning",
        id: "f9",
        kind: "feature",
        parentId: "p2",
        workspaceProjectId: null,
        keyword: "",
        token: 1,
      },
    });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    await waitFor(() => expect(intentToast("计划列表加载失败")).toBe(true));
    expect(intentToast("该计划未关联项目")).toBe(false);
    expect(usePlanningStore.getState().activePlanId).toBe("p1");
  });

  it("定位等待快照时用户手动切走项目：旧定位静默放弃，不抢新项目视图", async () => {
    const snapB = deferred<{ project: { id: string; name: string }; planId: string | null }>();
    const PLAN_C = plan("p3", "计划三", "root-c");
    bridge.projectHubGetProject.mockImplementation(async (rootId: string) => {
      if (rootId === "root-b") return snapB.promise;
      if (rootId === "root-c") return { project: { id: rootId, name: "项目三" }, planId: "p3" };
      return { project: { id: rootId, name: "项目一" }, planId: "p1" };
    });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B, PLAN_C]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [feat("f9", "p2", "迟到功能")] : pid === "p3" ? [] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B, PLAN_C]);
    setIntent({ projectId: "root-b", featureId: "f9" });
    const controller: HarnessController = {};

    render(
      <WorkspaceHarness
        controller={controller}
        initialProjectId="root-a"
        projects={[...ROOTS, wsProject("root-c")]}
      >
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    await waitFor(() => expect(bridge.projectHubGetProject).toHaveBeenCalledWith("root-b"));
    // 用户在 root-b 快照仍挂起时手动切到 root-c。
    await act(async () => {
      await controller.selectProject!("root-c");
    });
    await waitFor(() => expect(usePlanningStore.getState().activePlanId).toBe("p3"));
    // 旧定位的迟到回包不得再选中 p2、不得用失败文案打断用户。
    snapB.resolve({ project: { id: "root-b", name: "项目二" }, planId: "p2" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p2");
    expect(intentToast("该项目尚无可用计划")).toBe(false);
    expect(intentToast("项目计划解析失败")).toBe(false);
    expect(intentToast("切换项目未完成")).toBe(false);
    expect(usePlanningStore.getState().activePlanId).toBe("p3");
  });

  it("用户在定位途中切换视图：旧定位不得把视图拉回", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    const featuresP2 = deferred<PlanningFeature[]>();
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? featuresP2.promise : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    setIntent({ projectId: "root-b", featureId: "f9" });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    // 定位已切到 root-b 且 p2 数据仍在途：此时用户手动切到里程碑视图。
    await waitFor(() => expect(bridge.planningListFeatures).toHaveBeenCalledWith("p2"));
    fireEvent.click(screen.getByRole("tab", { name: "里程碑" }));
    featuresP2.resolve([feat("f9", "p2", "定位目标九")]);
    await waitFor(() => expect(usePlanningStore.getState().loadedForPlan).toBe("p2"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // 旧定位被用户接管：视图保持在里程碑，不再跳回功能视图。
    expect(screen.getByRole("tab", { name: "里程碑" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "功能列表" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(intentToast("功能不存在")).toBe(false);
  });

  it("深链 initialPlanId 变化（p1→p1b）：新的合法目标可以再次消费", async () => {
    const PLAN_A2 = plan("p1b", "计划一B", "root-a");
    mockPlanResolve({ "root-a": "p1" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_A2]);
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p1b" ? [feat("f2", "p1b", "深链二功能")] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_A2]);

    const view = render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace initialPlanId="p1" />
      </WorkspaceHarness>,
    );
    await waitFor(() => expect(usePlanningStore.getState().activePlanId).toBe("p1"));

    view.rerender(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace initialPlanId="p1b" />
      </WorkspaceHarness>,
    );
    await waitFor(() => expect(usePlanningStore.getState().activePlanId).toBe("p1b"));
    expect(bridge.planningListFeatures).toHaveBeenCalledWith("p1b");
  });

  it("深链计划不属于当前项目：明确反馈且不加载", async () => {
    mockPlanResolve({ "root-a": "p1" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    bridge.planningListFeatures.mockResolvedValue([F1]);
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace initialPlanId="p2" />
      </WorkspaceHarness>,
    );

    await waitFor(() => expect(intentToast("该计划不存在或不属于当前项目")).toBe(true));
    expect(usePlanningStore.getState().activePlanId).toBe("p1");
    expect(bridge.planningListFeatures).not.toHaveBeenCalledWith("p2");
  });

  it("功能不属于当前计划：不伪装定位成功，落回功能列表并反馈", async () => {
    mockPlanResolve({ "root-a": "p1", "root-b": "p2" });
    bridge.planningListProjects.mockResolvedValue([PLAN_A, PLAN_B]);
    // p2 的列表里混入一条 project_id=p1 的脏数据：定位必须识别归属不符。
    bridge.planningListFeatures.mockImplementation(async (pid: string) =>
      pid === "p2" ? [feat("f9", "p1", "错归属功能")] : [F1],
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    seedStore([PLAN_A, PLAN_B]);
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "planning",
        id: "f9",
        kind: "feature",
        parentId: "p2",
        workspaceProjectId: "root-b",
        keyword: "",
        token: 1,
      },
    });

    render(
      <WorkspaceHarness initialProjectId="root-a" projects={ROOTS}>
        <PlanningWorkspace />
      </WorkspaceHarness>,
    );

    await waitFor(() => expect(intentToast("功能不属于当前计划")).toBe(true));
    expect(usePlanningStore.getState().activePlanId).toBe("p2");
    const tab = screen.getByRole("tab", { name: "功能列表" });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  });
});
