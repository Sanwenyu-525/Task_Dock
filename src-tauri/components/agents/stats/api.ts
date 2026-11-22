//! Agent 工作时间统计前端契约。
//!
//! 说明：集成会话会把 `agentWorkTimeStats` 并入 `src/lib/bridge.ts`；本文件是
//! 迁移前的自包含封装，避免直接改共享的 bridge.ts。

import { invokeCommand } from "../../../lib/errors";

export type StatsOrigin = "real" | "selftest" | "benchmark" | "mock" | "manual";
export type StatsBucket = "day" | "week" | "month";

export interface WorkTimeStatsQuery {
  from: string;
  to: string;
  origin?: StatsOrigin;
  source_id?: string | null;
  bucket?: StatsBucket;
  timezone_offset_minutes?: number;
  session_limit?: number;
  max_runs?: number;
}

export interface StatsRange {
  from: string;
  to: string;
  origin: StatsOrigin;
  source_id: string | null;
  bucket: StatsBucket;
  timezone_offset_minutes: number;
}

export interface StatsCoverage {
  runs_in_range: number;
  runs_analyzed: number;
  run_limit: number;
  runs_truncated: boolean;
  events_loaded: number;
  event_limit: number;
  events_truncated: boolean;
  sessions_total: number;
  sessions_shown: number;
}

export interface StatsTotals {
  runs: number;
  runs_with_detail: number;
  runs_without_detail: number;
  completed: number;
  failed: number;
  interrupted: number;
  unresolved: number;
  unverified_terminal: number;
  failure_rate: number | null;
  span_sec: number;
  exec_sec: number;
  wait_sec: number;
  idle_sec: number;
  unknown_sec: number;
  open_tail_sec: number;
  estimated_runs: number;
  window_attributed_runs: number;
}

export interface StatsQuality {
  missing_start_runs: number;
  missing_end_runs: number;
  stale_open_runs: number;
  late_events: number;
  unknown_timestamp_events: number;
  coalesced_events: number;
  unreliable_intervals: number;
  gap_unknown_sec: number;
  no_detail_runs: number;
  window_attributed_runs: number;
  unattributed_events: number;
}

export interface SourceStats {
  source_id: string;
  display_name: string;
  runs: number;
  /** 该来源中没有可用事件明细的轮次数（执行/等待不可测量） */
  runs_without_detail: number;
  completed: number;
  failed: number;
  unresolved: number;
  failure_rate: number | null;
  span_sec: number;
  exec_sec: number;
  wait_sec: number;
  unknown_sec: number;
}

export interface SessionStats {
  session_id: string;
  source_id: string;
  source_name: string;
  external_id: string;
  title: string;
  status: string;
  last_seen_at: string;
  runs: number;
  /** 该会话中没有可用事件明细的轮次数（执行/等待不可测量） */
  runs_without_detail: number;
  completed: number;
  failed: number;
  unresolved: number;
  span_sec: number;
  exec_sec: number;
  wait_sec: number;
  open_tail_sec: number;
}

export interface TrendPoint {
  bucket: string;
  start_at: string;
  runs: number;
  completed: number;
  failed: number;
  exec_sec: number;
  wait_sec: number;
  unknown_sec: number;
}

export interface SourceOption {
  id: string;
  display_name: string;
  category: string;
  hidden: boolean;
}

export interface WorkTimeStats {
  generated_at: string;
  range: StatsRange;
  coverage: StatsCoverage;
  totals: StatsTotals;
  by_source: SourceStats[];
  sessions: SessionStats[];
  trend: TrendPoint[];
  quality: StatsQuality;
  available_sources: SourceOption[];
  warnings: string[];
}

export function agentWorkTimeStats(query: WorkTimeStatsQuery): Promise<WorkTimeStats> {
  // 注意：`query` 内字段是 snake_case（与 Rust `WorkTimeStatsQuery` 的 serde 字段同名），
  // 不是 camelCase；改动需前后端同步，否则后端会按缺省值处理（例如丢掉时区偏移）。
  return invokeCommand<WorkTimeStats>("agent_work_time_stats", { query });
}
