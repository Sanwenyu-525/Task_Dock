#!/usr/bin/env node
//! Task Dock 统一集成 / 统一构建 / 多 Agent 联合验收台账（零依赖，Node >= 18）。
//!
//!   node scripts/taskdock-integration.mjs task add    --id <slug> --owner <agent> --module <模块> --paths <a,b>
//!   node scripts/taskdock-integration.mjs task update --id <slug> [--paths ...] [--note ...] [--public-interface]
//!   node scripts/taskdock-integration.mjs task check  --id <slug> --cmd <命令> --exit <退出码> [--log <路径>]
//!   node scripts/taskdock-integration.mjs task ready  --id <slug> --commit <交付提交> [--from <起点>]
//!   node scripts/taskdock-integration.mjs task list|show --id <slug>
//!
//!   node scripts/taskdock-integration.mjs snapshot bootstrap --base <稳定提交> [--note <说明>] [--force]
//!   node scripts/taskdock-integration.mjs snapshot create --tasks a,b,c | --all-ready
//!                                           [--base <稳定提交>] [--check none|static] [--dry-run]
//!                                           [--allow-overlap] [--allow-extra-paths] [--note <文字>]
//!   node scripts/taskdock-integration.mjs build --snapshot <id|latest> --platform desktop|web|android
//!                                           [--dry-run] [--force] [--target-dir <绝对路径>]
//!                                           [--priority P0..P3] [--command <实验用命令串>]
//!   node scripts/taskdock-integration.mjs accept --build <id> --task <id>
//!                                           --status pass|fail|blocked|not-run
//!                                           [--evidence <仓库内相对路径>] [--note <文字>] [--repro <复现步骤>]
//!   node scripts/taskdock-integration.mjs status [--json]
//!
//! 定位（与 AGENTS.md 第 3、5 节配套，细节见 docs/INTEGRATION_BUILD.md）：
//!   - 任务状态机：developing → integration-ready → integrated → verifying → accept-passed / accept-failed；
//!   - 集成 = 把「已登记交付提交」里**声明路径**的改动，按顺序应用到工具自有的 `integration` 分支
//!     工作区，产出快照提交；共享工作区里其他任务的未提交改动无法进入快照；
//!   - 构建 = 在同一个干净工作区里 checkout 到快照提交后执行，产物与 commit/任务/校验值一起记账；
//!   - 验收 = 多个 Agent 针对同一 buildId 各写自己的验收记录，不改他人结论。
//!
//! 安全边界：
//!   - 只读主工作区的 Git 对象，不提交、不重置、不 stash、不 checkout 主工作区；
//!   - 只写 <主仓库>/tmp/integration/（已 gitignore）与工具自有的 `integration` 分支工作区；
//!   - 不推送、不打标签、不删除任何非工具自有分支或目录；
//!   - 目标工作区目录已存在但未被 Git 登记、或不属于本仓库时一律拒绝，绝不覆盖；
//!   - 冲突/路径越界/工作区不干净时拒绝执行并保留现场（除工具自有工作区内的失败清理）。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, statSync, symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJson } from "./sched/state.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const BRANCH = "integration";
const TASK_STATUS = [
  "developing", "integration-ready", "integrated", "verifying", "accept-passed", "accept-failed",
];
const STATUS_LABEL = {
  developing: "开发中",
  "integration-ready": "待集成",
  integrated: "已集成",
  verifying: "待验收",
  "accept-passed": "验收通过",
  "accept-failed": "验收失败",
};
const ACCEPT_STATUS = ["pass", "fail", "blocked", "not-run"];
const EXIT = { ok: 0, usage: 1, rejected: 2, buildFailed: 3, state: 4 };
const TASK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TASK_ID = 48;

class Fail extends Error {
  constructor(message, code = EXIT.rejected) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- 基础工具

function git(args, cwd, { input, timeout = 120000 } = {}) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", input, timeout, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

function gitOut(args, cwd, what) {
  const r = git(args, cwd);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim();
    throw new Fail(`${what}失败：git ${args.join(" ")}\n${detail}`, EXIT.rejected);
  }
  return r.stdout;
}

function exists(p) {
  try { return lstatSync(p) !== null; } catch { return false; }
}

function samePath(a, b) {
  const na = resolve(a);
  const nb = resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isInside(parent, child) {
  const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  if (rel === "") return true;
  return !(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`));
}

function nowIso() { return new Date().toISOString(); }

function parseArgs(argv) {
  const args = { _: [], flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { args.flags.push(key); args[key] = true; continue; }
      if (key in args && args[key] !== true) args[key] = [].concat(args[key], next);
      else args[key] = next;
      i++;
    } else args._.push(a);
  }
  return args;
}

function flag(args, name) { return args[name] === true; }

function str(args, name, fallback = "") {
  const v = args[name];
  if (v === undefined) return fallback;
  if (v === true) throw new Fail(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} 需要一个值`, EXIT.usage);
  return String(v);
}

function list(value) {
  if (value === undefined) return [];
  return [].concat(value).flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
}

function normalizeRepoPath(raw, what) {
  const p = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === "" || p === ".") throw new Fail(`${what} 不能为空`, EXIT.usage);
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p)) throw new Fail(`${what} 必须是仓库内相对路径：${raw}`, EXIT.usage);
  const segs = p.split("/");
  if (segs.some((s) => s === "..")) throw new Fail(`${what} 不允许包含 ..：${raw}`, EXIT.usage);
  return segs.filter((s) => s !== "" && s !== ".").join("/");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pathCovered(declared, changed) {
  if (declared === changed) return true;
  const d = declared.endsWith("/") ? declared.slice(0, -1) : declared;
  return changed.startsWith(d + "/");
}

// ---------------------------------------------------------------- 仓库与目录

function repoContext() {
  const cwd = process.cwd();
  const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd,
    "解析 Git 公共目录（请在仓库内执行）").trim();
  const commonDir = resolve(cwd, common);
  const mainRoot = resolve(commonDir, "..");
  return { cwd, commonDir, mainRoot };
}

function statePaths(ctx) {
  const root = join(ctx.mainRoot, "tmp", "integration");
  return {
    root,
    tasks: join(root, "tasks"),
    snapshots: join(root, "snapshots"),
    builds: join(root, "builds"),
    logs: join(root, "logs"),
  };
}

function integrationWorktree(ctx) {
  return join(dirname(ctx.mainRoot), `${basename(ctx.mainRoot)}-integration`);
}

