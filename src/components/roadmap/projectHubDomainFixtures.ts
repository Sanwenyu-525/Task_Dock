//! 专业摘要测试夹具：与后端 DTO 字段一一对应的纯数据构造器（不含断言与副作用）。
//!
//! 单独成文件而不是放在 `*.test.ts` 里导出：避免组件测试 import 夹具时把另一个
//! 测试文件的用例一并执行。

import type { ComicOverviewStats } from "../../workbench/creative/comic/types";
import type { DwsDevelopmentSummary } from "../../workbench/creative/development/types";
import type { GameOverviewStats } from "../../workbench/creative/game/types";
import type { GeneralStats } from "../../workbench/creative/general/ipc";
import type { NovelOverviewStats } from "../../workbench/creative/novel/types";

export function novelStats(overrides: Partial<NovelOverviewStats> = {}): NovelOverviewStats {
  return {
    volumes: 3,
    chapters: 12,
    words: 186_000,
    characters: 8,
    locations: 4,
    worldviews: 15,
    recentChapters: 2,
    recentWords: 12_000,
    lastChapter: {
      chapterId: "ch-1",
      title: "第十章 雪夜",
      volumeTitle: "第一卷",
      wordCount: 9_600,
      updatedAt: "2026-11-20T10:00:00+08:00",
    },
    targetWords: 300_000,
    targetUpdatedAt: "2026-11-01T00:00:00+08:00",
    ...overrides,
  };
}

export function emptyNovelStats(): NovelOverviewStats {
  return novelStats({
    volumes: 0,
    chapters: 0,
    words: 0,
    characters: 0,
    locations: 0,
    worldviews: 0,
    recentChapters: 0,
    recentWords: 0,
    lastChapter: null,
    targetWords: null,
    targetUpdatedAt: null,
  });
}

export function comicStats(overrides: Partial<ComicOverviewStats> = {}): ComicOverviewStats {
  return {
    projectId: "p-comic",
    episodeCount: 4,
    completedEpisodeCount: 1,
    shotCount: 40,
    completedShotCount: 10,
    pendingShotCount: 20,
    doingShotCount: 6,
    blockedShotCount: 4,
    characterCount: 6,
    sceneCount: 5,
    mediaCount: 22,
    adoptedMediaCount: 9,
    updatedAt: "2026-11-22T09:00:00+08:00",
    ...overrides,
  };
}

export function emptyComicStats(): ComicOverviewStats {
  return comicStats({
    episodeCount: 0,
    completedEpisodeCount: 0,
    shotCount: 0,
    completedShotCount: 0,
    pendingShotCount: 0,
    doingShotCount: 0,
    blockedShotCount: 0,
    characterCount: 0,
    sceneCount: 0,
    mediaCount: 0,
    adoptedMediaCount: 0,
    updatedAt: null,
  });
}

export function gameStats(overrides: Partial<GameOverviewStats> = {}): GameOverviewStats {
  return {
    projectId: "p-game",
    assetCount: 18,
    buildCount: 6,
    successfulBuildCount: 3,
    failedBuildCount: 2,
    plannedBuildCount: 1,
    testCount: 9,
    passedTestCount: 5,
    failedTestCount: 3,
    blockedTestCount: 1,
    latestBuildAt: "2026-11-21T18:30:00+08:00",
    latestBuildStatus: "failed",
    updatedAt: "2026-11-21T18:30:00+08:00",
    ...overrides,
  };
}

export function emptyGameStats(): GameOverviewStats {
  return gameStats({
    assetCount: 0,
    buildCount: 0,
    successfulBuildCount: 0,
    failedBuildCount: 0,
    plannedBuildCount: 0,
    testCount: 0,
    passedTestCount: 0,
    failedTestCount: 0,
    blockedTestCount: 0,
    latestBuildAt: null,
    latestBuildStatus: null,
    updatedAt: null,
  });
}

export function devSummary(
  overrides: Partial<DwsDevelopmentSummary> = {},
): DwsDevelopmentSummary {
  return {
    projectId: "p-dev",
    projectName: "开发项目",
    kind: "development",
    archived: false,
    weakDevProjectId: "dev-1",
    devProjects: [
      {
        devProjectId: "dev-1",
        name: "task_dock",
        rootPath: "D:/Develop/task_dock",
        exists: true,
        note: "",
        linkOrigin: "weak_ref",
        git: {
          status: "ok",
          branch: "main",
          detached: false,
          isWorktree: false,
          mainRepoPath: null,
          headSha: "abc1234",
          dirtyCount: 7,
          probedAt: "2026-11-21T10:00:00+08:00",
        },
      },
      {
        devProjectId: "dev-2",
        name: "已移走的仓库",
        rootPath: "E:/gone/repo",
        exists: false,
        note: "",
        linkOrigin: "manual",
        git: {
          status: "path_missing",
          branch: null,
          detached: false,
          isWorktree: false,
          mainRepoPath: null,
          headSha: null,
          dirtyCount: null,
          probedAt: "2026-11-21T10:00:00+08:00",
        },
      },
    ],
    tasks: [
      {
        taskId: "t-1",
        title: "接入摘要",
        status: "completed",
        priority: 1,
        dueAt: null,
        linkOrigin: "workspace_link",
      },
      {
        taskId: "t-2",
        title: "补测试",
        status: "pending",
        priority: 2,
        dueAt: "2026-11-25",
        linkOrigin: "manual",
      },
      {
        taskId: "t-3",
        title: "已删除任务",
        status: "missing",
        priority: 2,
        dueAt: null,
        linkOrigin: "workspace_link",
      },
    ],
    ...overrides,
  };
}

export function emptyDevSummary(): DwsDevelopmentSummary {
  return devSummary({ devProjects: [], tasks: [] });
}

export function generalStatsData(overrides: Partial<GeneralStats> = {}): GeneralStats {
  return {
    totalItems: 9,
    todoItems: 3,
    doingItems: 2,
    blockedItems: 1,
    doneItems: 3,
    milestonesTotal: 4,
    milestonesOpen: 1,
    milestonesDone: 3,
    milestonesSkipped: 0,
    linkedTasks: 2,
    materialsTotal: 5,
    materialsAlive: 4,
    currentMilestone: null,
    recentActivity: [],
    ...overrides,
  };
}

export function emptyGeneralStats(): GeneralStats {
  return generalStatsData({
    totalItems: 0,
    todoItems: 0,
    doingItems: 0,
    blockedItems: 0,
    doneItems: 0,
    milestonesTotal: 0,
    milestonesOpen: 0,
    milestonesDone: 0,
    milestonesSkipped: 0,
    linkedTasks: 0,
    materialsTotal: 0,
    materialsAlive: 0,
  });
}
