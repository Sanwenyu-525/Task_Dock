/**
 * 项目总览读模型：只组合已有事实，不在组件里做业务计算。
 *
 * `buildProjectOverview` 输入均为已查询好的结构；后续 Rust 适配层负责一次批量查询，
 * 这里不发起任何 IO。
 */

import { detectProjectExecutionRisks } from "./task";
import { normalizeProjectPath } from "./workspace";
import type {
  CapabilityStatusResult,
  IntegrityIssue,
  IntegrityReport,
  MilestoneSummary,
  NextAction,
  PhaseSummary,
  ProgressSnapshot,
  ProjectDeliverableRecord,
  ProjectEvent,
  ProjectExecutionState,
  ProjectOverview,
  ProjectResourceLink,
  ProjectSummary,
  ProjectTask,
  WorkspaceSummary,
} from "./types";

function selectCurrentPhase(phases: PhaseSummary[]): PhaseSummary | null {
  const active = phases.find((phase) => phase.status === "active");
  if (active) return active;
  return [...phases].sort((left, right) => left.order - right.order).find((phase) => phase.status !== "completed") ?? null;
}

function overdueTasks(tasks: ProjectTask[], projectId: string, now: string): ProjectTask[] {
  const today = now.slice(0, 10);
  return tasks
    .filter(
      (task) =>
        task.projectId === projectId &&
        task.status === "pending" &&
        task.dueDate !== null &&
        task.dueDate < today,
    )
    .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""));
}

export interface ExecutionStateInput {
  projectId: string;
  phases: PhaseSummary[];
  tasks: ProjectTask[];
  milestones: MilestoneSummary[];
  events: ProjectEvent[];
  now: string;
}

export function getProjectExecutionState(input: ExecutionStateInput): ProjectExecutionState {
  const current = selectCurrentPhase(input.phases);
  const incompleteMilestones = input.milestones
    .filter((milestone) => !milestone.completed)
    .sort((left, right) => {
      if (!left.targetDate && !right.targetDate) return left.id.localeCompare(right.id);
      if (!left.targetDate) return 1;
      if (!right.targetDate) return -1;
      return left.targetDate.localeCompare(right.targetDate);
    });
  const lastEvent = [...input.events]
    .filter((event) => event.projectId === input.projectId)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];

  const projectTasks = input.tasks.filter((task) => task.projectId === input.projectId);

  return {
    projectId: input.projectId,
    currentPhaseId: current?.id ?? null,
    currentPhaseTitle: current?.title ?? null,
    blockedPhaseIds: input.phases.filter((phase) => phase.status === "blocked").map((phase) => phase.id),
    nextMilestoneId: incompleteMilestones[0]?.id ?? null,
    nextMilestoneTitle: incompleteMilestones[0]?.title ?? null,
    pendingTaskCount: projectTasks.filter((task) => task.status === "pending").length,
    overdueTaskCount: overdueTasks(input.tasks, input.projectId, input.now).length,
    lastActivityAt: lastEvent?.occurredAt ?? null,
  };
}

export interface NextActionInput {
  projectId: string;
  phases: PhaseSummary[];
  tasks: ProjectTask[];
  capability: CapabilityStatusResult;
  deliverables: ProjectDeliverableRecord[];
  workspace: WorkspaceSummary | null;
  now: string;
}

/**
 * 生成下一步建议：最多 5 条，全部可解释、可忽略；不自动执行。
 */
export function getProjectNextActions(input: NextActionInput): NextAction[] {
  const actions: NextAction[] = [];
  const projectTasks = input.tasks.filter((task) => task.projectId === input.projectId);
  const seenTaskIds = new Set<string>();

  const overdue = overdueTasks(input.tasks, input.projectId, input.now).slice(0, 2);
  for (const task of overdue) {
    seenTaskIds.add(task.id);
    actions.push({
      id: `action-task-${task.id}`,
      kind: "task",
      title: `处理逾期任务：${task.title}`,
      detail: `截止 ${task.dueDate}，状态仍为待办`,
      targetId: task.id,
    });
  }

  const requiredGap = input.capability.lines.find((line) => line.necessity === "required" && !line.satisfied);
  if (requiredGap) {
    actions.push({
      id: `action-capability-${requiredGap.capabilityId}`,
      kind: "capability",
      title: `补齐能力：${requiredGap.name}`,
      detail: requiredGap.impact || "必需能力未满足，查看缺口方案",
      targetId: requiredGap.capabilityId,
    });
  }

  const current = selectCurrentPhase(input.phases);
  const phaseTasks = projectTasks
    .filter(
      (task) =>
        task.status === "pending" &&
        (!current || task.phaseId === current.id) &&
        !seenTaskIds.has(task.id),
    )
    .slice(0, 2);
  for (const task of phaseTasks) {
    seenTaskIds.add(task.id);
    actions.push({
      id: `action-task-${task.id}`,
      kind: "task",
      title: `推进任务：${task.title}`,
      detail: current ? `当前阶段：${current.title}` : "未归属阶段",
      targetId: task.id,
    });
  }

  const planned = input.deliverables.find(
    (item) => item.projectId === input.projectId && item.status === "planned",
  );
  if (planned) {
    actions.push({
      id: `action-deliverable-${planned.id}`,
      kind: "deliverable",
      title: `确认交付物：${planned.title}`,
      detail: planned.path,
      targetId: planned.id,
    });
  }

  if (!input.workspace || !input.workspace.rootPath) {
    actions.push({
      id: "action-workspace",
      kind: "workspace",
      title: "关联工作空间根目录",
      detail: "让任务与交付物落到实际执行环境",
      targetId: input.workspace?.id ?? null,
    });
  }

  const unassessed = input.capability.lines.find((line) => line.necessity === "required" && line.mastery === "unknown");
  if (unassessed && actions.length < 5) {
    actions.push({
      id: `action-review-${unassessed.capabilityId}`,
      kind: "review",
      title: `评估能力现状：${unassessed.name}`,
      detail: "尚未评估，准备度暂不能判定",
      targetId: unassessed.capabilityId,
    });
  }

  return actions.slice(0, 5);
}

