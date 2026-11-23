/**
 * @vitest-environment node
 */
//! 专业摘要适配层单测：类型路由、解包、空态判定、归属校验与格式化。

import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  novelOverviewStats: vi.fn(),
  comicOverviewStats: vi.fn(),
  gameOverviewStats: vi.fn(),
  dwsDevelopmentSummary: vi.fn(),
  generalStats: vi.fn(),
}));

vi.mock("../../workbench/creative/novel/ipc", () => ({
  novelOverviewStats: ipc.novelOverviewStats,
}));
vi.mock("../../workbench/creative/comic/ipc", () => ({
  comicOverviewStats: ipc.comicOverviewStats,
}));
vi.mock("../../workbench/creative/game/ipc", () => ({
  gameOverviewStats: ipc.gameOverviewStats,
}));
vi.mock("../../workbench/creative/development/ipc", () => ({
  dwsDevelopmentSummary: ipc.dwsDevelopmentSummary,
}));
vi.mock("../../workbench/creative/general/ipc", () => ({
  generalStats: ipc.generalStats,
}));

import {
  emptyComicStats,
  emptyDevSummary,
  emptyGameStats,
  emptyGeneralStats,
  emptyNovelStats,
  comicStats,
  devSummary,
  gameStats,
  generalStatsData,
  novelStats,
} from "./projectHubDomainFixtures";
import {
  SUPPORTED_DOMAIN_KINDS,
  domainSummaryUpdatedAt,
  fetchProjectDomainSummary,
  formatSummaryDate,
  formatWordCount,
  isDomainSummaryEmpty,
  isSupportedDomainKind,
  safePercent,
  summaryBelongsToProject,
} from "./projectHubDomainAdapter";

beforeEach(() => {
  vi.clearAllMocks();
  ipc.novelOverviewStats.mockResolvedValue(novelStats());
  ipc.comicOverviewStats.mockResolvedValue(comicStats());
  ipc.gameOverviewStats.mockResolvedValue(gameStats());
  ipc.dwsDevelopmentSummary.mockResolvedValue({ summary: devSummary() });
  ipc.generalStats.mockResolvedValue({ stats: generalStatsData() });
});

describe("专业摘要适配层", () => {
  it("五种类型各自只调用一个对应统计接口，并保留 kind 判别", async () => {
    const novel = await fetchProjectDomainSummary("p-novel", "novel");
    expect(novel.kind).toBe("novel");
    expect(ipc.novelOverviewStats).toHaveBeenCalledWith("p-novel");
    expect(ipc.comicOverviewStats).not.toHaveBeenCalled();

    const comic = await fetchProjectDomainSummary("p-comic", "ai_comic");
    expect(comic.kind).toBe("ai_comic");
    expect(ipc.comicOverviewStats).toHaveBeenCalledWith("p-comic");

    const game = await fetchProjectDomainSummary("p-game", "game");
    expect(game.kind).toBe("game");
    expect(ipc.gameOverviewStats).toHaveBeenCalledWith("p-game");

    const dev = await fetchProjectDomainSummary("p-dev", "development");
    expect(dev.kind).toBe("development");
    if (dev.kind === "development") {
      // 解包 `{ summary }`，不在前端二次统计
      expect(dev.data.projectId).toBe("p-dev");
    }
    expect(ipc.dwsDevelopmentSummary).toHaveBeenCalledWith("p-dev");

    const general = await fetchProjectDomainSummary("p-general", "general");
    expect(general.kind).toBe("general");
    if (general.kind === "general") {
      expect(general.data.totalItems).toBe(9);
    }
    expect(ipc.generalStats).toHaveBeenCalledWith("p-general");
  });

  it("未接入的项目类型不会被当成已支持", () => {
    expect(SUPPORTED_DOMAIN_KINDS).toHaveLength(5);
    expect(isSupportedDomainKind("novel")).toBe(true);
    expect(isSupportedDomainKind("other")).toBe(false);
    expect(isSupportedDomainKind("")).toBe(false);
  });

  it("归属校验只对带 projectId 的 DTO 生效", () => {
    const comic = { kind: "ai_comic" as const, data: comicStats({ projectId: "p-a" }) };
    expect(summaryBelongsToProject(comic, "p-a")).toBe(true);
    expect(summaryBelongsToProject(comic, "p-b")).toBe(false);

    const game = { kind: "game" as const, data: gameStats({ projectId: "p-a" }) };
    expect(summaryBelongsToProject(game, "p-b")).toBe(false);

    const dev = { kind: "development" as const, data: devSummary({ projectId: "p-a" }) };
    expect(summaryBelongsToProject(dev, "p-b")).toBe(false);

    const novel = { kind: "novel" as const, data: novelStats() };
    const general = { kind: "general" as const, data: generalStatsData() };
    expect(summaryBelongsToProject(novel, "p-b")).toBe(true);
    expect(summaryBelongsToProject(general, "p-b")).toBe(true);
  });

  it("空态按真实零值判定，不会把「只有任务」当成有专业数据", () => {
    expect(isDomainSummaryEmpty({ kind: "novel", data: emptyNovelStats() })).toBe(true);
    expect(isDomainSummaryEmpty({ kind: "novel", data: novelStats() })).toBe(false);

    expect(isDomainSummaryEmpty({ kind: "ai_comic", data: emptyComicStats() })).toBe(true);
    expect(isDomainSummaryEmpty({ kind: "ai_comic", data: comicStats() })).toBe(false);

    expect(isDomainSummaryEmpty({ kind: "game", data: emptyGameStats() })).toBe(true);
    expect(isDomainSummaryEmpty({ kind: "game", data: gameStats() })).toBe(false);

    expect(isDomainSummaryEmpty({ kind: "development", data: emptyDevSummary() })).toBe(true);
    expect(isDomainSummaryEmpty({ kind: "development", data: devSummary() })).toBe(false);

    expect(isDomainSummaryEmpty({ kind: "general", data: emptyGeneralStats() })).toBe(true);
    expect(isDomainSummaryEmpty({ kind: "general", data: generalStatsData() })).toBe(false);
  });

  it("只有漫剧/游戏提供最近更新时间，空项目不伪造时间", () => {
    expect(domainSummaryUpdatedAt({ kind: "ai_comic", data: comicStats() })).toBe(
      "2026-11-22T09:00:00+08:00",
    );
    expect(domainSummaryUpdatedAt({ kind: "game", data: gameStats() })).toBe(
      "2026-11-21T18:30:00+08:00",
    );
    expect(domainSummaryUpdatedAt({ kind: "ai_comic", data: emptyComicStats() })).toBeNull();
    expect(domainSummaryUpdatedAt({ kind: "novel", data: novelStats() })).toBeNull();
    expect(domainSummaryUpdatedAt({ kind: "general", data: generalStatsData() })).toBeNull();
  });

  it("字数与百分比格式化不制造精度幻觉", () => {
    expect(formatWordCount(0)).toBe("0 字");
    expect(formatWordCount(999)).toBe("999 字");
    expect(formatWordCount(12_000)).toBe("1.2 万字");
    expect(formatWordCount(1_860_000)).toBe("186 万字");
    expect(formatWordCount(Number.NaN)).toBe("未知");

    expect(safePercent(10, 40)).toBe(25);
    expect(safePercent(0, 0)).toBeNull();
    expect(safePercent(5, 0)).toBeNull();
    expect(safePercent(50, 40)).toBe(100);

    expect(formatSummaryDate("2026-11-22T09:00:00+08:00")).toBe("2026-11-22");
    expect(formatSummaryDate(null)).toBeNull();
    expect(formatSummaryDate("bad")).toBeNull();
  });
});
