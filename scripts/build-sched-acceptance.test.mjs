//! 构建调度器**跨进程行为验收**（node --test）：
//! 真实起多个调度进程与真实子进程，只用「模拟可用内存」制造极端场景，
//! 不靠真实耗尽内存压测（会危害开发机）。
//!
//! 运行：npm run sched:acceptance   （约 60–90s）
//!
//! 覆盖需求第十一条验收项：
//!   1 跨进程互斥 / 2 跨 Worktree / 3 内存不足与恢复 / 4 异常恢复 /
//!   5 排队与运行中取消 / 6 构建去重与输入变化 / 7 轻量并行 / 8 队列公平性 / 9 原有工具链兼容

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyArgv } from "./sched/classify.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHED = join(REPO, "scripts", "build-sched.mjs");

// ---------------------------------------------------------------- 测试环境

let envSeq = 0;

/**
 * 每个测试一套独立状态目录与两个「工作区」，互不干扰；
 * 内存用 sim 文件模拟（可随时改值），调度器自身读的是同一份模拟值。
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), `sched-acc-${envSeq++}-`));
  const home = join(dir, "state");
  const wsA = join(dir, "wt-a");
  const wsB = join(dir, "wt-b");
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });
  for (const ws of [wsA, wsB]) writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "fixture" }));
  const simFile = join(dir, "sim-avail.txt");
  writeFileSync(simFile, "avail_mb=9000\n");
  const log = join(dir, "fake-build.log");
  const fake = join(dir, "fake-build.mjs");
  writeFileSync(fake, FAKE_BUILD_SOURCE);
  return { dir, home, wsA, wsB, simFile, log, fake };
}

const FAKE_BUILD_SOURCE = `
import { appendFileSync } from "node:fs";
const log = process.env.FAKE_LOG;
const dur = Number(process.env.FAKE_DURATION_MS ?? 1000);
const code = Number(process.env.FAKE_EXIT ?? 0);
const tag = process.argv[2] ?? "t";
const pid = process.pid;
const t0 = Date.now();
// 追加写要重试：机器重负载 / 杀软扫描时 appendFileSync 可能抛 EPERM/EBUSY，
// 丢一条 end 行会让验收按"任务一直没结束"统计，产生假的"重叠执行"结论。
function note(line) {
  for (let i = 0; i < 30; i++) {
    try { appendFileSync(log, line); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
  }
}
note(\`\${tag} start \${pid} \${t0}\\n\`);
setTimeout(() => {
  note(\`\${tag} end \${pid} \${Date.now()}\\n\`);
  process.exit(code);
}, dur);
`;

function setSimAvail(ctx, mb) {
  writeFileSync(ctx.simFile, `avail_mb=${mb}\n`);
}

function baseEnv(ctx, extra = {}) {
  return {
    ...process.env,
    TASKDOCK_BUILD_SCHED_HOME: ctx.home,
    TASKDOCK_SCHED_SIM_FILE: ctx.simFile,
    // 测试专用加速参数：不影响生产默认值
    TASKDOCK_SCHED_POLL_MS: "150",
    TASKDOCK_SCHED_MEMORY_SAMPLE_MS: "400",
    TASKDOCK_SCHED_HEARTBEAT_MS: "500",
    TASKDOCK_SCHED_DISK_PRECHECK: "false",
    // 验收里任何「排队卡死」都必须在 1 分钟内暴露成退出码 3，而不是等默认的 20 分钟
    TASKDOCK_SCHED_DEFAULT_WAIT_TIMEOUT_MIN: "1",
    ...extra,
  };
}

/**
 * 起一个调度器进程执行假构建（真实子进程、真实退出码）。
 * @returns {{child, done:Promise<{code,stdout,stderr}>, pid:number|null}}
 */
