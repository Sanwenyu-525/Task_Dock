/**
 * 项目中枢读模型适配：把 IPC 快照（camelCase 结构）翻译成领域层输入。
 *
 * 关键口径（`docs/project-hub/02-架构设计.md` §4.1）：
 * - 阶段完成 = 该阶段**功能与必需交付物**全部完成，不是「任务都完成」；
 * - 项目整体进度 = 各阶段内部完成率的算术平均（阶段等权），无阶段数据时回退任务完成率并标注；
 * - 里程碑完成率必须有可判定的依据（绑定功能全部完成），否则返回 null 而不是编造；
 * - 「没有资源」与「资源未评估」是两件事：前者是事实，后者是待办。
 *
 * 本模块只做纯函数，不发起 IO，便于单测锁定口径。
 */

import type {
  DeliverableProgressInput,
  FeatureProgressInput,
  MilestoneProgressInput,
  PhaseProgressInput,
  PhaseSummary,
  ProjectProgressInput,
  ResourceAvailability,
  TaskProgressInput,
} from "./types";

export interface HubPhaseLike {
  id: string;
  name: string;
  description: string;
  targetDate: string | null;
  startDate: string | null;
  sortOrder: number;
  taskCount: number;
  completedTaskCount: number;
  featureCount: number;
  completedFeatureCount: number;
}

export interface HubFeatureLike {
  id: string;
  title: string;
  status: string;
  milestoneId: string | null;
  priority: string;
}

export interface HubTaskLike {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  phaseId: string | null;
}

export interface HubDeliverableLike {
  id: string;
  title: string;
  status: string;
  phaseId: string | null;
}

export interface HubMilestoneLike {
  id: string;
  name: string;
  targetDate: string | null;
  featureCount: number;
  completedFeatureCount: number;
}

export interface HubCapabilityLike {
  capabilityId: string;
  name: string;
  category: string;
  necessity: string;
  targetLevel: string;
  assessmentLevel: string | null;
  mastery: string;
  resourceCount: number;
  availableResourceCount: number;
  verifiedResourceCount: number;
  impact: string;
  alternative: string;
  phaseId: string | null;
}

export interface HubSnapshotLike {
  planId: string | null;
  phases: HubPhaseLike[];
  features: HubFeatureLike[];
  tasks: HubTaskLike[];
  deliverables: HubDeliverableLike[];
  milestones: HubMilestoneLike[];
  capabilities: HubCapabilityLike[];
}

/** 功能状态白名单（与 `planning_features.status` 的 CHECK 约束一致）。 */
const FEATURE_STATUSES = ["planned", "in_progress", "review", "completed", "blocked", "paused"];

function featureStatus(value: string): FeatureProgressInput["status"] {
  return (FEATURE_STATUSES as string[]).includes(value)
    ? (value as FeatureProgressInput["status"])
    : "planned";
}

/**
 * 阶段状态：先看功能，再看任务，最后才落到「未开始」。
 * - 阶段有功能：功能全部完成 → completed；
 * - 阶段无功能但有任务：任务全部完成 → completed；
 * - 两者都没有：pending（待评估，不是 0%）。
 */
export function buildPhaseSummaries(snapshot: HubSnapshotLike): PhaseSummary[] {
  const ordered = [...snapshot.phases].sort((left, right) => left.sortOrder - right.sortOrder);
  let activeAssigned = false;

  return ordered.map((phase) => {
    const features = snapshot.features.filter((feature) => feature.milestoneId === phase.id);
    const tasks = snapshot.tasks.filter((task) => task.phaseId === phase.id);

    let completed = false;
    let hasUnit = false;
    if (features.length > 0) {
      hasUnit = true;
      completed = features.every((feature) => feature.status === "completed");
    } else if (tasks.length > 0) {
      hasUnit = true;
      completed = tasks.every((task) => task.status === "completed");
    }

    let status: PhaseSummary["status"];
    if (!hasUnit) {
      status = "pending";
    } else if (completed) {
      status = "completed";
    } else if (!activeAssigned) {
      status = "active";
      activeAssigned = true;
    } else {
      status = "pending";
    }

    return {
      id: phase.id,
      title: phase.name,
      order: phase.sortOrder,
      status,
      targetDate: phase.targetDate,
    };
  });
}

