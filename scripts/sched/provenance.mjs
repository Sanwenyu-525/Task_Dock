//! 构建 provenance：给每个调度任务留下可复核的源码/产物边车记录。
//!
//! 为什么需要它：安装包自身的 SHA256 只能证明「文件是不是同一份」，不能回答
//! 「这份包由哪次 HEAD、哪些未提交改动、哪些前端资源编译而来」。本模块在任务开始时
//! 记录 Git HEAD/分支/脏文件及其内容哈希，在任务结束时记录本次构建实际写出的
//! 安装包与前端资源 SHA256，并写到 `<state>/logs/<taskId>.provenance.json`。
//!
//! 约束：所有采集都必须 fail-soft，不能因为 git 不可用、文件被锁或单文件过大而让
//! 构建失败；记录的是元数据与哈希，不记录源码正文、剪贴板正文或用户路径内容。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import { atomicWriteJson } from "./state.mjs";

const SCHEMA = "taskdock.build-provenance/1";
const MAX_DIRTY_FILES = 500;
const MAX_DIRTY_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DIRTY_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACTS = 500;
const ARTIFACT_EXTENSIONS = new Set([
  ".exe", ".msi", ".msix", ".appx", ".zip", ".7z",
  ".apk", ".aab", ".dmg", ".appimage", ".deb", ".rpm",
  ".png", ".jpg", ".jpeg", ".webp", ".svg",
]);

const nowIso = () => new Date().toISOString();

let gitExecutableCache;

/**
 * 解析 Git 可执行文件：调度器可能由不同父进程启动，PATH 里不一定有 git。
 * 依次尝试 git、TASKDOCK_GIT/GIT_EXE、Windows 常见安装路径；找不到时返回 null。
 */
