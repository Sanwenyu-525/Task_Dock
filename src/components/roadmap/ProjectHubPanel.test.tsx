/**
 * @vitest-environment jsdom
 */
//! 项目中枢面板测试（jsdom）：
//! - 创建项目携带功能草案（features + phaseIndex），重试复用同一 clientRequestId；
//! - 参数变化时请求 ID 变化；
//! - 项目切换不串数据（代际保护）；
//! - 进度口径：阶段按功能完成度、里程碑无依据时待评估；
//! - 项目资源视图：真实查询、绑定、解除绑定与可用性校验。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectHubPanel from "./ProjectHubPanel";
import type {
  ProjectHubCreateInput,
  ProjectHubProjectSummary,
  ProjectHubResourceCandidate,
  ProjectHubResourceLink,
  ProjectHubSnapshot,
} from "../../lib/bridge";

const bridge = vi.hoisted(() => ({
  projectHubListProjects: vi.fn(),
  projectHubGetProject: vi.fn(),
  projectHubCreateProject: vi.fn(),
  projectHubResourceCandidates: vi.fn(),
  projectHubResourceLinks: vi.fn(),
  projectHubResourceLink: vi.fn(),
  projectHubResourceUnlink: vi.fn(),
  projectHubResourceValidate: vi.fn(),
  openProjectWorkspaceWindow: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bridge")>()),
  ...bridge,
}));

function nameOf(id: string): string {
  if (id === "p-a") return "项目 A";
  if (id === "p-b") return "项目 B";
  if (id === "new") return "新建项目";
  return `项目 ${id}`;
}

function summary(id: string, name: string): ProjectHubProjectSummary {
  return {
    id,
    name,
    kind: "general",
    status: "active",
    description: "",
    goal: "目标",
    targetDate: null,
    activePlanId: `plan-${id}`,
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    phaseCount: 2,
    taskCount: 1,
    completedTaskCount: 0,
    capabilityCount: 1,
    capabilityGapCount: 0,
    deliverableCount: 0,
  };
}

function snapshot(id: string, overrides: Partial<ProjectHubSnapshot> = {}): ProjectHubSnapshot {
  return {
    project: summary(id, nameOf(id)),
    planId: `plan-${id}`,
    goals: [],
    phases: [
      {
        id: "p1",
        name: "阶段一",
        description: "",
        targetDate: null,
        startDate: null,
        sortOrder: 0,
        taskCount: 0,
        completedTaskCount: 0,
        featureCount: 1,
        completedFeatureCount: 0,
      },
    ],
    milestones: [],
    features: [
      {
        id: "f1",
        title: "功能一",
        description: "",
        status: "planned",
        priority: "P0",
        milestoneId: "p1",
        acceptanceCriteria: "",
        targetDate: null,
        sortOrder: 0,
      },
    ],
    capabilities: [
      {
        id: "req-1",
        capabilityId: "cap-1",
        name: "结构设计",
        category: "human",
        description: "",
        mastery: "unknown",
        necessity: "required",
        targetLevel: "basic",
        assessmentLevel: null,
        status: "open",
        impact: "",
        alternative: "",
        phaseId: null,
        resourceCount: 0,
        availableResourceCount: 0,
        verifiedResourceCount: 0,
      },
    ],
    tasks: [],
    deliverables: [],
    events: [],
    risks: [],
    ...overrides,
  };
}

const WAIT = { timeout: 2000 };

beforeEach(() => {
  vi.clearAllMocks();
  bridge.projectHubListProjects.mockResolvedValue([summary("p-a", "项目 A")]);
  bridge.projectHubGetProject.mockImplementation(async (id: string) => snapshot(id));
  bridge.projectHubCreateProject.mockImplementation(async (input: ProjectHubCreateInput) =>
    snapshot("new", {
      project: summary("new", input.name),
    }),
  );
  bridge.projectHubResourceCandidates.mockResolvedValue([] as ProjectHubResourceCandidate[]);
  bridge.projectHubResourceLinks.mockResolvedValue([] as ProjectHubResourceLink[]);
  bridge.projectHubResourceLink.mockResolvedValue({} as ProjectHubResourceLink);
  bridge.projectHubResourceUnlink.mockResolvedValue(undefined);
  bridge.projectHubResourceValidate.mockResolvedValue({} as ProjectHubResourceLink);
});

afterEach(() => {
  cleanup();
});

