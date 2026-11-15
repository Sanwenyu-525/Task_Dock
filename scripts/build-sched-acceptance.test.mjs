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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

test("补充A：嵌套调度不自锁（tauri build → beforeBuildCommand `npm run build` 场景）", async () => {
  // 外层与外层**同分类**：若内层没有直通而是去排队，它等的正是自己父进程持有的槽位，
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
