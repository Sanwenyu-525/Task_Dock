//! 构建调度器单元测试（零依赖，node --test）：不启任何真实构建，只验证判定逻辑。
//! 跨进程/并发/崩溃恢复等行为测试见 scripts/build-sched-acceptance.test.mjs（npm run sched:acceptance）。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, loadConfig, configRisks, DANGER_AUTH_ENV } from "./sched/config.mjs";
import { classifyArgv, classifyCommandLine, splitCommandLine } from "./sched/classify.mjs";
import { effectivePriority, compareOrder, parsePriority, computeFingerprint, evaluateEligibility } from "./sched/queue.mjs";
import {
  classifyReservation, computeBudget, createReservation, maxEstimateMb, planAdmission, readReservation,
  readReservations, releaseReservation, setReservationChild, sumReserved, writeReservation,
} from "./sched/budget.mjs";
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

// ---------------------------------------------------------------- 内存准入（已删除）
//
// 2026-11-15 晚：`evaluateMemoryAdmission` / `memoryFloorForClass` / `pressureLevel` 连同
// `heavyMinAvailMb` / `mediumMinAvailMb` / `lightMinAvailMb` / `hysteresisMb` / `safetyReserveMb`
// 已整体删除。原先「3GB 挡住重型 / 滞回 / 压力等级」这四组用例随功能一并移除；
// 现在只剩槽位并发与全局预算两条约束（见下一节）。

// ---------------------------------------------------------------- 全局预算（跨分类）
//
// 背景（2026-11-15 整改前）：旧实现里「准入 = 本分类槽位有空 + 本任务自己的内存门槛达标」，
// 不同分类各自读同一份 os.freemem 快照各自放行 → Heavy(6000)+Medium(3000) 在 7GB 可用时
// 双双合格，合计 9000MB 已经超卖。当时为此加了全局预算约束。
//
// 2026-11-15 晚：内存门槛（约束 A）已按用户要求整体删除，现在**只有**槽位并发与全局预算
// 两条约束；预算仍是防超卖的唯一跨分类闸门，这一组测试继续锁定它。

test("全局预算：上限 = 物理总量 - 系统保留（硬上限，不被任务峰值抬高）", () => {
  const b = computeBudget({ cfg, totalMb: 16005 });
  assert.equal(b.budgetMb, 16005 - cfg.systemReserveMb);
  assert.equal(b.hardLimitMb, 16005 - cfg.systemReserveMb);
  assert.equal(b.reserveBreached, false, "未开 allowReserveBreach 时绝不能突破系统保留");

  // 系统保留调得过大时：预算**不再**被夹到最大分类峰值（旧公式的缺陷），
  // 而是如实变成 1005MB 并标记「最大分类峰值装不下」，由 planAdmission 明确拒绝重型任务。
  const tight = computeBudget({ cfg: { ...cfg, systemReserveMb: 15000 }, totalMb: 16005 });
  assert.equal(tight.rawMb, 1005);
  assert.equal(tight.budgetMb, 1005, "预算必须严格等于 totalMb - systemReserveMb");
  assert.equal(tight.hardLimitMb, 1005);
  assert.equal(tight.reserveBreached, false);
  assert.equal(tight.peakExceedsBudget, true, "6000MB 峰值装不进 1005MB 预算");
  assert.match(tight.warning, /无法准入/);

  assert.equal(maxEstimateMb(cfg), 6000);
  assert.equal(computeBudget({ cfg: { ...cfg, budgetEnabled: false }, totalMb: 16005 }).enabled, false);
  const noReserve = computeBudget({ cfg: { ...cfg, systemReserveMb: 0 }, totalMb: 16005 });
  assert.equal(noReserve.budgetMb, 16005);
  // 把安全垫整块取消（systemReserveMb=0）也是风险，必须显式提示，而不是悄悄"用满物理内存"
  assert.match(noReserve.warning, /systemReserveMb=0/);
  assert.match(noReserve.warning, /没有给操作系统/);
});

