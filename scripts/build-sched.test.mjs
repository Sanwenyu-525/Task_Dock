//! 构建调度器单元测试（零依赖，node --test）：不启任何真实构建，只验证判定逻辑。
//! 跨进程/并发/崩溃恢复等行为测试见 scripts/build-sched-acceptance.test.mjs（npm run sched:acceptance）。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, loadConfig, configRisks } from "./sched/config.mjs";
import { classifyArgv, classifyCommandLine, splitCommandLine, CLASSES } from "./sched/classify.mjs";
import { effectivePriority, compareOrder, parsePriority, computeFingerprint, evaluateEligibility } from "./sched/queue.mjs";
import {
  BUILD_CLASSES, classifyReservation, createReservation, planGlobalConcurrency, readReservation,
  readReservations, releaseReservation, setReservationChild, writeReservation,
} from "./sched/admission.mjs";
import { resolveStateHome, ensureState, paths } from "./sched/state.mjs";
import { slotNames, snapshotSlots, cmdlineSignature, reapStaleSlots } from "./sched/lock.mjs";
import { selfIdentity, verifyIdentity } from "./sched/proc.mjs";
import { buildSpawnPlan, resolveExecutable, priorityConflict } from "./sched/runner.mjs";
import { inferWorkspace } from "./sched/devservers.mjs";

const cfg = DEFAULT_CONFIG;
const tmpRoot = mkdtempSync(join(tmpdir(), "sched-unit-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function mkWorkspace(name, scripts) {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  if (scripts) writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts }, null, 2));
  return dir;
}

// 真实存在的 linked worktree（没有就返回 null，测试退化为不断言跨 worktree 相等）
function firstWorktree(repoRoot) {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot, encoding: "utf8", timeout: 20000, windowsHide: true,
  });
  if (r.status !== 0) return null;
  const entries = (r.stdout ?? "").split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return entries.find((p) => norm(p) !== norm(repoRoot)) ?? null;
}

// ---------------------------------------------------------------- 分类

test("分类：cargo 各子命令按编译范围分级", () => {
  const c = (args) => classifyArgv(["cargo", ...args]).taskClass;
  assert.equal(c(["build"]), "heavy", "cargo build 是完整编译");
  assert.equal(c(["build", "--release"]), "heavy");
  assert.equal(c(["check"]), "medium", "cargo check 属 Rust 局部检查");
  assert.equal(c(["check", "--release"]), "heavy", "release 依赖树仍是重型");
  assert.equal(c(["fmt"]), "light");
  assert.equal(c(["clippy", "--all-targets"]), "heavy");
  assert.equal(c(["clippy"]), "medium");
  assert.equal(c(["test"]), "heavy", "无过滤的全量 cargo test 属重型");
  assert.equal(c(["test", "--lib", "mobile_sync::"]), "medium", "限定目标的测试是中型");
  assert.equal(c(["test", "--release"]), "heavy");
});

test("分类：前端工具的轻/中/重边界", () => {
  assert.equal(classifyArgv(["vite", "build"]).taskClass, "medium", "Vite 构建是中型");
  assert.equal(classifyArgv(["vite"]).taskClass, "dev");
  assert.equal(classifyArgv(["tsc", "--noEmit"]).taskClass, "medium");
  assert.equal(classifyArgv(["tsc", "--noEmit", "src/a.ts"]).taskClass, "light");
  assert.equal(classifyArgv(["vitest", "run"]).taskClass, "medium");
  assert.equal(classifyArgv(["vitest", "run", "src/x.test.ts"]).taskClass, "light");
  assert.equal(classifyArgv(["eslint", "src"]).taskClass, "light");
  assert.equal(classifyArgv(["prettier", "--check", "."]).taskClass, "light");
});

test("分类：Tauri / Gradle / 移动端都归为重型，dev 单独一类", () => {
  assert.equal(classifyArgv(["tauri", "build"]).taskClass, "heavy");
  assert.equal(classifyArgv(["tauri", "dev"]).taskClass, "dev");
  assert.equal(classifyArgv(["tauri", "info"]).taskClass, "light");
  assert.equal(classifyArgv(["gradlew", "assembleDebug"]).taskClass, "heavy");
  assert.equal(classifyArgv(["expo", "run:android"]).taskClass, "heavy");
});

