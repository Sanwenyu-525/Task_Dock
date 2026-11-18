/**
 * 项目中枢领域类型（前端契约）。
 *
 * 与 `docs/project-hub/05-服务与接口.md` 的 DTO 对齐；Rust 端实现后由
 * `#[serde(rename_all = "camelCase")]` 保证字段名一致。
 *
 * 设计约束：
 * - 所有可能为空的事实必须用 `null`，禁止用 0、空串或默认日期冒充；
 * - 生成/推断字段必须带 `source`，UI 据此显示「你提供 / 模板 / 推断」；
 * - 进度与能力准备度只返回结构化结果，不在这里做任何 UI 文案。
 */

/** 五种工作模式，与 `workspace_projects.kind` 一致。 */
export type ProjectKind = "novel" | "game" | "ai_comic" | "general" | "development";

/** 项目生命周期（归档是独立开关，不改变计划执行状态）。 */
export type ProjectLifecycle = "active" | "archived";

/** 计划执行状态，与既有 `planning_projects.status` 一致。 */
export type PlanStatus = "planning" | "in_progress" | "paused" | "completed";

export type Priority = "P0" | "P1" | "P2";

export type FeatureStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "completed"
  | "blocked"
  | "paused";

/** 字段来源：用户提供 / 模板 / 推断 / 默认值。 */
export type FieldSource = "user" | "template" | "inferred" | "default";

export type Necessity = "required" | "recommended" | "optional";

/** 能力五类，禁止把「已安装 Skill」当作「已掌握能力」。 */
export type CapabilityCategory = "human" | "tool" | "ai" | "agent" | "external";

export type Mastery = "expert" | "proficient" | "basic" | "learning" | "none" | "unknown";

export type ResourceAvailability = "available" | "partial" | "unavailable" | "unknown";

export type CapabilityReadinessLabel = "ready" | "partial" | "blocked" | "unassessed";

export type ResourceKind =
  | "knowledge"
  | "skill"
  | "mcp"
  | "agent"
  | "tool"
  | "template"
  | "workflow";

export type ConstraintKind = "deadline" | "budget" | "scope" | "platform" | "quality" | "other";

export type SolutionKind = "learn" | "resource" | "alternative" | "descope" | "accept";

export type DeliverableStatus = "planned" | "produced" | "accepted" | "rejected";

/** 带来源的字段值。 */
export interface Provenanced<T> {
  value: T;
  source: FieldSource;
  /** 解释为什么这样推断；不得写用户未提供的事实。 */
  note?: string;
}

export interface ProjectGoal {
  id: string;
  title: string;
  kind: "goal" | "subgoal";
  parentId: string | null;
  /** 度量名称，例如「字数」「章节」「关卡」。 */
  metric: string;
  /** 目标值；未知必须为 null。 */
  targetValue: number | null;
  unit: string;
  status: "active" | "achieved" | "dropped";
  source: FieldSource;
}

export interface ProjectConstraint {
  kind: ConstraintKind;
  /** 用户原话片段，保留证据。 */
  text: string;
  /** 相对截止时间（天）；只有用户说了「N 个月/周/天」才填写。 */
  relativeDays: number | null;
  /** 绝对日期（YYYY-MM-DD）；只有用户明确给出日期才填写。 */
  absoluteDate: string | null;
  /** 预算金额；未提及必须为 null。 */
  amount: number | null;
  currency: string | null;
  /** 平台/范围等自由值。 */
  value: string | null;
  source: FieldSource;
}

export interface ProjectUncertainty {
  id: string;
  /** 对应字段名，便于 UI 定位。 */
  field: string;
  question: string;
  /** true = 不解决无法继续；false = 可以留空后补。 */
  blocking: boolean;
  options: string[];
}

export interface ProjectIntent {
  raw: string;
  /** 项目名称；未显式命名时为 null 或推断值（source=inferred）。 */
  title: string | null;
  titleSource: FieldSource;
  kind: ProjectKind | null;
  goals: ProjectGoal[];
  constraints: ProjectConstraint[];
  uncertainties: ProjectUncertainty[];
  /** 用户原话中的产出物短语（未结构化，供草案使用）。 */
  deliverables: string[];
  /** 范围排除项，例如「不做联机」。 */
  scopeNotes: string[];
  provider: "local" | "agent";
}

