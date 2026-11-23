//! 漫剧制作统计（纯函数，2026-11-23）：剧集 → 镜头状态分布与完成比例。
//!
//! 统计一律**由真实镜头数据派生**：不新增持久化字段、不写回 `comic_episodes.progress`，
//! 也不把「镜头完成比例」当成剧集整体制作进度（两者口径不同，界面分开表述）。

import type { ComicShot, ShotStatus } from "./types";

export interface EpisodeShotStats {
  /** 本集镜头总数。 */
  total: number;
  todo: number;
  doing: number;
  blocked: number;
  done: number;
  /** 镜头完成比例（0–100，四舍五入）。总数为 0 时为 0。 */
  doneRatio: number;
}

export const EMPTY_EPISODE_STATS: EpisodeShotStats = {
  total: 0,
  todo: 0,
  doing: 0,
  blocked: 0,
  done: 0,
  doneRatio: 0,
};

/** 按剧集聚合镜头状态；`episodeId` 为空或未知的镜头不计入任何剧集。 */
export function buildEpisodeShotStats(
  shots: ReadonlyArray<Pick<ComicShot, "episodeId" | "status">>,
): Map<string, EpisodeShotStats> {
  const stats = new Map<string, EpisodeShotStats>();
  for (const shot of shots) {
    if (!shot.episodeId) continue;
    const current = stats.get(shot.episodeId) ?? { ...EMPTY_EPISODE_STATS };
    current.total += 1;
    const status: ShotStatus = shot.status;
    if (status === "todo" || status === "doing" || status === "blocked" || status === "done") {
      current[status] += 1;
    }
    stats.set(shot.episodeId, current);
  }
  for (const value of stats.values()) {
    value.doneRatio = value.total > 0 ? Math.round((value.done / value.total) * 100) : 0;
  }
  return stats;
}
