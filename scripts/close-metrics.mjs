#!/usr/bin/env node
/**
 * 工作台关闭链路指标：把终端日志 / 诊断 jsonl 汇总成「可验收」的数字。
 *
 * 用法：
 *   node scripts/close-metrics.mjs <file...>            # 文本或 jsonl 均可，自动识别
 *   node scripts/close-metrics.mjs <file> --json        # 机器可读
 *   node scripts/close-metrics.mjs <file> --orphan-ms=20000
 *   cat app.log | node scripts/close-metrics.mjs -      # 从标准输入读
 *
 * 为什么需要它（2026-11-19 关闭专项，第五阶段验收）：
 * - 现场故障的表征是「连续 CLOSE_REQUESTED，没有任何后续解释」，人工数日志不可靠；
 * - 「正文 flush 耗时与成功率」必须是统计值，不是印象值；
 * - 关闭链路跨前端（CLOSE_GUARD_* / MANUSCRIPT_*）与 Rust（CLOSE_REQUESTED /
 *   CLOSE_GEOMETRY_* / WINDOW_DESTROYED）两侧，必须按 attempt 串起来看。
 *
 * 输入两种形态都支持：
 * 1. tracing 终端输出：`2026-11-19T12:00:00.123Z  INFO ...: CLOSE_REQUESTED label="workspace"`
 * 2. 诊断中心 jsonl：`{"timestamp":"...","event":"manuscript-save-completed","duration_ms":12,...}`
 * 阶段名在两种形态下都会归一化成大写下划线形式。
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 与 Rust `CLOSE_TRACE_STAGES` 对齐；新增阶段时两处一起改。 */
const KNOWN_STAGES = new Set([
  "CLOSE_REQUESTED",
  "CLOSE_GEOMETRY_SNAPSHOT_STARTED",
  "CLOSE_GEOMETRY_SNAPSHOT_COMPLETED",
  "CLOSE_GEOMETRY_PERSIST_STARTED",
  "CLOSE_GEOMETRY_PERSIST_COMPLETED",
  "CLOSE_GEOMETRY_PERSIST_FAILED",
  "CLOSE_GEOMETRY_PERSIST_SKIPPED",
  "CLOSE_GEOMETRY_PERSIST_DEFERRED",
  "CLOSE_GEOMETRY_EXIT_FLUSH",
  "WINDOW_DESTROYED",
  "CLOSE_GUARD_INSTALLED",
  "CLOSE_GUARD_REQUESTED",
  "CLOSE_GUARD_NO_FLUSH",
  "CLOSE_GUARD_PREVENTED",
  "CLOSE_GUARD_FLUSH_STARTED",
  "CLOSE_GUARD_FLUSH_COMPLETED",
  "CLOSE_GUARD_FLUSH_FAILED",
  "CLOSE_GUARD_FLUSH_TIMEOUT",
  "CLOSE_GUARD_RETRY_CLOSE_STARTED",
  "CLOSE_GUARD_RETRY_CLOSE_ACCEPTED",
  "CLOSE_GUARD_RETRY_CLOSE_FAILED",
  "CLOSE_GUARD_ALLOWED",
  "CLOSE_GUARD_DUPLICATE",
  "CLOSE_GUARD_DESTROY_TIMEOUT",
  "CLOSE_GUARD_DISPOSED",
  "MANUSCRIPT_FLUSH_STARTED",
  "MANUSCRIPT_FLUSH_SKIPPED_CLEAN",
  "MANUSCRIPT_FLUSH_WAIT_EXISTING_SAVE",
  "MANUSCRIPT_SAVE_STARTED",
  "MANUSCRIPT_SAVE_COMPLETED",
  "MANUSCRIPT_SAVE_FAILED",
  "MANUSCRIPT_FLUSH_COMPLETED",
]);

const FAILURE_STAGES = {
  CLOSE_GUARD_FLUSH_TIMEOUT: "flush-timeout",
  CLOSE_GUARD_FLUSH_FAILED: "flush-failed",
  CLOSE_GUARD_RETRY_CLOSE_FAILED: "close-rejected",
  CLOSE_GUARD_DESTROY_TIMEOUT: "not-destroyed",
};

