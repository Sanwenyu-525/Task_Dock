//! 协作中心 IPC 桥接（v77）。
//!
//! 与 `bridge.ts` 同源：统一经 `invokeCommand` 做错误归一化；这里只做类型与参数
//! 映射，不含业务规则。后端命令位于 `src-tauri/src/collab/commands.rs`，与 MCP
//! 共用 `collab::service::Core`。

import { invokeCommand as invoke } from "./errors";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type IssueKind =
  | "feature"
  | "improvement"
  | "architecture"
  | "performance"
  | "security"
  | "tech_debt"
  | "bug"
  | "other";

export interface Issue {
  id: string;
  projectId: string;
  kind: IssueKind;
  title: string;
  description: string;
  impact: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: string;
  acceptance: string;
  reproSteps: string[];
  expectedResult: string | null;
  actualResult: string | null;
  environment: string | null;
  relatedFiles: string[];
  resolution: string;
  assignee: string;
  dedupeKey: string;
  sourceAgent: string;
  sourceSession: string;
  source: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueInput {
  kind: IssueKind;
  title: string;
  description?: string;
  impact?: string;
  priority?: string;
  acceptance?: string;
  reproSteps?: string[];
  expectedResult?: string | null;
  actualResult?: string | null;
  environment?: string | null;
  relatedFiles?: string[];
  assignee?: string;
  clientRequestId?: string;
}

export interface DuplicateCandidate {
  id: string;
  title: string;
  status: string;
  kind: string;
  score: number;
  reason: string;
}

export interface IssueCreateResult {
  issue: Issue;
  duplicateCandidates: DuplicateCandidate[];
  idempotentReplay: boolean;
}

export interface IssueDetail {
  issue: Issue;
  links: Array<{
    id: string;
    issueId: string;
    targetKind: string;
    targetId: string;
    relation: string;
    createdBy: string;
    createdAt: string;
  }>;
  evidence: Evidence[];
  plans: string[];
  evidenceCount: number;
}

export interface Evidence {
  id: string;
  projectId: string;
  subjectKind: string;
  subjectId: string;
  kind: string;
  title: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  mime: string;
  metaJson: string;
  createdBy: string;
  source: string;
  createdAt: string;
}

export interface TaskDraft {
  title: string;
  description?: string;
  priority?: number;
}

export interface Plan {
  id: string;
  projectId: string;
  issueId: string | null;
  title: string;
  summary: string;
  solutionMd: string;
  breakdown: TaskDraft[];
  status: string;
  reviewNote: string;
  approvedBy: string;
  approvedAt: string | null;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanTaskRef {
  taskId: string;
  title: string;
  status: string;
  completedAt: string | null;
  orphan: boolean;
}

export interface PlanDetail {
  plan: Plan;
  visuals: VisualDocument[];
  tasks: PlanTaskRef[];
  evidence: Evidence[];
}

export interface PlanTasksResult {
  plan: Plan;
  created: string[];
  existing: string[];
  tasks: PlanTaskRef[];
}

export interface PlanProgress {
  total: number;
  completed: number;
  percent: number | null;
  orphan: number;
}

export type VisualKind =
  | "flowchart"
  | "architecture"
  | "dataflow"
  | "prototype"
  | "bug_annotation"
  | "static_image"
  | "diff";

/** 创作来源：与 source（入口）正交。 */
export type AuthoringMode =
  | "manual"
  | "ai_generated"
  | "ai_assisted"
  | "agent_authored"
  | "imported";

/** 可人工创建的 kind（diff 只能由版本对比生成）。 */
export const CREATABLE_VISUAL_KINDS: Exclude<VisualKind, "diff">[] = [
  "flowchart",
  "architecture",
  "dataflow",
  "prototype",
  "bug_annotation",
  "static_image",
];

export interface VisualDocument {
  id: string;
  projectId: string;
  planId: string | null;
  title: string;
  description: string;
  kind: VisualKind;
  authoringMode: AuthoringMode;
  schemaVersion: number;
  sourceFormat: string;
  sourceContent: string;
  renderer: string;
  previewAsset: string | null;
  status: string;
  version: number;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisualVersion {
  id: string;
  documentId: string;
  version: number;
  snapshot: string;
  changeSummary: string;
  authoringMode: AuthoringMode;
  createdBy: string;
  source: string;
  createdAt: string;
}

export interface VisualAsset {
  id: string;
  projectId: string;
  documentId: string | null;
  title: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  mime: string;
  ext: string;
  status: string;
  metaJson: string;
  createdBy: string;
  source: string;
  createdAt: string;
}

export interface AssetContent {
  id: string;
  mime: string;
  sizeBytes: number;
  /** 不含 data: 前缀的 base64。 */
  base64: string;
}

export interface AiProposal {
  job: AiJob;
  documentId: string;
  baseRevision: number;
  kind: VisualKind;
  proposedContent: string;
  summary: string;
}

export interface PatchOp {
  op:
    | "add"
    | "update"
    | "remove"
    | "move"
    | "style"
    | "events"
    | "page_add"
    | "page_remove"
    | "page_rename";
  pageId?: string;
  componentId?: string;
  component?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  /**
   * 字段删除（与 patch 同时出现时先删除再写入）。
   * 后端只接受 props/style/events，删除不存在的键是幂等空操作。
   */
  removeKeys?: {
    props?: string[];
    style?: string[];
    events?: string[];
  };
  x?: number;
  y?: number;
  name?: string;
  page?: Record<string, unknown>;
}

export interface DiffItem {
  path: string;
  change: string;
  before: string | null;
  after: string | null;
}

export interface VisualDiff {
  added: number;
  removed: number;
  changed: number;
  summary: string;
  items: DiffItem[];
}

export interface PrototypeState {
  currentPage: string;
  modal: string | null;
  values: Record<string, unknown>;
}

export interface PrototypeEvent {
  action: "navigate" | "openModal" | "closeModal" | "toggle" | "setValue";
  target?: string;
  value?: unknown;
}

export interface InteractionFlowReport {
  ok: boolean;
  issues: string[];
}

export interface AiJob {
  id: string;
  projectId: string;
  planId: string | null;
  documentId: string | null;
  kind: string;
  provider: string;
  model: string;
  prompt: string;
  paramsJson: string;
  status: string;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  costUnits: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiNotice {
  textProvider: string;
  imageProvider: string | null;
  imageAvailable: boolean;
  message: string;
}

export const collabIssueCreate = (projectId: string, input: IssueInput) =>
  invoke<IssueCreateResult>("collab_issue_create", { projectId, input });

export const collabIssueUpdate = (
  id: string,
  expectedRevision: number,
  patch: Record<string, unknown>,
) => invoke<Issue>("collab_issue_update", { id, expectedRevision, patch });

export const collabIssueGet = (id: string) => invoke<IssueDetail>("collab_issue_get", { id });

export const collabIssueList = (
  projectId: string,
  filter: {
    status?: string;
    kind?: string;
    priority?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  } = {},
) => invoke<Page<Issue>>("collab_issue_list", { projectId, filter });

export const collabIssueDuplicates = (
  projectId: string,
  title: string,
  description: string,
  kind: string,
  excludeId?: string,
) => invoke<DuplicateCandidate[]>("collab_issue_duplicates", {
  projectId,
  title,
  description,
  kind,
  excludeId,
});

export const collabIssueArchive = (id: string, expectedRevision: number) =>
  invoke<Issue>("collab_issue_archive", { id, expectedRevision });

export const collabIssueResolve = (id: string, expectedRevision: number, resolution: string) =>
  invoke<Issue>("collab_issue_resolve", { id, expectedRevision, resolution });

export const collabIssueVerify = (id: string, expectedRevision: number, evidenceId: string) =>
  invoke<Issue>("collab_issue_verify", { id, expectedRevision, evidenceId });

export const collabEvidenceAttachText = (
  projectId: string,
  input: {
    subjectKind: string;
    subjectId: string;
    kind: string;
    title?: string;
    text?: string;
    mime?: string;
  },
) => invoke<Evidence>("collab_evidence_attach_text", { projectId, input });

export const collabEvidenceAttachPath = (
  projectId: string,
  input: {
    subjectKind: string;
    subjectId: string;
    kind: string;
    title?: string;
    path: string;
    mime?: string;
  },
) => invoke<Evidence>("collab_evidence_attach", { projectId, input });

export const collabEvidenceList = (
  projectId: string,
  subjectKind?: string,
  subjectId?: string,
) => invoke<Page<Evidence>>("collab_evidence_list", { projectId, subjectKind, subjectId });

export const collabPlanCreateFromIssue = (issueId: string) =>
  invoke<Plan>("collab_plan_create_from_issue", { issueId });

export const collabPlanUpdate = (
  id: string,
  expectedRevision: number,
  patch: Record<string, unknown>,
) => invoke<Plan>("collab_plan_update", { id, expectedRevision, patch });

export const collabPlanGet = (id: string) => invoke<PlanDetail>("collab_plan_get", { id });

export const collabPlanList = (
  projectId: string,
  status?: string,
  page = 1,
  pageSize = 20,
) => invoke<Page<Plan>>("collab_plan_list", { projectId, status, page, pageSize });

export const collabPlanSubmit = (id: string, expectedRevision: number) =>
  invoke<Plan>("collab_plan_submit", { id, expectedRevision });

export const collabPlanReview = (
  id: string,
  expectedRevision: number,
  decision: "approve" | "reject" | "request_changes",
  note?: string,
) => invoke<Plan>("collab_plan_review", { id, expectedRevision, decision, note });

export const collabPlanCreateTasks = (id: string) =>
  invoke<PlanTasksResult>("collab_plan_create_tasks", { id });

export const collabPlanProgress = (id: string) => invoke<PlanProgress>("collab_plan_progress", { id });

export const collabVisualList = (projectId: string, kind?: string, page = 1, pageSize = 20) =>
  invoke<Page<VisualDocument>>("collab_visual_list", { projectId, kind, page, pageSize });

export const collabVisualGet = (id: string) => invoke<VisualDocument>("collab_visual_get", { id });

export const collabVisualCreate = (
  projectId: string,
  input: {
    title: string;
    description?: string;
    kind: VisualKind;
    sourceFormat?: string;
    sourceContent?: string;
    planId?: string | null;
    authoringMode?: AuthoringMode;
  },
) => invoke<VisualDocument>("collab_visual_create", { projectId, input });

export const collabVisualUpdate = (
  id: string,
  expectedRevision: number,
  patch: Record<string, unknown>,
  changeSummary?: string,
) => invoke<VisualDocument>("collab_visual_update", { id, expectedRevision, patch, changeSummary });

export const collabVisualVersions = (id: string, page = 1, pageSize = 50) =>
  invoke<Page<VisualVersion>>("collab_visual_versions", { id, page, pageSize });

export const collabVisualRestore = (id: string, version: number, expectedRevision: number) =>
  invoke<VisualDocument>("collab_visual_restore", { id, version, expectedRevision });

export const collabVisualCompare = (id: string, fromVersion: number, toVersion: number) =>
  invoke<VisualDiff>("collab_visual_compare", { id, fromVersion, toVersion });

export const collabVisualExport = (id: string, format: "svg" | "json") =>
  invoke<{ format: string; content: string; filename: string }>("collab_visual_export", {
    id,
    format,
  });

export const collabPrototypeState = (id: string) =>
  invoke<PrototypeState>("collab_prototype_state", { id });

export const collabPrototypeDispatch = (id: string, state: PrototypeState, event: PrototypeEvent) =>
  invoke<PrototypeState>("collab_prototype_dispatch", { id, state, event });

export const collabPrototypePatch = (
  id: string,
  expectedRevision: number,
  ops: PatchOp[],
  changeSummary?: string,
) =>
  invoke<VisualDocument>("collab_prototype_patch", {
    id,
    expectedRevision,
    ops,
    changeSummary,
  });

export const collabPrototypeValidate = (id: string) =>
  invoke<InteractionFlowReport>("collab_prototype_validate", { id });

export const collabVisualAssetImport = (
  projectId: string,
  input: { path: string; title?: string; documentId?: string | null },
) => invoke<VisualAsset>("collab_visual_asset_import", { projectId, input });

export const collabVisualAssetList = (projectId: string, documentId?: string) =>
  invoke<VisualAsset[]>("collab_visual_asset_list", { projectId, documentId });

export const collabVisualAssetArchive = (id: string) =>
  invoke<VisualAsset>("collab_visual_asset_archive", { id });

export const collabAssetRead = (id: string) =>
  invoke<AssetContent>("collab_asset_read", { id });

export const collabAiModify = (
  id: string,
  instruction: string,
  selection: string[] = [],
  pageId?: string,
) =>
  invoke<AiProposal>("collab_ai_modify", {
    id,
    instruction,
    selection,
    pageId: pageId ?? null,
  });

/** 资产内容 → 可直接用于 <img src> 的 data URL。 */
export const assetDataUrl = (content: AssetContent) =>
  `data:${content.mime};base64,${content.base64}`;

export const collabAiGenerate = (
  projectId: string,
  kind: "flowchart" | "architecture" | "dataflow" | "prototype",
  prompt: string,
  planId?: string,
  issueId?: string,
) => invoke<AiJob>("collab_ai_generate", { projectId, planId, issueId, kind, prompt });

export const collabAiImage = (projectId: string, prompt: string, planId?: string) =>
  invoke<AiJob>("collab_ai_image", { projectId, planId, prompt });

export const collabAiJobs = (projectId: string, status?: string) =>
  invoke<Page<AiJob>>("collab_ai_jobs", { projectId, status, page: 1, pageSize: 20 });

export const collabAiNotice = () => invoke<AiNotice>("collab_ai_notice");
