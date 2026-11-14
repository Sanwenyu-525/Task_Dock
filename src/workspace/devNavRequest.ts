//! 跨窗口「打开开发工作台」请求状态机（P0-A，2026-11-13）。
//!
//! 这是纯函数层，**不依赖 Tauri/React**：所有竞态都能在单测里逐条复现。
//!
//! ## 要解决的时序
//! 1. 回执先于命令响应：requestId 由工作空间窗口**在发命令之前**生成并登记，
//!    因此早到的回执能被识别；命令响应晚到只是重复确认同一个编号。
//! 2. 重复回执：同一个 requestId 的终态只处理一次。
//! 3. 迟到回执：已经被新请求取代的旧编号直接忽略；只有「当前没有在途请求、
//!    且编号正好是刚刚收敛的那一个」才允许修正展示（并标记 late）。
//! 4. pending 不是终态：主窗口被未保存草稿拦截后先回 pending，用户确认/取消后
//!    再回 succeeded/cancelled；pending 期间**不得**显示「已进入开发工作台」。
//! 5. 超时：只有仍在等待首个结果时才超时；pending 之后超时不再触发（已有结果）。

import type { OpenDevWorkbenchAck, OpenDevWorkbenchStatus } from "../lib/bridge";

export type DevNavPhase =
  | { state: "idle" }
  | { state: "requesting"; requestId: number }
  | { state: "pending"; requestId: number }
  /** 导航真实生效（标签已切且开发项目上下文已提交）。`late` = 超时后才收到。 */
  | { state: "success"; requestId: number; late: boolean }
  /** 用户在主窗口取消了未保存草稿的切换，导航未发生。 */
  | { state: "cancelled"; requestId: number; late: boolean }
  | {
      state: "error";
      requestId: number;
      error: string | null;
      timedOut: boolean;
      late: boolean;
    };

export interface DevNavTracker {
  /** 正在等待结果的请求；null = 没有在途请求。 */
  current: number | null;
  /** 最近一次已收敛（成功/失败/取消/超时）的请求，用于识别同请求迟到回执。 */
  settled: number | null;
  /** 已收敛请求最终采用的回执状态：同状态重复回执直接忽略（只处理一次）。 */
  settledStatus: OpenDevWorkbenchStatus | null;
  phase: DevNavPhase;
}

export const INITIAL_DEV_NAV: DevNavTracker = {
  current: null,
  settled: null,
  settledStatus: null,
  phase: { state: "idle" },
};

/** 兼容旧后端：没有 status 时按 ok/pending 推导。 */
export function resolveAckStatus(ack: Pick<OpenDevWorkbenchAck, "ok" | "pending" | "status">): OpenDevWorkbenchStatus {
  if (ack.status) return ack.status;
  if (ack.pending) return "pending";
  return ack.ok ? "succeeded" : "failed";
}

/** 登记新请求（必须在调用命令之前）。旧的未决请求由调用方负责收尾。 */
export function beginDevNav(requestId: number): DevNavTracker {
  return {
    current: requestId,
    settled: null,
    settledStatus: null,
    phase: { state: "requesting", requestId },
  };
}

function finalPhase(
  status: Exclude<OpenDevWorkbenchStatus, "pending">,
  requestId: number,
  error: string | null,
  late: boolean,
): DevNavPhase {
  switch (status) {
    case "succeeded":
      return { state: "success", requestId, late };
    case "cancelled":
      return { state: "cancelled", requestId, late };
    default:
      return { state: "error", requestId, error, timedOut: false, late };
  }
}

export type ApplyAckResult =
  /** 与本请求无关（过期/旧请求/已收敛请求的重复回执）。 */
  | { kind: "ignored" }
  /** 当前在途请求的状态推进；`final=true` 表示已经收敛。 */
  | { kind: "updated"; tracker: DevNavTracker; final: boolean }
  /** 刚刚收敛的同一请求的迟到回执：只修正展示，不产生在途请求。 */
  | { kind: "late"; tracker: DevNavTracker };

export function applyDevNavAck(
  tracker: DevNavTracker,
  ack: OpenDevWorkbenchAck,
): ApplyAckResult {
  const status = resolveAckStatus(ack);

  if (tracker.current === ack.requestId) {
    if (status === "pending") {
      // 同一个 pending 回执重复到达：状态不变，不重复处理。
      if (tracker.phase.state === "pending" && tracker.phase.requestId === ack.requestId) {
        return { kind: "ignored" };
      }
      return {
        kind: "updated",
        final: false,
        tracker: { ...tracker, phase: { state: "pending", requestId: ack.requestId } },
      };
    }
    return {
      kind: "updated",
      final: true,
      tracker: {
        current: null,
        settled: ack.requestId,
        settledStatus: status,
        phase: finalPhase(status, ack.requestId, ack.error, false),
      },
    };
  }

  // 迟到回执只在「没有新的在途请求」且编号正好是刚收敛的那个时才生效：
  // 它不能覆盖新请求，也不能被当成新请求的结果。
  if (tracker.current === null && tracker.settled === ack.requestId) {
    // 同状态重复回执只处理一次（避免把「已成功」重复判成「迟到成功」）。
    if (tracker.settledStatus === status) return { kind: "ignored" };
    // 已经收敛出终态后，迟到的 pending 不能把结果退回「等待确认」。
    if (status === "pending" && tracker.settledStatus !== null) {
      return { kind: "ignored" };
    }
    const phase: DevNavPhase =
      status === "pending"
        ? { state: "pending", requestId: ack.requestId }
        : finalPhase(status, ack.requestId, ack.error, true);
    return {
      kind: "late",
      tracker: { ...tracker, settledStatus: status, phase },
    };
  }

  return { kind: "ignored" };
}

/** 等待首个结果超时：只有仍在 requesting 的请求会被判超时。 */
export function applyDevNavTimeout(tracker: DevNavTracker, requestId: number): DevNavTracker {
  if (tracker.current !== requestId) return tracker;
  if (tracker.phase.state !== "requesting") return tracker;
  return {
    current: null,
    settled: requestId,
    settledStatus: null,
    phase: { state: "error", requestId, error: null, timedOut: true, late: false },
  };
}

/** 命令本身失败（主窗口不可用、事件发送失败、项目校验失败等）。 */
export function applyDevNavFailure(
  tracker: DevNavTracker,
  requestId: number,
  error: string,
): DevNavTracker {
  if (tracker.current !== requestId) return tracker;
  return {
    current: null,
    settled: requestId,
    settledStatus: null,
    phase: { state: "error", requestId, error, timedOut: false, late: false },
  };
}

/** 是否已有在途请求（用于单飞：requesting 期间不允许并发发起）。 */
export function devNavInFlight(tracker: DevNavTracker): boolean {
  return tracker.current !== null;
}

/** 下一次用户点击是否可以发起（requesting 中禁止；pending/终态允许取代）。 */
export function canStartDevNav(tracker: DevNavTracker): boolean {
  return tracker.phase.state !== "requesting";
}