const FAILURE_REASONS = new Set(Object.values(FAILURE_STAGES));

const ISO_TS = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const STAGE_TOKEN = /\b(CLOSE_(?:GUARD|GEOMETRY)_[A-Z_]+|CLOSE_REQUESTED|WINDOW_DESTROYED|MANUSCRIPT_[A-Z_]+)\b/;
const KEY_VALUE = /([A-Za-z_][\w]*)=("([^"]*)"|\S+)/g;

function normalizeStage(raw) {
  if (!raw) return null;
  const upper = String(raw).toUpperCase().replace(/-/g, "_");
  return KNOWN_STAGES.has(upper) ? upper : null;
}

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 文本行：取时间戳 + 阶段 + `k=v` 字段。 */
function parseTextLine(line) {
  const token = STAGE_TOKEN.exec(line);
  if (!token) return null;
  const fields = {};
  KEY_VALUE.lastIndex = 0;
  let match;
  while ((match = KEY_VALUE.exec(line)) !== null) {
    fields[match[1]] = match[3] !== undefined ? match[3] : match[2];
  }
  const tsMatch = ISO_TS.exec(line.trim());
  return {
    stage: token[1],
    ts: tsMatch ? parseTime(tsMatch[1]) : null,
    attemptId: fields.attempt ?? null,
    durationMs: fields.duration_ms !== undefined ? Number(fields.duration_ms) : null,
    result: fields.result ?? null,
    raw: line.trim(),
  };
}

/** 诊断 jsonl：event 名归一化，metadata 里的键摊平。 */
function parseJsonLine(line) {
  if (!line.trim().startsWith("{")) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const stage = normalizeStage(obj.event ?? obj.stage ?? obj.action);
  if (!stage) return null;
  const meta = obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {};
  return {
    stage,
    ts: parseTime(obj.timestamp),
    attemptId: meta.attemptId ?? obj.operation_id ?? null,
    durationMs:
      typeof obj.duration_ms === "number"
        ? obj.duration_ms
        : typeof meta.durationMs === "number"
          ? meta.durationMs
          : null,
    result: meta.result ?? obj.status ?? null,
    raw: line.trim(),
  };
}

function parseEvent(line) {
  return parseJsonLine(line) ?? parseTextLine(line);
}

function readInputs(args) {
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0 || files.includes("-")) {
    return [{ name: "<stdin>", text: readFileSync(0, "utf8") }];
  }
  return files.map((file) => ({ name: file, text: readFileSync(file, "utf8") }));
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function summarize(numbers) {
  const values = numbers.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (values.length === 0) return { n: 0, p50: null, p95: null, max: null, avg: null };
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values[values.length - 1],
    avg: Math.round(sum / values.length),
  };
}

/**
 * 按 attempt 分组。
 *
 * 只有工作台守卫的 `CLOSE_GUARD_*` 自带 attemptId；Rust 侧与正文侧没有。
 * 规则：
 * - 上一条事务**已终结**（销毁或带原因失败）时，新的请求才开启新事务；
 *   否则一律并入（连续三次 CLOSE_REQUESTED 在旧实现里属于同一笔卡死事务，
 *   不能被数成三次「尝试」，否则成功率会被稀释）。
 * - 带 attemptId 的事件若找不到同名事务，且当前事务还没 id，就认领它
 *   （`CLOSE_REQUESTED → CLOSE_GUARD_REQUESTED` 正是这样串起来的）。
 * - 与关闭无关的正文自动保存（事务尚未开始时）不挂到任何事务上，只进全局统计。
 */
