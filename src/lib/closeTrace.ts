//! 关闭链路终端追踪：把前端关键阶段写进 Rust `tracing`（终端可见）。
//!
//! 背景：`logEvent` 只进诊断中心（本地文件 + 诊断页），终端看不到。
//! 关闭失败复盘需要 `CLOSE_GUARD_*` 与 Rust 的 `CLOSE_REQUESTED /
//! CLOSE_GEOMETRY_* / WINDOW_DESTROYED` 出现在同一条时间线上，因此单开这条
//! 窄通道。
//!
//! 约束：
//! - 只传白名单阶段名 + 标量字段；**不传正文、项目名、文件路径**；
//! - 同步入队、失败静默降级：诊断绝不能影响关闭本身，也不能反过来触发错误上报
//!   （因此用原始 `invoke`，不走 `invokeCommand`）；
//! - 非 Tauri 环境（浏览器预览 / 单测）直接 no-op，不产生无效 IPC。

import { invoke } from "@tauri-apps/api/core";

export interface CloseTraceFields {
  attemptId?: string | null;
  windowLabel?: string | null;
  route?: string | null;
  module?: string | null;
  duplicate?: boolean;
  durationMs?: number;
  result?: string | null;
  /** 短标签（如 `chapter=a1b2c3d4`）；禁止正文。 */
  detail?: string | null;
}

/** Tauri 运行时探测结果缓存：一次失败后不再反复尝试。 */
let available: boolean | null = null;

function isTauriRuntime(): boolean {
  if (available !== null) return available;
  try {
    available = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    available = false;
  }
  return available;
}

/**
 * 记录一条关闭链路阶段。
 *
 * @param stage 白名单阶段名（Rust 侧二次校验，未知阶段会被拒绝并告警）
 * @param fields 标量上下文；值会被 Rust 侧截断与清洗
 */
export function traceWorkbenchClose(stage: string, fields: CloseTraceFields = {}): void {
  if (!isTauriRuntime()) return;
  try {
    const payload = { stage, ...fields };
    // 必须同步投递：动态 import 会让末段（FLUSH_COMPLETED / ALLOWED）晚于
    // 窗口销毁，或在关闭事务之间乱序，验收无法据此还原真实顺序。
    void invoke<void>("workbench_close_trace", { payload }).catch(() => {
      // 窗口正在销毁时 IPC 可能直接失败：关闭通道，避免后续反复报错。
      available = false;
    });
  } catch {
    available = false;
  }
}
