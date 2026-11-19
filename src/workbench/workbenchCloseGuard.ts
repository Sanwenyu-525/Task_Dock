//! 工作台窗口关闭协调器：单一关闭事务 + 保存等待上限 + 明确状态机。
//!
//! ## 为什么需要状态机（2026-11-19 关闭专项）
//!
//! 旧实现只有 `running` / `allowClose` 两个布尔值，并且把「flush 成功」与
//! 「close() Promise 完成」当成窗口已销毁。真实故障是：
//! 1. 有保存 IPC 永久 pending 时 `await flush()` 永不返回 → `running` 永久为真；
//! 2. 之后的每次 CloseRequested 都被同步 `preventDefault()` 后静默 return；
//! 3. 标题栏在 close IPC resolve 时就解锁，用户以为没点上，继续点击，
//!    于是日志里只有连续 `CLOSE_REQUESTED`、没有任何后续解释。
//!
//! 现在的契约：
//! - 一个窗口同时只允许一笔有效关闭事务；
//! - 任何 CloseRequested 只要没被许可都**同步** `preventDefault()`；
//! - 保存等待有上限（默认 15s）；超时只停止本次等待，**不取消、不覆盖**
//!   底层保存，原始 Promise 保留给下一次重试复用；
//! - `close()` 受理 ≠ 窗口销毁：受理后进入 `closed` 并挂销毁兜底，仍未销毁
//!   则恢复为可重试的 `failed`；
//! - 关闭成功后 `allowClose` 终身有效，不会退回 idle。
//!
//! 诊断阶段名与 Rust `workbench_close_trace` 白名单一一对应。

export interface WorkbenchCloseEvent {
  preventDefault: () => void;
}

export interface WorkbenchCloseWindow {
  onCloseRequested: (
    handler: (event: WorkbenchCloseEvent) => void | Promise<void>,
  ) => Promise<() => void>;
  close: () => Promise<void>;
  /** 窗口 label（诊断用）；旧替身/非 Tauri 环境可缺省。 */
  label?: () => string;
}

export type WorkbenchCloseState =
  | "idle"
  | "saving"
  | "retrying-close"
  | "failed"
  | "closed";

export type WorkbenchCloseFailureReason =
  | "flush-false"
  | "flush-error"
  | "flush-timeout"
  | "close-rejected"
  | "not-destroyed";

export interface WorkbenchCloseSnapshot {
  state: WorkbenchCloseState;
  /** 本次关闭事务标识（诊断串联用）；idle 时为 null。 */
  attemptId: string | null;
  /** 失败原因；成功路径为 null。 */
  reason: WorkbenchCloseFailureReason | null;
  /** 底层保存是否仍在进行（超时后仍为 true：可以继续等待或稍后重试）。 */
  flushPending: boolean;
  /** 本次事件是否只是重复请求（被并入进行中的事务）。 */
  duplicate: boolean;
}

export interface WorkbenchCloseContext {
  route?: string;
  module?: string;
}

export type WorkbenchCloseTrace = (
  stage: string,
  fields?: Record<string, unknown>,
) => void;

export interface WorkbenchCloseGuardOptions {
  window: WorkbenchCloseWindow;
  /** 当前工作台注册的正文离开守卫；没有正文模块时返回 null。 */
  getFlush: () => (() => Promise<boolean>) | null;
  /** 保存失败/关闭失败/超时提示；不会吞掉错误。 */
  onError: (error: unknown) => void;
  /** 关闭状态变化（标题栏据此禁用按钮 / 展示提示）。 */
  onStateChange?: (snapshot: WorkbenchCloseSnapshot) => void;
  /** 终端诊断通道（生产接 `traceWorkbenchClose`；单测可省略）。 */
  trace?: WorkbenchCloseTrace;
  /** 事务上下文（路由 / 当前项目模块），仅用于诊断。 */
  getContext?: () => WorkbenchCloseContext;
  /** 保存等待上限（毫秒）。 */
  timeoutMs?: number;
  /** close() 受理后等待窗口销毁的上限（毫秒）。 */
  destroyTimeoutMs?: number;
}

