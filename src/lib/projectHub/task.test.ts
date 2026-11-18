import { describe, expect, it } from "vitest";

import { calculateCapabilityReadiness } from "./capability";
import {
  createProjectTasks,
  detectProjectExecutionRisks,
  getProjectTasks,
  linkTaskToCapability,
  linkTaskToPhase,
} from "./task";
import type { PhaseSummary, ProjectTask, TaskDraft, WorkspaceSummary } from "./types";

function task(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    projectId: "p1",
    phaseId: "phase-1",
    milestoneId: null,
    title: "写大纲",
    status: "pending",
    priority: "P1",
    dueDate: null,
    capabilityIds: [],
    deliverableIds: [],
    ...overrides,
  };
}

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    id: "d1",
    title: "写大纲",
    phaseId: "phase-1",
    priority: "P1",
    dueDate: null,
    capabilityKeys: [],
    source: "template",
    manualFields: [],
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

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "w1",
    name: "工作空间",
    kind: "general",
    rootPath: "D:/project",
    projectId: "p1",
    moduleIds: ["overview"],
    lastOpenedAt: null,
    ...overrides,
  };
}

function capability() {
  return calculateCapabilityReadiness([], "2026-11-18T00:00:00.000Z");
}

describe("createProjectTasks", () => {
  it("跳过同阶段同名任务，保留不同阶段同名任务", () => {
    const plan = createProjectTasks(
      "p1",
      [draft(), draft({ id: "d2", title: " 写大纲 " }), draft({ id: "d3", phaseId: "phase-2" })],
      [],
      { phaseIds: ["phase-1", "phase-2"] },
    );
    expect(plan.accepted).toHaveLength(2);
    expect(plan.accepted.map((item) => item.phaseId)).toEqual(["phase-1", "phase-2"]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toContain("同名");
  });

  it("只与同项目任务去重，不被其他项目同名任务阻塞", () => {
    const plan = createProjectTasks(
      "p1",
      [draft()],
      [
        { id: "old", projectId: "p2", phaseId: "phase-1", title: "写大纲" },
        { id: "global", projectId: null, phaseId: null, title: "写大纲" },
      ],
      { phaseIds: ["phase-1"] },
    );
    expect(plan.accepted).toHaveLength(1);
  });

  it("跳过空标题与不存在的阶段", () => {
    const plan = createProjectTasks(
      "p1",
      [draft({ title: "  " }), draft({ id: "d2", phaseId: "missing" })],
      [],
      { phaseIds: ["phase-1"] },
    );
    expect(plan.accepted).toHaveLength(0);
    expect(plan.skipped.map((item) => item.reason)).toEqual(["任务标题为空", "阶段不存在：missing"]);
  });
});

describe("getProjectTasks", () => {
  it("按项目、阶段、状态与能力过滤", () => {
    const tasks = [
      task({ id: "t1", capabilityIds: ["c1"] }),
      task({ id: "t2", phaseId: "phase-2", status: "completed" }),
      task({ id: "t3", projectId: "p2" }),
    ];
    expect(getProjectTasks(tasks, "p1")).toHaveLength(2);
    expect(getProjectTasks(tasks, "p1", { phaseId: "phase-2" })).toHaveLength(1);
    expect(getProjectTasks(tasks, "p1", { status: "completed" })).toHaveLength(1);
    expect(getProjectTasks(tasks, "p1", { capabilityId: "c1" })).toHaveLength(1);
  });
});

describe("任务关联", () => {
  it("拒绝跨项目的任务/阶段关联", () => {
    expect(() => linkTaskToPhase(task({ projectId: "p2" }), { ...phase(), projectId: "p1" }, "p1")).toThrow(
      "任务不属于该项目",
    );
    expect(() => linkTaskToPhase(task(), { ...phase(), projectId: "p2" }, "p1")).toThrow("阶段不属于该项目");
  });

  it("同项目关联返回链接，能力 ID 必须非空", () => {
    expect(linkTaskToPhase(task(), { ...phase(), projectId: "p1" }, "p1")).toEqual({
      taskId: "t1",
      projectId: "p1",
      phaseId: "phase-1",
    });
    expect(linkTaskToCapability({ id: "t1" }, "c1")).toEqual({ taskId: "t1", capabilityId: "c1" });
    expect(() => linkTaskToCapability({ id: "t1" }, " ")).toThrow("capabilityId 不能为空");
  });
});

describe("detectProjectExecutionRisks", () => {
  it("逾期超过三天判为高，并保留最早任务", () => {
    const risks = detectProjectExecutionRisks({
      projectId: "p1",
      now: "2026-11-18T09:00:00.000Z",
      tasks: [
        task({ id: "t1", title: "逾期四天", dueDate: "2026-11-14" }),
        task({ id: "t2", title: "逾期一天", dueDate: "2026-11-17" }),
      ],
      phases: [phase()],
      milestones: [],
      capability: capability(),
      workspace: workspace(),
      nextActions: [{ id: "a", kind: "task", title: "做", detail: "", targetId: "t1" }],
    });
    const overdue = risks.find((risk) => risk.kind === "overdue");
    expect(overdue?.severity).toBe("high");
    expect(overdue?.sourceId).toBe("t1");
    expect(overdue?.title).toContain("2 个任务");
  });

  it("阻塞阶段与必需能力缺口判为高", () => {
    const capabilityStatus = calculateCapabilityReadiness(
      [
        {
          capabilityId: "c1",
          name: "写作",
          category: "human",
          necessity: "required",
          assessmentLevel: "none",
          libraryMastery: "unknown",
          resource: "unavailable",
          phaseId: "phase-1",
          impact: "",
          alternative: "",
        },
      ],
      "2026-11-18T00:00:00.000Z",
    );

    const risks = detectProjectExecutionRisks({
      projectId: "p1",
      now: "2026-11-18T09:00:00.000Z",
      tasks: [],
      phases: [phase({ status: "blocked" })],
      milestones: [],
      capability: capabilityStatus,
      workspace: workspace(),
      nextActions: [{ id: "a", kind: "task", title: "做", detail: "", targetId: "t1" }],
    });

    expect(risks.find((risk) => risk.kind === "blocked_phase")?.severity).toBe("high");
    expect(risks.find((risk) => risk.kind === "capability_gap")?.severity).toBe("high");
  });

  it("缺少工作空间根目录时给出低风险提示", () => {
    const risks = detectProjectExecutionRisks({
      projectId: "p1",
      now: "2026-11-18T09:00:00.000Z",
      tasks: [],
      phases: [],
      milestones: [],
      capability: capability(),
      workspace: workspace({ rootPath: null }),
      nextActions: [{ id: "a", kind: "task", title: "做", detail: "", targetId: "t1" }],
    });
    expect(risks.find((risk) => risk.kind === "missing_workspace")?.severity).toBe("low");
  });

  it("干净项目不产生风险", () => {
    const risks = detectProjectExecutionRisks({
      projectId: "p1",
      now: "2026-11-18T09:00:00.000Z",
      tasks: [task({ status: "completed", dueDate: "2026-11-01" })],
      phases: [phase({ status: "completed" })],
      milestones: [],
      capability: capability(),
      workspace: workspace(),
      nextActions: [{ id: "a", kind: "task", title: "做", detail: "", targetId: "t1" }],
    });
    expect(risks).toHaveLength(0);
  });
});
