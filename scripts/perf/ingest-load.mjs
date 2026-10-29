#!/usr/bin/env node
//! Task Dock HTTP 接入压测客户端（真机 Windows：对运行中的 Task Dock 主程序发事件）。
//!
//! 用法（在仓库根目录）：
//!   node scripts/perf/ingest-load.mjs --base http://127.0.0.1:47821 --token <HTTP 令牌> \
//!     --agents 10 --rate 50 --duration 600 --out docs/performance/results/http-A.json
//!
//! 场景参数：
//!   A 持续：--agents 10 --rate 50 --duration 600   （10 Agent × 50 事件/秒 × 10 分钟）
//!   B 突发：--agents 4  --rate 50 --duration 60    （200 事件/秒 × 60 秒）
//!   C 过载：--agents 8  --rate 100 --duration 20 --batch 1（配合服务端小队列/慢盘观察 429/503）
//!
//! 说明：
//! - running 事件走快速入队（HTTP 200 + queued），waiting/completed/failed 等待落库确认；
//! - 429/503 与网络错误按 Retry-After / 指数退避重试，绝不把失败当成功；
//! - 关键事件最终失败会写入结果 JSON 的 critical_failed_ids（用于与数据库对账）；
//! - 不伪造数据：所有数字来自本次真实 HTTP 往返。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const RUN_LEN = 20;

function parseArgs(argv) {
  const out = {
    base: "http://127.0.0.1:47821",
    token: "",
    agents: 4,
    rate: 50,
    duration: 60,
    batch: 1,
    timeoutMs: 15000,
    maxRetries: 40,
    out: "",
    source: "bridge",
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
      case "--agents": out.agents = Number(next()); break;
      case "--rate": out.rate = Number(next()); break;
      case "--duration": out.duration = Number(next()); break;
      case "--batch": out.batch = Number(next()); break;
      case "--timeout-ms": out.timeoutMs = Number(next()); break;
      case "--max-retries": out.maxRetries = Number(next()); break;
      case "--out": out.out = next(); break;
      case "--source": out.source = next(); break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${key}`);
    }
  }
  if (!out.token) throw new Error("必须提供 --token（Task Dock 设置中的 HTTP 接入令牌）");
  if (!(out.agents > 0) || !(out.rate > 0) || !(out.duration > 0)) {
    throw new Error("--agents / --rate / --duration 必须为正数");
  }
  return out;
}

function printHelp() {
  console.log(`Task Dock HTTP 压测客户端
  --base <url>        服务端地址（默认 http://127.0.0.1:47821）
  --token <token>     必需：HTTP 接入 Bearer 令牌
  --agents <n>        Agent 数量（默认 4）
  --rate <n>          每 Agent 每秒事件数（默认 50）
  --duration <secs>   持续秒数（默认 60）
  --batch <n>         每个请求批量事件数（默认 1；批量请求等待事务提交）
  --timeout-ms <n>    单请求超时（默认 15000）
  --max-retries <n>   429/503/网络错误最大重试次数（默认 40）
  --out <path>        结果 JSON 输出路径（默认 docs/performance/results/）`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

function latencySummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
  };
}

function buildEvent(cfg, agent, index) {
  const state =
    index % RUN_LEN === RUN_LEN - 1
      ? "completed"
      : index % RUN_LEN === RUN_LEN / 2
        ? "waiting"
        : "running";
  return {
    schema_version: 1,
    event_id: `http-a${agent}-e${index}`,
    source_id: cfg.source,
    instance_id: `http-instance-${agent}`,
    session_id: `http-perf-session-${agent}`,
    run_id: `http-perf-run-${agent}-${Math.floor(index / RUN_LEN)}`,
    task_title: `HTTP 压测 ${agent}-${index}`,
    state,
    message: `http perf ${agent} #${index}`,
    occurred_at: new Date().toISOString(),
    evidence_type: "observed",
    confidence: 1,
  };
}

async function postJson(cfg, payload) {
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
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body, ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function createStats() {
  return {
    sent: 0,
    running_sent: 0,
    critical_sent: 0,
    ok: 0,
    merged: 0,
    sampled: 0,
    rejected_429: 0,
    rejected_503: 0,
    validation_errors: 0,
    network_errors: 0,
    retries: 0,
    critical_ok: 0,
    critical_failed_ids: [],
    latencies_all: [],
    latencies_critical: [],
  };
}

async function sendWithRetry(cfg, stats, events, { critical, id }) {
  stats.sent += events.length;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await postJson(cfg, events.length === 1 ? events[0] : events);
    } catch (e) {
      stats.network_errors += 1;
      if (attempt >= cfg.maxRetries) {
        if (critical) stats.critical_failed_ids.push({ id, error: String(e) });
        return false;
      }
      stats.retries += 1;
      await sleep(Math.min(2000, 100 * 2 ** Math.min(attempt, 4)));
      continue;
    }
    stats.latencies_all.push(res.ms);
    if (critical) stats.latencies_critical.push(res.ms);

    if (res.status === 200) {
      stats.ok += events.length;
      if (res.body?.merged) stats.merged += Number(res.body.merged) || 0;
      if (res.body?.sampled) stats.sampled += Number(res.body.sampled) || 0;
      if (critical) stats.critical_ok += events.length;
      return true;
    }
    if (res.status === 429 || res.status === 503) {
      if (res.status === 429) stats.rejected_429 += 1;
      else stats.rejected_503 += 1;
      if (attempt >= cfg.maxRetries) {
        if (critical) stats.critical_failed_ids.push({ id, status: res.status, body: res.body });
        return false;
      }
      stats.retries += 1;
      const hinted = Number(res.retryAfter) * 1000;
      const backoff = Number.isFinite(hinted) && hinted > 0 ? hinted : Math.min(2000, 100 * 2 ** Math.min(attempt, 4));
      await sleep(backoff);
      continue;
    }
    // 400/401/422 等属于客户端/配置错误：不重试，如实记录
    stats.validation_errors += 1;
    if (critical) stats.critical_failed_ids.push({ id, status: res.status, body: res.body });
    return false;
  }
}

