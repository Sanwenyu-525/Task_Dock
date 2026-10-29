import { create } from "zustand";
import { agentSnapshot, type AgentSnapshot } from "../lib/bridge";

export type AgentRefreshPriority = "critical" | "normal";

export interface AgentRefreshMetrics {
  /** 实际发起的快照请求数（100 条事件应远小于 100） */
  snapshotRequests: number;
  /** 成功应用到 store 的快照数 */
  snapshotApplied: number;
  /** 因节流/单飞合并掉的事件数 */
  coalesced: number;
  /** 窗口隐藏期间跳过（仅置脏）的次数 */
  skippedHidden: number;
  /** 同时进行的快照请求峰值（应为 1） */
  maxConcurrent: number;
  lastLatencyMs: number;
  lastError: string | null;
}

const MIN_INTERVAL_MS: Record<AgentRefreshPriority, number> = {
  critical: 100,
  normal: 400,
};

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let inFlightPromise: Promise<void> | null = null;
let dirty = false;
let dirtyCritical = false;
let lastFetchAt = 0;
let failures = 0;
let retryAt = 0;
let activeRequests = 0;
let bound = false;

const metrics: AgentRefreshMetrics = {
  snapshotRequests: 0,
  snapshotApplied: 0,
  coalesced: 0,
  skippedHidden: 0,
  maxConcurrent: 0,
  lastLatencyMs: 0,
  lastError: null,
};

export const getAgentRefreshMetrics = (): AgentRefreshMetrics => ({ ...metrics });

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function applySnapshot(s: AgentSnapshot) {
  useAgentsStore.setState({ snapshot: s });
}

async function fetchSnapshot(): Promise<void> {
  if (inFlightPromise) return inFlightPromise;
  inFlight = true;
  activeRequests += 1;
  metrics.snapshotRequests += 1;
  metrics.maxConcurrent = Math.max(metrics.maxConcurrent, activeRequests);
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  inFlightPromise = (async () => {
    try {
      const s = await agentSnapshot();
      applySnapshot(s);
      metrics.snapshotApplied += 1;
      failures = 0;
      retryAt = 0;
      metrics.lastError = null;
    } catch (e) {
      failures += 1;
      retryAt = Date.now() + Math.min(10000, 500 * 2 ** Math.min(failures, 5));
      metrics.lastError = String(e);
      dirty = true;
    } finally {
      lastFetchAt = Date.now();
      metrics.lastLatencyMs =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
      inFlight = false;
      inFlightPromise = null;
      activeRequests -= 1;
      if (dirty) {
        dirty = false;
        const critical = dirtyCritical;
        dirtyCritical = false;
        scheduleAgentRefresh(critical ? "critical" : "normal");
      }
    }
  })();
  return inFlightPromise;
}

function armTimer(priority: AgentRefreshPriority) {
  if (timer) return;
  const now = Date.now();
  const delay = Math.max(0, lastFetchAt + MIN_INTERVAL_MS[priority] - now, retryAt - now);
  timer = setTimeout(() => {
    timer = null;
    if (isHidden()) {
      dirty = true;
      dirtyCritical = dirtyCritical || priority === "critical";
      metrics.skippedHidden += 1;
      return;
    }
    if (inFlight) {
      dirty = true;
      dirtyCritical = dirtyCritical || priority === "critical";
      return;
    }
    void fetchSnapshot();
  }, delay);
}

/**
 * 事件驱动的快照刷新入口：节流 + 单飞 + 脏标记追赶 + 隐藏窗口不刷新。
 * 100 条事件只会产生 1 次在途请求 + 至多 1 次追赶请求。
 */
export function scheduleAgentRefresh(priority: AgentRefreshPriority = "normal"): void {
  if (isHidden()) {
    dirty = true;
    dirtyCritical = dirtyCritical || priority === "critical";
    metrics.skippedHidden += 1;
    return;
  }
  if (timer) {
    // 定时器未触发前到达的事件会被这次快照一并包含，无需二次刷新；
    // 若升级为关键状态，则把等待窗口缩短到关键间隔。
    metrics.coalesced += 1;
    if (priority === "critical") {
      clearTimeout(timer);
      timer = null;
      armTimer("critical");
    }
    return;
  }
  if (inFlight) {
    dirty = true;
    dirtyCritical = dirtyCritical || priority === "critical";
    metrics.coalesced += 1;
    return;
  }
  armTimer(priority);
}

/** 手动/交互触发：等待当前在途请求后立即拉取一次（仍保持单飞）。 */
export async function refreshAgentsNow(): Promise<void> {
  if (inFlightPromise) await inFlightPromise;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await fetchSnapshot();
}

function bindVisibilitySync() {
  if (bound || typeof document === "undefined") return;
  bound = true;
  document.addEventListener("visibilitychange", () => {
    // 恢复显示时同步一次，弥补隐藏期间的合并（不引入轮询）
    if (!isHidden() && dirty) {
      dirty = false;
      dirtyCritical = false;
      scheduleAgentRefresh("critical");
    }
  });
}

export const useAgentsStore = create<{
  snapshot: AgentSnapshot | null;
  /** 与后端手动刷新/向导等交互路径使用：立即拉取（单飞） */
  load: () => Promise<void>;
}>(() => ({
  snapshot: null,
  load: async () => {
    bindVisibilitySync();
    await refreshAgentsNow();
  },
}));

bindVisibilitySync();
