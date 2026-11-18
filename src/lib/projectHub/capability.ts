/**
 * 能力准备度与缺口分析。
 *
 * 两条独立指标：
 * - 掌握度：项目实测优先，其次能力库；`unknown` 不进入分母；
 * - 资源可用度：Skill / MCP / Agent / 工具等是否真的可调用。
 *
 * 禁止用单一百分比掩盖能力缺失；数据不足时返回 `unassessed`。
 */

import type {
  CapabilityGap,
  CapabilityGapResolution,
  CapabilityLine,
  CapabilityRequirementInput,
  CapabilitySolution,
  CapabilityStatusResult,
  Mastery,
  ResourceAvailability,
  ResourceCandidate,
  ResourceKind,
  SolutionKind,
} from "./types";

const MASTERY_VALUE: Record<Exclude<Mastery, "unknown">, number> = {
  expert: 3,
  proficient: 2.5,
  basic: 2,
  learning: 1,
  none: 0,
};

const AVAILABILITY_VALUE: Record<Exclude<ResourceAvailability, "unknown">, number> = {
  available: 1,
  partial: 0.6,
  unavailable: 0,
};

const NECESSITY_WEIGHT: Record<CapabilityRequirementInput["necessity"], number> = {
  required: 3,
  recommended: 2,
  optional: 1,
};

function resolveMastery(requirement: CapabilityRequirementInput): { mastery: Mastery; assessed: boolean } {
  if (requirement.assessmentLevel && requirement.assessmentLevel !== "unknown") {
    return { mastery: requirement.assessmentLevel, assessed: true };
  }
  if (requirement.libraryMastery !== "unknown") {
    return { mastery: requirement.libraryMastery, assessed: false };
  }
  return { mastery: "unknown", assessed: false };
}

function isMasterySufficient(mastery: Mastery): boolean {
  return mastery === "expert" || mastery === "proficient" || mastery === "basic";
}

function lineSatisfied(mastery: Mastery, resource: ResourceAvailability): boolean {
  return isMasterySufficient(mastery) || resource === "available";
}

/**
 * 计算能力准备度。`computedAt` 可注入，便于测试稳定。
 */
export function calculateCapabilityReadiness(
  requirements: CapabilityRequirementInput[],
  computedAt: string = new Date().toISOString(),
): CapabilityStatusResult {
  const lines: CapabilityLine[] = requirements.map((requirement) => {
    const resolved = resolveMastery(requirement);
    return {
      capabilityId: requirement.capabilityId,
      name: requirement.name,
      category: requirement.category,
      necessity: requirement.necessity,
      phaseId: requirement.phaseId,
      mastery: resolved.mastery,
      masteryAssessed: resolved.assessed,
      resource: requirement.resource,
      impact: requirement.impact,
      alternative: requirement.alternative,
      satisfied: lineSatisfied(resolved.mastery, requirement.resource),
    };
  });

  let masteryWeight = 0;
  let masterySum = 0;
  let resourceWeight = 0;
  let resourceSum = 0;
  let assessedCount = 0;

  for (const requirement of requirements) {
    const weight = NECESSITY_WEIGHT[requirement.necessity];
    if (requirement.assessmentLevel !== null || requirement.libraryMastery !== "unknown") assessedCount += 1;

    const resolved = resolveMastery(requirement);
    if (resolved.mastery !== "unknown") {
      masteryWeight += weight;
      masterySum += weight * (MASTERY_VALUE[resolved.mastery] / 3);
    }
    if (requirement.resource !== "unknown") {
      resourceWeight += weight;
      resourceSum += weight * AVAILABILITY_VALUE[requirement.resource];
    }
  }

  const masteryScore = masteryWeight > 0 ? Math.round((masterySum / masteryWeight) * 1000) / 10 : null;
  const resourceScore = resourceWeight > 0 ? Math.round((resourceSum / resourceWeight) * 1000) / 10 : null;

  const requiredLines = lines.filter((line) => line.necessity === "required");
  const requiredTotal = requiredLines.length;
  const unassessedRequired = requiredLines.filter((line) => line.mastery === "unknown").length;
  const assessedRequired = requiredTotal - unassessedRequired;

  let label: CapabilityStatusResult["label"];
  if (lines.length === 0 || assessedCount === 0) {
    label = "unassessed";
  } else if (requiredTotal > 0 && unassessedRequired * 2 > requiredTotal) {
    label = "unassessed";
  } else if (requiredLines.some((line) => line.mastery === "none" && (line.resource === "unavailable" || line.resource === "unknown"))) {
    label = "blocked";
  } else if (requiredTotal === 0 || requiredLines.every((line) => line.satisfied)) {
    label = "ready";
  } else {
    label = "partial";
  }

  return {
    masteryScore,
    resourceScore,
    assessedCount,
    unassessedCount: lines.length - assessedCount,
    assessedRequired,
    unassessedRequired,
    label,
    lines,
    computedAt,
  };
}