test("分类：npm 脚本按 package.json 脚本体展开，不靠名字里的 build", () => {
  const ws = mkWorkspace("ws-scripts", {
    "build": "tsc --noEmit && vite build",
    "build:inner": "npm run build",
    "release": "cargo build --release",
    "lint": "eslint src",
    "watch": "vite",
    "serve": "tauri",
  });
  assert.equal(classifyArgv(["npm", "run", "build"], { cwd: ws }).taskClass, "medium");
  assert.equal(classifyArgv(["npm", "run", "release"], { cwd: ws }).taskClass, "heavy");
  assert.equal(classifyArgv(["npm", "run", "lint"], { cwd: ws }).taskClass, "light");
  assert.equal(classifyArgv(["npm", "run", "watch"], { cwd: ws }).taskClass, "dev");
  assert.equal(classifyArgv(["npm", "run", "build:inner"], { cwd: ws }).taskClass, "medium",
    "脚本互相调用时按最深一层的实际命令判定");
  assert.equal(classifyArgv(["npm", "run", "build"], { cwd: ws }).rule.startsWith("npm-script"), true);
  assert.equal(classifyArgv(["npm", "run", "serve", "dev"], { cwd: ws }).taskClass, "dev",
    "脚本名之后的实参要接回脚本体：npm run serve dev 不能退化成 serve");
  assert.equal(classifyArgv(["npm", "run", "serve", "--", "dev"], { cwd: ws }).taskClass, "dev",
    "带 -- 分隔符的透传实参同样生效");
});

test("分类：未识别命令按保守策略归为重型（不允许误判为轻量）", () => {
  const r = classifyArgv(["some-unknown-tool", "--flag"]);
  assert.equal(r.taskClass, "heavy");
  assert.match(r.reason, /保守/);
  // 显式覆盖优先，并记录来源
  assert.equal(classifyArgv(["some-unknown-tool"], { explicitClass: "light" }).rule, "explicit");
});

test("分类：组合命令取最高等级", () => {
  const line = "tsc --noEmit && cargo build --release && echo done";
  assert.equal(classifyCommandLine(line).taskClass, "heavy");
  assert.deepEqual(splitCommandLine("a && b | c ; d"), ["a", "b", "c", "d"]);
});

test("分类：仓库内轻量脚本不被误判为重型", () => {
  assert.equal(classifyArgv(["node", "scripts/build-guard.mjs", "precheck"]).taskClass, "light");
  assert.equal(classifyArgv(["node", "scripts/worktree-guard.mjs", "status"]).taskClass, "light");
  assert.equal(classifyArgv(["node", "scripts/make-preview.mjs"]).taskClass, "medium");
  assert.equal(classifyArgv(["node", "-e", "console.log(1)"]).taskClass, "light");
});

test("分类：长期运行的 vite 服务都归 dev（`vite preview` 不得掉进 light）", () => {
  // dev / preview 都是「不 Ctrl+C 就不退出」的服务：按 light 归类会占轻量槽位、
  // 还能与另一条轻量任务同时拉起两个预览服务抢端口。
  assert.equal(classifyArgv(["vite"]).taskClass, "dev");
  assert.equal(classifyArgv(["vite", "preview"]).taskClass, "dev");
  assert.equal(classifyArgv(["vite", "--version"]).taskClass, "light", "一次性查询命令仍是 light");
  assert.equal(classifyArgv(["vite", "build"]).taskClass, "medium", "构建仍归 medium（不得因本次改动被抬重）");
  assert.equal(classifyArgv(["npm", "run", "preview:raw"], { cwd: process.cwd() }).taskClass, "dev",
    "`npm run preview:raw` 展开到 vite preview 后也必须是 dev");
});

