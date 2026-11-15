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
import { resolveStateHome } from "./sched/state.mjs";
import { slotNames, snapshotSlots } from "./sched/lock.mjs";
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
  });
  assert.equal(classifyArgv(["npm", "run", "build"], { cwd: ws }).taskClass, "medium");
  assert.equal(classifyArgv(["npm", "run", "release"], { cwd: ws }).taskClass, "heavy");
  assert.equal(classifyArgv(["npm", "run", "lint"], { cwd: ws }).taskClass, "light");
  assert.equal(classifyArgv(["npm", "run", "watch"], { cwd: ws }).taskClass, "dev");
  assert.equal(classifyArgv(["npm", "run", "build:inner"], { cwd: ws }).taskClass, "medium",
    "脚本互相调用时按最深一层的实际命令判定");
  assert.equal(classifyArgv(["npm", "run", "build"], { cwd: ws }).rule.startsWith("npm-script"), true);
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
