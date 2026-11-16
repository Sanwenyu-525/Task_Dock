//! 统一集成 / 构建 / 验收台账的自动化用例（node:test，零依赖）。
//!
//! 全部用例在系统临时目录里自建一次性 Git 仓库，不读写本仓库的工作树、
//! 构建缓存或验收证据；每个用例结束删除自己的临时目录。
//!
//!   npm run test:scripts   （或 node --test scripts/taskdock-integration.test.mjs）

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "taskdock-integration.mjs");
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
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function run(repo, args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: repo, encoding: "utf8", env: ENV });
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
    'const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();',
    'const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();',
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
  const r2 = run(repo, ["task", "check", "--id", id, "--cmd", "npm test", "--exit", "0"]);
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

// ---------------------------------------------------------------- 任务与状态机

test("任务交付必须带通过检查，未就绪不得进入集成", () => {
  const { home, repo, base } = makeRepo();
  try {
    assert.equal(run(repo, ["task", "add", "--id", "alpha", "--owner", "a", "--module", "m", "--paths", "src/app.txt"]).status, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", base]).status, 2);
    assert.equal(run(repo, ["task", "check", "--id", "alpha", "--cmd", "npm test", "--exit", "1"]).status, 2);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", base]).status, 2);
    const commit = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha work");
    assert.equal(run(repo, ["task", "check", "--id", "alpha", "--cmd", "npm test", "--exit", "0"]).status, 0);
    assert.equal(run(repo, ["task", "ready", "--id", "alpha", "--commit", commit]).status, 0);
    const show = run(repo, ["task", "show", "--id", "alpha", "--json"]);
    assert.equal(JSON.parse(show.out).status, "integration-ready");
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

test("交付提交包含未声明路径时拒绝，显式放行后记录 ignoredPaths", () => {
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
    assert.equal(snap.ignoredPaths.length, 1);
    assert.match(snap.ignoredPaths[0], /src\/other\.txt/);
    // 放行只记录，不把未声明文件带进快照
    assert.equal(readFileSync(join(wtPath(repo), "src/other.txt"), "utf8"), "other v1\n");
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
    assert.match(r.out, /不是本仓库登记的工作区/);
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

test("集成工作区不干净时构建拒绝执行", () => {
  const { home, repo, base } = makeRepo();
  try {
    const alpha = commitFile(repo, { "src/app.txt": "app v2\n" }, "alpha");
    addReadyTask(repo, "alpha", ["src/app.txt"], alpha);
    assert.equal(run(repo, ["snapshot", "create", "--tasks", "alpha", "--base", base, "--check", "none"]).status, 0);
    writeFileSync(join(wtPath(repo), "scratch.txt"), "未清理的临时文件\n", "utf8");
    const r = run(repo, ["build", "--snapshot", "snap-01", "--platform", "web", "--command", "node emit.mjs"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /未提交改动/);
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