export interface FeatureDraft {
  id: string;
  title: string;
  acceptance: string;
  priority: Priority;
  source: FieldSource;
  /** 被用户手动改过的字段名；生成时不得覆盖。 */
  manualFields: string[];
}

export interface PhaseDraft {
  id: string;
  title: string;
  purpose: string;
  order: number;
  startDate: string | null;
  targetDate: string | null;
  features: FeatureDraft[];
  milestoneTitles: string[];
  /** 该阶段需要的能力 key，与 capabilityRequirements.key 对应。 */
  capabilityKeys: string[];
  source: FieldSource;
  manualFields: string[];
}

export interface CapabilityRequirementDraft {
  key: string;
  name: string;
  category: CapabilityCategory;
  necessity: Necessity;
  targetLevel: "basic" | "proficient";
  phaseId: string | null;
  impact: string;
  alternative: string;
  source: FieldSource;
}

export interface TaskDraft {
  id: string;
  title: string;
  phaseId: string | null;
  priority: Priority;
  dueDate: string | null;
  capabilityKeys: string[];
  source: FieldSource;
  manualFields: string[];
}

export interface WorkspaceSuggestion {
  /** 建议的根目录；没有用户明确路径时必须为 null，不得编造。 */
  rootPathHint: string | null;
  moduleHints: string[];
  note: string;
}

export interface ProjectDraft {
  name: string;
  kind: ProjectKind;
  goal: string;
  description: string;
  /** 只有用户明确给出日期才有值；相对期限放在 constraints。 */
  targetDate: string | null;
  phases: PhaseDraft[];
  capabilityRequirements: CapabilityRequirementDraft[];
  tasks: TaskDraft[];
  constraints: ProjectConstraint[];
  workspace: WorkspaceSuggestion;
  risks: string[];
  uncertainties: ProjectUncertainty[];
  templateId: string;
  source: FieldSource;
  /** 项目级手动字段（name/goal/targetDate/description）。 */
  manualFields: string[];
}

export type PlanChangeEntity =
  | "project"
  | "goal"
  | "phase"
  | "feature"
  | "milestone"
  | "capability"
  | "task"
  | "date"
  | "scope";

export type PlanChangeOp =
  | "add"
  | "remove"
  | "modify"
  | "move"
  | "regenerate";

export interface PlanChange {
  op: PlanChangeOp;
  entity: PlanChangeEntity;
  targetId: string | null;
  label: string;
  before: string | null;
  after: string | null;
  /** 删除已完成任务/阶段等高风险操作；必须二次确认。 */
  destructive: boolean;
  affectedTaskIds: string[];
}

export interface ProjectDraftRevision {
  instruction: string;
  changed: boolean;
  draft: ProjectDraft;
  changes: PlanChange[];
  /** 指令无法识别时的原因；changed=false 时必须说明，不得静默改写。 */
  unparsedReason: string | null;
}

export interface PlanningDiff {
  added: PlanChange[];
  removed: PlanChange[];
  modified: PlanChange[];
  destructive: PlanChange[];
  /** 因手动锁定而未被生成覆盖的字段。 */
  preservedManualFields: string[];
}

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  targetId: string | null;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

// ── 进度 ────────────────────────────────────────────────────────────────

export type ProgressSource = "tasks" | "phases" | "milestones" | "overall";

export interface ProgressMetric {
  completed: number;
  total: number;
  /** total=0 时为 null；禁止显示 0%。 */
  percent: number | null;
  source: ProgressSource;
  note: string;
}

export interface TaskProgressInput {
  id: string;
  status: "pending" | "completed";
  phaseId: string | null;
}

export interface DeliverableProgressInput {
  id: string;
  status: DeliverableStatus;
  required: boolean;
}

export interface FeatureProgressInput {
  id: string;
  status: FeatureStatus;
}

