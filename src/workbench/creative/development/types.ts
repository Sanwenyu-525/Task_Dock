//! 开发工作空间（D1）前端类型契约，与 Rust `development_workspace.rs` 返回结构一一对应。
//!
//! 复用 bridge 已导出的 dev_workbench 类型；本文件只补 D1 自己的关联 / 追溯 / 风险模型。

import type {
  DevAcceptanceRecord,
  DevAgentRunCandidate,
  DevGitInfo,
  DevHandoffPack,
} from "../../../lib/bridge";

export type {
  DevAcceptanceRecord,
  DevAgentRunCandidate,
  DevGitInfo,
  DevHandoffPack,
};

/** 关联到本开发项目的一个开发仓库。 */
export interface DwsDevProjectRef {
  devProjectId: string;
  name: string;
  rootPath: string;
  /** 目录当前是否存在（false = 失效，前端如实降级，不自动重建）。 */
  exists: boolean;
  note: string;
  /** weak_ref = workspace_projects 既有弱引用；manual = 手工关联。 */
  linkOrigin: "weak_ref" | "manual" | string;
  git: DevGitInfo;
}

/** 关联到本开发项目的既有任务（弱引用 tasks）。 */
export interface DwsTaskRef {
  taskId: string;
  title: string;
  status: string;
  priority: number;
  dueAt: string | null;
  linkOrigin: "workspace_link" | "manual" | string;
}

export interface DwsDevelopmentSummary {
  projectId: string;
  projectName: string;
  kind: string;
  archived: boolean;
  weakDevProjectId: string | null;
  devProjects: DwsDevProjectRef[];
  tasks: DwsTaskRef[];
}

/** 一条显式关联（项目 ↔ 仓库 / 任务 / 交接包 / 构建 / 验收记录）。 */
export interface DwsTaskLink {
  id: string;
  projectId: string;
  devProjectId: string | null;
  devProjectName: string | null;
  taskId: string;
  taskTitle: string | null;
  handoffPackId: string;
  handoffTitle: string | null;
  buildId: string;
  acceptanceRecordId: string;
  acceptanceVerdict: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 单任务接续视图：交接包 / Agent 轮次 / 人工验收记录。 */
export interface DwsTaskHandoff {
  taskId: string;
  taskTitle: string | null;
  taskStatus: string | null;
  packs: DevHandoffPack[];
  agentCandidates: DevAgentRunCandidate[];
  acceptanceRecords: DevAcceptanceRecord[];
  links: DwsTaskLink[];
  /** 最新人工验收结论；无记录 = null。**只有这里代表验收结论**。 */
  latestAcceptanceVerdict: string | null;
  acceptanceRecordCount: number;
  /** 是否存在 Agent 自述完成的轮次（仅事实，不等于验收通过）。 */
  agentSelfReportedCompleted: boolean;
}

export interface DwsLedgerCheck {
  cmd: string;
  exitCode: number | null;
  at: string;
  logPath: string | null;
}

export interface DwsLedgerTask {
  id: string;
  module: string;
  owner: string;
  status: string;
  paths: string[];
  snapshot: string | null;
  buildId: string | null;
  acceptance: string | null;
  notes: string;
  updatedAt: string;
  checks: DwsLedgerCheck[];
  /** 记录来源仓库（多仓库聚合时必须能追溯到具体仓库）。 */
  repoName: string;
  repoRoot: string;
}

export interface DwsLedgerArtifact {
  name: string;
  kind: string;
  files: number | null;
  bytes: number | null;
  sha256: string | null;
}

export interface DwsLedgerBuild {
  id: string;
  snapshot: string | null;
  commit: string | null;
  shortCommit: string | null;
  dirty: boolean | null;
  platform: string;
  config: string;
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  tasks: string[];
  logPath: string | null;
  artifacts: DwsLedgerArtifact[];
  host: string;
  repoName: string;
  repoRoot: string;
}

export interface DwsLedgerSnapshot {
  id: string;
  branch: string | null;
  base: string | null;
  commit: string | null;
  tasks: string[];
  note: string;
  createdAt: string | null;
  repoName: string;
  repoRoot: string;
}

/** 一个台账来源：某仓库自己的 `tmp/integration`，或本次手工指定的目录。 */
export interface DwsLedgerSource {
  devProjectId: string | null;
  name: string;
  repoRoot: string;
  ledgerDir: string | null;
  available: boolean;
  /** 不可用原因，或「部分文件被跳过 / 记录被截断」的如实说明。 */
  reason: string | null;
  taskCount: number;
  snapshotCount: number;
  buildCount: number;
  truncated: boolean;
}

export interface DwsBuildTrace {
  ledgerAvailable: boolean;
  ledgerRoot: string | null;
  ledgerReason: string | null;
  tasks: DwsLedgerTask[];
  snapshots: DwsLedgerSnapshot[];
  builds: DwsLedgerBuild[];
  links: DwsTaskLink[];
  acceptanceRecords: DevAcceptanceRecord[];
  /** 本次参与解析的台账来源（可用与不可用都列出，便于排查「为什么没数据」）。 */
  sources: DwsLedgerSource[];
}

export interface DwsChangedFile {
  path: string;
  status: string;
  group: string;
}

export interface DwsRiskFlag {
  level: "info" | "warn" | string;
  code: string;
  message: string;
  files: string[];
}

export interface DwsRepoRisk {
  devProjectId: string | null;
  name: string;
  rootPath: string;
  exists: boolean;
  git: DevGitInfo;
  changedFiles: DwsChangedFile[];
  truncated: boolean;
  /** 改动清单是否真的读到了。false（超时 / git 缺失 / 非仓库）时不得当成「零改动」。 */
  changedFilesKnown: boolean;
  risks: DwsRiskFlag[];
}

/** 一条本机探测快照摘要（最多 20 条，不跨机同步、不作为验收依据）。 */
export interface DwsProbeSnapshot {
  id: string;
  probedAt: string;
  gitStatus: string;
  branch: string | null;
  headSha: string | null;
  dirtyCount: number | null;
  repoCount: number;
  truncated: boolean;
}

export interface DwsGitRisk {
  repos: DwsRepoRisk[];
  risks: DwsRiskFlag[];
  advice: string;
  persisted: boolean;
  /** 最近的本机探测快照（最多 5 条）；仅用于核对本次探测，不代表验收历史。 */
  history: DwsProbeSnapshot[];
}

/** 验收结论徽标文案（与既有 acceptanceStatus 口径一致）。 */
export const VERDICT_LABELS: Record<string, string> = {
  pass: "通过",
  fail: "未通过",
  blocked: "阻塞",
  not_verified: "证据不足",
};