function ensureDirs(paths) {
  for (const dir of [paths.root, paths.tasks, paths.snapshots, paths.builds, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
    .map((e) => readJson(join(dir, e.name)))
    .filter((v) => v && typeof v === "object");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, value);
}

// ---------------------------------------------------------------- 任务台账

function taskFile(paths, id) { return join(paths.tasks, `${id}.json`); }

function loadTask(paths, id) {
  if (!TASK_RE.test(id) || id.length > MAX_TASK_ID) {
    throw new Fail(`任务标识非法：${id}（小写字母/数字 + 单短横线，≤ ${MAX_TASK_ID} 字符）`, EXIT.usage);
  }
  const t = readJson(taskFile(paths, id));
  if (!t) throw new Fail(`任务不存在：${id}（先执行 task add）`, EXIT.usage);
  return t;
}

function saveTask(paths, task) {
  task.updatedAt = nowIso();
  writeJson(taskFile(paths, task.id), task);
  return task;
}

function cmdTask(sub, argv) {
  const args = parseArgs(argv);
  const ctx = repoContext();
  const paths = statePaths(ctx);
  ensureDirs(paths);
  const id = str(args, "id");

  if (sub === "add") {
    if (!id) throw new Fail("用法：task add --id <slug> --owner <agent> --module <模块> --paths <a,b>", EXIT.usage);
    if (existsSync(taskFile(paths, id))) throw new Fail(`任务已存在：${id}（用 task update 修改）`, EXIT.rejected);
    if (!TASK_RE.test(id) || id.length > MAX_TASK_ID) throw new Fail(`任务标识非法：${id}`, EXIT.usage);
    const task = {
      id,
      module: str(args, "module", "(未声明模块)"),
      owner: str(args, "owner", "(未声明负责人)"),
      status: "developing",
      paths: list(args.paths).map((p) => normalizeRepoPath(p, "--paths")),
      commit: null,
      from: null,
      integratedCommit: null,
      snapshot: null,
      build: null,
      acceptance: null,
      checks: [],
      publicInterface: flag(args, "publicInterface"),
      needs: list(args.needs),
      notes: str(args, "note"),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (task.paths.length === 0) throw new Fail("task add 必须声明 --paths（写入范围，用于集成与冲突判定）", EXIT.usage);
    saveTask(paths, task);
    console.log(`已登记任务 ${id}（${STATUS_LABEL[task.status]}，写入范围 ${task.paths.length} 项）`);
    return EXIT.ok;
  }

  // 只读命令必须先于任务加载（list/status 不需要 --id）
  if (sub === "list" || sub === undefined) {
    const all = readJsonDir(paths.tasks).sort((a, b) => a.id.localeCompare(b.id));
    if (flag(args, "json")) { console.log(JSON.stringify(all, null, 2)); return EXIT.ok; }
    if (all.length === 0) { console.log("（暂无任务记录）"); return EXIT.ok; }
    printTable(all, [
      { key: "id", title: "任务" },
      { key: "module", title: "模块" },
      { key: "owner", title: "负责人" },
      { key: "status", title: "状态" },
      { key: "commitShort", title: "交付提交" },
      { key: "pathsCount", title: "写入范围" },
    ], (t) => ({
      ...t, status: STATUS_LABEL[t.status] ?? t.status,
      commitShort: t.commit ? t.commit.slice(0, 7) : "-",
      pathsCount: `${t.paths.length} 项`,
    }));
    return EXIT.ok;
  }

  const task = loadTask(paths, id);

  if (sub === "update") {
    if (args.paths !== undefined) {
      const next = list(args.paths).map((p) => normalizeRepoPath(p, "--paths"));
      if (next.length === 0) throw new Fail("--paths 不能为空", EXIT.usage);
      task.paths = next;
    }
    if (args.module !== undefined) task.module = str(args, "module");
    if (args.owner !== undefined) task.owner = str(args, "owner");
    if (args.note !== undefined) task.notes = str(args, "note");
    if (args.needs !== undefined) task.needs = list(args.needs);
    if (args.publicInterface !== undefined) task.publicInterface = flag(args, "publicInterface");
    if (args.status !== undefined) {
      const next = str(args, "status");
      if (next !== "developing" && next !== "integration-ready") {
        throw new Fail(`task update 只能切到 developing / integration-ready（其余状态由集成与验收流程推进）`, EXIT.usage);
      }
      if (next === "integration-ready") {
        throw new Fail("进入待集成的判据由 task ready 校验（需交付提交 + 通过检查）", EXIT.usage);
      }
      task.status = "developing";
      task.snapshot = null;
      task.build = null;
    }
    saveTask(paths, task);
    console.log(`已更新任务 ${id}（${STATUS_LABEL[task.status]}）`);
    return EXIT.ok;
  }

  if (sub === "check") {
    const cmdText = str(args, "cmd");
    if (!cmdText) throw new Fail("用法：task check --id <slug> --cmd <命令> --exit <退出码> [--log <路径>]", EXIT.usage);
    const rawExit = str(args, "exit");
    const exitCode = Number.parseInt(rawExit, 10);
    if (!Number.isInteger(exitCode)) throw new Fail(`--exit 需要整数退出码（当前 ${rawExit}）`, EXIT.usage);
    const logPath = args.log === undefined ? null : normalizeRepoPath(str(args, "log"), "--log");
    task.checks.push({ cmd: cmdText, exitCode, at: nowIso(), logPath });
    saveTask(paths, task);
    console.log(`已记录检查（${id}）：${cmdText} → exit ${exitCode}`);
    return exitCode === 0 ? EXIT.ok : EXIT.rejected;
  }

  if (sub === "ready") {
    const commitRef = str(args, "commit");
    if (!commitRef) throw new Fail("用法：task ready --id <slug> --commit <交付提交> [--from <起点>]", EXIT.usage);
    const commit = gitOut(["rev-parse", "--verify", `${commitRef}^{commit}`], ctx.mainRoot, "解析交付提交").trim();
    const from = args.from === undefined
      ? gitOut(["rev-parse", "--verify", `${commit}^`], ctx.mainRoot, "解析交付提交的父提交").trim()
      : gitOut(["rev-parse", "--verify", `${str(args, "from")}^{commit}`], ctx.mainRoot, "解析 --from").trim();
    if (from === commit) throw new Fail("交付提交与起点相同，没有可集成内容", EXIT.rejected);
    const passing = task.checks.filter((c) => c.exitCode === 0);
    if (passing.length === 0) throw new Fail(`任务 ${id} 尚无通过的检查记录，不能进入待集成（先 task check）`, EXIT.rejected);
    task.commit = commit;
    task.from = from;
    task.status = "integration-ready";
    saveTask(paths, task);
    console.log(`任务 ${id} → 待集成（交付提交 ${commit.slice(0, 7)}，通过检查 ${passing.length} 项）`);
    return EXIT.ok;
  }

  if (sub === "show") {
    if (flag(args, "json")) { console.log(JSON.stringify(task, null, 2)); return EXIT.ok; }
    console.log(`任务 ${task.id}`);
    console.log(`  模块：${task.module}`);
    console.log(`  负责人：${task.owner}`);
    console.log(`  状态：${STATUS_LABEL[task.status] ?? task.status}`);
    console.log(`  写入范围：${task.paths.join(", ")}`);
    if (task.commit) console.log(`  交付提交：${task.commit}`);
    if (task.integratedCommit) console.log(`  已集成提交：${task.integratedCommit}`);
    if (task.snapshot) console.log(`  集成快照：${task.snapshot}`);
    if (task.build) console.log(`  所在构建：${task.build}`);
    if (task.acceptance) console.log(`  验收记录：${task.acceptance}`);
    console.log(`  公共接口：${task.publicInterface ? "是" : "否"}`);
    if (task.needs.length) console.log(`  依赖任务：${task.needs.join(", ")}`);
    console.log("  检查记录：");
    for (const c of task.checks) {
      console.log(`    - ${c.at} exit=${c.exitCode} ${c.cmd}${c.logPath ? `（日志 ${c.logPath}）` : ""}`);
    }
    if (task.notes) console.log(`  备注：${task.notes}`);
    return EXIT.ok;
  }

  throw new Fail(`未知 task 子命令：${sub}（可用 add|update|check|ready|list|show）`, EXIT.usage);
}

// ---------------------------------------------------------------- 集成快照

function snapshotSeq(id) {
  const m = /^snap-(\d+)$/.exec(id ?? "");
  return m ? Number.parseInt(m[1], 10) : 0;
}

function nextSnapshotId(paths) {
  const existing = readJsonDir(paths.snapshots).map((s) => snapshotSeq(s.id));
  const max = existing.length ? Math.max(...existing) : 0;
  return `snap-${String(max + 1).padStart(2, "0")}`;
}

function latestSnapshot(paths) {
  const all = readJsonDir(paths.snapshots).sort((a, b) => snapshotSeq(a.id) - snapshotSeq(b.id));
  return all.length ? all[all.length - 1] : null;
}

function taskChangedEntries(ctx, task) {
  const out = gitOut(["diff", "--name-status", `${task.from}..${task.commit}`], ctx.mainRoot, "读取交付提交改动");
  const entries = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    const paths = parts.slice(1).map((p) => p.replace(/\\/g, "/"));
    entries.push({ status, paths });
  }
  return entries;
}

function entriesCovered(entries, declared) {
  const missing = [];
  for (const e of entries) {
    // 改名/新增/删除的每一侧都必须落在声明范围内，否则视为越界
    const uncovered = e.paths.filter((p) => !declared.some((d) => pathCovered(d, p) || pathCovered(p, d)));
    if (uncovered.length) missing.push(`${e.status} ${e.paths.join(" → ")}`);
  }
  return missing;
}

function parseWorktrees(mainRoot) {
  const out = gitOut(["worktree", "list", "--porcelain"], mainRoot, "列出 Worktree");
  const items = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) continue;
    const item = { path: "", branch: null, detached: false };
    for (const line of lines) {
      if (line.startsWith("worktree ")) item.path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) item.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") item.detached = true;
    }
    if (item.path) items.push(item);
  }
  return items;
}

