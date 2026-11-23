//! 游戏线 IPC 唯一包装层（G1，2026-11-16）。
//!
//! 所有命令经 `creativeInvoke` 出口；禁止在组件里直接 `import { invoke }`。
//! 制作事项复用既有 `workspace_item_*` 命令，不另建事项表。

import { creativeInvoke } from "../ipc";
import type { WorkspaceItem, WorkspaceItemStatus } from "../../../lib/bridge";
import type {
  GameAsset,
  GameBuild,
  GameDetectionReport,
  GameOverviewStats,
  GameProjectFact,
  GameTestRecord,
} from "./types";

// ── 引擎识别事实 ────────────────────────────────────────────────────────

export function gameProjectDetect(projectId: string) {
  return creativeInvoke<{
    detection: GameDetectionReport;
    facts: GameProjectFact | null;
  }>("game_project_detect", { projectId });
}

export function gameProjectFactsGet(projectId: string) {
  return creativeInvoke<{ facts: GameProjectFact | null }>("game_project_facts_get", {
    projectId,
  });
}

export function gameProjectFactsSave(input: {
  projectId: string;
  engine: string;
  detectionMethod: string;
  evidence?: string | null;
  engineVersion?: string | null;
}) {
  return creativeInvoke<{ facts: GameProjectFact }>("game_project_facts_save", {
    projectId: input.projectId,
    engine: input.engine,
    detectionMethod: input.detectionMethod,
    evidence: input.evidence ?? null,
    engineVersion: input.engineVersion ?? null,
  });
}

// ── 游戏资源 ───────────────────────────────────────────────────────────

export function gameAssetList(projectId: string) {
  return creativeInvoke<{ assets: GameAsset[] }>("game_asset_list", { projectId });
}

export function gameAssetSave(input: {
  id?: string | null;
  projectId: string;
  kind: string;
  name: string;
  path: string;
  itemId?: string | null;
  note?: string | null;
}) {
  return creativeInvoke<{ asset: GameAsset }>("game_asset_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    kind: input.kind,
    name: input.name,
    path: input.path,
    itemId: input.itemId ?? null,
    note: input.note ?? null,
  });
}

export function gameAssetDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("game_asset_delete", { id });
}

// ── 构建记录 ────────────────────────────────────────────────────────────

export function gameBuildList(projectId: string) {
  return creativeInvoke<{ builds: GameBuild[] }>("game_build_list", { projectId });
}

export function gameBuildSave(input: {
  id?: string | null;
  projectId: string;
  target: string;
  engine?: string | null;
  config?: string | null;
  status: string;
  builtAt?: string | null;
  logPath?: string | null;
  logSummary?: string | null;
  artifactPath?: string | null;
  itemId?: string | null;
  note?: string | null;
}) {
  return creativeInvoke<{ build: GameBuild }>("game_build_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    target: input.target,
    engine: input.engine ?? null,
    config: input.config ?? null,
    status: input.status,
    builtAt: input.builtAt ?? null,
    logPath: input.logPath ?? null,
    logSummary: input.logSummary ?? null,
    artifactPath: input.artifactPath ?? null,
    itemId: input.itemId ?? null,
    note: input.note ?? null,
  });
}

export function gameBuildDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("game_build_delete", { id });
}

// ── 测试记录 ───────────────────────────────────────────────────────────

export function gameTestList(projectId: string) {
  return creativeInvoke<{ tests: GameTestRecord[] }>("game_test_list", { projectId });
}

export function gameTestSave(input: {
  id?: string | null;
  projectId: string;
  buildId?: string | null;
  title: string;
  scope?: string | null;
  result: string;
  testedAt?: string | null;
  summary?: string | null;
  defectCount?: number | null;
  itemId?: string | null;
  note?: string | null;
}) {
  return creativeInvoke<{ test: GameTestRecord }>("game_test_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    buildId: input.buildId ?? null,
    title: input.title,
    scope: input.scope ?? null,
    result: input.result,
    testedAt: input.testedAt ?? null,
    summary: input.summary ?? null,
    defectCount: input.defectCount ?? null,
    itemId: input.itemId ?? null,
    note: input.note ?? null,
  });
}

export function gameTestDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("game_test_delete", { id });
}

// ── 项目概览统计（项目中枢专业摘要）────────────────────────────────────

/**
 * 游戏项目概览统计：后端一次只读聚合，只按 `projectId` 作用域统计，
 * 不加载资源/构建/测试行，不扫描产物与日志，也不触发任何构建或探测。
 */
export function gameOverviewStats(projectId: string) {
  return creativeInvoke<GameOverviewStats>("game_overview_stats", { projectId });
}

// ── 既有制作事项（复用 workspace_items，不另建表）─────────────────────────

export function workspaceItemList(projectId: string) {
  return creativeInvoke<{ items: WorkspaceItem[] }>("workspace_item_list", { projectId });
}

export function workspaceItemSave(input: {
  id?: string | null;
  projectId: string;
  title: string;
  stage?: string | null;
  status?: WorkspaceItemStatus | null;
  metadataJson?: string | null;
}) {
  return creativeInvoke<{ item: WorkspaceItem }>("workspace_item_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    parentId: null,
    title: input.title,
    stage: input.stage ?? null,
    status: input.status ?? null,
    sortOrder: null,
    metadataJson: input.metadataJson ?? null,
  });
}

export function workspaceItemDelete(id: string) {
  return creativeInvoke<{ ok: true }>("workspace_item_delete", { id });
}

/** 只读打开原文件（系统默认程序；不修改文件内容）。 */
export function fsOpen(path: string) {
  return creativeInvoke<null>("fs_open", { path });
}