function groupAttempts(events, orphanMs) {
  const attempts = [];
  let current = null;
  const lastTs = events.reduce((acc, event) => (event.ts && event.ts > acc ? event.ts : acc), 0);

  const isOpen = (attempt) =>
    attempt !== null &&
    !attempt.events.some(
      (event) => event.stage === "WINDOW_DESTROYED" || FAILURE_STAGES[event.stage],
    );

  const newAttempt = (event) => {
    const attempt = {
      id: event.attemptId ?? null,
      events: [],
      firstTs: event.ts,
      lastTs: event.ts,
      requested: false,
    };
    attempts.push(attempt);
    current = attempt;
    return attempt;
  };

  for (const event of events) {
    let attempt = null;
    if (event.attemptId) {
      attempt = attempts.find((item) => item.id === event.attemptId) ?? null;
      if (!attempt && isOpen(current) && current.id === null) {
        current.id = event.attemptId;
        attempt = current;
      }
    } else if (event.stage.startsWith("MANUSCRIPT_") && !(current && current.requested)) {
      // 关闭事务之外的自动保存：不归属任何一次关闭。
      continue;
    }
    if (!attempt && event.stage === "WINDOW_DESTROYED") {
      // 销毁日志来自 Rust，没有 attemptId：优先挂到「已受理关闭」的开启事务上，
      // 否则前一条陈旧事件可能把 current 带偏，销毁就归不到正确的事务。
      attempt =
        [...attempts]
          .reverse()
          .find(
            (item) =>
              isOpen(item) &&
              item.events.some(
                (known) =>
                  known.stage === "CLOSE_GUARD_RETRY_CLOSE_ACCEPTED" ||
                  known.stage === "CLOSE_GUARD_ALLOWED",
              ),
          ) ?? null;
    }
    if (!attempt) {
      attempt = isOpen(current) ? current : newAttempt(event);
    }
    attempt.events.push(event);
    attempt.lastStage = event.stage;
    attempt.lastTs = event.ts ?? attempt.lastTs;
    attempt.firstTs = attempt.firstTs ?? event.ts;
    if (event.stage === "CLOSE_REQUESTED") {
      attempt.requested = true;
      attempt.requests = (attempt.requests ?? 0) + 1;
    } else if (event.stage === "CLOSE_GUARD_REQUESTED") {
      // 同一次请求的守卫侧记录：标记事务，不重复计数。
      attempt.requested = true;
    }
    // 归到已终结的旧事务时不要把游标拉回去，否则后续事件会跟着错位。
    if (attempt === current || isOpen(attempt)) current = attempt;
  }

  for (const attempt of attempts) {
    const stages = attempt.events.map((event) => event.stage);
    const destroyed = stages.includes("WINDOW_DESTROYED");
    const failureStage = stages.find((stage) => FAILURE_STAGES[stage]);
    const accepted = stages.includes("CLOSE_GUARD_RETRY_CLOSE_ACCEPTED");
    let outcome;
    if (destroyed) outcome = "destroyed";
    else if (failureStage) outcome = FAILURE_STAGES[failureStage];
    else if (accepted) outcome = "accepted-not-destroyed";
    else if (!attempt.requested) outcome = "passive";
    else outcome = "unexplained";

    attempt.outcome = outcome;
    // 最后一条记录离文件末尾不足 orphanMs 时，可能只是还在进行，不算故障；
    // 但已经出现多次请求仍无任何一方解释，就是旧故障签名（用户点了没反应），
    // 不能再用「可能还在进行」放过。
    attempt.stillRunning =
      outcome === "unexplained" &&
      (attempt.requests ?? 0) <= 1 &&
      lastTs !== 0 &&
      attempt.lastTs !== null
        ? lastTs - attempt.lastTs < orphanMs
        : false;
    attempt.durationMs =
      attempt.firstTs !== null && attempt.lastTs !== null ? attempt.lastTs - attempt.firstTs : null;
  }
  return attempts.filter((attempt) => attempt.requested || attempt.events.length > 1);
}

/** 「只有 CLOSE_REQUESTED、没有任何后续解释」的直接判定。 */
function findBareRequests(events) {
  const bare = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].stage !== "CLOSE_REQUESTED") continue;
    let explained = false;
    for (let j = i + 1; j < events.length; j += 1) {
      const stage = events[j].stage;
      if (stage === "CLOSE_REQUESTED") continue;
      // 下一条同样是请求说明这一条没被任何一方记录：仍属未解释。
      explained = true;
      break;
    }
    if (!explained) bare.push(events[i].raw);
  }
  return bare;
}