function gapReason(line: CapabilityLine): CapabilityGap["reason"] {
  if (line.mastery === "unknown") return "unassessed";
  if (isMasterySufficient(line.mastery)) return "resource";
  return "missing";
}

const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  knowledge: "知识库",
  skill: "Skill",
  mcp: "MCP 工具",
  agent: "Agent",
  tool: "工具",
  template: "模板",
  workflow: "工作流",
};

/**
 * 生成能力缺口列表。只包含未满足的条目。
 */
export function calculateCapabilityGaps(
  status: CapabilityStatusResult,
  resources: ResourceCandidate[] = [],
): CapabilityGap[] {
  return status.lines
    .filter((line) => !line.satisfied)
    .map((line) => ({
      capabilityId: line.capabilityId,
      name: line.name,
      necessity: line.necessity,
      phaseId: line.phaseId,
      mastery: line.mastery,
      resource: line.resource,
      reason: gapReason(line),
      impact: line.impact,
      alternative: line.alternative,
      solutions: recommendCapabilitySolutions(
        {
          capabilityId: line.capabilityId,
          name: line.name,
          necessity: line.necessity,
          phaseId: line.phaseId,
          mastery: line.mastery,
          resource: line.resource,
          reason: gapReason(line),
          impact: line.impact,
          alternative: line.alternative,
          solutions: [],
        },
        resources.filter((resource) => resource.availability === "available" || resource.availability === "partial"),
      ),
    }));
}

/** 只返回与能力相关的可用资源；没有候选时返回空数组，不编造资源。 */
export function findCapabilityResources(
  resources: ResourceCandidate[],
  kinds: ResourceKind[] = ["knowledge", "skill", "mcp", "agent", "tool", "template", "workflow"],
): ResourceCandidate[] {
  return resources.filter((resource) => kinds.includes(resource.kind));
}

function solution(
  kind: SolutionKind,
  label: string,
  rationale: string,
  target: CapabilitySolution["target"] = null,
): CapabilitySolution {
  return { kind, label, rationale, target };
}

/**
 * 推荐解决方案：按「学习 → 调用现有资源 → 替代方案 → 降范围 → 接受缺口」排序。
 * 资源候选必须由调用方按能力过滤，函数不猜测资源归属。
 */
export function recommendCapabilitySolutions(
  gap: CapabilityGap,
  resources: ResourceCandidate[] = [],
): CapabilitySolution[] {
  const solutions: CapabilitySolution[] = [];

  if (gap.mastery === "none" || gap.mastery === "learning") {
    solutions.push(
      solution("learn", `学习「${gap.name}」`, "当前掌握度不足，可安排学习任务并设置验收标准"),
    );
  }

  for (const resource of resources) {
    solutions.push(
      solution(
        "resource",
        `使用${RESOURCE_KIND_LABELS[resource.kind]}：${resource.label}`,
        resource.availability === "available" ? "该资源当前可用" : "该资源部分可用，需先补齐",
        { kind: resource.kind, id: resource.id },
      ),
    );
  }

  if (gap.alternative.trim()) {
    solutions.push(solution("alternative", `采用替代方案：${gap.alternative}`, "项目已记录替代路径"));
  }

  if (gap.necessity !== "optional") {
    solutions.push(
      solution(
        "descope",
        "暂时降低范围",
        gap.necessity === "required" ? "必需能力，降范围需要明确确认" : "建议级能力，可先跳过并记录风险",
      ),
    );
  }

  solutions.push(solution("accept", "接受缺口并继续", "记录影响，后续阶段重新评估"));

  return solutions;
}

/**
 * 记录缺口处理决定。返回可写入数据库的决议；实际关联由服务层执行。
 */
export function resolveCapabilityGap(
  projectId: string,
  capabilityId: string,
  selection: CapabilitySolution,
  note = "",
): CapabilityGapResolution {
  if (!projectId.trim()) throw new Error("projectId 不能为空");
  if (!capabilityId.trim()) throw new Error("capabilityId 不能为空");
  if (!selection.label.trim()) throw new Error("解决方案缺少说明");
  return {
    capabilityId,
    solutionKind: selection.kind,
    note: note.trim(),
    status: "applied",
  };
}
