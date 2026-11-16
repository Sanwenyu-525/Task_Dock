//! 通用线 IPC 类型化包装（U1）。
//!
//! 唯一调用出口是 `../ipc.ts` 的 `creativeInvoke`；本文件不直接 `import { invoke }`，
//! 也不修改 `src/lib/bridge.ts`。核心既有命令（事项、任务关联）同样经 `creativeInvoke`
//! 调用，只读取弱引用数据，不复制事项/任务实现。

import { creativeInvoke } from "../ipc";

// ── 类型（与 Rust 模型 camelCase 对齐）─────────────────────────────────

export type MilestoneStatus = "open" | "done" | "skipped";
export type MaterialKind = "file" | "folder" | "link" | "note";

export interface GeneralMilestone {
  id: string;
  projectId: string;
  title: string;
  targetDate: string | null;
  status: MilestoneStatus;
  note: string;
  sortOrder: number;
  linkedItemId: string | null;
  linkedItemExists: boolean;
  linkedItemTitle: string | null;
  linkedTaskId: string | null;
  linkedTaskExists: boolean;
  linkedTaskTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GeneralMaterial {
  id: string;
  projectId: string;
  kind: MaterialKind;
  title: string;
  path: string;
  note: string;
  alive: boolean;
  aliveReason: string | null;
  linkedTitle: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface GeneralActivityEvent {
  kind: "item" | "milestone" | "material" | "taskLink";
  refId: string;
  title: string;
  status: string | null;
  at: string;
}

export interface GeneralStats {
  totalItems: number;
  todoItems: number;
  doingItems: number;
  blockedItems: number;
  doneItems: number;
  milestonesTotal: number;
  milestonesOpen: number;
  milestonesDone: number;
  milestonesSkipped: number;
  linkedTasks: number;
  materialsTotal: number;
  materialsAlive: number;
  currentMilestone: GeneralMilestone | null;
  recentActivity: GeneralActivityEvent[];
}

export interface GeneralApplyTemplateResult {
  applied: boolean;
  itemsCreated: number;
  milestonesCreated: number;
  reason: string | null;
}

export interface CoreWorkspaceItem {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  stage: string;
  status: string;
  sortOrder: number;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoreTaskLink {
  projectId: string;
  taskId: string;
  title: string;
  status: string;
  priority: number;
  dueAt: string | null;
  createdAt: string;
}

export interface TemplateStagePayload {
  title: string;
  items: string[];
  milestone?: { title: string; note?: string } | null;
}

// ── 包装 ──────────────────────────────────────────────────────────────

export function generalApplyTemplate(
  projectId: string,
  templateId: string,
  stages: TemplateStagePayload[],
) {
  return creativeInvoke<GeneralApplyTemplateResult>("general_apply_template", {
    projectId,
    templateId,
    stages,
  });
}

export function generalMilestoneList(projectId: string) {
  return creativeInvoke<{ milestones: GeneralMilestone[] }>("general_milestone_list", {
    projectId,
  });
}

export interface MilestoneSavePayload {
  id?: string | null;
  projectId: string;
  title: string;
  targetDate?: string | null;
  status?: MilestoneStatus | null;
  note?: string | null;
  linkedItemId?: string | null;
  linkedTaskId?: string | null;
  sortOrder?: number | null;
}

export function generalMilestoneSave(payload: MilestoneSavePayload) {
  return creativeInvoke<{ milestone: GeneralMilestone }>("general_milestone_save", {
    ...payload,
  });
}

export function generalMilestoneDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("general_milestone_delete", { id });
}

export function generalMaterialList(projectId: string) {
  return creativeInvoke<{ materials: GeneralMaterial[] }>("general_material_list", {
    projectId,
  });
}

export interface MaterialSavePayload {
  id?: string | null;
  projectId: string;
  kind: MaterialKind;
  title: string;
  path: string;
  note?: string | null;
}

export function generalMaterialSave(payload: MaterialSavePayload) {
  return creativeInvoke<{ material: GeneralMaterial }>("general_material_save", {
    ...payload,
  });
}

export function generalMaterialDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("general_material_delete", { id });
}

export function generalMaterialOpen(id: string) {
  return creativeInvoke<{ kind: MaterialKind; opened: boolean }>("general_material_open", {
    id,
  });
}

export function generalStats(projectId: string) {
  return creativeInvoke<{ stats: GeneralStats }>("general_stats", { projectId });
}

/** 既有核心命令：项目事项（只读引用，供里程碑关联选择）。 */
export function coreItemList(projectId: string) {
  return creativeInvoke<{ items: CoreWorkspaceItem[] }>("workspace_item_list", {
    projectId,
  });
}

/** 既有核心命令：项目关联任务（只读引用，供里程碑关联选择）。 */
export function coreTaskLinkList(projectId: string) {
  return creativeInvoke<{ links: CoreTaskLink[] }>("workspace_task_link_list", {
    projectId,
  });
}