test("全局预算：4/8/16/32GB 设备档位的判定表（安全余量不被静默突破）", () => {
  const devices = [
    { totalMb: 4096, label: "4GB" },
    { totalMb: 8192, label: "8GB" },
    { totalMb: 16384, label: "16GB" },
    { totalMb: 32768, label: "32GB" },
  ];
  const rows = [];
  for (const d of devices) {
    const budget = computeBudget({ cfg, totalMb: d.totalMb });
    const expected = Math.max(0, d.totalMb - cfg.systemReserveMb);
    assert.equal(budget.budgetMb, expected, `${d.label} 预算应严格等于 物理-保留`);
    assert.equal(budget.hardLimitMb, expected, `${d.label} 硬上限不得被抬高`);
    // 核心不变量：生效预算 + 系统保留 ≤ 物理内存（默认配置下永不侵占安全垫）
    assert.ok(budget.budgetMb + budget.reserveMb <= d.totalMb,
      `${d.label} ⛔ 预算 ${budget.budgetMb} + 保留 ${budget.reserveMb} 超过物理 ${d.totalMb}（安全余量被静默突破）`);

    const heavy = planAdmission({ budget, entries: [], taskId: "h", estimateMb: cfg.estimateHeavyMb });
    const medium = planAdmission({ budget, entries: [], taskId: "m", estimateMb: cfg.estimateMediumMb });
    rows.push({
      device: d.label, budgetMb: budget.budgetMb,
      heavy: heavy.admit ? "准入" : (heavy.infeasible ? "不可准入（峰值>预算）" : "预算不足"),
      medium: medium.admit ? "准入" : (medium.infeasible ? "不可准入（峰值>预算）" : "预算不足"),
      warning: budget.warning ?? "",
    });

    if (d.totalMb < cfg.systemReserveMb + cfg.estimateHeavyMb) {
      // 4GB / 8GB：重型 6000MB 装不下 → 必须是"不可准入"，并且原因里写清物理与保留
      assert.equal(heavy.admit, false, `${d.label} 重型任务不得准入`);
      assert.equal(heavy.infeasible, true, `${d.label} 应判为 infeasible（等待也不会放行）`);
      assert.match(heavy.reason, /本机装不下|全局预算为 0/);
      assert.match(heavy.hint, /systemReserveMb/, "可操作建议里必须指明 systemReserveMb 这个旋钮");
      assert.ok(budget.warning, `${d.label} 必须给出预算风险提示`);
    } else {
      assert.equal(heavy.admit, true, `${d.label} 重型任务应准入`);
    }
  }
  // 判定表本身留证据，便于报告引用
  assert.equal(rows.map((r) => r.device).join(","), "4GB,8GB,16GB,32GB");
  assert.equal(rows[0].budgetMb, 4096 - cfg.systemReserveMb, "4GB 档：4096-3072=1024MB");
  assert.equal(rows[1].budgetMb, 8192 - cfg.systemReserveMb);
  assert.equal(rows[1].heavy, "不可准入（峰值>预算）", "8GB 档重型任务必须明确不可准入，而不是排队");
});

test("全局预算：8GB 机器上 Heavy 6GB 的完整判定（本题 P0 的复现场景）", () => {
  const budget = computeBudget({ cfg, totalMb: 8192 });
  assert.equal(budget.reserveMb, 3072);
  assert.equal(budget.hardLimitMb, 5120, "8GB - 3GB 保留 = 5GB 才是真实上限");
  assert.equal(budget.budgetMb, 5120, "旧公式会把它抬到 6000MB，这里必须仍是 5120");
  const plan = planAdmission({ budget, entries: [], taskId: "heavy-1", estimateMb: 6000 });
  assert.equal(plan.admit, false);
  assert.equal(plan.infeasible, true);
  assert.equal(plan.hardLimitMb, 5120);
  assert.match(plan.reason, /预计峰值 5\.86 GB > 本机全局预算上限 5\.00 GB/);
  assert.match(plan.reason, /系统保留 3\.00 GB/);
  assert.match(plan.reason, /不是排队问题/);
  assert.match(plan.hint, /allowReserveBreach/);
  // 同一台 8GB 机器上中型/轻量仍然可跑（不能因为重型装不下就整体停摆）
  assert.equal(planAdmission({ budget, entries: [], taskId: "m-1", estimateMb: 3000 }).admit, true);
  assert.equal(planAdmission({ budget, entries: [], taskId: "l-1", estimateMb: 800 }).admit, true);
});

