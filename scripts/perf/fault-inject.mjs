#!/usr/bin/env node
//! Task Dock 真机故障注入客户端（P1-05 E 组）：重复重试 / 提交后超时 / 瞬时过载 / 关键状态乱序。
//!
//! 用法：
//!   node scripts/perf/fault-inject.mjs --mode duplicate --token <tok> --out docs/performance/results/E-dup.json
//!   node scripts/perf/fault-inject.mjs --mode timeout   --token <tok> --count 200 --timeout-ms 5 --out ...
//!   node scripts/perf/fault-inject.mjs --mode burst     --token <tok> --count 3000 --out ...
//!   node scripts/perf/fault-inject.mjs --mode interleave --token <tok> --out ...
//!
//! 只报告真实 HTTP 往返；需要与数据库核对的 ID 全部写入结果 JSON。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    base: "http://127.0.0.1:47821",
    token: "",
    mode: "duplicate",
    count: 200,
    timeoutMs: 15000,
    maxRetries: 40,
    out: "",
    runId: `f${Date.now().toString(36)}`,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数缺少值: ${key}`);
      return v;
    };
    switch (key) {
      case "--base": out.base = next().replace(/\/+$/, ""); break;
      case "--token": out.token = next(); break;
      case "--mode": out.mode = next(); break;
      case "--count": out.count = Number(next()); break;
      case "--timeout-ms": out.timeoutMs = Number(next()); break;
      case "--max-retries": out.maxRetries = Number(next()); break;
      case "--out": out.out = next(); break;
      case "--run-id": out.runId = next(); break;
      default: throw new Error(`未知参数: ${key}`);
    }
  }
  if (!out.token) throw new Error("必须提供 --token");
  return out;
}

function event(cfg, name, state, { session = `${cfg.runId}-session`, run = `${cfg.runId}-run`, occurredAt, message } = {}) {
  return {
    schema_version: 1,
    event_id: `${cfg.runId}-${name}`,
    source_id: "bridge",
    instance_id: "fault-inject",
    session_id: session,
    run_id: run,
    task_title: `故障注入 ${cfg.runId}`,
    state,
    message: message || `fault ${name}`,
    occurred_at: occurredAt || new Date().toISOString(),
    evidence_type: "observed",
    confidence: 1,
  };
}

async function post(cfg, payload, timeoutMs = cfg.timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(`${cfg.base}/api/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
    return { ok: true, status: res.status, body, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, error: String(e), ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

async function modeDuplicate(cfg) {
  const first = event(cfg, "dup-waiting", "waiting");
  const a = await post(cfg, first);
  const b = await post(cfg, first);
  const batch = [];
  for (let i = 0; i < 20; i++) {
    const ev = event(cfg, `dup-completed-${i}`, "completed");
    batch.push(ev);
    const [x, y] = await Promise.all([post(cfg, ev), post(cfg, ev)]);
    batch[i] = { id: ev.event_id, first: x.status ?? x.error, second: y.status ?? y.error, bodies: [x.body, y.body] };
  }
  await sleep(4000);
  return {
    mode: "duplicate",
    run_id: cfg.runId,
    single: { id: first.event_id, statuses: [a.status ?? a.error, b.status ?? b.error], bodies: [a.body, b.body] },
    concurrent_pairs: batch,
    unique_event_ids: [first.event_id, ...batch.map((x) => x.id)],
  };
}

async function modeTimeout(cfg) {
  const aborted = [];
  const ok = [];
  for (let i = 0; i < cfg.count; i++) {
    const ev = event(cfg, `to-running-${i}`, "running");
    const r = await post(cfg, ev, cfg.timeoutMs);
    if (r.ok && r.status === 200) ok.push(ev.event_id);
    else aborted.push({ id: ev.event_id, error: r.error || `HTTP ${r.status}` });
    await sleep(5);
  }
  // 标记事件：确认服务端仍正常处理关键状态
  const markers = [];
  for (let i = 0; i < 10; i++) {
    const ev = event(cfg, `to-marker-${i}`, "completed");
    const r = await post(cfg, ev);
    markers.push({ id: ev.event_id, status: r.status ?? r.error });
    await sleep(50);
  }
  await sleep(6000);
  return {
    mode: "timeout",
    run_id: cfg.runId,
    timeout_ms: cfg.timeoutMs,
    attempted: cfg.count,
    ok_ids: ok,
    aborted_ids: aborted,
    markers,
    marker_ids: markers.map((m) => m.id),
  };
}

async function modeBurst(cfg) {
  const running = [];
  const critical = [];
  for (let i = 0; i < cfg.count; i++) {
    running.push(event(cfg, `burst-running-${i}`, "running"));
    if (i % 10 === 9) critical.push(event(cfg, `burst-waiting-${i}`, i % 20 === 19 ? "completed" : "waiting"));
  }
  const statuses = {};
  let okCount = 0;
  let errCount = 0;
  let retryCount = 0;
  const criticalOk = [];
  const criticalFailed = [];
  const t0 = performance.now();
  const queue = [...running, ...critical];
  const worker = async () => {
    while (queue.length) {
      const ev = queue.shift();
      let r = await post(cfg, ev, 10000);
      let attempts = 0;
      // 429/503 是显式背压：按 Retry-After（缺省指数退避）重试，不能把拒绝当成功。
      while ((!r.ok || r.status === 429 || r.status === 503) && attempts < cfg.maxRetries) {
        attempts += 1;
        const hinted = Number(r.retryAfter) * 1000;
        const backoff = Number.isFinite(hinted) && hinted > 0
          ? hinted
          : Math.min(2000, 100 * 2 ** Math.min(attempts, 4));
        await sleep(backoff);
        r = await post(cfg, ev, 10000);
      }
      retryCount += attempts;
      const key = r.ok ? String(r.status) : "network-error";
      statuses[key] = (statuses[key] || 0) + 1;
      const isCritical = ev.state !== "running";
      if (r.ok && r.status === 200) {
        okCount += 1;
        if (isCritical) criticalOk.push(ev.event_id);
      } else {
        errCount += 1;
        if (isCritical) criticalFailed.push({ id: ev.event_id, status: r.status, error: r.error });
      }
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  const elapsedMs = Math.round(performance.now() - t0);
  await sleep(10000);
  return {
    mode: "burst",
    run_id: cfg.runId,
    submitted: running.length + critical.length,
    running_submitted: running.length,
    critical_submitted: critical.length,
    elapsed_ms: elapsedMs,
    statuses,
    ok: okCount,
    errors: errCount,
    retries: retryCount,
    critical_ok_ids: criticalOk,
    critical_failed: criticalFailed,
  };
}

async function modeInterleave(cfg) {
  const session = `${cfg.runId}-interleave-session`;
  const run = `${cfg.runId}-interleave-run`;
  const now = Date.now();
  const t = (offsetMs) => new Date(now + offsetMs).toISOString();
  const steps = [
    { name: "i1-running", state: "running", occurredAt: t(0) },
    { name: "i2-waiting", state: "waiting", occurredAt: t(1000) },
    // 延迟到达的旧 running：不得把 waiting 覆盖回 running
    { name: "i3-late-running", state: "running", occurredAt: t(-10000) },
    { name: "i4-completed", state: "completed", occurredAt: t(2000) },
    // 新轮次：completed 之后的新 running 应重新打开
    { name: "i5-new-round-running", state: "running", occurredAt: t(3000) },
    { name: "i6-waiting", state: "waiting", occurredAt: t(4000) },
  ];
  const sent = [];
  for (const s of steps) {
    const ev = event(cfg, s.name, s.state, { session, run, occurredAt: s.occurredAt });
    const r = await post(cfg, ev);
    sent.push({ id: ev.event_id, state: s.state, occurred_at: s.occurredAt, status: r.status ?? r.error, body: r.body });
    await sleep(400);
  }
  await sleep(6000);
  return {
    mode: "interleave",
    run_id: cfg.runId,
    session_id: session,
    run_id_external: run,
    steps: sent,
    expect_final_state: "waiting",
  };
}

async function main() {
  const cfg = parseArgs(process.argv);
  const started_at = new Date().toISOString();
  let result;
  if (cfg.mode === "duplicate") result = await modeDuplicate(cfg);
  else if (cfg.mode === "timeout") result = await modeTimeout(cfg);
  else if (cfg.mode === "burst") result = await modeBurst(cfg);
  else if (cfg.mode === "interleave") result = await modeInterleave(cfg);
  else throw new Error(`未知模式: ${cfg.mode}`);

  const report = { scenario: "fault-inject", started_at, config: { ...cfg, token: "<redacted>" }, result };
  const out = cfg.out || resolve("docs/performance/results", `fault-${cfg.mode}-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`[结果] ${out}`);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exitCode = 2;
});
