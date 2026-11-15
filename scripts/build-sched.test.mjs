//! 构建调度器单元测试（零依赖，node --test）：不启任何真实构建，只验证判定逻辑。
//! 跨进程/并发/崩溃恢复等行为测试见 scripts/build-sched-acceptance.test.mjs（npm run sched:acceptance）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, loadConfig } from "./sched/config.mjs";
import { classifyArgv, classifyCommandLine, splitCommandLine } from "./sched/classify.mjs";
import { effectivePriority, compareOrder, parsePriority, computeFingerprint } from "./sched/queue.mjs";
import { evaluateMemoryAdmission, memoryFloorForClass, pressureLevel } from "./sched/mem.mjs";
import {
  classifyReservation, computeBudget, createReservation, maxEstimateMb, planAdmission, readReservation,
  readReservations, releaseReservation, setReservationChild, sumReserved, writeReservation,
} from "./sched/budget.mjs";
import { resolveStateHome } from "./sched/state.mjs";
import { slotNames, snapshotSlots, cmdlineSignature } from "./sched/lock.mjs";
import { verifyIdentity } from "./sched/proc.mjs";
import { buildSpawnPlan, resolveExecutable } from "./sched/runner.mjs";
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

// ---------------------------------------------------------------- 内存准入

test("内存准入：16GB 默认阈值下 3GB 可用内存必须挡住重型任务", () => {
  const mem = { availMb: 3072, totalMb: 16000, simulated: true, source: "test" };
  const r = evaluateMemoryAdmission({ cfg, taskClass: "heavy", mem });
  assert.equal(r.admit, false);
  assert.equal(r.floorMb, 6144);
  assert.match(r.reason, /6\.00 GB/);
  assert.match(r.reason, /模拟/);

  const light = evaluateMemoryAdmission({ cfg, taskClass: "light", mem });
  assert.equal(light.admit, true, "3GB 仍可跑轻量任务（门槛 2.5GB）");
});

test("内存准入：恢复后需要多留滞回量才放行", () => {
  const mem = { availMb: 6500, totalMb: 16000, simulated: true, source: "test" };
  assert.equal(evaluateMemoryAdmission({ cfg, taskClass: "heavy", mem, memoryWaitSeen: false }).admit, true);
  const withHysteresis = evaluateMemoryAdmission({ cfg, taskClass: "heavy", mem, memoryWaitSeen: true });
  assert.equal(withHysteresis.admit, false, "等待过内存的任务恢复时需 6GB+1GB");
  assert.equal(
    evaluateMemoryAdmission({ cfg, taskClass: "heavy", mem: { ...mem, availMb: 7500 }, memoryWaitSeen: true }).admit,
    true,
  );
});

test("内存准入：预计峰值也参与下限（未知大任务不能被小门槛放进来）", () => {
  const mem = { availMb: 4200, totalMb: 16000, simulated: true, source: "test" };
  const r = evaluateMemoryAdmission({ cfg, taskClass: "medium", mem, estimateOverrideMb: 5000 });
  assert.equal(r.floorMb, Math.max(cfg.mediumMinAvailMb, 5000));
  assert.equal(r.admit, false);
});

test("内存准入：压力等级与分类门槛一致", () => {
  assert.equal(pressureLevel(cfg, { availMb: 1000 }).level, "critical");
  assert.equal(pressureLevel(cfg, { availMb: 3000 }).level, "elevated");
  assert.equal(pressureLevel(cfg, { availMb: 5000 }).level, "moderate");
  assert.equal(pressureLevel(cfg, { availMb: 9000 }).level, "normal");
  assert.equal(memoryFloorForClass(cfg, "heavy"), 6144);
  assert.equal(memoryFloorForClass(cfg, "light"), 2560);
});

// ---------------------------------------------------------------- 全局预算（跨分类）
//
// 背景（整改前的真实缺口）：旧实现里「准入 = 本分类槽位有空 + 本任务自己的内存门槛达标」，
// 不同分类各自读同一份 os.freemem 快照各自放行 → Heavy(6000)+Medium(3000) 在 7GB 可用时
// 双双合格，合计 9000MB 已经超卖。这一组测试锁定新的两重独立约束。

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
  // 夹取/不夹取都不影响约束 A 的分类门槛
  assert.equal(memoryFloorForClass(cfg, "heavy"), 6144);

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
  const heavyFloor = memoryFloorForClass(cfg, "heavy"); // 约束 A 的分类门槛（6144）
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
    // 约束 A 的分类门槛在任何档位都不变（预算修正不改门槛）
    assert.equal(memoryFloorForClass(cfg, "heavy"), heavyFloor);
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

test("两重约束互不重复扣减：约束 A 只认实时可用内存，不因台账预留而收紧", () => {
  const home = join(tmpRoot, "budget-no-double-count");
  writeReservation(home, createReservation({ taskId: "h-held", taskClass: "heavy", reservedMb: 6000 }));

  const mem = { availMb: 6200, totalMb: 16005, simulated: true, source: "test" };
  // 若把台账预留也扣进约束 A（6200 - 6000 = 200MB），重型任务会被永久挡住——这正是要避免的重复扣减
  assert.equal(evaluateMemoryAdmission({ cfg, taskClass: "heavy", mem }).admit, true);

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
    heavyMinAvailMb: 1024, unknownKey: 1, pollMs: "abc", logMaxMb: 12.5,
  }));
  const { config, problems } = loadConfig({ repoRoot: repo, stateHome: join(tmpRoot, "cfg-home"), env: {} });
  assert.equal(config.heavyMinAvailMb, 1024);
  assert.equal(config.logMaxMb, 12.5);
  assert.ok(problems.some((p) => p.includes("unknownKey")));
  assert.ok(problems.some((p) => p.includes("pollMs")));
});

test("配置：环境变量覆盖优先于仓库配置", () => {
  const repo = mkWorkspace("cfg-env", null);
  writeFileSync(join(repo, "build-sched.config.json"), JSON.stringify({ heavyMinAvailMb: 1024 }));
  const { config, sources } = loadConfig({
    repoRoot: repo, stateHome: join(tmpRoot, "cfg-env-home"),
    env: { TASKDOCK_SCHED_HEAVY_MIN_AVAIL_MB: "2048" },
  });
  assert.equal(config.heavyMinAvailMb, 2048);
  assert.ok(sources.some((s) => s.kind === "env"));
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

test("槽位命名：重型只有 1 个槽位，轻量按配置并行", () => {
  assert.deepEqual(slotNames("heavy", cfg.heavyConcurrency), ["heavy-1"]);
  assert.deepEqual(slotNames("light", cfg.lightConcurrency), ["light-1", "light-2"]);
  assert.deepEqual(snapshotSlots(join(tmpRoot, "no-such-home")), []);
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