test("全局预算：系统保留 ≥ 物理内存的退化场景（预算为 0，全部不可准入且原因明确）", () => {
  for (const [totalMb, reserveMb] of [[8192, 8192], [8192, 9000], [4096, 5120]]) {
    const budget = computeBudget({ cfg: { ...cfg, systemReserveMb: reserveMb }, totalMb });
    assert.equal(budget.rawMb, totalMb - reserveMb);
    assert.equal(budget.budgetMb, 0, `保留 ${reserveMb} ≥ 物理 ${totalMb} 时预算必须夹到 0`);
    assert.equal(budget.hardLimitMb, 0);
    assert.equal(budget.reserveExhausted, true);
    assert.match(budget.warning, /系统保留 .* ≥ 物理内存 .*全局预算为 0/);
    const plan = planAdmission({ budget, entries: [], taskId: "x", estimateMb: 800 });
    assert.equal(plan.admit, false);
    assert.equal(plan.infeasible, true);
    assert.match(plan.reason, /全局预算为 0/);
  }
});

test("全局预算：多个任务合计超过预算时必须拒绝（原子预留不超卖）", () => {
  const budget = computeBudget({ cfg, totalMb: 8192 }); // 5120MB
  const sitting = [
    { taskId: "h-1", taskClass: "heavy", reservedMb: 6000 }, // 理论上不该被写进去（峰值>预算）
  ];
  // 即使台账里存在一条超过预算的旧预留（例如历史上允许突破时留下的），后来的任务也不会被放行
  const blocked = planAdmission({ budget, entries: sitting, taskId: "m-1", estimateMb: 3000 });
  assert.equal(blocked.admit, false);
  assert.equal(blocked.reservedMb, 6000);
  assert.match(blocked.reason, /全局构建预算不足/);

  // 正常组合：3000 已预留 + 3000 再来 = 6000 > 5120 → 拒绝；预留 2000 + 3000 = 5000 ≤ 5120 → 放行
  const ok = planAdmission({ budget, entries: [{ taskId: "m-old", reservedMb: 2000 }], taskId: "m-new", estimateMb: 3000 });
  assert.equal(ok.admit, true);
  const no = planAdmission({ budget, entries: [{ taskId: "m-old", reservedMb: 3000 }], taskId: "m-new", estimateMb: 3000 });
  assert.equal(no.admit, false);
  // 预算 5120 下：两个 light(800) + medium(3000) = 4600 ≤ 5120 → 第三个 light 会超
  const three = [{ taskId: "l-1", reservedMb: 800 }, { taskId: "m-1", reservedMb: 3000 }];
  assert.equal(planAdmission({ budget, entries: three, taskId: "l-2", estimateMb: 800 }).admit, true);
  assert.equal(planAdmission({ budget, entries: [...three, { taskId: "l-2", reservedMb: 800 }], taskId: "l-3", estimateMb: 800 }).admit, false);
});

