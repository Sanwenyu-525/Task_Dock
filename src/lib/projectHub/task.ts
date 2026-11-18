/**
 * 项目任务领域逻辑：去重创建、关联校验、风险识别。
 *
 * 任务行仍由全局任务系统写入；这里只产出「应该创建/关联什么」与风险，不直接改数据库。
 */

import type {
  CapabilityStatusResult,
  MilestoneSummary,
  NextAction,
  PhaseSummary,
  ProjectRisk,
  ProjectTask,
  ProjectTaskFilter,
  TaskCapabilityLink,
  TaskCreationPlan,
  TaskDraft,
  TaskPlanLink,
  WorkspaceSummary,
} from "./types";

export interface TaskCreationOptions {
  /** 项目中已存在的阶段 ID；提供时，草案引用不存在的阶段会被跳过而不是创建脏关联。 */
  phaseIds?: string[];
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 生成任务创建计划：同项目、同阶段、同名任务视为重复，返回 `skipped` 而不是静默丢弃。
 */
export function createProjectTasks(
  projectId: string,
  drafts: TaskDraft[],
  existing: Array<Pick<ProjectTask, "id" | "projectId" | "phaseId" | "title">> = [],
  options: TaskCreationOptions = {},
): TaskCreationPlan {
  if (!projectId.trim()) throw new Error("projectId 不能为空");

  const existingKeys = new Set(
    existing
      .filter((task) => task.projectId === projectId)
      .map((task) => `${task.phaseId ?? "none"}|${normalizeTitle(task.title)}`),
  );
  const accepted: TaskDraft[] = [];
  const skipped: TaskCreationPlan["skipped"] = [];

  for (const draft of drafts) {
    const title = draft.title.trim();
    if (!title) {
      skipped.push({ draftId: draft.id, title: draft.title, reason: "任务标题为空" });
      continue;
    }
    if (draft.phaseId && options.phaseIds && !options.phaseIds.includes(draft.phaseId)) {
      skipped.push({ draftId: draft.id, title, reason: `阶段不存在：${draft.phaseId}` });
      continue;
    }
    const key = `${draft.phaseId ?? "none"}|${normalizeTitle(title)}`;
    if (existingKeys.has(key)) {
      skipped.push({ draftId: draft.id, title, reason: "同阶段已存在同名任务" });
      continue;
    }
    existingKeys.add(key);
    accepted.push({ ...draft, title, capabilityKeys: [...draft.capabilityKeys], manualFields: [...draft.manualFields] });
  }

  return { accepted, skipped };
}

export function getProjectTasks(
  tasks: ProjectTask[],
  projectId: string,
  filter: ProjectTaskFilter = {},
): ProjectTask[] {
  return tasks.filter((task) => {
    if (task.projectId !== projectId) return false;
    if (filter.phaseId !== undefined && task.phaseId !== filter.phaseId) return false;
    if (filter.status && task.status !== filter.status) return false;
    if (filter.capabilityId && !task.capabilityIds.includes(filter.capabilityId)) return false;
    if (filter.dueBefore && (!task.dueDate || task.dueDate > filter.dueBefore)) return false;
    return true;
  });
}

/** 任务挂到阶段；任务与阶段必须属于同一项目。 */
export function linkTaskToPhase(
  task: Pick<ProjectTask, "id" | "projectId" | "phaseId">,
  phase: Pick<PhaseSummary, "id"> & { projectId: string },
  projectId: string,
): TaskPlanLink {
  if (!projectId.trim()) throw new Error("projectId 不能为空");
  if (task.projectId !== projectId) throw new Error("任务不属于该项目");
  if (phase.projectId !== projectId) throw new Error("阶段不属于该项目");
  if (!phase.id.trim()) throw new Error("phaseId 不能为空");
  return { taskId: task.id, projectId, phaseId: phase.id };
}

export function linkTaskToCapability(
  task: Pick<ProjectTask, "id">,
  capabilityId: string,
): TaskCapabilityLink {
  if (!capabilityId.trim()) throw new Error("capabilityId 不能为空");
  return { taskId: task.id, capabilityId };
}

export interface ExecutionRiskInput {
  projectId: string;
  now: string;
  tasks: ProjectTask[];
  phases: PhaseSummary[];
  milestones: MilestoneSummary[];
  capability: CapabilityStatusResult;
  workspace: WorkspaceSummary | null;
  nextActions: NextAction[];
}

const SEVERITY_ORDER: Record<ProjectRisk["severity"], number> = { high: 0, medium: 1, low: 2 };

function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400000));
}