function runFake(ctx, { tag, durationMs = 1000, exitCode = 0, taskClass = "heavy", priority = "P1",
  cwd = null, extraArgs = [], envExtra = {}, onSpawn = null } = {}) {
  const args = [SCHED, "run", "--priority", priority];
  if (taskClass) args.push("--class", taskClass);
  args.push(...extraArgs, "--", process.execPath, ctx.fake, tag);
  const child = spawn(process.execPath, args, {
    cwd: cwd ?? ctx.wsA,
    env: baseEnv(ctx, {
      FAKE_LOG: ctx.log,
      FAKE_DURATION_MS: String(durationMs),
      FAKE_EXIT: String(exitCode),
      ...envExtra,
    }),
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const cap = (s, chunk) => (s.length > 30000 ? s : s + chunk);
  child.stdout.on("data", (c) => { stdout = cap(stdout, c.toString("utf8")); });
  child.stderr.on("data", (c) => { stderr = cap(stderr, c.toString("utf8")); });
  const done = new Promise((res) => {
    child.on("exit", (code, signal) => res({ code, signal, stdout, stderr, pid: child.pid }));
  });
  if (onSpawn) onSpawn(child);
  // text(): 提交进程运行期间的已捕获输出（用于读它打印的任务 id），done 里另有完整快照
  return { child, done, pid: child.pid, text: () => stdout };
}

function schedJson(ctx, args) {
  const r = spawnSync(process.execPath, [SCHED, ...args], {
    cwd: ctx.wsA, env: baseEnv(ctx), encoding: "utf8", timeout: 60000, windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`sched ${args.join(" ")} 失败(${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** 跑一条会打印人读文案（不是 JSON）的调度 CLI 子命令。 */
function schedCli(ctx, args) {
  return spawnSync(process.execPath, [SCHED, ...args], {
    cwd: ctx.wsA, env: baseEnv(ctx), encoding: "utf8", timeout: 60000, windowsHide: true,
  });
}

function readQueue(ctx) {
  const dir = join(ctx.home, "queue");
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => {
        try { return JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function readSlots(ctx) {
  const dir = join(ctx.home, "slots");
  try { return readdirSync(dir).filter((n) => /^(heavy|medium|light|dev)-\d+$/.test(n)); } catch { return []; }
}

function readHistory(ctx) {
  try {
    return readFileSync(join(ctx.home, "history.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function findTask(ctx, predicate) {
  return readQueue(ctx).find(predicate) ?? null;
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 120, what = "条件" } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
}

/** 解析假构建日志为区间，用来看「同一时刻到底有几个重型构建在跑」。 */
function intervals(logPath) {
  let text = "";
  try { text = readFileSync(logPath, "utf8"); } catch { return []; }
  const starts = new Map();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+) (start|end) (\d+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    const [, tag, kind, pid, ts] = m;
    if (kind === "start") starts.set(`${tag}:${pid}`, Number(ts));
    else {
      const start = starts.get(`${tag}:${pid}`);
      if (start !== undefined) out.push({ tag, pid: Number(pid), start, end: Number(ts) });
    }
  }
  return out;
}

function maxOverlap(list) {
  const points = [];
  for (const iv of list) { points.push({ t: iv.start, d: 1 }); points.push({ t: iv.end, d: -1 }); }
  points.sort((a, b) => (a.t === b.t ? a.d - b.d : a.t - b.t));
  let cur = 0;
  let max = 0;
  for (const p of points) { cur += p.d; max = Math.max(max, cur); }
  return max;
}

function startCount(logPath, tag) {
  let text = "";
  try { text = readFileSync(logPath, "utf8"); } catch { return 0; }
  return (text.match(new RegExp(`^${tag} start `, "gm")) ?? []).length;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function killOnly(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/F"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
}

function cleanup(ctx) {
  // 收尾：确保没有遗留的调度/假构建进程仍占用测试目录
  for (const rec of readQueue(ctx)) {
    if (rec.child?.pid && isAlive(rec.child.pid)) killOnly(rec.child.pid);
  }
  for (const n of readSlots(ctx)) {
    try {
      const owner = JSON.parse(readFileSync(join(ctx.home, "slots", n, "owner.json"), "utf8"));
      if (owner?.pid && isAlive(owner.pid)) killOnly(owner.pid);
    } catch { /* ignore */ }
  }
  try { rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 句柄可能仍占用 */ }
}

// ---------------------------------------------------------------- 1. 跨进程互斥

test("验收1：3 个独立进程同时提交重型任务，任意时刻只有 1 个在跑", async () => {
  const ctx = setup();
  try {
    const runs = ["m1", "m2", "m3"].map((tag) => runFake(ctx, { tag, durationMs: 1200 }));
    const results = await Promise.all(runs.map((r) => r.done));
    for (const r of results) assert.equal(r.code, 0, `任务应成功：${r.stderr}`);

    const iv = intervals(ctx.log);
    assert.equal(iv.length, 3, "三个任务都应真正执行过");
    assert.equal(maxOverlap(iv), 1, "⛔ 重型任务发生了重叠执行");

    const span = Math.max(...iv.map((x) => x.end)) - Math.min(...iv.map((x) => x.start));
    assert.ok(span > 3000, `串行执行总时长应 >= 3×1.2s，实测 ${span}ms`);
    assert.equal(readSlots(ctx).length, 0, "全部结束后不得残留槽位");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 2. 跨 Worktree

test("验收2：两个不同 Worktree 提交重型任务，共享同一全局资源限制", async () => {
  const ctx = setup();
  try {
    const a = runFake(ctx, { tag: "ws-a", durationMs: 1200, cwd: ctx.wsA });
    const b = runFake(ctx, { tag: "ws-b", durationMs: 1200, cwd: ctx.wsB });
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    const iv = intervals(ctx.log);
    assert.equal(iv.length, 2);
    assert.equal(maxOverlap(iv), 1, "⛔ 不同 Worktree 之间绕过了全局互斥");

    const status = schedJson(ctx, ["status", "--json"]);
    assert.equal(status.stateHome, ctx.home, "两个工作区必须解析到同一状态目录");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 3. 内存不足与恢复

test("验收3：可用内存 3GB 时重型任务等待，恢复到 9GB 后自动继续", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 3000);
    const run = runFake(ctx, { tag: "mem", durationMs: 600, priority: "P0" });

    // 记录是「先落 queued 再判资源」的两步写：这里必须等首轮评估结果（waitReason 非空），
    // 否则会读到还没评估过的 queued 快照，把「等待原因为空」误判成缺陷
    const waiting = await waitFor(() => {
      const rec = findTask(ctx, (t) => t.command?.[2] === "mem");
      return rec && (rec.status === "waiting_resources" || rec.status === "queued") && rec.waitReason ? rec : null;
    }, { what: "重型任务进入等待（含等待原因）" });

    assert.equal(startCount(ctx.log, "mem"), 0, "⛔ 内存不足时仍然启动了重型构建");
    assert.match(String(waiting.waitReason ?? ""), /6\.00 GB/, "等待原因必须明确给出内存缺口");
    assert.equal(readSlots(ctx).length, 0, "等待期间不得占用重型槽位");

    setSimAvail(ctx, 9000);
    const res = await run.done;
    assert.equal(res.code, 0, `内存恢复后应能继续执行：${res.stderr}`);
    assert.equal(startCount(ctx.log, "mem"), 1, "恢复后只应启动一次");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 4. 异常恢复

test("验收4：调度进程被强杀后，旧构建仍在跑时不得放行新构建（且不永久死锁）", async () => {
  const ctx = setup();
  try {
    // --detach-child 让子进程脱离调度器控制台：结构上等价于 Gradle daemon / tauri 应用
    // 这类「父进程死了构建还在跑」的守护进程，正是需要回收的危险窗口。
    // （普通子进程在 Windows 上会随父进程控制台关闭一起退出，见 docs/BUILD_SCHEDULER.md）
    const orphanRun = runFake(ctx, { tag: "orphan", durationMs: 30000, extraArgs: ["--detach-child"] });
    // 等到真正开始执行，并拿到子进程 PID
    const running = await waitFor(() => {
      const rec = findTask(ctx, (t) => t.command?.[2] === "orphan");
      return rec && rec.status === "running" && rec.child?.pid ? rec : null;
    }, { what: "重型任务进入运行态" });
    const orphanChildPid = running.child.pid;
    assert.ok(isAlive(orphanChildPid), "前置条件：假构建进程仍存活");

    await new Promise((r) => setTimeout(r, 900)); // 让心跳至少更新一次
    killOnly(orphanRun.pid); // 只杀调度客户端，不杀进程树：模拟崩溃
    await orphanRun.done.catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(isAlive(orphanChildPid), "前置条件：崩溃后旧构建进程仍在跑（这正是危险窗口）");
    assert.equal(readSlots(ctx).length, 1, "崩溃后槽位仍被占（不能因为进程消失就自动释放）");

    const nextRun = runFake(ctx, { tag: "next", durationMs: 800 });
    const res = await nextRun.done;
    assert.equal(res.code, 0, `恢复后新任务应能执行：${res.stderr}`);
    assert.match(res.stderr, /回收槽位|已终止孤儿构建进程树/, "必须明确记录回收动作");
    assert.equal(isAlive(orphanChildPid), false, "旧构建进程树必须已被终止，否则会出现两个重型构建");

    const iv = intervals(ctx.log);
    const second = iv.filter((x) => x.tag === "next");
    assert.equal(second.length, 1, "新任务应执行一次");
    assert.equal(maxOverlap(iv), 1, "⛔ 新旧构建发生了重叠");

    // 再提交一个，确认没有永久死锁
    const third = runFake(ctx, { tag: "third", durationMs: 400 });
    const r3 = await third.done;
    assert.equal(r3.code, 0, "恢复后队列必须继续可用（无死锁）");

    const reclaimLog = join(ctx.home, "reclaim-log.jsonl");
    assert.ok(existsSync(reclaimLog), "必须留回收审计记录");
    assert.match(readFileSync(reclaimLog, "utf8"), /reap-orphan/, "审计记录里应有杀死孤儿进程的证据");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 5. 取消

test("验收5a：取消排队中的任务，不影响正在运行的任务", async () => {
  const ctx = setup();
  try {
    // 占位任务跑足 8s：cancel 本身要起一个新进程（机器繁忙时可能 1–3s），
    // 留足窗口才能保证「取消发生在 B 仍在排队时」，否则测到的是「取消一个已经跑完的任务」
    const heavyA = runFake(ctx, { tag: "hold", durationMs: 8000, extraArgs: ["--label", "hold"] });
    await waitFor(() => findTask(ctx, (t) => t.label === "hold" && t.status === "running"), { what: "A 开始运行" });

    const queuedB = runFake(ctx, { tag: "victim", durationMs: 600, extraArgs: ["--label", "victim"] });
    const victim = await waitFor(
      () => findTask(ctx, (t) => t.label === "victim" && (t.status === "queued" || t.status === "waiting_resources")),
      { what: "B 进入排队" },
    );
    // 目标 id 以提交进程自己打印的为准（避免 label 查询在并发清理下匹配到别的记录）
    const printedId = /\b(h-[a-z0-9]+-[0-9a-f]{6})\b/.exec(queuedB.text())?.[1] ?? victim.id;
    assert.equal(printedId, victim.id,
      `提交进程打印的任务 id 与队列记录不一致（printed=${printedId} record=${victim.id}）`);

    const cancel = spawnSync(process.execPath, [SCHED, "cancel", printedId, "--wait", "8"], {
      cwd: ctx.wsA, env: baseEnv(ctx), encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    assert.equal(cancel.status, 0, `取消失败：${cancel.stderr}`);

    const resB = await queuedB.done;
    // 失败时把关键现场带进断言消息：是"取消没生效"还是"取消来晚了（任务已跑完）"
    const victimRec = findTask(ctx, (t) => t.label === "victim");
    assert.equal(resB.code, 4,
      `被取消的任务应返回调度层取消码 4（实际 exit=${resB.code}，记录 status=${victimRec?.status}`
      + `，cancel 标记=${existsSync(join(ctx.home, "cancel", victim.id)) ? "仍在" : "已清除"}`
      + `，cancel 输出=${cancel.stdout.trim().replace(/\s+/g, " ").slice(-160)}`
      + `，victim 启动次数=${startCount(ctx.log, "victim")}）`);
    assert.equal(startCount(ctx.log, "victim"), 0, "⛔ 已取消的排队任务仍然执行了");

    const resA = await heavyA.done;
    assert.equal(resA.code, 0, "另一个任务不得被取消请求影响");
    assert.equal(startCount(ctx.log, "hold"), 1);
  } finally { cleanup(ctx); }
});

test("验收5b：取消运行中的任务，状态准确且资源安全释放", async () => {
  const ctx = setup();
  try {
    const run = runFake(ctx, { tag: "killme", durationMs: 6000, extraArgs: ["--label", "killme"] });
    const rec = await waitFor(() => {
      const t = findTask(ctx, (x) => x.label === "killme");
      return t && t.status === "running" && t.child?.pid ? t : null;
    }, { what: "任务进入运行态" });

    const cancel = spawnSync(process.execPath, [SCHED, "cancel", rec.id, "--wait", "12"], {
      cwd: ctx.wsA, env: baseEnv(ctx), encoding: "utf8", timeout: 40000, windowsHide: true,
    });
    assert.equal(cancel.status, 0, `取消失败：${cancel.stdout}`);

    const res = await run.done;
    assert.equal(res.code, 4, "运行中被取消应返回 4");
    assert.equal(res.signal === null || res.signal === undefined || res.code === 4, true);
    await waitFor(() => readSlots(ctx).length === 0, { what: "槽位释放" });

    const status = schedJson(ctx, ["queue", "--json"]);
    const still = status.tasks.find((t) => t.id === rec.id);
    assert.equal(still, undefined, "被取消任务不应继续占在活动队列里");

    const history = spawnSync(process.execPath, [SCHED, "history", "--json"], {
      cwd: ctx.wsA, env: baseEnv(ctx), encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    const entries = JSON.parse(history.stdout);
    const entry = entries.find((e) => e.id === rec.id);
    assert.equal(entry?.status, "cancelled", "历史里必须记录 cancelled");
    assert.equal(entry?.exitCode, 4);
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 6. 去重

test("验收6：等价并发构建只执行一次；输入变化后不再复用", async () => {
  const ctx = setup();
  try {
    // 同一工作区、同一命令、同一代码状态 → 等价
    const first = runFake(ctx, { tag: "dup", durationMs: 5000 });
    await waitFor(() => findTask(ctx, (t) => t.status === "running" && t.command?.[2] === "dup"), { what: "首个任务运行" });
    const second = runFake(ctx, { tag: "dup", durationMs: 5000 });
    const [r1, r2] = await Promise.all([first.done, second.done]);
    assert.equal(r1.code, 0);
    assert.equal(r2.code, 0);
    assert.equal(startCount(ctx.log, "dup"), 1, "⛔ 等价任务被执行了多次");
    assert.match(r2.stderr, /等价任务/, "第二个提交方应看到去重说明");

    // 改依赖清单（真实输入变化）→ 指纹改变，不得附加到旧任务
    const third = runFake(ctx, { tag: "dup2", durationMs: 4000 });
    await waitFor(() => findTask(ctx, (t) => t.status === "running" && t.command?.[2] === "dup2"), { what: "变化后的任务运行" });
    const pkg = JSON.parse(readFileSync(join(ctx.wsA, "package.json"), "utf8"));
    pkg.dependencies = { changed: "1.0.0" };
    writeFileSync(join(ctx.wsA, "package.json"), JSON.stringify(pkg, null, 2));

    const fourth = runFake(ctx, { tag: "dup2", durationMs: 1200 });
    const [r3, r4] = await Promise.all([third.done, fourth.done]);
    assert.equal(r3.code, 0);
    assert.equal(r4.code, 0);
    assert.equal(startCount(ctx.log, "dup2"), 2, "输入变化后必须各自执行，不得复用旧结果");
    assert.doesNotMatch(r4.stderr, /附加/, "输入不同不得被判为等价");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 7. 轻量并行

test("验收7：重型运行期间轻量任务可并行；内存不足时轻量也要等", async () => {
  const ctx = setup();
  try {
    const heavy = runFake(ctx, { tag: "big", durationMs: 5000, taskClass: "heavy" });
    await waitFor(() => findTask(ctx, (t) => t.status === "running" && t.command?.[2] === "big"), { what: "重型任务运行" });

    const light = runFake(ctx, { tag: "small", durationMs: 900, taskClass: "light" });
    const rs = await light.done;
    assert.equal(rs.code, 0, `轻量任务应能并行执行：${rs.stderr}`);

    // 内存回落到轻量门槛以下：新的轻量任务必须等待
    setSimAvail(ctx, 2000);
    const blockedLight = runFake(ctx, { tag: "small2", durationMs: 500, taskClass: "light" });
    const waiting = await waitFor(() => {
      const t = findTask(ctx, (x) => x.command?.[2] === "small2");
      // 同验收3：必须先等到首轮评估写入 waitReason，否则读到的是未评估的 queued 快照
      return t && t.status !== "running" && t.waitReason ? t : null;
    }, { what: "轻量任务进入等待（含等待原因）" });
    assert.equal(startCount(ctx.log, "small2"), 0, "⛔ 内存不足时轻量任务不应启动");
    assert.match(String(waiting.waitReason ?? ""), /2\.50 GB/);
    setSimAvail(ctx, 9000);
    const rb = await blockedLight.done;
    assert.equal(rb.code, 0, `内存恢复后轻量任务应继续执行：${rb.stderr.slice(-300)}`);

    // 等重型任务自然结束后再看区间（重型还在跑时日志里只有 start 行）
    const rh = await heavy.done;
    assert.equal(rh.code, 0, `重型任务应正常完成：${rh.stderr.slice(-300)}`);

    const iv = intervals(ctx.log);
    const big = iv.find((x) => x.tag === "big");
    const small = iv.find((x) => x.tag === "small");
    assert.ok(big && small, `两个任务都应执行：log=${readFileSync(ctx.log, "utf8").trim()} light.stderr=${rs.stderr.slice(-300)}`);
    assert.ok(small.start >= big.start && small.end <= big.end,
      "轻量任务应在重型任务运行期间完成（资源充足时允许并行）");
    assert.equal(maxOverlap(iv), 2, "重型 + 轻量应同时存在");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 8. 公平性

test("验收8：高优先级持续涌入时，低优先级任务不会无限期饥饿", async () => {
  const ctx = setup();
  try {
    // 缩短老化周期，让「几秒」等价于「几分钟」的排队老化；轻量槽位只留 1 个，制造真正排队
    const agingEnv = { TASKDOCK_SCHED_AGING_STEP_MS: "1200", TASKDOCK_SCHED_LIGHT_CONCURRENCY: "1" };

    // 先用一个长任务占住唯一的轻量槽位，否则 P3 会立刻拿到槽位、根本进不了队列
    const blocker = runFake(ctx, { tag: "blocker", durationMs: 6000, taskClass: "light", priority: "P1", envExtra: agingEnv });
    await waitFor(() => findTask(ctx, (t) => t.status === "running" && t.command?.[2] === "blocker"), { what: "占位任务运行" });

    const low = runFake(ctx, { tag: "p3", durationMs: 500, taskClass: "light", priority: "P3", envExtra: agingEnv });
    await waitFor(() => {
      const t = findTask(ctx, (x) => x.command?.[2] === "p3");
      return t && t.status !== "running" ? t : null;
    }, { what: "P3 进入排队" });
    await new Promise((r) => setTimeout(r, 400));

    // 持续提交 P0，抢同一个轻量槽位
    const p0Runs = [];
    for (let i = 0; i < 3; i++) {
      p0Runs.push(runFake(ctx, { tag: `p0-${i}`, durationMs: 500, taskClass: "light", priority: "P0", envExtra: agingEnv }));
      await new Promise((r) => setTimeout(r, 300));
    }

    const res = await low.done;
    assert.equal(res.code, 0, `P3 任务最终必须执行：${res.stderr.slice(-300)}`);
    const p0Results = await Promise.all(p0Runs.map((r) => r.done));
    for (const r of p0Results) assert.equal(r.code, 0, `P0 任务应正常完成：${r.stderr.slice(-200)}`);
    await blocker.done;

    const iv = intervals(ctx.log);
    const p3 = iv.find((x) => x.tag === "p3");
    assert.ok(p3, "P3 任务必须被执行");
    const p0s = iv.filter((x) => x.tag.startsWith("p0-"));
    assert.ok(p0s.length >= 1, "前置条件：P0 任务已执行");
    // 老化生效：P3 应在仍未完成的 P0 之前插队，而不是等所有 P0 全跑完
    assert.ok(p3.start < Math.max(...p0s.map((x) => x.end)),
      "P3 在持续 P0 涌入时被饿死（老化未生效）");
    assert.ok(p0s.some((x) => x.start > p3.start),
      "P3 之后仍有 P0 在执行，说明 P3 是插队执行而非空队列捡漏");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 9. 原有工具链兼容

test("验收9：原有工具链经调度器执行仍然正常（build-guard / npm 脚本 / 队列查询）", async () => {
  const ctx = setup();
  try {
    // 真实既有工具：build-guard precheck（磁盘/缓存守卫）
    const guard = spawnSync(process.execPath, [
      SCHED, "run", "--class", "light", "--", process.execPath, join(REPO, "scripts", "build-guard.mjs"), "precheck",
    ], { cwd: REPO, env: baseEnv(ctx), encoding: "utf8", timeout: 90000, windowsHide: true });
    assert.equal(guard.status, 0, `既有 build-guard 经调度器执行失败：${guard.stderr?.slice(-400)}`);
    assert.match(guard.stdout + guard.stderr, /precheck/);

    // npm 脚本入口经过调度器后仍返回 npm 的真实退出码
    const npm = spawnSync(process.execPath, [SCHED, "run", "--", "npm", "run", "--silent", "sched:queue"], {
      cwd: REPO, env: baseEnv(ctx), encoding: "utf8", timeout: 90000, windowsHide: true,
    });
    assert.equal(npm.status, 0, `npm 脚本经调度器执行失败：${npm.stderr?.slice(-400)}`);
    assert.match(npm.stdout, /队列|任务ID|任务/, "npm 输出应被正常转发");

    // 调度层失败必须与代码错误区分：不存在的命令不得报 success
    const missing = spawnSync(process.execPath, [SCHED, "run", "--", "definitely-not-a-command-xyz"], {
      cwd: REPO, env: baseEnv(ctx), encoding: "utf8", timeout: 60000, windowsHide: true,
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /sched: exit=.*status=failed/);
  } finally { cleanup(ctx); }
});

// ------------------------------------------------- 补充A. 嵌套调度（tauri beforeBuildCommand）

test("补充A：嵌套调度不自锁（tauri build → beforeBuildCommand `npm run build` 场景）", async () => {  // 外层与外层**同分类**：若内层没有直通而是去排队，它等的正是自己父进程持有的槽位，
  // 会一直挂到超时（甚至永久）——这就是必须验证的真实风险，而不是理论问题。
  const ctx = setup();
  try {
    const innerArgv = [
      process.execPath, SCHED, "run", "--class", "heavy", "--label", "nested-inner", "--",
      process.execPath, ctx.fake, "nested",
    ];
    const outer = spawnSync(
      process.execPath,
      [SCHED, "run", "--class", "heavy", "--label", "nested-outer", "--", ...innerArgv],
      {
        cwd: ctx.wsA,
        env: baseEnv(ctx, { FAKE_LOG: ctx.log, FAKE_DURATION_MS: "800", FAKE_EXIT: "0" }),
        encoding: "utf8", timeout: 45000, windowsHide: true,
      },
    );
    assert.equal(outer.status, 0, `嵌套调度未自锁但返回值异常（45s 内未完成视为自锁）：${(outer.stderr ?? "").slice(-600)}`);
    assert.match(outer.stderr, /嵌套/, "内层应明确提示为直通执行");
    assert.equal(startCount(ctx.log, "nested"), 1, "内层命令应执行恰好一次");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 10. 等待超时层级

test("验收10：资源等待超时记为调度层失败（exit 3），不被误判为编译错误，子进程未启动", async () => {
  const ctx = setup();
  try {
    // 模拟可用内存低于轻量门槛（2560MB），任务始终无法准入；--wait-timeout 0.1 分钟 ≈ 6s 超时
    setSimAvail(ctx, 300);
    const run = runFake(ctx, {
      tag: "wait-timeout", taskClass: "light", durationMs: 500,
      extraArgs: ["--wait-timeout", "0.1"],
    });
    const res = await run.done;

    assert.equal(res.code, 3, "等待资源超时必须返回调度层退出码 3，而不是子进程编译失败码");
    assert.match(res.stderr, /等待资源超时/, "失败原因必须明确是等待资源超时");
    assert.match(res.stderr, /sched: exit=3\b.*status=failed/, "日志尾行必须标注调度层状态 failed");
    assert.equal(startCount(ctx.log, "wait-timeout"), 0, "⛔ 未准入任务不应启动子进程");

    const rec = findTask(ctx, (t) => t.command?.[2] === "wait-timeout");
    assert.ok(rec, "记录应落盘");
    assert.equal(rec.status, "failed");
    assert.equal(rec.exitCode, 3);
    assert.match(String(rec.finishReason ?? ""), /等待资源超时/);
    assert.equal(rec.child, null, "未启动的任务不得登记子进程");

    const history = readHistory(ctx);
    const entry = history.find((e) => e.command?.[2] === "wait-timeout");
    assert.ok(entry, "历史里必须有该任务记录");
    assert.equal(entry.status, "failed");
    assert.equal(entry.exitCode, 3);
    assert.match(String(entry.reason ?? ""), /等待资源超时/);
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 12. 跨分类全局预算
//
// 整改前：准入只看「本分类槽位 + 本任务自己的内存门槛」，不同分类各自读同一份 freemem 快照
// 各自放行 → 合计超卖。以下用例用**模拟内存**制造"预算只够一个"的极端组合（绝不真实压满内存）。

const TOTAL_MB_REAL = Math.round(totalmem() / (1024 * 1024));

/** 让调度进程的全局预算恰好等于 targetMb（通过"物理总量 - 目标预算"反推系统保留）。 */
function budgetEnv(targetMb, extra = {}) {
  return { TASKDOCK_SCHED_SYSTEM_RESERVE_MB: String(TOTAL_MB_REAL - targetMb), ...extra };
}

function reservationsOf(ctx) {
  const dir = join(ctx.home, "reservations");
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => { try { return JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** 造一条"崩溃残留"预留：和一个真实崩溃留下的文件完全同构。 */
function writeResidue(ctx, entry) {
  const dir = join(ctx.home, "reservations");
  mkdirSync(dir, { recursive: true });
  const full = {
    taskId: entry.taskId,
    taskClass: entry.taskClass ?? "heavy",
    reservedMb: entry.reservedMb,
    label: "crashed-residue",
    ownerPid: entry.ownerPid,
    ownerStartTime: entry.ownerStartTime ?? new Date().toISOString(),
    ownerStartTimeSource: "uptime",
    nonce: "residue",
    childPid: entry.childPid ?? null,
    childCmdSignature: entry.childCmdSignature ?? null,
    childCmdLine: entry.childCmdLine ?? null,
    detached: entry.detached === true,
    phase: entry.phase ?? "starting",
    createdAt: entry.createdAt ?? new Date(Date.now() - 600000).toISOString(),
    heartbeatAt: entry.heartbeatAt ?? new Date(Date.now() - 300000).toISOString(),
  };
  writeFileSync(join(dir, `${full.taskId}.json`), JSON.stringify(full, null, 2));
  return full;
}

/** 一个确定已退出的 PID：拿它当"崩溃掉的调度进程"。 */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 15000, windowsHide: true });
  return r.pid;
}

/**
 * 复核"有没有超卖"的硬证据：每个真正启动过的任务都记录了它**准入那一刻**的
 * （预算上限 / 已预留 / 本次预计），三者必须始终满足 `reserved + estimate <= budget`。
 */
function assertBudgetInvariant(ctx, expectedBudgetMb, label = "") {
  const rows = readHistory(ctx).filter((e) => e.budgetAtStart);
  assert.ok(rows.length > 0, `${label}历史里必须有预算证据（budgetAtStart）`);
  for (const e of rows) {
    const b = e.budgetAtStart;
    assert.ok(b.budgetMb >= expectedBudgetMb - 1 && b.budgetMb <= expectedBudgetMb + 1,
      `${label}预算上限应为 ${expectedBudgetMb}，实际 ${b.budgetMb}（${e.id}）`);
    assert.ok(b.reservedMb + b.estimateMb <= b.budgetMb,
      `${label}⛔ 超卖：任务 ${e.id} 准入时已预留 ${b.reservedMb} + 本次 ${b.estimateMb} > 预算 ${b.budgetMb}`);
  }
  // 收尾后台账必须清空：任何残留都意味着预算泄漏
  assert.equal(reservationsOf(ctx).length, 0, `${label}任务结束后预留台账必须清空`);
}

test("预算1：Heavy 与 Medium 同时申请，预算只够一个时不并行", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000); // 两者都能过"实时可用内存"门槛（heavy 6144 / medium 4096）
    const env = budgetEnv(8900); // 6000 + 3000 = 9000 > 8900
    const heavy = runFake(ctx, { tag: "b1-heavy", taskClass: "heavy", durationMs: 1200, envExtra: env });
    const medium = runFake(ctx, { tag: "b1-medium", taskClass: "medium", durationMs: 1200, envExtra: env });
    const [rh, rm] = await Promise.all([heavy.done, medium.done]);
    assert.equal(rh.code, 0, `heavy 应成功：${rh.stderr}`);
    assert.equal(rm.code, 0, `medium 应成功：${rm.stderr}`);
    assert.equal(maxOverlap(intervals(ctx.log)), 1, "⛔ 预算只够一个却发生了并行 = 超卖");
    assertBudgetInvariant(ctx, 8900, "预算1 ");
  } finally { cleanup(ctx); }
});

test("预算2：Heavy + 两个 Dev 同时申请（6000+3000+3000 > 9000）", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    const env = budgetEnv(9000);
    const runs = [
      runFake(ctx, { tag: "b2-heavy", taskClass: "heavy", durationMs: 1200, envExtra: env }),
      runFake(ctx, { tag: "b2-dev1", taskClass: "dev", durationMs: 1200, envExtra: env }),
      runFake(ctx, { tag: "b2-dev2", taskClass: "dev", durationMs: 1200, envExtra: env }),
    ];
    const results = await Promise.all(runs.map((r) => r.done));
    for (const r of results) assert.equal(r.code, 0, `任务应成功：${r.stderr}`);
    assertBudgetInvariant(ctx, 9000, "预算2 ");
    const iv = intervals(ctx.log);
    assert.equal(iv.length, 3, "三个任务都应真正执行过");
  } finally { cleanup(ctx); }
});

test("预算3：Medium + 两个 Light（3000+800+800 > 3800）", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    // 把重型预计峰值调小，只为让 3800MB 预算能容纳三个任务；预算本身严格等于 3800（不再被夹取抬高）
    const env = budgetEnv(3800, { TASKDOCK_SCHED_ESTIMATE_HEAVY_MB: "3000" });
    const runs = [
      runFake(ctx, { tag: "b3-medium", taskClass: "medium", durationMs: 1200, envExtra: env }),
      runFake(ctx, { tag: "b3-light1", taskClass: "light", durationMs: 1200, envExtra: env }),
      runFake(ctx, { tag: "b3-light2", taskClass: "light", durationMs: 1200, envExtra: env }),
    ];
    const results = await Promise.all(runs.map((r) => r.done));
    for (const r of results) assert.equal(r.code, 0, `任务应成功：${r.stderr}`);
    assertBudgetInvariant(ctx, 3800, "预算3 ");
    assert.ok(maxOverlap(intervals(ctx.log)) <= 2, "3800MB 预算下最多只能有 3000+800 两个任务并行");
  } finally { cleanup(ctx); }
});

test("预算4：两个不同 Worktree 同时申请，共享同一份全局预算", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    const env = budgetEnv(8900);
    const a = runFake(ctx, { tag: "b4-wt-a", taskClass: "heavy", durationMs: 1200, cwd: ctx.wsA, envExtra: env });
    const b = runFake(ctx, { tag: "b4-wt-b", taskClass: "medium", durationMs: 1200, cwd: ctx.wsB, envExtra: env });
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0); assert.equal(rb.code, 0);
    assert.equal(maxOverlap(intervals(ctx.log)), 1, "⛔ 不同 Worktree 各自放行导致超卖");
    assertBudgetInvariant(ctx, 8900, "预算4 ");
  } finally { cleanup(ctx); }
});

test("预算5：三个不同分类同时提交，合计超过预算时不并行超卖", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    const env = budgetEnv(6900); // heavy 6000 + light 800 = 6800 ≤ 6900；再加 medium 3000 → 9800 > 6900
    const runs = [
      runFake(ctx, { tag: "b5-heavy", taskClass: "heavy", durationMs: 1000, envExtra: env }),
      runFake(ctx, { tag: "b5-medium", taskClass: "medium", durationMs: 1000, envExtra: env }),
      runFake(ctx, { tag: "b5-light", taskClass: "light", durationMs: 1000, envExtra: env }),
    ];
    const results = await Promise.all(runs.map((r) => r.done));
    for (const r of results) assert.equal(r.code, 0, `任务应成功：${r.stderr}`);
    assertBudgetInvariant(ctx, 6900, "预算5 ");
  } finally { cleanup(ctx); }
});

test("预算6：崩溃残留预留（崩在 spawn 之前）——宽限期内挡人，宽限后安全回收", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 9000);
    const env = budgetEnv(6000, {
      TASKDOCK_SCHED_RECLAIM_PROBE_MS: "400",
      TASKDOCK_SCHED_RESERVATION_ORPHAN_GRACE_MS: "2500",
    });
    // 一个"刚崩溃、还没来得及登记子进程"的重型任务：占满 6000MB 预算
    writeResidue(ctx, { taskId: "h-crash-before-spawn", reservedMb: 6000, ownerPid: deadPid(), detached: false });

    const run = runFake(ctx, { tag: "b6-light", taskClass: "light", durationMs: 500, envExtra: env });
    // 宽限期内：必须挡在等待里，且不得动残留（否则无法证明旧构建没在跑）
    await waitFor(() => {
      const rec = findTask(ctx, (t) => t.command?.[2] === "b6-light");
      return rec && rec.status === "waiting_resources" ? rec : null;
    }, { timeoutMs: 2000, what: "任务进入 waiting_resources" });
    assert.match(
      String(findTask(ctx, (t) => t.command?.[2] === "b6-light")?.waitReason ?? ""),
      /全局构建预算不足|准入临界区/,
      "必须明确写出是全局预算不足，而不是含糊的等待",
    );
    assert.equal(reservationsOf(ctx).length, 1, "宽限期内不得回收崩溃残留");

    const res = await run.done;
    assert.equal(res.code, 0, `宽限到期后应自动回收并执行：${res.stderr}`);
    assert.equal(reservationsOf(ctx).length, 0, "任务结束后台账必须清空");
    assertBudgetInvariant(ctx, 6000, "预算6 ");
  } finally { cleanup(ctx); }
});

test("预算7：detached 孤儿预留 fail-closed——不会自动回收，任务明确等待超时", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 9000);
    const env = budgetEnv(6000, { TASKDOCK_SCHED_RECLAIM_PROBE_MS: "400", TASKDOCK_SCHED_RESERVATION_ORPHAN_GRACE_MS: "500" });
    writeResidue(ctx, {
      taskId: "h-detached-orphan", reservedMb: 6000, ownerPid: deadPid(),
      detached: true, heartbeatAt: new Date(Date.now() - 300000).toISOString(),
    });
    const res = await runFake(ctx, {
      tag: "b7-light", taskClass: "light", durationMs: 300, envExtra: env,
      extraArgs: ["--wait-timeout", "0.05"],
    }).done;
    assert.equal(res.code, 3, "资源等待超时必须记调度层退出码 3");
    assert.match(String(res.stderr), /全局构建预算不足/, "失败原因必须指向全局预算");
    assert.equal(reservationsOf(ctx).length, 1, "⛔ detached 孤儿不得被自动回收（无法证明它已退出）");
    assert.ok(startCount(ctx.log, "b7-light") === 0, "被预算挡住的任务绝不能真的启动子进程");
  } finally { cleanup(ctx); }
});

test("预算8：持有者已死但旧构建子进程仍存活——拒绝回收，子进程结束后才回收", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 9000);
    const env = budgetEnv(6000, { TASKDOCK_SCHED_RECLAIM_PROBE_MS: "400", TASKDOCK_SCHED_RESERVATION_ORPHAN_GRACE_MS: "500" });
    const liveChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    liveChild.unref();
    try {
      writeResidue(ctx, {
        taskId: "h-orphan-with-child", reservedMb: 6000, ownerPid: deadPid(),
        childPid: liveChild.pid, childCmdLine: "node -e setTimeout", detached: false,
      });

      const first = await runFake(ctx, {
        tag: "b8-light-1", taskClass: "light", durationMs: 300, envExtra: env,
        extraArgs: ["--wait-timeout", "0.05"],
      }).done;
      assert.equal(first.code, 3, "旧构建还在跑时必须等待超时，不得放行新构建");
      assert.equal(reservationsOf(ctx).length, 1, "⛔ 子进程仍存活时不得回收预留");
      assert.equal(startCount(ctx.log, "b8-light-1"), 0, "新构建绝不能启动");

      killOnly(liveChild.pid);
      await waitFor(() => !isAlive(liveChild.pid), { timeoutMs: 5000, what: "旧构建子进程退出" });

      const second = await runFake(ctx, {
        tag: "b8-light-2", taskClass: "light", durationMs: 300, envExtra: env,
        extraArgs: ["--wait-timeout", "0.5"],
      }).done;
      assert.equal(second.code, 0, `旧构建结束后应回收并执行：${second.stderr}`);
      assert.equal(reservationsOf(ctx).length, 0, "回收后台账必须清空");
    } finally {
      if (isAlive(liveChild.pid)) killOnly(liveChild.pid);
    }
  } finally { cleanup(ctx); }
});

test("预算9：取消与超时都不得漏账（预留必须归还）", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    const env = budgetEnv(9000);

    // (a) 运行中取消
    const run = runFake(ctx, { tag: "b9-cancel", taskClass: "light", durationMs: 4000, envExtra: env });
    const id = await waitFor(() => {
      const rec = findTask(ctx, (t) => t.command?.[2] === "b9-cancel" && t.status === "running");
      return rec ? rec.id : null;
    }, { timeoutMs: 10000, what: "任务进入 running" });
    assert.equal(reservationsOf(ctx).length, 1, "运行中必须有且只有一条预留");
    const cancel = schedCli(ctx, ["cancel", id, "--wait", "5"]);
    assert.equal(cancel.status, 0, `cancel 应返回 0：${cancel.stdout}${cancel.stderr}`);
    const res = await run.done;
    assert.equal(res.code, 4, "取消必须返回调度层退出码 4");
    assert.equal(reservationsOf(ctx).length, 0, "⛔ 取消后预留没有归还（预算泄漏）");

    // (b) 内存不足导致的等待超时
    setSimAvail(ctx, 1000);
    const timeout = await runFake(ctx, {
      tag: "b9-timeout", taskClass: "light", durationMs: 200, envExtra: budgetEnv(9000),
      extraArgs: ["--wait-timeout", "0.05"],
    }).done;
    assert.equal(timeout.code, 3);
    assert.equal(reservationsOf(ctx).length, 0, "从未启动的任务不得留下预留");
  } finally { cleanup(ctx); }
});

test("预算10：Dev 长期运行时普通构建申请资源（6000+6000 超过预算，必须排队）", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    const env = budgetEnv(6000);
    const dev = runFake(ctx, { tag: "b10-dev", taskClass: "dev", durationMs: 2600, envExtra: env });
    await waitFor(() => findTask(ctx, (t) => t.command?.[2] === "b10-dev" && t.status === "running"),
      { timeoutMs: 10000, what: "dev 任务开始运行" });
    const heavy = runFake(ctx, { tag: "b10-heavy", taskClass: "heavy", durationMs: 800, envExtra: env });
    const [rd, rh] = await Promise.all([dev.done, heavy.done]);
    assert.equal(rd.code, 0); assert.equal(rh.code, 0, `heavy 应在 dev 结束后执行：${rh.stderr}`);
    const devIv = intervals(ctx.log).filter((i) => i.tag === "b10-dev");
    const heavyIv = intervals(ctx.log).filter((i) => i.tag === "b10-heavy");
    assert.equal(devIv.length, 1); assert.equal(heavyIv.length, 1);
    assert.ok(heavyIv[0].start >= devIv[0].end,
      "⛔ dev 常驻（3000）+ heavy（6000）合计超过 6000 预算却并行了");
  } finally { cleanup(ctx); }
});

test("预算11：多进程争最后一份预算（槽位允许 2 个并发，预算只够 1 个）", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 9000);
    // 三个分类的预计峰值都调成 800，预算 800 → 只有 1 个能跑（light 槽位本来有 2 个）
    const env = budgetEnv(800, {
      TASKDOCK_SCHED_ESTIMATE_HEAVY_MB: "800",
      TASKDOCK_SCHED_ESTIMATE_MEDIUM_MB: "800",
    });
    const runs = ["b11-l1", "b11-l2", "b11-l3"].map((tag) =>
      runFake(ctx, { tag, taskClass: "light", durationMs: 1000, envExtra: env }));
    const results = await Promise.all(runs.map((r) => r.done));
    for (const r of results) assert.equal(r.code, 0, `任务应成功：${r.stderr}`);
    assert.equal(maxOverlap(intervals(ctx.log)), 1,
      "⛔ 预算只够 1 个，却有 2 个轻量任务同时跑（槽位不是唯一闸门）");
    assertBudgetInvariant(ctx, 800, "预算11 ");
  } finally { cleanup(ctx); }
});

test("预算12：内存降到危险区时排队，恢复后自动继续（不留预算残留）", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 1000); // 低于轻量门槛 2560 → 约束 A 挡住
    const run = runFake(ctx, { tag: "b12-light", taskClass: "light", durationMs: 400, envExtra: budgetEnv(9000) });
    await waitFor(() => {
      const rec = findTask(ctx, (t) => t.command?.[2] === "b12-light");
      return rec && rec.status === "waiting_resources" ? rec : null;
    }, { timeoutMs: 3000, what: "内存不足时进入 waiting_resources" });
    assert.match(String(findTask(ctx, (t) => t.command?.[2] === "b12-light")?.waitReason ?? ""), /内存/);
    assert.equal(reservationsOf(ctx).length, 0, "内存不足时不得先把预算占住");

    setSimAvail(ctx, 9000);
    const res = await run.done;
    assert.equal(res.code, 0, `内存恢复后应自动继续：${res.stderr}`);
    assert.equal(reservationsOf(ctx).length, 0, "任务结束后台账必须清空");
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 11. 子进程失败原因可查询

test("验收11：子进程非零退出后，队列记录与历史都能查到明确失败原因与日志路径", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 9000);
    const run = runFake(ctx, { tag: "fail-code", taskClass: "light", durationMs: 200, exitCode: 7 });
    const res = await run.done;

    assert.equal(res.code, 7, "子进程退出码必须原样透传");
    const rec = findTask(ctx, (t) => t.command?.[2] === "fail-code");
    assert.ok(rec, "记录应落盘");
    assert.equal(rec.status, "failed");
    assert.equal(rec.exitCode, 7);
    assert.match(String(rec.finishReason ?? ""), /子进程退出码 7/, "失败原因必须写明退出码");
    assert.ok(rec.logPath, "必须带回日志相对路径");
    const logAbs = join(ctx.home, rec.logPath);
    assert.ok(existsSync(logAbs), "日志文件必须存在");

    const history = readHistory(ctx);
    const entry = history.find((e) => e.command?.[2] === "fail-code");
    assert.ok(entry, "历史里必须有该任务记录");
    assert.equal(entry.status, "failed");
    assert.equal(entry.exitCode, 7);
    assert.match(String(entry.reason ?? ""), /子进程退出码 7/);
  } finally { cleanup(ctx); }
});

// ------------------------------------------------- 补充B. 预算夹取策略修正（2026-11-15 第二轮）
//
// 复现本轮 P0 缺陷：旧公式 `max(totalMb - systemReserveMb, 最大分类预计峰值)` 会在小内存机器上把预算
// 抬高到 Heavy 峰值（8GB / 3GB 保留 → 5120MB 预算被抬到 6000MB），静默侵占系统保留的安全边界。
// 现在预算严格等于 `total - 保留`，装不下的任务明确判为不可准入；突破只能是显式开关。
// 注意：这里用 `budgetEnv(5120)` 模拟"预算只有 5120MB"的机器（真实 totalMb 仍是 15.63GB，
// 通过把 systemReserveMb 调到 9.98GB 达成），设备档位对应的真实算式在
// scripts/build-sched.test.mjs 的「4/8/16/32GB 档位判定表」里逐个断言。

test("补充B1：预算 5120MB 下 Heavy（预计 6000MB）判为不可准入——不排队等待、不启动子进程、原因明确", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000); // 约束 A 完全充足（heavy 门槛 6144），唯一挡它的是预算
    const env = budgetEnv(5120);
    const res = await runFake(ctx, {
      tag: "b13-heavy-infeasible", taskClass: "heavy", durationMs: 300,
      envExtra: env, extraArgs: ["--wait-timeout", "0.05"],
    }).done;

    assert.equal(res.code, 3, "装不下的任务最终是调度层等待超时（3），不是编译失败码");
    assert.match(String(res.stderr), /本机装不下/, "失败原因必须直说本机装不下");
    assert.match(String(res.stderr), /系统保留 .*不会自我放行/);
    assert.match(String(res.stderr), /不是排队问题/, "必须明确区别于普通排队");
    assert.equal(startCount(ctx.log, "b13-heavy-infeasible"), 0, "⛔ 不可准入的任务绝不能启动子进程");
    assert.equal(reservationsOf(ctx).length, 0, "被预算拒绝的任务不得留下预留");

    const rec = findTask(ctx, (t) => t.command?.[2] === "b13-heavy-infeasible");
    assert.ok(rec, "队列记录应落盘");
    assert.match(String(rec.finishReason ?? ""), /本机装不下/);
    const hist = readHistory(ctx).find((e) => e.command?.[2] === "b13-heavy-infeasible");
    assert.ok(hist, "历史里必须有该任务记录");
    assert.equal(hist.budgetAtStart, null, "从未准入的任务不得写入 budgetAtStart 证据");

    // status 必须把"预算装不下最大分类峰值"这件事显式打出来，而不是只显示一个很小的预算数字
    const st = spawnSync(process.execPath, [SCHED, "status"], {
      cwd: ctx.wsA, env: baseEnv(ctx, env), encoding: "utf8", timeout: 60000, windowsHide: true,
    });
    assert.equal(st.status, 0, `status 应正常退出：${st.stderr}`);
    assert.match(st.stdout, /硬上限 = 物理 .* - 系统保留 .* = 5\.00 GB/, "status 必须展示硬上限的推导");
    assert.match(st.stdout, /小于最大分类预计峰值 5\.86 GB/, "status 必须提示预算装不下重型任务");
    assert.match(st.stdout, /无法准入/, "提示必须给出结论：该类任务无法准入");
  } finally { cleanup(ctx); }
});

test("补充B2：同一预算下显式开启 allowReserveBreach 才能让 Heavy 准入，且必须留下「已突破保留边界」证据", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    const env = budgetEnv(5120, { TASKDOCK_SCHED_ALLOW_RESERVE_BREACH: "true" });
    const res = await runFake(ctx, {
      tag: "b14-heavy-breach", taskClass: "heavy", durationMs: 800, envExtra: env,
      extraArgs: ["--wait-timeout", "0.3"],
    }).done;
    assert.equal(res.code, 0, `显式突破保留边界后应能执行：${res.stderr}`);
    assert.equal(startCount(ctx.log, "b14-heavy-breach"), 1);

    const hist = readHistory(ctx).find((e) => e.command?.[2] === "b14-heavy-breach");
    assert.ok(hist?.budgetAtStart, "准入证据必须落盘");
    assert.equal(hist.budgetAtStart.budgetMb, 6000, "突破时预算被抬到最大分类峰值 6000MB");
    assert.equal(hist.budgetAtStart.hardLimitMb, 5120, "硬上限仍是 5120MB（物理-保留），证据里必须区分");
    assert.equal(hist.budgetAtStart.reserveBreached, true, "⛔ 突破保留边界这件事必须可事后复核");
    assert.equal(reservationsOf(ctx).length, 0, "任务结束后台账必须清空");

    // status 必须显著告警（这是"危险开关"的唯一可见性来源）
    const st = spawnSync(process.execPath, [SCHED, "status"], {
      cwd: ctx.wsA, env: baseEnv(ctx, env), encoding: "utf8", timeout: 60000, windowsHide: true,
    });
    assert.equal(st.status, 0);
    assert.match(st.stdout, /已显式开启 allowReserveBreach/);
    assert.match(st.stdout, /安全垫已被侵占/);
  } finally { cleanup(ctx); }
});

test("补充B3：预算 5120MB 下 heavy(3000)+medium(2400) 合计 5400 超预算——不并行超卖，light 仍能跑", async () => {
  const ctx = setup();
  try {
    setSimAvail(ctx, 12000);
    const env = budgetEnv(5120, {
      TASKDOCK_SCHED_ESTIMATE_HEAVY_MB: "3000",
      TASKDOCK_SCHED_ESTIMATE_MEDIUM_MB: "2400",
    });
    const runs = [
      runFake(ctx, { tag: "b15-heavy", taskClass: "heavy", durationMs: 1000, envExtra: env }),
      runFake(ctx, { tag: "b15-medium", taskClass: "medium", durationMs: 1000, envExtra: env }),
      runFake(ctx, { tag: "b15-light1", taskClass: "light", durationMs: 600, envExtra: env }),
      runFake(ctx, { tag: "b15-light2", taskClass: "light", durationMs: 600, envExtra: env }),
    ];
    const results = await Promise.all(runs.map((r) => r.done));
    for (const r of results) assert.equal(r.code, 0, `任务应成功：${r.stderr}`);
    const iv = intervals(ctx.log);
    assert.equal(iv.length, 4, "四个任务都应真正执行过");
    const heavyIv = iv.find((i) => i.tag === "b15-heavy");
    const medIv = iv.find((i) => i.tag === "b15-medium");
    assert.ok(heavyIv && medIv, "两种分类都应留下执行区间");
    assert.ok(heavyIv.end <= medIv.start || medIv.end <= heavyIv.start,
      "⛔ 3000+2400=5400 > 5120 预算，heavy 与 medium 不得并行");
    assert.ok(maxOverlap(iv) <= 3, "预算只允许 heavy/medium 之一 + 两个 light 并行");
    assertBudgetInvariant(ctx, 5120, "补充B3 ");
  } finally { cleanup(ctx); }
});

// ------------------------------------------------- 补充C. 构建入口全覆盖（零资源静态闸门）
//
// 本轮 P0 之三：`apps/mobile/package.json` 的 build 脚本曾是 `cd android && gradlew.bat assembleRelease`，
// 可以完全绕过统一调度器（直接 Gradle 会把 16GB 机器打到 OOM，且不占重型槽位、不计预算）。
// 这里把"哪个入口必须经调度器、哪个是显式逃生口"写成可执行断言：
//   - 高资源入口的脚本体必须包含 `scripts/build-sched.mjs run`；
//   - 每个被包装的入口都必须有一个 `:raw` 逃生口（排障用，不得作为日常推荐命令）；
//   - 不允许同一个脚手架里出现两层 `build-sched.mjs run`（那会双重排队/自锁）；
//   - 被包装的原始命令仍然按预期分类（heavy/medium/dev），分类表不被脚本改动破坏。
// 全部是读文件 + 纯函数分类，不启动任何真实构建。

const ROOT_PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const MOBILE_PKG = JSON.parse(readFileSync(join(REPO, "apps", "mobile", "package.json"), "utf8"));
const SCHED_TOKEN = "scripts/build-sched.mjs run";

/** 必须经调度器的入口：[package.json 所在目录描述, 脚本名, 期望分类, 对应 raw 逃生口, raw 的附加实参] */
const MUST_ROUTE = [
  ["root", "build", "medium", "build:raw", []],
  ["root", "test", "medium", "test:raw", []],
  // `npm run tauri -- build` 才是真实发布构建入口（裸 `npm run tauri` 只会打印 tauri 用法）
  ["root", "tauri", "heavy", "tauri:raw", ["build"]],
  ["apps/mobile", "start", "dev", "start:raw", []],
  ["apps/mobile", "android", "heavy", "android:raw", []],
  ["apps/mobile", "prebuild", "heavy", "prebuild:raw", []],
  ["apps/mobile", "typecheck", "medium", "typecheck:raw", []],
  ["apps/mobile", "test", "medium", "test:raw", []],
  ["apps/mobile", "build:android", "heavy", "build:android:raw", []],
];

/**
 * 明确允许直接执行（不进队列）的入口，每条都写清理由。
 * 原则：只有「只读/轻量工具」「常驻 dev 服务」「交互式 watch」「调度器自身 CLI」可以豁免。
 */
const DIRECT_ALLOWED = new Map([
  ["dev", "dev 类长期服务（vite），未纳管实例由约束 A + `sched dev` 盘点，见 BUILD_SCHEDULER.md 12.8"],
  ["preview", "dev 类预览服务，同上"],
  ["test:watch", "交互式 watch：长期运行、人工 Ctrl+C 结束，进队列反而会长期占槽"],
  ["test:scripts", "只读 node --test 单测（light），不产生构建产物"],
  ["help:check", "局部 vitest 用例（light）"],
  ["icons", "node 脚本生成静态图标资源（light）"],
  ["pretauri", "npm 生命周期钩子：tauri 前跑 build-guard precheck（light）"],
  ["guard:precheck", "build-guard 只读磁盘/缓存预检（light）"],
  ["guard:report", "build-guard 只读报告（light）"],
  ["guard:register", "build-guard 台账登记（light）"],
  ["guard:cleanup", "build-guard 缓存清理（light，需授权）"],
  ["worktree", "worktree-guard：只读/受控的 git 元数据操作（light）"],
  ["worktree:status", "同上"],
  ["worktree:create", "同上（创建隔离工作区，属于 git 操作而非编译）"],
  ["worktree:check", "同上"],
  ["worktree:cleanup", "同上（默认 dry-run）"],
  ["sched", "调度器自身 CLI：再经 run 派发会自锁"],
  ["sched:status", "同上（只读）"],
  ["sched:queue", "同上（只读）"],
  ["sched:history", "同上（只读）"],
  ["sched:doctor", "同上（默认只读）"],
  ["sched:config", "同上（只读）"],
  ["sched:cancel", "同上（只发取消标记）"],
  ["sched:dev", "同上（只盘点进程）"],
  ["sched:acceptance", "本套件自身入口：node --test 验收，不能自己调度自己"],
  ["cargo", "已是调度子命令（`node scripts/build-sched.mjs cargo`），自带排队与分类"],
  ["icons:generate", "node 脚本生成图标（light，手机端）"],
  ["icons:check", "node 脚本只读检查图标（light，手机端）"],
]);

function scriptsOf(pkgDir) {
  return pkgDir === "root" ? ROOT_PKG.scripts : MOBILE_PKG.scripts;
}

function pkgCwd(pkgDir) {
  return pkgDir === "root" ? REPO : join(REPO, "apps", "mobile");
}

test("补充C1：所有高资源构建入口都经统一调度器，且都有 :raw 排障逃生口", () => {
  for (const [pkg, name, expectedClass, rawName, rawArgs] of MUST_ROUTE) {
    const scripts = scriptsOf(pkg);
    const body = scripts[name];
    assert.ok(body, `${pkg} 缺少脚本 ${name}`);
    assert.ok(body.includes(SCHED_TOKEN), `${pkg} 的 ${name} 未接入调度器：${body}`);
    // 手机端入口必须带 --priority/--label（在 queue/status 里一眼能认出是哪一段构建）；
    // 根目录的 build/test/tauri 是上一轮已上线的写法（本轮按主 Agent 授权不改根 package.json），
    // 它们的标签由分类表给出，这里只要求"确实经调度器"。
    if (pkg !== "root") {
      assert.ok(body.includes("--priority"), `${pkg} 的 ${name} 应带 --priority：${body}`);
      assert.ok(body.includes("--label"), `${pkg} 的 ${name} 应带 --label，便于在 queue/status 里辨认`);
    }
    const raws = scripts[rawName];
    assert.ok(raws, `${pkg} 缺少排障逃生口 ${rawName}（不带派发最后一次机会）`);
    assert.ok(!raws.includes(SCHED_TOKEN), `${rawName} 必须是"不经调度器"的原始命令：${raws}`);
    const classified = classifyArgv(["npm", "run", rawName, ...rawArgs], { cwd: pkgCwd(pkg) });
    assert.equal(
      classified.taskClass, expectedClass,
      `${rawName} 的真实开销应分类为 ${expectedClass}（实际 ${classified.taskClass}/${classified.rule}：${classified.reason}）`,
    );
  }
});

test("补充C2：任何入口都不得双重排队（同一脚手架里只能有一层 build-sched run）", () => {
  const all = [
    ...Object.entries(ROOT_PKG.scripts).map(([k, v]) => ["root", k, v]),
    ...Object.entries(MOBILE_PKG.scripts).map(([k, v]) => ["apps/mobile", k, v]),
  ];
  for (const [pkg, name, body] of all) {
    const count = body.split(SCHED_TOKEN).length - 1;
    assert.ok(count <= 1, `${pkg} 的 ${name} 里出现了 ${count} 层调度器调用（会重复占槽/自锁）：${body}`);
    if (!body.includes(SCHED_TOKEN)) continue;
    // 被包装的命令必须接在 `--` 之后，否则调度器会把脚本体当成自己的选项
    assert.ok(/--\s/.test(body), `${pkg} 的 ${name} 缺少 \`--\` 分隔符：${body}`);
    // 不允许套娃式二次派发
    assert.ok(!body.includes("build-sched.mjs run -- node scripts/build-sched.mjs"),
      `${pkg} 的 ${name} 出现了套娃式二次派发`);
  }
  // 根目录的 build/test/tauri 都必须只包一层（内层由 npm 脚本直接执行）
  for (const name of ["build", "test", "tauri"]) {
    assert.equal(ROOT_PKG.scripts[name].split(SCHED_TOKEN).length - 1, 1, `root ${name} 必须恰好一层调度`);
  }
});

test("补充C3：未接入调度器的入口只允许是「轻量/dev/交互式」，且豁免名单是显式的", () => {
  for (const [pkg, pkgObj] of [["root", ROOT_PKG], ["apps/mobile", MOBILE_PKG]]) {
    for (const [name, body] of Object.entries(pkgObj.scripts)) {
      if (body.includes(SCHED_TOKEN)) continue;
      if (name.endsWith(":raw")) continue;                 // 逃生口，允许
      if (DIRECT_ALLOWED.has(name)) continue;              // 显式豁免（含理由）
      // 其余一律视为"未纳管入口"：要么接入调度器，要么在 DIRECT_ALLOWED 里写清理由
      assert.fail(`${pkg} 的 ${name} 未接入调度器且未在豁免名单里（会绕过资源闸门）：${body}`);
    }
  }
});

test("补充C4：手机端 APK 入口能正确定位到 android/gradlew.bat（不依赖当前目录）", () => {
  const body = MOBILE_PKG.scripts["build:android"];
  assert.match(body, /--cwd android/, "必须显式 --cwd android，否则 gradlew 找不到工程目录");
  assert.match(body, /gradlew\.bat assembleRelease/);
  assert.match(body, /--priority P0/);
  assert.match(body, /--label apk-release/);
  assert.ok(existsSync(join(REPO, "apps", "mobile", "android", "gradlew.bat")), "gradlew.bat 必须存在于 apps/mobile/android");
  // 分类必须落在重型：APK release 会拉起 Gradle/Kotlin 守护进程，按中/轻量放行就是超卖
  assert.equal(classifyArgv(["gradlew.bat", "assembleRelease"], { cwd: join(REPO, "apps", "mobile", "android") }).taskClass, "heavy");
});