export function analyze(texts, options = {}) {
  const orphanMs = options.orphanMs ?? 20_000;
  const events = [];
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = parseEvent(line);
      if (event) events.push(event);
    }
  }
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const attempts = groupAttempts(events, orphanMs);
  const byStage = new Map();
  for (const event of events) {
    if (!byStage.has(event.stage)) byStage.set(event.stage, []);
    byStage.get(event.stage).push(event);
  }

  const durationsOf = (stage) =>
    (byStage.get(stage) ?? [])
      .map((event) => event.durationMs)
      .filter((value) => typeof value === "number" && Number.isFinite(value));

  const requested = attempts.filter((attempt) => attempt.requested);
  const destroyed = requested.filter((attempt) => attempt.outcome === "destroyed");
  const failed = requested.filter((attempt) => FAILURE_REASONS.has(attempt.outcome));
  const unexplained = requested.filter(
    (attempt) => attempt.outcome === "unexplained" && !attempt.stillRunning,
  );
  const running = requested.filter((attempt) => attempt.stillRunning);

  const saveCompleted = durationsOf("MANUSCRIPT_SAVE_COMPLETED");
  const saveFailed = durationsOf("MANUSCRIPT_SAVE_FAILED");
  const saveTotal = saveCompleted.length + saveFailed.length;

  return {
    events: events.length,
    attempts: {
      total: requested.length,
      requests: requested.reduce((acc, attempt) => acc + (attempt.requests ?? 0), 0),
      destroyed: destroyed.length,
      failed: failed.length,
      unexplained: unexplained.length,
      stillRunning: running.length,
      successRate: requested.length === 0 ? null : destroyed.length / requested.length,
      details: requested.map((attempt) => ({
        id: attempt.id,
        outcome: attempt.outcome,
        stages: attempt.events.map((event) => event.stage),
        durationMs: attempt.durationMs,
      })),
    },
    latency: {
      flush: summarize(durationsOf("CLOSE_GUARD_FLUSH_COMPLETED").concat(durationsOf("CLOSE_GUARD_FLUSH_TIMEOUT"))),
      save: summarize(saveCompleted.concat(saveFailed)),
      savePending: summarize(saveCompleted),
      geometrySnapshot: summarize(durationsOf("CLOSE_GEOMETRY_SNAPSHOT_COMPLETED")),
      geometryPersist: summarize(durationsOf("CLOSE_GEOMETRY_PERSIST_COMPLETED")),
      retryClose: summarize(durationsOf("CLOSE_GUARD_RETRY_CLOSE_ACCEPTED")),
    },
    manuscript: {
      saveTotal,
      saveOk: saveCompleted.length,
      saveFailed: saveFailed.length,
      successRate: saveTotal === 0 ? null : saveCompleted.length / saveTotal,
    },
    counter: {
      flushStarted: (byStage.get("CLOSE_GUARD_FLUSH_STARTED") ?? []).length,
      flushTimeout: (byStage.get("CLOSE_GUARD_FLUSH_TIMEOUT") ?? []).length,
      duplicate: (byStage.get("CLOSE_GUARD_DUPLICATE") ?? []).length,
      prevented: (byStage.get("CLOSE_GUARD_PREVENTED") ?? []).length,
      noFlush: (byStage.get("CLOSE_GUARD_NO_FLUSH") ?? []).length,
      destroyTimeout: (byStage.get("CLOSE_GUARD_DESTROY_TIMEOUT") ?? []).length,
      geometryDeferred: (byStage.get("CLOSE_GEOMETRY_PERSIST_DEFERRED") ?? []).length,
    },
    bareRequests: findBareRequests(events),
  };
}

function ms(value) {
  return value === null || value === undefined ? "-" : `${value}ms`;
}

function line(label, stat) {
  if (stat.n === 0) return `  ${label.padEnd(30)} 无样本`;
  return `  ${label.padEnd(30)} n=${String(stat.n).padEnd(4)} p50=${ms(stat.p50).padEnd(8)} p95=${ms(stat.p95).padEnd(8)} max=${ms(stat.max)}`;
}