export interface OverviewInput extends NextActionInput {
  project: ProjectSummary;
  milestones: MilestoneSummary[];
  events: ProjectEvent[];
  progress: ProgressSnapshot;
  stale: boolean;
}

/**
 * 组装总览。调用方必须先完成批量查询；本函数不做任何持久化。
 */
export function buildProjectOverview(input: OverviewInput): ProjectOverview {
  const nextActions = getProjectNextActions(input);
  const risks = detectProjectExecutionRisks({
    projectId: input.projectId,
    now: input.now,
    tasks: input.tasks,
    phases: input.phases,
    milestones: input.milestones,
    capability: input.capability,
    workspace: input.workspace,
    nextActions,
  });

  const recentDeliverables = input.deliverables
    .filter((item) => item.projectId === input.projectId)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .slice(0, 5);
  const recentEvents = input.events
    .filter((event) => event.projectId === input.projectId)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, 10);

  return {
    project: input.project,
    goal: input.project.goal,
    currentPhase: selectCurrentPhase(input.phases),
    progress: input.progress,
    capability: input.capability,
    risks,
    nextActions,
    recentDeliverables,
    recentEvents,
    computedAt: input.now,
    stale: input.stale,
  };
}

export interface IntegrityInput {
  project: ProjectSummary;
  phases: PhaseSummary[];
  tasks: ProjectTask[];
  capability: CapabilityStatusResult;
  deliverables: ProjectDeliverableRecord[];
  resourceLinks?: ProjectResourceLink[];
  rootPath?: string | null;
  deleting?: boolean;
}

/**
 * 完整性校验：删除或应用修订前调用；只报告，不自动修复。
 */
export function validateProjectIntegrity(input: IntegrityInput): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const projectId = input.project.id;
  const phaseIds = new Set(input.phases.map((phase) => phase.id));

  if (!projectId.trim()) {
    issues.push({
      code: "project_id_missing",
      severity: "blocking",
      message: "项目 ID 为空",
      entityId: null,
    });
  }

  if (phaseIds.size !== input.phases.length) {
    issues.push({
      code: "duplicate_phase_id",
      severity: "blocking",
      message: "阶段 ID 重复，关联关系不可判定",
      entityId: null,
    });
  }

  if (!input.project.activePlanId) {
    issues.push({
      code: "active_plan_missing",
      severity: "warning",
      message: "项目没有生效中的计划",
      entityId: projectId,
    });
  }

  for (const task of input.tasks.filter((item) => item.projectId === projectId)) {
    if (task.phaseId && !phaseIds.has(task.phaseId)) {
      issues.push({
        code: "task_phase_missing",
        severity: "warning",
        message: `任务「${task.title}」引用的阶段不存在`,
        entityId: task.id,
      });
    }
  }

  for (const line of input.capability.lines) {
    if (line.phaseId && !phaseIds.has(line.phaseId)) {
      issues.push({
        code: "capability_phase_missing",
        severity: "warning",
        message: `能力「${line.name}」引用的阶段不存在`,
        entityId: line.capabilityId,
      });
    }
  }

  for (const deliverable of input.deliverables.filter((item) => item.projectId === projectId)) {
    try {
      normalizeProjectPath(deliverable.path, input.rootPath ?? null);
    } catch (error) {
      issues.push({
        code: "deliverable_path_unsafe",
        severity: "blocking",
        message: error instanceof Error ? error.message : "交付物路径不安全",
        entityId: deliverable.id,
      });
    }
  }

  if (input.deleting && (input.resourceLinks?.length ?? 0) > 0) {
    issues.push({
      code: "shared_resources_in_use",
      severity: "blocking",
      message: `项目仍引用 ${input.resourceLinks?.length ?? 0} 个共享资源，删除前需先解除关联`,
      entityId: projectId,
    });
  }

  return { ok: !issues.some((issue) => issue.severity === "blocking"), issues };
}
