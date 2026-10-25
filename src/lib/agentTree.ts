//! Agent 监控树与实时状态聚合（纯函数，可测试）。
//!
//! 语义约定（v0.3）：
//! - 「当前实时状态」只包含 running / waiting / failed / disconnected 的近期轮次；
//!   completed 是历史完成轮次，不得当作当前运行状态。
//! - failed 只在近期窗口内计入（历史失败不应让状态点永久变红）；
//!   running / waiting 由后端 stale 清理兜底，天然是新鲜的。
//! - 失联（disconnected）不等于失败，优先级低于等待介入与运行中。
//! - 会话未携带实例信息（instance_id = null）时直接挂在 Agent 层级下，
//!   严禁伪造 "default" 实例。

import type { AgentRun, AgentSession, AgentSnapshot } from "./bridge";

export type LiveState = "failed" | "waiting" | "running" | "disconnected" | "idle";

/** 实时状态优先级：失败 > 等待介入 > 运行中 > 失联 > 空闲。 */
export const LIVE_STATE_ORDER: LiveState[] = ["failed", "waiting", "running", "disconnected", "idle"];

/** failed 计入实时状态的近期窗口（运行/等待由后端 stale 清理保证新鲜）。 */
export const FAILED_RECENT_MS = 60 * 60 * 1000;

