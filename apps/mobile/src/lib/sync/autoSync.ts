// 前台自动同步：把「用户手动点立即同步」变成「回到前台 / 写完一条内容后自动补齐」。
//
// 边界（docs/mobile/11-background-sync-design.md 方案 A+B 的落地版）：
// - 只在应用前台运行；不做后台任务、不做常驻轮询、不注册网络监听；
// - 判定链：开关 → 已配对 + 令牌 → 网络非计费 → 单飞 → 退避 → 最小间隔；
// - 复用 engine.syncNow 的单飞/超时/退避与 outbox 同事务契约，不复制同步逻辑；
// - 失败静默（不弹 Toast），但状态落到同步页（最近结果 + 失败原因 + 下次重试）；
// - 「本地保存成功」与「桌面端已确认」是两个状态：这里只推进同步结果，不修改本地记录。
import { countAttachmentsForTransfer } from "../../db/attachments";
import { getSetting, setSetting } from "../../db/kv";
import { countPendingSyncOps, countSyncConflicts, loadSyncResult, type SyncLastResult } from "../../db/sync";
import { loadConnection, readToken } from "../../db/syncConnection";
import { isSyncing, syncNow } from "./engine";
import { isLegacyConnection } from "./connectionState";
import { subscribeLocalChange } from "./localChange";
import { probeNetworkMetering, type NetworkMetering } from "../net/network";

/** 两次成功自动同步之间的最小间隔：前台频繁切换不重复拉取 */
export const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60_000;
/** 本地写入后的合并窗口：连续保存多条只同步一次 */
export const AUTO_SYNC_DEBOUNCE_MS = 8_000;
/** 失败退避：30s → 60s → 120s → 300s（封顶，不无限增长） */
export const AUTO_SYNC_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;

const KEY_ENABLED = "sync.auto.enabled";
const KEY_WIFI_ONLY = "sync.auto.wifi_only";
const KEY_TRANSFER_ATTACHMENTS = "sync.auto.transfer_attachments";
const KEY_LAST_SUCCESS = "sync.auto.last_success_at";
const KEY_FAILURES = "sync.auto.failures";
const KEY_NEXT_ATTEMPT = "sync.auto.next_attempt_at";

export interface AutoSyncSettings {
  /** 前台自动同步总开关（默认开：这是本次交付的核心效率能力） */
  enabled: boolean;
  /** 只在非计费网络下自动同步（默认开；判定不可用视为计费） */
  wifiOnly: boolean;
  /** 采集附件是否随同步自动发送到桌面端（默认关：涉及用户照片/录音，必须显式开启） */
  autoTransferAttachments: boolean;
}

async function readFlag(key: string, fallback: boolean): Promise<boolean> {
  const raw = await getSetting(key);
  if (raw == null) return fallback;
  return raw === "1";
}

export async function loadAutoSyncSettings(): Promise<AutoSyncSettings> {
  const [enabled, wifiOnly, autoTransferAttachments] = await Promise.all([
    readFlag(KEY_ENABLED, true),
    readFlag(KEY_WIFI_ONLY, true),
    readFlag(KEY_TRANSFER_ATTACHMENTS, false),
  ]);
  return { enabled, wifiOnly, autoTransferAttachments };
}

export async function saveAutoSyncSettings(
  patch: Partial<AutoSyncSettings>,
): Promise<AutoSyncSettings> {
  if (patch.enabled !== undefined) await setSetting(KEY_ENABLED, patch.enabled ? "1" : "0");
  if (patch.wifiOnly !== undefined) await setSetting(KEY_WIFI_ONLY, patch.wifiOnly ? "1" : "0");
  if (patch.autoTransferAttachments !== undefined) {
    await setSetting(KEY_TRANSFER_ATTACHMENTS, patch.autoTransferAttachments ? "1" : "0");
  }
  const next = await loadAutoSyncSettings();
  await loadSyncStatus();
  if (!next.enabled) cancelAutoSync();
  return next;
}

export type AutoSyncReason =
  | "foreground"
  | "local_change"
  | "manual_after_save"
  | "retry"
  | "startup";

export type AutoSyncSkipReason =
  | "disabled"
  | "unpaired"
  | "no_token"
  | "legacy_connection"
  | "metered_network"
  | "unknown_network"
  | "in_flight"
  | "backoff"
  | "too_soon"
  | "ok";

