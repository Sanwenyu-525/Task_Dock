//! 主窗口 → 统一工作台的导航事务（U0）。
//!
//! 「invoke 返回成功」只代表请求已入队；真实结果只认工作台回执：
//! - `succeeded`：工作台已切到目标功能（窗口已唤醒并聚焦）；
//! - `pending`：工作台有未保存草稿，已弹出确认条，等用户确认/取消；
//! - `cancelled`：用户取消切换，原页面与草稿保留；
//! - `failed`：路由被拒绝/保存中/窗口不可用，附可读原因。
//!
//! requestId 由本模块**在发命令之前**生成并登记监听：工作台可能在命令响应
//! 返回之前就回执（窗口已存在时尤其常见），晚登记会丢掉早到的回执并假超时。
//!
//! `pending` 不是终态：本模块保留回执监听，返回的 outcome 同时带有
//! `settled` Promise，最终确认/取消/超时会收敛为确定结果。普通快捷按钮可以
//! 只消费初始状态（不阻塞），需要最终结果的后台流程使用 `openWorkbenchAndWait`。
//!
//! 失败不伪造成功：超时、订阅失败、编号不一致都返回 `failed` 并写诊断；
//! 胶囊/主面板据此展示失败原因，而不是静默当作已打开。

import {
  onWorkbenchNavAck,
  workbenchOpenWindow,
  type WorkbenchNavAck,
  type WorkbenchNavStatus,
  type WorkbenchNavTarget,
} from "./bridge";
import { logEvent } from "./diagnostics";
import { errorMessage } from "./errors";

export type WorkbenchNavOutcomeStatus = WorkbenchNavStatus;

export interface WorkbenchNavOutcome {
  /** 已切到目标功能（pending 时为 false）。 */
  ok: boolean;
  /** 被未保存草稿拦截，等待用户在工作台确认（不是失败，也还不是成功）。 */
  pending: boolean;
  status: WorkbenchNavOutcomeStatus;
  /** 非 succeeded 时的可读原因。 */
  error: string | null;
  requestId: number;
  /** 本次调用是否创建了工作台窗口（诊断用）。 */
  created: boolean;
  /**
   * 最终回执（终态）。非 pending 时与当前结果相同；pending 时等待用户
   * 确认/取消或超时。任何已受理请求都能通过它追踪到确定结果。
   */
  settled: Promise<WorkbenchNavOutcome>;
}

export interface OpenWorkbenchOptions {
  /** 覆盖默认初始回执超时（测试用）。 */
  timeoutMs?: number;
  /** 覆盖 pending 等待用户决定的超时（测试用）。 */
  pendingTimeoutMs?: number;
  /** 注入请求编号（测试/重试用；正常由本模块生成）。 */
  requestId?: number;
}

const ACK_TIMEOUT_MS = 12_000;
/**
 * pending 的最终等待上限：略大于 Rust 侧 awaiting 清理阈值（300s），
 * 让 Rust 先清理迟到回执，再由前端如实报告超时。
 */
const PENDING_SETTLE_TIMEOUT_MS = 320_000;

let requestSeq = 0;

/** 客户端请求编号：Date.now()*1000 + 序号，进程内单调且与既有协议同口径。 */
export function nextWorkbenchRequestId(): number {
  requestSeq = (requestSeq + 1) % 1000;
  return Date.now() * 1000 + requestSeq;
}

function finish(
  status: WorkbenchNavOutcomeStatus,
  requestId: number,
  created: boolean,
  error: string | null,
  settled: Promise<WorkbenchNavOutcome>,
): WorkbenchNavOutcome {
  return {
    ok: status === "succeeded",
    pending: status === "pending",
    status,
    error,
    requestId,
    created,
    settled,
  };
}