test("优先级：运行中的高优先级任务不得把后到的低优先级任务顶死（无限让位）", () => {
  // 2026-11-15 第二轮缺陷：`priorityConflict` 曾把 running 也算成"在等同一分类"，
  // 于是 P2 的 `npm run dev` 拿到槽位后又让位、下一轮又被同一个 running 记录顶回去 → 无限让位。
  // 一个 P1 长驻 dev 就能饿死之后所有 P2 dev。
  const cfg = { ...DEFAULT_CONFIG, agingStepMs: 0 };
  const nowIso = new Date().toISOString();
  const self = { id: "self-dev", status: "queued", taskClass: "dev", priority: 2, enqueuedAt: nowIso, updatedAt: nowIso };
  const base = { taskClass: "dev", priority: 1, updatedAt: nowIso, enqueuedAt: new Date(Date.now() - 3600e3).toISOString() };
  const runningP1 = { ...base, id: "run-p1", status: "running" };
  const queuedP1 = { ...base, id: "queue-p1", status: "queued", enqueuedAt: new Date(Date.now() - 5000).toISOString() };
  const waitingP0 = { ...base, id: "wait-p0", status: "waiting_resources", priority: 0 };
  const runningHeavy = { ...base, id: "run-heavy", status: "running", taskClass: "heavy" };

  assert.equal(priorityConflict([runningP1, self], self, cfg), null,
    "⛔ running 的高优先级任务已经持有槽位，不得再让后来者让位");
  assert.equal(priorityConflict([runningHeavy, self], self, cfg), null, "跨分类不参与同分类优先级判定");
  assert.match(priorityConflict([queuedP1, self], self, cfg) ?? "", /更高优先级任务在等待同一分类/,
    "真正还在排队的高优先级任务仍必须优先（修复没有放宽防插队）");
  assert.match(priorityConflict([waitingP0, self], self, cfg) ?? "", /更高优先级任务在等待同一分类/,
    "waiting_resources 也是\"还在等\"，同样要有优先权");

  // 队列评估的解释文案同理（否则 queue 会指着一条 running 记录说"它在前面"）
  const home = mkdtempSync(join(tmpdir(), "sched-prioconf-"));
  try {
    const mem = { totalMb: 16000, availMb: 9000 };
    const eligRunning = evaluateEligibility({ home, task: self, tasks: [runningP1, self], cfg, mem });
    assert.deepEqual(eligRunning.priorityBlockers, [], "running 记录不得进 priorityBlockers");
    const eligQueued = evaluateEligibility({ home, task: self, tasks: [queuedP1, self], cfg, mem });
    assert.ok(eligQueued.priorityBlockers.length > 0, "真正在等的高优先级任务仍要排在前面");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 优先级

test("优先级：解析与老化（高优先级持续涌入也不能饿死 P3）", () => {
  assert.equal(parsePriority("P0"), 0);
  assert.equal(parsePriority("2"), 2);
  assert.equal(parsePriority(undefined, 1), 1);
  assert.throws(() => parsePriority("P9"));

  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const task = { id: "x", priority: 3, enqueuedAt: new Date(t0).toISOString() };
  const now = t0;
  assert.equal(effectivePriority(task, now, cfg), 3);
  assert.equal(effectivePriority(task, now + cfg.agingStepMs, cfg), 2);
  assert.equal(effectivePriority(task, now + cfg.agingStepMs * 2, cfg), 1);
  assert.equal(effectivePriority(task, now + cfg.agingStepMs * 3, cfg), 0);
  assert.equal(effectivePriority(task, now + cfg.agingStepMs * 10, cfg), 0, "有效优先级不为负");
});

test("优先级：同级按入队先后，高优先级排在前面", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const a = { id: "a-id1", priority: 1, enqueuedAt: new Date(now - 5000).toISOString(), status: "queued", taskClass: "heavy" };
  const b = { id: "b-id2", priority: 1, enqueuedAt: new Date(now - 1000).toISOString(), status: "queued", taskClass: "heavy" };
  const p0 = { id: "c-id3", priority: 0, enqueuedAt: new Date(now - 10).toISOString(), status: "queued", taskClass: "heavy" };
  assert.ok(compareOrder(a, b, now, cfg) < 0);
  assert.ok(compareOrder(p0, a, now, cfg) < 0);
});

test("全局并发：BUILD_CLASSES 与分类表保持一致（只排除 dev，防止新增分类后名额口径漂移）", () => {
  assert.deepEqual(
    [...BUILD_CLASSES].sort(),
    CLASSES.filter((c) => c !== "dev").sort(),
    "全局并发只统计一次性构建分类；新增分类时这里必须同步并显式决定是否占名额",
  );
});

test("全局并发：3 个构建在跑时 dev 任务不被构建锁挡住（它只受 dev 槽位约束）", () => {
  const entries = [
    { taskId: "h-1", taskClass: "heavy" },
    { taskId: "m-1", taskClass: "medium" },
    { taskId: "l-1", taskClass: "light" },
  ];
  const devReq = planGlobalConcurrency({ cfg, entries, taskId: "d-new", taskClass: "dev" });
  assert.equal(devReq.applies, false);
  assert.equal(devReq.active, 3, "active 仍如实展示 3 个构建在跑");
  assert.equal(devReq.admit, true, "dev 不占名额，也不该被并发上限拒绝");
});

test("全局并发：上限 3 统计 heavy/medium/light 合计，dev 不占名额，重入不把自己算成占用者", () => {
  const entries = [
    { taskId: "h-1", taskClass: "heavy" },
    { taskId: "m-1", taskClass: "medium" },
    { taskId: "l-1", taskClass: "light" },
  ];
  const full = planGlobalConcurrency({ cfg, entries, taskId: "l-2" });
  assert.equal(full.cap, 3, "默认上限是 3");
  assert.equal(full.active, 3);
  assert.equal(full.admit, false);
  assert.match(full.reason, /全局构建并发已满（3\/3）/);
  assert.match(full.reason, /自动释放名额/, "必须说明名额会自动释放，避免被误读成机器装不下");
  assert.match(full.scope, /dev/);

  assert.equal(planGlobalConcurrency({ cfg, entries: entries.slice(0, 2), taskId: "l-2" }).admit, true);

  // dev 常驻服务（2 个）不占构建名额：与既有「dev 不占一次性构建锁」的契约一致
  const withDev = planGlobalConcurrency({
    cfg,
    entries: [...entries, { taskId: "d-1", taskClass: "dev" }, { taskId: "d-2", taskClass: "dev" }],
    taskId: "l-2",
  });
  assert.equal(withDev.active, 3, "dev 不计入 active");
  assert.equal(withDev.admit, false);

  // 台账里已有自己（重入）：不能把自己算成占用者，否则会永远拒绝自己
  const self = planGlobalConcurrency({ cfg, entries, taskId: "h-1" });
  assert.equal(self.active, 2);
  assert.equal(self.admit, true);

  // 上限可配置；缺省/非法只在测试或特殊构造里出现（配置校验会拦住 < 1）
  assert.equal(planGlobalConcurrency({ cfg: { ...cfg, globalConcurrency: 5 }, entries, taskId: "l-2" }).admit, true);
  assert.equal(planGlobalConcurrency({ cfg: { globalConcurrency: null }, entries, taskId: "l-2" }).cap, null);
});

test("全局并发：globalConcurrency 必须 >= 1，非法值被拒绝且环境变量可覆盖", () => {
  const home = join(tmpRoot, "cfg-global-cap");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ globalConcurrency: 0 }));
  const bad = loadConfig({ stateHome: home, env: {} });
  assert.ok(bad.problems.some((p) => /globalConcurrency 必须 >= 1/.test(p)), `应报非法值：${bad.problems}`);
  assert.equal(bad.config.globalConcurrency, cfg.globalConcurrency, "非法值被拒绝后沿用默认");
  const overridden = loadConfig({ stateHome: home, env: { TASKDOCK_SCHED_GLOBAL_CONCURRENCY: "2" } });
  assert.equal(overridden.config.globalConcurrency, 2);
});