/**
 * 当前阶段：第一个未完成阶段。全部完成时返回 null（不再回退到第一个阶段）。
 */
export function currentPhaseOf(snapshot: HubSnapshotLike): PhaseSummary | null {
  const summaries = buildPhaseSummaries(snapshot);
  const active = summaries.find((phase) => phase.status === "active");
  if (active) return active;
  return summaries.find((phase) => phase.status !== "completed") ?? null;
}

/** 四项进度的输入装配：阶段用功能 + 交付物，里程碑用绑定功能的完成情况。 */
export function buildProgressInput(snapshot: HubSnapshotLike): ProjectProgressInput {
  const tasks: TaskProgressInput[] = snapshot.tasks.map((task) => ({
    id: task.id,
    status: task.status === "completed" ? "completed" : "pending",
    phaseId: task.phaseId,
  }));

  const phases: PhaseProgressInput[] = snapshot.phases.map((phase) => {
    const features: FeatureProgressInput[] = snapshot.features
      .filter((feature) => feature.milestoneId === phase.id)
      .map((feature) => ({ id: feature.id, status: featureStatus(feature.status) }));

    // 交付物在项目中枢是「承诺」，因此按必需项计入阶段完成度。
    const deliverables: DeliverableProgressInput[] = snapshot.deliverables
      .filter((deliverable) => deliverable.phaseId === phase.id)
      .map((deliverable) => ({
        id: deliverable.id,
        status:
          deliverable.status === "accepted"
            ? "accepted"
            : deliverable.status === "rejected"
              ? "rejected"
              : deliverable.status === "produced"
                ? "produced"
                : "planned",
        required: true,
      }));

    return {
      id: phase.id,
      title: phase.name,
      features,
      deliverables,
      countsTowardOverall: true,
    };
  });

  // 里程碑完成率只统计「有可判定依据」的里程碑：绑定了功能才能判断是否完成。
  // 没有绑定功能的里程碑不计入分母（无法判定 ≠ 未完成）；全部无法判定时结果为 null。
  const milestones: MilestoneProgressInput[] = snapshot.milestones
    .filter((milestone) => milestone.featureCount > 0)
    .map((milestone) => ({
      id: milestone.id,
      completesAt: milestone.targetDate,
      completed: milestone.completedFeatureCount === milestone.featureCount,
    }));

  return { tasks, phases, milestones };
}

/**
 * 能力资源可用性：
 * - 没有关联资源 → `unavailable`（事实：确认没有可用资源）；
 * - 有关联但从未校验过 → `unknown`（未评估，不是不可用）；
 * - 全部可用 → `available`；部分可用 → `partial`。
 */
export function capabilityResourceAvailability(
  capability: Pick<HubCapabilityLike, "resourceCount" | "availableResourceCount" | "verifiedResourceCount">,
): ResourceAvailability {
  if (capability.resourceCount <= 0) return "unavailable";
  if (capability.verifiedResourceCount <= 0) return "unknown";
  if (capability.availableResourceCount >= capability.resourceCount) return "available";
  if (capability.availableResourceCount > 0) return "partial";
  return "unavailable";
}

/** 能力准备度输入：掌握度优先取项目实测，未评估时回落到能力库并标记未评估。 */
export function buildCapabilityInput(snapshot: HubSnapshotLike) {
  return snapshot.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId,
    name: capability.name,
    category: capability.category as "human" | "tool" | "ai" | "agent" | "external",
    necessity: capability.necessity as "required" | "recommended" | "optional",
    phaseId: capability.phaseId,
    assessmentLevel:
      capability.assessmentLevel && capability.assessmentLevel !== "unknown"
        ? (capability.assessmentLevel as "expert" | "proficient" | "basic" | "learning" | "none")
        : null,
    libraryMastery: (capability.mastery || "unknown") as
      | "expert"
      | "proficient"
      | "basic"
      | "learning"
      | "none"
      | "unknown",
    resource: capabilityResourceAvailability(capability),
    impact: capability.impact,
    alternative: capability.alternative,
  }));
}
