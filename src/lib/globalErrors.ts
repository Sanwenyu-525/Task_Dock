//! 未处理异常兜底（每个窗口入口安装一次）。
//!
//! - 处理 `unhandledrejection`：漏网的异步失败必须进入诊断日志，并让用户知道；
//! - 处理 `error`：事件处理器等 React 边界之外的未捕获异常进入诊断日志
//!   （渲染异常由 `ErrorBoundary` 归属，这里通过 `isLogged` 跳过，避免同一异常两条记录）；
//! - 正常取消（AbortError / 已取消）不记录、不提示；
//! - Toast 30s 内同一根因只提示一次；诊断日志对 250ms 内的重复观察做有界抑制，
//!   但被抑制的次数会在下一次实际写入时通过 `suppressed_since_last` 带回，
//!   后端仍能累计真实发生次数；
//! - 处理器自身吞掉异常，绝不抛出第二个异常；独立小窗口只写诊断、不弹 Toast。

import { normalizeError, type AppError } from "./errors";
import { reportError } from "./errorReport";
import { isLogged, logEvent, markLogged, reserveReport } from "./diagnostics";

const DEDUPE_MS = 30_000;
const recent = new Map<string, number>();
let installed = false;

function shouldToast(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of recent) {
    if (now - at > DEDUPE_MS) recent.delete(k);
  }
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  recent.set(key, now);
  return true;
}

function looksCancelled(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === "AbortError") return true;
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return /已取消|取消操作|aborted|abort/i.test(text);
}

/** 未处理 Promise 异常 → 诊断（250ms 内的重复观察只累计次数，不丢真实发生次数）。 */
function logUnhandledRejection(err: AppError): void {
  try {
    if (isLogged(err)) return;
    const reservation = reserveReport(err.code, err.message);
    if (!reservation.emit) return;
    const level =
      err.severity === "critical" ? "CRITICAL" : err.severity === "warning" ? "WARN" : "ERROR";
    logEvent({
      level,
      module: "ui",
      action: "unhandled_rejection",
      event: "failed",
      status: "failed",
      error_code: err.code,
      error_category: err.category,
      message: err.message,
      metadata:
        reservation.suppressed > 0
          ? { suppressed_since_last: reservation.suppressed }
          : undefined,
    });
    markLogged(err);
  } catch {
    // 诊断失败不得影响兜底。
  }
}

export interface GlobalErrorOptions {
  /** 是否弹 Toast（没有 Toast 宿主的独立小窗口传 false，仅记录诊断） */
  toast?: boolean;
}

export function installGlobalErrorHandlers(options: GlobalErrorOptions = {}): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const withToast = options.toast !== false;

  window.addEventListener("unhandledrejection", (event) => {
    try {
      if (looksCancelled(event.reason)) return;
      const err = normalizeError(event.reason);
      const toast = shouldToast(`${err.code}:${err.message}`);
      // 先归属诊断事件；重复发生由后端按指纹聚合并计数。
      logUnhandledRejection(err);
      if (withToast) {
        // 已归属，reportError 只负责用户提示（不会再写一条日志）。
        if (toast) reportError(err, { operation: "后台任务" });
      } else {
        console.warn(`[unhandledrejection] ${err.code}: ${err.message}`, err.detail ?? "");
      }
    } catch {
      // 兜底处理器自身失败不得影响渲染或业务
    }
  });

  // React ErrorBoundary 覆盖渲染/生命周期异常；这里补充事件处理器、定时器、
  // 原生回调等边界之外的未捕获异常（否则只会留在控制台）。
  window.addEventListener("error", (event) => {
    try {
      const detail = event as ErrorEvent;
      const raw = detail.error;
      if (raw && isLogged(raw)) return;
      if (looksCancelled(raw ?? detail.message)) return;
      const err = normalizeError(raw ?? detail.message);
      const reservation = reserveReport(err.code, err.message);
      if (!reservation.emit) return;
      logEvent({
        level: "ERROR",
        module: "ui",
        action: "uncaught_error",
        event: "failed",
        status: "failed",
        error_code: err.code,
        error_category: err.category,
        message: err.message,
        // 只保留文件名（不含完整本地路径）；Rust 端还会再次脱敏。
        component: typeof detail.filename === "string" ? detail.filename.split(/[\\/]/).pop() : undefined,
        metadata:
          reservation.suppressed > 0
            ? { suppressed_since_last: reservation.suppressed }
            : undefined,
      });
      if (raw) markLogged(raw);
    } catch {
      // ignore
    }
  });
}