test("全局并发：3 个构建在跑时，第 4 个的等待原因是「全局构建并发已满」", () => {
  const home = join(tmpRoot, "elig-global-cap");
  ensureState(home);
  const now = new Date().toISOString();
  const mk = (taskId, taskClass) => ({
    taskId, taskClass, label: null, ownerPid: process.pid,
    ownerStartTime: now, ownerStartTimeSource: "test", nonce: taskId,
    childPid: null, detached: false, phase: "running", createdAt: now, heartbeatAt: now,
  });
  writeReservation(home, mk("h-1", "heavy"));
  writeReservation(home, mk("m-1", "medium"));
  writeReservation(home, mk("l-1", "light"));

  const task = { id: "l-new", taskClass: "light", priority: 1, status: "queued", enqueuedAt: now, updatedAt: now };
  const elig = evaluateEligibility({ home, task, tasks: [task], cfg });
  assert.equal(elig.eligible, false);
  assert.equal(elig.capBlocked, true);
  assert.ok(elig.blockers.some((b) => /全局构建并发已满（3\/3）/.test(b)), `等待原因应写明并发已满：${elig.blockers}`);

  // 释放一个名额（等价于某个构建结束）后必须立刻可准入
  rmSync(join(paths(home).reservations, "h-1.json"), { force: true });
  const after = evaluateEligibility({ home, task, tasks: [task], cfg });
  assert.equal(after.capBlocked, false);
  assert.equal(after.eligible, true);
});


test("预留台账：写入/读取正常，释放必须校验身份（PID/nonce 不符时拒绝删除）", () => {
  const home = join(tmpRoot, "budget-ledger");
  const entry = createReservation({ taskId: "h-led", taskClass: "heavy", detached: false });
  writeReservation(home, entry);

  assert.equal(readReservations(home).length, 1);
  assert.equal(readReservation(home, "h-led").nonce, entry.nonce);
  assert.equal(readReservation(home, "h-led").phase, "queued");

  setReservationChild(home, entry, { pid: 4321, commandLine: '"C:\\nvm4w\\nodejs\\node.exe" D:\\x\\fake.mjs t1', startTime: "s" });
  const stored = readReservation(home, "h-led");
  assert.equal(stored.childPid, 4321);
  assert.equal(stored.childCmdSignature, "d:/x/fake.mjs t1");
  assert.match(stored.childCmdLine, /fake\.mjs/, "原始命令行要留给 doctor --reap 做签名取证");

  // 别的进程凭据（PID 复用 / nonce 不符）不得删除
  for (const fake of [{ ...entry, nonce: "deadbeef" }, { ...entry, ownerPid: entry.ownerPid + 1 }]) {
    const r = releaseReservation({ home, entry: fake });
    assert.equal(r.ok, false);
    assert.equal(readReservations(home).length, 1, "拒绝删除后台账必须仍在（否则名额会被错误归还）");
  }

  assert.equal(releaseReservation({ home, entry: readReservation(home, "h-led") }).ok, true);
  assert.equal(readReservations(home).length, 0);
  // 幂等：已不存在的预留再释放一次不算错误
  assert.equal(releaseReservation({ home, entry }).ok, true);
});