export function formatReport(report, sources = []) {
  const out = [];
  out.push("工作台关闭链路指标");
  if (sources.length > 0) out.push(`来源: ${sources.join(", ")}`);
  out.push(`事件总数: ${report.events}`);
  out.push("");
  const a = report.attempts;
  out.push("关闭尝试");
  out.push(
    `  关闭请求 ${a.requests} 次 / 事务 ${a.total} 笔 / 已销毁 ${a.destroyed} / 显式失败 ${a.failed} / 未解释 ${a.unexplained} / 疑似进行中 ${a.stillRunning}`,
  );
  out.push(
    `  关闭成功率: ${a.successRate === null ? "无样本" : `${(a.successRate * 100).toFixed(1)}%`}`,
  );
  out.push("");
  out.push("耗时");
  out.push(line("flush 总耗时（守卫侧）", report.latency.flush));
  out.push(line("正文保存（含失败）", report.latency.save));
  out.push(line("正文保存（仅成功）", report.latency.savePending));
  out.push(line("几何快照（主线程）", report.latency.geometrySnapshot));
  out.push(line("几何持久化（后台）", report.latency.geometryPersist));
  out.push(line("close() 受理耗时", report.latency.retryClose));
  out.push("");
  out.push("正文保存");
  out.push(
    `  成功 ${report.manuscript.saveOk} / 失败 ${report.manuscript.saveFailed} / 成功率 ${
      report.manuscript.successRate === null
        ? "无样本"
        : `${(report.manuscript.successRate * 100).toFixed(1)}%`
    }`,
  );
  out.push("");
  out.push("计数");
  out.push(
    `  flush 开始 ${report.counter.flushStarted} / 超时 ${report.counter.flushTimeout} / 重复请求 ${report.counter.duplicate} / 已拦截 ${report.counter.prevented} / 无守卫放行 ${report.counter.noFlush}`,
  );
  out.push(
    `  销毁兜底超时 ${report.counter.destroyTimeout} / 几何延迟持久化 ${report.counter.geometryDeferred}`,
  );
  out.push("");
  if (a.details.length > 0) {
    out.push("逐次链路");
    for (const detail of a.details) {
      out.push(`  ${detail.id ?? "(无 id)"} → ${detail.outcome}  ${detail.stages.join(" → ")}`);
    }
    out.push("");
  }
  out.push("结论");
  if (report.events === 0) {
    out.push("  ✗ 没有解析到任何关闭链路事件：确认日志级别为 info，且输入文件是应用终端输出或诊断 jsonl。");
  } else if (report.bareRequests.length > 0) {
    out.push(`  ✗ 发现 ${report.bareRequests.length} 条「只有 CLOSE_REQUESTED、无任何后续解释」的记录（P0 回归）：`);
    for (const raw of report.bareRequests.slice(0, 5)) out.push(`    ${raw}`);
  } else if (a.unexplained > 0) {
    out.push(`  ✗ 有 ${a.unexplained} 次尝试停在中间态（既未销毁也没有失败原因）。`);
  } else if (a.destroyed > 0) {
    out.push("  ✓ 每次关闭请求都有明确结局（已销毁或带原因失败），未发现无解释终止。");
  } else {
    out.push("  · 未观察到成功的关闭（可能尚未在真机执行验收场景）。");
  }
  return out.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const orphanArg = args.find((arg) => arg.startsWith("--orphan-ms="));
  const orphanMs = orphanArg ? Number(orphanArg.split("=")[1]) : undefined;
  const asJson = args.includes("--json");

  const inputs = readInputs(args);
  const report = analyze(
    inputs.map((input) => input.text),
    { orphanMs },
  );
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const bad = report.bareRequests.length > 0 || report.attempts.unexplained > 0;
    process.exitCode = bad ? 1 : 0;
    return;
  }
  process.stdout.write(`${formatReport(report, inputs.map((input) => input.name))}\n`);
  process.exitCode = report.bareRequests.length > 0 || report.attempts.unexplained > 0 ? 1 : 0;
}

if (isMainModule()) {
  main();
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