export interface PhaseProgressInput {
  id: string;
  title: string;
  features: FeatureProgressInput[];
  deliverables: DeliverableProgressInput[];
  /** 声明该阶段是否参与整体进度；默认 true。 */
  countsTowardOverall?: boolean;
}

export interface MilestoneProgressInput {
  id: string;
  completesAt: string | null;
  completed: boolean;
}

export interface ProgressSnapshot {
  tasks: ProgressMetric;
  phases: ProgressMetric;
  milestones: ProgressMetric;
  overall: ProgressMetric;
  computedAt: string;
}

export interface ProjectProgressInput {
  tasks: TaskProgressInput[];
  phases: PhaseProgressInput[];
  milestones: MilestoneProgressInput[];
  computedAt?: string;
}

// ── 能力 ────────────────────────────────────────────────────────────────

export interface CapabilityRequirementInput {
  capabilityId: string;
  name: string;
  category: CapabilityCategory;
  necessity: Necessity;
  /** 项目实测；null 表示未评估。 */
  assessmentLevel: Mastery | null;
  /** 能力库全局掌握度；assessmentLevel 为 null 时才使用。 */
  libraryMastery: Mastery;
  resource: ResourceAvailability;
  phaseId: string | null;
  impact: string;
  alternative: string;
}

export interface CapabilityLine {
  capabilityId: string;
  name: string;
  category: CapabilityCategory;
  necessity: Necessity;
  phaseId: string | null;
  /** 已解析的掌握度（项目实测优先）。 */
  mastery: Mastery;
  /** 该掌握度是否来自项目实测（false=来自能力库或未知）。 */
  masteryAssessed: boolean;
  resource: ResourceAvailability;
  impact: string;
  alternative: string;
  /** 单条能力是否满足项目要求。 */
  satisfied: boolean;
}

export interface CapabilityStatusResult {
  /** 仅统计已评估的必需/建议/可选能力；无数据为 null。 */
  masteryScore: number | null;
  resourceScore: number | null;
  assessedCount: number;
  unassessedCount: number;
  assessedRequired: number;
  unassessedRequired: number;
  label: CapabilityReadinessLabel;
  lines: CapabilityLine[];
  computedAt: string;
}

export interface CapabilityGap {
  capabilityId: string;
  name: string;
  necessity: Necessity;
  phaseId: string | null;
  mastery: Mastery;
  resource: ResourceAvailability;
  /** 缺口类型：未评估 / 能力缺失 / 仅缺资源。 */
  reason: "unassessed" | "missing" | "resource";
  impact: string;
  alternative: string;
  solutions: CapabilitySolution[];
}

export interface CapabilitySolution {
  kind: SolutionKind;
  label: string;
  rationale: string;
  target: { kind: ResourceKind; id: string } | null;
}

export interface ResourceCandidate {
  kind: ResourceKind;
  id: string;
  label: string;
  availability: ResourceAvailability;
}

export interface CapabilityGapResolution {
  capabilityId: string;
  solutionKind: SolutionKind;
  note: string;
  status: "proposed" | "applied" | "rejected";
}

// ── 项目 / 执行 / 工作空间 / 资源 / 总览 ────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  kind: ProjectKind;
  lifecycle: ProjectLifecycle;
  goal: string;
  targetDate: string | null;
  activePlanId: string | null;
  workspaceId: string | null;
  revision: number;
  updatedAt: string;
}

export interface PhaseSummary {
  id: string;
  title: string;
  order: number;
  status: "pending" | "active" | "completed" | "blocked";
  targetDate: string | null;
}

export interface ProjectTask {
  id: string;
  projectId: string | null;
  phaseId: string | null;
  milestoneId: string | null;
  title: string;
  status: "pending" | "completed";
  priority: Priority;
  dueDate: string | null;
  capabilityIds: string[];
  deliverableIds: string[];
}

export interface ProjectTaskFilter {
  phaseId?: string | null;
  status?: "pending" | "completed";
  capabilityId?: string;
  dueBefore?: string;
}

export interface TaskCreationPlan {
  accepted: TaskDraft[];
  skipped: Array<{ draftId: string; title: string; reason: string }>;
}