test("崩溃残留台账：只有证明旧构建已结束才回收，unknown/detached/子进程存活一律 fail-closed", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const mk = (over = {}) => ({
    taskId: "h-crash", taskClass: "heavy", ownerPid: 4242,
    ownerStartTime: "2026-01-01T00:00:00.000Z", ownerStartTimeSource: "uptime", nonce: "n",
    childPid: null, detached: false,
    heartbeatAt: new Date(now - 200000).toISOString(), createdAt: new Date(now - 260000).toISOString(),
    ...over,
  });
  const probe = (o = {}) => ({
    ownerAlive: () => o.ownerAlive ?? false,
    childAlive: () => o.childAlive ?? false,
    verify: () => ({ state: o.identity ?? "gone", detail: "测试用证据" }),
    hasLiveChildOf: () => ({ known: o.kidsKnown ?? true, alive: o.kidsAlive ?? false, detail: "测试用子进程证据" }),
  });
  const c = (entry, o = {}) => classifyReservation(entry, { cfg, now, probe: probe(o) });

  assert.equal(c(mk(), { ownerAlive: true }).state, "owner-alive", "持有者还活着就不动");
  assert.equal(c(mk(), { identity: "unknown" }).reclaimable, false, "身份 unknown 必须 fail-closed");
  assert.equal(c(mk({ childPid: 999 }), { childAlive: true }).state, "child-alive", "旧构建可能还在跑");
  assert.equal(c(mk({ childPid: 999 }), { childAlive: false }).state, "owner-gone-child-gone");
  assert.equal(c(mk({ detached: true })).reclaimable, false, "detached 孤儿不自动回收（需 doctor --reap）");
  assert.equal(c(mk({ heartbeatAt: new Date(now - 1000).toISOString() })).state, "grace", "未登记 childPid 时要等宽限");
  assert.equal(c(mk(), { kidsKnown: false }).state, "unknown-children");
  assert.equal(c(mk(), { kidsAlive: true }).state, "child-alive");
  assert.equal(c(mk()).reclaimable, true, "持有者已死 + 无 childPid + 宽限已过 + 无存活子进程 → 可回收");
});

// ---------------------------------------------------------------- 配置

test("配置：未知字段、非法数值被拒绝而不是静默忽略", () => {
  const repo = mkWorkspace("cfg-repo");
  writeFileSync(join(repo, "build-sched.config.json"), JSON.stringify({
    globalConcurrency: 5, unknownKey: 1, pollMs: "abc", logMaxMb: 12.5,
  }));
  const { config, problems } = loadConfig({ repoRoot: repo, stateHome: join(tmpRoot, "cfg-home"), env: {} });
  assert.equal(config.globalConcurrency, 5);
  assert.equal(config.logMaxMb, 12.5);
  assert.ok(problems.some((p) => p.includes("unknownKey")));
  assert.ok(problems.some((p) => p.includes("pollMs")));
});

test("配置：环境变量覆盖优先于仓库配置", () => {
  const repo = mkWorkspace("cfg-env", null);
  writeFileSync(join(repo, "build-sched.config.json"), JSON.stringify({ globalConcurrency: 4 }));
  const { config, sources } = loadConfig({
    repoRoot: repo, stateHome: join(tmpRoot, "cfg-env-home"),
    env: { TASKDOCK_SCHED_GLOBAL_CONCURRENCY: "2" },
  });
  assert.equal(config.globalConcurrency, 2);
  assert.ok(sources.some((s) => s.kind === "env"));
});

test("配置：已删除的内存门槛与预算字段不得重新生效（必须报未知字段）", () => {
  const home = join(tmpRoot, "cfg-budget-removed");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    memoryAdmissionEnabled: false, heavyMinAvailMb: 1, hysteresisMb: 1,
    budgetEnabled: false, systemReserveMb: 1, estimateHeavyMb: 1, allowReserveBreach: true,
  }));
  const loaded = loadConfig({ stateHome: home, env: {} });
  const removed = [
    "memoryAdmissionEnabled", "heavyMinAvailMb", "hysteresisMb",
    "budgetEnabled", "systemReserveMb", "estimateHeavyMb", "allowReserveBreach",
  ];
  for (const k of removed) {
    assert.ok(loaded.problems.some((p) => p.includes(`未知字段 ${k}`),
      `字段 ${k} 已随功能删除，写在配置里必须报未知字段而不是静默生效`));
    assert.equal(loaded.config[k], undefined, `${k} 不得再出现在有效配置里`);
  }
  const risks = configRisks({
    config: loaded.config, sources: loaded.sources, problems: loaded.problems,
  });
  assert.ok(risks.some((r) => r.key === "unknown" && r.level === "P1"), "未知字段必须是 P1 风险项");
});

