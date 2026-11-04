//! 未处理异常兜底（每个窗口入口安装一次）。
//!
//! - 只处理 `unhandledrejection`：漏网的异步失败仍要让用户知道，而不是只留在控制台；
//! - 渲染异常由 `ErrorBoundary` 处理，这里不重复监听 `error` 事件，避免同一异常两次提示；
//! - 正常取消（AbortError / 已取消）不提示；
//! - 相同根因 30s 内只提示一次；处理器自身吞掉异常，绝不抛出第二个异常；
//! - 独立小窗口（快速捕获/通知/右键菜单）没有 Toast 宿主，只写诊断日志（`toast: false`），
//!   不把提示发到用户看不见的窗口里。

import { normalizeError } from "./errors";
import { reportError } from "./errorReport";

const DEDUPE_MS = 30_000;
const recent = new Map<string, number>();
let installed = false;

function shouldReport(key: string): boolean {
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
      if (!shouldReport(`${err.code}:${err.message}`)) return;
      if (withToast) {
        reportError(err, { operation: "后台任务" });
      } else {
        console.warn(`[unhandledrejection] ${err.code}: ${err.message}`, err.detail ?? "");
      }
    } catch {
      // 兜底处理器自身失败不得影响渲染或业务
    }
  });
}