function gitExecutable() {
  if (gitExecutableCache !== undefined) return gitExecutableCache;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.TASKDOCK_GIT,
    process.env.GIT_EXE,
    "git",
    programFiles ? join(programFiles, "Git", "cmd", "git.exe") : null,
    programFilesX86 ? join(programFilesX86, "Git", "cmd", "git.exe") : null,
    localAppData ? join(localAppData, "Programs", "Git", "cmd", "git.exe") : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], {
        timeout: 5000,
        windowsHide: true,
        stdio: "ignore",
      });
      gitExecutableCache = candidate;
      return candidate;
    } catch { /* 试下一个 */ }
  }
  gitExecutableCache = null;
  return null;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(cwd, args) {
  const exe = gitExecutable();
  if (!exe) return null;
  try {
    return execFileSync(exe, args, {
      cwd,
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** 不做 trim 的 Git 输出：porcelain -z 的首字符空格是状态位，trim 会把路径整体左移一位。 */
function gitRaw(cwd, args) {
  const exe = gitExecutable();
  if (!exe) return null;
  try {
    return execFileSync(exe, args, {
      cwd,
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function fileDigest(path, maxBytes = MAX_DIRTY_FILE_BYTES) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { bytes: null, sha256: null, skipped: "not-a-file" };
    if (st.size > maxBytes) return { bytes: st.size, sha256: null, skipped: "file-too-large" };
    const buf = readFileSync(path);
    return { bytes: buf.length, sha256: sha256Bytes(buf) };
  } catch (err) {
    return { bytes: null, sha256: null, skipped: err?.code ?? "unreadable" };
  }
}

function parseStatusZ(text) {
  const records = String(text ?? "").split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const path = rec.slice(3);
    // -z 下重命名/复制记录后面还会跟一条原路径；原路径不单独计入脏文件。
    if (status[0] === "R" || status[0] === "C") i++;
    files.push({ status, path });
  }
  return files;
}

function normalizeRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

/**
 * 采集当前工作区的源码 provenance。优先用 cwd 所在的 Git 工作树，找不到时才退回 repoRoot。
 * 无 Git 时返回 `status: "not-git"`，不抛出。
 */
export function collectSourceProvenance({ cwd, repoRoot } = {}) {
  const workdir = cwd && existsSync(cwd) ? resolve(cwd) : resolve(repoRoot ?? ".");
  const gitRoot = git(workdir, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    return {
      schema: SCHEMA,
      kind: "source",
      capturedAt: nowIso(),
      status: "not-git",
      workdir,
    };
  }

  const head = git(gitRoot, ["rev-parse", "HEAD"]);
  const shortHead = git(gitRoot, ["rev-parse", "--short=12", "HEAD"]);
  const branch = git(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const statusText = gitRaw(gitRoot, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const allDirtyEntries = parseStatusZ(statusText ?? "");
  const entries = allDirtyEntries.slice(0, MAX_DIRTY_FILES);
  const fullDirtyCount = allDirtyEntries.length;

  let totalBytes = 0;
  const dirtyFiles = [];
  for (const entry of entries) {
    if (totalBytes >= MAX_DIRTY_TOTAL_BYTES) {
      dirtyFiles.push({ ...entry, bytes: null, sha256: null, skipped: "total-budget" });
      continue;
    }
    const full = join(gitRoot, entry.path);
    const digest = entry.status.includes("D")
      ? { bytes: null, sha256: null, skipped: "deleted" }
      : fileDigest(full, Math.min(MAX_DIRTY_FILE_BYTES, MAX_DIRTY_TOTAL_BYTES - totalBytes));
    if (digest.bytes) totalBytes += digest.bytes;
    dirtyFiles.push({ ...entry, ...digest });
  }

  return {
    schema: SCHEMA,
    kind: "source",
    capturedAt: nowIso(),
    status: "ok",
    gitRoot,
    head: head ?? null,
    shortHead: shortHead ?? null,
    branch: branch ?? null,
    dirty: fullDirtyCount > 0,
    dirtyFileCount: fullDirtyCount,
    dirtyFiles,
    truncated: fullDirtyCount > MAX_DIRTY_FILES,
    sourceFingerprint: sha256Bytes(JSON.stringify({
      head: head ?? null,
      branch: branch ?? null,
      dirty: dirtyFiles,
      fullDirtyCount,
    })),
  };
}

function isArtifactFile(path) {
  const ext = extname(path).toLowerCase();
  if (ARTIFACT_EXTENSIONS.has(ext)) return true;
  // 前端构建产物：入口与 JS/CSS chunk，用于回答「包内嵌的是哪一次 dist」。
  return ext === ".html" || ext === ".js" || ext === ".css" || ext === ".json";
}

function walkFiles(dir, out, { depth = 0, maxDepth = 3, startedAtMs = 0 } = {}) {
  if (out.length >= MAX_ARTIFACTS) return;
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (out.length >= MAX_ARTIFACTS) return;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (depth < maxDepth) walkFiles(full, out, { depth: depth + 1, maxDepth, startedAtMs });
      continue;
    }
    if (!st.isFile() || !isArtifactFile(full)) continue;
    // 只记录本次构建开始后写出的文件，避免把上一次构建的旧包混入 provenance。
    if (st.mtimeMs + 5000 < startedAtMs) continue;
    out.push({ full, bytes: st.size, mtimeMs: st.mtimeMs });
  }
}

/**
 * 采集本次任务实际写出的安装包与前端资源。只扫描 TaskDock 已知产物目录，
 * 避免遍历整个仓库；超过上限时标记 truncated。
 */
export function collectArtifactProvenance({ cwd, repoRoot, startedAtMs = 0 } = {}) {
  const workdir = cwd && existsSync(cwd) ? resolve(cwd) : resolve(repoRoot ?? ".");
  const gitRoot = git(workdir, ["rev-parse", "--show-toplevel"]);
  const root = gitRoot ?? resolve(repoRoot ?? workdir);
  const started = Number.isFinite(startedAtMs) ? startedAtMs : 0;
  const candidates = [
    join(root, "dist", "index.html"),
    join(root, "dist", "assets"),
    join(root, "src-tauri", "target", "release", "task-dock.exe"),
    join(root, "src-tauri", "target", "release", "bundle"),
    join(root, "apps", "mobile", "android", "app", "build", "outputs"),
  ];
  const found = [];
  for (const candidate of candidates) {
    if (found.length >= MAX_ARTIFACTS) break;
    if (!existsSync(candidate)) continue;
    let st;
    try { st = statSync(candidate); } catch { continue; }
    if (st.isDirectory()) {
      walkFiles(candidate, found, { depth: 0, maxDepth: 3, startedAtMs: started });
    } else if (st.isFile() && isArtifactFile(candidate) && st.mtimeMs + 5000 >= started) {
      found.push({ full: candidate, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }

  const files = found.slice(0, MAX_ARTIFACTS).map((f) => {
    const digest = fileDigest(f.full, 512 * 1024 * 1024);
    return {
      path: normalizeRelative(root, f.full),
      bytes: digest.bytes ?? f.bytes,
      sha256: digest.sha256,
      skipped: digest.skipped ?? null,
      mtime: new Date(f.mtimeMs).toISOString(),
    };
  });

  return {
    schema: SCHEMA,
    kind: "artifacts",
    capturedAt: nowIso(),
    root,
    startedAtMs: started || null,
    files,
    truncated: found.length > MAX_ARTIFACTS || files.some((f) => f.skipped),
  };
}

/**
 * 写任务级 provenance 边车。任务结束后调用；写失败不阻断构建收尾。
 * 返回文件路径（写失败时返回 null）。
 */
export function writeBuildProvenance({
  logDir, task, status, exitCode = null, reason = null,
  startedAt = null, finishedAt = null, source = null, artifacts = null,
} = {}) {
  if (!logDir || !task?.id) return null;
  const target = join(logDir, `${task.id}.provenance.json`);
  const data = {
    schema: SCHEMA,
    taskId: task.id,
    label: task.label ?? null,
    taskClass: task.taskClass ?? null,
    command: task.command ?? null,
    cwd: task.cwd ?? null,
    status,
    exitCode,
    reason,
    enqueuedAt: task.enqueuedAt ?? null,
    startedAt,
    finishedAt: finishedAt ?? nowIso(),
    source,
    artifacts,
    summary: {
      head: source?.head ?? null,
      shortHead: source?.shortHead ?? null,
      dirty: source?.dirty ?? null,
      dirtyFileCount: source?.dirtyFileCount ?? null,
      sourceFingerprint: source?.sourceFingerprint ?? null,
      artifactCount: artifacts?.files?.length ?? 0,
    },
  };
  try {
    atomicWriteJson(target, data);
    return target;
  } catch {
    return null;
  }
}

export function readBuildProvenance(logDir, taskId) {
  if (!logDir || !taskId) return null;
  try {
    return JSON.parse(readFileSync(join(logDir, `${taskId}.provenance.json`), "utf8"));
  } catch {
    return null;
  }
}

/** 按产物 SHA256 反查任务 provenance；返回匹配记录数组（可能为空）。 */
export function findProvenanceByArtifact(logDir, sha256) {
  const needle = String(sha256 ?? "").toLowerCase();
  if (!needle) return [];
  let names = [];
  try { names = readdirSync(logDir); } catch { return []; }
  const matches = [];
  for (const name of names) {
    if (!name.endsWith(".provenance.json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(logDir, name), "utf8"));
      const files = data?.artifacts?.files ?? [];
      if (files.some((f) => String(f.sha256 ?? "").toLowerCase() === needle)) matches.push(data);
    } catch { /* 损坏的边车不应阻塞查询 */ }
  }
  return matches;
}