// ---------------------------------------------------------------- 指纹

test("去重指纹：输入相同才等价，改依赖/换工作区都会失效", () => {
  const a = mkWorkspace("fp-a");
  const b = mkWorkspace("fp-b");
  writeFileSync(join(a, "package.json"), '{"name":"a"}\n');
  writeFileSync(join(b, "package.json"), '{"name":"a"}\n');
  const argv = ["node", "scripts/make-preview.mjs"];

  const f1 = computeFingerprint({ argv, cwd: a, env: {} });
  const f2 = computeFingerprint({ argv, cwd: a, env: {} });
  assert.equal(f1.hash, f2.hash, "同一目录同一命令指纹稳定");

  const f3 = computeFingerprint({ argv, cwd: b, env: {} });
  assert.notEqual(f1.hash, f3.hash, "不同工作区产物不同，必须区分");

  writeFileSync(join(a, "package.json"), '{"name":"a","dependencies":{"x":"1"}}\n');
  const f4 = computeFingerprint({ argv, cwd: a, env: {} });
  assert.notEqual(f1.hash, f4.hash, "依赖清单变化后不得复用旧结果");

  const f5 = computeFingerprint({ argv: ["node", "scripts/gen-icons.mjs"], cwd: a, env: {} });
  assert.notEqual(f4.hash, f5.hash, "命令不同不等价");
});

// ---------------------------------------------------------------- 状态目录

test("状态目录：同一仓库的不同 Worktree 解析到同一个全局位置", () => {
  const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
  const main = resolveStateHome({ cwd: repoRoot, env: {} });
  const worktree = firstWorktree(repoRoot);
  if (worktree) {
    const wt = resolveStateHome({ cwd: worktree, env: {} });
    assert.equal(main.home, wt.home, "全局构建资源必须跨 Worktree 共享");
    assert.equal(main.source, "git-common-dir");
  } else {
    // 没有额外 worktree 的机器上退化为「至少解析成功」的断言，不伪造结论
    assert.ok(main.home.length > 0);
  }

  const over = resolveStateHome({ cwd: process.cwd(), env: { TASKDOCK_BUILD_SCHED_HOME: join(tmpRoot, "h") } });
  assert.equal(over.home, join(tmpRoot, "h"));
  assert.throws(() => resolveStateHome({ cwd: ".", env: { TASKDOCK_BUILD_SCHED_HOME: "relative/path" } }));
});

test("状态目录：Git 不在 PATH 时仍通过 .git 定位，不静默退回 tmpdir", () => {
  const repo = join(tmpRoot, "fake-git-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const r = resolveStateHome({ cwd: repo, env: { PATH: "" } });
  assert.equal(r.source, "git-common-dir");
  assert.equal(r.home, join(repo, ".git", "taskdock-build-sched"));
});

test("槽位命名：重型只有 1 个槽位，轻量按配置并行", () => {
  assert.deepEqual(slotNames("heavy", cfg.heavyConcurrency), ["heavy-1"]);
  assert.deepEqual(slotNames("light", cfg.lightConcurrency), ["light-1", "light-2"]);
  assert.deepEqual(snapshotSlots(join(tmpRoot, "no-such-home")), []);
});

test("槽位自愈：后台扫描只回收「持有者已死 + 子进程已结束」的槽位", () => {
  const home = join(tmpRoot, "sweep-home");
  ensureState(home);
  const slots = paths(home).slots;
  // 拿一个确定已退出的真实 PID：避免用猜的数字，isPidAlive 对未知错误会按「可能存活」处理
  const deadPid = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" }).pid;
  const put = (name, owner, ageMs = 120000) => {
    const dir = join(slots, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "owner.json"), JSON.stringify(owner));
    const t = new Date(Date.now() - ageMs);
    utimesSync(join(dir, "owner.json"), t, t);
    return dir;
  };

  const heavy = put("heavy-1", {
    taskId: "dead-task", pid: deadPid, startTime: new Date().toISOString(),
    startTimeSource: "uptime", child: null,
  });
  const admission = put(".admission", {
    taskId: "dead-admission", pid: deadPid, startTime: new Date().toISOString(),
    startTimeSource: "uptime", child: null,
  });
  const fresh = put("medium-1", { taskId: "fresh", pid: deadPid, child: null }, 5000);
  const alive = put("light-1", {
    taskId: "alive", pid: process.pid, startTime: selfIdentity().startTime,
    startTimeSource: "uptime", child: null,
  });

  const swept = reapStaleSlots({ home, cfg, log: () => {} });
  assert.deepEqual(swept.reclaimed.map((r) => r.slot).sort(), [".admission", "heavy-1"]);
  assert.equal(existsSync(heavy), false, "持有者已死 + 无子进程 → 必须回收");
  assert.equal(existsSync(admission), false,
    "准入临界区 slots/.admission 的崩溃残留同样要回收，否则所有分类的准入都被它卡死");
  assert.equal(existsSync(fresh), true, "心跳仍新鲜 → 不做取证、不动");
  assert.equal(existsSync(alive), true, "持有者仍存活 → 不动");
});