function isToolWorktree(ctx, wt) {
  const entry = parseWorktrees(ctx.mainRoot).find((w) => samePath(w.path, wt));
  if (!entry) return false;
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], wt);
  if (common.status !== 0) return false;
  return samePath(common.stdout.trim(), ctx.commonDir) && !samePath(wt, ctx.mainRoot);
}

function assertClean(wt, what) {
  const relevant = dirtyEntries(wt).filter((e) => e.paths.some((p) => !isBuildOutputPath(p)));
  if (relevant.length) {
    const text = relevant.map((e) => `${e.code} ${e.paths.join(" → ")}`).join("\n");
    throw new Fail(`${what}存在未提交改动，集成/构建拒绝执行（先确认归属并处理）：\n${text}`, EXIT.rejected);
  }
}

// 集成工作区的构建产物与共享依赖不参与状态判定：它们由本工具或构建本身产生，
// 既不是任务交付内容，也不能因为上一次构建的残留阻塞下一次集成。
const BUILD_OUTPUT_PREFIXES = [
  "node_modules/", "dist/", ".preview/", ".screenshots/", "tmp/",
  "src-tauri/target", "src-tauri/gen/", "apps/mobile/android/",
];

function isBuildOutputPath(rawPath) {
  const p = String(rawPath).replace(/\\/g, "/");
  return BUILD_OUTPUT_PREFIXES.some((prefix) => (prefix.endsWith("/") ? p.startsWith(prefix) : p.startsWith(prefix)));
}

function dirtyEntries(wt) {
  const out = gitOut(["status", "--porcelain", "-z"], wt, "读取工作区状态");
  const parts = out.split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    const code = item.slice(0, 2);
    const path = item.slice(3).replace(/\\/g, "/");
    if (code[0] === "R" || code[0] === "C") {
      const from = (parts[++i] ?? "").replace(/\\/g, "/");
      entries.push({ code, paths: [path, from] });
    } else {
      entries.push({ code, paths: [path] });
    }
  }
  return entries;
}

function prepareWorktree(ctx, baseCommit) {
  const wt = integrationWorktree(ctx);
  const registered = parseWorktrees(ctx.mainRoot).find((w) => samePath(w.path, wt));

  if (!existsSync(wt)) {
    if (registered) {
      throw new Fail(`集成工作区目录缺失但 Git 仍有登记：${wt}\n先人工确认废弃后执行 git worktree prune`, EXIT.rejected);
    }
    if (!isInside(dirname(ctx.mainRoot), wt)) {
      throw new Fail(`集成工作区必须位于主仓库同级目录：${wt}`, EXIT.rejected);
    }
    const branchExists = git(["rev-parse", "--verify", `refs/heads/${BRANCH}`], ctx.mainRoot).status === 0;
    const args = branchExists
      ? ["worktree", "add", wt, BRANCH]
      : ["worktree", "add", "-b", BRANCH, wt, baseCommit];
    const r = git(args, ctx.mainRoot, { timeout: 300000 });
    if (r.status !== 0) throw new Fail(`创建集成工作区失败：${(r.stderr || r.stdout).trim()}`, EXIT.rejected);
    console.log(`已创建集成工作区：${wt}（分支 ${BRANCH}）`);
  } else if (!registered) {
    throw new Fail(`路径已存在但不是本仓库登记的工作区，拒绝触碰：${wt}`, EXIT.rejected);
  } else if (!isToolWorktree(ctx, wt)) {
    throw new Fail(`工作区不属于本仓库或就是主工作区，拒绝操作：${wt}`, EXIT.rejected);
  }

  assertClean(wt, "集成工作区");

  const holders = parseWorktrees(ctx.mainRoot)
    .filter((w) => w.branch === BRANCH && !samePath(w.path, wt));
  if (holders.length) {
    throw new Fail(`分支 ${BRANCH} 同时被其他工作区占用：${holders.map((h) => h.path).join(", ")}`, EXIT.rejected);
  }

  const head = gitOut(["rev-parse", "HEAD"], wt, "读取集成工作区 HEAD").trim();
  void head;
  // 无论当前是 HEAD==base 还是落后，都把工具自有分支固定到基线提交；-B 只作用于 integration
  const r = git(["checkout", "-q", "-B", BRANCH, baseCommit], wt);
  if (r.status !== 0) throw new Fail(`切换集成工作区到 ${baseCommit.slice(0, 7)} 失败：${(r.stderr || r.stdout).trim()}`, EXIT.rejected);
  assertClean(wt, "集成工作区");
  return wt;
}

function cleanupWorktree(wt, commit) {
  // 仅用于工具自有干净工作区：应用补丁或检查失败后回到起点，避免半个补丁留在工作区。
  if (!existsSync(wt)) return;
  git(["reset", "--hard", "--quiet", commit], wt);
  git(["reset", "--quiet"], wt);
  const dirty = git(["status", "--porcelain"], wt);
  if (dirty.status === 0 && dirty.stdout.trim() !== "") {
    console.error(`警告：集成工作区清理后仍有改动，请人工检查：\n${dirty.stdout.trim()}`);
  }
}

