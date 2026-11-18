import { describe, expect, it } from "vitest";

import { calculateCapabilityReadiness } from "./capability";
import { calculateProjectProgress } from "./progress";
import {
  getProjectDeliverables,
  getWorkspaceProjectContext,
  linkWorkspaceToProject,
  normalizeProjectPath,
  recordProjectDeliverable,
  syncWorkspaceDeliverables,
  unlinkWorkspaceFromProject,
} from "./workspace";
import type {
  MilestoneSummary,
  PhaseSummary,
  ProjectDeliverableRecord,
  ProjectSummary,
  ProjectTask,
  WorkspaceLink,
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

describe("normalizeProjectPath", () => {
  it("拒绝上级目录与空路径", () => {
    expect(() => normalizeProjectPath("../secret.md")).toThrow("上级目录");
    expect(() => normalizeProjectPath("  ")).toThrow("不能为空");
  });

  it("相对路径正常化，绝对路径必须在根目录内", () => {
    expect(normalizeProjectPath("docs\\list.md")).toBe("docs/list.md");
    expect(normalizeProjectPath("D:\\project\\docs\\list.md", "D:/project")).toBe("D:/project/docs/list.md");
    expect(() => normalizeProjectPath("D:/other/list.md", "D:/project")).toThrow("不在项目根目录内");
    expect(() => normalizeProjectPath("D:/project/list.md", null)).toThrow("无法校验绝对路径");
  });
});

describe("linkWorkspaceToProject", () => {
  it("重复关联返回既有链接", () => {
    const existing: WorkspaceLink[] = [{ projectId: "p1", workspaceId: "w1", linkedAt: NOW }];
    const link = linkWorkspaceToProject("p1", workspace(), existing, "2026-11-19T00:00:00.000Z");
    expect(link).toBe(existing[0]);
  });

  it("拒绝把已属于其他项目的工作空间绑定过来", () => {
    expect(() => linkWorkspaceToProject("p1", workspace({ projectId: "p2" }), [], NOW)).toThrow(
      "工作空间已关联其他项目",
    );
  });

  it("解除关联只清链接，不删除工作空间", () => {
    const links: WorkspaceLink[] = [{ projectId: "p1", workspaceId: "w1", linkedAt: NOW }];
    const result = unlinkWorkspaceFromProject("p1", workspace(), links);
    expect(result.workspace.id).toBe("w1");
    expect(result.workspace.projectId).toBeNull();
    expect(result.links).toHaveLength(0);
    expect(result.removed?.workspaceId).toBe("w1");
  });

  it("解除不存在的关联是幂等的", () => {
    const result = unlinkWorkspaceFromProject("p1", workspace({ projectId: null }), []);
    expect(result.removed).toBeNull();
    expect(result.workspace.projectId).toBeNull();
  });
});

describe("交付物记录与同步", () => {
  it("记录交付物默认是 planned，不会自动验收", () => {
    const record = recordProjectDeliverable(
      { projectId: "p1", phaseId: "phase-1", title: "资料清单", path: "docs\\list.md", required: true, note: "" },
      { id: "d1", rootPath: "D:/project", now: NOW },
    );
    expect(record.status).toBe("planned");
    expect(record.path).toBe("docs/list.md");
    expect(record.acceptedAt).toBeNull();
  });

  it("拒绝空标题与越界绝对路径", () => {
    expect(() =>
      recordProjectDeliverable(
        { projectId: "p1", phaseId: null, title: " ", path: "a.md", required: false, note: "" },
        { id: "d1" },
      ),
    ).toThrow("名称不能为空");
    expect(() =>
      recordProjectDeliverable(
        { projectId: "p1", phaseId: null, title: "越界", path: "D:/other/a.md", required: false, note: "" },
        { id: "d1", rootPath: "D:/project" },
      ),
    ).toThrow("不在项目根目录内");
  });

  it("文件存在只把 planned 推进到 produced，并明确不重算规划", () => {
    const deliverables = [deliverable(), deliverable({ id: "d2", path: "docs/missing.md" })];
    const result = syncWorkspaceDeliverables(
      "p1",
      deliverables,
      [
        { path: "docs\\list.md", exists: true, modifiedAt: NOW },
        { path: "docs/missing.md", exists: false, modifiedAt: null },
      ],
      "D:/project",
    );
    expect(result.produced).toEqual(["docs/list.md"]);
    expect(result.missing).toEqual(["docs/missing.md"]);
    expect(result.recomputePlan).toBe(false);
  });

  it("已验收交付物不因文件变化回退", () => {
    const result = syncWorkspaceDeliverables(
      "p1",
      [deliverable({ status: "accepted" })],
      [{ path: "docs/list.md", exists: false, modifiedAt: null }],
    );
    expect(result.unchanged).toEqual(["docs/list.md"]);
  });

  it("按项目与状态查询交付物", () => {
    const list = [deliverable(), deliverable({ id: "d2", status: "accepted" }), deliverable({ id: "d3", projectId: "p2" })];
    expect(getProjectDeliverables(list, "p1")).toHaveLength(2);
    expect(getProjectDeliverables(list, "p1", "accepted")).toHaveLength(1);
  });
});

describe("getWorkspaceProjectContext", () => {
  it("组装当前阶段、任务计数、能力、里程碑与交付物", () => {
    const milestones: MilestoneSummary[] = [
      { id: "m1", title: "准备完成", targetDate: null, completed: false },
    ];
    const progress = calculateProjectProgress({
      tasks: [{ id: "t1", status: "pending", phaseId: "phase-1" }],
      phases: [],
      milestones: [],
      computedAt: NOW,
    });

    const context = getWorkspaceProjectContext({
      project: project(),
      phases: [phase(), phase({ id: "phase-2", title: "执行", order: 2, status: "pending" })],
      tasks: [
        task(),
        task({ id: "t2", dueDate: "2026-11-16" }),
        task({ id: "t3", projectId: "p2" }),
      ],
      capability: calculateCapabilityReadiness([], NOW),
      milestones,
      deliverables: [deliverable(), deliverable({ id: "d2", projectId: "p2" })],
      progress,
      stale: false,
      now: NOW,
    });

    expect(context.currentPhase?.id).toBe("phase-1");
    expect(context.tasks).toEqual({ total: 2, pending: 2, overdue: 1 });
    expect(context.deliverables).toHaveLength(1);
    expect(context.milestones).toHaveLength(1);
    expect(context.stale).toBe(false);
  });

  it("没有进行中阶段时回退到首个未完成阶段", () => {
    const context = getWorkspaceProjectContext({
      project: project(),
      phases: [
        phase({ status: "completed" }),
        phase({ id: "phase-2", title: "执行", order: 2, status: "pending" }),
      ],
      tasks: [],
      capability: calculateCapabilityReadiness([], NOW),
      milestones: [],
      deliverables: [],
      progress: calculateProjectProgress({ tasks: [], phases: [], milestones: [], computedAt: NOW }),
      stale: true,
      now: NOW,
    });
    expect(context.currentPhase?.id).toBe("phase-2");
    expect(context.stale).toBe(true);
  });
});
