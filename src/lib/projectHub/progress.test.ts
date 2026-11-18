import { describe, expect, it } from "vitest";

import {
  calculateMilestoneProgress,
  calculatePhaseProgress,
  calculateProjectProgress,
  calculateTaskProgress,
} from "./progress";

describe("calculateTaskProgress", () => {
  it("没有任务时为 null，不显示 0%", () => {
    const metric = calculateTaskProgress([]);
    expect(metric.total).toBe(0);
    expect(metric.percent).toBeNull();
  });

  it("按任务状态计算", () => {
    const metric = calculateTaskProgress([
      { id: "t1", status: "completed", phaseId: "p1" },
      { id: "t2", status: "pending", phaseId: "p1" },
      { id: "t3", status: "completed", phaseId: null },
    ]);
    expect(metric.completed).toBe(2);
    expect(metric.total).toBe(3);
    expect(metric.percent).toBe(66.7);
  });
});

describe("calculatePhaseProgress", () => {
  it("功能与必需交付物一起计入，可选交付物不计入", () => {
    const metric = calculatePhaseProgress({
      id: "p1",
      title: "阶段",
      features: [
        { id: "f1", status: "completed" },
        { id: "f2", status: "in_progress" },
      ],
      deliverables: [
        { id: "d1", status: "accepted", required: true },
        { id: "d2", status: "planned", required: false },
      ],
    });
    expect(metric.total).toBe(3);
    expect(metric.completed).toBe(2);
    expect(metric.percent).toBe(66.7);
  });

  it("空阶段返回 null", () => {
    expect(calculatePhaseProgress({ id: "p1", title: "空", features: [], deliverables: [] }).percent).toBeNull();
  });
});

describe("calculateMilestoneProgress", () => {
  it("没有里程碑时为 null", () => {
    const metric = calculateMilestoneProgress([]);
    expect(metric.percent).toBeNull();
  });

  it("只有显式 completed 才算完成", () => {
    const metric = calculateMilestoneProgress([
      { id: "m1", completesAt: "2026-12-01", completed: true },
      { id: "m2", completesAt: null, completed: false },
    ]);
    expect(metric.percent).toBe(50);
  });
});

describe("calculateProjectProgress", () => {
  it("整体进度取有数据阶段的算术平均，而不是任务完成率", () => {
    const snapshot = calculateProjectProgress({
      tasks: [
        { id: "t1", status: "completed", phaseId: "p1" },
        { id: "t2", status: "pending", phaseId: "p2" },
      ],
      phases: [
        {
          id: "p1",
          title: "阶段一",
          features: [{ id: "f1", status: "completed" }],
          deliverables: [],
        },
        {
          id: "p2",
          title: "阶段二",
          features: [{ id: "f2", status: "planned" }],
          deliverables: [],
        },
      ],
      milestones: [],
      computedAt: "2026-11-18T00:00:00.000Z",
    });

    expect(snapshot.tasks.percent).toBe(50);
    expect(snapshot.phases.percent).toBe(50);
    expect(snapshot.overall.percent).toBe(50);
    expect(snapshot.overall.note).toContain("2 个阶段");
    expect(snapshot.computedAt).toBe("2026-11-18T00:00:00.000Z");
  });

  it("阶段完成率按整阶段计，整体按各阶段内部完成率平均", () => {
    const snapshot = calculateProjectProgress({
      tasks: [],
      phases: [
        {
          id: "p1",
          title: "半成品阶段",
          features: [
            { id: "f1", status: "completed" },
            { id: "f2", status: "planned" },
          ],
          deliverables: [],
        },
        {
          id: "p2",
          title: "完成阶段",
          features: [{ id: "f3", status: "completed" }],
          deliverables: [],
        },
      ],
      milestones: [],
    });

    expect(snapshot.phases.completed).toBe(1);
    expect(snapshot.phases.total).toBe(2);
    expect(snapshot.phases.percent).toBe(50);
    expect(snapshot.overall.percent).toBe(75);
  });

  it("没有阶段数据时回退任务完成率并标注来源", () => {
    const snapshot = calculateProjectProgress({
      tasks: [{ id: "t1", status: "completed", phaseId: null }],
      phases: [],
      milestones: [],
    });
    expect(snapshot.phases.percent).toBeNull();
    expect(snapshot.overall.percent).toBe(100);
    expect(snapshot.overall.note).toContain("回退任务完成率");
  });

  it("完全无数据时整体进度为 null", () => {
    const snapshot = calculateProjectProgress({ tasks: [], phases: [], milestones: [] });
    expect(snapshot.overall.percent).toBeNull();
  });

  it("声明不计入整体的阶段被排除", () => {
    const snapshot = calculateProjectProgress({
      tasks: [],
      phases: [
        { id: "p1", title: "主体", features: [{ id: "f1", status: "completed" }], deliverables: [] },
        {
          id: "p2",
          title: "可选",
          features: [{ id: "f2", status: "planned" }],
          deliverables: [],
          countsTowardOverall: false,
        },
      ],
      milestones: [],
    });
    expect(snapshot.overall.percent).toBe(100);
    expect(snapshot.overall.note).toContain("1 个阶段");
  });
});
