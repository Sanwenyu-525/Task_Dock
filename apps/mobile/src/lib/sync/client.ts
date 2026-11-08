// 同步客户端骨架：只负责「带超时、有界退避、可取消」地调用 v1 端点。
//
// 明确约束：
// - 本文件不会自动发起任何请求：只有调用 pull()/push() 才会触网，便于在配对前保持完全离线；
// - fetchImpl 可注入，默认使用全局 fetch，测试可替换为纯内存实现；
// - 不做任何落库/合并，收到 PullResult / PushResult 后由调用方决定如何应用。
import { AppError, isAppError, toAppError } from "../errors";

import { parsePullResult, parsePushResult, type Op, type PullResult, type PushResult } from "./protocol";

/** 单次请求超时；与 docs/MOBILE_STACK.md §3.6 一致 */
const REQUEST_TIMEOUT_MS = 5_000;
/** 重试延时序列：1/2/4/8/16/32 秒；60 秒是上限护栏 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000] as const;
const MAX_BACKOFF_MS = 60_000;
/** 最多重试 6 次（首次尝试之外）；全部失败后抛出最后一次错误 */
const MAX_RETRIES = 6;
const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 500;

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<HttpResponseLike>;

export interface SyncClientOptions {
  /** 桌面端局域网地址，例如 https://192.168.1.10:8787 */
  baseUrl: string;
  /** 配对时签发的设备令牌；只进请求头，绝不写日志 */
  token: string;
  /** 设备标识；缺省时由服务端从 token 推导 */
  deviceId?: string;
  fetchImpl?: FetchLike;
}

export interface SyncClient {
  pull(since: string, limit?: number): Promise<PullResult>;
  push(ops: readonly Op[]): Promise<PushResult>;
  /** 取消所有在途请求与退避定时器；取消后客户端仍可继续发起新请求 */
  cancel(): void;
}

interface ActiveOperation {
  cancelled: boolean;
  controllers: Set<AbortController>;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** 退避等待的唤醒函数：取消时立即结束等待 */
  wake: (() => void) | null;
}

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`同步请求失败：HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

function cancelledError(): AppError {
  return new AppError("network", "同步请求已取消");
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // 超时与网络层异常都会被 attemptRequest 包装成 network；validation 等不重试。
  if (isAppError(error)) return error.kind === "network";
  return false;
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new AppError("validation", "同步服务地址不能为空");
  if (!options.token) throw new AppError("validation", "同步令牌不能为空");

  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const active = new Set<ActiveOperation>();

  function createOperation(): ActiveOperation {
    const operation: ActiveOperation = {
      cancelled: false,
      controllers: new Set(),
      timers: new Set(),
      wake: null,
    };
    active.add(operation);
    return operation;
  }

  function cancelOperation(operation: ActiveOperation): void {
    operation.cancelled = true;
    for (const controller of operation.controllers) controller.abort();
    operation.controllers.clear();
    for (const timer of operation.timers) clearTimeout(timer);
    operation.timers.clear();
    const wake = operation.wake;
    operation.wake = null;
    if (wake) wake();
  }

  function sleep(operation: ActiveOperation, ms: number): Promise<void> {
    if (operation.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        operation.timers.delete(timer);
        operation.wake = null;
        resolve();
      }, ms);
      operation.timers.add(timer);
      // cancelOperation 会清掉 timer 并调用 wake，保证取消后不留下悬挂的定时器
      operation.wake = resolve;
    });
  }

  async function attempt(operation: ActiveOperation, url: string, init: FetchInitLike): Promise<unknown> {
    if (operation.cancelled) throw cancelledError();

    const controller = new AbortController();
    operation.controllers.add(controller);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    operation.timers.add(timer);

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new HttpStatusError(response.status);
      try {
        return await response.json();
      } catch (error) {
        throw new AppError("validation", "同步响应不是合法 JSON", error);
      }
    } catch (error) {
      if (operation.cancelled) throw cancelledError();
      if (timedOut) throw new AppError("network", "同步请求超时（5s）", error);
      if (error instanceof HttpStatusError) throw error;
      throw toAppError(error, "network");
    } finally {
      clearTimeout(timer);
      operation.timers.delete(timer);
      operation.controllers.delete(controller);
    }
  }

  async function request<T>(
    operation: ActiveOperation,
    url: string,
    init: FetchInitLike,
    parse: (body: unknown) => T,
  ): Promise<T> {
    let lastError: unknown = null;

    for (let attemptIndex = 0; attemptIndex <= MAX_RETRIES; attemptIndex += 1) {
      if (operation.cancelled) throw cancelledError();

      try {
        return parse(await attempt(operation, url, init));
      } catch (error) {
        lastError = error;
        if (operation.cancelled) throw cancelledError();
        if (attemptIndex >= MAX_RETRIES || !isRetryable(error)) break;

        const delay = Math.min(
          RETRY_DELAYS_MS[Math.min(attemptIndex, RETRY_DELAYS_MS.length - 1)],
          MAX_BACKOFF_MS,
        );
        await sleep(operation, delay);
      }
    }

    if (isAppError(lastError)) throw lastError;
    throw toAppError(lastError, "network");
  }

  function headers(): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${options.token}`,
    };
  }

  function pull(since: string, limit = DEFAULT_PULL_LIMIT): Promise<PullResult> {
    const operation = createOperation();
    const safeLimit = Math.min(
      Math.max(Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_PULL_LIMIT, 1),
      MAX_PULL_LIMIT,
    );
    const url = `${baseUrl}/v1/changes?since=${encodeURIComponent(since)}&limit=${safeLimit}`;

    return request(operation, url, { method: "GET", headers: headers() }, parsePullResult).finally(
      () => {
        active.delete(operation);
      },
    );
  }

  function push(ops: readonly Op[]): Promise<PushResult> {
    // 空队列不发请求，避免无意义的鉴权与流量
    if (ops.length === 0) return Promise.resolve({ ack: [], conflicts: [] });

    const operation = createOperation();
    const url = `${baseUrl}/v1/ops`;
    const body = JSON.stringify({ device_id: options.deviceId, ops });

    return request(
      operation,
      url,
      {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body,
      },
      (response) => parsePushResult(response, ops),
    ).finally(() => {
      active.delete(operation);
    });
  }

  function cancel(): void {
    for (const operation of active) cancelOperation(operation);
    active.clear();
  }

  return { pull, push, cancel };
}