export interface AutoSyncDecisionInput {
  settings: AutoSyncSettings;
  /** 连接元数据存在且不是 v1 遗留连接 */
  paired: boolean;
  hasToken: boolean;
  metering: NetworkMetering;
  hasPendingLocalChanges: boolean;
  now: number;
  lastSuccessAt: number;
  nextAttemptAt: number;
  syncing: boolean;
}

export interface AutoSyncDecision {
  run: boolean;
  reason: AutoSyncSkipReason;
}

/**
 * 纯判定：什么时候允许自动同步。
 *
 * 「无本地变更」不是跳过理由：桌面端可能改了任务/笔记，前台恢复需要 pull 一次；
 * 但「刚成功同步过」只应节流「纯拉取」，不能节流「本地有待推送的写入」——
 * 否则保存一条任务后 5 分钟内都不会上传，与「写完就同步」的目标冲突。
 */
export function decideAutoSync(input: AutoSyncDecisionInput): AutoSyncDecision {
  if (!input.settings.enabled) return { run: false, reason: "disabled" };
  if (!input.paired) return { run: false, reason: "unpaired" };
  if (!input.hasToken) return { run: false, reason: "no_token" };
  if (input.settings.wifiOnly) {
    if (input.metering === "metered") return { run: false, reason: "metered_network" };
    if (input.metering === "unknown") return { run: false, reason: "unknown_network" };
  }
  if (input.syncing) return { run: false, reason: "in_flight" };
  if (input.nextAttemptAt > input.now) return { run: false, reason: "backoff" };
  if (
    input.lastSuccessAt > 0 &&
    input.now - input.lastSuccessAt < AUTO_SYNC_MIN_INTERVAL_MS &&
    !input.hasPendingLocalChanges
  ) {
    return { run: false, reason: "too_soon" };
  }
  return { run: true, reason: "ok" };
}

/** 第 n 次连续失败后的等待时间（n 从 1 开始） */
export function backoffForFailure(failures: number): number {
  const index = Math.min(Math.max(failures - 1, 0), AUTO_SYNC_BACKOFF_MS.length - 1);
  return AUTO_SYNC_BACKOFF_MS[index];
}

export function describeSkipReason(reason: AutoSyncSkipReason): string {
  switch (reason) {
    case "disabled":
      return "自动同步已关闭";
    case "unpaired":
      return "尚未配对桌面端";
    case "no_token":
      return "本机配对令牌不可用";
    case "legacy_connection":
      return "旧连接需重新配对";
    case "metered_network":
      return "当前是计费网络（已开启仅 Wi-Fi 同步）";
    case "unknown_network":
      return "无法确认网络类型（按计费网络处理）";
    case "in_flight":
      return "同步正在进行";
    case "backoff":
      return "等待重试冷却";
    case "too_soon":
      return "距上次成功同步不足 5 分钟";
    case "ok":
      return "可同步";
  }
}

// ── 状态快照（同步页 / 采集页共用，不引入状态库）────────────────────────

export type SyncPhase = "idle" | "pending" | "syncing" | "failed" | "conflict" | "unpaired";

export interface SyncStatusSnapshot {
  phase: SyncPhase;
  /** outbox 里待发送的操作数（任务/笔记/收集箱合计） */
  pendingOps: number;
  /** 待发送附件数（pending + failed） */
  pendingAttachments: number;
  conflictCount: number;
  lastResult: SyncLastResult | null;
  lastSuccessAt: number;
  settings: AutoSyncSettings;
  /** 上一次自动同步跳过/执行的原因（人类可读） */
  lastAutoNote: string | null;
  updatedAt: number;
}

type StatusListener = (snapshot: SyncStatusSnapshot) => void;
type CompletedListener = (result: SyncLastResult) => void;

const statusListeners = new Set<StatusListener>();
const completedListeners = new Set<CompletedListener>();
let cachedStatus: SyncStatusSnapshot | null = null;
let lastAutoNote: string | null = null;

export function getCachedSyncStatus(): SyncStatusSnapshot | null {
  return cachedStatus;
}