function ts(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 当前需要关注的轮次（实时集合）。
 * - running / waiting / disconnected：开放式状态，全部计入
 *   （disconnected 由 stale 清理产生，天然近期；遗留历史 disconnected 行也计入，
 *   用于「最近有失联」提示，但优先级最低）
 * - failed：仅近期窗口内计入
 * - completed：历史轮次，不计入
 */
export function liveRuns(runs: AgentRun[], now = Date.now()): AgentRun[] {
  return runs.filter((r) => {
    if (r.status === "running" || r.status === "waiting") return true;
    if (r.status === "failed" || r.status === "disconnected") {
      return now - ts(r.updated_at) <= FAILED_RECENT_MS;
    }
    return false;
  });
}

/** 实时最差状态（标题栏状态点用）。 */
export function worstAgentState(snapshot: AgentSnapshot | null, now = Date.now()): LiveState {
  if (!snapshot) return "idle";
  const live = new Set(liveRuns(snapshot.runs, now).map((r) => r.status));
  for (const s of LIVE_STATE_ORDER) {
    if (s !== "idle" && live.has(s)) return s;
  }
  return "idle";
}

export interface LiveSummary {
  running: number;
  waiting: number;
  failed: number;
  disconnected: number;
  worst: LiveState;
}

/** 实时计数汇总（极简/紧凑/Agent 概览共用）。 */
export function liveSummary(snapshot: AgentSnapshot | null, now = Date.now()): LiveSummary {
  const live = liveRuns(snapshot?.runs ?? [], now);
  const count = (s: string) => live.filter((r) => r.status === s).length;
  const summary: LiveSummary = {
    running: count("running"),
    waiting: count("waiting"),
    failed: count("failed"),
    disconnected: count("disconnected"),
    worst: "idle",
  };
  summary.worst =
    (LIVE_STATE_ORDER.find(
      (s) => s !== "idle" && count(s) > 0,
    ) as LiveState | undefined) ?? "idle";
  return summary;
}

// ── 监控树：Agent → 实例（可选）→ 会话 → 轮次 ──

export interface TreeRun {
  id: string;
  externalRunId: string | null;
  taskTitle: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  pending: string[];
}

export interface TreeSession {
  id: string;
  externalId: string;
  title: string;
  status: string;
  lastSeen: string;
  runs: TreeRun[];
  /** 会话的实时最差状态（无实时轮次时为 idle） */
  liveState: LiveState;
}

export interface TreeInstance {
  /** agent_instances 行 ID */
  id: string;
  /** 实例标识（进程/安装 key） */
  key: string;
  displayName: string;
  sessions: TreeSession[];
}

export interface TreeAgent {
  id: string;
  name: string;
  liveState: LiveState;
  activeCount: number;
  /** 已知实例分组；instance_id 为空的会话不进任何实例 */
  instances: TreeInstance[];
  /** 未关联实例的会话（保持真实关系，不伪造 default 实例） */
  unassignedSessions: TreeSession[];
}

/** 会话/Agent 关注优先级：等待介入 > 失败 > 运行中 > 失联 > 空闲。 */
const ATTENTION_ORDER: Record<string, number> = {
  waiting: 0,
  failed: 1,
  running: 2,
  disconnected: 3,
  idle: 4,
};

function attentionRank(state: string): number {
  return ATTENTION_ORDER[state] ?? 5;
}

function toTreeRuns(runs: AgentRun[]): TreeRun[] {
  return runs.map((r) => ({
    id: r.id,
    externalRunId: r.external_run_id,
    taskTitle: r.task_title,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    updatedAt: r.updated_at,
    pending: r.pending_items,
  }));
}

function sessionLiveState(runs: AgentRun[], now: number): LiveState {
  const statuses = new Set(liveRuns(runs, now).map((r) => r.status));
  for (const s of LIVE_STATE_ORDER) {
    if (s !== "idle" && statuses.has(s)) return s;
  }
  return "idle";
}

/**
 * 由快照构建监控树。
 * - 会话按 agent_instances.id 关联分组；未携带实例信息的会话留在
 *   unassignedSessions，绝不伪造实例。
 * - 会话按关注优先级 + 最近活动排序；Agent 亦然（需关注的排前面）。
 */
export function buildTree(snapshot: AgentSnapshot, now = Date.now()): TreeAgent[] {
  const instanceById = new Map(snapshot.instances.map((i) => [i.id, i]));

  const runsBySession = new Map<string, AgentRun[]>();
  for (const r of snapshot.runs) {
    const list = runsBySession.get(r.session_id) ?? [];
    list.push(r);
    runsBySession.set(r.session_id, list);
  }

  const sessionsBySource = new Map<string, AgentSession[]>();
  for (const s of snapshot.sessions) {
    const list = sessionsBySource.get(s.source_id) ?? [];
    list.push(s);
    sessionsBySource.set(s.source_id, list);
  }

  const agents: TreeAgent[] = [];
  for (const src of snapshot.sources) {
    const sessions = sessionsBySource.get(src.id) ?? [];
    if (sessions.length === 0) continue;

    const groups = new Map<string, TreeSession[]>();
    const unassigned: TreeSession[] = [];
    for (const sess of sessions) {
      const rawRuns = runsBySession.get(sess.id) ?? [];
      // 轮次按开始时间倒序（最新在前）
      rawRuns.sort((a, b) => ts(b.started_at) - ts(a.started_at));
      const treeSess: TreeSession = {
        id: sess.id,
        externalId: sess.external_id,
        title: sess.title,
        status: sess.status,
        lastSeen: sess.last_seen_at,
        runs: toTreeRuns(rawRuns),
        liveState: sessionLiveState(rawRuns, now),
      };
      const instId = sess.instance_id ?? null;
      if (instId && instanceById.has(instId)) {
        const arr = groups.get(instId) ?? [];
        arr.push(treeSess);
        groups.set(instId, arr);
      } else {
        unassigned.push(treeSess);
      }
    }

    const sortSess = (a: TreeSession, b: TreeSession) =>
      attentionRank(a.liveState) - attentionRank(b.liveState) || ts(b.lastSeen) - ts(a.lastSeen);

    const instances: TreeInstance[] = [...groups.entries()]
      .map(([id, list]) => ({
        id,
        key: instanceById.get(id)?.instance_key ?? id,
        displayName: instanceById.get(id)?.display_name || instanceById.get(id)?.instance_key || id,
        sessions: list.sort(sortSess),
      }))
      .sort(
        (a, b) =>
          attentionRank(a.sessions[0]?.liveState ?? "idle") -
          attentionRank(b.sessions[0]?.liveState ?? "idle"),
      );
    unassigned.sort(sortSess);

    const all = [...instances.flatMap((i) => i.sessions), ...unassigned];
    const activeCount = all.filter((s) => s.liveState === "running" || s.liveState === "waiting").length;
    const worst =
      LIVE_STATE_ORDER.find((s) => s !== "idle" && all.some((x) => x.liveState === s)) ?? "idle";

    agents.push({
      id: src.id,
      name: src.display_name,
      liveState: worst as LiveState,
      activeCount,
      instances,
      unassignedSessions: unassigned,
    });
  }

  agents.sort(
    (a, b) => attentionRank(a.liveState) - attentionRank(b.liveState) || a.name.localeCompare(b.name),
  );
  return agents;
}