export interface WorkbenchCloseGuardHandle {
  /** 卸载：解绑事件并清理计时器；不重置已建立的状态。 */
  stop: () => void;
  /** 标题栏 X 按钮的统一入口（与 Alt+F4 共用同一笔事务）。 */
  requestClose: () => void;
  /** 当前状态快照（只读副本）。 */
  getState: () => WorkbenchCloseSnapshot;
}

/** 保存等待上限：与产品约定一致（15s 后必须给出反馈）。 */
export const WORKBENCH_CLOSE_TIMEOUT_MS = 15_000;
/** 关闭受理后等待销毁的上限：超过仍未销毁就恢复可重试。 */
export const WORKBENCH_CLOSE_DESTROY_TIMEOUT_MS = 5_000;

/**
 * 保存超时（**不是**保存失败）：底层 IPC 可能仍在进行。
 * 文案必须同时给出「未关闭」与「可以稍后重试」，不能假装成功或假装失败。
 */
export class WorkbenchCloseTimeoutError extends Error {
  readonly code = "WORKBENCH_CLOSE_TIMEOUT";
  constructor(waitedMs: number) {
    super(
      `正文保存仍在进行，工作台暂未关闭。可以继续等待，或稍后重试。（已等待 ${Math.round(
        waitedMs / 1000,
      )} 秒）`,
    );
    this.name = "WorkbenchCloseTimeoutError";
  }
}

