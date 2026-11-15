#!/usr/bin/env node
//! Task Dock 统一构建调度入口（零依赖，Node >= 18）。
//!
//!   node scripts/build-sched.mjs run [选项] -- <命令> [参数...]
//!   node scripts/build-sched.mjs status [--json] [--verbose]
//!   node scripts/build-sched.mjs queue [--json] [--limit N]
//!   node scripts/build-sched.mjs cancel <任务ID或前缀> [--wait 15]
//!   node scripts/build-sched.mjs history [--limit N] [--json]
//!   node scripts/build-sched.mjs doctor [--reap] [--json]
//!   node scripts/build-sched.mjs config [--json] [--all]
//!   node scripts/build-sched.mjs dev [--json]
//!   node scripts/build-sched.mjs cargo [选项] -- <cargo 子命令与参数>
//!
//! 详细说明与验收记录见 docs/BUILD_SCHEDULER.md。

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONFIG, configEnvName, configRisks, describeSources, loadConfig, DANGER_AUTH_ENV, DANGER_TOKENS,
} from "./sched/config.mjs";
import {
  ensureState, paths, readJson, resolveStateHome, slotDir,
} from "./sched/state.mjs";
import { concurrencyForClass, formatMb, memoryFloorForClass, pressureLevel, readMemory } from "./sched/mem.mjs";
import { reapOrphanChild, snapshotSlots } from "./sched/lock.mjs";
import {
  ACTIVE_STATUSES, PRIORITY_LABEL, clearCancelMarker, compareOrder, effectivePriority,
  housekeeping, parsePriority, readQueue, readTask, requestCancel, writeTask,
} from "./sched/queue.mjs";
import { EXIT, executeTask, runInline } from "./sched/runner.mjs";
import { scanDevServers } from "./sched/devservers.mjs";
import { verifyIdentity } from "./sched/proc.mjs";
import {
  budgetSnapshot, classifyReservation, computeBudget, defaultProbe, readReservations, reclaimStaleReservations,
} from "./sched/budget.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "node scripts/build-sched.mjs";

// ---------------------------------------------------------------- 参数解析

/** 把命令行拆成 [选项段, 透传段]：第一个独立的 `--` 之后全部属于被执行命令。 */
function splitPassthrough(argv) {
  const idx = argv.indexOf("--");
  if (idx < 0) return [argv, []];
  return [argv.slice(0, idx), argv.slice(idx + 1)];
}

function parseOptions(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { opts[key] = true; continue; }
      opts[key] = next;
      i++;
    } else positional.push(a);
  }
  return { opts, positional };
}

function parseDurationMinutes(value, flagName) {
  if (value === undefined) return null;
  if (value === true) throw new Error(`${flagName} 需要一个分钟数`);
  if (String(value).trim() === "0") return 0; // 0 = 不限
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new Error(`${flagName} 需要非负分钟数（当前 ${value}）`);
  return num;
}

// ---------------------------------------------------------------- 输出工具

function pad(text, width) {
  const s = String(text ?? "");
  const visible = [...s].length;
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

function truncate(text, width) {
  const s = String(text ?? "");
  return [...s].length > width ? [...s].slice(0, width - 1).join("") + "…" : s;
}

function printTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.title.length, ...rows.map((r) => [...String(r[c.key] ?? "")].length)));
  const header = columns.map((c, i) => pad(c.title, widths[i])).join("  ");
  console.log(header);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    console.log(columns.map((col, i) => pad(truncate(r[col.key] ?? "", widths[i]), widths[i])).join("  "));
  }
}

