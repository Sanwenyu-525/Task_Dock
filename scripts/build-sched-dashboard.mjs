#!/usr/bin/env node
// Task Dock 构建调度只读看板。
// 数据源：scripts/sched/queue.mjs、lock.mjs、admission.mjs 的读取函数 + build-sched.mjs config。
// 安全边界：只读状态目录，不取消任务、不写配置、不占构建槽位；仅监听 127.0.0.1。

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStateHome } from "./sched/state.mjs";
import {
  ACTIVE_STATUSES,
  PRIORITY_LABEL,
  compareOrder,
  effectivePriority,
  readQueue,
} from "./sched/queue.mjs";
import { snapshotSlots } from "./sched/lock.mjs";
import { admissionSnapshot } from "./sched/admission.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SCHED = join(SCRIPT_DIR, "build-sched.mjs");
const DEFAULT_PORT = 47901;
const DEFAULT_INTERVAL_MS = 2000;

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, intervalMs: DEFAULT_INTERVAL_MS, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const raw = argv[++i];
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port 需要 1..65535 的整数，收到 ${raw ?? "(空)"}`);
      }
      opts.port = port;
    } else if (arg === "--interval") {
      const raw = argv[++i];
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms < 500) throw new Error(`--interval 需要 >= 500ms，收到 ${raw ?? "(空)"}`);
      opts.intervalMs = Math.round(ms);
    } else if (arg === "--once") {
      opts.once = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Task Dock 构建调度只读看板

  node scripts/build-sched-dashboard.mjs [--port 47901] [--interval 2000] [--once]

  --port       监听端口（仅 127.0.0.1，默认 ${DEFAULT_PORT}）
  --interval   页面刷新间隔毫秒（默认 ${DEFAULT_INTERVAL_MS}）
  --once       只打印一次 JSON 快照，不启动服务（用于自检/脚本）

数据源与安全边界：
  - 只读取 scripts/build-sched.mjs 的 status 同源状态（queue/slots/reservations）；
  - 不写状态目录、不取消任务、不占构建槽位、不修改配置；
  - 页面隐藏时停止请求，服务端按需计算，空闲不轮询。
`);
}