function reportFailure(action: string, message: string): void {
  logEvent({
    level: "WARN",
    module: "workbench-nav",
    action,
    event: "navigate-failed",
    message,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Node 环境下不因测试残留 pending 计时器而阻塞进程；浏览器无 unref 时忽略。 */
function armTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

function statusError(status: WorkbenchNavOutcomeStatus, error: string | null): string | null {
  if (status === "succeeded") return null;
  if (status === "pending") {
    return error ?? "工作台有未保存内容：已在工作台弹出确认条，确认前不会切换";
  }
  if (status === "cancelled") return error ?? "已在工作台取消切换";
  return error ?? "工作台导航失败";
}

/** 立即终结的结果（订阅/命令失败等，没有后续回执可等）。 */
function terminalOutcome(
  status: WorkbenchNavOutcomeStatus,
  requestId: number,
  created: boolean,
  error: string | null,
): WorkbenchNavOutcome {
  const settled = deferred<WorkbenchNavOutcome>();
  const outcome = finish(status, requestId, created, statusError(status, error), settled.promise);
  settled.resolve(outcome);
  return outcome;
}

/**
 * 打开/唤醒工作台并导航到结构化目标。只应在主窗口（胶囊/完整面板）调用。
 *
 * 返回初始结果；pending 时通过 `outcome.settled` 等待最终结果。
 */
export async function openWorkbench(
  target: WorkbenchNavTarget,
  options: OpenWorkbenchOptions = {},
): Promise<WorkbenchNavOutcome> {
  const requestId = options.requestId ?? nextWorkbenchRequestId();
  const timeoutMs = options.timeoutMs ?? ACK_TIMEOUT_MS;
  const pendingTimeoutMs = options.pendingTimeoutMs ?? PENDING_SETTLE_TIMEOUT_MS;

  const initialDeferred = deferred<WorkbenchNavOutcome>();
  const settledDeferred = deferred<WorkbenchNavOutcome>();
  let initialResolved = false;
  let settledResolved = false;
  let commandDone = false;
  let created = false;
  const earlyAcks: WorkbenchNavAck[] = [];

  let unlisten: (() => void) | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    if (initialTimer !== null) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    unlisten?.();
    unlisten = null;
  };

  const outcomeFor = (
    status: WorkbenchNavOutcomeStatus,
    error: string | null,
  ): WorkbenchNavOutcome =>
    finish(status, requestId, created, statusError(status, error), settledDeferred.promise);

  const resolveInitial = (outcome: WorkbenchNavOutcome): void => {
    if (initialResolved) return;
    initialResolved = true;
    if (initialTimer !== null) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    initialDeferred.resolve(outcome);
  };

  const resolveSettled = (outcome: WorkbenchNavOutcome, alsoInitial = false): void => {
    if (settledResolved) return;
    settledResolved = true;
    settledDeferred.resolve(outcome);
    if (alsoInitial) resolveInitial(outcome);
    cleanup();
  };

  const handleAck = (ack: WorkbenchNavAck): void => {
    if (ack.requestId !== requestId || settledResolved) return;
    if (ack.status === "pending") {
      // 重复 pending（用户还没决定时事件重放）不改变任何状态。
      if (initialResolved) return;
      resolveInitial(outcomeFor("pending", ack.error));
      pendingTimer = armTimer(() => {
        const outcome = outcomeFor(
          "failed",
          `等待工作台确认超时（${Math.round(pendingTimeoutMs / 1000)} 秒）；工作台内的确认条可能仍可操作`,
        );
        resolveSettled(outcome);
      }, pendingTimeoutMs);
      return;
    }
    // 终态可能先于 pending 到达（pending 事件丢失/用户瞬间取消）：同时收敛初始结果。
    const outcome = outcomeFor(ack.status, ack.error);
    resolveSettled(outcome, !initialResolved);
  };

  // 先登记回执监听，再发命令：工作台可能在命令响应之前就回执。
  try {
    unlisten = await onWorkbenchNavAck((ack) => {
      if (ack.requestId !== requestId) return;
      if (!commandDone) {
        earlyAcks.push(ack);
        return;
      }
      handleAck(ack);
    });
  } catch (e) {
    const message = `无法订阅工作台回执：${errorMessage(e)}`;
    reportFailure("subscribe-ack", message);
    return terminalOutcome("failed", requestId, false, message);
  }

  try {
    const response = await workbenchOpenWindow({
      target,
      projectId: target.projectId ?? null,
      requestId,
    });
    created = response.created;
    commandDone = true;
    if (response.requestId !== requestId) {
      const message = "工作台回执编号不一致，请重试";
      reportFailure("request-id-mismatch", message);
      cleanup();
      return terminalOutcome("failed", requestId, created, message);
    }

    // 先处理命令返回前已经到达的回执（早到回执不能丢）。
    for (const ack of earlyAcks) handleAck(ack);
    earlyAcks.length = 0;

    if (!initialResolved) {
      initialTimer = armTimer(() => {
        const outcome = outcomeFor(
          "failed",
          `工作台未在 ${Math.round(timeoutMs / 1000)} 秒内回执（可能仍在启动或渲染失败）；窗口若已打开，请手动切换功能后重试`,
        );
        reportFailure("ack-timeout", outcome.error ?? "ack-timeout");
        resolveSettled(outcome, true);
      }, timeoutMs);
    }

    return await initialDeferred.promise;
  } catch (e) {
    commandDone = true;
    const message = `打开工作台失败：${errorMessage(e)}`;
    reportFailure("open-window", message);
    cleanup();
    return terminalOutcome("failed", requestId, false, message);
  }
}

/**
 * 等待导航最终结果（包含 pending → 用户确认/取消）。用于确实需要终态的后台
 * 流程；胶囊快捷入口不应使用它，以免按钮无限等待。
 */
export async function openWorkbenchAndWait(
  target: WorkbenchNavTarget,
  options: OpenWorkbenchOptions = {},
): Promise<WorkbenchNavOutcome> {
  const initial = await openWorkbench(target, options);
  if (!initial.pending) return initial;
  return initial.settled;
}

/** 打开工作台首页（胶囊的完整工作台入口）。 */
export function openWorkbenchHome(options?: OpenWorkbenchOptions): Promise<WorkbenchNavOutcome> {
  return openWorkbench({ tab: "home" }, options);
}

/** 测试/诊断：重置请求序号。 */
export function __resetWorkbenchNavForTests(): void {
  requestSeq = 0;
}