function fmtAgo(iso) {
  if (!iso) return "-";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

// ---------------------------------------------------------------- 上下文

function context() {
  const cwd = process.cwd();
  let state;
  try {
    state = resolveStateHome({ cwd, env: process.env });
  } catch (err) {
    console.error(`[sched] ${err.message}`);
    process.exit(EXIT.internal);
  }
  const loaded = loadConfig({ repoRoot: REPO_ROOT, stateHome: state.home, env: process.env });
  return {
    cwd, state, cfg: loaded.config, sources: loaded.sources,
    configProblems: loaded.problems, danger: loaded.danger,
  };
}

function warnConfig(problems) {
  if (!problems?.length) return;
  for (const p of problems) console.error(`[sched] 配置问题：${p}`);
}

// ---------------------------------------------------------------- run

async function cmdRun(argv) {
  const [optArgv, command] = splitPassthrough(argv);
  const { opts } = parseOptions(optArgv);
  if (opts.help) { printRunHelp(); return EXIT.ok; }
  if (command.length === 0) {
    console.error(`用法：${SELF} run [选项] -- <命令> [参数...]`);
    console.error("例：node scripts/build-sched.mjs run --priority P1 -- npm run build");
    return EXIT.usage;
  }
  const ctx = context();
  warnConfig(ctx.configProblems);

  let priority;
  try {
    priority = parsePriority(opts.priority, 1);
  } catch (err) {
    console.error(`[sched] ${err.message}`);
    return EXIT.usage;
  }
  let waitTimeoutMin;
  let runTimeoutMin;
  try {
    waitTimeoutMin = parseDurationMinutes(opts.waitTimeout, "--wait-timeout");
    runTimeoutMin = parseDurationMinutes(opts.runTimeout, "--run-timeout");
  } catch (err) {
    console.error(`[sched] ${err.message}`);
    return EXIT.usage;
  }
  if (opts.class && !["light", "medium", "heavy", "dev"].includes(opts.class)) {
    console.error(`[sched] --class 只能是 light|medium|heavy|dev（当前 ${opts.class}）`);
    return EXIT.usage;
  }
  const cwd = opts.cwd ? resolve(String(opts.cwd)) : process.cwd();
  if (!existsSync(cwd)) {
    console.error(`[sched] --cwd 不存在：${cwd}`);
    return EXIT.usage;
  }

  // 嵌套调用（例如 tauri build 的 beforeBuildCommand 调 npm run build）：直接执行，不再排队
  const parentTask = process.env.TASKDOCK_SCHED_TASK_ID;
  if (parentTask) {
    console.error(`[sched] 检测到已处于调度任务 ${parentTask} 内部，内层命令直通执行（不再排队，避免自锁）`);
    return runInline({ argv: command, cwd, shellRaw: opts.shellRaw === true });
  }

  return await executeTask({
    argv: command,
    cwd,
    label: typeof opts.label === "string" ? opts.label : undefined,
    priority,
    explicitClass: opts.class ?? null,
    cfg: ctx.cfg,
    home: ctx.state.home,
    tee: opts.noTee !== true,
    dedupe: ctx.cfg.dedupe && opts.noDedupe !== true,
    shellRaw: opts.shellRaw === true,
    detachChild: opts.detachChild === true,
    waitTimeoutMin,
    runTimeoutMin,
    estimateMb: opts.estimateMb ? Number(opts.estimateMb) : null,
    repoRoot: REPO_ROOT,
  });
}

function printRunHelp() {
  console.log(`${SELF} run [选项] -- <命令> [参数...]

选项：
  --priority P0..P3    优先级（默认 P1）。P0 阻塞开发的关键验证 / P3 非紧急全量检查
  --class <级别>       显式覆盖分类（light|medium|heavy|dev）；不写则按命令链自动判定
  --label <文字>       显示在 queue/status 里的任务名
  --wait-timeout <分>  排队等待上限（默认取配置 defaultWaitTimeoutMin；0 = 不限）
  --run-timeout <分>   运行上限（默认 0 = 不限；超时终止本任务子进程树）
  --estimate-mb <N>    覆盖预计内存峰值（仅影响准入下限与解释文案）
  --cwd <路径>         执行目录（默认当前目录；cargo 请用 cargo 子命令）
  --no-dedupe          关闭等价任务合并（仍会执行）
  --no-tee             子进程输出只写日志，不转发到终端
  --detach-child       子进程脱离本进程控制台（仅用于构造"会脱离父进程存活"的验收场景）
  --shell-raw          允许含引号/换行的参数（交给 cmd.exe 原样解析，慎用）

退出码：子进程码原样返回；调度层失败 3=等待/运行超时 4=取消 5=调度器错误 6=磁盘检查阻塞
        日志尾部有 \`sched: exit=... status=... reason=...\` 机器可读行用于区分层级。`);
}

// ---------------------------------------------------------------- status

function cmdStatus(argv) {
  const { opts } = parseOptions(argv);
  const ctx = context();
  const mem = readMemory();
  const slots = snapshotSlots(ctx.state.home, { verify: opts.verbose === true });
  const tasks = readQueue(ctx.state.home).filter((t) => ACTIVE_STATUSES.has(t.status));
  const pressure = pressureLevel(ctx.cfg, mem);
  const budget = budgetSnapshot({ home: ctx.state.home, cfg: ctx.cfg, totalMb: mem.totalMb });
  const devScan = opts.verbose === true ? scanDevServers({ repoRoot: REPO_ROOT, knownRoots: knownWorktrees() }) : null;

  const payload = {
    generatedAt: new Date().toISOString(),
    stateHome: ctx.state.home,
    stateSource: ctx.state.source,
    memory: { availMb: mem.availMb, totalMb: mem.totalMb, simulated: mem.simulated, source: mem.source },
    pressure,
    budget,
    slots,
    tasks,
    config: ctx.cfg,
    configProblems: ctx.configProblems,
    configSources: describeSources(ctx.sources),
    danger: ctx.danger,
    configRisks: configRisks({ config: ctx.cfg, danger: ctx.danger, sources: ctx.sources, problems: ctx.configProblems }),
    devServers: devScan ? { findings: devScan.findings, rows: devScan.rows.length } : null,
  };
  if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return EXIT.ok; }

  console.log(`状态目录：${ctx.state.home}  (来源：${ctx.state.source})`);
  console.log(`内存：可用 ${formatMb(mem.availMb)} / 总计 ${formatMb(mem.totalMb)}` +
    `${mem.simulated ? "  ⚠ 模拟值" : ""}  〔${mem.source}〕`);
  console.log(`压力：${pressure.text}`);
  console.log(`全局预算：${budget.enabled ? "启用" : "⚠ 已被显式关闭（危险授权生效）"} ` +
    `${formatMb(budget.reservedMb)} / ${formatMb(budget.budgetMb)} 已预留` +
    `（可用余量 ${formatMb(budget.availableMb)}；硬上限 = 物理 ${formatMb(budget.totalMb)} - 系统保留 ${formatMb(budget.reserveMb)}` +
    ` = ${formatMb(budget.hardLimitMb)}）`);
  // 危险授权 / 安全余量 / 配置来源：三条都必须显著可见，避免「配置被改了却看不出来」
  if (!budget.enabled) {
    console.log(`  ⚠ 预算关闭依据：${DANGER_AUTH_ENV}=${budget.dangerAuth.join(",") || "(缺令牌)"}` +
      "；本机不再执行跨分类全局预算，history 会标记该任务");
  }
  if (Number(budget.reserveReducedMb) > 0) {
    console.log(`  ⚠ 安全余量被下调：申报 ${formatMb(budget.reserveMb)}，推荐基线 ` +
      `${formatMb(budget.reserveBaselineMb)}，减少 ${formatMb(budget.reserveReducedMb)}` +
      `${budget.reserveLowerAuthorized ? "（已获 reserve-lower 授权）" : "（未经授权，有效值已回到基线）"}`);
  } else {
    console.log(`  安全余量：系统保留 ${formatMb(budget.reserveMb)}（推荐基线 ${formatMb(budget.reserveBaselineMb)}，未下调）`);
  }
  console.log(`  配置来源：${budget.configSources}`);
  // 预算风险一律显式打印：系统保留被侵占、预算装不下最大分类峰值、系统保留 ≥ 物理内存
  if (budget.warning) console.log(`  ${budget.warning}`);
  for (const e of budget.entries) {
    console.log(`  ${pad(e.taskId, 16)} ${pad(e.taskClass, 6)} ${pad(formatMb(e.reservedMb), 9)} ` +
      `phase=${pad(e.phase ?? "?", 9)} pid=${pad(e.ownerPid ?? "?", 7)} ` +
      `${e.state && e.state !== "owner-alive" ? `⚠ ${e.state}` : ""}`);
  }
  console.log("");
  console.log("槽位：");
  const bySlot = new Map(slots.map((s) => [s.slot, s]));
  for (const cls of ["heavy", "medium", "light", "dev"]) {
    const n = concurrencyForClass(ctx.cfg, cls);
    for (let i = 1; i <= n; i++) {
      const name = `${cls}-${i}`;
      const s = bySlot.get(name);
      if (!s) { console.log(`  ${pad(name, 9)} free      门槛 ${formatMb(memoryFloorForClass(ctx.cfg, cls))}`); continue; }
      console.log(`  ${pad(name, 9)} ${pad(s.taskId ?? "?", 16)} pid=${pad(s.pid ?? "?", 7)} ` +
        `心跳 ${pad(s.heartbeatAgeMs === null ? "?" : `${Math.round(s.heartbeatAgeMs / 1000)}s`, 4)}前 ` +
        `${s.label ? s.label : ""}${s.pidAlive === false ? "  ⚠ 持有进程已退出（下次竞争会回收）" : ""}` +
        `${s.identity === "gone" ? "  ⚠ 身份不符" : ""}`);
    }
  }
  console.log("");
  const waiting = tasks.filter((t) => t.status !== "running");
  const running = tasks.filter((t) => t.status === "running");
  console.log(`运行中 ${running.length} 个，排队 ${waiting.length} 个`);
  for (const t of [...running, ...waiting].slice(0, 12)) {
    const prio = `${PRIORITY_LABEL[t.priority] ?? t.priority}`;
    console.log(`  ${pad(t.id, 16)} ${pad(t.taskClass, 6)} ${pad(prio, 2)} ${pad(t.status, 16)} ` +
      `${pad(fmtAgo(t.enqueuedAt) + "前入队", 10)} ${truncate(t.waitReason ?? t.label ?? "", 60)}`);
  }
  if (tasks.length > 12) console.log(`  …还有 ${tasks.length - 12} 个，见 ${SELF} queue`);
  console.log("");
  console.log(`策略：重型 并发${ctx.cfg.heavyConcurrency}/门槛${formatMb(ctx.cfg.heavyMinAvailMb)} ` +
    `中型 并发${ctx.cfg.mediumConcurrency}/门槛${formatMb(ctx.cfg.mediumMinAvailMb)} ` +
    `轻量 并发${ctx.cfg.lightConcurrency}/门槛${formatMb(ctx.cfg.lightMinAvailMb)} ` +
    `dev 并发${ctx.cfg.devConcurrency} 采样${ctx.cfg.memorySampleMs}ms 滞回${formatMb(ctx.cfg.hysteresisMb)} ` +
    `cargoJobs=${ctx.cfg.cargoJobs}`);
  if (ctx.configProblems.length) {
    console.log("");
    for (const p of ctx.configProblems) console.log(`配置问题：${p}`);
  }
  if (devScan) {
    console.log("");
    console.log(`开发服务器/常驻构建进程：${devScan.rows.length} 个相关进程`);
    for (const f of devScan.findings) console.log(`  [${f.level}] ${f.text}\n      → ${f.hint}`);
    if (!devScan.findings.length) console.log("  未发现重复 dev server 或端口冲突");
  }
  return EXIT.ok;
}