function applyPatch(wt, patch, label) {
  if (!patch.trim()) {
    console.log(`  · ${label}：无内容变化（跳过）`);
    return;
  }
  const r = spawnSync("git", ["apply", "--index", "--3way", "--whitespace=nowarn"], {
    cwd: wt, input: patch, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Fail(
      `应用 ${label} 失败（可能与已集成改动冲突）：\n${(r.stderr || r.stdout).trim()}\n` +
      "请先读双方 diff 确认归属，必要时调整集成顺序或改用 Worktree 隔离后重新交付。",
      EXIT.rejected,
    );
  }
}

function appliedPaths(wt) {
  // 只关心补丁真正落地/暂存的条目；构建产物已按 BUILD_OUTPUT_PREFIXES 排除
  return dirtyEntries(wt).filter((e) => e.paths.some((p) => !isBuildOutputPath(p)));
}

function lockFileOf(ctx, commit, name) {
  const r = git(["show", `${commit}:${name}`], ctx.mainRoot);
  return r.status === 0 ? r.stdout : null;
}

function normalizeNewlines(text) {
  // 换行风格由 core.autocrlf 决定，不是依赖差异；比较前统一成 LF
  return String(text).replace(/\r\n/g, "\n");
}

function dependencyMap(text) {
  try {
    const json = JSON.parse(text);
    const pick = (key) => {
      const value = json?.[key];
      if (!value || typeof value !== "object") return null;
      return Object.keys(value).sort().map((k) => [k, value[k]]);
    };
    return JSON.stringify({
      dependencies: pick("dependencies"),
      devDependencies: pick("devDependencies"),
      optionalDependencies: pick("optionalDependencies"),
      peerDependencies: pick("peerDependencies"),
    });
  } catch { return null; }
}

function ensureNodeModulesLink(ctx, wt, commit) {
  const nm = join(wt, "node_modules");
  if (existsSync(nm)) {
    let st;
    try { st = lstatSync(nm); } catch { st = null; }
    if (st && st.isSymbolicLink()) {
      const real = resolve(wt, readlinkSafe(nm) ?? "");
      if (!samePath(real, join(ctx.mainRoot, "node_modules"))) {
        throw new Fail(`集成工作区 node_modules 链接指向异常：${real}`, EXIT.rejected);
      }
      return;
    }
    return; // 独立安装，保留
  }
  // 依赖是否一致以 package-lock 为准；package.json 只比较依赖段（脚本/元数据差异不影响已装依赖）
  const lockAtCommit = lockFileOf(ctx, commit, "package-lock.json");
  const lockOnDisk = join(ctx.mainRoot, "package-lock.json");
  if (lockAtCommit === null || !existsSync(lockOnDisk)) {
    throw new Fail("无法核对依赖一致性（缺少 package-lock.json），拒绝在集成工作区构建", EXIT.rejected);
  }
  if (normalizeNewlines(lockAtCommit) !== normalizeNewlines(readFileSync(lockOnDisk, "utf8"))) {
    throw new Fail(
      "集成快照的 package-lock.json 与主工作区不一致：不能在共享依赖上构建。\n" +
      "请在集成工作区内独立安装依赖（npm ci）后重试，或先确认主工作区依赖与快照一致。",
      EXIT.rejected,
    );
  }
  const pkgAtCommit = lockFileOf(ctx, commit, "package.json");
  if (pkgAtCommit !== null && existsSync(join(ctx.mainRoot, "package.json"))) {
    const a = dependencyMap(pkgAtCommit);
    const b = dependencyMap(readFileSync(join(ctx.mainRoot, "package.json"), "utf8"));
    if (a === null || b === null || a !== b) {
      throw new Fail(
        "集成快照的 package.json 依赖声明与主工作区不一致：不能在共享依赖上构建。\n" +
        "请先确认依赖版本，或在集成工作区内独立安装依赖（npm ci）。",
        EXIT.rejected,
      );
    }
  }
  const target = join(ctx.mainRoot, "node_modules");
  if (!existsSync(target)) throw new Fail(`主工作区缺少 node_modules：${target}`, EXIT.rejected);
  symlinkSync(target, nm, "junction");
  console.log(`已链接依赖（junction）：${nm} → ${target}`);
}

// 读取链接/junction 目标；失败返回 null（由调用方拒绝，不猜测）
function readlinkSafe(path) {
  try { return readlinkSync(path); } catch { return null; }
}

function runScheduled(ctx, wt, label, argvTokens, logPath, env, priority = "P1") {
  const sched = join(ctx.mainRoot, "scripts", "build-sched.mjs");
  const useSched = existsSync(sched);
  const command = useSched
    ? ["node", sched, "run", "--priority", priority, "--label", label, "--cwd", wt, "--", ...argvTokens]
    : argvTokens;
  if (!useSched) console.log("  提示：未找到构建调度器，按直接执行处理（仅测试/实验环境允许）");
  return runToLog(command, { cwd: wt, env, logPath });
}

function runToLog(command, { cwd, env, logPath }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    const r = spawnSync(command[0], command.slice(1), {
      cwd, env, stdio: ["ignore", fd, fd], windowsHide: true,
    });
    return { status: r.status, error: r.error ?? null, logPath };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

function logTail(logPath, lines = 30) {
  try {
    const text = readFileSync(logPath, "utf8");
    const all = text.split(/\r?\n/).filter((l) => l !== "");
    return all.slice(-lines).join("\n");
  } catch { return ""; }
}

function cmdSnapshotBootstrap(argv) {
  const args = parseArgs(argv);
  const ctx = repoContext();
  const paths = statePaths(ctx);
  ensureDirs(paths);

  const baseRef = str(args, "base");
  if (!baseRef) {
    throw new Fail(
      "用法：snapshot bootstrap --base <稳定提交> [--note <说明>] [--force]\n" +
      "基线快照只记录一个已确认的稳定提交，不叠加任何任务；后续用 snapshot create 增量叠加。\n" +
      "--force：基线提交经构建验证不可用、且尚无任务被集成时，另行登记一条新基线（旧记录保留）。",
      EXIT.usage,
    );
  }
  const base = gitOut(["rev-parse", "--verify", `${baseRef}^{commit}`], ctx.mainRoot, "解析 --base").trim();
  const previous = latestSnapshot(paths);
  const force = flag(args, "force");
  let replaces = null;
  if (previous) {
    if (!force) {
      throw new Fail(
        "已存在集成快照：基线只能建立一次（后续请用 snapshot create 增量叠加）。\n" +
        "若基线提交本身不可构建，且还没有任务被集成，可用 --force 重新登记一条新基线。",
        EXIT.rejected,
      );
    }
    const withTasks = readJsonDir(paths.snapshots).filter((s) => s.tasks?.length);
    if (withTasks.length) {
      throw new Fail(
        `已有任务被集成进快照（${withTasks.map((s) => s.id).join(", ")}），不能重置基线——那会丢失任务关联。`,
        EXIT.rejected,
      );
    }
    if (samePath(previous.commit, base)) {
      throw new Fail(`基线提交与现有快照 ${previous.id} 相同，无需重新登记`, EXIT.rejected);
    }
    replaces = previous.id;
  }

  const snapId = nextSnapshotId(paths);
  const record = {
    id: snapId,
    branch: BRANCH,
    worktree: integrationWorktree(ctx),
    base,
    commit: base,
    tasks: [],
    checks: [],
    note: str(args, "note"),
    createdAt: nowIso(),
    bootstrap: true,
    ...(replaces ? { replaces } : {}),
  };
  writeJson(join(paths.snapshots, `${snapId}.json`), record);
  if (replaces) {
    console.log(`已重新登记基线快照 ${snapId}：${base.slice(0, 7)}（替代 ${replaces}，后者保留为历史记录）`);
  } else {
    console.log(`已登记基线快照 ${snapId}：${base.slice(0, 7)}（不含任何任务改动）`);
  }
  console.log(`下一步：npm run integrate -- build --snapshot ${snapId} --platform desktop`);
  return EXIT.ok;
}

function cmdSnapshotCreate(argv) {
  const args = parseArgs(argv);
  const ctx = repoContext();
  const paths = statePaths(ctx);
  ensureDirs(paths);

  const selectedIds = list(args.tasks);
  const allReady = flag(args, "allReady");
  if (selectedIds.length === 0 && !allReady) {
    throw new Fail("用法：snapshot create --tasks a,b,c（或 --all-ready）[--base <提交>] [--check static|none]", EXIT.usage);
  }

  let tasks = (allReady
    ? readJsonDir(paths.tasks).sort((a, b) => a.id.localeCompare(b.id))
    : selectedIds.map((id) => loadTask(paths, id)));
  if (allReady) {
    // 只挑真正有「未集成交付」的任务：已集成且交付提交没变的不再重复应用
    tasks = tasks.filter((t) => {
      if (t.status === "integration-ready") return true;
      return (t.status === "integrated" || t.status === "verifying" || t.status === "accept-failed")
        && t.commit && t.commit !== t.integratedCommit;
    });
  }
  if (tasks.length === 0) throw new Fail("没有可集成任务（待集成队列为空）", EXIT.usage);

  for (const t of tasks) {
    if (t.status === "integrated" && t.commit === t.integratedCommit) {
      throw new Fail(`任务 ${t.id} 已集成在该提交，且没有新的交付提交（无需重复集成）`, EXIT.rejected);
    }
    if (!["integration-ready", "integrated", "verifying", "accept-failed"].includes(t.status)) {
      throw new Fail(`任务 ${t.id} 当前状态为「${STATUS_LABEL[t.status] ?? t.status}」，只有「待集成」（或返工后的新交付）可进入集成`, EXIT.rejected);
    }
    if (!t.commit) throw new Fail(`任务 ${t.id} 没有交付提交（先 task ready）`, EXIT.rejected);
    if (!t.paths?.length) throw new Fail(`任务 ${t.id} 缺少写入范围声明`, EXIT.rejected);
  }

  const check = str(args, "check", tasks.length ? "static" : "none");
  if (!["none", "static"].includes(check)) throw new Fail(`--check 只能是 none|static（当前 ${check}）`, EXIT.usage);
  const allowOverlap = flag(args, "allowOverlap");
  const allowExtra = flag(args, "allowExtraPaths");

  // 1) 解析基线：首次集成必须显式给出稳定提交
  const previous = latestSnapshot(paths);
  let base;
  if (args.base !== undefined) {
    base = gitOut(["rev-parse", "--verify", `${str(args, "base")}^{commit}`], ctx.mainRoot, "解析 --base").trim();
  } else if (previous) {
    base = previous.commit;
  } else {
    throw new Fail(
      "首次集成必须显式指定 --base <稳定提交>：\n" +
      "  它应当是一个已确认的、可构建的提交（例如上一轮已验证的 release 提交），" +
      "不能用共享工作区的当前 HEAD 代替——那里的提交可能混有仍在开发的任务。",
      EXIT.usage,
    );
  }

  // 2) 每个任务的改动与声明范围核对
  const plans = [];
  for (const t of tasks) {
    const changed = taskChangedEntries(ctx, t);
    const extra = entriesCovered(changed, t.paths);
    if (extra.length && !allowExtra) {
      throw new Fail(
        `任务 ${t.id} 的交付提交包含未声明路径，拒绝集成（防止把其他任务的改动带进快照）：\n` +
        extra.map((e) => `  ${e}`).join("\n") +
        "\n处理：收窄交付提交，或确认这些文件属于本任务后用 --allow-extra-paths 显式放行。",
        EXIT.rejected,
      );
    }
    const missing = t.paths.filter((d) => !changed.some((e) => e.paths.some((p) => pathCovered(d, p))));
    if (missing.length) console.log(`  提示：任务 ${t.id} 声明的 ${missing.length} 项路径在交付提交里没有改动：${missing.join(", ")}`);
    plans.push({ task: t, changed, extra });
  }

  // 3) 选中任务之间的路径交集（同一文件只能有一个所有者）
  const overlaps = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      for (const a of plans[i].task.paths) {
        for (const b of plans[j].task.paths) {
          if (pathCovered(a, b) || pathCovered(b, a) || a === b) {
            overlaps.push(`${plans[i].task.id} ↔ ${plans[j].task.id}：${a}${a === b ? "" : ` / ${b}`}`);
          }
        }
      }
    }
  }
  if (overlaps.length && !allowOverlap) {
    throw new Fail(
      `选中任务之间存在写入范围交集，拒绝同批集成（交集文件只能有一个所有者）：\n` +
      overlaps.map((o) => `  ${o}`).join("\n") +
      "\n处理：拆分批次按顺序集成，或确认合并方案后用 --allow-overlap 显式放行。",
      EXIT.rejected,
    );
  }

  const snapId = nextSnapshotId(paths);
  console.log(`集成快照 ${snapId}：基线 ${base.slice(0, 7)}，任务 ${tasks.map((t) => t.id).join(", ")}`);
  if (overlaps.length) console.log(`  放行交集（--allow-overlap）：${overlaps.join("；")}`);

  if (flag(args, "dryRun")) {
    for (const p of plans) {
      console.log(`  · ${p.task.id} ${p.task.commit.slice(0, 7)} → ${p.changed.length} 个路径条目`);
      if (p.extra.length) console.log(`    放行未声明路径：${p.extra.join("；")}`);
    }
    console.log(`  · 检查级别：${check === "none" ? "跳过" : "静态（tsc + vite build）"}`);
    console.log("  · dry-run：未创建快照、未写工作区");
    return EXIT.ok;
  }

  const wt = prepareWorktree(ctx, base);
  const checkLog = join(paths.logs, `${snapId}-checks.log`);
  try {
    // 4) 逐个应用交付提交的声明路径改动
    for (const p of plans) {
      const list = p.task.paths;
      const patch = gitOut(
        ["diff", "--binary", `${p.task.from}..${p.task.commit}`, "--", ...list],
        ctx.mainRoot, `读取 ${p.task.id} 补丁`,
      );
      applyPatch(wt, patch, p.task.id);
      console.log(`  · 已应用 ${p.task.id}（${p.task.commit.slice(0, 7)}）`);
    }

    // 5) 结果必须严格落在声明范围内
    const applied = appliedPaths(wt);
    const declared = tasks.flatMap((t) => t.paths);
    const strays = applied.filter((e) => !e.paths.some((p) => declared.some((d) => pathCovered(d, p) || pathCovered(p, d))));
    if (strays.length) {
      throw new Fail(
        `集成工作区出现声明范围外的改动，拒绝提交快照：\n${strays.map((s) => `  ${s.code} ${s.paths.join(" → ")}`).join("\n")}`,
        EXIT.rejected,
      );
    }

    // 6) 集成检查（真实执行，不接受“应该能过”）
    let checkResult = null;
    if (check === "static") {
      ensureNodeModulesLink(ctx, wt, base);
      console.log("  执行集成静态检查：tsc --noEmit && vite build（经构建调度器排队）");
      const r = runScheduled(ctx, wt, `integration-${snapId}-static`, ["npm", "run", "build:raw"], checkLog, {
        ...process.env, CARGO_TARGET_DIR: join(ctx.mainRoot, "src-tauri", "target-integration"),
      });
      checkResult = { cmd: "npm run build:raw", exitCode: r.status, at: nowIso(), logPath: rel(ctx.mainRoot, checkLog) };
      if (r.status !== 0) {
        throw new Fail(`集成静态检查失败（exit ${r.status}）：\n${logTail(checkLog)}\n日志：${checkLog}`, EXIT.buildFailed);
      }
      console.log("  静态检查通过");
    }

    // 7) 生成快照提交（提交信息带任务关联，供 git log 追溯）
    const subject = `integration: ${tasks.length} 项已集成任务（${snapId}）`;
    const body = [
      `TaskDock-Snapshot: ${snapId}`,
      `TaskDock-Base: ${base}`,
      `TaskDock-Tasks: ${tasks.map((t) => `${t.id}=${t.commit}`).join(" ")}`,
      `TaskDock-Check: ${checkResult ? `${checkResult.cmd} exit=${checkResult.exitCode}` : "none"}`,
    ].join("\n");
    const commitArgs = ["commit", "--quiet", "-m", subject, "-m", body];
    const cr = git(commitArgs, wt);
    if (cr.status !== 0) throw new Fail(`生成快照提交失败：${(cr.stderr || cr.stdout).trim()}`, EXIT.rejected);
    const commit = gitOut(["rev-parse", "HEAD"], wt, "读取快照提交").trim();
    assertClean(wt, "集成工作区（提交后）");

    const record = {
      id: snapId,
      branch: BRANCH,
      worktree: wt,
      base,
      commit,
      tasks: plans.map((p) => ({
        id: p.task.id,
        module: p.task.module,
        owner: p.task.owner,
        commit: p.task.commit,
        from: p.task.from,
        paths: p.task.paths,
      })),
      ignoredPaths: plans.flatMap((p) => p.extra.map((e) => `${p.task.id}: ${e}`)),
      overlaps,
      checks: checkResult ? [checkResult] : [],
      note: str(args, "note"),
      createdAt: nowIso(),
    };
    writeJson(join(paths.snapshots, `${snapId}.json`), record);

    for (const p of plans) {
      p.task.status = "integrated";
      p.task.integratedCommit = p.task.commit;
      p.task.snapshot = snapId;
      p.task.build = null;
      p.task.acceptance = null;
      saveTask(paths, p.task);
    }

    console.log(`快照 ${snapId} 完成：${commit.slice(0, 7)}（含 ${tasks.length} 项任务）`);
    console.log(`下一步：npm run integrate -- build --snapshot ${snapId} --platform desktop`);
    return EXIT.ok;
  } catch (err) {
    cleanupWorktree(wt, base);
    throw err;
  }
}