test("全局预算：显式 allowReserveBreach 开关（默认关闭；开启后必须显著标注风险）", () => {
  const totalMb = 8192;
  // 默认关闭：口头/配置里没写就是关闭，绝不能悄悄突破
  const off = computeBudget({ cfg, totalMb });
  assert.equal(off.breachAllowed, false);
  assert.equal(off.reserveBreached, false);
  assert.equal(off.budgetMb, 5120);

  // 显式开启：预算被抬到最大分类峰值 6000，但必须标注"侵占了 880MB 安全垫"
  const on = computeBudget({ cfg: { ...cfg, allowReserveBreach: true }, totalMb });
  assert.equal(on.breachAllowed, true);
  assert.equal(on.budgetMb, 6000);
  assert.equal(on.hardLimitMb, 5120);
  assert.equal(on.breachMb, 880);
  assert.equal(on.reserveBreached, true);
  assert.equal(on.clamped, true, "兼容字段 clamped 只在显式突破时成立");
  assert.match(on.warning, /已显式开启 allowReserveBreach/);
  assert.match(on.warning, /5\.86 GB 高于/);
  assert.match(on.warning, /安全垫已被侵占 880 MB/);

  // 开启后重型任务可以准入，但 plan 上仍带 reserveBreached 证据
  const plan = planAdmission({ budget: on, entries: [], taskId: "h-1", estimateMb: 6000 });
  assert.equal(plan.admit, true);
  assert.equal(plan.reserveBreached, true);
  assert.equal(plan.hardLimitMb, 5120);

  // 大机器上开关没有副作用（raw 已经大于峰值）
  const big = computeBudget({ cfg: { ...cfg, allowReserveBreach: true }, totalMb: 16384 });
  assert.equal(big.reserveBreached, false);
  assert.equal(big.budgetMb, 16384 - 3072);
  assert.equal(big.warning, null);
});

test("全局预算：跨分类合计超卖必须被拒绝，恰好等于上限才放行", () => {
  const budget = { ...computeBudget({ cfg, totalMb: 16005 }), budgetMb: 9000, reservedMb: 0 };
  const sitting = [
    { taskId: "h-1", taskClass: "heavy", reservedMb: 6000 },
    { taskId: "m-1", taskClass: "medium", reservedMb: 3000 },
  ];

  // Heavy 已预留 6000，再来一个 Medium(3000)：6000+3000 = 9000 ≤ 9000 → 恰好可放行
  const exact = planAdmission({ budget, entries: [sitting[0]], taskId: "m-2", estimateMb: 3000 });
  assert.equal(exact.admit, true, "恰好等于预算上限应当放行");
  assert.equal(exact.reservedMb, 6000);

  // 已有 6000+3000，再来 Light(800)：9800 > 9000 → 拒绝（这正是旧实现会放过的超卖组合）
  const over = planAdmission({ budget, entries: sitting, taskId: "l-1", estimateMb: 800 });
  assert.equal(over.admit, false);
  assert.match(over.reason, /全局构建预算不足/);
  assert.match(over.reason, /已预留 8\.79 GB/);

  // 自身旧预留不计入（重入而不是"另一个任务"，否则自己会和自己抢预算）
  const self = planAdmission({ budget, entries: sitting, taskId: "h-1", estimateMb: 6000 });
  assert.equal(self.reservedMb, 3000);
  assert.equal(self.admit, true);

  // 单任务预计峰值就超过预算 → 直接拒绝，不允许自我放行（且明确判为 infeasible，而不是"排队"）
  const huge = planAdmission({ budget: { ...budget, budgetMb: 5000 }, entries: [], taskId: "x", estimateMb: 6000 });
  assert.equal(huge.admit, false);
  assert.equal(huge.infeasible, true);
  assert.match(huge.reason, /本机全局预算上限 4\.88 GB/);

  // 预算被显式关闭时只保留约束 A（故障回退路径）
  const off = planAdmission({ budget: { ...budget, enabled: false }, entries: sitting, taskId: "l-2", estimateMb: 800 });
  assert.equal(off.admit, true);
});

test("全局预算：台账预留在预算侧扣减；内存门槛已删除，不存在重复扣减问题", () => {
  const home = join(tmpRoot, "budget-no-double-count");
  writeReservation(home, createReservation({ taskId: "h-held", taskClass: "heavy", reservedMb: 6000 }));

  // 约束 B 独立地看到 6000 已预留：预算 10000 时 6000+6000 = 12000 > 10000 → 排队
  const tight = { ...computeBudget({ cfg, totalMb: 16005 }), budgetMb: 10000, enabled: true };
  const plan = planAdmission({ budget: tight, entries: readReservations(home), taskId: "h-new", estimateMb: 6000 });
  assert.equal(plan.reservedMb, 6000);
  assert.equal(plan.admit, false);
  assert.equal(sumReserved(readReservations(home)), 6000);
});

