//! 开发工作空间（D1）IPC 唯一出口：所有命令经共享 `creativeInvoke`，
//! 不在组件里直接 `import { invoke }`，也不改 `src/lib/bridge.ts`。

import { creativeInvoke } from "../ipc";
import type {
  DwsBuildTrace,
  DwsDevelopmentSummary,
  DwsGitRisk,
  DwsTaskHandoff,
  DwsTaskLink,
} from "./types";

/** E1：开发项目关联摘要（仓库 / 任务 / 只读 Git 摘要）。 */
export const dwsDevelopmentSummary = (projectId: string) =>
  creativeInvoke<{ summary: DwsDevelopmentSummary }>("dws_development_summary", {
    projectId,
  });

/** E1/E2/E3：保存一条显式关联（同键幂等更新）。 */
export const dwsTaskLinkSave = (input: {
  projectId: string;
  taskId?: string | null;
  devProjectId?: string | null;
  handoffPackId?: string | null;
  buildId?: string | null;
  acceptanceRecordId?: string | null;
  note?: string | null;
}) =>
  creativeInvoke<{ link: DwsTaskLink }>("dws_task_link_save", {
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    devProjectId: input.devProjectId ?? null,
    handoffPackId: input.handoffPackId ?? null,
    buildId: input.buildId ?? null,
    acceptanceRecordId: input.acceptanceRecordId ?? null,
    note: input.note ?? null,
  });

export const dwsTaskLinkList = (projectId: string, taskId?: string | null) =>
  creativeInvoke<{ links: DwsTaskLink[] }>("dws_task_link_list", {
    projectId,
    taskId: taskId ?? null,
  });

export const dwsTaskLinkDelete = (projectId: string, linkId: string) =>
  creativeInvoke<{ ok: boolean }>("dws_task_link_delete", { projectId, linkId });

/** E2：单任务接续视图（交接包 / Agent 轮次 / 人工验收记录）。 */
export const dwsTaskHandoff = (projectId: string, taskId: string) =>
  creativeInvoke<{ handoff: DwsTaskHandoff }>("dws_task_handoff", { projectId, taskId });

/** E3：构建与验收追溯（只读解析集成台账）。 */
export const dwsBuildTrace = (projectId: string, ledgerDir?: string | null) =>
  creativeInvoke<{ trace: DwsBuildTrace }>("dws_build_trace", {
    projectId,
    ledgerDir: ledgerDir ?? null,
  });

/** E4：Git / Worktree 风险探测（只读）。 */
export const dwsGitRiskProbe = (projectId: string, ledgerDir?: string | null) =>
  creativeInvoke<{ risk: DwsGitRisk }>("dws_git_risk_probe", {
    projectId,
    ledgerDir: ledgerDir ?? null,
  });

/** 既有命令：在系统资源管理器中打开目录（只读打开，不改动仓库）。 */
export const dwsRevealPath = (path: string) =>
  creativeInvoke<void>("fs_reveal", { path });

/** 既有命令：打开开发工作台窗口（既有导航机制，目标为当前工作空间项目）。 */
export const dwsOpenDevWorkbench = (projectId: string | null) =>
  creativeInvoke<{ opened: boolean; projectId: string | null; requestId: number | null }>(
    "open_project_workspace_window",
    { projectId, requestId: null },
  );