test("槽位自愈：子进程仍存活时不回收（后台扫描绝不终止正在跑的构建）", () => {
  const home = join(tmpRoot, "sweep-home-2");
  ensureState(home);
  const slots = paths(home).slots;
  const deadPid = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" }).pid;
  const dir = join(slots, "heavy-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify({
    taskId: "orphan-build", pid: deadPid, startTime: new Date().toISOString(),
    startTimeSource: "uptime", child: { pid: process.pid, commandLine: "node fake-build.mjs" },
  }));
  const t = new Date(Date.now() - 120000);
  utimesSync(join(dir, "owner.json"), t, t);

  const swept = reapStaleSlots({ home, cfg, log: () => {} });
  assert.equal(swept.reclaimed.length, 0, "调度进程崩溃但构建子进程仍在跑 → 后台扫描不得回收");
  assert.ok(swept.blocked.some((b) => b.slot === "heavy-1" && /仍存活/.test(b.reason),
    "必须给出「子进程仍存活」的阻塞原因，交由竞争路径/doctor 处置"));
  assert.equal(existsSync(dir), true);
});

// ---------------------------------------------------------------- 进程启动

test("子进程启动：exe 直连、.cmd 走 ComSpec、危险参数被拒绝", () => {
  const plan = buildSpawnPlan(["node", "-v"], process.cwd(), {});
  assert.match(plan.file, /node\.exe$/i);
  assert.deepEqual(plan.args, ["-v"]);

  const npmPlan = buildSpawnPlan(["npm", "run", "build"], process.cwd(), {});
  assert.match(npmPlan.file, /cmd\.exe$/i, "npm 是 .cmd，必须经 cmd.exe");
  assert.match(npmPlan.args.join(" "), /run build/);

  assert.throws(() => buildSpawnPlan(["echo", 'a"b'], process.cwd(), {}), /双引号/);
  assert.doesNotThrow(() => buildSpawnPlan(["echo", 'a"b'], process.cwd(), {}, { shellRaw: true }));

  const resolved = resolveExecutable("node", process.cwd());
  assert.ok(resolved && !resolved.needsShell);
});

test("开发服务器归属：从命令行绝对路径推断工作区", () => {
  assert.equal(
    inferWorkspace('"C:\\nvm4w\\nodejs\\node.exe" "D:\\Develop\\task_dock\\node_modules\\vite\\bin\\vite.js"'),
    "D:/Develop/task_dock",
  );
  assert.equal(inferWorkspace('npm-cli.js run dev'), null);
  assert.equal(
    inferWorkspace("cargo test", { knownRoots: ["D:\\Develop\\task_dock"] }),
    null,
    "没有路径线索时不臆断归属",
  );
});

// ---------------------------------------------------------------- 可执行解析（Windows shim）

