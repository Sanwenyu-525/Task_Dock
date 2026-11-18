import { describe, expect, it } from "vitest";

import {
  calculateCapabilityGaps,
  calculateCapabilityReadiness,
  findCapabilityResources,
  recommendCapabilitySolutions,
  resolveCapabilityGap,
} from "./capability";
import type { CapabilityRequirementInput } from "./types";

const NOW = "2026-11-18T00:00:00.000Z";

function requirement(overrides: Partial<CapabilityRequirementInput> = {}): CapabilityRequirementInput {
  return {
    capabilityId: "cap-1",
    name: "长篇写作",
    category: "human",
    necessity: "required",
    assessmentLevel: null,
    libraryMastery: "unknown",
    resource: "unknown",
    phaseId: "phase-1",
    impact: "影响正文产出",
    alternative: "",
    ...overrides,
  };
}

describe("calculateCapabilityReadiness", () => {
  it("没有能力需求时返回待评估，不给百分比", () => {
    const status = calculateCapabilityReadiness([], NOW);
    expect(status.label).toBe("unassessed");
    expect(status.masteryScore).toBeNull();
    expect(status.resourceScore).toBeNull();
    expect(status.assessedCount).toBe(0);
  });

  it("必需能力全部未评估时标记待评估", () => {
    const status = calculateCapabilityReadiness([requirement()], NOW);
    expect(status.label).toBe("unassessed");
    expect(status.unassessedRequired).toBe(1);
  });

  it("掌握度达到基础即视为满足", () => {
    const status = calculateCapabilityReadiness([requirement({ assessmentLevel: "basic" })], NOW);
    expect(status.label).toBe("ready");
    expect(status.lines[0].satisfied).toBe(true);
    expect(status.lines[0].masteryAssessed).toBe(true);
  });

  it("能力缺失且没有可用资源时阻塞", () => {
    const status = calculateCapabilityReadiness(
      [requirement({ assessmentLevel: "none", resource: "unavailable" })],
      NOW,
    );
    expect(status.label).toBe("blocked");
  });

  it("能力缺失但资源可用时仍视为满足", () => {
    const status = calculateCapabilityReadiness(
      [requirement({ assessmentLevel: "none", resource: "available" })],
      NOW,
    );
    expect(status.label).toBe("ready");
  });

  it("学习中且资源未确认时是部分就绪", () => {
    const status = calculateCapabilityReadiness(
      [requirement({ assessmentLevel: "learning", resource: "unknown" })],
      NOW,
    );
    expect(status.label).toBe("partial");
  });

  it("未评估必需能力超过一半时优先标记待评估", () => {
    const status = calculateCapabilityReadiness(
      [
        requirement({ capabilityId: "c1" }),
        requirement({ capabilityId: "c2" }),
        requirement({ capabilityId: "c3" }),
      ],
      NOW,
    );
    expect(status.label).toBe("unassessed");
  });

  it("恰好一半未评估时不直接判为待评估", () => {
    const status = calculateCapabilityReadiness(
      [
        requirement({ capabilityId: "c1" }),
        requirement({ capabilityId: "c2", assessmentLevel: "basic" }),
      ],
      NOW,
    );
    expect(status.label).toBe("partial");
    expect(status.assessedRequired).toBe(1);
    expect(status.unassessedRequired).toBe(1);
  });

  it("能力库掌握度只作参考，不算项目实测", () => {
    const status = calculateCapabilityReadiness(
      [requirement({ libraryMastery: "expert", resource: "unknown" })],
      NOW,
    );
    expect(status.lines[0].mastery).toBe("expert");
    expect(status.lines[0].masteryAssessed).toBe(false);
  });

  it("掌握度分数与资源分数分开计算，并按必需程度加权", () => {
    const status = calculateCapabilityReadiness(
      [
        requirement({ capabilityId: "c1", assessmentLevel: "expert", resource: "available" }),
        requirement({
          capabilityId: "c2",
          necessity: "optional",
          assessmentLevel: "none",
          resource: "unavailable",
        }),
      ],
      NOW,
    );
    expect(status.masteryScore).toBe(75);
    expect(status.resourceScore).toBe(75);
  });

  it("掌握度为 0 时分数为 0，而不是 null", () => {
    const status = calculateCapabilityReadiness([requirement({ assessmentLevel: "none" })], NOW);
    expect(status.masteryScore).toBe(0);
    expect(status.resourceScore).toBeNull();
  });
});

describe("calculateCapabilityGaps", () => {
  it("只返回未满足项，并给出可执行方案", () => {
    const status = calculateCapabilityReadiness(
      [
        requirement({ capabilityId: "c1", assessmentLevel: "learning", resource: "unknown", alternative: "拆成短篇" }),
        requirement({ capabilityId: "c2", assessmentLevel: "basic", resource: "available" }),
      ],
      NOW,
    );

    const gaps = calculateCapabilityGaps(status, [
      { kind: "skill", id: "skill-writing", label: "长篇写作 Skill", availability: "available" },
    ]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].capabilityId).toBe("c1");
    expect(gaps[0].reason).toBe("missing");
    expect(gaps[0].solutions.map((item) => item.kind)).toEqual([
      "learn",
      "resource",
      "alternative",
      "descope",
      "accept",
    ]);
    expect(gaps[0].solutions[1].target).toEqual({ kind: "skill", id: "skill-writing" });
  });

  it("可选能力缺口不推荐降范围", () => {
    const status = calculateCapabilityReadiness(
      [requirement({ necessity: "optional", assessmentLevel: "none", resource: "unavailable" })],
      NOW,
    );
    const gap = calculateCapabilityGaps(status)[0];
    expect(gap.solutions.some((item) => item.kind === "descope")).toBe(false);
  });
});

describe("资源筛选与决议", () => {
  it("按资源类型筛选候选", () => {
    const resources = [
      { kind: "skill" as const, id: "s1", label: "Skill", availability: "available" as const },
      { kind: "knowledge" as const, id: "k1", label: "知识库", availability: "partial" as const },
    ];
    expect(findCapabilityResources(resources, ["skill"])).toHaveLength(1);
  });

  it("没有候选资源时不编造资源方案", () => {
    const gap = calculateCapabilityGaps(
      calculateCapabilityReadiness([requirement({ assessmentLevel: "none", resource: "unavailable" })], NOW),
    )[0];
    expect(recommendCapabilitySolutions(gap, []).some((item) => item.kind === "resource")).toBe(false);
  });

  it("记录缺口处理决定时校验入参", () => {
    expect(() =>
      resolveCapabilityGap("", "cap-1", { kind: "learn", label: "学习", rationale: "", target: null }),
    ).toThrow("projectId 不能为空");
    expect(
      resolveCapabilityGap("p1", "cap-1", { kind: "learn", label: "学习", rationale: "", target: null }),
    ).toMatchObject({ solutionKind: "learn", status: "applied" });
  });
});