// ---------------------------------------------------------------- 统一构建

const PLATFORMS = {
  desktop: {
    config: "release-nsis-msi",
    command: ["npm", "run", "tauri:raw", "--", "build"],
    artifacts: [
      { kind: "glob", base: "<target>/release/bundle/nsis", pattern: "*.exe" },
      { kind: "glob", base: "<target>/release/bundle/msi", pattern: "*.msi" },
    ],
    needsNodeModules: true,
    needsTarget: true,
    diskPrecheck: true,
  },
  web: {
    config: "frontend-dist",
    command: ["npm", "run", "build:raw"],
    artifacts: [{ kind: "dir", path: "<worktree>/dist", name: "dist" }],
    needsNodeModules: true,
    needsTarget: false,
    diskPrecheck: false,
  },
  android: {
    config: "apk-release",
    command: ["npm", "--prefix", "apps/mobile", "run", "build:android"],
    artifacts: [{ kind: "glob", base: "<worktree>/apps/mobile/android/app/build/outputs/apk/release", pattern: "*.apk" }],
    needsNodeModules: true,
    needsTarget: false,
    diskPrecheck: true,
    requires: ["apps/mobile/android"],
  },
};

function nextBuildId(paths, snapId, platform) {
  const seq = String(snapshotSeq(snapId)).padStart(2, "0");
  const prefix = `b${seq}-${platform}-r`;
  const existing = readdirSync(paths.builds, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => Number.parseInt(e.name.slice(prefix.length), 10))
    .filter((n) => Number.isInteger(n));
  const max = existing.length ? Math.max(...existing) : 0;
  return `${prefix}${max + 1}`;
}