test("预留台账：写入/读取正常，释放必须校验身份（PID/nonce 不符时拒绝删除）", () => {
  const home = join(tmpRoot, "budget-ledger");
  const entry = createReservation({ taskId: "h-led", taskClass: "heavy", reservedMb: 6000, detached: false });
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
    assert.equal(readReservations(home).length, 1, "拒绝删除后预留必须仍在（否则预算会被错误归还）");
  }

  assert.equal(releaseReservation({ home, entry: readReservation(home, "h-led") }).ok, true);
  assert.equal(readReservations(home).length, 0);
  // 幂等：已不存在的预留再释放一次不算错误
  assert.equal(releaseReservation({ home, entry }).ok, true);
});

test("崩溃残留预留：只有证明旧构建已结束才回收，unknown/detached/子进程存活一律 fail-closed", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const mk = (over = {}) => ({
    taskId: "h-crash", taskClass: "heavy", reservedMb: 6000, ownerPid: 4242,
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
    estimateHeavyMb: 5000, unknownKey: 1, pollMs: "abc", logMaxMb: 12.5,
  }));
  const { config, problems } = loadConfig({ repoRoot: repo, stateHome: join(tmpRoot, "cfg-home"), env: {} });
  assert.equal(config.estimateHeavyMb, 5000);
  assert.equal(config.logMaxMb, 12.5);
  assert.ok(problems.some((p) => p.includes("unknownKey")));
  assert.ok(problems.some((p) => p.includes("pollMs")));
});

test("配置：环境变量覆盖优先于仓库配置", () => {
  const repo = mkWorkspace("cfg-env", null);
  writeFileSync(join(repo, "build-sched.config.json"), JSON.stringify({ estimateHeavyMb: 5000 }));
  const { config, sources } = loadConfig({
    repoRoot: repo, stateHome: join(tmpRoot, "cfg-env-home"),
    env: { TASKDOCK_SCHED_ESTIMATE_HEAVY_MB: "6000" },
  });
  assert.equal(config.estimateHeavyMb, 6000);
  assert.ok(sources.some((s) => s.kind === "env"));
});

