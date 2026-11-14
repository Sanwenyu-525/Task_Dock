//! 资源快照有效性：页面快照与趋势末端可能来自不同时刻的两份真实读数。
//!
//! 为什么需要统一判定：
//! - 概览的环形与指标可以消费「页面快照」或「趋势最近一次成功采样」；
//! - 手动刷新失败时 `useAsyncResource` 会清空 `data`，但趋势里仍保留更早的一次
//!   成功快照。若直接回退到趋势快照并当作当前值展示，就是把旧读数伪装成最新；
//! - 反过来，趋势末端可能比页面快照更新（10 秒周期采样），因此不能无脑只用页面快照。
//!
//! 本模块只做纯计算：按后端 `sampledAt` 选最新的一份，并给出明确状态：
//! - `pending`：首次读取尚未完成；
//! - `live`：当前读数，没有失败；
//! - `updating`：正在刷新，界面暂时沿用上次成功读数；
//! - `historical`：最近一次刷新失败，展示的只能是更早的历史读数；
//! - `failed`：没有任何可用读数（失败或未加载）。
//!
//! 调用方必须把 `freshness` 展示给用户，不能只消费 `snapshot` 数字。

import type { ResourceSnapshot } from "./bridge";
import type { MessageKey } from "../i18n";

/** 快照展示状态：决定文案与是否允许把数值说成「当前」。 */
export type SnapshotFreshness = "pending" | "live" | "updating" | "historical" | "failed";

/** 状态 → i18n Key：概览与各分区必须使用同一套文案。 */
export const FRESHNESS_LABEL: Record<SnapshotFreshness, MessageKey> = {
  pending: "resource.freshness.pending",
  live: "resource.freshness.live",
  updating: "resource.freshness.updating",
  historical: "resource.freshness.historical",
  failed: "resource.freshness.failed",
};

export interface SnapshotView {
  /** 按采样时间选出的最新一份快照；没有可用读数时为 null。 */
  snapshot: ResourceSnapshot | null;
  /** 该快照的后端采样时间（原样保留，可能为空）。 */
  sampledAt: string | null;
  freshness: SnapshotFreshness;
  /** 是否处于「刷新失败、只能展示历史读数」状态。 */
  stale: boolean;
}

/** 后端时间戳 → 毫秒；缺失/非法按 0 处理（不会因此被误判为最新）。 */
function sampledMillis(iso: string | null | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 选择要展示的快照并标注有效性。
 *
 * 同一 `sampledAt` 时优先页面快照（它带有本次刷新的完整上下文），
 * 但两者本来就是同一次后端读取，数值一致，不存在混用风险。
 */
export function pickSnapshotView(input: {
  snapshot: ResourceSnapshot | null;
  loading: boolean;
  error: string | null;
  trendLatest: ResourceSnapshot | null;
}): SnapshotView {
  const { snapshot, loading, error, trendLatest } = input;
  const candidates = [snapshot, trendLatest].filter(
    (item): item is ResourceSnapshot => item !== null,
  );
  const newest =
    candidates.length === 0
      ? null
      : candidates.reduce((best, item) =>
          sampledMillis(item.sampledAt) > sampledMillis(best.sampledAt) ? item : best,
        );

  // 有失败且仍有读数：只能是失败前/趋势里的历史读数，必须明示。
  const stale = Boolean(error) && newest !== null;
  let freshness: SnapshotFreshness;
  if (!newest) freshness = error ? "failed" : loading ? "pending" : "failed";
  else if (error) freshness = "historical";
  else if (loading) freshness = "updating";
  else freshness = "live";

  return {
    snapshot: newest,
    sampledAt: newest?.sampledAt ?? null,
    freshness,
    stale,
  };
}

/** 是否允许把该快照称为「当前读数」：仅 live 状态。 */
export function isCurrentReading(freshness: SnapshotFreshness): boolean {
  return freshness === "live";
}

/** 是否仍有可展示的读数（历史读数也算，但必须配 freshness 文案）。 */
export function hasReading(freshness: SnapshotFreshness): boolean {
  return freshness === "live" || freshness === "updating" || freshness === "historical";
}
