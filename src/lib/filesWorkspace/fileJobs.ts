//! 后端文件操作任务的浏览器端视图（单一来源）。
//!
//! 为什么需要这一层：`operationQueue.ts` 记录的是**前端发起的一次 IPC 调用**，
//! 只有「开始/结束」两态；后端 `fsops` 任务有 `pending/running/cancelling/…`
//! 与真实 `done/total`。两者若各画一套 UI，就会出现「前端显示 X 条、后端还在
//! 跑 Y 条」的双状态。这里把后端任务汇总成唯一列表，`OperationQueueBar` 同时
//! 渲染两种来源，但**后端任务以服务端快照为准**。
//!
//! 订阅按引用计数：第一个消费者挂载时才注册事件监听并拉取历史，最后一个卸载
//! 时解除，避免重复监听器（AGENTS.md §4.8）。

import {
  fsJobCancel,
  fsJobReport,
  fsJobStatus,
  fsJobs,
  isFileJobTerminal,
  onRecycleJobProgress,
  type FileJobSnapshot,
  type FsOpReport,
} from "../bridge";
import { normalizeError } from "../errors";

type Listener = (jobs: FileJobSnapshot[]) => void;
type Waiter = (job: FileJobSnapshot | null) => void;

/** 等待上限：超过后按「不可追踪」返回 null，调用方必须提示无法确认，不能当作成功。 */
const JOB_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

const listeners = new Set<Listener>();
const waiters = new Map<string, Set<Waiter>>();
let cache: FileJobSnapshot[] = [];
let unlisten: (() => void) | null = null;
let wiring: Promise<void> | null = null;
/** 订阅代次：卸载/重新订阅期间晚到的 listen 结果必须立即解除，不能留下重复监听。 */
let wiringGen = 0;
let consumers = 0;
/** 事件序号与每个任务最近一次事件序号：hydrate 在途时事件更新不得被旧快照覆盖。 */
let eventSeq = 0;
const jobEventSeq = new Map<string, number>();

function notify() {
  for (const listener of listeners) listener(cache);
}

function sortJobs() {
  cache.sort((a, b) => {
    const rank = (job: FileJobSnapshot) => (isFileJobTerminal(job) ? 1 : 0);
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return b.startedMs - a.startedMs;
  });
}

function resolveWaiters(id: string, job: FileJobSnapshot | null) {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const waiter of set) waiter(job);
}

const TERMINAL_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_JOBS = 60;

function pruneCache() {
  const now = Date.now();
  cache = cache.filter(
    (job) =>
      !isFileJobTerminal(job) ||
      waiters.has(job.id) ||
      (typeof job.finishedMs === "number" && now - job.finishedMs < TERMINAL_TTL_MS),
  );
  if (cache.length > MAX_CACHED_JOBS) {
    cache = cache.slice(cache.length - MAX_CACHED_JOBS);
  }
}

function merge(job: FileJobSnapshot) {
  eventSeq += 1;
  jobEventSeq.set(job.id, eventSeq);
  const index = cache.findIndex((item) => item.id === job.id);
  if (index >= 0) cache[index] = job;
  else cache.push(job);
  pruneCache();
  sortJobs();
  notify();
  if (isFileJobTerminal(job)) resolveWaiters(job.id, job);
}

async function hydrate() {
  const seqAtStart = eventSeq;
  const jobs = await fsJobs();
  const serverIds = new Set(jobs.map((job) => job.id));
  const merged: FileJobSnapshot[] = [];
  for (const job of jobs) {
    const cached = cache.find((item) => item.id === job.id);
    // 请求期间收到过该任务的事件：事件比这份快照新，保留事件版本。
    const eventNewer = (jobEventSeq.get(job.id) ?? 0) > seqAtStart;
    merged.push(eventNewer && cached ? cached : job);
  }
  // 快照里已经淘汰、但请求期间收到终态事件的任务仍要保留，供等待者收尾。
  for (const old of cache) {
    if (!serverIds.has(old.id) && (jobEventSeq.get(old.id) ?? 0) > seqAtStart) {
      merged.push(old);
    }
  }
  cache = merged;
  pruneCache();
  sortJobs();
  notify();
  for (const id of [...waiters.keys()]) {
    const job = cache.find((item) => item.id === id);
    if (job && isFileJobTerminal(job)) resolveWaiters(id, job);
  }
}

/** 没有订阅者也没有等待者时才断开事件；等待期间仍保留监听，避免只靠 2.5s 轮询。 */
function maybeRelease() {
  if (consumers !== 0 || waiters.size !== 0) return;
  wiringGen += 1;
  unlisten?.();
  unlisten = null;
  wiring = null;
  cache = cache.filter((job) => !isFileJobTerminal(job));
  jobEventSeq.clear();
}

