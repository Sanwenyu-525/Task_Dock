#!/usr/bin/env node
//! 内存根因诊断用 HTTP 事件发生器（仅隔离实例使用）。
//!
//! 与 ingest-load.mjs 的区别：可单独控制事件形态，用于区分
//! 「running 事件路径」「关键状态/通知路径」「整体吞吐」对内存的影响。
//!
//! 用法：
//!   node scripts/perf/memory-probe.mjs --base http://127.0.0.1:47841 --token <t> \
//!     --mode mixed --agents 4 --rate 5 --duration 480 --run-id diag1 \
//!     --out docs/performance/results/DIAG-mixed.json
//!
//! mode:
//!   mixed     每 20 个事件：1 个 waiting + 1 个 completed（复现 30 分钟 soak 形态）
//!   running   全部 running（同一 run，不产生 OS 通知）
//!   critical  全部 completed，每条独立 run（放大会话终态与通知路径）
//!   waiting   全部 waiting，每条独立 run（放大等待/通知路径）

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFile, rename } from "node:fs/promises";

const RUN_LEN = 20;

function parseArgs(argv) {
  const out = {
    base: "http://127.0.0.1:47841",
    token: "",
    mode: "mixed",
    agents: 4,
    rate: 5,
    duration: 60,
    batch: 1,
    timeoutMs: 15000,
    maxRetries: 40,
    inflight: 8,
    runId: `mem-${Date.now()}`,
    source: "bench",
    allowRealSource: false,
    transport: "http",
    inbox: "",
    out: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`缺少 ${a} 的值`);
      return v;
    };
    switch (a) {
      case "--base": out.base = next().replace(/\/+$/, ""); break;
      case "--token": out.token = next(); break;
      case "--mode": out.mode = next(); break;
      case "--agents": out.agents = Number(next()); break;
      case "--rate": out.rate = Number(next()); break;
      case "--duration": out.duration = Number(next()); break;
      case "--batch": out.batch = Number(next()); break;
      case "--timeout-ms": out.timeoutMs = Number(next()); break;
      case "--max-retries": out.maxRetries = Number(next()); break;
      case "--inflight": out.inflight = Number(next()); break;
      case "--run-id": out.runId = next(); break;
      case "--source": out.source = next(); break;
      case "--allow-real-source": out.allowRealSource = true; break;
      case "--transport": out.transport = next(); break;
      case "--inbox": out.inbox = next(); break;
      case "--out": out.out = next(); break;
      default: throw new Error(`未知参数: ${a}`);
    }
  }
  if (!out.token) throw new Error("必须提供 --token");
  if (!["mixed", "running", "critical", "waiting"].includes(out.mode)) {
    throw new Error(`未知 mode: ${out.mode}`);
  }
  if (!["http", "file"].includes(out.transport)) {
    throw new Error(`未知 transport: ${out.transport}`);
  }
  if (out.transport === "file" && !out.inbox) {
    throw new Error("file 传输必须提供 --inbox");
  }
  if (out.source !== "bench" && !out.allowRealSource) {
    // 真实来源的事件会被服务端判为 real（进入真实状态与系统通知），
    // 与 ingest-load.mjs 同口径：非隔离来源必须显式确认。
    throw new Error(
      `拒绝向真实来源 "${out.source}" 压测：该来源事件会被视为真实数据。` +
        "请使用默认 --source bench（隔离数据源），或在明确知情时追加 --allow-real-source。",
    );
  }
  return out;
}

const cfg = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildEvent(agent, index) {
  const criticalState = cfg.mode === "critical" ? "completed" : "waiting";
  const state =
    cfg.mode === "running"
      ? "running"
      : cfg.mode === "critical" || cfg.mode === "waiting"
        ? criticalState
        : index % RUN_LEN === RUN_LEN - 1
          ? "completed"
          : index % RUN_LEN === RUN_LEN / 2
            ? "waiting"
            : "running";
  const runSuffix =
    state === "running"
      ? "run-0"
      : cfg.mode === "mixed"
        ? `run-${Math.floor(index / RUN_LEN)}`
        : `run-${index}`;
  return {
    schema_version: 1,
    event_id: `mem-${cfg.runId}-a${agent}-e${index}`,
    source_id: cfg.source,
    instance_id: `mem-instance-${agent}`,
    session_id: `mem-${cfg.runId}-session-${agent}`,
    run_id: `mem-${cfg.runId}-${agent}-${runSuffix}`,
    task_title: `memory probe ${cfg.runId} ${agent}-${index}`,
    state,
    message: `memory probe ${agent} #${index}`,
    occurred_at: new Date().toISOString(),
    evidence_type: "observed",
    confidence: 1,
  };
}