function expandPattern(baseAbs, pattern) {
  const segs = pattern.split("/").filter(Boolean);
  let current = [baseAbs];
  for (const seg of segs) {
    const next = [];
    for (const dir of current) {
      if (!existsSync(dir)) continue;
      if (!seg.includes("*")) {
        const p = join(dir, seg);
        if (existsSync(p)) next.push(p);
        continue;
      }
      const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/\\\\]*")}$`, "i");
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (re.test(e.name)) next.push(join(dir, e.name));
    }
    current = next;
  }
  return current.filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
}

function dirDigest(root) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push(abs);
    }
  };
  walk(root);
  files.sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  let bytes = 0;
  for (const f of files) {
    const size = statSync(f).size;
    bytes += size;
    hash.update(`${relative(root, f).split(sep).join("/")}\0${sha256File(f)}\0${size}\n`);
  }
  return { sha256: hash.digest("hex"), files: files.length, bytes };
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) copyDir(from, to);
    else if (e.isFile()) copyFileSync(from, to);
  }
}

function collectArtifacts(platform, cfg, ctx, wt, buildDir, targetDir) {
  const out = [];
  for (const spec of cfg.artifacts) {
    if (spec.kind === "glob") {
      const baseAbs = spec.base.replace("<target>", targetDir ?? "").replace("<worktree>", wt);
      const found = expandPattern(baseAbs, spec.pattern);
      for (const file of found) {
        const name = basename(file);
        const dest = join(buildDir, "artifacts", name);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(file, dest);
        out.push({ name, kind: "file", sourcePath: file, copiedTo: rel(ctx.mainRoot, dest), bytes: statSync(dest).size, sha256: sha256File(dest) });
      }
    } else if (spec.kind === "dir") {
      const src = spec.path.replace("<worktree>", wt).replace("<target>", targetDir ?? "");
      if (!existsSync(src)) continue;
      const digest = dirDigest(src);
      const dest = join(buildDir, "artifacts", spec.name ?? basename(src));
      copyDir(src, dest);
      out.push({ name: spec.name ?? basename(src), kind: "dir", sourcePath: src, copiedTo: rel(ctx.mainRoot, dest), ...digest });
    }
  }
  return out;
}

function findReusableBuild(paths, reuseKey) {
  const dirs = readdirSync(paths.builds, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const name of dirs.sort().reverse()) {
    const record = readJson(join(paths.builds, name, "build.json"));
    if (!record || record.status !== "succeeded" || record.reuseKey !== reuseKey) continue;
    const artifactsOk = (record.artifacts ?? []).every((a) => {
      const p = join(paths.builds, name, "artifacts", a.name);
      if (a.kind === "dir") return existsSync(p);
      return existsSync(p) && sha256File(p) === a.sha256;
    });
    if (!artifactsOk) continue;
    return record;
  }
  return null;
}

function ensureBuildWorktree(ctx, commit) {
  const wt = integrationWorktree(ctx);
  if (!existsSync(wt)) {
    const registered = parseWorktrees(ctx.mainRoot).find((w) => samePath(w.path, wt));
    if (registered) {
      throw new Fail(`集成工作区目录缺失但 Git 仍有登记：${wt}\n先人工确认废弃后执行 git worktree prune`, EXIT.rejected);
    }
    const r = git(["worktree", "add", "--detach", wt, commit], ctx.mainRoot, { timeout: 300000 });
    if (r.status !== 0) throw new Fail(`创建集成构建工作区失败：${(r.stderr || r.stdout).trim()}`, EXIT.rejected);
    console.log(`已创建集成构建工作区（detached ${commit.slice(0, 7)}）：${wt}`);
  } else if (!isToolWorktree(ctx, wt)) {
    throw new Fail(`集成工作区不属于本仓库或就是主工作区：${wt}`, EXIT.rejected);
  }
  return wt;
}