function ensureWired(): Promise<void> {
  if (wiring) return wiring;
  const gen = ++wiringGen;
  wiring = (async () => {
    let un: (() => void) | null = null;
    try {
      un = await onRecycleJobProgress((job) => merge(job));
    } catch {
      // 没有 Tauri 运行时（jsdom 单测 / 极早期启动）：不注册事件监听，
      // 仍可由 waitForFileJob 的轮询与 refreshFileJobs 拉取快照，不得让订阅方崩溃。
      un = null;
    }
    // 在 listen 完成前订阅已解除/重建：这份监听属于过期代次，立即断开。
    if (gen !== wiringGen || (consumers === 0 && waiters.size === 0)) {
      un?.();
      return;
    }
    unlisten = un;
    try {
      await hydrate();
    } catch {
      // 后端尚未就绪（例如测试环境 / 启动早期）：保留旧快照，等待下一次刷新。
    }
  })();
  return wiring;
}

/** 订阅统一任务列表。返回解除函数（引用计数归零时断开后端事件）。 */
export function subscribeFileJobs(listener: Listener): () => void {
  consumers += 1;
  listeners.add(listener);
  void ensureWired();
  listener(cache);
  return () => {
    listeners.delete(listener);
    consumers = Math.max(0, consumers - 1);
    maybeRelease();
  };
}

/** 从后端重新拉取任务列表（打开面板/任务结束后调用）。 */
export async function refreshFileJobs(): Promise<FileJobSnapshot[]> {
  try {
    await hydrate();
  } catch {
    // 保留旧快照：网络/IPC 失败不应清空用户可见的任务。
  }
  return cache;
}

/** 记录刚发起的任务快照（IPC 返回值），让等待者在终态快照上立即得到结果。 */
export function registerFileJob(job: FileJobSnapshot): void {
  merge(job);
}

/** 请求取消后端任务。返回是否真的生效（不可安全取消时为 false）。 */
export async function cancelFileJob(id: string): Promise<boolean> {
  const effective = await fsJobCancel(id);
  if (effective) void refreshFileJobs();
  return effective;
}

/**
 * 等待任务进入终态。
 *
 * 事件为主、低频轮询兜底（`fsJobStatus` 只在事件缺失时补位，避免长任务把
 * 轮询打满）。找不到任务（已被历史淘汰或后端重启）时返回 `null`：
 * 调用方必须如实提示「任务已不可追踪」，不得当作成功。
 */
export function waitForFileJob(id: string): Promise<FileJobSnapshot | null> {
  const current = cache.find((job) => job.id === id);
  if (current && isFileJobTerminal(current)) return Promise.resolve(current);
  void ensureWired();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let misses = 0;
    let polling = false;
    const startedAt = Date.now();
    const finish = (job: FileJobSnapshot | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      const set = waiters.get(id);
      if (set) {
        set.delete(finish);
        if (!set.size) waiters.delete(id);
      }
      resolve(job);
      maybeRelease();
    };
    const set = waiters.get(id) ?? new Set<Waiter>();
    set.add(finish);
    waiters.set(id, set);
    timer = setInterval(() => {
      // 有上限：后端长时间无响应/事件丢失时，等待不能无限挂起。
      if (Date.now() - startedAt >= JOB_WAIT_TIMEOUT_MS) {
        finish(null);
        return;
      }
      // 慢 IPC 时上一轮未返回：跳过本轮，绝不制造重叠轮询。
      if (polling) return;
      polling = true;
      void (async () => {
        try {
          const snapshot = await fsJobStatus(id);
          misses = 0;
          merge(snapshot);
          if (isFileJobTerminal(snapshot)) finish(snapshot);
        } catch (err) {
          // 只有后端明确 NotFound 才计入“任务不存在”；网络/服务抖动不算。
          const error = normalizeError(err);
          if (error.code === "NOT_FOUND" || error.category === "not_found") {
            misses += 1;
            if (misses >= 2) finish(null);
          } else {
            misses = 0;
          }
        } finally {
          polling = false;
        }
      })();
    }, 2500);
  });
}

/** 等待终态并读取逐项报告；报告缺失/过期时 `report=null`，调用方不得据此清理源数据。 */
export async function finishFileJob(
  id: string,
): Promise<{ job: FileJobSnapshot | null; report: FsOpReport | null }> {
  const job = await waitForFileJob(id);
  if (!job) return { job: null, report: null };
  let report: FsOpReport | null = null;
  try {
    report = await fsJobReport(id);
  } catch {
    // 任务报告按需保留，过期后拒绝读取：这是「结果明细不可用」，不是任务失败。
    report = null;
  }
  return { job, report };
}

/** 当前缓存（只读快照，供测试与诊断使用）。 */
export function currentFileJobs(): FileJobSnapshot[] {
  return [...cache];
}

/**
 * 任务终态 → `FsOpReport`（供既有 `showFsOpOutcome` / 诊断摘要复用）。
 *
 * 注意：后端任务快照只保留失败/跳过明细的**展示名**，不带完整路径；
 * `entries` 因此只含未成功条目，`ok` 等计数直接取自快照，不能用 `entries.length`
 * 反推（否则会把「成功 40 项」显示成「成功 0 项」）。
 */
export function reportFromJob(job: FileJobSnapshot): FsOpReport {
  return {
    operationId: job.id,
    attempted: job.total,
    ok: job.ok,
    failed: job.failed,
    skipped: job.skipped,
    partial: job.partial,
    entries: job.failures.map((entry) => ({
      source: entry.label,
      target: null,
      status: entry.status as "failed" | "skipped" | "partial",
      reason: entry.message,
      code: entry.code,
      stage: null,
    })),
  };
}
