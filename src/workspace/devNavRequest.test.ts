//! P0-A 跨窗口导航请求状态机测试（2026-11-13）。
//!
//! 逐条覆盖验收要求的时序：回执先/后于命令返回、重复回执、迟到回执、
//! pending 之后确认/取消、超时、超时后迟到、命令失败、并发请求取代。
//! 这些断言只证明纯状态机，不证明真实窗口行为（那需要 Windows 真机）。

import { describe, expect, it } from "vitest";

import {
  INITIAL_DEV_NAV,
  applyDevNavAck,
  applyDevNavFailure,
  applyDevNavTimeout,
  beginDevNav,
  canStartDevNav,
  resolveAckStatus,
  type DevNavTracker,
} from "./devNavRequest";

const ack = (
  requestId: number,
  status: "pending" | "succeeded" | "cancelled" | "failed",
  error: string | null = null,
) => ({ requestId, status, ok: status === "succeeded", pending: status === "pending", error });

describe("跨窗口导航请求状态机", () => {
  it("回执先于命令返回：请求已登记，回执照常被识别", () => {
    const tracker = beginDevNav(101);
    expect(tracker.phase.state).toBe("requesting");
    const applied = applyDevNavAck(tracker, ack(101, "succeeded"));
    expect(applied.kind).toBe("updated");
    if (applied.kind !== "updated") return;
    expect(applied.final).toBe(true);
    expect(applied.tracker.phase.state).toBe("success");
    // 命令随后才返回（这里只是不再做任何状态写入）：结果不会被重置。
    expect(applied.tracker.current).toBeNull();
  });

  it("命令返回先于回执：等待期间状态仍是 requesting，回执到达后收敛", () => {
    const tracker = beginDevNav(102);
    expect(tracker.phase.state).toBe("requesting");
    const applied = applyDevNavAck(tracker, ack(102, "succeeded"));
    expect(applied.kind).toBe("updated");
  });

  it("两个同时请求：旧编号的迟到回执不能覆盖新请求", () => {
    const first = beginDevNav(1);
    const second = beginDevNav(2); // 用户又点了一次（旧请求被取代）
    const applied = applyDevNavAck(second, ack(1, "succeeded"));
    expect(applied.kind).toBe("ignored");
    expect(second.phase.state).toBe("requesting");
    expect(first.current).toBe(1);
  });

  it("迟到回执在超时后、没有新请求时修正展示并标记 late", () => {
    let tracker = beginDevNav(201);
    tracker = applyDevNavTimeout(tracker, 201);
    expect(tracker.phase).toMatchObject({ state: "error", timedOut: true });

    const applied = applyDevNavAck(tracker, ack(201, "succeeded"));
    expect(applied.kind).toBe("late");
    if (applied.kind !== "late") return;
    expect(applied.tracker.phase).toMatchObject({ state: "success", late: true });
    expect(applied.tracker.current).toBeNull();
  });

  it("超时后又有新请求：旧请求的迟到回执被忽略", () => {
    let tracker = beginDevNav(202);
    tracker = applyDevNavTimeout(tracker, 202);
    tracker = beginDevNav(203);
    const applied = applyDevNavAck(tracker, ack(202, "succeeded"));
    expect(applied.kind).toBe("ignored");
    expect(tracker.phase.state).toBe("requesting");
  });

  it("重复回执只处理一次", () => {
    const tracker = beginDevNav(301);
    const first = applyDevNavAck(tracker, ack(301, "succeeded"));
    expect(first.kind).toBe("updated");
    if (first.kind !== "updated") return;
    const duplicate = applyDevNavAck(first.tracker, ack(301, "succeeded"));
    expect(duplicate.kind).toBe("ignored");
  });

  it("pending 不是终态：保持等待，确认后再回 succeeded", () => {
    let tracker: DevNavTracker = beginDevNav(401);
    const pending = applyDevNavAck(tracker, ack(401, "pending"));
    expect(pending.kind).toBe("updated");
    if (pending.kind !== "updated") return;
    expect(pending.final).toBe(false);
    expect(pending.tracker.phase.state).toBe("pending");
    expect(pending.tracker.current).toBe(401);

    // 重复 pending 不重复处理
    const dup = applyDevNavAck(pending.tracker, ack(401, "pending"));
    expect(dup.kind).toBe("ignored");

    const done = applyDevNavAck(pending.tracker, ack(401, "succeeded"));
    expect(done.kind).toBe("updated");
    if (done.kind !== "updated") return;
    expect(done.tracker.phase.state).toBe("success");
    expect(done.tracker.current).toBeNull();
  });

  it("pending 之后用户取消：收敛为 cancelled", () => {
    const pending = applyDevNavAck(beginDevNav(402), ack(402, "pending"));
    if (pending.kind !== "updated") throw new Error("pending 未被识别");
    const cancelled = applyDevNavAck(pending.tracker, ack(402, "cancelled"));
    expect(cancelled.kind).toBe("updated");
    if (cancelled.kind !== "updated") return;
    expect(cancelled.tracker.phase.state).toBe("cancelled");
  });

  it("pending 之后不会因为首个结果超时被误判为失败", () => {
    const pending = applyDevNavAck(beginDevNav(403), ack(403, "pending"));
    if (pending.kind !== "updated") throw new Error("pending 未被识别");
    const afterTimeout = applyDevNavTimeout(pending.tracker, 403);
    expect(afterTimeout).toBe(pending.tracker);
    expect(afterTimeout.phase.state).toBe("pending");
  });

  it("超时只对仍在等待首个结果的请求生效", () => {
    const tracker = beginDevNav(404);
    expect(applyDevNavTimeout(tracker, 999)).toBe(tracker);
    const timedOut = applyDevNavTimeout(tracker, 404);
    expect(timedOut.phase).toMatchObject({ state: "error", timedOut: true });
    expect(timedOut.current).toBeNull();
  });

  it("命令失败：收敛为 failed，后续迟到回执只修正展示", () => {
    const tracker = beginDevNav(501);
    const failed = applyDevNavFailure(tracker, 501, "主窗口不可用");
    expect(failed.phase).toMatchObject({
      state: "error",
      timedOut: false,
      error: "主窗口不可用",
    });
    const late = applyDevNavAck(failed, ack(501, "succeeded"));
    expect(late.kind).toBe("late");
    if (late.kind !== "late") return;
    expect(late.tracker.phase).toMatchObject({ state: "success", late: true });
  });

  it("已收敛出终态后，迟到的 pending 不能把结果退回等待", () => {
    const done = applyDevNavAck(beginDevNav(502), ack(502, "succeeded"));
    if (done.kind !== "updated") throw new Error("未识别");
    const late = applyDevNavAck(done.tracker, ack(502, "pending"));
    expect(late.kind).toBe("ignored");
    expect(done.tracker.phase.state).toBe("success");
  });

  it("单飞：requesting 中不能再发起，pending/终态可以", () => {
    expect(canStartDevNav(INITIAL_DEV_NAV)).toBe(true);
    const requesting = beginDevNav(601);
    expect(canStartDevNav(requesting)).toBe(false);
    const pending = applyDevNavAck(requesting, ack(601, "pending"));
    if (pending.kind !== "updated") throw new Error("未识别");
    expect(canStartDevNav(pending.tracker)).toBe(true);
  });

  it("兼容旧后端：没有 status 时按 ok/pending 推导", () => {
    expect(resolveAckStatus({ ok: true, pending: false })).toBe("succeeded");
    expect(resolveAckStatus({ ok: false, pending: true })).toBe("pending");
    expect(resolveAckStatus({ ok: false, pending: false })).toBe("failed");
    expect(resolveAckStatus({ ok: false, pending: true, status: "cancelled" })).toBe("cancelled");
  });
});
