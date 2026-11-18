import { describe, expect, it } from "vitest";

import { calculateCapabilityReadiness } from "./capability";
import {
  buildProjectOverview,
  getProjectExecutionState,
  getProjectNextActions,
  validateProjectIntegrity,
} from "./overview";
import { calculateProjectProgress } from "./progress";
import type {
  MilestoneSummary,
  PhaseSummary,
  ProjectDeliverableRecord,
  ProjectResourceLink,
  ProjectSummary,
  ProjectTask,
  WorkspaceSummary,
} from "./types";

const NOW = "2026-11-18T09:00:00.000Z";

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "p1",
    name: "知识库",
    kind: "general",
    lifecycle: "active",
    goal: "整理知识库",
    targetDate: null,
    activePlanId: "plan-1",
    workspaceId: "w1",
    revision: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

function phase(overrides: Partial<PhaseSummary> = {}): PhaseSummary {
  return {
    id: "phase-1",
    title: "准备",
    order: 1,
    status: "active",
    targetDate: null,
    ...overrides,
  };
}

function task(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    projectId: "p1",
    phaseId: "phase-1",
    milestoneId: null,
    title: "整理资料",
    status: "pending",
    priority: "P1",
    dueDate: null,
    capabilityIds: [],
    deliverableIds: [],
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "w1",
    name: "工作空间",
    kind: "general",
    rootPath: "D:/project",
    projectId: "p1",
    moduleIds: [],
    lastOpenedAt: null,
    ...overrides,
  };
}

function deliverable(overrides: Partial<ProjectDeliverableRecord> = {}): ProjectDeliverableRecord {
  return {
    id: "d1",
    projectId: "p1",
    phaseId: "phase-1",
    title: "资料清单",
    path: "docs/list.md",
    status: "planned",
    required: true,
    recordedAt: NOW,
    acceptedAt: null,
    note: "",
    ...overrides,
  };
}

function progress() {
  return calculateProjectProgress({ tasks: [], phases: [], milestones: [], computedAt: NOW });
}

function capability() {
  return calculateCapabilityReadiness([], NOW);
}

describe("getProjectExecutionState", () => {
  it("选中 active 阶段、最早未完成里程碑与最近活动", () => {
    const milestones: MilestoneSummary[] = [
      { id: "m2", title: "第二阶段", targetDate: "2026-12-01", completed: false },
      { id: "m1", title: "第一阶段", targetDate: "2026-11-20", completed: false },
      { id: "m0", title: "已完成", targetDate: "2026-11-01", completed: true },
    ];
    const state = getProjectExecutionState({
      projectId: "p1",
      phases: [phase(), phase({ id: "phase-2", title: "执行", order: 2, status: "blocked" })],
      tasks: [task(), task({ id: "t2", status: "completed" }), task({ id: "t3", dueDate: "2026-11-15" })],
      milestones,
      events: [
        { id: "e1", projectId: "p1", type: "task", title: "更新", occurredAt: "2026-11-17T00:00:00.000Z", sourceId: null },
        { id: "e2", projectId: "p1", type: "task", title: "更早", occurredAt: "2026-11-10T00:00:00.000Z", sourceId: null },
        { id: "e3", projectId: "p2", type: "task", title: "其他项目", occurredAt: "2026-11-18T00:00:00.000Z", sourceId: null },
      ],
      now: NOW,
    });

    expect(state.currentPhaseId).toBe("phase-1");
    expect(state.blockedPhaseIds).toEqual(["phase-2"]);
    expect(state.nextMilestoneId).toBe("m1");
    expect(state.nextMilestoneTitle).toBe("第一阶段");
    expect(state.pendingTaskCount).toBe(2);
    expect(state.overdueTaskCount).toBe(1);
    expect(state.lastActivityAt).toBe("2026-11-17T00:00:00.000Z");
  });

  it("全部完成后当前阶段为空", () => {
    const state = getProjectExecutionState({
      projectId: "p1",
      phases: [phase({ status: "completed" })],
      tasks: [],
      milestones: [],
      events: [],
      now: NOW,
    });
    expect(state.currentPhaseId).toBeNull();
    expect(state.nextMilestoneId).toBeNull();
    expect(state.lastActivityAt).toBeNull();
  });
});