function knownWorktrees() {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 20000, windowsHide: true,
  });
  if (r.status !== 0) return [];
  return (r.stdout ?? "").split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

// ---------------------------------------------------------------- queue

function cmdQueue(argv) {
  const { opts } = parseOptions(argv);
  const ctx = context();
  const tasks = readQueue(ctx.state.home).filter((t) => ACTIVE_STATUSES.has(t.status));
  const limit = Number(opts.limit ?? 30);
  const now = Date.now();
  const sorted = tasks.slice().sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return compareOrder(a, b, now, ctx.cfg);
  });
  if (opts.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      stateHome: ctx.state.home,
      memory: readMemory(),
      tasks: sorted.slice(0, limit),
    }, null, 2));
    return EXIT.ok;
  }
  if (!sorted.length) {
    console.log("队列为空（没有排队或运行中的任务）");
    const emptyBudget = budgetSnapshot({ home: ctx.state.home, cfg: ctx.cfg, totalMb: readMemory().totalMb });
    if (emptyBudget.warning) console.log(`⚠ ${emptyBudget.warning}`);
    return EXIT.ok;
  }
  printTable(sorted.slice(0, limit).map((t) => ({
    id: t.id,
    class: t.taskClass,
    priority: `${PRIORITY_LABEL[t.priority] ?? t.priority}/${PRIORITY_LABEL[effectivePriority(t, now, ctx.cfg)] ?? effectivePriority(t, now, ctx.cfg)}`,
    status: t.status,
    waited: fmtAgo(t.enqueuedAt),
    worktree: (t.worktree ?? "").replace(/\\/g, "/").split("/").slice(-1)[0],
    waiting_reason: t.waitReason ?? t.label ?? "",
  })), [
    { key: "id", title: "任务ID" },
    { key: "class", title: "分类" },
    { key: "priority", title: "优先级" },
    { key: "status", title: "状态" },
    { key: "waited", title: "已等待" },
    { key: "worktree", title: "工作区" },
    { key: "waiting_reason", title: "等待原因/标签" },
  ]);
  console.log("");
  // 队列底部固定给出预算与风险：`waiting_reason` 里已经写明是哪一侧不够，这里再给出"这台机器能不能装下"的结论，
  // 避免"峰值大于预算"被误读成"再等等就好"。
  const budgetView = budgetSnapshot({ home: ctx.state.home, cfg: ctx.cfg, totalMb: readMemory().totalMb });
  console.log(`全局预算：${formatMb(budgetView.reservedMb)} / ${formatMb(budgetView.budgetMb)} 已预留` +
    `（硬上限 = 物理 ${formatMb(budgetView.totalMb)} - 系统保留 ${formatMb(budgetView.reserveMb)}）`);
  if (budgetView.warning) console.log(`⚠ ${budgetView.warning}`);
  console.log("");
  console.log("说明：优先级列显示「基础/经老化后的有效优先级」；等待越久有效优先级越高，避免 P3 饥饿。");
  return EXIT.ok;
}