/**
 * 识别执行风险。只读派生，不写库；最多返回 10 条，按严重度排序。
 */
export function detectProjectExecutionRisks(input: ExecutionRiskInput): ProjectRisk[] {
  const today = input.now.slice(0, 10);
  const projectTasks = input.tasks.filter((task) => task.projectId === input.projectId);
  const risks: ProjectRisk[] = [];

  const overdue = projectTasks
    .filter((task) => task.status === "pending" && task.dueDate !== null && task.dueDate < today)
    .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""));
  if (overdue.length > 0) {
    const worstDays = Math.max(...overdue.map((task) => daysBetween(task.dueDate as string, today)));
    risks.push({
      id: "risk-overdue",
      kind: "overdue",
      severity: worstDays > 3 ? "high" : "medium",
      title: `${overdue.length} 个任务已逾期`,
      detail: `最早逾期 ${worstDays} 天：${overdue.slice(0, 3).map((task) => task.title).join("、")}`,
      sourceId: overdue[0].id,
      suggestion: "调整截止时间或先处理阻塞项，并在任务中心更新状态。",
    });
  }

  const blockedPhases = input.phases.filter((phase) => phase.status === "blocked");
  if (blockedPhases.length > 0) {
    risks.push({
      id: "risk-blocked-phase",
      kind: "blocked_phase",
      severity: "high",
      title: `${blockedPhases.length} 个阶段处于阻塞`,
      detail: blockedPhases.map((phase) => phase.title).join("、"),
      sourceId: blockedPhases[0].id,
      suggestion: "查看阶段内的阻塞功能或能力缺口，先解除依赖再继续。",
    });
  }

  const requiredGaps = input.capability.lines.filter((line) => line.necessity === "required" && !line.satisfied);
  if (requiredGaps.length > 0) {
    const severe = requiredGaps.some((line) => line.mastery === "none" && line.resource === "unavailable");
    risks.push({
      id: "risk-capability",
      kind: "capability_gap",
      severity: severe ? "high" : "medium",
      title: `${requiredGaps.length} 项必需能力未满足`,
      detail: requiredGaps.map((line) => line.name).join("、"),
      sourceId: requiredGaps[0].capabilityId,
      suggestion: "选择学习、调用资源、替代方案或明确降范围；不要用百分比掩盖缺口。",
    });
  }

  const lateMilestones = input.milestones.filter(
    (milestone) => !milestone.completed && milestone.targetDate !== null && milestone.targetDate < today,
  );
  if (lateMilestones.length > 0) {
    risks.push({
      id: "risk-milestone",
      kind: "milestone_late",
      severity: "medium",
      title: `${lateMilestones.length} 个里程碑已过计划日期`,
      detail: lateMilestones.map((milestone) => milestone.title).join("、"),
      sourceId: lateMilestones[0].id,
      suggestion: "重排里程碑日期或缩小当前阶段范围，保留变更记录。",
    });
  }

  if (!input.workspace || !input.workspace.rootPath) {
    risks.push({
      id: "risk-workspace",
      kind: "missing_workspace",
      severity: "low",
      title: "尚未关联工作空间根目录",
      detail: "任务与交付物无法落到实际执行环境。",
      sourceId: input.workspace?.id ?? null,
      suggestion: "在项目中枢的「执行」中关联或创建工作空间。",
    });
  }

  if (input.nextActions.length === 0 && projectTasks.some((task) => task.status === "pending")) {
    risks.push({
      id: "risk-next-actions",
      kind: "no_next_action",
      severity: "low",
      title: "有待办但没有下一步建议",
      detail: "任务缺少阶段、能力或交付物关联，系统无法判断优先级。",
      sourceId: null,
      suggestion: "为任务补充阶段与能力关联，或手动指定下一步。",
    });
  }

  return risks.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]).slice(0, 10);
}