function now(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function idleSnapshot(): WorkbenchCloseSnapshot {
  return {
    state: "idle",
    attemptId: null,
    reason: null,
    flushPending: false,
    duplicate: false,
  };
}

type FlushOutcome =
  | { kind: "settled"; ok: boolean; error?: unknown }
  | { kind: "timeout" };

/**
 * 安装关闭协调器。
 *
 * 无正文守卫时**不拦截**：不 preventDefault、不主动 close，窗口走原生关闭
 * （保留 Rust 的几何保存与销毁路径）。
 */
export async function installWorkbenchCloseGuard(
  options: WorkbenchCloseGuardOptions,
): Promise<WorkbenchCloseGuardHandle> {
  const timeoutMs = options.timeoutMs ?? WORKBENCH_CLOSE_TIMEOUT_MS;
  const destroyTimeoutMs = options.destroyTimeoutMs ?? WORKBENCH_CLOSE_DESTROY_TIMEOUT_MS;

  let disposed = false;
  /** 已许可关闭：后续 CloseRequested 直接放行（不得再 preventDefault）。 */
  let allowClose = false;
  /** 事务在途标记：同步置位，重复事件只能并入，不能另起 flush。 */
  let running = false;
  /** 底层保存原始 Promise：超时不清除，重试优先复用。 */
  let pendingFlush: Promise<boolean> | null = null;
  let attemptSeq = 0;
  let snapshot = idleSnapshot();
  /** 事务开始时的上下文（路由/模块），后续 trace 用同一份。 */
  let context: WorkbenchCloseContext = {};
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const windowLabel = (() => {
    try {
      return options.window.label?.() ?? null;
    } catch {
      return null;
    }
  })();

  const trace = (stage: string, fields: Record<string, unknown> = {}): void => {
    try {
      options.trace?.(stage, {
        attemptId: snapshot.attemptId,
        windowLabel,
        route: context.route ?? null,
        module: context.module ?? null,
        ...fields,
      });
    } catch {
      // 诊断永远不能影响关闭。
    }
  };

  const emit = (patch: Partial<WorkbenchCloseSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    try {
      options.onStateChange?.({ ...snapshot });
    } catch {
      // 订阅方异常不能打断关闭事务。
    }
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    clearTimeout(timer);
    timers.delete(timer);
  };

  const schedule = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  /** 保存 Promise 必须在超时后仍可追踪：只有真正结束后才清空。 */
  const startFlush = (flush: () => Promise<boolean>): Promise<boolean> => {
    const promise = (async () => flush())();
    pendingFlush = promise;
    void promise.then(
      () => {
        if (pendingFlush === promise) pendingFlush = null;
      },
      () => {
        if (pendingFlush === promise) pendingFlush = null;
      },
    );
    return promise;
  };

  /** 只等待，不取消：超时后底层 Promise 继续保留在 pendingFlush 里。 */
  const settleWithin = (promise: Promise<boolean>, ms: number): Promise<FlushOutcome> =>
    new Promise<FlushOutcome>((resolve) => {
      let settled = false;
      const timer = schedule(() => {
        if (settled) return;
        settled = true;
        resolve({ kind: "timeout" });
      }, ms);
      promise.then(
        (ok) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve({ kind: "settled", ok: Boolean(ok) });
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve({ kind: "settled", ok: false, error });
        },
      );
    });

  const nextAttemptId = (): string => {
    attemptSeq += 1;
    return `close-${attemptSeq}`;
  };

  /**
   * 真正发起关闭。调用前必须已确认保存成功（或本来就没有保存守卫）。
   * `allowClose` 必须在 `await close()` 之前置位：第二次 CloseRequested
   * 是同步事件，晚一微任务就会被自己的守卫再次拦下。
   */
  const finishClose = async (startedAt: number): Promise<void> => {
    emit({ state: "retrying-close", reason: null, flushPending: pendingFlush !== null });
    trace("CLOSE_GUARD_RETRY_CLOSE_STARTED");
    allowClose = true;
    // `close()` 也可能永远不返回（窗口已销毁但 IPC 回执丢失，或原生层被拖住）。
    // 「等待受理」同样必须有上限，否则又会回到「停在 retrying-close、按钮永远
    // 不可用、没有任何反馈」——那正是本次 P0 的原始症状。
    let rejection: unknown = null;
    const outcome = await new Promise<"accepted" | "rejected" | "timeout">((resolve) => {
      let settled = false;
      const timer = schedule(() => {
        if (settled) return;
        settled = true;
        resolve("timeout");
      }, destroyTimeoutMs);
      options.window.close().then(
        () => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve("accepted");
        },
        (error) => {
          rejection = error;
          if (settled) return;
          settled = true;
          clearTimer(timer);
          resolve("rejected");
        },
      );
    });
    if (disposed) return;

    if (outcome === "timeout") {
      allowClose = false;
      trace("CLOSE_GUARD_DESTROY_TIMEOUT", { detail: "close-accept-timeout" });
      emit({ state: "failed", reason: "not-destroyed", flushPending: false });
      options.onError(
        new Error(
          `关闭请求已发出，但窗口在 ${Math.round(destroyTimeoutMs / 1000)} 秒内既未销毁也未返回受理结果；请重试或使用 Alt+F4。`,
        ),
      );
      return;
    }

    if (outcome === "rejected") {
      allowClose = false;
      trace("CLOSE_GUARD_RETRY_CLOSE_FAILED", { result: "rejected" });
      emit({ state: "failed", reason: "close-rejected", flushPending: false });
      options.onError(rejection);
      return;
    }

    trace("CLOSE_GUARD_RETRY_CLOSE_ACCEPTED", { durationMs: elapsed(startedAt) });
    // 「受理」只是 IPC 返回，不等于窗口已销毁：保留 disabled，并挂兜底。
    emit({ state: "closed" });
    schedule(() => {
      if (disposed || snapshot.state !== "closed") return;
      allowClose = false;
      trace("CLOSE_GUARD_DESTROY_TIMEOUT");
      emit({ state: "failed", reason: "not-destroyed", flushPending: false });
      options.onError(
        new Error("关闭请求已被受理，但窗口仍未销毁；请重试或使用 Alt+F4。"),
      );
    }, destroyTimeoutMs);
  };

  const runTransaction = async (): Promise<void> => {
    if (running) return;
    running = true;
    const startedAt = now();
    try {
      context = (() => {
        try {
          return options.getContext?.() ?? {};
        } catch {
          return {};
        }
      })();
      const flush = (() => {
        try {
          return options.getFlush();
        } catch {
          return null;
        }
      })();

      if (!flush) {
        // 没有正文守卫：直接关闭，不额外 flush。
        trace("CLOSE_GUARD_NO_FLUSH");
        await finishClose(startedAt);
        return;
      }

      emit({ state: "saving", reason: null, flushPending: true });
      const reused = pendingFlush !== null;
      trace("CLOSE_GUARD_FLUSH_STARTED", { duplicate: false, detail: reused ? "reused" : "new" });

      const promise = pendingFlush ?? startFlush(flush);
      const outcome = await settleWithin(promise, timeoutMs);
      if (disposed) return;

      if (outcome.kind === "timeout") {
        // 只停止等待：pendingFlush 保留，下一次点击继续等同一个 Promise。
        trace("CLOSE_GUARD_FLUSH_TIMEOUT", {
          durationMs: elapsed(startedAt),
          result: "timeout",
        });
        emit({ state: "failed", reason: "flush-timeout", flushPending: true });
        options.onError(new WorkbenchCloseTimeoutError(timeoutMs));
        return;
      }

      if (!outcome.ok) {
        trace("CLOSE_GUARD_FLUSH_FAILED", {
          durationMs: elapsed(startedAt),
          result: outcome.error ? "error" : "false",
        });
        emit({
          state: "failed",
          reason: outcome.error ? "flush-error" : "flush-false",
          flushPending: false,
        });
        options.onError(
          outcome.error ?? new Error("正文尚未保存，工作台窗口保持打开"),
        );
        return;
      }

      trace("CLOSE_GUARD_FLUSH_COMPLETED", { durationMs: elapsed(startedAt) });
      await finishClose(startedAt);
    } catch (error) {
      if (disposed) return;
      // 兜底：事务内部任何未预期异常都必须回到可重试状态，不能永久卡在 saving。
      trace("CLOSE_GUARD_FLUSH_FAILED", { result: "unexpected" });
      emit({ state: "failed", reason: "flush-error", flushPending: pendingFlush !== null });
      options.onError(error);
    } finally {
      running = false;
    }
  };

  const requestClose = (): void => {
    if (disposed) return;
    if (snapshot.state === "saving" || snapshot.state === "retrying-close" || snapshot.state === "closed") {
      trace("CLOSE_GUARD_DUPLICATE", { duplicate: true, detail: snapshot.state });
      emit({ duplicate: true });
      return;
    }
    const attemptId = nextAttemptId();
    emit({ attemptId, duplicate: false, reason: null, flushPending: false });
    trace("CLOSE_GUARD_REQUESTED", { detail: "button" });
    void runTransaction();
  };

  const handler = (event: WorkbenchCloseEvent): void => {
    if (disposed) return;
    if (allowClose) {
      // 第二次 CloseRequested：直接放行，绝不再 preventDefault。
      trace("CLOSE_GUARD_ALLOWED");
      return;
    }
    const flush = (() => {
      try {
        return options.getFlush();
      } catch {
        return null;
      }
    })();
    if (!flush) {
      // 没有正文守卫：不拦截（Rust 侧照常保存几何并销毁）。
      trace("CLOSE_GUARD_NO_FLUSH", { detail: "native" });
      return;
    }
    // 必须在任何 await 之前同步阻止：晚一拍窗口可能已被销毁。
    event.preventDefault();
    // 显式清空 attemptId：此刻新事务尚未分配 id，而 snapshot 里可能还留着
    // 上一笔（已失败）的 id —— 带着它会把本次拦截记到旧事务上。
    trace("CLOSE_GUARD_PREVENTED", { attemptId: null });
    if (running) {
      trace("CLOSE_GUARD_DUPLICATE", { duplicate: true, detail: snapshot.state });
      emit({ duplicate: true });
      return;
    }
    const attemptId = nextAttemptId();
    emit({ attemptId, duplicate: false, reason: null, flushPending: false });
    trace("CLOSE_GUARD_REQUESTED", { detail: "native" });
    void runTransaction();
  };

  const stopListening = await options.window.onCloseRequested(handler);
  trace("CLOSE_GUARD_INSTALLED", { detail: "ready" });

  return {
    requestClose,
    getState: () => ({ ...snapshot }),
    stop: () => {
      if (disposed) return;
      disposed = true;
      trace("CLOSE_GUARD_DISPOSED");
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      stopListening();
    },
  };
}