describe("项目中枢面板", () => {
  it("加载项目列表并渲染总览", async () => {
    render(<ProjectHubPanel />);
    expect(await screen.findByRole("heading", { name: "项目 A" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /总览/ })).toBeTruthy();
  });

  it("切换项目时使用最新请求的结果，不串数据", async () => {
    bridge.projectHubListProjects.mockResolvedValue([
      summary("p-a", "项目 A"),
      summary("p-b", "项目 B"),
    ]);
    bridge.projectHubGetProject.mockImplementation(async (id: string) => {
      if (id === "p-a") {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return snapshot("p-a");
      }
      return snapshot("p-b");
    });

    const user = userEvent.setup();
    render(<ProjectHubPanel />);
    await screen.findByRole("heading", { name: "项目 A" });

    await user.selectOptions(screen.getByLabelText("选择项目"), "p-b");
    expect(await screen.findByRole("heading", { name: "项目 B" })).toBeTruthy();

    // 迟到的 A 响应不得覆盖当前选择
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.getByRole("heading", { name: "项目 B" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "项目 A" })).toBeNull();
  });

  it("创建项目携带功能草案（标题 + 阶段下标 + 优先级 + 验收标准）", async () => {
    const user = userEvent.setup();
    render(<ProjectHubPanel />);
    await screen.findByRole("heading", { name: "项目 A" });

    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    const textarea = await screen.findByPlaceholderText(/2D Roguelike/);
    await user.type(textarea, "我要写一本科幻小说");
    await user.click(screen.getByRole("button", { name: "开始规划" }));

    const confirm = await screen.findByRole("button", { name: "确认并创建" });
    await user.click(confirm);

    await waitFor(() => expect(bridge.projectHubCreateProject).toHaveBeenCalled(), WAIT);
    const input = bridge.projectHubCreateProject.mock.calls[0][0] as ProjectHubCreateInput;
    expect(input.features?.length ?? 0).toBeGreaterThan(0);
    const feature = input.features?.[0];
    expect(feature?.title).toBeTruthy();
    expect(typeof feature?.phaseIndex).toBe("number");
    expect(["P0", "P1", "P2"]).toContain(feature?.priority);
    expect(input.clientRequestId).toBeTruthy();
  });

  it("同一草案重试复用同一个请求 ID（超时后重试不重复创建）", async () => {
    bridge.projectHubCreateProject
      .mockRejectedValueOnce(new Error("请求超时"))
      .mockImplementation(async (input: ProjectHubCreateInput) =>
        snapshot("new", { project: summary("new", input.name) }),
      );

    const user = userEvent.setup();
    render(<ProjectHubPanel />);
    await screen.findByRole("heading", { name: "项目 A" });

    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    await user.type(await screen.findByPlaceholderText(/2D Roguelike/), "我要写一本科幻小说");
    await user.click(screen.getByRole("button", { name: "开始规划" }));

    const confirm = await screen.findByRole("button", { name: "确认并创建" });
    await user.click(confirm);
    await screen.findByRole("alert");
    expect(bridge.projectHubCreateProject).toHaveBeenCalledTimes(1);
    const firstId = (bridge.projectHubCreateProject.mock.calls[0][0] as ProjectHubCreateInput)
      .clientRequestId;

    await user.click(confirm);
    await waitFor(() => expect(bridge.projectHubCreateProject).toHaveBeenCalledTimes(2), WAIT);
    const secondId = (bridge.projectHubCreateProject.mock.calls[1][0] as ProjectHubCreateInput)
      .clientRequestId;
    expect(secondId).toBe(firstId);
  });

  it("阶段进度按功能完成度展示；里程碑无依据时显示待评估", async () => {
    bridge.projectHubGetProject.mockResolvedValue(
      snapshot("p-a", {
        milestones: [
          {
            id: "m1",
            name: "里程碑",
            description: "",
            targetDate: null,
            phaseId: null,
            sortOrder: 0,
            featureCount: 0,
            completedFeatureCount: 0,
          },
        ],
      }),
    );
    render(<ProjectHubPanel />);
    await screen.findByRole("heading", { name: "项目 A" });

    const metrics = screen.getByText("阶段完成").parentElement as HTMLElement;
    expect(metrics.textContent).toContain("0%");
    const milestoneMetric = screen.getByText("里程碑").parentElement as HTMLElement;
    expect(milestoneMetric.textContent).toContain("待评估");
  });

  it("功能与看板视图展示功能状态", async () => {
    const user = userEvent.setup();
    render(<ProjectHubPanel />);
    await screen.findByRole("heading", { name: "项目 A" });
    await user.click(screen.getByRole("tab", { name: /功能与看板/ }));
    expect(await screen.findByText("功能一")).toBeTruthy();
    expect(screen.getByText(/待开始（1）/)).toBeTruthy();
  });

  it("项目资源视图：绑定与解除关联都走后端命令", async () => {
    const candidate: ProjectHubResourceCandidate = {
      kind: "knowledge",
      id: "kb-1",
      label: "项目资料",
      scope: "global",
      availability: "available",
      detail: "知识库",
    };
    const link: ProjectHubResourceLink = {
      id: "link-1",
      capabilityId: "cap-1",
      capabilityName: "结构设计",
      resourceKind: "knowledge",
      resourceId: "kb-1",
      label: "项目资料",
      availability: "available",
      lastCheckedAt: null,
      createdAt: "2026-11-20T00:00:00Z",
    };
    bridge.projectHubResourceCandidates.mockResolvedValue([candidate]);
    bridge.projectHubResourceLinks.mockResolvedValue([link]);

    const user = userEvent.setup();
    render(<ProjectHubPanel />);
    await screen.findByRole("heading", { name: "项目 A" });
    await user.click(screen.getByRole("tab", { name: /项目资源/ }));

    const linked = await screen.findAllByText("项目资料");
    expect(linked.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /校验可用性/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /关联/ }));
    await waitFor(
      () =>
        expect(bridge.projectHubResourceLink).toHaveBeenCalledWith("p-a", {
          capabilityId: "cap-1",
          resourceKind: "knowledge",
          resourceId: "kb-1",
        }),
      WAIT,
    );

    await user.click(screen.getByRole("button", { name: /解除/ }));
    await waitFor(
      () => expect(bridge.projectHubResourceUnlink).toHaveBeenCalledWith("p-a", "link-1"),
      WAIT,
    );
  });

  it("能力视图区分「没有资源」与「关联但未校验」", async () => {
    const user = userEvent.setup();
    bridge.projectHubGetProject.mockResolvedValue(
      snapshot("p-a", {
        capabilities: [
          {
            ...snapshot("p-a").capabilities[0],
            resourceCount: 2,
            availableResourceCount: 0,
            verifiedResourceCount: 0,
          },
        ],
      }),
    );
    render(<ProjectHubPanel />);
    await screen.findByRole("heading", { name: "项目 A" });
    await user.click(screen.getByRole("tab", { name: /能力/ }));
    const section = await screen.findByText("能力需求与缺口");
    expect(within(section.parentElement as HTMLElement).getByText(/尚未校验可用性/)).toBeTruthy();
  });
});