describe("getProjectNextActions", () => {
  it("逾期任务排在最前，最多五条", () => {
    const actions = getProjectNextActions({
      projectId: "p1",
      phases: [phase()],
      tasks: [
        task({ id: "t1", title: "逾期一", dueDate: "2026-11-14" }),
        task({ id: "t2", title: "逾期二", dueDate: "2026-11-16" }),
        task({ id: "t3", title: "阶段任务" }),
      ],
      capability: capability(),
      deliverables: [deliverable()],
      workspace: workspace(),
      now: NOW,
    });

    expect(actions).toHaveLength(4);
    expect(actions[0].title).toContain("逾期一");
    expect(actions[1].title).toContain("逾期二");
    expect(actions[2].title).toContain("阶段任务");
    expect(actions[3].kind).toBe("deliverable");
  });

  it("必需能力缺口给出可执行建议", () => {
    const status = calculateCapabilityReadiness(
      [
        {
          capabilityId: "c1",
          name: "写作",
          category: "human",
          necessity: "required",
          assessmentLevel: "learning",
          libraryMastery: "unknown",
          resource: "unknown",
          phaseId: "phase-1",
          impact: "影响产出",
          alternative: "",
        },
      ],
      NOW,
    );
    const actions = getProjectNextActions({
      projectId: "p1",
      phases: [],
      tasks: [],
      capability: status,
      deliverables: [],
      workspace: workspace(),
      now: NOW,
    });
    expect(actions[0].kind).toBe("capability");
    expect(actions[0].title).toContain("写作");
  });
});

describe("buildProjectOverview", () => {
  it("组合当前阶段、风险、建议、最近交付物与事件，并限制条数", () => {
    const deliverables = Array.from({ length: 6 }, (_, index) =>
      deliverable({ id: `d${index}`, recordedAt: `2026-11-1${index}T00:00:00.000Z` }),
    );
    const events = Array.from({ length: 12 }, (_, index) => ({
      id: `e${index}`,
      projectId: "p1",
      type: "task",
      title: `事件 ${index}`,
      occurredAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      sourceId: null,
    }));

    const overview = buildProjectOverview({
      project: project(),
      projectId: "p1",
      phases: [phase()],
      tasks: [task({ dueDate: "2026-11-14" })],
      milestones: [],
      capability: capability(),
      deliverables,
      workspace: workspace(),
      events,
      progress: progress(),
      stale: false,
      now: NOW,
    });

    expect(overview.currentPhase?.id).toBe("phase-1");
    expect(overview.risks.some((risk) => risk.kind === "overdue")).toBe(true);
    expect(overview.nextActions.length).toBeGreaterThan(0);
    expect(overview.recentDeliverables).toHaveLength(5);
    expect(overview.recentEvents).toHaveLength(10);
    expect(overview.computedAt).toBe(NOW);
  });
});

describe("validateProjectIntegrity", () => {
  it("干净项目通过", () => {
    const report = validateProjectIntegrity({
      project: project(),
      phases: [phase()],
      tasks: [task()],
      capability: capability(),
      deliverables: [deliverable()],
    });
    expect(report.ok).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("缺少生效计划、任务/能力引用不存在阶段时给出警告", () => {
    const report = validateProjectIntegrity({
      project: project({ activePlanId: null }),
      phases: [phase()],
      tasks: [task({ phaseId: "missing" })],
      capability: calculateCapabilityReadiness(
        [
          {
            capabilityId: "c1",
            name: "写作",
            category: "human",
            necessity: "required",
            assessmentLevel: "basic",
            libraryMastery: "unknown",
            resource: "unknown",
            phaseId: "missing",
            impact: "",
            alternative: "",
          },
        ],
        NOW,
      ),
      deliverables: [],
    });
    expect(report.ok).toBe(true);
    expect(report.issues.map((issue) => issue.code).sort()).toEqual([
      "active_plan_missing",
      "capability_phase_missing",
      "task_phase_missing",
    ]);
  });

  it("重复阶段 ID、越界交付物路径、删除仍有共享资源时阻止", () => {
    const links: ProjectResourceLink[] = [
      {
        id: "p1:skill:s1",
        projectId: "p1",
        resource: { kind: "skill", id: "s1", label: "Skill" },
        linkedAt: NOW,
        lastVerifiedAt: null,
        availability: "available",
      },
    ];
    const report = validateProjectIntegrity({
      project: project(),
      phases: [phase(), phase()],
      tasks: [],
      capability: capability(),
      deliverables: [deliverable({ path: "../secret.md" })],
      resourceLinks: links,
      deleting: true,
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "duplicate_phase_id")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "deliverable_path_unsafe")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "shared_resources_in_use")).toBe(true);
  });

  it("删除时没有共享资源引用可以通过", () => {
    const report = validateProjectIntegrity({
      project: project(),
      phases: [phase()],
      tasks: [],
      capability: capability(),
      deliverables: [],
      resourceLinks: [],
      deleting: true,
    });
    expect(report.ok).toBe(true);
  });
});