// ---------------------------------------------------------------- cancel

async function cmdCancel(argv) {
  const { opts, positional } = parseOptions(argv);
  const needle = positional[0];
  if (!needle) {
    console.error(`用法：${SELF} cancel <任务ID或前缀> [--wait 秒]`);
    return EXIT.usage;
  }
  const ctx = context();
  const tasks = readQueue(ctx.state.home);
  const matches = tasks.filter((t) => t.id === needle || t.id.startsWith(needle));
  if (!matches.length) {
    console.error(`[sched] 队列里没有匹配 ${needle} 的任务（可能已结束，见 history）`);
    return EXIT.usage;
  }
  if (matches.length > 1) {
    console.error(`[sched] 前缀 ${needle} 匹配多个任务，请写全 ID：${matches.map((t) => t.id).join(", ")}`);
    return EXIT.usage;
  }
  const task = matches[0];
  if (!ACTIVE_STATUSES.has(task.status)) {
    console.log(`任务 ${task.id} 已是终态 ${task.status}（exit=${task.exitCode ?? "-"}），无需取消`);
    return EXIT.ok;
  }

  const waitSec = Number(opts.wait ?? 15);
  requestCancel(ctx.state.home, task.id, { reason: "CLI cancel" });
  console.log(`[sched] 已登记取消请求：${task.id}（${task.taskClass} / ${task.status}）`);

  const owner = verifyIdentity({ pid: task.owner?.pid, startTime: task.owner?.startTime ?? null });
  // 只有「身份取证明确判定已退出」且「记录长时间没有任何更新」才敢直接按终态处理：
  // 单次 blink 式探活失败（重负载下进程快照漏读、PID 复用判定）不足以断言提交进程已死，
  // 否则会先把活着的提交进程的任务标成 cancelled，然后它自己覆盖回 running 继续跑（错判）。
  const staleMs = Date.now() - Date.parse(task.updatedAt ?? task.enqueuedAt ?? 0);
  if (owner.state === "gone" && staleMs > 15000) {
    // 提交进程已消失：没人会响应取消，直接按终态处理（不碰其他人的进程）
    writeTask(ctx.state.home, {
      ...task, status: "cancelled", exitCode: null,
      finishReason: `提交进程已退出（${owner.detail}），由 CLI 标记取消`,
      finishedAt: new Date().toISOString(),
    });
    clearCancelMarker(ctx.state.home, task.id);
    console.log(`[sched] 提交进程已退出，任务 ${task.id} 直接标记为 cancelled`);
    return EXIT.ok;
  }

  const deadline = Date.now() + Math.max(0, waitSec) * 1000;
  const t0 = Date.now();
  while (Date.now() < deadline) {
    const rec = readTask(ctx.state.home, task.id);
    if (!rec || !ACTIVE_STATUSES.has(rec.status)) {
      const status = rec?.status ?? "unknown";
      console.log(`[sched] 任务 ${task.id} 已结束：status=${status} exit=${rec?.exitCode ?? "-"}` +
        `${rec?.finishReason ? ` reason=${rec.finishReason}` : ""}`);
      return status === "cancelled" ? EXIT.ok : EXIT.ok;
    }
    // 等待中再取证一次：确认「提交进程确实已退出」且「记录 6s 内没被任何人更新」时，
    // 才敢替它收尾（否则只登记取消请求，让活着的持有者自己按取消码退出）。
    if (Date.now() - t0 > 2000) {
      const again = verifyIdentity({ pid: rec.owner?.pid, startTime: rec.owner?.startTime ?? null });
      const idle = Date.now() - Date.parse(rec.updatedAt ?? rec.enqueuedAt ?? 0);
      if (again.state === "gone" && idle > 6000) {
        writeTask(ctx.state.home, {
          ...rec, status: "cancelled", exitCode: null,
          finishReason: `提交进程已退出（${again.detail}），由 CLI 标记取消`,
          finishedAt: new Date().toISOString(),
        });
        clearCancelMarker(ctx.state.home, task.id);
        console.log(`[sched] 提交进程已退出且记录 ${Math.round(idle / 1000)}s 无更新，任务 ${task.id} 标记为 cancelled`);
        return EXIT.ok;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[sched] 取消请求已登记，但持有进程在 ${waitSec}s 内未完成收尾：` +
    `任务仍为 ${readTask(ctx.state.home, task.id)?.status ?? "?"}。请求已持久化，持有者下一轮轮询会处理。`);
  return EXIT.waitTimeout;
}

// ---------------------------------------------------------------- history

function cmdHistory(argv) {
  const { opts } = parseOptions(argv);
  const ctx = context();
  const limit = Number(opts.limit ?? 25);
  let entries = readHistoryLines(paths(ctx.state.home).history);
  if (opts.status) entries = entries.filter((e) => e.status === opts.status);
  entries = entries.slice(-limit);
  if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return EXIT.ok; }
  if (!entries.length) { console.log("还没有历史记录"); return EXIT.ok; }
  printTable(entries.map((e) => ({
    id: e.id,
    class: e.taskClass,
    priority: PRIORITY_LABEL[e.priority] ?? e.priority,
    status: e.status,
    exit: e.exitCode ?? "-",
    waiting: e.waitMs ? `${Math.round(e.waitMs / 1000)}s` : "0s",
    run: e.runMs ? `${Math.round(e.runMs / 1000)}s` : "0s",
    memory: e.memDuringRun?.minAvailMb !== null && e.memDuringRun?.minAvailMb !== undefined
      ? `低至${formatMb(e.memDuringRun.minAvailMb)}` : "-",
    finished: e.finishedAt?.slice(5, 19).replace("T", " ") ?? "-",
    label: truncate(e.label ?? e.command?.join(" ") ?? "", 40),
    reason: truncate(e.reason ?? "", 40),
  })), [
    { key: "id", title: "任务ID" },
    { key: "class", title: "分类" },
    { key: "priority", title: "优先级" },
    { key: "status", title: "状态" },
    { key: "exit", title: "退出码" },
    { key: "waiting", title: "等待" },
    { key: "run", title: "运行" },
    { key: "memory", title: "运行期最低可用内存" },
    { key: "finished", title: "结束时间" },
    { key: "label", title: "任务" },
    { key: "reason", title: "备注" },
  ]);
  console.log("");
  console.log("提示：日志正文在状态目录 logs/<任务ID>.log；历史只保留元数据，不含业务输出。");
  return EXIT.ok;
}

function readHistoryLines(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ---------------------------------------------------------------- doctor

function cmdDoctor(argv) {
  const { opts } = parseOptions(argv);
  const ctx = context();
  const home = ctx.state.home;
  const issues = [];
  const ok = [];
  const actions = [];

  // 1) 状态目录
  try {
    ensureState(home);
    ok.push(`状态目录可写：${home}`);
  } catch (err) {
    issues.push({ severity: "P0", text: `状态目录不可写：${err.message}` });
  }

  // 2) 配置
  if (ctx.configProblems.length) {
    for (const p of ctx.configProblems) issues.push({ severity: "P1", text: `配置：${p}` });
  } else ok.push("配置校验通过（未知字段/非法数值会被拒绝而不是静默忽略）");

  // 2b) 配置风险：预算被关、保留被下调、门槛被改到 1 MB 级、环境变量覆盖……
  //     这类「配置被改坏」不会报错，只会让准入静默失效（19:22 那次真实发生过），必须成条列出。
  const cfgRisks = configRisks({
    config: ctx.cfg, danger: ctx.danger, sources: ctx.sources, problems: ctx.configProblems,
    hasActiveReservations: readReservations(home).length > 0,
  });
  for (const r of cfgRisks) {
    issues.push({
      severity: r.level,
      text: `配置风险[${r.key}] ${r.text}` +
        `（当前 ${String(r.current ?? "-")} / 基线 ${String(r.baseline ?? "-")}；来源 ${r.source}` +
        `${r.affectsRunning ? "；影响运行中任务" : ""}）`,
    });
  }
  if (!cfgRisks.length) ok.push(`配置安全边界正常（预算${ctx.cfg.budgetEnabled === false ? "关闭" : "开启"}，` +
    `系统保留 ${formatMb(ctx.cfg.systemReserveMb)} ≥ 基线 ${formatMb(ctx.cfg.recommendedSystemReserveMb)}）`);

  // 3) 槽位卫生
  const slots = snapshotSlots(home, { verify: true });
  for (const s of slots) {
    if (s.identity === "gone") {
      issues.push({
        severity: "P1",
        text: `槽位 ${s.slot} 的持有进程已退出（${s.identityDetail}），记录 task=${s.taskId}` +
          `${s.child?.pid ? `，子进程 PID ${s.child.pid}` : ""}`,
      });
    } else if (s.identity === "unknown") {
      issues.push({ severity: "P1", text: `槽位 ${s.slot} 身份无法确认：${s.identityDetail}（按占用处理，不回收）` });
    } else if (s.stale) {
      issues.push({ severity: "P2", text: `槽位 ${s.slot} 心跳停滞 ${Math.round((s.heartbeatAgeMs ?? 0) / 1000)}s（持有者仍存活）` });
    } else ok.push(`槽位 ${s.slot} 健康：${s.taskId}（心跳 ${Math.round((s.heartbeatAgeMs ?? 0) / 1000)}s 前）`);
  }
  if (!slots.length) ok.push("当前没有占用中的槽位");

  // 4) 回收/释放残留目录
  const leftover = leftoverDirs(home);
  for (const l of leftover) issues.push({ severity: "P2", text: `残留目录 ${l}` });

  // 5) 队列残留
  const tasks = readQueue(home);
  const staleQueued = tasks.filter((t) => ACTIVE_STATUSES.has(t.status) && t.status !== "running" &&
    verifyIdentity({ pid: t.owner?.pid, startTime: t.owner?.startTime ?? null }).state === "gone");
  for (const t of staleQueued) {
    issues.push({ severity: "P2", text: `排队任务 ${t.id} 的提交进程已退出（会被 housekeeping 归档为 cancelled）` });
  }
  if (tasks.length && !staleQueued.length) ok.push(`队列记录 ${tasks.length} 条，无孤儿`);

  // 5b) 全局预算台账（预留与活动任务应当一一对应：多出来的就是崩溃残留）
  const reservations = readReservations(home);
  const budgetView = budgetSnapshot({ home, cfg: ctx.cfg, totalMb: readMemory().totalMb, probe: defaultProbe() });
  ok.push(`全局预算 ${formatMb(budgetView.reservedMb)} / ${formatMb(budgetView.budgetMb)} 已预留（${reservations.length} 条台账）`);
  // 预算风险（系统保留被侵占 / 预算装不下最大分类峰值 / 系统保留 ≥ 物理内存）必须在诊断里成条列出，
  // 而不是只在 status 里一行带过：这类问题会让重型任务"永远排队"，容易被误读成"谁占着槽位"。
  if (budgetView.warning) {
    issues.push({ severity: budgetView.reserveExhausted ? "P0" : "P2", text: `全局预算：${budgetView.warning}` });
  }
  const probe = defaultProbe();
  for (const r of budgetView.entries) {
    if (r.state === "owner-alive") {
      const taskRec = tasks.find((t) => t.id === r.taskId);
      if (taskRec && ACTIVE_STATUSES.has(taskRec.status)) continue; // 正常在跑
      issues.push({
        severity: "P2",
        text: `预留 ${r.taskId}（${formatMb(r.reservedMb)}）的持有进程仍存活但队列里没有对应活跃任务` +
          `（phase=${r.phase}，pid=${r.ownerPid}）`,
      });
      continue;
    }
    issues.push({
      severity: "P1",
      text: `预留 ${r.taskId}（${formatMb(r.reservedMb)}）无法自动回收：${r.state}——${r.note}`,
    });
  }

  // 6) 体积
  const logBytes = dirBytes(paths(home).logs);
  const histLines = readHistoryLines(paths(home).history).length;
  ok.push(`日志目录 ${formatMb(logBytes / 1024 / 1024)}（${countFiles(paths(home).logs)} 个文件），历史 ${histLines} 条`);

  // 7) 开发服务器
  const devScan = scanDevServers({ repoRoot: REPO_ROOT, knownRoots: knownWorktrees() });
  if (devScan.ok) {
    for (const f of devScan.findings) issues.push({ severity: f.level === "conflict" ? "P1" : "P3", text: `开发服务器：${f.text}` });
    if (!devScan.findings.length) ok.push(`开发服务器盘点：${devScan.rows.length} 个相关进程，无重复/端口冲突`);
  } else issues.push({ severity: "P3", text: `开发服务器盘点失败：${devScan.error}` });

  // 8) 回收动作（--reap 时执行）
  if (opts.reap === true) {
    for (const s of slots) {
      const owner = readJson(join(slotDir(home, s.slot), "owner.json"));
      if (!owner) {
        if (isDirEmptyish(slotDir(home, s.slot))) {
          safeRemove(slotDir(home, s.slot));
          actions.push(`删除空壳槽位 ${s.slot}`);
        }
        continue;
      }
      const idCheck = verifyIdentity({ pid: owner.pid, startTime: owner.startTime ?? null });
      if (idCheck.state !== "gone") continue;
      const reap = reapOrphanChild({
        child: owner.child ?? null, taskId: owner.taskId ?? null,
        audit: paths(home).reclaimLog, reason: `doctor --reap 回收 ${s.slot}`,
      });
      if (!reap.ok) {
        actions.push(`拒绝回收 ${s.slot}：${reap.detail}`);
        continue;
      }
      const moved = `${slotDir(home, s.slot)}.reclaim-${Date.now()}`;
      try {
        renameSync(slotDir(home, s.slot), moved);
        rmSync(moved, { recursive: true, force: true, maxRetries: 3 });
        actions.push(`回收槽位 ${s.slot}（持有者已退出）；${reap.detail}`);
      } catch (err) {
        actions.push(`回收 ${s.slot} 失败：${err?.code ?? err}`);
      }
    }
    for (const l of leftover) {
      try { rmSync(l, { recursive: true, force: true, maxRetries: 3 }); actions.push(`删除残留目录 ${l}`); }
      catch (err) { actions.push(`删除 ${l} 失败：${err?.code ?? err}`); }
    }

    // 预留台账：先按"证明已死"的规则处置能处置的；只有「持有者已死 + 子进程仍存活」的条目
    // 才用命令行签名取证终止子进程（绝不触碰持有者仍活着的任务）。
    const ledgerProbe = defaultProbe();
    const auditPath = paths(home).reclaimLog;
    for (const entry of readReservations(home)) {
      if (!Number.isInteger(entry.childPid)) continue;
      const verdict = classifyReservation(entry, { cfg: ctx.cfg, probe: ledgerProbe });
      if (verdict.reclaimable || verdict.state === "owner-alive") continue;
      const reap = reapOrphanChild({
        child: { pid: entry.childPid, commandLine: entry.childCmdLine ?? entry.childCmdSignature },
        taskId: entry.taskId, audit: auditPath, reason: `doctor --reap 处置预留 ${entry.taskId} 的构建子进程`,
      });
      actions.push(reap.ok
        ? `终止预留 ${entry.taskId} 的旧构建子进程：${reap.detail}`
        : `拒绝终止预留 ${entry.taskId} 的子进程：${reap.detail}`);
    }
    const sweep = reclaimStaleReservations({
      home, cfg: ctx.cfg, probe: ledgerProbe, audit: auditPath, log: (m) => actions.push(m),
    });
    if (sweep.removed.length) {
      actions.push(`回收崩溃残留预留 ${sweep.removed.length} 条：` +
        sweep.removed.map((r) => `${r.taskId}(${formatMb(r.reservedMb)})`).join("、"));
    }
    for (const b of sweep.blocked) actions.push(`保留预留 ${b.taskId}（${formatMb(b.reservedMb)}）：${b.detail}`);

    const cleaned = housekeeping({ home, tasks: readQueue(home), cfg: ctx.cfg, log: (m) => actions.push(m) });
    if (cleaned.length) actions.push(`归档/清理队列记录 ${cleaned.length} 条`);
    // 过期终态记录同样清掉
    for (const t of readQueue(home)) {
      if (ACTIVE_STATUSES.has(t.status)) continue;
      try { rmSync(join(paths(home).queue, `${t.id}.json`), { force: true }); } catch { /* ignore */ }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(), stateHome: home, ok, issues, actions,
      memory: readMemory(), budget: budgetView, slots, config: ctx.cfg,
      configSources: describeSources(ctx.sources), danger: ctx.danger, configRisks: cfgRisks,
    }, null, 2));
    return issues.some((i) => i.severity === "P0") ? EXIT.internal : EXIT.ok;
  }

  console.log(`诊断：${home}`);
  console.log("");
  for (const i of ok) console.log(`  ✓ ${i}`);
  for (const i of issues) console.log(`  [${i.severity}] ${i.text}`);
  console.log("");
  if (actions.length) {
    console.log("已执行的回收动作：");
    for (const a of actions) console.log(`  · ${a}`);
  } else if (issues.length) {
    console.log("提示：加 --reap 才会执行槽位回收/残留清理（默认只诊断，不动任何进程与文件）。");
  }
  const mem = readMemory();
  console.log(`内存：可用 ${formatMb(mem.availMb)} / ${formatMb(mem.totalMb)}${mem.simulated ? "（模拟值）" : ""}`);
  console.log(`全局预算：${formatMb(budgetView.reservedMb)} / ${formatMb(budgetView.budgetMb)} 已预留` +
    `（硬上限 ${formatMb(budgetView.hardLimitMb)} = 物理 ${formatMb(budgetView.totalMb)} - 系统保留 ${formatMb(budgetView.reserveMb)}）`);
  console.log(`配置来源：${describeSources(ctx.sources)}`);
  return issues.some((i) => i.severity === "P0") ? EXIT.internal : EXIT.ok;
}

function leftoverDirs(home) {
  const dir = paths(home).slots;
  try {
    return readdirSync(dir)
      .filter((n) => n.includes(".reclaim-") || n.includes(".release-"))
      .map((n) => join(dir, n))
      .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

function isDirEmptyish(dir) {
  try {
    return readdirSync(dir).filter((n) => n !== "owner.json" && n !== "heartbeat" && !n.startsWith(".")).length === 0;
  } catch { return false; }
}

function safeRemove(path) {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
}

function dirBytes(dir) {
  let total = 0;
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    try {
      const st = statSync(join(dir, n));
      if (st.isDirectory()) total += dirBytes(join(dir, n));
      else total += st.size;
    } catch { /* ignore */ }
  }
  return total;
}

function countFiles(dir) {
  try { return readdirSync(dir).length; } catch { return 0; }
}

// ---------------------------------------------------------------- config

function cmdConfig(argv) {
  const { opts } = parseOptions(argv);
  const ctx = context();
  if (opts.json) {
    console.log(JSON.stringify({
      stateHome: ctx.state.home, sources: ctx.sources, problems: ctx.configProblems,
      effective: ctx.cfg, defaults: opts.all ? DEFAULT_CONFIG : undefined,
      danger: ctx.danger,
      configRisks: configRisks({ config: ctx.cfg, danger: ctx.danger, sources: ctx.sources, problems: ctx.configProblems }),
    }, null, 2));
    return EXIT.ok;
  }
  console.log(`状态目录：${ctx.state.home}`);
  console.log("");
  const overrides = new Set((ctx.sources ?? []).flatMap((s) => s.applied ?? []));
  for (const [key, value] of Object.entries(ctx.cfg)) {
    const mark = overrides.has(key) ? "  (被覆盖)" : "";
    const envName = configEnvName(key);
    console.log(`  ${pad(key, 22)} ${pad(String(value), 10)}${mark}${opts.all ? "" : ""}` +
      (opts.all ? `   env: ${envName}` : ""));
  }
  console.log("");
  if (ctx.sources.length) {
    console.log("配置来源：");
    for (const s of ctx.sources) {
      console.log(`  · ${s.label ?? s.kind}${s.path ? `: ${s.path}` : ""}${s.names ? `: ${s.names.join(", ")}` : ""}`);
    }
  } else {
    console.log("配置来源：全部使用内置默认值（可创建 build-sched.config.json 或在状态目录写 config.json）");
  }
  if (ctx.configProblems.length) {
    console.log("");
    for (const p of ctx.configProblems) console.log(`问题：${p}`);
  }
  if (ctx.danger) {
    console.log("");
    console.log(`危险授权（${DANGER_AUTH_ENV}）：${ctx.danger.tokens.length ? ctx.danger.tokens.join(",") : "未设置"}`);
    if (ctx.danger.budgetOffRequested) {
      console.log(`  · 配置要求关闭预算：${ctx.danger.budgetOffAuthorized ? "已授权生效" : "未授权，已忽略"}`);
    }
    if (ctx.danger.reserveBreachRequested) {
      console.log(`  · 配置要求 allowReserveBreach：${ctx.danger.reserveBreachAuthorized ? "已授权生效" : "未授权，已关闭"}`);
    }
    if (ctx.danger.reserveLowerRequested) {
      console.log(`  · 配置降低系统保留：${ctx.danger.reserveDeclaredMb} MB（基线 ` +
        `${ctx.danger.reserveBaselineMb} MB）→ ${ctx.danger.reserveLowerAuthorized ? "已授权生效" : "未授权，有效值回到基线"}`);
    }
    for (const b of ctx.danger.blocked) console.log(`  · ${b}`);
  }
  return ctx.configProblems.length ? EXIT.usage : EXIT.ok;
}

// ---------------------------------------------------------------- dev

function cmdDev(argv) {
  const { opts } = parseOptions(argv);
  const scan = scanDevServers({ repoRoot: REPO_ROOT, knownRoots: knownWorktrees() });
  if (opts.json) { console.log(JSON.stringify(scan, null, 2)); return scan.ok ? EXIT.ok : EXIT.internal; }
  if (!scan.ok) {
    console.error(`[sched] 进程盘点失败：${scan.error}`);
    return EXIT.internal;
  }
  console.log(`开发服务器/常驻构建进程：${scan.rows.length} 个`);
  printTable(scan.rows.map((r) => ({
    pid: r.pid,
    role: r.role,
    workspace: (r.workspace ?? "-").replace(/\\/g, "/").split("/").slice(-1)[0],
    ports: r.ports.join(",") || "-",
    memory: r.workingSetMb ? `${r.workingSetMb} MB` : "-",
    chain: r.parentChain.join(" ← "),
  })), [
    { key: "pid", title: "PID" },
    { key: "role", title: "角色" },
    { key: "workspace", title: "工作区" },
    { key: "ports", title: "监听端口" },
    { key: "memory", title: "内存" },
    { key: "chain", title: "父进程链" },
  ]);
  console.log("");
  if (!scan.findings.length) { console.log("未发现重复实例、端口冲突或跨 Worktree 错误复用。"); return EXIT.ok; }
  for (const f of scan.findings) console.log(`[${f.level}] ${f.text}\n    → ${f.hint}`);
  console.log("");
  console.log("调度器只做盘点与提示：不会自动终止任何进程（终止其他会话的进程需要明确授权）。");
  return EXIT.ok;
}

// ---------------------------------------------------------------- cargo

async function cmdCargo(argv) {
  // 有 `--` 时前面是调度选项，后面是 cargo 参数；没有 `--` 时（npm run cargo -- test --lib x）
  // 全部参数都原样交给 cargo——否则 cargo 自己的 `--lib`、`--workspace` 会被当成调度选项吞掉。
  const [optArgv, rest] = splitPassthrough(argv);
  const { opts } = parseOptions(optArgv);
  const args = rest.length ? rest : optArgv;
  if (!args.length) {
    console.error(`用法：${SELF} cargo -- <cargo 子命令与参数>（例如 cargo -- test --lib clipboard::）`);
    return EXIT.usage;
  }
  const ctx = context();
  const cargoCwd = join(REPO_ROOT, "src-tauri");
  if (!existsSync(join(cargoCwd, "Cargo.toml"))) {
    console.error(`[sched] 找不到 ${cargoCwd}/Cargo.toml`);
    return EXIT.usage;
  }
  const parentTask = process.env.TASKDOCK_SCHED_TASK_ID;
  if (parentTask) {
    console.error(`[sched] 已处于调度任务 ${parentTask} 内部，cargo 直通执行`);
    return runInline({ argv: ["cargo", ...args], cwd: cargoCwd });
  }
  console.log("[sched] 在 src-tauri/ 内执行 cargo（保持 rust-toolchain.toml 固定的 MSVC 工具链）");
  return await executeTask({
    argv: ["cargo", ...args],
    cwd: cargoCwd,
    label: `cargo ${args.join(" ")}`,
    priority: rest.length ? parsePriority(opts.priority, 1) : 1,
    explicitClass: rest.length ? (opts.class ?? null) : null,
    cfg: ctx.cfg,
    home: ctx.state.home,
    tee: opts.noTee !== true,
    dedupe: ctx.cfg.dedupe && opts.noDedupe !== true,
    waitTimeoutMin: rest.length ? parseDurationMinutes(opts.waitTimeout, "--wait-timeout") : null,
    runTimeoutMin: rest.length ? parseDurationMinutes(opts.runTimeout, "--run-timeout") : null,
    repoRoot: REPO_ROOT,
  });
}

// ---------------------------------------------------------------- main

function printHelp() {
  console.log(`Task Dock 统一构建调度器（${SELF}）

  run      提交并执行一个构建任务（排队 + 内存准入 + 全局互斥）
  status   资源与槽位现状（--json 供程序读取，--verbose 附带进程身份校验与 dev 盘点）
  queue    当前队列（按有效优先级排序）
  cancel   取消排队或运行中的任务
  history  执行记录（退出码、等待时长、运行期最低可用内存）
  doctor   自诊断（--reap 才执行槽位回收/残留清理）
  config   有效配置与来源
  dev      开发服务器/端口冲突盘点（只读）
  cargo    在 src-tauri/ 内执行 cargo 子命令

所有高资源构建都应通过本入口执行，详见 docs/BUILD_SCHEDULER.md。
npm 侧快捷入口：npm run build / npm run tauri / npm run test / npm run cargo -- <子命令>`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const rest = argv.slice(1);
  switch (cmd) {
    case "run": return await cmdRun(rest);
    case "status": return cmdStatus(rest);
    case "queue": return cmdQueue(rest);
    case "cancel": return await cmdCancel(rest);
    case "history": return cmdHistory(rest);
    case "doctor": return cmdDoctor(rest);
    case "config": return cmdConfig(rest);
    case "dev": return cmdDev(rest);
    case "cargo": return await cmdCargo(rest);
    case "help":
    case "--help":
    case "-h": printHelp(); return EXIT.ok;
    default:
      console.error(`未知子命令：${cmd}`);
      printHelp();
      return EXIT.usage;
  }
}

main().then((code) => {
  process.exitCode = typeof code === "number" ? code : EXIT.internal;
}).catch((err) => {
  console.error(`[sched] 未捕获错误：${err?.stack ?? err}`);
  process.exitCode = EXIT.internal;
});