function loadEffectiveConfig() {
  const out = execFileSync(process.execPath, [SCHED, "config", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  const parsed = JSON.parse(out);
  if (!parsed || typeof parsed.effective !== "object" || parsed.effective === null) {
    throw new Error("config --json 没有返回 effective 配置");
  }
  return {
    config: parsed.effective,
    stateHome: parsed.stateHome,
    configProblems: Array.isArray(parsed.problems) ? parsed.problems : [],
    configRisks: Array.isArray(parsed.configRisks) ? parsed.configRisks : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
  };
}

function fmtDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${value}ms`;
  const totalSec = Math.floor(value / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hour = Math.floor(totalSec / 3600);
  if (hour > 0) return `${hour}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function shortWorktree(task) {
  const raw = task.worktree ?? task.cwd ?? "";
  if (!raw) return "";
  return basename(String(raw).replace(/[\\/]+$/, ""));
}

function buildSnapshot({ state, cfgInfo, intervalMs }) {
  const now = Date.now();
  const cfg = cfgInfo.config;
  const tasks = readQueue(state.home).filter((t) => ACTIVE_STATUSES.has(t.status));
  const slots = snapshotSlots(state.home, { verify: false });
  const admission = admissionSnapshot({ home: state.home, cfg });

  const sorted = tasks.slice().sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return compareOrder(a, b, now, cfg);
  });

  let queuedPosition = 0;
  const taskViews = sorted.map((t) => {
    const enqueuedMs = Date.parse(t.enqueuedAt ?? t.updatedAt ?? "");
    const priority = PRIORITY_LABEL[t.priority] ?? String(t.priority ?? "?");
    const effective = PRIORITY_LABEL[effectivePriority(t, now, cfg)] ?? String(effectivePriority(t, now, cfg));
    const view = {
      id: t.id,
      label: t.label ?? "",
      taskClass: t.taskClass ?? "",
      status: t.status ?? "?",
      priority,
      effectivePriority: effective,
      enqueuedAt: t.enqueuedAt ?? null,
      waitedMs: Number.isFinite(enqueuedMs) ? Math.max(0, now - enqueuedMs) : null,
      worktree: shortWorktree(t),
      waitReason: t.waitReason ?? "",
      position: null,
    };
    if (t.status !== "running") {
      queuedPosition += 1;
      view.position = queuedPosition;
    }
    return view;
  });

  const classMeta = [
    { key: "heavy", label: "重型", concurrency: cfg.heavyConcurrency, counted: true },
    { key: "medium", label: "中型", concurrency: cfg.mediumConcurrency, counted: true },
    { key: "light", label: "轻量", concurrency: cfg.lightConcurrency, counted: true },
    { key: "dev", label: "dev", concurrency: cfg.devConcurrency, counted: false },
  ];

  let slotsTotal = 0;
  let slotsOccupied = 0;
  const lanes = classMeta.map((meta) => {
    const slotRows = [];
    const count = Math.max(1, Number(meta.concurrency) || 1);
    for (let i = 1; i <= count; i += 1) {
      const slotName = `${meta.key}-${i}`;
      const found = slots.find((s) => s.slot === slotName) ?? null;
      slotsTotal += 1;
      if (found?.taskId) slotsOccupied += 1;
      slotRows.push({
        name: slotName,
        taskId: found?.taskId ?? null,
        label: found?.label ?? "",
        taskClass: found?.taskClass ?? meta.key,
        heartbeatAgeMs: found?.heartbeatAgeMs ?? null,
        pidAlive: found?.pidAlive ?? null,
        stale: found?.stale ?? false,
      });
    }
    return { ...meta, slots: slotRows };
  });

  const running = taskViews.filter((t) => t.status === "running").length;
  const queued = taskViews.length - running;
  const global = admission.global ?? { active: 0, cap: null };
  const ledger = (admission.entries ?? []).map((e) => ({
    taskId: e.taskId,
    taskClass: e.taskClass,
    phase: e.phase,
    ownerPid: e.ownerPid,
    childPid: e.childPid,
    heartbeatAgeMs: e.heartbeatAgeMs,
    state: e.state,
    note: e.note ?? null,
  }));

  return {
    generatedAt: new Date(now).toISOString(),
    refreshIntervalMs: intervalMs,
    stateHome: state.home,
    stateSource: state.source,
    configLoadedAt: cfgInfo.loadedAt,
    config: {
      globalConcurrency: cfg.globalConcurrency,
      heavyConcurrency: cfg.heavyConcurrency,
      mediumConcurrency: cfg.mediumConcurrency,
      lightConcurrency: cfg.lightConcurrency,
      devConcurrency: cfg.devConcurrency,
      cargoJobs: cfg.cargoJobs,
      agingStepMs: cfg.agingStepMs,
    },
    configProblems: cfgInfo.configProblems,
    configRisks: cfgInfo.configRisks,
    counts: {
      active: taskViews.length,
      running,
      queued,
      slotsTotal,
      slotsFree: Math.max(0, slotsTotal - slotsOccupied),
    },
    global: {
      active: global.active ?? 0,
      cap: global.cap ?? null,
      applies: global.applies !== false,
      reason: global.reason ?? null,
      activeTaskIds: global.activeTaskIds ?? [],
    },
    lanes,
    tasks: taskViews,
    ledger,
  };
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Task Dock 构建调度看板</title>
<style>
:root {
  --bg: #0b1220;
  --panel: #121b2b;
  --panel-2: #172338;
  --line: #243149;
  --text: #e7edf7;
  --muted: #8fa0bb;
  --green: #34d399;
  --amber: #fbbf24;
  --red: #f87171;
  --blue: #60a5fa;
  --cyan: #22d3ee;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body {
  font: 14px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  padding: 18px 22px 28px;
}
a { color: var(--blue); }
.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .2px; }
.sub { color: var(--muted); font-size: 12px; }
.controls { display: flex; gap: 8px; align-items: center; }
button {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer;
}
button:hover { border-color: #3b4d6d; background: #1b2a42; }
button[aria-pressed="true"] { color: var(--amber); border-color: #6b5520; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 16px 0; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card .label { color: var(--muted); font-size: 12px; }
.card .value { font-size: 26px; font-weight: 650; line-height: 1.2; margin-top: 4px; font-variant-numeric: tabular-nums; }
.card .hint { color: var(--muted); font-size: 11px; margin-top: 2px; }
.value.good { color: var(--green); }
.value.warn { color: var(--amber); }
.value.bad { color: var(--red); }
.section { margin-top: 18px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.section-head h2 { font-size: 15px; margin: 0; font-weight: 600; }
.section-head .note { color: var(--muted); font-size: 11px; }
.lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.lane { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; }
.lane-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.lane-title { display: flex; align-items: center; gap: 7px; font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--muted); }
.dot.heavy { background: var(--red); }
.dot.medium { background: var(--amber); }
.dot.light { background: var(--green); }
.dot.dev { background: var(--cyan); }
.lane-count { color: var(--muted); font-size: 11px; }
.slots { display: flex; flex-direction: column; gap: 6px; }
.slot { border: 1px solid var(--line); border-radius: 8px; background: #0f1828; padding: 8px 9px; min-height: 52px; }
.slot.free { color: var(--muted); display: flex; align-items: center; justify-content: space-between; }
.slot.occupied { border-color: #33516f; }
.slot.stale { border-color: #6b5520; background: #1d1a10; }
.slot .slot-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.slot .slot-name { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.slot .slot-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot .slot-meta { color: var(--muted); font-size: 11px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn-text { color: var(--amber); }
.bad-text { color: var(--red); }
.table-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: auto; }
table { width: 100%; border-collapse: collapse; min-width: 900px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-size: 11px; font-weight: 600; background: #0f1828; position: sticky; top: 0; z-index: 1; }
tr:last-child td { border-bottom: 0; }
tr.running td { background: #10231f; }
td.mono, .mono { font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; }
td.reason { max-width: 430px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid transparent; white-space: nowrap; }
.pill.running { color: var(--green); border-color: #1d5b46; background: #0f2b24; }
.pill.queued, .pill.waiting_resources { color: var(--amber); border-color: #6b5520; background: #241f0f; }
.pill.cancelling { color: var(--red); border-color: #6b2a2a; background: #2a1414; }
.empty { color: var(--muted); padding: 16px; text-align: center; }
.banner { border-radius: 9px; padding: 9px 12px; margin: 10px 0; font-size: 12px; }
.banner.warn { background: #241f0f; border: 1px solid #6b5520; color: #fde68a; }
.banner.bad { background: #2a1414; border: 1px solid #6b2a2a; color: #fecaca; }
.ledger { display: flex; flex-wrap: wrap; gap: 6px; }
.ledger-chip { background: #0f1828; border: 1px solid var(--line); border-radius: 7px; padding: 5px 8px; font-size: 11px; color: var(--muted); }
.ledger-chip b { color: var(--text); font-weight: 600; }
footer { margin-top: 18px; color: var(--muted); font-size: 11px; line-height: 1.7; }
footer code { color: #c7d2fe; }
.conn { font-size: 11px; color: var(--muted); }
.conn.ok { color: var(--green); }
.conn.err { color: var(--red); }
@media (max-width: 620px) {
  body { padding: 14px; }
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lane { min-width: 0; }
}
</style>
</head>
<body>
<div class="top">
  <div>
    <h1>Task Dock 构建调度看板</h1>
    <div class="sub" id="meta">正在读取状态…</div>
  </div>
  <div class="controls">
    <span class="conn" id="conn">连接中</span>
    <button id="refresh" type="button">立即刷新</button>
    <button id="pause" type="button" aria-pressed="false">暂停自动刷新</button>
  </div>
</div>

<div class="banner bad" id="error" hidden></div>
<div class="banner warn" id="config-warn" hidden></div>

<div class="cards">
  <div class="card">
    <div class="label">全局构建并发</div>
    <div class="value" id="global-value">–</div>
    <div class="hint" id="global-hint">heavy/medium/light 合计</div>
  </div>
  <div class="card">
    <div class="label">运行中</div>
    <div class="value good" id="running-value">–</div>
    <div class="hint">含 dev 常驻服务</div>
  </div>
  <div class="card">
    <div class="label">排队</div>
    <div class="value warn" id="queued-value">–</div>
    <div class="hint">按有效优先级排序</div>
  </div>
  <div class="card">
    <div class="label">空闲槽位</div>
    <div class="value" id="slots-value">–</div>
    <div class="hint">heavy / medium / light / dev</div>
  </div>
</div>

<div class="section">
  <div class="section-head">
    <h2>槽位与活动台账</h2>
    <span class="note" id="config-note"></span>
  </div>
  <div class="lanes" id="lanes"></div>
  <div class="section-head" style="margin-top:12px">
    <h2 style="font-size:13px">活动台账</h2>
    <span class="note">每条占一个全局构建名额；dev 不计入</span>
  </div>
  <div class="ledger" id="ledger"></div>
</div>

<div class="section">
  <div class="section-head">
    <h2>队列</h2>
    <span class="note">运行中在前，其余按有效优先级；等待越久老化优先级越高</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>状态</th>
          <th>任务 ID</th>
          <th>分类</th>
          <th>优先级</th>
          <th>已等待</th>
          <th>工作区</th>
          <th>等待原因 / 标签</th>
        </tr>
      </thead>
      <tbody id="queue-body"></tbody>
    </table>
    <div class="empty" id="queue-empty" hidden>当前没有运行中或排队中的构建。</div>
  </div>
</div>

<footer>
  只读看板：不写状态目录、不取消任务、不占构建槽位。数据源与
  <code>build-sched.mjs status</code> 同源；页面隐藏时停止请求，服务端按需计算。
  <br>状态目录：<span class="mono" id="state-home"></span>
</footer>

<script>
(function () {
  var timer = null;
  var paused = false;
  var lastData = null;
  var intervalMs = ${DEFAULT_INTERVAL_MS};

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtDuration(ms) {
    if (ms == null || !isFinite(ms)) return "–";
    var v = Math.max(0, Number(ms));
    if (v < 1000) return v + "ms";
    var sec = Math.floor(v / 1000) % 60;
    var min = Math.floor(v / 60000) % 60;
    var hour = Math.floor(v / 3600000);
    if (hour > 0) return hour + "h " + min + "m";
    if (min > 0) return min + "m " + sec + "s";
    return sec + "s";
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function showError(message) {
    var el = document.getElementById("error");
    if (!el) return;
    if (message) { el.hidden = false; el.textContent = message; }
    else { el.hidden = true; el.textContent = ""; }
  }

  function renderLanes(data) {
    var host = document.getElementById("lanes");
    host.innerHTML = data.lanes.map(function (lane) {
      var slots = lane.slots.map(function (slot) {
        if (!slot.taskId) {
          return '<div class="slot free"><span class="slot-name">' + esc(slot.name) +
            '</span><span>空闲</span></div>';
        }
        var warn = slot.stale || slot.pidAlive === false;
        var meta = '心跳 ' + fmtDuration(slot.heartbeatAgeMs) + '前';
        if (slot.pidAlive === false) meta += ' · 持有进程已退出';
        else if (slot.stale) meta += ' · 心跳超时';
        return '<div class="slot occupied' + (warn ? ' stale' : '') + '">' +
          '<div class="slot-top"><span class="slot-label">' + esc(slot.label || slot.taskId) +
          '</span><span class="slot-name">' + esc(slot.name) + '</span></div>' +
          '<div class="slot-meta">' + esc(slot.taskId) + ' · ' +
          '<span class="' + (warn ? 'warn-text' : '') + '">' + esc(meta) + '</span></div></div>';
      }).join("");
      return '<div class="lane"><div class="lane-head"><div class="lane-title">' +
        '<span class="dot ' + esc(lane.key) + '"></span>' + esc(lane.label) +
        '</div><span class="lane-count">' + lane.slots.filter(function (s) { return s.taskId; }).length +
        '/' + lane.slots.length + (lane.counted ? '' : ' · 不计入全局') + '</span></div>' +
        '<div class="slots">' + slots + '</div></div>';
    }).join("");
  }

  function renderLedger(data) {
    var host = document.getElementById("ledger");
    if (!data.ledger.length) {
      host.innerHTML = '<span class="note">活动台账为空。</span>';
      return;
    }
    host.innerHTML = data.ledger.map(function (entry) {
      var hb = entry.heartbeatAgeMs == null ? '心跳 ?' : '心跳 ' + fmtDuration(entry.heartbeatAgeMs) + '前';
      var state = entry.state && entry.state !== 'owner-alive' ? ' · ' + entry.state : '';
      return '<span class="ledger-chip"><b>' + esc(entry.taskId) + '</b> · ' +
        esc(entry.taskClass) + ' · ' + esc(entry.phase || '?') + ' · ' + esc(hb) +
        esc(state) + '</span>';
    }).join("");
  }

  function renderQueue(data) {
    var body = document.getElementById("queue-body");
    var empty = document.getElementById("queue-empty");
    if (!data.tasks.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = data.tasks.map(function (task) {
      var statusClass = task.status === "running" ? "running" :
        (task.status === "waiting_resources" ? "waiting_resources" : "queued");
      var reason = task.waitReason || task.label || "";
      return '<tr class="' + (task.status === "running" ? "running" : "") + '">' +
        '<td class="mono">' + (task.position == null ? '–' : task.position) + '</td>' +
        '<td><span class="pill ' + statusClass + '">' + esc(task.status) + '</span></td>' +
        '<td class="mono">' + esc(task.id) + '</td>' +
        '<td>' + esc(task.taskClass) + '</td>' +
        '<td class="mono">' + esc(task.priority) + ' / ' + esc(task.effectivePriority) + '</td>' +
        '<td>' + esc(fmtDuration(task.waitedMs)) + '</td>' +
        '<td>' + esc(task.worktree || '–') + '</td>' +
        '<td class="reason" title="' + esc(reason) + '">' + esc(reason || '–') + '</td></tr>';
    }).join("");
  }

  function render(data) {
    lastData = data;
    intervalMs = data.refreshIntervalMs || intervalMs;
    var cap = data.global.cap;
    var active = data.global.active;
    setText("global-value", active + " / " + (cap == null ? "∞" : cap));
    var globalValue = document.getElementById("global-value");
    globalValue.className = "value " + (cap == null ? "" : (active >= cap ? "bad" : "good"));
    setText("global-hint", cap == null ? "未启用全局上限" :
      (active >= cap ? "已满，新构建会排队" : "heavy/medium/light 合计；dev 不计入"));
    setText("running-value", data.counts.running);
    setText("queued-value", data.counts.queued);
    setText("slots-value", data.counts.slotsFree + " / " + data.counts.slotsTotal);
    setText("meta", "更新于 " + new Date(data.generatedAt).toLocaleTimeString() +
      " · 每 " + Math.round((data.refreshIntervalMs || intervalMs) / 1000) + " 秒刷新" +
      (paused ? " （已暂停）" : ""));
    setText("config-note", "全局 " + data.config.globalConcurrency +
      " · heavy " + data.config.heavyConcurrency +
      " · medium " + data.config.mediumConcurrency +
      " · light " + data.config.lightConcurrency +
      " · dev " + data.config.devConcurrency +
      " · cargoJobs " + data.config.cargoJobs + "（无内存维度）");
    setText("state-home", data.stateHome);
    var warn = document.getElementById("config-warn");
    var problems = (data.configProblems || []).concat(data.configRisks || []);
    if (problems.length) {
      warn.hidden = false;
      warn.textContent = "配置提示：" + problems.map(String).join("；");
    } else {
      warn.hidden = true;
      warn.textContent = "";
    }
    renderLanes(data);
    renderLedger(data);
    renderQueue(data);
  }

  function setConn(text, cls) {
    var el = document.getElementById("conn");
    el.textContent = text;
    el.className = "conn " + (cls || "");
  }

  async function tick(force) {
    if (!force && (paused || document.hidden)) return;
    try {
      var res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      render(data);
      showError("");
      setConn("已连接", "ok");
    } catch (err) {
      setConn("连接失败", "err");
      showError("读取状态失败：" + (err && err.message ? err.message : String(err)) +
        "。旧数据保留在页面上。");
    }
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () { tick(false); }, intervalMs);
  }

  document.getElementById("refresh").addEventListener("click", function () { tick(true); });
  document.getElementById("pause").addEventListener("click", function (ev) {
    paused = !paused;
    ev.currentTarget.setAttribute("aria-pressed", paused ? "true" : "false");
    ev.currentTarget.textContent = paused ? "恢复自动刷新" : "暂停自动刷新";
    setText("meta", lastData ? ("更新于 " + new Date(lastData.generatedAt).toLocaleTimeString() +
      " · 每 " + Math.round(intervalMs / 1000) + " 秒刷新" + (paused ? " （已暂停）" : "")) : "正在读取状态…");
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) tick(true);
  });
  tick(true).then(startTimer);
})();
</script>
</body>
</html>`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return 0; }

  const state = resolveStateHome({ cwd: REPO_ROOT, env: process.env });
  const cfgInfo = loadEffectiveConfig();
  cfgInfo.loadedAt = new Date().toISOString();

  if (opts.once) {
    const snapshot = buildSnapshot({ state, cfgInfo, intervalMs: opts.intervalMs });
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }

  let cached = null;
  let cachedAt = 0;
  function getSnapshot() {
    const now = Date.now();
    if (!cached || now - cachedAt >= opts.intervalMs) {
      cached = buildSnapshot({ state, cfgInfo, intervalMs: opts.intervalMs });
      cachedAt = now;
    }
    return cached;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const common = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...common, Allow: "GET, HEAD" });
      res.end("method not allowed");
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, {
        ...common,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(req.method === "HEAD" ? "" : HTML);
      return;
    }
    if (url.pathname === "/api/state") {
      const body = JSON.stringify(getSnapshot());
      res.writeHead(200, {
        ...common,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? "" : body);
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { ...common, "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok\n");
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, common);
      res.end();
      return;
    }
    res.writeHead(404, { ...common, "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`端口 ${opts.port} 已被占用；换一个：--port ${opts.port + 1}`);
    } else {
      console.error(`看板服务启动失败：${err && err.message ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  });

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`Task Dock 构建调度看板：http://127.0.0.1:${opts.port}`);
    console.log(`状态目录：${state.home}（${state.source}）`);
    console.log(`刷新间隔：${opts.intervalMs}ms；页面隐藏时暂停请求；Ctrl+C 停止。`);
  });

  const shutdown = () => {
    server.close(() => { process.exitCode = 0; });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return null;
}

main();