export interface TaskPlanLink {
  taskId: string;
  projectId: string;
  phaseId: string | null;
}

export interface TaskCapabilityLink {
  taskId: string;
  capabilityId: string;
}

export type RiskSeverity = "high" | "medium" | "low";

export type RiskKind =
  | "overdue"
  | "blocked_phase"
  | "capability_gap"
  | "milestone_late"
  | "missing_workspace"
  | "no_next_action";

export interface ProjectRisk {
  id: string;
  kind: RiskKind;
  severity: RiskSeverity;
  title: string;
  detail: string;
  sourceId: string | null;
  suggestion: string;
}

export type NextActionKind = "task" | "capability" | "deliverable" | "workspace" | "review";

export interface NextAction {
  id: string;
  kind: NextActionKind;
  title: string;
  detail: string;
  targetId: string | null;
}

export interface ProjectExecutionState {
  projectId: string;
  currentPhaseId: string | null;
  currentPhaseTitle: string | null;
  blockedPhaseIds: string[];
  nextMilestoneId: string | null;
  nextMilestoneTitle: string | null;
  pendingTaskCount: number;
  overdueTaskCount: number;
  lastActivityAt: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: ProjectKind;
  rootPath: string | null;
  projectId: string | null;
  moduleIds: string[];
  lastOpenedAt: string | null;
}

export interface WorkspaceLink {
  projectId: string;
  workspaceId: string;
  linkedAt: string;
}

export interface ProjectDeliverableRecord {
  id: string;
  projectId: string;
  phaseId: string | null;
  title: string;
  path: string;
  status: DeliverableStatus;
  required: boolean;
  recordedAt: string;
  acceptedAt: string | null;
  note: string;
}

export interface DeliverableInput {
  projectId: string;
  phaseId: string | null;
  title: string;
  path: string;
  required: boolean;
  note: string;
}

export interface WorkspaceFileFact {
  path: string;
  exists: boolean;
  modifiedAt: string | null;
}

export interface WorkspaceSyncResult {
  produced: string[];
  missing: string[];
  unchanged: string[];
  /** 文件变化只同步交付物事实，不触发整项目规划重算。 */
  recomputePlan: false;
}

export interface MilestoneSummary {
  id: string;
  title: string;
  targetDate: string | null;
  completed: boolean;
}

export interface WorkspaceProjectContext {
  projectId: string;
  projectName: string;
  goal: string;
  currentPhase: PhaseSummary | null;
  phases: PhaseSummary[];
  tasks: { total: number; pending: number; overdue: number };
  capability: CapabilityStatusResult;
  milestones: MilestoneSummary[];
  deliverables: ProjectDeliverableRecord[];
  progress: ProgressSnapshot;
  stale: boolean;
}

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
  label: string;
}

export interface ProjectResourceLink {
  id: string;
  projectId: string;
  resource: ResourceRef;
  linkedAt: string;
  lastVerifiedAt: string | null;
  availability: ResourceAvailability;
}

export interface ResourceProbe {
  resource: ResourceRef;
  exists: boolean;
  availability: ResourceAvailability;
  checkedAt: string;
  detail: string;
}

export interface CapabilityResourceRelation {
  capabilityId: string;
  resourceKind: ResourceKind;
  resourceId: string;
}

export interface ResourceDeleteBlocker {
  resource: ResourceRef;
  projectIds: string[];
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  type: string;
  title: string;
  occurredAt: string;
  sourceId: string | null;
}

export interface ProjectOverview {
  project: ProjectSummary;
  goal: string;
  currentPhase: PhaseSummary | null;
  progress: ProgressSnapshot;
  capability: CapabilityStatusResult;
  risks: ProjectRisk[];
  nextActions: NextAction[];
  recentDeliverables: ProjectDeliverableRecord[];
  recentEvents: ProjectEvent[];
  computedAt: string;
  stale: boolean;
}

export interface IntegrityIssue {
  code: string;
  severity: "blocking" | "warning";
  message: string;
  entityId: string | null;
}

export interface IntegrityReport {
  ok: boolean;
  issues: IntegrityIssue[];
}