function cmdBuild(argv) {
  const args = parseArgs(argv);
  const ctx = repoContext();
  const paths = statePaths(ctx);
  ensureDirs(paths);

  const snapRef = str(args, "snapshot", "latest");
  const snap = snapRef === "latest" ? latestSnapshot(paths) : readJson(join(paths.snapshots, `${snapRef}.json`));
  if (!snap) throw new Fail(`快照不存在：${snapRef}（先 snapshot create）`, EXIT.usage);

  const platform = str(args, "platform");
  const cfg = PLATFORMS[platform];
  if (!cfg) throw new Fail(`--platform 只能是 ${Object.keys(PLATFORMS).join("|")}（当前 ${platform || "空"}）`, EXIT.usage);

  let targetDir = null;
  if (cfg.needsTarget) {
    if (args.targetDir === undefined) {
      targetDir = join(ctx.mainRoot, "src-tauri", "target-integration");
    } else {
      const raw = str(args, "targetDir");
      if (!isAbsolute(raw)) throw new Fail(`--target-dir 必须是绝对路径（当前 ${raw}）`, EXIT.usage);
      targetDir = resolve(raw);
    }
    if (!isInside(ctx.mainRoot, targetDir)) {
      throw new Fail(`--target-dir 必须在主仓库内（构建缓存规范）：${targetDir}`, EXIT.rejected);
    }
  }

  const priority = str(args, "priority", "P0");

  const reuseKey = `${snap.commit}|${platform}|${cfg.config}`;
  if (!flag(args, "force")) {
    const reusable = findReusableBuild(paths, reuseKey);
    if (reusable) {
      console.log(`复用已有构建 ${reusable.id}（同一提交 ${snap.commit.slice(0, 7)} / ${platform} / ${cfg.config}）`);
      for (const a of reusable.artifacts) console.log(`  · ${a.name} ${a.kind === "dir" ? `${a.files} 个文件` : `${(a.bytes / 1024 / 1024).toFixed(1)} MB`} sha256=${a.sha256.slice(0, 12)}… ${a.copiedTo}`);
      markSnapshotTasks(paths, snap, reusable.id, "verifying");
      return EXIT.ok;
    }
  }

  const buildId = nextBuildId(paths, snap.id, platform);
  const buildDir = join(paths.builds, buildId);
  const logPath = join(buildDir, "build.log");

  const wt = ensureBuildWorktree(ctx, snap.commit);

  let command = cfg.command;
  const override = args.command === undefined ? null : str(args, "command");
  if (override) {
    command = ["cmd.exe", "/d", "/s", "/c", override];
    console.log("  提示：使用 --command 覆盖平台命令（仅测试/实验，绕过构建调度器）");
  }

  const env = { ...process.env };
  if (cfg.needsTarget) env.CARGO_TARGET_DIR = targetDir;

  console.log(`构建 ${buildId}：快照 ${snap.id} / ${snap.commit.slice(0, 7)} / ${platform} / ${cfg.config}`);
  if (flag(args, "dryRun")) {
    console.log(`  工作区：${wt}`);
    console.log(`  目标缓存：${cfg.needsTarget ? targetDir : "(无)"}`);
    console.log(`  命令：${command.join(" ")}`);
    console.log(`  调度：${override ? "直接执行（覆盖命令）" : "经 scripts/build-sched.mjs 排队"}`);
    console.log("  产物：");
    for (const spec of cfg.artifacts) {
      console.log(`    - ${spec.kind === "glob" ? `${spec.base}/${spec.pattern}` : spec.path}`);
    }
    console.log("  dry-run：未切换工作区、未执行构建、未写记录");
    return EXIT.ok;
  }

  // 磁盘预检（重型构建）：复用 build-guard，不另造门槛
  if (cfg.diskPrecheck && !override) {
    const guard = join(ctx.mainRoot, "scripts", "build-guard.mjs");
    if (existsSync(guard)) {
      const r = spawnSync("node", [guard, "precheck"], { cwd: ctx.mainRoot, encoding: "utf8", windowsHide: true, timeout: 120000 });
      if (r.status === 2) {
        throw new Fail(`磁盘预检未通过（build-guard exit 2）：\n${(r.stdout || "") + (r.stderr || "")}\n先按 docs/DEVELOPMENT.md 第七章处理空间后再构建。`, EXIT.rejected);
      }
    }
  }

  const requiredPaths = [wt];
  for (const relPath of cfg.requires ?? []) requiredPaths.push(join(wt, relPath));

  const startedAt = nowIso();
  const startedMs = Date.now();
  let record = null;

  try {
    // 干净快照工作区：其他人工作区里的未提交改动无法进入这里
    assertClean(wt, "集成工作区（构建前）");
    const r = git(["checkout", "--quiet", "--detach", snap.commit], wt);
    if (r.status !== 0) throw new Fail(`切换集成工作区到快照提交失败：${(r.stderr || r.stdout).trim()}`, EXIT.rejected);
    const head = gitOut(["rev-parse", "HEAD"], wt, "校验构建提交").trim();
    if (head !== snap.commit) throw new Fail(`构建提交与快照不一致：${head} ≠ ${snap.commit}`, EXIT.rejected);
    assertClean(wt, "集成工作区（切换后）");

    for (const p of requiredPaths) {
      if (!existsSync(p)) {
        throw new Fail(
          `缺少构建必需的非入库目录：${p}\n` +
          (platform === "android"
            ? "移动端需在集成工作区内生成 apps/mobile/android（npx expo prebuild --platform android），该目录不入库。"
            : "确认路径是否存在，或改在具备该输入的工作区构建。"),
          EXIT.rejected,
        );
      }
    }
    if (cfg.needsNodeModules && !override) ensureNodeModulesLink(ctx, wt, snap.commit);
    if (cfg.needsTarget) mkdirSync(targetDir, { recursive: true });

    console.log(`  执行：${command.join(" ")}`);
    const result = override
      ? runToLog(command, { cwd: wt, env, logPath })
      : runScheduled(ctx, wt, `integration-${buildId}`, command, logPath, env, priority);

    const durationMs = Date.now() - startedMs;
    const status = result.status === 0 ? "succeeded" : "failed";
    const artifacts = status === "succeeded" ? collectArtifacts(platform, cfg, ctx, wt, buildDir, cfg.needsTarget ? targetDir : null) : [];

    record = {
      id: buildId,
      snapshot: snap.id,
      commit: snap.commit,
      shortCommit: snap.commit.slice(0, 7),
      dirty: false,
      platform,
      config: cfg.config,
      reuseKey,
      status,
      exitCode: result.status,
      startedAt,
      finishedAt: nowIso(),
      durationMs,
      tasks: (snap.tasks ?? []).map((t) => ({ id: t.id, commit: t.commit, module: t.module, owner: t.owner })),
      command,
      cwd: wt,
      targetDir: cfg.needsTarget ? targetDir : null,
      logPath: rel(ctx.mainRoot, logPath),
      artifacts,
      host: `${process.platform}-${process.arch}`,
    };
    writeJson(join(buildDir, "build.json"), record);

    if (status !== "succeeded") {
      throw new Fail(`构建失败（exit ${result.status}）：\n${logTail(logPath)}\n日志：${logPath}`, EXIT.buildFailed);
    }

    console.log(`构建 ${buildId} 完成：${durationMs} ms，产物 ${artifacts.length} 项`);
    for (const a of artifacts) {
      console.log(`  · ${a.name} ${a.kind === "dir" ? `${a.files} 个文件 / ${(a.bytes / 1024 / 1024).toFixed(2)} MB` : `${(a.bytes / 1024 / 1024).toFixed(2)} MB`}`);
      console.log(`    sha256=${a.sha256}`);
      console.log(`    ${a.copiedTo}`);
    }
    if (artifacts.length === 0) {
      console.log("  警告：未收集到产物，请核对平台产物路径（记录已落盘，供排查）");
    }
    markSnapshotTasks(paths, snap, buildId, "verifying");
    console.log(`包含任务：${(snap.tasks ?? []).map((t) => t.id).join(", ") || "(无)"}`);
    console.log(`验收记录：npm run integrate -- accept --build ${buildId} --task <任务> --status pass`);
    return EXIT.ok;
  } catch (err) {
    if (!record) {
      record = {
        id: buildId,
        snapshot: snap.id,
        commit: snap.commit,
        shortCommit: snap.commit.slice(0, 7),
        dirty: false,
        platform,
        config: cfg.config,
        reuseKey,
        status: "failed",
        exitCode: err.code ?? EXIT.rejected,
        startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - startedMs,
        tasks: (snap.tasks ?? []).map((t) => ({ id: t.id, commit: t.commit, module: t.module, owner: t.owner })),
        command,
        cwd: wt,
        targetDir: cfg.needsTarget ? targetDir : null,
        logPath: existsSync(logPath) ? rel(ctx.mainRoot, logPath) : null,
        artifacts: [],
        host: `${process.platform}-${process.arch}`,
        reason: err.message.split("\n")[0],
      };
      writeJson(join(buildDir, "build.json"), record);
    }
    throw err;
  }
}

function markSnapshotTasks(paths, snap, buildId, status) {
  for (const t of snap.tasks ?? []) {
    const task = readJson(taskFile(paths, t.id));
    if (!task) continue;
    if (task.status === "accept-passed") continue;
    task.status = status;
    task.build = buildId;
    saveTask(paths, task);
  }
}

// ---------------------------------------------------------------- 验收记录

function cmdAccept(argv) {
  const args = parseArgs(argv);
  const ctx = repoContext();
  const paths = statePaths(ctx);
  ensureDirs(paths);

  const buildId = str(args, "build");
  const taskId = str(args, "task");
  const status = str(args, "status");
  if (!buildId || !taskId) throw new Fail("用法：accept --build <id> --task <id> --status pass|fail|blocked|not-run", EXIT.usage);
  if (!ACCEPT_STATUS.includes(status)) throw new Fail(`--status 只能是 ${ACCEPT_STATUS.join("|")}`, EXIT.usage);

  const buildDir = join(paths.builds, buildId);
  const build = readJson(join(buildDir, "build.json"));
  if (!build) throw new Fail(`构建不存在：${buildId}`, EXIT.usage);
  const task = loadTask(paths, taskId);
  if (!(build.tasks ?? []).some((t) => t.id === taskId)) {
    throw new Fail(`任务 ${taskId} 不在构建 ${buildId} 的任务清单里（构建包含：${(build.tasks ?? []).map((t) => t.id).join(", ")}）`, EXIT.rejected);
  }

  let evidence = null;
  if (args.evidence !== undefined) {
    const raw = str(args, "evidence");
    evidence = isAbsolute(raw) ? resolve(raw) : resolve(ctx.mainRoot, raw);
    if (!isInside(ctx.mainRoot, evidence)) throw new Fail(`证据路径必须在仓库内：${raw}`, EXIT.rejected);
    if (!existsSync(evidence)) throw new Fail(`证据路径不存在：${rel(ctx.mainRoot, evidence)}`, EXIT.rejected);
    evidence = rel(ctx.mainRoot, evidence);
  }

  const note = str(args, "note");
  const repro = str(args, "repro");
  if (status === "fail" && !note) {
    throw new Fail("验收失败必须写 --note（失败现象 + 影响），便于负责人复现修复", EXIT.rejected);
  }

  const record = {
    build: buildId,
    snapshot: build.snapshot,
    commit: build.commit,
    task: taskId,
    status,
    note,
    repro,
    evidencePaths: evidence ? [evidence] : [],
    agent: str(args, "agent", task.owner),
    at: nowIso(),
  };
  const dest = join(buildDir, "acceptance", `${taskId}.json`);
  writeJson(dest, record);

  if (status === "pass") { task.status = "accept-passed"; task.acceptance = rel(ctx.mainRoot, dest); }
  else if (status === "fail") { task.status = "accept-failed"; task.acceptance = rel(ctx.mainRoot, dest); }
  else { task.acceptance = rel(ctx.mainRoot, dest); }
  task.build = buildId;
  saveTask(paths, task);

  console.log(`已记录验收：${taskId} @ ${buildId} → ${status}${evidence ? `（证据 ${evidence}）` : "（无证据路径）"}`);
  if (status === "blocked" || status === "not-run") {
    console.log("  说明：未给出通过结论，任务状态保持待验收。");
  }
  if (status === "fail") {
    console.log(`  下一步：负责人修复后 task ready，再 snapshot create 生成下一个快照（旧 build 记录保留）。`);
  }
  return EXIT.ok;
}

