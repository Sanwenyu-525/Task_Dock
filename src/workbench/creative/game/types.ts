//! 游戏工作空间前端类型（G1，2026-11-16）。
//!
//! 与 `src-tauri/src/commands/game_workspace.rs` 的返回模型一一对应；字段 camelCase。

/** 引擎类型（与后端 CHECK 约束一致）。 */
export type GameEngine = "unity" | "unreal" | "godot" | "custom" | "unknown";
/** 识别方式：自动扫描 / 用户手动指定。 */
export type GameDetectionMethod = "auto" | "manual" | "unknown";
/** 资源类型。 */
export type GameAssetKind =
  | "image"
  | "model"
  | "audio"
  | "animation"
  | "scene"
  | "config"
  | "other";
/** 构建状态。 */
export type GameBuildStatus = "planned" | "success" | "failed" | "canceled" | "unknown";
/** 测试结果。 */
export type GameTestResult = "passed" | "failed" | "blocked" | "skipped" | "unknown";

export interface GameProjectFact {
  id: string;
  projectId: string;
  engine: GameEngine;
  detectionMethod: GameDetectionMethod;
  engineVersion: string;
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface GameDetectionReport {
  engine: GameEngine;
  engineVersion: string;
  evidence: string[];
  /** 多引擎标记冲突：除胜出引擎外其余命中的特征标记；无冲突为空。 */
  conflicts: string[];
  rootExists: boolean;
  rootPath: string;
}

export interface GameAsset {
  id: string;
  projectId: string;
  kind: GameAssetKind;
  name: string;
  path: string;
  relativePath: string;
  /** inside = 项目根目录内；outside = 根目录之外（已标注，未复制文件）。 */
  location: "inside" | "outside";
  sizeBytes: number;
  modifiedAt: string;
  itemId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 读时计算：登记路径当前是否存在。 */
  pathExists: boolean;
  /** 读时计算：关联事项是否仍存在（弱引用）。 */
  itemExists: boolean;
}

export interface GameBuild {
  id: string;
  projectId: string;
  target: string;
  engine: string;
  config: string;
  status: GameBuildStatus;
  builtAt: string;
  logPath: string;
  logSummary: string;
  artifactPath: string;
  /** 本轮恒为 manual：手动登记，未接入引擎执行器。 */
  source: "manual" | "imported";
  itemId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  logExists: boolean;
  artifactExists: boolean;
  /** 读时计算：关联事项是否仍存在（弱引用）。 */
  itemExists: boolean;
}

export interface GameTestRecord {
  id: string;
  projectId: string;
  buildId: string | null;
  title: string;
  scope: string;
  result: GameTestResult;
  testedAt: string;
  summary: string;
  defectCount: number;
  itemId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 读时计算：关联构建是否仍存在（弱引用）。 */
  buildExists: boolean;
  /** 读时计算：关联事项是否仍存在（弱引用）。 */
  itemExists: boolean;
}

/**
 * 游戏项目概览统计（项目中枢「专业工作进展」摘要）。
 *
 * 与 `game_workspace.rs::GameOverviewStats` 一一对应：后端整表聚合，不加载
 * 资源/构建/测试行，也不扫描产物与日志。`latestBuildAt/Status` 无记录时为 `null`，
 * `updatedAt` 空项目为 `null`（不伪造成功或默认状态）。
 */
export interface GameOverviewStats {
  projectId: string;
  assetCount: number;
  buildCount: number;
  successfulBuildCount: number;
  failedBuildCount: number;
  plannedBuildCount: number;
  testCount: number;
  passedTestCount: number;
  failedTestCount: number;
  blockedTestCount: number;
  latestBuildAt: string | null;
  latestBuildStatus: string | null;
  updatedAt: string | null;
}

/** 制作事项分类（承载在 `workspace_items.metadataJson.category`）。 */
export const GAME_ITEM_CATEGORIES = [
  { value: "system", label: "游戏系统" },
  { value: "mechanic", label: "玩法机制" },
  { value: "level", label: "关卡" },
  { value: "ui", label: "UI" },
  { value: "character", label: "角色" },
  { value: "scene", label: "场景" },
  { value: "audio", label: "音频" },
  { value: "animation", label: "动画" },
  { value: "test", label: "测试" },
  { value: "bugfix", label: "Bug 修复" },
] as const;

export type GameItemCategory = (typeof GAME_ITEM_CATEGORIES)[number]["value"];

export const GAME_ASSET_KINDS: ReadonlyArray<{ value: GameAssetKind; label: string }> = [
  { value: "image", label: "图片" },
  { value: "model", label: "模型" },
  { value: "audio", label: "音频" },
  { value: "animation", label: "动画" },
  { value: "scene", label: "场景" },
  { value: "config", label: "配置文件" },
  { value: "other", label: "其他" },
];

export const GAME_BUILD_STATUSES: ReadonlyArray<{ value: GameBuildStatus; label: string }> = [
  { value: "planned", label: "计划中" },
  { value: "success", label: "构建成功" },
  { value: "failed", label: "构建失败" },
  { value: "canceled", label: "已取消" },
  { value: "unknown", label: "未知" },
];

export const GAME_TEST_RESULTS: ReadonlyArray<{ value: GameTestResult; label: string }> = [
  { value: "passed", label: "通过" },
  { value: "failed", label: "失败" },
  { value: "blocked", label: "阻塞" },
  { value: "skipped", label: "跳过" },
  { value: "unknown", label: "未知" },
];

export const GAME_ENGINES: ReadonlyArray<{ value: GameEngine; label: string }> = [
  { value: "unity", label: "Unity" },
  { value: "unreal", label: "Unreal" },
  { value: "godot", label: "Godot" },
  { value: "custom", label: "自定义引擎" },
  { value: "unknown", label: "未知" },
];

export function categoryLabel(value: string): string {
  return GAME_ITEM_CATEGORIES.find((c) => c.value === value)?.label ?? "未分类";
}

export function assetKindLabel(value: string): string {
  return GAME_ASSET_KINDS.find((k) => k.value === value)?.label ?? value;
}

export function buildStatusLabel(value: string): string {
  return GAME_BUILD_STATUSES.find((s) => s.value === value)?.label ?? value;
}

export function testResultLabel(value: string): string {
  return GAME_TEST_RESULTS.find((r) => r.value === value)?.label ?? value;
}

export function engineLabel(value: string): string {
  return GAME_ENGINES.find((e) => e.value === value)?.label ?? value;
}
