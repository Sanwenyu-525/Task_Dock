//! 项目中枢「专业工作进展」适配层（2026-11-23）。
//!
//! ## 职责边界
//! - 项目中枢只负责**统一展示**：本层把五种专业工作空间的只读统计收敛成一个
//!   `ProjectDomainSummary` 联合类型，供同一个 UI 外壳渲染；
//! - 专业工作空间仍是各自领域数据的唯一事实来源：这里只调用既有
//!   （小说 / 开发 / 通用）或本轮新增的轻量聚合接口（漫剧 / 游戏），
//!   不执行 SQL、不用多个列表接口拼统计、不复制数据到公共项目表；
//! - 领域类型必须来自真实后端 DTO，禁止 `any` 或按项目名称猜测类型。
//!
//! ## 空数据语义
//! `fetchProjectDomainSummary` 成功返回真实零值；「有没有专业数据」由
//! `isDomainSummaryEmpty` 单独判断，UI 用「暂无专业数据」表达，而不是渲染一排 0。

import { comicOverviewStats } from "../../workbench/creative/comic/ipc";
import type { ComicOverviewStats } from "../../workbench/creative/comic/types";
import { dwsDevelopmentSummary } from "../../workbench/creative/development/ipc";
import type { DwsDevelopmentSummary } from "../../workbench/creative/development/types";
import { gameOverviewStats } from "../../workbench/creative/game/ipc";
import type { GameOverviewStats } from "../../workbench/creative/game/types";
import { generalStats, type GeneralStats } from "../../workbench/creative/general/ipc";
import { novelOverviewStats } from "../../workbench/creative/novel/ipc";
import type { NovelOverviewStats } from "../../workbench/creative/novel/types";

/** 已接入专业摘要的项目类型（与 `ProjectKind` 同名，避免再定义一套枚举）。 */
export type SupportedDomainKind = "novel" | "ai_comic" | "game" | "development" | "general";

export const SUPPORTED_DOMAIN_KINDS: readonly SupportedDomainKind[] = [
  "novel",
  "ai_comic",
  "game",
  "development",
  "general",
];

export function isSupportedDomainKind(kind: string): kind is SupportedDomainKind {
  return (SUPPORTED_DOMAIN_KINDS as readonly string[]).includes(kind);
}

/**
 * 统一展示模型：`kind` 与 `data` 强绑定，渲染侧靠它做穷尽分支，
 * 不会出现「小说类型渲染漫剧字段」这种错配。
 */
export type ProjectDomainSummary =
  | { kind: "novel"; data: NovelOverviewStats }
  | { kind: "ai_comic"; data: ComicOverviewStats }
  | { kind: "game"; data: GameOverviewStats }
  | { kind: "development"; data: DwsDevelopmentSummary }
  | { kind: "general"; data: GeneralStats };

/** 区块标题（UI 与测试共用同一份文案）。 */
export const DOMAIN_SUMMARY_TITLE = "专业工作进展";

/**
 * 按项目类型调用对应的**唯一**统计接口（每种类型一次 IPC）。
 *
 * 开发 / 通用的后端返回带外层包装（`{summary}` / `{stats}`），这里只解包，
 * 不在前端合成任何二次统计。
 */
export async function fetchProjectDomainSummary(
  projectId: string,
  kind: SupportedDomainKind,
): Promise<ProjectDomainSummary> {
  switch (kind) {
    case "novel":
      return { kind, data: await novelOverviewStats(projectId) };
    case "ai_comic":
      return { kind, data: await comicOverviewStats(projectId) };
    case "game":
      return { kind, data: await gameOverviewStats(projectId) };
    case "development": {
      const { summary } = await dwsDevelopmentSummary(projectId);
      return { kind, data: summary };
    }
    case "general": {
      const { stats } = await generalStats(projectId);
      return { kind, data: stats };
    }
  }
}

/**
 * 摘要归属校验：带 `projectId` 的领域 DTO 必须与请求的项目一致。
 *
 * 小说 / 通用 DTO 没有项目 ID 字段，后端已按 `projectId` 参数限定作用域，
 * 这里不做无意义的猜测；漫剧 / 游戏 / 开发带 ID，用于兜住错项目响应。
 */
export function summaryBelongsToProject(
  summary: ProjectDomainSummary,
  projectId: string,
): boolean {
  switch (summary.kind) {
    case "ai_comic":
    case "game":
    case "development":
      return summary.data.projectId === projectId;
    case "novel":
    case "general":
      return true;
  }
}

/**
 * 「没有任何专业数据」：用真实零值判断，不看项目名称或任务数。
 *
 * 只作为 UI 空态开关，不参与任何进度计算——领域空 ≠ 项目没进度。
 */
export function isDomainSummaryEmpty(summary: ProjectDomainSummary): boolean {
  switch (summary.kind) {
    case "novel": {
      const d = summary.data;
      return (
        d.volumes === 0 &&
        d.chapters === 0 &&
        d.words === 0 &&
        d.characters === 0 &&
        d.worldviews === 0
      );
    }
    case "ai_comic": {
      const d = summary.data;
      return (
        d.episodeCount === 0 &&
        d.shotCount === 0 &&
        d.characterCount === 0 &&
        d.sceneCount === 0 &&
        d.mediaCount === 0
      );
    }
    case "game": {
      const d = summary.data;
      return d.assetCount === 0 && d.buildCount === 0 && d.testCount === 0;
    }
    case "development": {
      const d = summary.data;
      return d.devProjects.length === 0 && d.tasks.length === 0;
    }
    case "general": {
      const d = summary.data;
      return (
        d.totalItems === 0 &&
        d.milestonesTotal === 0 &&
        d.linkedTasks === 0 &&
        d.materialsTotal === 0
      );
    }
  }
}

/**
 * 领域数据最近更新时间；没有该字段的领域返回 `null`（UI 不渲染「更新于」）。
 *
 * 只有漫剧 / 游戏的后端摘要带 `updatedAt`，且空项目为 `null`——
 * 绝不退化成「当前时间」。
 */
export function domainSummaryUpdatedAt(summary: ProjectDomainSummary): string | null {
  switch (summary.kind) {
    case "ai_comic":
    case "game":
      return summary.data.updatedAt;
    case "novel":
    case "development":
    case "general":
      return null;
  }
}

/**
 * 字数口径：后端 `word_count` 是真实正文字数；这里只做千分位与「万字」缩写，
 * 不做任何换算误差判断（例如四舍五入到 0.1 万）。
 */
export function formatWordCount(words: number): string {
  if (!Number.isFinite(words) || words < 0) return "未知";
  if (words >= 10_000) {
    const wan = words / 10_000;
    return `${wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10} 万字`;
  }
  return `${Math.round(words)} 字`;
}

/** 时间只展示到日：摘要不承担精确时序，完整时间在专业工作空间里看。 */
export function formatSummaryDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  return date.length === 10 ? date : null;
}

/** 百分比：分母为 0 或非法时返回 `null`，UI 显示「待评估」而不是 0%。 */
export function safePercent(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  const raw = (part / total) * 100;
  return Math.min(100, Math.max(0, Math.round(raw)));
}
