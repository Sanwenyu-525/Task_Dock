import test from "node:test";
import assert from "node:assert/strict";

import { analyze, formatReport } from "./close-metrics.mjs";

const T = (second, ms = 0) =>
  `2026-11-19T12:00:${String(second).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`;

const text = (second, ms, stage, fields = "") =>
  `${T(second, ms)}  INFO task_dock_lib::project_workspace_window: ${stage} ${fields}`.trim();

const jsonl = (second, ms, event, extra = {}) =>
  JSON.stringify({
    timestamp: T(second, ms),
    module: "workbench",
    action: "manuscript-save",
    event,
    ...extra,
  });

test("成功关闭：一笔事务、命中销毁、flush 有耗时样本", () => {
  const log = [
    text(0, 100, "CLOSE_REQUESTED", 'label="workspace"'),
    text(0, 105, "CLOSE_GUARD_PREVENTED"),
    text(0, 106, "CLOSE_GUARD_REQUESTED", "attempt=close-1"),
    text(0, 107, "CLOSE_GUARD_FLUSH_STARTED", "attempt=close-1"),
    jsonl(0, 130, "manuscript-flush-started", { duration_ms: 0 }),
    jsonl(0, 168, "manuscript-save-completed", { duration_ms: 38 }),
    text(0, 170, "CLOSE_GUARD_FLUSH_COMPLETED", "attempt=close-1 duration_ms=63"),
    text(0, 171, "CLOSE_GUARD_RETRY_CLOSE_STARTED", "attempt=close-1"),
    text(0, 180, "CLOSE_GUARD_RETRY_CLOSE_ACCEPTED", "attempt=close-1 duration_ms=9"),
    text(0, 181, "CLOSE_GUARD_ALLOWED", "attempt=close-1"),
    text(0, 240, "WINDOW_DESTROYED"),
  ].join("\n");

  const report = analyze([log]);
  assert.equal(report.attempts.total, 1);
  assert.equal(report.attempts.requests, 1);
  assert.equal(report.attempts.destroyed, 1);
  assert.equal(report.attempts.successRate, 1);
  assert.equal(report.bareRequests.length, 0);
  assert.equal(report.latency.flush.n, 1);
  assert.equal(report.latency.flush.p50, 63);
  assert.equal(report.latency.retryClose.p50, 9);
  assert.equal(report.manuscript.saveOk, 1);
  assert.equal(report.manuscript.successRate, 1);
  assert.match(formatReport(report), /✓ 每次关闭请求都有明确结局/);
});

test("旧故障签名：连续 CLOSE_REQUESTED 且无任何后续解释", () => {
  const log = [
    text(1, 0, "CLOSE_REQUESTED", 'label="workspace"'),
    text(1, 500, "CLOSE_REQUESTED", 'label="workspace"'),
    text(1, 1000, "CLOSE_REQUESTED", 'label="workspace"'),
  ].join("\n");

  const report = analyze([log]);
  // 三次请求是同一笔卡住的事务，不能被算成三次独立尝试稀释成功率。
  assert.equal(report.attempts.total, 1);
  assert.equal(report.attempts.requests, 3);
  assert.equal(report.attempts.destroyed, 0);
  assert.equal(report.attempts.unexplained, 1);
  assert.equal(report.bareRequests.length, 3);
  assert.match(formatReport(report), /✗ 发现 3 条/);
});

test("超时后重试：第一笔带原因失败，第二笔成功，成功率按事务计", () => {
  const log = [
    text(2, 0, "CLOSE_REQUESTED"),
    text(2, 5, "CLOSE_GUARD_PREVENTED"),
    text(2, 6, "CLOSE_GUARD_REQUESTED", "attempt=close-1"),
    text(2, 7, "CLOSE_GUARD_FLUSH_STARTED", "attempt=close-1"),
    text(17, 7, "CLOSE_GUARD_FLUSH_TIMEOUT", "attempt=close-1 duration_ms=15000"),
    text(20, 0, "CLOSE_REQUESTED"),
    text(20, 5, "CLOSE_GUARD_PREVENTED", "attempt=close-1"),
    text(20, 6, "CLOSE_GUARD_REQUESTED", "attempt=close-2"),
    text(20, 7, "CLOSE_GUARD_FLUSH_STARTED", "attempt=close-2 detail=reused"),
    text(20, 40, "CLOSE_GUARD_FLUSH_COMPLETED", "attempt=close-2 duration_ms=33"),
    text(20, 41, "CLOSE_GUARD_RETRY_CLOSE_STARTED", "attempt=close-2"),
    text(20, 50, "CLOSE_GUARD_RETRY_CLOSE_ACCEPTED", "attempt=close-2 duration_ms=9"),
    text(20, 120, "WINDOW_DESTROYED"),
  ].join("\n");

  const report = analyze([log]);
  assert.equal(report.attempts.total, 2);
  assert.equal(report.attempts.destroyed, 1);
  assert.equal(report.attempts.failed, 1);
  assert.equal(report.attempts.successRate, 0.5);
  assert.equal(report.attempts.details[0].outcome, "flush-timeout");
  assert.equal(report.attempts.details[1].outcome, "destroyed");
  assert.equal(report.counter.flushTimeout, 1);
});

test("正文保存：成功/失败分别统计，持续时间按样本汇总", () => {
  const log = [
    jsonl(3, 0, "manuscript-save-started", { duration_ms: 0 }),
    jsonl(3, 40, "manuscript-save-completed", { duration_ms: 40 }),
    jsonl(3, 100, "manuscript-save-started", { duration_ms: 0 }),
    jsonl(3, 350, "manuscript-save-failed", { duration_ms: 250 }),
    jsonl(3, 400, "manuscript-save-completed", { duration_ms: 10 }),
  ].join("\n");

  const report = analyze([log]);
  assert.equal(report.manuscript.saveOk, 2);
  assert.equal(report.manuscript.saveFailed, 1);
  assert.equal(report.manuscript.saveTotal, 3);
  assert.equal(report.manuscript.successRate, 2 / 3);
  assert.equal(report.latency.save.max, 250);
  assert.equal(report.latency.save.n, 3);
});

test("末尾未终结的请求算进行中，不误报为无解释", () => {
  const log = [
    text(4, 0, "CLOSE_REQUESTED"),
    text(4, 5, "CLOSE_GUARD_PREVENTED"),
    text(4, 6, "CLOSE_GUARD_REQUESTED", "attempt=close-1"),
    text(4, 7, "CLOSE_GUARD_FLUSH_STARTED", "attempt=close-1"),
  ].join("\n");

  const report = analyze([log], { orphanMs: 20_000 });
  assert.equal(report.attempts.total, 1);
  assert.equal(report.attempts.stillRunning, 1);
  assert.equal(report.attempts.unexplained, 0);
  assert.equal(report.bareRequests.length, 0);
  assert.match(formatReport(report), /未观察到成功的关闭/);
});