test("可执行解析：PATH 里的无扩展名 shim 不得抢在 .cmd 前面（否则 spawn ENOENT -4058）", () => {
  // 2026-11-15 第二轮实测：`npm run dev` → `run -- vite` 时调度器选中了 `node_modules/.bin/vite`
  // （无扩展名 bash shim），Node 在 Windows 上 spawn 它直接报 -4058（ENOENT），
  // `npm run preview` 同理。这里复刻 node_modules/.bin 的真实形态并断言解析结果。
  const dir = mkdtempSync(join(tmpdir(), "sched-resolve-"));
  const saved = process.env.PATH;
  try {
    writeFileSync(join(dir, "probe-tool"), "#!/bin/sh\nexec node \"$@\"\n");
    writeFileSync(join(dir, "probe-tool.cmd"), "@echo off\r\n");
    process.env.PATH = `${dir}${delimiter}${saved}`;
    const resolved = resolveExecutable("probe-tool", process.cwd());
    assert.ok(resolved, "同目录下的 probe-tool 必须能被解析到");
    assert.match(resolved.path, /\.cmd$/i, `必须优先选 .cmd（实际选中 ${resolved.path}）`);
    assert.equal(resolved.needsShell, true, ".cmd/.bat 必须走 ComSpec");
    // 只有无扩展名 shim 时仍能找到它（兜底不丢），由调用方承担 spawn 失败
    rmSync(join(dir, "probe-tool.cmd"));
    const fallback = resolveExecutable("probe-tool", process.cwd());
    assert.ok(fallback, "只剩无扩展名文件时仍应被找到（不因修复而解析失败）");
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 身份取证与 PID 复用防护
test("命令行签名：斜杠/引号/大小写归一，剥除可执行文件本体与 cmd 包装前缀", () => {
  assert.equal(
    cmdlineSignature('"C:\\nvm4w\\nodejs\\node.exe" D:\\repo\\fake-build.mjs t1'),
    "d:/repo/fake-build.mjs t1",
  );
  assert.equal(
    cmdlineSignature("node D:/repo/fake-build.mjs t1"),
    "d:/repo/fake-build.mjs t1",
  );
  assert.equal(
    cmdlineSignature('cmd.exe /d /s /c "chcp 65001>nul & npm.cmd run build"'),
    "npm.cmd run build",
  );
  assert.equal(cmdlineSignature(""), "");
});

test("身份取证：记录缺失 PID 判 gone；不存在的 PID 不得判为同一进程", () => {
  assert.equal(verifyIdentity({}).state, "gone");
  assert.equal(verifyIdentity({ pid: null }).state, "gone");
  // 一个高概率未被占用的 PID：无论 CIM 是否能查到，都不得返回 same
  const check = verifyIdentity({ pid: 2147483, startTime: new Date().toISOString() });
  assert.notEqual(check.state, "same", "不存在的 PID 不得被当作原进程（PID 复用防护）");
});

test("身份取证：「进程在但读不到创建时间」只能是 unknown，不得冤判成 PID 已被复用", () => {
  // 2026-11-15 第二轮缺陷：旧实现把 startTime=null 一路掉到 gone，于是
  //   ① 等价任务去重被跳过（同一构建跑两遍）；
  //   ② 崩溃回收可能把**活着的**构建的槽位/名额判成可回收（并发超卖）。
  // 这里用注入的 probe 把四种结论都钉住（不需要真实 CIM）。
  const live = process.pid;
  const now = new Date().toISOString();
  const probeOf = (value) => () => value;

  assert.equal(
    verifyIdentity({ pid: live, startTime: now }, { probe: probeOf({ known: true, alive: true, startTime: now }) }).state,
    "same", "创建时间完全一致 → same",
  );
  assert.equal(
    verifyIdentity({ pid: live, startTime: now, source: "uptime" },
      { probe: probeOf({ known: true, alive: true, startTime: new Date(Date.now() - 900).toISOString() }) }).state,
    "same", "uptime 推导值与 CIM 的亚秒级误差必须在容差内",
  );
  assert.equal(
    verifyIdentity({ pid: live, startTime: "2001-01-01T00:00:00.000Z", source: "uptime" },
      { probe: probeOf({ known: true, alive: true, startTime: now }) }).state,
    "gone", "创建时间差很远 → 真的 PID 复用",
  );
  const unreadable = verifyIdentity({ pid: live, startTime: now, source: "uptime" },
    { probe: probeOf({ known: true, alive: true, startTime: null }) });
  assert.equal(unreadable.state, "unknown", "⛔ 读不到创建时间不能判 gone（旧实现正是这里出错）");
  assert.match(unreadable.detail, /读不到创建时间/);
  assert.equal(
    verifyIdentity({ pid: live, startTime: now }, { probe: probeOf({ known: false, alive: true, startTime: null }) }).state,
    "unknown", "CIM 查询失败 → unknown",
  );
  assert.equal(
    verifyIdentity({ pid: live, startTime: now }, { probe: probeOf({ known: true, alive: false, startTime: null }) }).state,
    "gone", "进程确实不存在 → gone",
  );
});

test("配置安全：坏 JSON 与未知字段必须被 doctor 报出来，而不是静默忽略", () => {
  const badHome = join(tmpRoot, "cfg-badjson");
  mkdirSync(badHome, { recursive: true });
  writeFileSync(join(badHome, "config.json"), "{ this is not json ");
  const bad = loadConfig({ stateHome: badHome, env: {} });
  assert.ok(bad.problems.some((p) => p.includes("读取失败")), "坏 JSON 必须报读取失败");
  const badRisks = configRisks({ config: bad.config, sources: bad.sources, problems: bad.problems });
  assert.ok(badRisks.some((r) => r.key === "config" && r.level === "P0"));

  const typoHome = join(tmpRoot, "cfg-typo");
  mkdirSync(typoHome, { recursive: true });
  writeFileSync(join(typoHome, "config.json"), JSON.stringify({ globalConcurrency: 6, typpoKey: 1 }));
  const typo = loadConfig({ stateHome: typoHome, env: {} });
  assert.ok(typo.problems.some((p) => p.includes("未知字段 typpoKey")), "拼错的字段必须被点名");
  const typoRisks = configRisks({ config: typo.config, sources: typo.sources, problems: typo.problems });
  assert.ok(typoRisks.some((r) => r.key === "unknown" && r.level === "P1"), "未知字段至少 P1");
});