/**
 * 工作空间与项目关联：绑定校验、上下文组装、交付物记录、文件事实同步。
 *
 * 规则：
 * - 只同步交付物事实，`recomputePlan` 恒为 false；
 * - 文件路径不能包含 `..`，绝对路径必须位于项目根目录内；
 * - 解除关联只清链接，不删除工作空间或文件。
 */

import type {
  CapabilityStatusResult,
  DeliverableInput,
  MilestoneSummary,
  PhaseSummary,
  ProgressSnapshot,
  ProjectDeliverableRecord,
  ProjectSummary,
  ProjectTask,
  WorkspaceFileFact,
  WorkspaceLink,
  WorkspaceProjectContext,
  WorkspaceSummary,
  WorkspaceSyncResult,
} from "./types";

export function normalizeProjectPath(path: string, rootPath: string | null = null): string {
  const raw = path.trim().replace(/\\/g, "/");
  if (!raw) throw new Error("文件路径不能为空");
  if (raw.includes("\0")) throw new Error("文件路径包含非法字符");
  const segments = raw.split("/");
  if (segments.includes("..")) throw new Error("文件路径不能包含上级目录");
  const normalized = raw.replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");

  const absolute = /^[A-Za-z]:/.test(normalized) || normalized.startsWith("/");
  if (absolute) {
    if (!rootPath) throw new Error("缺少项目根目录，无法校验绝对路径");
    const root = rootPath.trim().replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const target = normalized.toLowerCase();
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw new Error("文件路径不在项目根目录内");
    }
  }
  return normalized;
}

/**
 * 关联工作空间。v1 中工作空间与项目是同一实体，但仍校验归属，禁止把已属于 A 的工作空间绑到 B。
 */
export function linkWorkspaceToProject(
  projectId: string,
  workspace: WorkspaceSummary,
  existing: WorkspaceLink[] = [],
  now: string = new Date().toISOString(),
): WorkspaceLink {
  if (!projectId.trim()) throw new Error("projectId 不能为空");
  if (workspace.projectId && workspace.projectId !== projectId) {
    throw new Error("工作空间已关联其他项目");
  }
  const current = existing.find((link) => link.projectId === projectId && link.workspaceId === workspace.id);
  if (current) return current;
  return { projectId, workspaceId: workspace.id, linkedAt: now };
}

/** 解除关联：只移除链接并返回更新后的工作空间副本。 */
export function unlinkWorkspaceFromProject(
  projectId: string,
  workspace: WorkspaceSummary,
  links: WorkspaceLink[],
): { workspace: WorkspaceSummary; links: WorkspaceLink[]; removed: WorkspaceLink | null } {
  const target = links.find((link) => link.projectId === projectId && link.workspaceId === workspace.id) ?? null;
  if (!target) {
    return { workspace: { ...workspace, moduleIds: [...workspace.moduleIds] }, links: [...links], removed: null };
  }
  return {
    workspace: { ...workspace, projectId: null, moduleIds: [...workspace.moduleIds] },
    links: links.filter((link) => link !== target),
    removed: target,
  };
}

export interface WorkspaceContextInput {
  project: ProjectSummary;
  phases: PhaseSummary[];
  tasks: ProjectTask[];
  capability: CapabilityStatusResult;
  milestones: MilestoneSummary[];
  deliverables: ProjectDeliverableRecord[];
  progress: ProgressSnapshot;
  stale: boolean;
  now: string;
}

function selectCurrentPhase(phases: PhaseSummary[]): PhaseSummary | null {
  const active = phases.find((phase) => phase.status === "active");
  if (active) return active;
  return [...phases].sort((left, right) => left.order - right.order).find((phase) => phase.status !== "completed") ?? null;
}

export function getWorkspaceProjectContext(input: WorkspaceContextInput): WorkspaceProjectContext {
  const today = input.now.slice(0, 10);
  const projectTasks = input.tasks.filter((task) => task.projectId === input.project.id);
  const pending = projectTasks.filter((task) => task.status === "pending");
  const overdue = pending.filter((task) => task.dueDate !== null && task.dueDate < today);

  return {
    projectId: input.project.id,
    projectName: input.project.name,
    goal: input.project.goal,
    currentPhase: selectCurrentPhase(input.phases),
    phases: input.phases.map((phase) => ({ ...phase })),
    tasks: { total: projectTasks.length, pending: pending.length, overdue: overdue.length },
    capability: input.capability,
    milestones: input.milestones.map((milestone) => ({ ...milestone })),
    deliverables: getProjectDeliverables(input.deliverables, input.project.id),
    progress: input.progress,
    stale: input.stale,
  };
}

/**
 * 记录交付物：默认 `planned`，不会因为文件存在就自动验收。
 */
export function recordProjectDeliverable(
  input: DeliverableInput,
  options: { id: string; rootPath?: string | null; now?: string },
): ProjectDeliverableRecord {
  if (!input.projectId.trim()) throw new Error("projectId 不能为空");
  if (!input.title.trim()) throw new Error("交付物名称不能为空");
  const path = normalizeProjectPath(input.path, options.rootPath ?? null);
  return {
    id: options.id,
    projectId: input.projectId,
    phaseId: input.phaseId,
    title: input.title.trim(),
    path,
    status: "planned",
    required: input.required,
    recordedAt: options.now ?? new Date().toISOString(),
    acceptedAt: null,
    note: input.note.trim(),
  };
}

export function getProjectDeliverables(
  deliverables: ProjectDeliverableRecord[],
  projectId: string,
  status?: ProjectDeliverableRecord["status"],
): ProjectDeliverableRecord[] {
  return deliverables.filter((item) => item.projectId === projectId && (!status || item.status === status));
}

/**
 * 用工作空间文件事实更新交付物状态：只把 `planned` 且文件存在的条目推进到 `produced`。
 */
export function syncWorkspaceDeliverables(
  projectId: string,
  deliverables: ProjectDeliverableRecord[],
  files: WorkspaceFileFact[],
  rootPath: string | null = null,
): WorkspaceSyncResult {
  const factMap = new Map<string, boolean>();
  for (const file of files) {
    try {
      factMap.set(normalizeProjectPath(file.path, rootPath).toLowerCase(), file.exists);
    } catch {
      // 非法路径不进入同步，避免绕过安全边界。
    }
  }

  const produced: string[] = [];
  const missing: string[] = [];
  const unchanged: string[] = [];

  for (const deliverable of deliverables.filter((item) => item.projectId === projectId)) {
    if (deliverable.status !== "planned") {
      unchanged.push(deliverable.path);
      continue;
    }
    const exists = factMap.get(deliverable.path.toLowerCase());
    if (exists) produced.push(deliverable.path);
    else missing.push(deliverable.path);
  }

  return { produced, missing, unchanged, recomputePlan: false };
}