test("配置：已删除的内存门槛字段不得重新生效（必须报未知字段）", () => {
  const home = join(tmpRoot, "cfg-gate-removed");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    memoryAdmissionEnabled: false, heavyMinAvailMb: 1, hysteresisMb: 1,
  }));
  const loaded = loadConfig({ stateHome: home, env: {} });
  for (const k of ["memoryAdmissionEnabled", "heavyMinAvailMb", "hysteresisMb"]) {
    assert.ok(loaded.problems.some((p) => p.includes(`未知字段 ${k}`),
      `字段 ${k} 已随门槛删除，写在配置里必须报未知字段而不是静默生效`));
    assert.equal(loaded.config[k], undefined, `${k} 不得再出现在有效配置里`);
  }
  const risks = configRisks({
    config: loaded.config, danger: loaded.danger, sources: loaded.sources, problems: loaded.problems,
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
  //   ② 崩溃回收可能把**活着的**构建的槽位/预算判成可回收（并发超卖）。
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

// ---------------------------------------------------------------- 配置安全（第三轮 4.1-4.4）

function mkState(name, configObj) {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  if (configObj) writeFileSync(join(dir, "config.json"), JSON.stringify(configObj, null, 2));
  return dir;
}

const DANGER_ENV = "TASKDOCK_SCHED_DANGER_AUTH";

test("配置安全：budgetEnabled=false 没有危险授权时必须被忽略", () => {
  const home = mkState("cfg-off-noauth", { budgetEnabled: false });
  const loaded = loadConfig({ stateHome: home, env: {} });
  assert.equal(loaded.config.budgetEnabled, true, "只凭配置文件不得关闭全局预算");
  assert.equal(loaded.danger.budgetOffRequested, true);
  assert.equal(loaded.danger.budgetOffAuthorized, false);
  assert.ok(loaded.problems.some((p) => p.includes("budget-off"), "必须明说缺哪个授权令牌"));
  assert.ok(loaded.danger.blocked.length >= 1);
});

test("配置安全：budget-off 授权生效，且预算证据里能审计到关闭原因", () => {
  const home = mkState("cfg-off-auth", { budgetEnabled: false });
  const loaded = loadConfig({ stateHome: home, env: { [DANGER_ENV]: "budget-off" } });
  assert.equal(loaded.config.budgetEnabled, false);
  assert.equal(loaded.danger.budgetOffAuthorized, true);
  const budget = computeBudget({ cfg: loaded.config, totalMb: 16005 });
  assert.equal(budget.enabled, false);
  assert.equal(budget.budgetOffAuthorized, true);
  assert.deepEqual(budget.dangerAuth, ["budget-off"]);
  const plan = planAdmission({ budget, entries: [], estimateMb: 6000 });
  assert.equal(plan.admit, true, "授权关闭后不再受预算约束");
  assert.equal(plan.budgetEnabled, false, "history 的 budgetAtStart 必须能看出这次是关了预算的");
  assert.match(plan.reason, /危险授权/);
});

test("配置安全：allowReserveBreach 需要独立授权才生效", () => {
  const home = mkState("cfg-breach", { allowReserveBreach: true });
  const denied = loadConfig({ stateHome: home, env: {} });
  assert.equal(denied.config.allowReserveBreach, false, "未授权时不得侵占系统保留");
  const allowed = loadConfig({ stateHome: home, env: { [DANGER_ENV]: "reserve-breach" } });
  assert.equal(allowed.config.allowReserveBreach, true);
  const budget = computeBudget({ cfg: allowed.config, totalMb: 8192 });
  assert.equal(budget.hardLimitMb, 5120);
  assert.equal(budget.budgetMb, 6000);
  assert.equal(budget.reserveBreached, true);
  assert.equal(computeBudget({ cfg: denied.config, totalMb: 8192 }).budgetMb, 5120);
});

test("配置安全：systemReserveMb 低于推荐基线未授权时 fail-closed 回基线", () => {
  const home = mkState("cfg-reserve-low", { systemReserveMb: 1024, recommendedSystemReserveMb: 3072 });
  const denied = loadConfig({ stateHome: home, env: {} });
  assert.equal(denied.config.systemReserveMb, 3072, "有效值必须回到基线，避免安全余量被静默缩小");
  assert.equal(denied.danger.reserveLowerRequested, true);
  assert.equal(denied.danger.reserveLowerAuthorized, false);
  const authorized = loadConfig({ stateHome: home, env: { [DANGER_ENV]: "reserve-lower" } });
  assert.equal(authorized.config.systemReserveMb, 1024, "授权后保留申报值（不改配置文件）");
  const budget = computeBudget({ cfg: authorized.config, totalMb: 8192 });
  assert.equal(budget.reserveReducedMb, 2048, "必须算出实际减少的安全余量");
  assert.equal(budget.hardLimitMb, 7168);
  const risks = configRisks({ config: authorized.config, danger: authorized.danger });
  assert.ok(risks.some((r) => r.key === "systemReserveMb" && r.level === "P1" && r.text.includes("2048")),
    "doctor 必须报「安全余量减少 2048 MB」");
});

test("配置安全：doctor 能抓到 1 MB 预计峰值、关闭预算与环境变量覆盖", () => {
  const home = mkState("cfg-broken", {
    budgetEnabled: false, estimateHeavyMb: 1, estimateMediumMb: 1, estimateLightMb: 1,
  });
  const loaded = loadConfig({
    stateHome: home,
    env: { [DANGER_ENV]: "budget-off", TASKDOCK_SCHED_ESTIMATE_HEAVY_MB: "1" },
  });
  const risks = configRisks({ config: loaded.config, danger: loaded.danger, sources: loaded.sources, problems: loaded.problems });
  const keys = risks.map((r) => r.key);
  assert.ok(keys.includes("budgetEnabled"), "关闭预算必须是风险项");
  assert.ok(risks.some((r) => r.key === "budgetEnabled" && r.level === "P0"));
  for (const k of ["estimateHeavyMb", "estimateMediumMb", "estimateLightMb"]) {
    assert.ok(risks.some((r) => r.key === k && r.level === "P1"), `${k}=1MB 必须报 P1`);
  }
  assert.ok(risks.some((r) => r.key === "env" && r.text.includes("TASKDOCK_SCHED_ESTIMATE_HEAVY_MB")),
    "环境变量覆盖必须被点名");
  assert.ok(risks.every((r) => r.source), "每条风险都要能说出配置来源");
});

test("配置安全：4/8/16/32 GB 档位在「预算关闭 + 保留 0」等极端组合下语义稳定", () => {
  for (const totalMb of [4096, 8192, 16005, 32768]) {
    const normal = computeBudget({ cfg: DEFAULT_CONFIG, totalMb });
    assert.equal(normal.budgetMb, totalMb - DEFAULT_CONFIG.systemReserveMb);
    // systemReserveMb=0 且未授权：有效值必须回到推荐基线（0 不再等于"用满物理内存"）
    const zeroDeniedHome = mkState(`cfg-zero-denied-${totalMb}`, { systemReserveMb: 0 });
    const zeroDenied = computeBudget({ cfg: loadConfig({ stateHome: zeroDeniedHome, env: {} }).config, totalMb });
    assert.equal(zeroDenied.reserveMb, DEFAULT_CONFIG.recommendedSystemReserveMb, "无授权时 0 被 fail-closed 收紧");
    // 授权 reserve-lower 后才允许 0：同时必须算出「安全余量减少 3072 MB」并保留告警
    const zeroAuthHome = mkState(`cfg-zero-auth-${totalMb}`, { systemReserveMb: 0 });
    const zero = computeBudget({ cfg: loadConfig({ stateHome: zeroAuthHome, env: { [DANGER_ENV]: "reserve-lower" } }).config, totalMb });
    assert.equal(zero.reserveMb, 0);
    assert.equal(zero.reserveReducedMb, DEFAULT_CONFIG.recommendedSystemReserveMb, "减少的安全余量必须可计算");
    assert.ok(zero.warning, "systemReserveMb=0 必须继续显式告警");
    const offHome = mkState(`cfg-off2-${totalMb}`, { budgetEnabled: false });
    const off = computeBudget({ cfg: loadConfig({ stateHome: offHome, env: {} }).config, totalMb });
    assert.equal(off.enabled, true, "无授权时配置里的 false 不得生效");
  }
});
test("配置安全：坏 JSON 与未知字段必须被 doctor 报出来，而不是静默忽略", () => {
  const badHome = join(tmpRoot, "cfg-badjson");
  mkdirSync(badHome, { recursive: true });
  writeFileSync(join(badHome, "config.json"), "{ this is not json ");
  const bad = loadConfig({ stateHome: badHome, env: {} });
  assert.ok(bad.problems.some((p) => p.includes("读取失败")), "坏 JSON 必须报读取失败");
  const badRisks = configRisks({ config: bad.config, danger: bad.danger, sources: bad.sources, problems: bad.problems });
  assert.ok(badRisks.some((r) => r.key === "config" && r.level === "P0"));

  const typoHome = mkState("cfg-typo", { estimateHeavyMb: 6000, typpoKey: 1 });
  const typo = loadConfig({ stateHome: typoHome, env: {} });
  assert.ok(typo.problems.some((p) => p.includes("未知字段 typpoKey")), "拼错的字段必须被点名");
  const typoRisks = configRisks({ config: typo.config, danger: typo.danger, sources: typo.sources, problems: typo.problems });
  assert.ok(typoRisks.some((r) => r.key === "unknown" && r.level === "P1"), "未知字段至少 P1");
});