export function subscribeSyncStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  if (cachedStatus) listener(cachedStatus);
  return () => {
    statusListeners.delete(listener);
  };
}

/** 同步成功后通知外层刷新列表（pull 可能改了任务/笔记/收集箱）。 */
export function subscribeSyncCompleted(listener: CompletedListener): () => void {
  completedListeners.add(listener);
  return () => {
    completedListeners.delete(listener);
  };
}

function emitStatus(snapshot: SyncStatusSnapshot): void {
  cachedStatus = snapshot;
  for (const listener of statusListeners) {
    try {
      listener(snapshot);
    } catch {
      // 订阅方异常不影响调度
    }
  }
}

export async function loadSyncStatus(): Promise<SyncStatusSnapshot> {
  const [pendingOps, pendingAttachments, conflictCount, lastResult, settings, lastSuccessRaw] =
    await Promise.all([
      countPendingSyncOps().catch(() => 0),
      countAttachmentsForTransfer().catch(() => 0),
      countSyncConflicts().catch(() => 0),
      loadSyncResult().catch(() => null),
      loadAutoSyncSettings().catch(() => ({
        enabled: false,
        wifiOnly: true,
        autoTransferAttachments: false,
      })),
      getSetting(KEY_LAST_SUCCESS).catch(() => null),
    ]);

  const lastSuccessAt = Number(lastSuccessRaw ?? 0) || 0;
  const syncing = isSyncing();
  const phase: SyncPhase = syncing
    ? "syncing"
    : lastResult?.error
      ? "failed"
      : conflictCount > 0
        ? "conflict"
        : pendingOps > 0 || pendingAttachments > 0
          ? "pending"
          : "idle";

  const snapshot: SyncStatusSnapshot = {
    phase,
    pendingOps,
    pendingAttachments,
    conflictCount,
    lastResult,
    lastSuccessAt,
    settings,
    lastAutoNote,
    updatedAt: Date.now(),
  };
  emitStatus(snapshot);
  return snapshot;
}

// ── 调度 ──────────────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<AutoSyncOutcome> | null = null;
/** 应用是否在前台：只有前台才允许排重试定时器（Android 不保证后台准点执行） */
let foreground = false;

export interface AutoSyncOutcome {
  ran: boolean;
  reason: AutoSyncSkipReason;
  result?: SyncLastResult;
  error?: string;
}

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** 取消所有待执行的自动同步（解除配对、关闭开关、退到后台时调用）。 */
export function cancelAutoSync(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  clearRetryTimer();
}

/**
 * 前台状态变化：退后台取消待执行的重试；回前台按持久化的 next_attempt_at 重新排。
 *
 * 这是「失败退避到期真的会重试」的落点：只写 next_attempt_at 不会自己触发，
 * 必须有一个在前台存活、可取消的定时器把时间带到下一次请求。
 */
export function setAutoSyncForeground(active: boolean): void {
  foreground = active;
  if (!active) {
    clearRetryTimer();
    return;
  }
  void scheduleRetryIfDue();
}

async function scheduleRetryIfDue(): Promise<void> {
  clearRetryTimer();
  if (!foreground) return;
  try {
    const [settings, state] = await Promise.all([loadAutoSyncSettings(), readAutoSyncState()]);
    if (!settings.enabled) return;
    if (state.nextAttemptAt <= 0) return;
    const delay = state.nextAttemptAt - Date.now();
    if (delay <= 0) {
      // 退避时间已过（例如进程重启后回到前台）：直接走一次请求，仍受防抖/单飞/退避约束
      requestAutoSync("retry");
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!foreground) return;
      void runAutoSync("retry");
    }, Math.min(delay, AUTO_SYNC_BACKOFF_MS[AUTO_SYNC_BACKOFF_MS.length - 1]));
  } catch {
    // 读设置失败不排重试，避免无依据的网络请求
  }
}

async function readAutoSyncState(): Promise<{
  lastSuccessAt: number;
  nextAttemptAt: number;
  failures: number;
}> {
  const [lastSuccessRaw, nextAttemptRaw, failuresRaw] = await Promise.all([
    getSetting(KEY_LAST_SUCCESS),
    getSetting(KEY_NEXT_ATTEMPT),
    getSetting(KEY_FAILURES),
  ]);
  return {
    lastSuccessAt: Number(lastSuccessRaw ?? 0) || 0,
    nextAttemptAt: Number(nextAttemptRaw ?? 0) || 0,
    failures: Number(failuresRaw ?? 0) || 0,
  };
}