async function healthCheck(cfg) {
  try {
    const res = await fetch(`${cfg.base}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body;
  } catch (e) {
    throw new Error(
      `无法连接 Task Dock（${cfg.base}）：${String(e)}\n` +
        `请先启动应用，并在「设置 → HTTP 接入」确认端口与令牌。`,
    );
  }
}

async function main() {
  const cfg = parseArgs(process.argv);
  const health = await healthCheck(cfg);
  console.log(`[health] ${JSON.stringify(health)}`);
  console.log(
    `[load] ${cfg.agents} agents × ${cfg.rate} ev/s × ${cfg.duration}s = 约 ${cfg.agents * cfg.rate * cfg.duration} 事件，batch=${cfg.batch}`,
  );

  const stats = createStats();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const stopAt = t0 + cfg.duration * 1000;
  const criticalTasks = [];
  let criticalSeq = 0;

  const agentLoop = async (agent) => {
    const period = 1000 / cfg.rate;
    let next = performance.now();
    let index = 0;
    let batch = [];
    while (performance.now() < stopAt) {
      const now = performance.now();
      if (now < next) {
        await sleep(Math.min(next - now, 50));
        continue;
      }
      next += period;
      const event = buildEvent(cfg, agent, index);
      index += 1;
      if (event.state === "running") {
        stats.running_sent += 1;
        if (cfg.batch > 1) {
          batch.push(event);
          if (batch.length >= cfg.batch) {
            const payload = batch;
            batch = [];
            const id = payload.map((e) => e.event_id).join(",");
            // 批量请求由服务端等待事务提交，单独放行避免拖住发流
            criticalTasks.push(sendWithRetry(cfg, stats, payload, { critical: false, id }));
          }
        } else {
          await sendWithRetry(cfg, stats, [event], { critical: false, id: event.event_id });
        }
      } else {
        stats.critical_sent += 1;
        const id = event.event_id;
        criticalSeq += 1;
        const p = sendWithRetry(cfg, stats, [event], { critical: true, id });
        if (criticalSeq % 32 === 0) await p;
        else criticalTasks.push(p);
      }
    }
    if (batch.length > 0) {
      criticalTasks.push(sendWithRetry(cfg, stats, batch, { critical: false, id: "tail" }));
    }
  };

  await Promise.all(Array.from({ length: cfg.agents }, (_, a) => agentLoop(a)));
  await Promise.all(criticalTasks);
  const elapsedMs = performance.now() - t0;

  // 排空窗口：再等 5 秒，让服务端合并缓冲落库（统计不重复提交）
  await sleep(5000);

  const report = {
    scenario: "http-load",
    started_at: startedAt,
    machine: { platform: process.platform, arch: process.arch, node: process.version },
    config: { ...cfg, token: "<redacted>" },
    health,
    elapsed_ms: Math.round(elapsedMs),
    actual_rate: Math.round((stats.sent / (elapsedMs / 1000)) * 100) / 100,
    counts: {
      sent: stats.sent,
      running_sent: stats.running_sent,
      critical_sent: stats.critical_sent,
      ok: stats.ok,
      merged: stats.merged,
      sampled: stats.sampled,
      rejected_429: stats.rejected_429,
      rejected_503: stats.rejected_503,
      validation_errors: stats.validation_errors,
      network_errors: stats.network_errors,
      retries: stats.retries,
      critical_ok: stats.critical_ok,
      critical_failed: stats.critical_failed_ids.length,
      critical_failed_ids: stats.critical_failed_ids.slice(0, 20),
    },
    latency_all: latencySummary(stats.latencies_all),
    latency_critical: latencySummary(stats.latencies_critical),
  };

  const out =
    cfg.out ||
    resolve(
      "docs/performance/results",
      `http-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`[结果] ${out}`);

  const pass =
    stats.critical_failed_ids.length === 0 &&
    stats.validation_errors === 0 &&
    stats.ok > 0;
  console.log(pass ? "[判定] PASS（客户端视角）" : "[判定] FAIL（存在关键事件最终失败或协议错误）");
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exitCode = 2;
});
