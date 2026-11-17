import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectArtifactProvenance, collectSourceProvenance, findProvenanceByArtifact,
  readBuildProvenance, writeBuildProvenance,
} from "./provenance.mjs";

function git(cwd, args) {
  const candidates = [
    process.env.TASKDOCK_GIT,
    process.env.GIT_EXE,
    "git",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "cmd", "git.exe") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe") : null,
  ].filter(Boolean);
  let last = null;
  for (const candidate of candidates) {
    try {
      return execFileSync(candidate, args, {
        cwd, encoding: "utf8", timeout: 20000, windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new Error("git not found");
}

test("provenance：记录 HEAD、脏文件路径与内容哈希", () => {
  const repo = mkdtempSync(join(tmpdir(), "taskdock-prov-source-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "TaskDock Test"]);
    writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    writeFileSync(join(repo, "base.txt"), "changed\n", "utf8");
    writeFileSync(join(repo, "untracked.txt"), "new\n", "utf8");

    const source = collectSourceProvenance({ cwd: repo });
    assert.equal(source.status, "ok");
    assert.equal(source.dirty, true);
    assert.equal(source.dirtyFileCount, 2);
    assert.match(source.head, /^[0-9a-f]{40}$/);
    assert.match(source.sourceFingerprint, /^[0-9a-f]{64}$/);
    const changed = source.dirtyFiles.find((f) => f.path === "base.txt");
    const untracked = source.dirtyFiles.find((f) => f.path === "untracked.txt");
    assert.ok(changed?.sha256);
    assert.ok(untracked?.sha256);
    assert.notEqual(changed.sha256, untracked.sha256);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("provenance：产物 hash 可反查，边车可读回", () => {
  const repo = mkdtempSync(join(tmpdir(), "taskdock-prov-artifact-"));
  const logDir = mkdtempSync(join(tmpdir(), "taskdock-prov-logs-"));
  try {
    mkdirSync(join(repo, "dist", "assets"), { recursive: true });
    mkdirSync(join(repo, "src-tauri", "target", "release", "bundle", "nsis"), { recursive: true });
    writeFileSync(join(repo, "dist", "index.html"), "<html>build</html>", "utf8");
    writeFileSync(join(repo, "dist", "assets", "main.js"), "console.log(1)", "utf8");
    writeFileSync(join(repo, "src-tauri", "target", "release", "bundle", "nsis", "setup.exe"), "fake-exe", "utf8");

    const artifacts = collectArtifactProvenance({ cwd: repo, repoRoot: repo, startedAtMs: 0 });
    assert.ok(artifacts.files.some((f) => f.path === "dist/index.html" && f.sha256));
    assert.ok(artifacts.files.some((f) => f.path.endsWith("setup.exe") && f.sha256));

    const task = {
      id: "prov-test",
      label: "prov test",
      taskClass: "light",
      command: ["node", "-e", "0"],
      cwd: repo,
      enqueuedAt: new Date().toISOString(),
    };
    const source = collectSourceProvenance({ cwd: repo });
    const path = writeBuildProvenance({
      logDir, task, status: "succeeded", exitCode: 0,
      startedAt: task.enqueuedAt, finishedAt: new Date().toISOString(),
      source, artifacts,
    });
    assert.ok(path);
    const read = readBuildProvenance(logDir, task.id);
    assert.equal(read.taskId, task.id);
    assert.equal(read.status, "succeeded");
    assert.equal(read.source.status, "not-git");
    const setup = artifacts.files.find((f) => f.path.endsWith("setup.exe"));
    const matches = findProvenanceByArtifact(logDir, setup.sha256);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].taskId, task.id);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});
