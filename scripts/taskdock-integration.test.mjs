//! 统一集成 / 构建 / 验收台账的自动化用例（node:test，零依赖）。
//!
//! 全部用例在系统临时目录里自建一次性 Git 仓库，不读写本仓库的工作树、
//! 构建缓存或验收证据；每个用例结束删除自己的临时目录。
//!
//!   npm run test:scripts   （或 node --test scripts/taskdock-integration.test.mjs）

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "taskdock-integration.mjs");

// 与 CLI 一致：不同 Agent 的 shell 可能没有把 Git 放进 PATH
function resolveGitBinary() {
  if (process.env.TASKDOCK_GIT && existsSync(process.env.TASKDOCK_GIT)) return process.env.TASKDOCK_GIT;
  const names = process.platform === "win32" ? ["git.exe", "git"] : ["git"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "git";
}

const GIT = resolveGitBinary();
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "taskdock-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "taskdock-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(repo, args) {
  const r = spawnSync(GIT, args, { cwd: repo, encoding: "utf8", env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function run(repo, args, envExtra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: repo, encoding: "utf8", env: { ...ENV, ...envExtra } });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function write(repo, relPath, content) {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** 一次性仓库：base 提交含 README、src/app.txt、src/other.txt 与 emit.mjs（构建桩）。 */
function makeRepo() {
  const home = mkdtempSync(join(tmpdir(), "tdi-"));
  const repo = join(home, "demo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  // 与真实仓库一致：台账/构建产物不入库，避免测试用的 git add -A 把它们扫进交付提交
  write(repo, ".gitignore", "tmp/\nnode_modules/\ndist/\n");
  write(repo, "README.md", "demo repo\n");
  write(repo, "src/app.txt", "app v1\n");
  write(repo, "src/other.txt", "other v1\n");
  write(repo, "src/notes.txt", "notes v1\n");
  write(repo, "emit.mjs", [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    'mkdirSync("dist", { recursive: true });',
    `const head = execFileSync(${JSON.stringify(GIT)}, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();`,
    `const dirty = execFileSync(${JSON.stringify(GIT)}, ["status", "--porcelain"], { encoding: "utf8" }).trim();`,
    'writeFileSync("dist/index.html", "<!doctype html><title>demo</title>\\n");',
    'writeFileSync("dist/result.txt", `head=${head}\\ndirty=${dirty || "clean"}\\n`);',
    "",
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return { home, repo, base: git(repo, ["rev-parse", "HEAD"]) };
}

function commitFile(repo, changes, message) {
  for (const [relPath, content] of Object.entries(changes)) {
    if (content === null) rmSync(join(repo, relPath), { force: true });
    else write(repo, relPath, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function addReadyTask(repo, id, paths, commit, from, extra = []) {
  const r1 = run(repo, ["task", "add", "--id", id, "--owner", `agent-${id}`, "--module", "测试模块", "--paths", paths.join(",")]);
  assert.equal(r1.status, 0, r1.out);
  // 正式集成资格必须来自真实执行（task verify），手动 task check 只作外部证据。
  const r2 = run(repo, ["task", "verify", "--id", id, "--commit", commit, "--cmd", "node emit.mjs"]);
  assert.equal(r2.status, 0, r2.out);
  const readyArgs = ["task", "ready", "--id", id, "--commit", commit, ...extra];
  if (from) readyArgs.push("--from", from);
  const r3 = run(repo, readyArgs);
  assert.equal(r3.status, 0, r3.out);
}

function readSnapshot(repo, id) {
  return JSON.parse(readFileSync(join(repo, "tmp", "integration", "snapshots", `${id}.json`), "utf8"));
}

function readBuild(repo, id) {
  return JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", id, "build.json"), "utf8"));
}

function wtPath(repo) { return join(dirname(repo), `${repo.split(/[\\/]/).pop()}-integration`); }
function buildWtPath(repo) { return join(dirname(repo), `${repo.split(/[\\/]/).pop()}-integration-build`); }
function verifyWtPath(repo) { return join(dirname(repo), `${repo.split(/[\\/]/).pop()}-integration-verify`); }
function identityFile(repo, role) { return join(repo, "tmp", "integration", "worktrees", `${role}.json`); }
function writeJsonFile(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function runAsync(repo, args, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd: repo, env: { ...ENV, ...envExtra }, windowsHide: true });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("close", (status) => resolve({ status, out: output }));
  });
}

// 测试仓库里的“依赖环境”：锁文件 + 依赖段 + 共享 node_modules（真实构建只校验，不执行 npm）。
function addNodeProject(repo, lockText = "lock-v1", { mobile = false } = {}) {
  const root = mobile ? "apps/mobile" : "";
  const prefix = root ? `${root}/` : "";
  write(repo, `${prefix}package.json`, JSON.stringify({ name: "demo", dependencies: { "demo-dep": "1.0.0" } }, null, 2));
  write(repo, `${prefix}package-lock.json`, `{"lockfileVersion":3,"dep":"${lockText}"}\n`);
  write(repo, `${prefix}node_modules/demo-dep/index.js`, "module.exports = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `node project ${root || "root"} ${lockText}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------- 任务与状态机

test("任务交付必须带通过检查，未就绪不得进入集成", () => {
  const { home, repo, base } = makeRepo();
  try {
    assert.equal(run(repo, ["task", "add", "--id", "alpha", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", base]).status, 2);
    assert.equal(run(repo, ["task", "check", "--id", "alpha", "--cmd", "npm test", "--exit", "1"]).status, 2);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", base]).status, 2);
    const commit = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha work");
    // 手动登记（即使 exit 0）只是外部证据，不能单独让任务进入待集成。
    assert.equal(run(repo, ["task", "check", "--id", "alpha", "--cmd", "npm test", "--exit", "0", "--commit", commit]).status, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", commit]).status, 2);
    // 真实执行并绑定同一提交后才算可信检查。
    assert.equal(run(repo, ["task", "verify", "--id", "alpha", "--commit", commit, "--cmd", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", commit]).status, 0);
    const show = run(repo, ["task", "show", "--id", "alpha", "--json"]);
    assert.equal(JSON.parse(show.out).status, "integration-ready");
    assert.equal(JSON.parse(show.out).checks.at(-1).source, "executed");
    // 没有 --base 的首次集成必须拒绝（防止用共享工作区 HEAD 当基线）
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--check", "none"]).status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 集成快照

test("快照只包含选中任务的声明路径，正在开发任务的未提交改动不进入快照", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    const beta = commitFile(repo, { "src/other.txt": "other v2\n" }, "beta");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "beta", ["src/other.txt"], beta);

    // 第三个 Agent 仍在开发：改动只存在于共享工作区，未提交
    write(repo, "src/notes.txt", "notes v2 (in progress)\n");
    write(repo, "src/dev-only.txt", "in progress\n");

    const r = run(repo, ["snapshot", "create", "--tasks", "alpha,beta", "--base", base, "--check", "none"]);
    assert.equal(r.status, 0, r.out);
    const snapId = readSnapshot(repo, "snap-01") ? "snap-01" : null;
    assert.ok(snapId, r.out);
    const snap = readSnapshot(repo, snapId);
    assert.equal(snap.tasks.length, 2);
    assert.deepEqual(snap.tasks.map((t) => t.id).sort(), ["alpha", "beta"]);

    const wt = wtPath(repo);
    assert.equal(git(wt, ["rev-parse", "HEAD"]), snap.commit);
    assert.equal(git(wt, ["status", "--porcelain"]), "", "集成工作区必须干净");
    assert.equal(readFileSync(join(wt, "src/app.txt"), "utf8"), "app v2\n");
    assert.equal(readFileSync(join(wt, "src/other.txt"), "utf8"), "other v2\n");
    // 开发中的改动不得进入快照
    assert.equal(readFileSync(join(wt, "src/notes.txt"), "utf8"), "notes v1\n");
    assert.equal(existsSync(join(wt, "src/dev-only.txt")), false);
    // 共享工作区里的开发改动必须原样保留
    assert.equal(readFileSync(join(repo, "src/notes.txt"), "utf8"), "notes v2 (in progress)\n");

    const body = git(repo, ["log", "-1", "--format=%B", snap.commit]);
    assert.match(body, /TaskDock-Snapshot: snap-01/);
    assert.match(body, new RegExp(`TaskDock-Tasks: alpha=${alpha} beta=${beta}`));
    const tasks = run(repo, ["task", "list", "--json"]);
    assert.equal(JSON.parse(tasks.out).every((t) => t.status === "integrated"), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("两个任务声明同一文件时拒绝同批集成", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    const gamma = commitFile(repo, { "src/app.txt": "app v3\n" }, "gamma");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "gamma", ["src/app.txt"], gamma, null);
    const r = run(repo, ["snapshot", "create", "--tasks", "alpha,gamma", "--base", base, "--check", "none"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /交集/);
    // 顺序集成：先 alpha 后 gamma（gamma 的父提交就是 alpha 提交，补丁可叠加）
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("交付提交包含未声明路径时拒绝，显式放行后真正应用并记录 includedExtraPaths", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n", "src/other.txt": "other v2\n" }, "alpha mixed");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    const rejected = run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]);
    assert.equal(rejected.status, 2, rejected.out);
    assert.match(rejected.out, /未声明路径/);
    const allowed = run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none", "--allow-extra-paths"]);
    assert.equal(allowed.status, 0, allowed.out);
    const snap = readSnapshot(repo, "snap-01");
    assert.equal(snap.includedExtraPaths.length, 1);
    assert.match(snap.includedExtraPaths[0], /src\/other\.txt/);
    // 放行 = 真正应用，不是“只记录不应用”
    assert.equal(readFileSync(join(wtPath(repo), "src/other.txt"), "utf8"), "other v2\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("集成工作区路径被非工作区目录占用时拒绝（不覆盖现场）", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    mkdirSync(wtPath(repo));
    writeFileSync(join(wtPath(repo), "keep.txt"), "别人的目录\n", "utf8");
    const r = run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /不是本仓库的 Worktree/);
    assert.equal(readFileSync(join(wtPath(repo), "keep.txt"), "utf8"), "别人的目录\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 构建

test("构建在干净快照工作区执行，并记录提交、任务与产物校验值", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const snap = readSnapshot(repo, "snap-01");
    // 共享工作区继续弄脏，构建不得受影响
    write(repo, "src/app.txt", "app v2 (uncommitted)\n");

    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(r.status, 0, r.out);
    const build = readBuild(repo, "b01-web-r1");
    assert.equal(build.status, "succeeded");
    assert.equal(build.commit, snap.commit);
    assert.equal(build.shortCommit, snap.commit.slice(0, 7));
    assert.equal(build.dirty, false);
    assert.deepEqual(build.tasks.map((t) => t.id), ["alpha"]);
    assert.equal(build.artifacts.length, 1);
    assert.equal(build.artifacts[0].kind, "dir");
    assert.ok(build.artifacts[0].sha256.length === 64);
    const artifact = readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "artifacts", "dist", "result.txt"), "utf8");
    assert.match(artifact, new RegExp(`head=${snap.commit}`));
    assert.match(artifact, /dirty=clean/);
    assert.equal(run(repo, ["task", "show", "--id", "alpha", "--json"]).out.includes('"verifying"'), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("相同代码快照与配置复用已有构建，不重复执行", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const first = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(first.status, 0, first.out);
    const second = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /复用已有构建/);
    const builds = readdirSync(join(repo, "tmp", "integration", "builds"));
    assert.deepEqual(builds, ["b01-web-r1"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("集成构建工作区不干净时构建拒绝执行", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const buildWt = buildWtPath(repo);
    git(repo, ["worktree", "add", "--detach", buildWt, base]);
    assert.equal(run(repo, ["worktree", "adopt", "--role", "build"]).status, 0);
    writeFileSync(join(buildWt, "scratch.txt"), "未清理的临时文件\n", "utf8");
    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /未提交改动/);
    const record = readBuild(repo, "b01-web-r1");
    assert.equal(record.dirty, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("dry-run 只输出计划，不切换工作区、不写记录", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none", "--dry-run"]).status, 0);
    assert.equal(existsSync(join(repo, "tmp", "integration", "snapshots", "snap-01.json")), false);
    assert.equal(existsSync(wtPath(repo)), false);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "desktop", "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /dry-run/);
    assert.equal(existsSync(join(repo, "tmp", "integration", "builds", "b01-desktop-r1")), false);
    assert.equal(existsSync(buildWtPath(repo)), false, "dry-run 不得创建构建工作区");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 并行验收与返工

test("多个 Agent 基于同一构建各自验收，结论互不覆盖；失败必须写原因", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    const beta = commitFile(repo, { "src/other.txt": "other v2\n" }, "beta");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "beta", ["src/other.txt"], beta);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha,beta", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);

    const pass = run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass", "--evidence", "emit.mjs"]);
    assert.equal(pass.status, 0, pass.out);
    const failNoNote = run(repo, ["accept", "--build", "b01-web-r1", "--task", "beta", "--status", "fail"]);
    assert.equal(failNoNote.status, 2, failNoNote.out);
    const fail = run(repo, ["accept", "--build", "b01-web-r1", "--task", "beta", "--status", "fail", "--note", "拖拽后任务不刷新"]);
    assert.equal(fail.status, 0, fail.out);
    const bad = run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass", "--evidence", "tmp/not-exist.json"]);
    assert.equal(bad.status, 2, bad.out);
    // 不在该构建里的任务不能验收
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "ghost", "--status", "pass"]).status, 1);

    const tasks = JSON.parse(run(repo, ["task", "list", "--json"]).out);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    assert.equal(byId.alpha.status, "accept-passed");
    assert.equal(byId.beta.status, "accept-failed");
    const records = readdirSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "acceptance"));
    assert.deepEqual(records.sort(), ["alpha.json", "beta.json"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("验收失败后修复 → 增量集成 → 新构建 → 复验通过（旧构建记录保留）", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    const beta = commitFile(repo, { "src/other.txt": "other v2\n" }, "beta");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "beta", ["src/other.txt"], beta);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha,beta", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "beta", "--status", "fail", "--note", "滚动位置丢失"]).status, 0);

    // 负责人修复：在上一交付提交之上追加修复提交，只声明修复文件
    write(repo, "src/other.txt", "other v2 (fixed)\n");
    write(repo, "src/notes.txt", "notes v2 (dev in progress)\n"); // 另一个任务仍在开发
    git(repo, ["add", "src/other.txt"]);
    git(repo, ["commit", "-q", "-m", "beta fix"]);
    const fix = git(repo, ["rev-parse", "HEAD"]);
    assert.equal(run(repo, ["task", "verify", "--id", "beta", "--commit", fix, "--cmd", "node emit.mjs"]).status, 0);
    const ready = run(repo, ["task", "ready", "--id", "beta", "--commit", fix, "--from", beta]);
    assert.equal(ready.status, 0, ready.out);

    const snap2 = run(repo, ["snapshot", "create", "--tasks", "beta", "--check", "none"]);
    assert.equal(snap2.status, 0, snap2.out);
    const snap = readSnapshot(repo, "snap-02");
    assert.equal(snap.base, readSnapshot(repo, "snap-01").commit, "第二个快照必须叠在上一个快照上");
    assert.deepEqual(snap.tasks.map((t) => t.id), ["beta"]);
    assert.equal(readFileSync(join(wtPath(repo), "src/other.txt"), "utf8"), "other v2 (fixed)\n");
    assert.equal(readFileSync(join(wtPath(repo), "src/notes.txt"), "utf8"), "notes v1\n", "开发中任务不得混入");

    // 旧构建仍可用；新构建是新记录
    const reuseOld = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(reuseOld.status, 0, reuseOld.out);
    assert.match(reuseOld.out, /复用已有构建/);
    const build2 = run(repo, ["build", "--snapshot", "snap-02", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(build2.status, 0, build2.out);
    const b2 = readBuild(repo, "b02-web-r1");
    assert.equal(b2.commit, snap.commit);
    assert.equal(snap.baseSnapshot, "snap-01", "增量快照应记录父快照");
    assert.deepEqual(b2.snapshotChain, ["snap-01", "snap-02"], "构建应记录快照链");
    assert.deepEqual(
      b2.includedTasks.map((t) => t.id).sort(),
      ["alpha", "beta"],
      "构建应能直接列出累计包含的全部任务，而不只本批增量",
    );
    // 旧构建不能给新版本写验收结论
    const stale = run(repo, ["accept", "--build", "b01-web-r1", "--task", "beta", "--status", "pass"]);
    assert.equal(stale.status, 2, stale.out);
    assert.match(stale.out, /快照|旧构建/);
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "beta", "--status", "pass"]).status, 0);
    const betaTask = JSON.parse(run(repo, ["task", "show", "--id", "beta", "--json"]).out);
    assert.equal(betaTask.status, "accept-passed");
    assert.equal(betaTask.build, "b02-web-r1");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("基线快照只登记稳定提交，不叠加任务；后续快照以它为基线", () => {
  const { home, repo, base } = makeRepo();
  try {
    assert.equal(run(repo, ["snapshot", "bootstrap"]).status, 1);
    assert.equal(run(repo, ["snapshot", "bootstrap", "--base", base]).status, 0);
    const boot = readSnapshot(repo, "snap-01");
    assert.equal(boot.commit, base);
    assert.deepEqual(boot.tasks, []);
    assert.equal(boot.bootstrap, true);
    assert.equal(run(repo, ["snapshot", "bootstrap", "--base", base]).status, 2, "基线只能建立一次");

    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    const create = run(repo, ["snapshot", "create", "--tasks", "alpha", "--check", "none"]);
    assert.equal(create.status, 0, create.out);
    assert.equal(readSnapshot(repo, "snap-02").base, base);
    const built = run(repo, ["build", "--snapshot", "snap-02", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(built.status, 0, built.out);
    assert.equal(readBuild(repo, "b02-web-r1").commit, readSnapshot(repo, "snap-02").commit);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("基线构建失败且无任务集成时，可 --force 重新登记基线（旧记录保留）", () => {
  const { home, repo, base } = makeRepo();
  try {
    assert.equal(run(repo, ["snapshot", "bootstrap", "--base", base]).status, 0);
    const failed = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web",
      "--command", "git rev-parse --verify definitely-not-a-ref"]);
    assert.equal(failed.status, 3, failed.out);
    assert.equal(readBuild(repo, "b01-web-r1").status, "failed");

    const later = commitFile(repo, { "docs/notes.md": "notes\n" }, "later");
    assert.equal(run(repo, ["snapshot", "bootstrap", "--base", later]).status, 2, "无 --force 必须拒绝");
    const rebased = run(repo, ["snapshot", "bootstrap", "--base", later, "--force"]);
    assert.equal(rebased.status, 0, rebased.out);
    const snap2 = readSnapshot(repo, "snap-02");
    assert.equal(snap2.commit, later);
    assert.equal(snap2.replaces, "snap-01");
    assert.equal(readSnapshot(repo, "snap-01").commit, base, "旧基线记录保留");

    const built = run(repo, ["build", "--snapshot", "snap-02", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(built.status, 0, built.out);
    assert.equal(readBuild(repo, "b02-web-r1").snapshot, "snap-02");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("零产物构建记为失败，任务不会进入待验收", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "git rev-parse --verify HEAD"]);
    assert.equal(r.status, 3, r.out);
    const build = readBuild(repo, "b01-web-r1");
    assert.equal(build.status, "failed");
    assert.equal(build.artifacts.length, 0);
    assert.match(build.reason, /产物/);
    const task = JSON.parse(run(repo, ["task", "show", "--id", "alpha", "--json"]).out);
    assert.equal(task.status, "integrated");
    const accept = run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass"]);
    assert.equal(accept.status, 2, accept.out);
    assert.match(accept.out, /待验收|可用构建/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("失败构建不能写 pass/fail，且 dry-run 不创建构建工作区", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "git rev-parse --verify definitely-not-a-ref"]);
    assert.equal(r.status, 3, r.out);
    assert.equal(readBuild(repo, "b01-web-r1").status, "failed");
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass"]).status, 2);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "fail", "--note", "构建本身失败"]).status, 2);
    assert.equal(existsSync(buildWtPath(repo)), true, "真实构建应使用独立构建工作区");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("同一类集成操作受锁保护，dry-run 不受锁影响", () => {
  const { home, repo, base } = makeRepo();
  try {
    assert.equal(run(repo, ["snapshot", "bootstrap", "--base", base]).status, 0);
    const lockPath = join(repo, "tmp", "integration", ".build.lock");
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, token: "test-lock", startedAt: new Date().toISOString(), command: "test",
    }) + "\n", "utf8");
    const blocked = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"], { TASKDOCK_BUILD_LOCK_WAIT_MS: "0" });
    assert.equal(blocked.status, 2, blocked.out);
    assert.match(blocked.out, /另一个集成操作正在运行/);
    const dry = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--dry-run", "--command", "node emit.mjs"]);
    assert.equal(dry.status, 0, dry.out);
    assert.equal(existsSync(buildWtPath(repo)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("快照失败保留失败记录，不写入快照台账也不推进分支", () => {
  const { home, repo, base } = makeRepo();
  try {
    assert.equal(run(repo, ["snapshot", "bootstrap", "--base", base]).status, 0);
    const c = commitFile(repo, { "src/app.txt": "app v2\n" }, "task change");
    addReadyTask(repo, "snapshot-fail", ["src/app.txt"], c);
    const r = run(repo, ["snapshot", "create", "--tasks", "snapshot-fail", "--check", "static"]);
    assert.ok([2, 3].includes(r.status), r.out);
    assert.equal(existsSync(join(repo, "tmp", "integration", "snapshots", "snap-02.json")), false);
    const failure = JSON.parse(readFileSync(join(repo, "tmp", "integration", "logs", "snap-02-failure.json"), "utf8"));
    assert.equal(failure.status, "failed");
    assert.equal(failure.base, base);
    assert.equal(failure.tasks[0].id, "snapshot-fail");
    assert.equal(git(repo, ["rev-parse", "--verify", "refs/heads/integration"]), base);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("写入范围变更后旧交付提交不能直接重新进入待集成", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    const update = run(repo, ["task", "update", "--id", "alpha", "--paths", "src/other.txt"]);
    assert.equal(update.status, 0, update.out);
    const task = JSON.parse(run(repo, ["task", "show", "--id", "alpha", "--json"]).out);
    assert.equal(task.status, "developing");
    assert.equal(task.commit, null);
    assert.equal(task.checks.length, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", alpha]).status, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("needs 依赖先于被依赖任务应用", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    const beta = commitFile(repo, { "src/other.txt": "other v2\n" }, "beta");
    const add = (id, paths, commit, needs = []) => {
      const r = run(repo, ["task", "add", "--id", id, "--owner", id, "--module", "m", "--paths", paths, ...(needs.length ? ["--needs", needs.join(",")] : [])]);
      assert.equal(r.status, 0, r.out);
      assert.equal(run(repo, ["task", "verify", "--id", id, "--commit", commit, "--cmd", "node emit.mjs"]).status, 0);
      assert.equal(run(repo, ["task", "ready", "--id", id, "--commit", commit]).status, 0);
    };
    add("alpha", "src/app.txt", alpha);
    add("beta", "src/other.txt", beta, ["alpha"]);
    const r = run(repo, ["snapshot", "create", "--tasks", "beta,alpha", "--base", base, "--check", "none"]);
    assert.equal(r.status, 0, r.out);
    const snap = readSnapshot(repo, "snap-01");
    assert.deepEqual(snap.tasks.map((t) => t.id), ["alpha", "beta"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("status --json 汇总任务、快照、构建与验收记录", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass"]).status, 0);
    const payload = JSON.parse(run(repo, ["status", "--json"]).out);
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.snapshots.length, 1);
    assert.equal(payload.builds.length, 1);
    assert.equal(payload.acceptance.length, 1);
    assert.match(payload.integrationWorktree, /demo-integration$/);
    assert.match(payload.buildWorktree, /demo-integration-build$/);
    const human = run(repo, ["status"]);
    assert.equal(human.status, 0);
    assert.match(human.out, /验收通过/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("已集成任务没有新交付提交时不重复集成", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const again = run(repo, ["snapshot", "create", "--tasks", "alpha", "--check", "none"]);
    assert.equal(again.status, 2, again.out);
    assert.match(again.out, /无需重复集成/);
    const allReady = run(repo, ["snapshot", "create", "--all-ready", "--check", "none"]);
    assert.equal(allReady.status, 1, allReady.out);
    assert.match(allReady.out, /待集成队列为空/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P1-01 工作区身份

test("工具工作区缺少身份记录 / 被篡改 / 非工具 Worktree 时拒绝，且不重置现场", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const beta = commitFile(repo, { "src/other.txt": "other v2\n" }, "beta");
    addReadyTask(repo, "beta", ["src/other.txt"], beta);
    const wt = wtPath(repo);
    const before = git(wt, ["rev-parse", "HEAD"]);
    write(wt, "sentinel-other-agent.txt", "must survive\n");
    rmSync(identityFile(repo, "snapshot"));

    const rejected = run(repo, ["snapshot", "create", "--tasks", "beta", "--check", "none"]);
    assert.equal(rejected.status, 2, rejected.out);
    assert.match(rejected.out, /缺少身份记录/);
    assert.equal(git(wt, ["rev-parse", "HEAD"]), before, "缺身份时不得切换/重置工作区");
    assert.equal(readFileSync(join(wt, "sentinel-other-agent.txt"), "utf8"), "must survive\n");

    rmSync(join(wt, "sentinel-other-agent.txt"));
    assert.equal(run(repo, ["worktree", "adopt", "--role", "snapshot"]).status, 0);
    const status = run(repo, ["worktree", "status"]);
    assert.equal(status.status, 0, status.out);
    assert.match(status.out, /snapshot:[\s\S]*身份有效/);

    // 篡改身份记录（改路径）必须被校验和拦住
    const identity = JSON.parse(readFileSync(identityFile(repo, "snapshot"), "utf8"));
    identity.path = repo;
    writeJsonFile(identityFile(repo, "snapshot"), identity);
    const tampered = run(repo, ["snapshot", "create", "--tasks", "beta", "--check", "none"]);
    assert.equal(tampered.status, 2, tampered.out);
    assert.match(tampered.out, /校验和不匹配|路径/);

    // 主工作区不能被登记为工具工作区
    assert.equal(run(repo, ["worktree", "adopt", "--role", "snapshot", "--path", repo]).status, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("预设路径被普通 Agent Worktree 占用时拒绝，不切分支不清理", () => {
  const { home, repo, base } = makeRepo();
  try {
    const wt = wtPath(repo);
    git(repo, ["worktree", "add", "-b", "agent-work", wt]);
    write(wt, "src/app.txt", "agent work in progress\n");
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    const r = run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /不是本仓库的 Worktree|必须挂在 integration 分支|缺少身份记录/);
    assert.equal(readFileSync(join(wt, "src/app.txt"), "utf8"), "agent work in progress\n");
    const branch = git(repo, ["worktree", "list", "--porcelain"]);
    assert.match(branch, /branch refs\/heads\/agent-work/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("构建工作区缺身份记录时拒绝构建；adopt 后可继续，旧产物保留", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    const artifact = join(repo, "tmp", "integration", "builds", "b01-web-r1", "artifacts", "dist", "index.html");
    assert.equal(existsSync(artifact), true);
    const bwt = buildWtPath(repo);
    rmSync(identityFile(repo, "build"));
    const refused = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs", "--force"]);
    assert.equal(refused.status, 2, refused.out);
    assert.match(refused.out, /缺少身份记录/);
    assert.equal(existsSync(artifact), true, "拒绝构建不能删除已有产物");
    assert.equal(run(repo, ["worktree", "adopt", "--role", "build"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs", "--force"]).status, 0);
    assert.equal(existsSync(join(bwt, "dist", "index.html")), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P1-02 依赖一致性

test("依赖一致才复用 junction；主工作区 lock 变化后已存在 junction 仍被重新校验拒绝", () => {
  const { home, repo, base } = makeRepo();
  try {
    const lockCommit = addNodeProject(repo, "lock-v1");
    assert.equal(run(repo, ["task", "add", "--id", "alpha", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    assert.equal(run(repo, ["task", "verify", "--id", "alpha", "--commit", lockCommit, "--cmd", "node emit.mjs"]).status, 0);
    const vwt = verifyWtPath(repo);
    const nm = join(vwt, "node_modules");
    assert.equal(existsSync(join(nm, "demo-dep", "index.js")), true);
    assert.equal(existsSync(join(vwt, ".taskdock-deps.json")), true);

    // 主工作区未提交地改了 lock：代码提交没变，但依赖已经不是同一套
    write(repo, "package-lock.json", '{"lockfileVersion":3,"dep":"lock-v2"}\n');
    const r = run(repo, ["task", "verify", "--id", "alpha", "--commit", lockCommit, "--cmd", "node emit.mjs"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /依赖.*不一致/);
    assert.equal(existsSync(nm), true, "拒绝时必须保留已存在的依赖链接，不能静默删除");

    // 独立 node_modules 缺少 marker 时也拒绝（依赖本身恢复一致，排除指纹差异干扰）
    write(repo, "package-lock.json", '{"lockfileVersion":3,"dep":"lock-v1"}\n');
    rmSync(nm, { recursive: true, force: true });
    mkdirSync(join(nm, "demo-dep"), { recursive: true });
    writeFileSync(join(nm, "demo-dep", "index.js"), "module.exports = 2;\n");
    const independent = run(repo, ["task", "verify", "--id", "alpha", "--commit", lockCommit, "--cmd", "node emit.mjs"]);
    assert.equal(independent.status, 2, independent.out);
    assert.match(independent.out, /缺少匹配的安装记录/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("移动端依赖与桌面依赖分别校验，不共用同一个指纹", () => {
  const { home, repo, base } = makeRepo();
  try {
    addNodeProject(repo, "root-v1");
    const mobileCommit = addNodeProject(repo, "mobile-v1", { mobile: true });
    assert.equal(run(repo, ["task", "add", "--id", "mobile", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    assert.equal(run(repo, ["task", "verify", "--id", "mobile", "--commit", mobileCommit, "--cmd", "node emit.mjs"]).status, 0);
    assert.equal(existsSync(join(verifyWtPath(repo), "apps", "mobile", "node_modules", "demo-dep", "index.js")), true);

    write(repo, "apps/mobile/package-lock.json", '{"lockfileVersion":3,"dep":"mobile-v2"}\n');
    const r = run(repo, ["task", "verify", "--id", "mobile", "--commit", mobileCommit, "--cmd", "node emit.mjs"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /apps\/mobile|（apps\/mobile）/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P1-03 台账并发

test("任务锁 fail-closed：死亡进程锁可回收，活跃进程的旧锁绝不按时间回收", () => {
  const { home, repo } = makeRepo();
  try {
    assert.equal(run(repo, ["task", "add", "--id", "alpha", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    const lock = join(repo, "tmp", "integration", ".task-alpha.lock");
    writeJsonFile(lock, { pid: 2147483646, token: "dead", startedAt: "2000-01-01T00:00:00.000Z", command: "crash" });
    utimesSync(lock, new Date(0), new Date(0));
    const r1 = run(repo, ["task", "update", "--id", "alpha", "--note", "after-crash"], { TASKDOCK_TASK_LOCK_WAIT_MS: "500" });
    assert.equal(r1.status, 0, r1.out);
    assert.equal(existsSync(lock), false);

    // 活跃 PID + 20 年前的锁：年龄不能成为回收理由
    const lock2 = join(repo, "tmp", "integration", ".task-alpha.lock");
    writeJsonFile(lock2, { pid: process.pid, token: "live", startedAt: "2000-01-01T00:00:00.000Z", command: "active" });
    utimesSync(lock2, new Date(0), new Date(0));
    const r2 = run(repo, ["task", "update", "--id", "alpha", "--note", "blocked"], { TASKDOCK_TASK_LOCK_WAIT_MS: "300" });
    assert.equal(r2.status, 2, r2.out);
    assert.match(r2.out, /不会因为锁“太旧”而回收/);
    assert.equal(existsSync(lock2), true, "活跃进程的锁必须保留");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("五进程同时更新五个不同任务，记录与修订号不丢失", async () => {
  const { home, repo } = makeRepo();
  try {
    const ids = ["t1", "t2", "t3", "t4", "t5"];
    for (const id of ids) {
      assert.equal(run(repo, ["task", "add", "--id", id, "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    }
    const results = await Promise.all(ids.map((id) =>
      runAsync(repo, ["task", "update", "--id", id, "--note", `note-${id}`])));
    for (const r of results) assert.equal(r.status, 0, r.out);
    for (const id of ids) {
      const task = JSON.parse(fsReadTask(repo, id));
      assert.equal(task.rev, 2);
      assert.equal(task.notes, `note-${id}`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("两进程同时更新同一任务：串行化且不丢修订", async () => {
  const { home, repo } = makeRepo();
  try {
    assert.equal(run(repo, ["task", "add", "--id", "alpha", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    const [a, b] = await Promise.all([
      runAsync(repo, ["task", "update", "--id", "alpha", "--note", "from-A"]),
      runAsync(repo, ["task", "update", "--id", "alpha", "--note", "from-B"]),
    ]);
    assert.equal(a.status, 0, a.out);
    assert.equal(b.status, 0, b.out);
    const task = JSON.parse(fsReadTask(repo, "alpha"));
    assert.ok(task.rev >= 3, `rev=${task.rev}`);
    assert.ok(["from-A", "from-B"].includes(task.notes));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("五进程并发写同一任务的检查记录：任务锁串行，不丢任何一条", async () => {
  const { home, repo } = makeRepo();
  try {
    assert.equal(run(repo, ["task", "add", "--id", "alpha", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) =>
      runAsync(repo, ["task", "check", "--id", "alpha", "--cmd", `check-${i}`, "--exit", "0"])));
    for (const r of results) assert.equal(r.status, 0, r.out);
    const task = JSON.parse(fsReadTask(repo, "alpha"));
    assert.equal(task.checks.length, 5);
    assert.equal(task.rev, 6);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("task update 与 snapshot create 竞争：锁内重新读取，任务状态与备注不被旧快照覆盖", async () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    const [snap, upd] = await Promise.all([
      runAsync(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]),
      runAsync(repo, ["task", "update", "--id", "alpha", "--note", "concurrent-note"]),
    ]);
    assert.equal(snap.status, 0, snap.out);
    assert.equal(upd.status, 0, upd.out);
    const task = JSON.parse(fsReadTask(repo, "alpha"));
    assert.equal(task.status, "integrated");
    assert.equal(task.notes, "concurrent-note");
    assert.equal(readSnapshot(repo, "snap-01").tasks[0].id, "alpha");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("两个进程并发构建同一快照：只产生一个构建，第二个复用", async () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const args = ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"];
    const [a, b] = await Promise.all([runAsync(repo, args), runAsync(repo, args)]);
    assert.equal(a.status, 0, a.out);
    assert.equal(b.status, 0, b.out);
    const builds = readdirSync(join(repo, "tmp", "integration", "builds")).filter((n) => n.startsWith("b01-web-r"));
    assert.equal(builds.length, 1, `builds=${builds.join(",")}`);
    assert.match(a.out + b.out, /复用/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P1-04 真实检查

test("task verify 真实执行并绑定提交；失败命令写记录但不得 ready", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, {
      "src/app.txt": "app v2\n",
      "fail-check.mjs": "process.exit(1);\n",
    }, "alpha");
    assert.equal(run(repo, ["task", "add", "--id", "alpha", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    const fail = run(repo, ["task", "verify", "--id", "alpha", "--commit", alpha, "--cmd", "node fail-check.mjs"]);
    assert.equal(fail.status, 2, fail.out);
    let task = JSON.parse(fsReadTask(repo, "alpha"));
    assert.equal(task.checks.at(-1).source, "executed");
    assert.equal(task.checks.at(-1).exitCode, 1);
    assert.match(task.checks.at(-1).logPath, /tmp\/integration\/logs\/verify-alpha-/);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", alpha]).status, 2);

    assert.equal(run(repo, ["task", "verify", "--id", "alpha", "--commit", alpha, "--cmd", "node emit.mjs"]).status, 0);
    task = JSON.parse(fsReadTask(repo, "alpha"));
    assert.equal(task.checks.at(-1).exitCode, 0);
    assert.equal(task.checks.at(-1).commit, alpha);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", alpha]).status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("task verify 拒绝与任务当前交付提交不一致的提交", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    const other = commitFile(repo, { "src/other.txt": "other v2\n" }, "other");
    const r = run(repo, ["task", "verify", "--id", "alpha", "--commit", other, "--cmd", "node emit.mjs"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /不一致/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- P2 额外路径 / 复用 / 缓存

test("--allow-extra-paths 的额外路径参与交集判定，并进入快照与构建溯源", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n", "src/extra.txt": "extra from alpha\n" }, "alpha");
    const beta = commitFile(repo, { "src/extra.txt": "extra from beta\n" }, "beta");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "beta", ["src/extra.txt"], beta);
    const overlap = run(repo, ["snapshot", "create", "--tasks", "alpha,beta", "--base", base, "--check", "none", "--allow-extra-paths"]);
    assert.equal(overlap.status, 2, overlap.out);
    assert.match(overlap.out, /额外.*↔|↔.*声明|交集/);

    // 只集成 alpha：额外路径真正进入快照，并在构建记录里可追溯
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none", "--allow-extra-paths"]).status, 0);
    assert.deepEqual(readSnapshot(repo, "snap-01").includedExtraPaths, ["alpha: src/extra.txt"]);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    const build = readBuild(repo, "b01-web-r1");
    assert.deepEqual(build.tasks[0].extraPaths, ["src/extra.txt"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("复用键覆盖依赖/工具链指纹；旧记录或产物被改都不复用", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const args = ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"];
    assert.equal(run(repo, args).status, 0);
    const b1 = readBuild(repo, "b01-web-r1");
    assert.match(b1.reuseKey, new RegExp(`\\|${b1.inputsDigest}$`));
    assert.equal(b1.arch, process.arch);

    // 模拟旧工具产生的记录（没有输入指纹）
    b1.reuseKey = `${b1.commit}|web|frontend-dist`;
    delete b1.inputsDigest;
    writeJsonFile(join(repo, "tmp", "integration", "builds", "b01-web-r1", "build.json"), b1);
    const again = run(repo, args);
    assert.equal(again.status, 0, again.out);
    assert.doesNotMatch(again.out, /复用已有构建/);
    assert.equal(existsSync(join(repo, "tmp", "integration", "builds", "b01-web-r2")), true);

    // 产物被篡改后必须重新构建，而不是凭 build.json 说成功就复用
    const artifact = join(repo, "tmp", "integration", "builds", "b01-web-r2", "artifacts", "dist", "index.html");
    writeFileSync(artifact, "<!doctype html><title>tampered</title>\n");
    const tampered = run(repo, args);
    assert.equal(tampered.status, 0, tampered.out);
    assert.equal(existsSync(join(repo, "tmp", "integration", "builds", "b01-web-r3")), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("build-guard register 失败时拒绝构建并保留错误", () => {
  const { home, repo } = makeRepo();
  try {
    const guard = "import process from \"node:process\";\nprocess.exit(1);\n";
    const base = commitFile(repo, { "scripts/build-guard.mjs": guard }, "guard stub");
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "desktop", "--command", "node emit.mjs"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /build-guard register 失败/);
    const record = readBuild(repo, "b01-desktop-r1");
    assert.equal(record.status, "failed");
    assert.match(record.reason, /build-guard register 失败/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function fsReadTask(repo, id) {
  return readFileSync(join(repo, "tmp", "integration", "tasks", `${id}.json`), "utf8");
}

// ---------------------------------------------------------------- 第三轮：合批与跨快照验收

test("batch plan 只读、按 min-ready 合批，不创建快照/构建", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    const beta = commitFile(repo, { "src/other.txt": "other v2\n" }, "beta");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "beta", ["src/other.txt"], beta);

    const before = run(repo, ["batch", "plan", "--platform", "web", "--json"]);
    assert.equal(before.status, 0, before.out);
    const pre = JSON.parse(before.out);
    assert.equal(pre.readOnly, true);
    assert.equal(pre.latestSnapshot, null);
    assert.equal(pre.counts.ready, 2);
    assert.equal(pre.recommendation.build, false);
    assert.equal(existsSync(join(repo, "tmp", "integration", "snapshots", "snap-01.json")), false);
    assert.deepEqual(existsSync(join(repo, "tmp", "integration", "builds"))
      ? readdirSync(join(repo, "tmp", "integration", "builds")) : [], []);

    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha,beta", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    const gamma = commitFile(repo, { "src/notes.txt": "notes v2\n" }, "gamma");
    addReadyTask(repo, "gamma", ["src/notes.txt"], gamma);

    const snapshotsBefore = readdirSync(join(repo, "tmp", "integration", "snapshots")).filter((f) => f.endsWith(".json")).length;
    const buildsBefore = readdirSync(join(repo, "tmp", "integration", "builds")).length;
    const after = run(repo, ["batch", "plan", "--platform", "web", "--json"]);
    assert.equal(after.status, 0, after.out);
    const plan = JSON.parse(after.out);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.latestSnapshot.id, "snap-01");
    assert.equal(plan.latestSnapshot.tasks, 2);
    assert.deepEqual(plan.newTasks.map((t) => t.id), ["gamma"]);
    assert.equal(plan.counts.pendingAcceptance, 2);
    assert.equal(plan.recommendation.build, false);
    assert.match(plan.recommendation.reason, /低于 min-ready=2/);
    assert.ok(plan.reuse);
    assert.equal(plan.latestBuild.id, "b01-web-r1");
    assert.equal(readdirSync(join(repo, "tmp", "integration", "snapshots")).filter((f) => f.endsWith(".json")).length, snapshotsBefore);
    assert.equal(readdirSync(join(repo, "tmp", "integration", "builds")).length, buildsBefore);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("batch plan 标记同一路径冲突，冲突任务不进入可合批集合", () => {
  const { home, repo } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app alpha\n" }, "alpha");
    const beta = commitFile(repo, { "src/app.txt": "app beta\n" }, "beta");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "beta", ["src/app.txt"], beta);
    const r = run(repo, ["batch", "plan", "--platform", "web", "--json"]);
    assert.equal(r.status, 0, r.out);
    const plan = JSON.parse(r.out);
    assert.equal(plan.counts.eligibleReady, 0);
    assert.equal(plan.recommendation.build, false);
    assert.equal(plan.blocked.length >= 2, true, JSON.stringify(plan.blocked));
    assert.match(JSON.stringify(plan.blocked), /写入范围冲突/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("六 Agent 一次合批：六任务同快照、一次正式构建、六份共享 buildId 验收", () => {
  const { home, repo, base } = makeRepo();
  try {
    const ids = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"];
    for (const id of ids) {
      const commit = commitFile(repo, { [`src/${id}.txt`]: `${id} v1\n` }, id);
      addReadyTask(repo, id, [`src/${id}.txt`], commit);
    }
    const pre = JSON.parse(run(repo, ["batch", "plan", "--platform", "web", "--json"]).out);
    assert.equal(pre.recommendation.build, false);
    assert.match(pre.recommendation.reason, /尚无集成快照|bootstrap/);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", ids.join(","), "--base", base, "--check", "none"]).status, 0);
    const plan = JSON.parse(run(repo, ["batch", "plan", "--platform", "web", "--json"]).out);
    assert.equal(plan.recommendation.build, true);
    assert.equal(plan.counts.pendingAcceptance, 6);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--mode", "batch", "--command", "node emit.mjs"]).status, 0);
    assert.equal(readdirSync(join(repo, "tmp", "integration", "builds")).filter((n) => n.startsWith("b01-web")).length, 1);
    const build = readBuild(repo, "b01-web-r1");
    assert.equal(build.tasks.length, 6);
    assert.deepEqual(build.includedTasks.map((t) => t.id).sort(), ids.slice().sort());
    for (const id of ids) {
      const r = run(repo, ["accept", "--build", "b01-web-r1", "--task", id, "--status", "pass", "--agent", `verifier-${id}`]);
      assert.equal(r.status, 0, r.out);
      const rec = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "acceptance", `${id}.json`), "utf8"));
      assert.equal(rec.build, "b01-web-r1");
      assert.equal(rec.kind, "first");
    }
    const cov = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "coverage.json"), "utf8"));
    assert.equal(cov.plannedAcceptance, 6);
    assert.equal(cov.completedAcceptance, 6);
    assert.equal(cov.pass, 6);
    assert.equal(cov.firstAcceptance, 6);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("分批完成：A/B/C 先批构建，D/E/F 后批增量，新构建累计六任务", () => {
  const { home, repo, base } = makeRepo();
  try {
    const first = ["wave-a", "wave-b", "wave-c"].map((id) => {
      const commit = commitFile(repo, { [`src/${id}.txt`]: `${id} v1\n` }, id);
      addReadyTask(repo, id, [`src/${id}.txt`], commit);
      return id;
    });
    assert.equal(run(repo, ["snapshot", "create", "--tasks", first.join(","), "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    const second = ["wave-d", "wave-e", "wave-f"].map((id) => {
      const commit = commitFile(repo, { [`src/${id}.txt`]: `${id} v1\n` }, id);
      addReadyTask(repo, id, [`src/${id}.txt`], commit);
      return id;
    });
    const plan = JSON.parse(run(repo, ["batch", "plan", "--platform", "web", "--json"]).out);
    assert.equal(plan.recommendation.build, true);
    assert.deepEqual(plan.newTasks.map((t) => t.id).sort(), second.slice().sort());
    assert.equal(run(repo, ["snapshot", "create", "--tasks", second.join(","), "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-02", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    const b2 = readBuild(repo, "b02-web-r1");
    assert.deepEqual(b2.includedTasks.map((t) => t.id).sort(), [...first, ...second].sort());
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "wave-a", "--status", "pass"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "wave-d", "--status", "pass"]).status, 0);
    const recA = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b02-web-r1", "acceptance", "wave-a.json"), "utf8"));
    assert.equal(recA.kind, "regression");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("五进程同时请求同一快照构建：只实际构建一次，其余复用同一 buildId", async () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v5\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const args = ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"];
    const results = await Promise.all(Array.from({ length: 5 }, () => runAsync(repo, args, { TASKDOCK_BUILD_LOCK_WAIT_MS: "120000" })));
    for (const r of results) assert.equal(r.status, 0, r.out);
    const dirs = readdirSync(join(repo, "tmp", "integration", "builds")).filter((n) => n.startsWith("b01-web"));
    assert.deepEqual(dirs, ["b01-web-r1"]);
    assert.equal(results.filter((r) => /复用/.test(r.out)).length >= 4, true, JSON.stringify(results.map((r) => r.out)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("一个修复批次：两个验收失败任务一次增量快照/一次构建，旧失败记录保留", () => {
  const { home, repo, base } = makeRepo();
  try {
    const a0 = commitFile(repo, { "src/app.txt": "app before fix\n" }, "a0");
    const b0 = commitFile(repo, { "src/other.txt": "other before fix\n" }, "b0");
    addReadyTask(repo, "fix-a", ["src/app.txt"], a0);
    addReadyTask(repo, "fix-b", ["src/other.txt"], b0);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "fix-a,fix-b", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "fix-a", "--status", "fail", "--note", "A 失败"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "fix-b", "--status", "fail", "--note", "B 失败"]).status, 0);

    const a1 = commitFile(repo, { "src/app.txt": "app fixed\n" }, "a fix");
    const b1 = commitFile(repo, { "src/other.txt": "other fixed\n" }, "b fix");
    assert.equal(run(repo, ["task", "verify", "--id", "fix-a", "--commit", a1, "--cmd", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "fix-a", "--commit", a1, "--from", b0]).status, 0);
    assert.equal(run(repo, ["task", "verify", "--id", "fix-b", "--commit", b1, "--cmd", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "fix-b", "--commit", b1, "--from", a1]).status, 0);
    const snap2 = run(repo, ["snapshot", "create", "--tasks", "fix-a,fix-b", "--check", "none"]);
    assert.equal(snap2.status, 0, snap2.out);
    assert.equal(run(repo, ["build", "--snapshot", "snap-02", "--platform", "web", "--mode", "batch", "--command", "node emit.mjs"]).status, 0);
    const b2 = readBuild(repo, "b02-web-r1");
    assert.deepEqual(b2.includedTasks.map((t) => t.id).sort(), ["fix-a", "fix-b"]);
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "fix-a", "--status", "pass"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "fix-b", "--status", "pass"]).status, 0);
    const oa = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "acceptance", "fix-a.json"), "utf8"));
    const ob = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "acceptance", "fix-b.json"), "utf8"));
    assert.equal(oa.status, "fail");
    assert.equal(ob.status, "fail");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("移动端任务不能用桌面/Web 构建验收（平台独立合批）", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "apps/mobile/src/screen.txt": "screen v1\n" }, "mobile change");
    addReadyTask(repo, "mobile-alpha", ["apps/mobile/src/screen.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "mobile-alpha", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    const r = run(repo, ["accept", "--build", "b01-web-r1", "--task", "mobile-alpha", "--status", "pass"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /移动端|平台|桌面/);
    const task = JSON.parse(fsReadTask(repo, "mobile-alpha"));
    assert.equal(task.status, "verifying");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("旧任务可以在包含其代码的新构建上验收，旧构建记录保留且标记 regression", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    const beta = commitFile(repo, { "src/other.txt": "other v2\n" }, "beta");
    const gamma = commitFile(repo, { "src/notes.txt": "notes v2\n" }, "gamma");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    addReadyTask(repo, "beta", ["src/other.txt"], beta);
    addReadyTask(repo, "gamma", ["src/notes.txt"], gamma);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha,beta,gamma", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass", "--agent", "agent-alpha"]).status, 0);

    const delta = commitFile(repo, { "src/delta.txt": "delta v1\n" }, "delta");
    const epsilon = commitFile(repo, { "src/epsilon.txt": "epsilon v1\n" }, "epsilon");
    addReadyTask(repo, "delta", ["src/delta.txt"], delta);
    addReadyTask(repo, "epsilon", ["src/epsilon.txt"], epsilon);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "delta,epsilon", "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-02", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    const b2 = readBuild(repo, "b02-web-r1");
    assert.deepEqual(b2.includedTasks.map((t) => t.id).sort(), ["alpha", "beta", "delta", "epsilon", "gamma"]);

    // 旧任务 alpha/beta/gamma 都在 snap-02 累计清单中，可以在 b02 上做回归验收。
    const a2 = run(repo, ["accept", "--build", "b02-web-r1", "--task", "alpha", "--status", "pass", "--agent", "agent-alpha"]);
    assert.equal(a2.status, 0, a2.out);
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "beta", "--status", "pass", "--agent", "agent-beta"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "gamma", "--status", "fail", "--agent", "agent-gamma", "--note", "窗口回归失败"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b02-web-r1", "--task", "delta", "--status", "pass", "--agent", "agent-delta"]).status, 0);

    const a2record = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b02-web-r1", "acceptance", "alpha.json"), "utf8"));
    assert.equal(a2record.build, "b02-web-r1");
    assert.equal(a2record.kind, "regression");
    const b1record = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "acceptance", "alpha.json"), "utf8"));
    assert.equal(b1record.build, "b01-web-r1");
    assert.equal(b1record.status, "pass");
    const d = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b02-web-r1", "acceptance", "delta.json"), "utf8"));
    assert.equal(d.kind, "first");

    const cov = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b02-web-r1", "coverage.json"), "utf8"));
    assert.equal(cov.plannedAcceptance, 5);
    assert.equal(cov.completedAcceptance, 4);
    assert.equal(cov.pass, 3);
    assert.equal(cov.fail, 1);
    assert.equal(cov.firstAcceptance, 1);
    assert.equal(cov.regressionAcceptance, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("同一 buildId+taskId 重复验收保留 revision/history，不覆盖旧结论", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    assert.equal(run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "pass", "--note", "复测通过"]).status, 0);
    assert.equal(run(repo, ["accept", "--build", "b01-web-r1", "--task", "alpha", "--status", "fail", "--note", "后来发现回归"]).status, 0);
    const record = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "acceptance", "alpha.json"), "utf8"));
    assert.equal(record.revision, 3);
    assert.equal(record.status, "fail");
    assert.equal(record.history.length, 2);
    assert.deepEqual(record.history.map((h) => h.status), ["pass", "pass"]);
    const task = JSON.parse(fsReadTask(repo, "alpha"));
    assert.equal(task.status, "accept-failed");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("构建失败按日志分类为 resource-error，不自动重复执行", () => {
  const { home, repo } = makeRepo();
  try {
    const base = commitFile(repo, {
      "fail.mjs": 'console.error("memory allocation of 25427984 bytes failed");\nprocess.exit(1);\n',
    }, "fail helper");
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--mode", "urgent", "--command", "node fail.mjs"]);
    assert.ok([2, 3].includes(r.status), r.out);
    const failed = readBuild(repo, "b01-web-r1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.mode, "urgent");
    assert.equal(failed.failureClass, "resource-error");
    assert.match(failed.failureHint, /降低 CARGO_BUILD_JOBS|资源/);
    assert.equal(failed.exitCode, 1);
    assert.equal(readdirSync(join(repo, "tmp", "integration", "builds")).filter((n) => n.startsWith("b01-web")).length, 1);
    const cov = JSON.parse(readFileSync(join(repo, "tmp", "integration", "builds", "b01-web-r1", "coverage.json"), "utf8"));
    assert.equal(cov.status, "failed");
    assert.equal(cov.failureClass, "resource-error");
    assert.equal(cov.completedAcceptance, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("集成静态检查只执行 npm run typecheck，不再重复 Vite 打包", () => {
  const { home, repo } = makeRepo();
  try {
    const pkg = JSON.stringify({ name: "demo", version: "1.0.0", scripts: { typecheck: "node check.mjs" } }, null, 2) + "\n";
    const lock = JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {} }, null, 2) + "\n";
    const base = commitFile(repo, {
      "package.json": pkg,
      "package-lock.json": lock,
      "check.mjs": 'console.log("typecheck ok");\n',
    }, "package fixture");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    const create = run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "static"]);
    assert.equal(create.status, 0, create.out);
    const snap = readSnapshot(repo, "snap-01");
    assert.equal(snap.checks[0].cmd, "npm run typecheck");
    assert.equal(snap.checks[0].exitCode, 0);
    assert.equal(existsSync(join(buildWtPath(repo), "dist", "index.html")), false);
    const log = readFileSync(join(repo, snap.checks[0].logPath), "utf8");
    assert.match(log, /typecheck ok/);
    assert.doesNotMatch(log, /vite build/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