// ---------------------------------------------------------------- 状态

function cmdStatus(argv) {
  const args = parseArgs(argv);
  const ctx = repoContext();
  const paths = statePaths(ctx);
  ensureDirs(paths);

  const tasks = readJsonDir(paths.tasks).sort((a, b) => a.id.localeCompare(b.id));
  const snapshots = readJsonDir(paths.snapshots).sort((a, b) => snapshotSeq(a.id) - snapshotSeq(b.id));
  const builds = readdirSync(paths.builds, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readJson(join(paths.builds, e.name, "build.json")))
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const acceptance = [];
  for (const b of builds) {
    const dir = join(paths.builds, b.id, "acceptance");
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      const r = readJson(join(dir, e.name));
      if (r) acceptance.push(r);
    }
  }

  if (flag(args, "json")) {
    console.log(JSON.stringify({ repo: ctx.mainRoot, integrationWorktree: integrationWorktree(ctx), tasks, snapshots, builds, acceptance }, null, 2));
    return EXIT.ok;
  }

  console.log(`仓库：${ctx.mainRoot}`);
  console.log(`集成工作区：${integrationWorktree(ctx)}${existsSync(integrationWorktree(ctx)) ? "" : "（尚未创建，snapshot create 时创建）"}`);

  console.log("\n任务：");
  if (tasks.length === 0) console.log("  （暂无）");
  else {
    printTable(tasks, [
      { key: "id", title: "任务" },
      { key: "module", title: "模块" },
      { key: "owner", title: "负责人" },
      { key: "status", title: "状态" },
      { key: "snapshot", title: "快照" },
      { key: "build", title: "构建" },
      { key: "acceptance", title: "验收" },
    ], (t) => ({
      ...t,
      status: STATUS_LABEL[t.status] ?? t.status,
      snapshot: t.snapshot ?? "-",
      build: t.build ?? "-",
      acceptance: t.acceptance ? "有记录" : "-",
    }));
  }

  console.log("\n集成快照：");
  if (snapshots.length === 0) console.log("  （暂无）");
  else {
    printTable(snapshots, [
      { key: "id", title: "快照" },
      { key: "commitShort", title: "提交" },
      { key: "taskIds", title: "任务" },
      { key: "checkText", title: "集成检查" },
      { key: "createdAt", title: "时间" },
    ], (s) => ({
      ...s,
      commitShort: s.commit.slice(0, 7),
      taskIds: (s.tasks ?? []).map((t) => t.id).join(", ") || "(基线)",
      checkText: s.checks?.length ? `exit=${s.checks[0].exitCode}` : "skip",
    }));
  }

  console.log("\n构建：");
  if (builds.length === 0) console.log("  （暂无）");
  else {
    printTable(builds, [
      { key: "id", title: "构建" },
      { key: "shortCommit", title: "提交" },
      { key: "platform", title: "平台" },
      { key: "statusText", title: "结果" },
      { key: "taskIds", title: "任务" },
      { key: "artifactText", title: "产物" },
      { key: "durationText", title: "耗时" },
    ], (b) => ({
      ...b,
      statusText: b.status === "succeeded" ? "成功" : `失败(${b.exitCode})`,
      taskIds: (b.tasks ?? []).map((t) => t.id).join(", ") || "-",
      artifactText: (b.artifacts ?? []).map((a) => a.name).join(", ") || "-",
      durationText: `${Math.round((b.durationMs ?? 0) / 1000)}s`,
    }));
  }

  console.log("\n验收记录：");
  if (acceptance.length === 0) console.log("  （暂无）");
  else {
    printTable(acceptance, [
      { key: "build", title: "构建" },
      { key: "task", title: "任务" },
      { key: "status", title: "结论" },
      { key: "agent", title: "验收者" },
      { key: "evidenceText", title: "证据" },
    ], (a) => ({ ...a, evidenceText: (a.evidencePaths ?? []).join(", ") || "-" }));
  }

  const pending = tasks.filter((t) => t.status === "accept-failed");
  if (pending.length) {
    console.log(`\n需要返工：${pending.map((t) => t.id).join(", ")}`);
  }
  return EXIT.ok;
}

// ---------------------------------------------------------------- 表格与帮助

function pad(text, width) {
  const s = String(text ?? "");
  const visible = [...s].length;
  return visible >= width ? s : s + " ".repeat(width - visible);
}

function truncate(text, width) {
  const s = String(text ?? "");
  return [...s].length > width ? [...s].slice(0, width - 1).join("") + "…" : s;
}

function printTable(rows, columns, map = (r) => r) {
  const data = rows.map(map);
  const widths = columns.map((c) => Math.max([...c.title].length, ...data.map((r) => [...String(r[c.key] ?? "")].length)) + 2);
  console.log("  " + columns.map((c, i) => pad(c.title, widths[i])).join(""));
  console.log("  " + widths.map((w) => "-".repeat(w)).join(""));
  for (const r of data) {
    console.log("  " + columns.map((c, i) => pad(truncate(r[c.key] ?? "", widths[i] - 2), widths[i])).join(""));
  }
}

function rel(root, p) {
  return relative(root, p).split(sep).join("/");
}

function printHelp() {
  console.log(`Task Dock 统一集成 / 构建 / 验收台账

  task add|update|check|ready|list|show   任务登记与交付（状态机见 docs/INTEGRATION_BUILD.md）
  snapshot bootstrap                     只登记一个已确认的稳定基线（不叠加任务）
  snapshot create                        把「待集成」任务的声明路径改动应用到 integration 分支并生成快照提交
  build                                  在干净快照工作区构建；同一输入复用已有产物
  accept                                 针对某个 buildId 写验收结论（多 Agent 各写一份）
  status                                 查看任务 / 快照 / 构建 / 验收记录

关键约束：
  - 首次集成必须 --base <稳定提交>；未完成任务的未提交改动不会进入快照。
  - 只有 integration 分支上的快照提交能生成正式测试安装包；桌面与移动端分别构建。
  - 构建记录含 commit / 平台 / 配置 / 任务 / 产物 sha256，位于 tmp/integration/builds/<构建>/build.json。
  - 本工具不推送、不打标签、不操作主工作区；失败时保留现场与日志。`);
}

// ---------------------------------------------------------------- 入口

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "task": return cmdTask(rest[0], rest.slice(1));
    case "snapshot":
      if (rest[0] === "create") return cmdSnapshotCreate(rest.slice(1));
      if (rest[0] === "bootstrap") return cmdSnapshotBootstrap(rest.slice(1));
      throw new Fail(`未知 snapshot 子命令：${rest[0] ?? "(空)"}（可用 bootstrap | create）`, EXIT.usage);
    case "build": return cmdBuild(rest);
    case "accept": return cmdAccept(rest);
    case "status": return cmdStatus(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return EXIT.ok;
    default:
      throw new Fail(`未知命令：${cmd}（可用 task | snapshot | build | accept | status | help）`, EXIT.usage);
  }
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return samePath(resolve(arg), SELF_PATH);
  } catch { return false; }
}

if (isDirectRun()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof Fail) {
      console.error(err.message);
      process.exit(err.code);
    }
    console.error(err?.stack ?? String(err));
    process.exit(EXIT.state);
  }
}

export { pathCovered, normalizeRepoPath, expandPattern, dirDigest };