async function postJson(events) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(`${cfg.base}/api/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(events.length === 1 ? events[0] : events),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, body: text, ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// 文件投递通道：直接写入 agent-inbox/，由应用的文件投递扫描器消费。
// 文件名必须以 .json 结尾（投递端只认最终文件），写入用 .tmp + rename 保证原子性。
let fileSeq = 0;
async function deliverByFile(events) {
  const started = performance.now();
  const body = JSON.stringify(events.length === 1 ? events[0] : events);
  const name = `probe-${cfg.runId}-${Date.now()}-${fileSeq++}.json`;
  const tmp = join(cfg.inbox, `${name}.tmp`);
  const dest = join(cfg.inbox, name);
  await writeFile(tmp, body, "utf-8");
  await rename(tmp, dest);
  return { status: 200, body: "file", ms: performance.now() - started };
}

async function deliver(events) {
  if (cfg.transport === "file") return deliverByFile(events);
  return postJson(events);
}

const stats = {
  sent: 0,
  ok: 0,
  failed: 0,
  retries: 0,
  critical_sent: 0,
  critical_ok: 0,
  critical_failed: 0,
  failed_ids: [],
  latencies: [],
};
const pending = new Set();
const stopAt = performance.now() + cfg.duration * 1000;
let stopped = false;

function track(p) {
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => {});
}

async function send(events, critical, id) {
  stats.sent += events.length;
  if (critical) stats.critical_sent += 1;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await deliver(events);
      stats.latencies.push(res.ms);
      if (res.status === 200) {
        stats.ok += events.length;
        if (critical) stats.critical_ok += 1;
        return;
      }
      if ((res.status === 429 || res.status === 503) && attempt < cfg.maxRetries) {
        stats.retries += 1;
        await sleep(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)));
        continue;
      }
      stats.failed += events.length;
      if (critical) {
        stats.critical_failed += 1;
        stats.failed_ids.push({ id, status: res.status, body: String(res.body).slice(0, 160) });
      }
      return;
    } catch (e) {
      if (attempt < cfg.maxRetries) {
        stats.retries += 1;
        await sleep(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)));
        continue;
      }
      stats.failed += events.length;
      if (critical) {
        stats.critical_failed += 1;
        stats.failed_ids.push({ id, error: String(e) });
      }
      return;
    }
  }
}

async function waitSlot() {
  while (pending.size >= cfg.inflight) await Promise.race(pending);
}

async function agentLoop(agent) {
  const period = 1000 / cfg.rate;
  let next = performance.now();
  let index = 0;
  let batch = [];
  while (!stopped && performance.now() < stopAt) {
    const now = performance.now();
    if (now < next) {
      await sleep(Math.min(next - now, 50));
      continue;
    }
    next += period;
    const event = buildEvent(agent, index);
    index += 1;
    if (event.state === "running" && cfg.batch > 1) {
      batch.push(event);
      if (batch.length >= cfg.batch) {
        const payload = batch;
        batch = [];
        await waitSlot();
        track(send(payload, false, "batch"));
      }
    } else {
      await waitSlot();
      track(send([event], event.state !== "running", event.event_id));
    }
  }
  if (batch.length) track(send(batch, false, "tail"));
}

const t0 = performance.now();
process.on("SIGINT", () => {
  stopped = true;
});
await Promise.all(Array.from({ length: cfg.agents }, (_, a) => agentLoop(a)));
await Promise.all(pending);
const elapsed = (performance.now() - t0) / 1000;
const sorted = [...stats.latencies].sort((a, b) => a - b);
const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0);
const result = {
  scenario: "memory-probe",
  mode: cfg.mode,
  config: cfg,
  elapsed_ms: Math.round(elapsed * 1000),
  actual_rate: Math.round((stats.sent / elapsed) * 100) / 100,
  counts: {
    sent: stats.sent,
    ok: stats.ok,
    failed: stats.failed,
    retries: stats.retries,
    critical_sent: stats.critical_sent,
    critical_ok: stats.critical_ok,
    critical_failed: stats.critical_failed,
    failed_ids: stats.failed_ids.slice(0, 20),
  },
  latency_ms: {
    p50: Math.round(pct(0.5) * 100) / 100,
    p95: Math.round(pct(0.95) * 100) / 100,
    max: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
  },
};
if (cfg.out) {
  mkdirSync(dirname(cfg.out), { recursive: true });
  writeFileSync(cfg.out, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
