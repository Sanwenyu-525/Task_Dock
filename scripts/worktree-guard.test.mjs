import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worktree-guard.mjs");

function run(cwd, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 120000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `git ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

function setupRepo(root) {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main", "-q"]);
  git(repo, ["config", "user.name", "worktree-guard-test"]);
  git(repo, ["config", "user.email", "worktree-guard@example.invalid"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "README.md"), "line1\nline2\n");
  writeFileSync(join(repo, "other.txt"), "other\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }) + "\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "worktree-guard-"));
  const repo = setupRepo(root);
  const worktreeRoot = join(root, "wts");
  return { root, repo, worktreeRoot };
}

function create(repo, worktreeRoot, task, extra = []) {
  const r = run(repo, ["create", "--task", task, "--root", worktreeRoot, ...extra]);
  assert.equal(r.status, 0, `create ${task} 失败：${r.stderr}`);
  return join(worktreeRoot, task);
}

function statusJson(repo, extra = []) {
  const r = run(repo, ["status", "--json", ...extra]);
  assert.equal(r.status, 0, `status 失败：${r.stderr}`);
  return JSON.parse(r.stdout);
}

function samePath(a, b) {
  const norm = (p) => resolve(p).toLowerCase().split("\\").join("/");
  return norm(a) === norm(b);
}

function checkJson(repo, task, extra = []) {
  const r = run(repo, ["check", "--task", task, "--json", ...extra]);
  return { status: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test("status 以 Git 登记为准，识别主工作区与任意目录名的 Worktree", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const weird = join(root, "not-a-task-name");
    git(repo, ["worktree", "add", "-q", "-b", "agent/legacy", weird, "HEAD"]);

    const data = statusJson(repo);
    assert.equal(samePath(data.mainRoot, repo), true);
    assert.equal(data.worktrees.length, 2);

    const main = data.worktrees.find((w) => w.isMain);
    assert.ok(main, "应识别主工作区");
    assert.equal(main.branch, "main");
    assert.equal(main.ahead, 0);

    const legacy = data.worktrees.find((w) => !w.isMain);
    assert.ok(legacy, "目录名不含任务名时仍应出现在清单中");
    assert.equal(legacy.branch, "agent/legacy");
    assert.equal(legacy.exists, true);
    assert.equal(legacy.activity, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create 从指定基准创建，重复任务名/已存在目录/非法参数均拒绝且不覆盖", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const first = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "second.txt"), "second\n");
    git(repo, ["add", "second.txt"]);
    git(repo, ["commit", "-q", "-m", "second"]);
    const second = git(repo, ["rev-parse", "HEAD"]);

    const alpha = create(repo, worktreeRoot, "alpha", ["--base", first]);
    assert.equal(git(alpha, ["rev-parse", "HEAD"]), first);
    assert.equal(samePath(git(alpha, ["rev-parse", "--show-toplevel"]), alpha), true);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), second, "创建 Worktree 不得移动主工作区 HEAD");

    const dup = run(repo, ["create", "--task", "alpha", "--root", worktreeRoot]);
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /目标目录已存在/);
    assert.ok(existsSync(join(alpha, "README.md")), "重复创建不得破坏已有 Worktree");

    const betaDir = join(worktreeRoot, "beta");
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(join(betaDir, "keep.txt"), "do-not-delete\n");
    const conflict = run(repo, ["create", "--task", "beta", "--root", worktreeRoot]);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /目标目录已存在/);
    assert.equal(readFileSync(join(betaDir, "keep.txt"), "utf8"), "do-not-delete\n");

    const branchConflict = run(repo, ["create", "--task", "gamma", "--root", worktreeRoot, "--branch", "main"]);
    assert.equal(branchConflict.status, 1);
    assert.match(branchConflict.stderr, /分支已存在/);

    const invalid = run(repo, ["create", "--task", "Bad_Name", "--root", worktreeRoot]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /任务名不合法/);

    const relative = run(repo, ["create", "--task", "delta", "--root", "rel-wts"]);
    assert.equal(relative.status, 1);
    assert.match(relative.stderr, /必须是绝对路径/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("两个 Worktree 的未提交修改互相隔离，主工作区内容保持不变", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const alpha = create(repo, worktreeRoot, "alpha");
    const beta = create(repo, worktreeRoot, "beta");

    writeFileSync(join(alpha, "README.md"), "line1\nALPHA-DIRTY\n");
    writeFileSync(join(alpha, "alpha-new.txt"), "alpha-untracked\n");

    const data = statusJson(repo);
    const row = (name) => data.worktrees.find((w) => samePath(w.path, join(worktreeRoot, name)));
    assert.equal(row("alpha").modified, 1);
    assert.equal(row("alpha").untracked, 1);
    assert.equal(row("beta").modified, 0);
    assert.equal(row("beta").untracked, 0);

    assert.equal(existsSync(join(beta, "alpha-new.txt")), false, "未跟踪文件不得跨 Worktree 可见");
    assert.equal(readFileSync(join(beta, "README.md"), "utf8"), "line1\nline2\n");
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "line1\nline2\n", "主工作区不得被 Worktree 修改");
    assert.equal(git(repo, ["status", "--porcelain"]), "", "主工作区应保持干净");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node_modules 仅在依赖清单一致时建立共享 junction", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "shared-deps\n");

    const alpha = create(repo, worktreeRoot, "alpha", ["--link-node-modules"]);
    const link = join(alpha, "node_modules");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "应创建 junction/链接");
    assert.equal(readFileSync(join(link, "marker.txt"), "utf8"), "shared-deps\n");

    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, changed: true }) + "\n");
    const betaRun = run(repo, ["create", "--task", "beta", "--root", worktreeRoot, "--link-node-modules"]);
    assert.equal(betaRun.status, 0);
    assert.match(betaRun.stdout, /package-lock\.json 与主仓库不一致/);
    assert.equal(existsSync(join(worktreeRoot, "beta", "node_modules")), false);

    // 先移除链接再删除临时目录，确保不触碰主仓库 node_modules。
    rmdirSync(link);
    assert.equal(readFileSync(join(repo, "node_modules", "marker.txt"), "utf8"), "shared-deps\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check 识别合并冲突、目标未提交重叠与源未提交内容", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const alpha = create(repo, worktreeRoot, "alpha");
    const beta = create(repo, worktreeRoot, "beta");

    writeFileSync(join(alpha, "README.md"), "line1\nALPHA\n");
    git(alpha, ["commit", "-q", "-am", "alpha change"]);
    writeFileSync(join(repo, "README.md"), "line1\nMAIN\n");
    git(repo, ["commit", "-q", "-am", "main conflicting change"]);

    const conflict = checkJson(repo, "alpha");
    assert.equal(conflict.status, 2);
    assert.deepEqual(conflict.json.conflictFiles, ["README.md"]);
    assert.equal(conflict.json.alreadyMerged, false);
    assert.equal(conflict.json.ready, false);
    assert.ok(conflict.json.risks.some((r) => r.includes("合并冲突")));

    writeFileSync(join(beta, "other.txt"), "line1\nBETA\n");
    git(beta, ["commit", "-q", "-am", "beta change"]);
    writeFileSync(join(repo, "other.txt"), "line1\nMAIN-DIRTY\n");

    const overlap = checkJson(repo, "beta");
    assert.equal(overlap.status, 2);
    assert.deepEqual(overlap.json.overlappingDirtyFiles, ["other.txt"]);
    assert.equal(overlap.json.targetDirty, true);
    assert.ok(overlap.json.risks.some((r) => r.includes("重叠")));

    writeFileSync(join(beta, "uncommitted.txt"), "dirty\n");
    const dirty = checkJson(repo, "beta");
    assert.equal(dirty.status, 2);
    assert.equal(dirty.json.sourceDirty, true);
    assert.ok(dirty.json.risks.some((r) => r.includes("未提交内容")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup 拒绝脏/未合入/锁定/缺失目录，合入后才允许清理", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const alpha = create(repo, worktreeRoot, "alpha");

    const inside = run(alpha, ["cleanup", "--task", "alpha", "--execute"]);
    assert.equal(inside.status, 3);
    assert.match(inside.stderr, /当前 cwd 位于待清理 Worktree 内/);
    assert.ok(existsSync(alpha), "在待清理 Worktree 内执行时必须拒绝");

    writeFileSync(join(alpha, "README.md"), "line1\nDIRTY\n");
    const dirty = run(repo, ["cleanup", "--task", "alpha", "--execute"]);
    assert.equal(dirty.status, 3);
    assert.match(dirty.stderr, /不干净/);
    assert.ok(existsSync(alpha), "拒绝清理时目录必须保留");

    git(alpha, ["restore", "README.md"]);
    writeFileSync(join(alpha, "untracked.txt"), "keep me\n");
    const untracked = run(repo, ["cleanup", "--task", "alpha", "--execute"]);
    assert.equal(untracked.status, 3);
    assert.ok(existsSync(join(alpha, "untracked.txt")), "未跟踪文件必须保留");
    rmSync(join(alpha, "untracked.txt"));

    writeFileSync(join(alpha, "feature.txt"), "feature\n");
    git(alpha, ["add", "feature.txt"]);
    git(alpha, ["commit", "-q", "-m", "feature"]);
    const unmerged = run(repo, ["cleanup", "--task", "alpha", "--execute"]);
    assert.equal(unmerged.status, 3);
    assert.match(unmerged.stderr, /尚未合入/);
    assert.ok(existsSync(alpha));

    git(repo, ["merge", "--no-ff", "-q", "agent/alpha", "-m", "merge alpha"]);
    const dry = run(repo, ["cleanup", "--task", "alpha"]);
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /dry-run/);
    assert.ok(existsSync(alpha), "dry-run 不得删除目录");

    const locked = git(repo, ["worktree", "lock", "--reason", "test-lock", alpha]);
    assert.equal(locked, "");
    const lockRefuse = run(repo, ["cleanup", "--task", "alpha", "--execute"]);
    assert.equal(lockRefuse.status, 3);
    assert.match(lockRefuse.stderr, /锁定/);
    assert.ok(existsSync(alpha));
    git(repo, ["worktree", "unlock", alpha]);

    const execute = run(repo, ["cleanup", "--task", "alpha", "--delete-branch", "--execute"]);
    assert.equal(execute.status, 0, execute.stderr);
    assert.equal(existsSync(alpha), false);
    const branches = git(repo, ["branch", "--list", "agent/alpha"]);
    assert.equal(branches, "");
    const listed = git(repo, ["worktree", "list", "--porcelain"]);
    assert.equal(listed.replace(/\\/g, "/").includes(alpha.replace(/\\/g, "/")), false);

    const missing = create(repo, worktreeRoot, "delta");
    rmSync(missing, { recursive: true, force: true });
    const missingRun = run(repo, ["cleanup", "--task", "delta", "--execute"]);
    assert.equal(missingRun.status, 3);
    assert.match(missingRun.stderr, /目录不存在/);
    assert.match(missingRun.stderr, /prune/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup 拒绝主工作区，状态检查不把 locked 当作活跃证据", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const task = repo.split(/[\\/]/).pop().toLowerCase();
    const mainRefuse = run(repo, ["cleanup", "--task", task, "--execute"]);
    assert.equal(mainRefuse.status, 3);
    assert.match(mainRefuse.stderr, /主工作区/);

    const alpha = create(repo, worktreeRoot, "alpha");
    git(repo, ["worktree", "lock", "--reason", "in-use", alpha]);
    const data = statusJson(repo);
    const row = data.worktrees.find((w) => samePath(w.path, alpha));
    assert.equal(row.locked, true);
    assert.equal(row.lockReason, "in-use");
    assert.equal(row.activity, "unknown");
    git(repo, ["worktree", "unlock", alpha]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("在 linked Worktree 内执行 status/create 仍以主仓库为公共根", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const alpha = create(repo, worktreeRoot, "alpha");

    const fromAlpha = statusJson(alpha);
    assert.equal(samePath(fromAlpha.mainRoot, repo), true, "linked Worktree 内应解析到主仓库");
    assert.equal(fromAlpha.worktrees.length, 2);

    const betaRun = run(alpha, ["create", "--task", "beta", "--root", worktreeRoot]);
    assert.equal(betaRun.status, 0, betaRun.stderr);
    const beta = join(worktreeRoot, "beta");
    assert.equal(samePath(git(beta, ["rev-parse", "--show-toplevel"]), beta), true);
    assert.equal(git(beta, ["branch", "--show-current"]), "agent/beta");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup 在分支删除失败时返回 5，Worktree 已移除但分支保留", () => {
  const { root, repo, worktreeRoot } = setup();
  try {
    const alpha = create(repo, worktreeRoot, "alpha");
    writeFileSync(join(alpha, "feature.txt"), "feature\n");
    git(alpha, ["add", "feature.txt"]);
    git(alpha, ["commit", "-q", "-m", "feature"]);

    // 先分出 side 并前进，再在 main 合入 alpha；最后切到 side 触发
    // `git branch -d` 的“未合入当前 HEAD”拒绝路径。
    git(repo, ["switch", "-q", "-c", "side"]);
    writeFileSync(join(repo, "side.txt"), "side\n");
    git(repo, ["add", "side.txt"]);
    git(repo, ["commit", "-q", "-m", "side"]);
    git(repo, ["switch", "-q", "main"]);
    git(repo, ["merge", "--no-ff", "-q", "agent/alpha", "-m", "merge alpha"]);
    git(repo, ["switch", "-q", "side"]);

    const result = run(repo, ["cleanup", "--task", "alpha", "--target", "main", "--delete-branch", "--execute"]);
    assert.equal(result.status, 5, result.stderr);
    assert.match(result.stdout, /分支未删除/);
    assert.equal(existsSync(alpha), false, "Worktree 本身应已移除");
    assert.notEqual(git(repo, ["branch", "--list", "agent/alpha"]), "", "删除失败时分支必须保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