/**
 * 执行一次自动同步（已调度过防抖）。并发触发返回同一个在途 Promise。
 *
 * 不抛错：所有失败都折算成 outcome.error 并落到同步页状态。
 */
export async function runAutoSync(reason: AutoSyncReason): Promise<AutoSyncOutcome> {
  if (runInFlight) return runInFlight;
  const task = executeAutoSync(reason).finally(() => {
    runInFlight = null;
  });
  runInFlight = task;
  return task;
}

async function executeAutoSync(reason: AutoSyncReason): Promise<AutoSyncOutcome> {
  let outcome: AutoSyncOutcome;
  try {
    const [settings, connection, token, pendingOps, state] = await Promise.all([
      loadAutoSyncSettings(),
      loadConnection(),
      readToken(),
      countPendingSyncOps().catch(() => 0),
      readAutoSyncState(),
    ]);
    const paired = Boolean(connection) && !isLegacyConnection(connection);
    const metering = probeNetworkMetering();
    const decision = decideAutoSync({
      settings,
      paired,
      hasToken: Boolean(token),
      metering,
      hasPendingLocalChanges: pendingOps > 0,
      now: Date.now(),
      lastSuccessAt: state.lastSuccessAt,
      nextAttemptAt: state.nextAttemptAt,
      syncing: isSyncing(),
    });

    if (!decision.run) {
      const label =
        decision.reason === "ok"
          ? describeSkipReason(decision.reason)
          : `${describeSkipReason(decision.reason)}`;
      lastAutoNote = `${label}（${reason}）`;
      outcome = { ran: false, reason: decision.reason };
      return outcome;
    }

    const result = await syncNow();
    const now = Date.now();
    clearRetryTimer();
    await Promise.all([
      setSetting(KEY_LAST_SUCCESS, String(now)),
      setSetting(KEY_FAILURES, "0"),
      setSetting(KEY_NEXT_ATTEMPT, "0"),
    ]);
    lastAutoNote = `自动同步完成（${reason}）：接收 ${result.applied}，发送 ${result.pushed}`;
    outcome = { ran: true, reason: "ok", result };
    for (const listener of completedListeners) {
      try {
        listener(result);
      } catch {
        // 订阅方异常不影响同步
      }
    }
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = await readAutoSyncState().catch(() => ({ failures: 0 } as {
      failures: number;
    }));
    const failures = (state.failures ?? 0) + 1;
    const next = Date.now() + backoffForFailure(failures);
    await setSetting(KEY_FAILURES, String(failures)).catch(() => undefined);
    await setSetting(KEY_NEXT_ATTEMPT, String(next)).catch(() => undefined);
    // 文案必须与实际行为一致：前台有定时器时才是「X 秒后重试」；否则只能说「下次满足条件」
    lastAutoNote = foreground
      ? `自动同步失败（${reason}）：${message}；${Math.round(
          backoffForFailure(failures) / 1000,
        )} 秒后重试`
      : `自动同步失败（${reason}）：${message}；下次满足条件时重试`;
    void scheduleRetryIfDue();
    outcome = { ran: true, reason: "ok", error: message };
    return outcome;
  } finally {
    await loadSyncStatus().catch(() => undefined);
  }
}

/**
 * 请求一次自动同步（防抖合并）。
 *
 * 调用点：App 回到前台、任意本地写入、保存采集后。重复调用只保留最后一次调度，
 * 因此连续输入 10 条收集箱也只会触发一次同步。
 */
export function requestAutoSync(reason: AutoSyncReason): void {
  void (async () => {
    try {
      const settings = await loadAutoSyncSettings();
      if (!settings.enabled) return;
      cancelAutoSync();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void runAutoSync(reason);
      }, AUTO_SYNC_DEBOUNCE_MS);
    } catch {
      // 读设置失败视为关闭，不启动任何网络行为
    }
  })();
}

// 数据层每次成功写库都会通知：写入后 8s 合并触发一次同步（开关关闭时直接返回）。
subscribeLocalChange(() => requestAutoSync("local_change"));
