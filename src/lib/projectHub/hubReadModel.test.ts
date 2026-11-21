/**
 * 项目中枢读模型口径测试（纯函数）。
 *
 * 锁定 `docs/project-hub/02-架构设计.md` §4.1 的四项进度定义：
 * - 阶段完成 = 功能与必需交付物全部完成（不是「任务都完成」）；
 * - 全部阶段完成时当前阶段为 null（不回退到第一个阶段）；
 * - 里程碑完成率没有可判定依据时为 null；
 * - 「没有资源」与「资源未评估」必须区分。
 */

import { describe, expect, it } from "vitest";
import {
  buildCapabilityInput,
  buildPhaseSummaries,
  buildProgressInput,
  capabilityResourceAvailability,
  currentPhaseOf,
  type HubSnapshotLike,
} from "./hubReadModel";
import { calculateProjectProgress } from "./progress";

function snapshot(overrides: Partial<HubSnapshotLike> = {}): HubSnapshotLike {
  return {
    planId: "plan-1",
    phases: [
      {
        id: "p1",
        name: "世界观",
        description: "",
        targetDate: null,
        startDate: null,
        sortOrder: 0,
        taskCount: 0,
        completedTaskCount: 0,
        featureCount: 2,
        completedFeatureCount: 0,
      },
      {
        id: "p2",
        name: "人物",
        description: "",
        targetDate: null,
        startDate: null,
        sortOrder: 1,
        taskCount: 0,
        completedTaskCount: 0,
        featureCount: 1,
        completedFeatureCount: 0,
      },
    ],
    features: [
      { id: "f1", title: "设定集", status: "completed", milestoneId: "p1", priority: "P0" },
      { id: "f2", title: "地理", status: "planned", milestoneId: "p1", priority: "P1" },
      { id: "f3", title: "主角", status: "planned", milestoneId: "p2", priority: "P1" },
    ],
    tasks: [],
    deliverables: [],
    milestones: [],
    capabilities: [],
    ...overrides,
  };
}

describe("阶段状态与当前阶段", () => {
  it("全部阶段完成时当前阶段为 null（不再回退到第一个阶段）", () => {
    const done = snapshot({
      features: [
        { id: "f1", title: "a", status: "completed", milestoneId: "p1", priority: "P0" },
        { id: "f2", title: "b", status: "completed", milestoneId: "p1", priority: "P0" },
        { id: "f3", title: "c", status: "completed", milestoneId: "p2", priority: "P0" },
      ],
    });
    expect(currentPhaseOf(done)).toBeNull();
    expect(buildPhaseSummaries(done).every((phase) => phase.status === "completed")).toBe(true);
  });

  it("第一个未完成阶段是当前阶段，其余为待开始", () => {
    const summaries = buildPhaseSummaries(snapshot());
    expect(summaries.map((phase) => phase.status)).toEqual(["active", "pending"]);
    expect(currentPhaseOf(snapshot())?.id).toBe("p1");
  });

  it("阶段没有功能也没有任务时是待评估，不是 0%", () => {
    const empty = snapshot({
      phases: [
        {
          id: "p1",
          name: "空阶段",
          description: "",
          targetDate: null,
          startDate: null,
          sortOrder: 0,
          taskCount: 0,
          completedTaskCount: 0,
          featureCount: 0,
          completedFeatureCount: 0,
        },
      ],
      features: [],
    });
    const progress = calculateProjectProgress(buildProgressInput(empty));
    expect(progress.phases.percent).toBeNull();
    expect(progress.overall.percent).toBeNull();
  });
});

describe("四项进度口径", () => {
  it("阶段完成率按功能计算，任务完成不影响阶段完成", () => {
    const data = snapshot({
      tasks: [{ id: "t1", title: "任务", status: "completed", dueAt: null, phaseId: "p1" }],
    });
    const progress = calculateProjectProgress(buildProgressInput(data));
    expect(progress.tasks.percent).toBe(100);
    // p1 两项功能只完成一项 → 阶段未完成
    expect(progress.phases.percent).toBe(0);
  });

  it("整体进度按阶段等权平均，并标注来源", () => {
    const data = snapshot({
      features: [
        { id: "f1", title: "a", status: "completed", milestoneId: "p1", priority: "P0" },
        { id: "f2", title: "b", status: "completed", milestoneId: "p1", priority: "P0" },
        { id: "f3", title: "c", status: "planned", milestoneId: "p2", priority: "P0" },
      ],
    });
    const progress = calculateProjectProgress(buildProgressInput(data));
    expect(progress.phases.percent).toBe(50);
    expect(progress.overall.percent).toBe(50);
    expect(progress.overall.note).toContain("算术平均");
  });

  it("里程碑没有绑定功能时完成率为 null（不编造）", () => {
    const data = snapshot({
      milestones: [{ id: "m1", name: "里程碑", targetDate: null, featureCount: 0, completedFeatureCount: 0 }],
    });
    const progress = calculateProjectProgress(buildProgressInput(data));
    expect(progress.milestones.percent).toBeNull();
  });

  it("里程碑绑定功能全部完成时计入完成率", () => {
    const data = snapshot({
      milestones: [{ id: "m1", name: "里程碑", targetDate: null, featureCount: 2, completedFeatureCount: 2 }],
    });
    const progress = calculateProjectProgress(buildProgressInput(data));
    expect(progress.milestones.percent).toBe(100);
  });
});

describe("资源可用性", () => {
  it("没有关联资源是事实：unavailable", () => {
    expect(
      capabilityResourceAvailability({
        resourceCount: 0,
        availableResourceCount: 0,
        verifiedResourceCount: 0,
      }),
    ).toBe("unavailable");
  });

  it("关联了但从未校验是 unknown，不是不可用", () => {
    expect(
      capabilityResourceAvailability({
        resourceCount: 2,
        availableResourceCount: 0,
        verifiedResourceCount: 0,
      }),
    ).toBe("unknown");
  });

  it("全部可用为 available，部分可用为 partial", () => {
    expect(
      capabilityResourceAvailability({
        resourceCount: 2,
        availableResourceCount: 2,
        verifiedResourceCount: 2,
      }),
    ).toBe("available");
    expect(
      capabilityResourceAvailability({
        resourceCount: 2,
        availableResourceCount: 1,
        verifiedResourceCount: 2,
      }),
    ).toBe("partial");
  });

  it("能力准备度输入区分「无资源」与「未评估」", () => {
    const data = snapshot({
      capabilities: [
        {
          capabilityId: "c1",
          name: "结构设计",
          category: "human",
          necessity: "required",
          targetLevel: "basic",
          assessmentLevel: null,
          mastery: "unknown",
          resourceCount: 0,
          availableResourceCount: 0,
          verifiedResourceCount: 0,
          impact: "",
          alternative: "",
          phaseId: null,
        },
      ],
    });
    const input = buildCapabilityInput(data);
    expect(input[0].resource).toBe("unavailable");
    expect(input[0].assessmentLevel).toBeNull();
  });
});
