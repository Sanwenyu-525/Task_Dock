//! 多 Agent Git Worktree 隔离守卫（零依赖，Node >= 18）：
//!   node scripts/worktree-guard.mjs status  [--target main] [--json]
//!   node scripts/worktree-guard.mjs create  --task <name> [--base <ref>] [--branch <name>]
//!                                           [--root <绝对目录>] [--link-node-modules] [--json]
//!   node scripts/worktree-guard.mjs check   --task <name> [--target main] [--json]
//!   node scripts/worktree-guard.mjs cleanup --task <name> [--target main]
//!                                           [--delete-branch] [--execute] [--json]
//!
//! 定位：
//!   - Worktree 是按需隔离手段：只在写入范围/共享资源/Git 状态存在无法协调的冲突时使用，
//!     不是多 Agent 并行的前置步骤（判定见 AGENTS.md §3.3）；
//!   - 共享工作区并行的任务不经过本工具，按文件所有权直接在主工作区写入；
//!   - 主工作区（git worktree list 的第一项）承担最终集成、验收与稳定版本管理；
//!   - 本工具不做 commit / merge / rebase / push，也不自动清理不安全的 Worktree。
//!
//! 安全边界：
//!   - create 只新建目录，目标目录/分支已存在即拒绝，绝不覆盖；
//!   - check 只读；冲突预测用 `git merge-tree` 在对象库计算，不改任何工作树；
//!   - cleanup 默认 dry-run；--execute 仍要求干净、已合入目标分支、未锁定，
//!     并拒绝主工作区；无法证明安全时返回非零退出码；
//!   - 只删除显式 --task 对应且由 Git 登记的 Worktree，不 prune 其他条目；
//!   - node_modules 只有在 package.json 与 package-lock.json 完全一致时才建立共享 junction。

import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET = "main";
const TASK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

class GuardError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------- git 基础

function git(args, cwd, timeout = 60000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ?? null,
  };
}

function gitOrDie(args, cwd, what) {
  const r = git(args, cwd);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim();
    throw new GuardError(`${what}失败：git ${args.join(" ")}\n${detail}`);
  }
  return r.stdout.trim();
}

// 以调用方的 cwd 为锚点解析仓库（通常是在仓库根或任意子目录执行）；
// 在 linked worktree 中执行时，--git-common-dir 指回主仓库的 .git，
// 因此主工作区路径始终可确定。
function repoContext() {
  const common = gitOrDie(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    process.cwd(),
    "解析 Git 公共目录（请在 Git 仓库内执行）",
  );
  const commonAbs = isAbsolute(common) ? common : resolve(process.cwd(), common);
  const mainRoot = realpathSync(dirname(commonAbs));
  return { mainRoot, cwd: realpathSync(process.cwd()) };
}

function defaultWorktreeRoot(mainRoot) {
  return join(dirname(mainRoot), `${basename(mainRoot)}-worktrees`);
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
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return true;
}

function normalizeRepoPath(p) {
  const n = p.split(sep).join("/").replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

function splitZ(out) {
  return out.split("\0").filter((v) => v !== "");
}

// ---------------------------------------------------------------- Worktree 清单

function parseWorktreePorcelain(text) {
  const items = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l !== "");
    if (lines.length === 0) continue;
    const item = {
      path: "",
      head: "",
      branch: null,
      detached: false,
      locked: false,
      lockReason: "",
      prunable: false,
      pruneReason: "",
    };
    for (const line of lines) {
      if (line.startsWith("worktree ")) item.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) item.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) item.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") item.detached = true;
      else if (line === "locked" || line.startsWith("locked ")) {
        item.locked = true;
        item.lockReason = line.slice("locked".length).trim();
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        item.prunable = true;
        item.pruneReason = line.slice("prunable".length).trim();
      }
    }
    if (item.path) items.push(item);
  }
  return items;
}

function listWorktrees(mainRoot) {
  return parseWorktreePorcelain(gitOrDie(["worktree", "list", "--porcelain"], mainRoot, "列出 Worktree"));
}

// 读取工作树状态：不依赖目录名，不跟随任何链接做删除判断。
function readStatus(worktreePath) {
  const r = git(["status", "--porcelain=v1", "-z", "--branch"], worktreePath);
  if (r.status !== 0) {
    return {
      ok: false,
      error: (r.stderr || r.stdout || `exit ${r.status}`).trim(),
      files: [],
      modified: 0,
      untracked: 0,
      conflicted: 0,
      conflictFiles: [],
    };
  }
  const entries = [];
  for (const part of splitZ(r.stdout)) {
    if (part.startsWith("## ")) continue;
    entries.push(part);
  }
  const files = [];
  const conflictFiles = [];
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const xy = entry.slice(0, 2);
    const rest = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      // -z 模式下重命名/复制为 `XY old\0new\0`，两个路径都纳入比较。
      const newPath = entries[++i] ?? "";
      if (rest) files.push(rest);
      if (newPath) files.push(newPath);
      modified++;
      continue;
    }
    if (xy === "??") {
      files.push(rest);
      untracked++;
      continue;
    }
    if (xy === "!!") continue;
    files.push(rest);
    if (CONFLICT_CODES.has(xy)) {
      conflicted++;
      conflictFiles.push(rest);
    } else {
      modified++;
    }
  }
  return { ok: true, error: "", files, modified, untracked, conflicted, conflictFiles };
}

function aheadBehind(cwd, target, head) {
  const r = git(["rev-list", "--left-right", "--count", `${target}...${head}`], cwd);
  if (r.status !== 0) return null;
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((v) => Number.parseInt(v, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

function resolveCommit(cwd, ref, what) {
  const r = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], cwd);
  if (r.status !== 0) {
    throw new GuardError(`${what}无法解析为提交：${ref}`);
  }
  return r.stdout.trim();
}

function shortHead(head) {
  return head ? head.slice(0, 12) : "未知";
}

// ---------------------------------------------------------------- status

function inspectWorktree(wt, target, mainRoot) {
  const exists = existsSync(wt.path);
  const row = {
    path: wt.path,
    branch: wt.branch,
    detached: wt.detached,
    head: wt.head,
    locked: wt.locked,
    lockReason: wt.lockReason,
    prunable: wt.prunable,
    pruneReason: wt.pruneReason,
    exists,
    isMain: samePath(wt.path, mainRoot),
    modified: null,
    untracked: null,
    conflicted: null,
    conflictFiles: [],
    ahead: null,
    behind: null,
    statusError: "",
    // 没有进程/会话级证据，活跃状态只能标记为未知；locked 仅代表人工锁定。
    activity: "unknown",
  };
  if (!exists) {
    row.statusError = "工作树目录不存在（可能已被手动删除，需人工确认后 git worktree prune）";
    return row;
  }
  const st = readStatus(wt.path);
  if (!st.ok) {
    row.statusError = st.error;
    return row;
  }
  row.modified = st.modified;
  row.untracked = st.untracked;
  row.conflicted = st.conflicted;
  row.conflictFiles = st.conflictFiles;
  const targetCommit = git(["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`], mainRoot);
  if (targetCommit.status === 0 && wt.head) {
    const ab = aheadBehind(mainRoot, targetCommit.stdout.trim(), wt.head);
    if (ab) {
      row.ahead = ab.ahead;
      row.behind = ab.behind;
    }
  }
  return row;
}

function runStatus(args) {
  const { mainRoot } = repoContext();
  const target = args.target ?? DEFAULT_TARGET;
  const list = listWorktrees(mainRoot);
  const rows = list.map((wt) => inspectWorktree(wt, target, mainRoot));
  const result = { generatedAt: new Date().toISOString(), mainRoot, target, worktrees: rows };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`主工作区：${mainRoot}`);
  console.log(`Worktree 总数：${rows.length}（含主工作区）`);
  if (git(["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`], mainRoot).status !== 0) {
    console.log(`警告：目标分支 ${target} 无法解析，已省略 ahead/behind（可用 --target 指定）`);
  }
  rows.forEach((row, i) => {
    const branch = row.detached ? "detached HEAD" : row.branch ?? "未知";
    console.log("");
    console.log(`${i + 1}) ${row.path}${row.isMain ? "  [主工作区]" : ""}`);
    console.log(`   分支 ${branch}   HEAD ${shortHead(row.head)}`);
    if (!row.exists) {
      console.log(`   状态 目录缺失${row.statusError ? `：${row.statusError}` : ""}`);
    } else if (row.modified === null) {
      console.log(`   状态 无法读取：${row.statusError}`);
    } else {
      console.log(`   状态 修改 ${row.modified} / 未跟踪 ${row.untracked} / 冲突 ${row.conflicted}`);
    }
    console.log(`   Git 锁定 ${row.locked ? `是${row.lockReason ? `（${row.lockReason}）` : ""}` : "否"}`);
    if (row.prunable) {
      console.log(`   可 prune 是${row.pruneReason ? `（${row.pruneReason}）` : ""}（本工具不自动执行）`);
    }
    if (row.ahead !== null) {
      console.log(`   相对 ${target} ahead ${row.ahead} / behind ${row.behind}`);
    }
    console.log("   活跃 未知（无进程/会话证据；locked 不代表正在工作）");
  });
  return 0;
}

// ---------------------------------------------------------------- create

function validateTaskName(task) {
  if (!task || typeof task !== "string") {
    throw new GuardError("缺少 --task（任务名，使用短横线小写英文，例如 capsule-drag）");
  }
  if (task.length > 48 || !TASK_RE.test(task)) {
    throw new GuardError(
      `任务名不合法：${task}。只允许小写字母/数字与单个短横线连接，长度 1-48，例如 resource-management`,
    );
  }
  return task;
}

function validateBranchName(mainRoot, branch) {
  const r = git(["check-ref-format", "--branch", branch], mainRoot);
  if (r.status !== 0) throw new GuardError(`分支名不合法：${branch}`);
  return branch;
}

function branchPresence(mainRoot, branch) {
  const local = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], mainRoot);
  if (local.status === 0) return "local";
  const remote = git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], mainRoot);
  if (remote.status === 0) return "remote";
  return null;
}

function ensureWorktreeRoot(rootAbs, mainRoot) {
  if (samePath(rootAbs, mainRoot) || isInside(mainRoot, rootAbs)) {
    throw new GuardError(
      `Worktree 根目录不能位于仓库内：${rootAbs}\n` +
      `默认使用仓库同级的 <仓库名>-worktrees，避免污染工作树与构建缓存统计`,
    );
  }
  const st = lstatSync(rootAbs, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink()) throw new GuardError(`Worktree 根目录是符号链接/联接点，拒绝使用：${rootAbs}`);
    if (!st.isDirectory()) throw new GuardError(`Worktree 根路径已存在且不是目录：${rootAbs}`);
    if (isInside(mainRoot, realpathSync(rootAbs))) {
      throw new GuardError(`Worktree 根目录解析后位于仓库内，拒绝使用：${realpathSync(rootAbs)}`);
    }
    return;
  }
  mkdirSync(rootAbs, { recursive: true });
  // 目录刚创建后再解析一次真实路径，防止父级链接把根目录指回仓库内部。
  if (isInside(mainRoot, realpathSync(rootAbs))) {
    throw new GuardError(`Worktree 根目录解析后位于仓库内，拒绝使用：${realpathSync(rootAbs)}`);
  }
}

function readFileOrNull(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

// 依赖共享只允许在依赖清单完全一致时建立 junction，避免两个任务对同一 node_modules
// 做不同版本的 npm 安装而互相污染。
function tryLinkNodeModules(mainRoot, worktreePath, enabled) {
  if (!enabled) return { linked: false, reason: "未指定 --link-node-modules" };
  const src = join(mainRoot, "node_modules");
  const dst = join(worktreePath, "node_modules");
  const srcStat = lstatSync(src, { throwIfNoEntry: false });
  if (!srcStat || !srcStat.isDirectory()) {
    return { linked: false, reason: "主仓库 node_modules 不存在，跳过共享依赖" };
  }
  if (lstatSync(dst, { throwIfNoEntry: false })) {
    return { linked: false, reason: "目标 Worktree 已有 node_modules，跳过" };
  }
  for (const name of ["package.json", "package-lock.json"]) {
    const a = readFileOrNull(join(mainRoot, name));
    const b = readFileOrNull(join(worktreePath, name));
    if (!a || !b || !a.equals(b)) {
      return { linked: false, reason: `${name} 与主仓库不一致，拒绝共享依赖（请在本 Worktree 内独立 npm ci）` };
    }
  }
  try {
    symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    return { linked: false, reason: `创建 node_modules 链接失败：${err?.code ?? err?.message ?? err}` };
  }
  const st = lstatSync(dst, { throwIfNoEntry: false });
  if (!st || !st.isSymbolicLink()) {
    return { linked: false, reason: "链接创建后复核失败，请人工确认" };
  }
  return { linked: true, reason: `已共享主仓库 node_modules（${src}）` };
}

function runCreate(args) {
  const { mainRoot } = repoContext();
  const task = validateTaskName(args.task);
  const branch = validateBranchName(mainRoot, args.branch ?? `agent/${task}`);
  if (typeof args.root === "string" && !isAbsolute(args.root)) {
    throw new GuardError(`--root 必须是绝对路径（相对路径会随 cwd 漂移）：${args.root}`);
  }
  const rootAbs = resolve(args.root ?? defaultWorktreeRoot(mainRoot));
  ensureWorktreeRoot(rootAbs, mainRoot);

  const worktreePath = join(rootAbs, task);
  if (existsSync(worktreePath)) {
    throw new GuardError(`目标目录已存在，拒绝覆盖：${worktreePath}\n请先确认该目录归属，或换一个 --task`);
  }
  const existingBranch = branchPresence(mainRoot, branch);
  if (existingBranch === "local") {
    throw new GuardError(`本地分支已存在，拒绝重复创建：${branch}\n可改用 --branch 指定新分支，或复用已有 Worktree`);
  }
  if (existingBranch === "remote") {
    throw new GuardError(`远程分支已存在：origin/${branch}\n请确认是否已有任务在推进；本工具不覆盖远程分支`);
  }

  const baseRef = args.base ?? "HEAD";
  const baseCommit = resolveCommit(mainRoot, baseRef, "基准");
  const added = git(["worktree", "add", "-b", branch, worktreePath, baseCommit], mainRoot);
  if (added.status !== 0) {
    throw new GuardError(
      `git worktree add 失败（未删除任何已有内容）：\n${(added.stderr || added.stdout).trim()}`,
    );
  }

  const top = git(["rev-parse", "--show-toplevel"], worktreePath);
  if (top.status !== 0 || !samePath(top.stdout.trim(), worktreePath)) {
    throw new GuardError(
      `Worktree 创建后校验失败：${worktreePath} 不是预期的仓库根（${top.stdout.trim() || top.stderr.trim()}）\n` +
      `请人工检查；本工具不会自动删除该目录`,
    );
  }

  const link = tryLinkNodeModules(mainRoot, worktreePath, args["link-node-modules"] === true);
  const head = gitOrDie(["rev-parse", "HEAD"], worktreePath, "读取 Worktree HEAD");
  const result = {
    task,
    path: worktreePath,
    branch,
    base: baseRef,
    baseCommit,
    head,
    mainRoot,
    nodeModules: link,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`已创建任务 Worktree`);
  console.log(`  任务：${task}`);
  console.log(`  路径：${worktreePath}`);
  console.log(`  分支：${branch}（从 ${baseRef} @ ${shortHead(baseCommit)} 创建）`);
  console.log(`  HEAD：${shortHead(head)}`);
  console.log(`  依赖：${link.linked ? link.reason : `未共享（${link.reason}）`}`);
  console.log("");
  console.log("下一步：");
  console.log(`  1) cd "${worktreePath}"`);
  console.log(`  2) git rev-parse --show-toplevel && git branch --show-current && git status --short`);
  if (!link.linked) console.log("  3) 如需前端构建/测试：在本 Worktree 内 npm ci（不要复用主仓库依赖）");
  console.log(
    `  ${link.linked ? "3" : "4"}) 如需 Rust 构建：在主仓库 src-tauri/ 下使用绝对路径 ` +
    `CARGO_TARGET_DIR=${join(mainRoot, "src-tauri", `target-${task}`)}，并用 build-guard register 登记`,
  );
  console.log(`  ${link.linked ? "4" : "5"}) 完成后先提交，再执行：node scripts/worktree-guard.mjs check --task ${task}`);
  return 0;
}

// ---------------------------------------------------------------- check

function resolveTaskWorktree(mainRoot, task) {
  const list = listWorktrees(mainRoot);
  const matches = list.filter((wt) => {
    const name = basename(wt.path);
    const sameName = process.platform === "win32"
      ? name.toLowerCase() === task.toLowerCase()
      : name === task;
    return sameName || wt.branch === `agent/${task}`;
  });
  const mainMatch = matches.filter((wt) => samePath(wt.path, mainRoot));
  if (matches.length === 0) {
    throw new GuardError(
      `未找到任务 ${task} 对应的 Worktree。\n先执行：node scripts/worktree-guard.mjs status`,
    );
  }
  if (matches.length > 1) {
    throw new GuardError(
      `任务名匹配到多个 Worktree，拒绝猜测：\n${matches.map((m) => `  ${m.path}`).join("\n")}\n` +
      `请先人工确认归属，必要时用 --task 使用唯一目录名`,
    );
  }
  return { wt: matches[0], isMain: mainMatch.length > 0, all: list };
}

function runCheck(args) {
  const { mainRoot } = repoContext();
  const task = validateTaskName(args.task);
  const { wt } = resolveTaskWorktree(mainRoot, task);
  if (!existsSync(wt.path)) {
    throw new GuardError(`Worktree 目录不存在：${wt.path}\n请人工确认后执行 git worktree prune（本工具不自动执行）`);
  }
  const target = args.target ?? DEFAULT_TARGET;
  const targetCommit = resolveCommit(mainRoot, target, "目标分支");
  const head = gitOrDie(["rev-parse", "HEAD"], wt.path, "读取 Worktree HEAD");
  const st = readStatus(wt.path);
  if (!st.ok) throw new GuardError(`读取 Worktree 状态失败：${st.error}`);

  const uncommittedFiles = [...new Set(st.files)];
  const committedFiles = [...new Set(splitZ(
    git(["diff", "--name-only", "-z", `${targetCommit}...${head}`], wt.path).stdout,
  ))];

  const alreadyMerged = git(["merge-base", "--is-ancestor", head, targetCommit], mainRoot).status === 0;
  let conflictFiles = [];
  if (!alreadyMerged) {
    const mt = git(
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", targetCommit, head],
      mainRoot,
    );
    if (mt.status === 1) {
      // 第一行是合并后的 tree oid，其余行是冲突文件。
      conflictFiles = mt.stdout.split(/\r?\n/).slice(1).map((s) => s.trim()).filter(Boolean);
    } else if (mt.status !== 0) {
      throw new GuardError(`git merge-tree 执行失败：${(mt.stderr || mt.stdout).trim()}`);
    }
  }

  // 目标分支通常检出在主工作区；若它被检出在别的 Worktree，以那个工作区为准。
  const targetWt = resolveTaskWorktreeTarget(mainRoot, target);
  const targetStatus = targetWt ? readStatus(targetWt) : null;
  const targetDirtyFiles = targetStatus?.ok ? [...new Set(targetStatus.files)] : [];
  const dirtySet = new Set(targetDirtyFiles.map(normalizeRepoPath));
  const overlapCandidates = [...new Set([...committedFiles, ...uncommittedFiles])];
  const overlappingDirtyFiles = overlapCandidates.filter((f) => dirtySet.has(normalizeRepoPath(f)));

  const ab = aheadBehind(mainRoot, targetCommit, head);
  const sourceDirty = st.modified > 0 || st.untracked > 0;
  const targetDirty = targetDirtyFiles.length > 0;
  const risks = [];
  if (st.conflicted > 0) risks.push(`源 Worktree 有未解决冲突：${st.conflictFiles.join(", ")}`);
  if (sourceDirty) {
    risks.push(
      `源 Worktree 有未提交内容（修改 ${st.modified} / 未跟踪 ${st.untracked}）：` +
      "未提交内容不会随 merge 集成，先提交或在 Worktree 内收敛",
    );
  }
  if (conflictFiles.length > 0) risks.push(`与 ${target} 存在合并冲突：${conflictFiles.join(", ")}`);
  if (overlappingDirtyFiles.length > 0) {
    risks.push(
      `待集成文件与目标工作区未提交改动重叠：${overlappingDirtyFiles.join(", ")}；` +
      "直接合并会覆盖/混入未提交内容，必须先在目标工作区收敛",
    );
  }
  if (targetDirty) {
    risks.push(`目标工作区有未提交改动（${targetDirtyFiles.length} 个文件），集成前应先提交或由所有者收敛`);
  }
  if (!alreadyMerged && !ab) risks.push("无法计算 ahead/behind（目标提交不可达）");

  const result = {
    task,
    path: wt.path,
    branch: wt.branch,
    detached: wt.detached,
    head,
    target,
    targetCommit,
    targetWorktree: targetWt,
    alreadyMerged,
    ahead: ab?.ahead ?? null,
    behind: ab?.behind ?? null,
    sourceDirty,
    sourceModified: st.modified,
    sourceUntracked: st.untracked,
    sourceConflicted: st.conflicted,
    committedFiles,
    uncommittedFiles,
    conflictFiles,
    targetDirty,
    targetDirtyFiles,
    overlappingDirtyFiles,
    risks,
    ready: risks.length === 0 && !alreadyMerged && (ab?.ahead ?? 0) > 0,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const branch = wt.detached ? "detached HEAD" : wt.branch;
    console.log(`任务：${task}`);
    console.log(`Worktree：${wt.path}`);
    console.log(`分支：${branch}   HEAD ${shortHead(head)}`);
    console.log(`目标：${target} @ ${shortHead(targetCommit)}`);
    console.log(`进度：ahead ${ab?.ahead ?? "未知"} / behind ${ab?.behind ?? "未知"}；已合入 ${alreadyMerged ? "是" : "否"}`);
    console.log(`源状态：修改 ${st.modified} / 未跟踪 ${st.untracked} / 冲突 ${st.conflicted}`);
    console.log(`待集成提交文件（${committedFiles.length}）：${committedFiles.join(", ") || "无"}`);
    if (uncommittedFiles.length > 0) {
      console.log(`未提交文件（${uncommittedFiles.length}，不会自动集成）：${uncommittedFiles.join(", ")}`);
    }
    console.log(`冲突预测：${conflictFiles.length > 0 ? conflictFiles.join(", ") : "无"}`);
    console.log(`与目标未提交改动重叠：${overlappingDirtyFiles.join(", ") || "无"}`);
    if (risks.length > 0) {
      console.log("阻塞/风险：");
      for (const risk of risks) console.log(`  - ${risk}`);
      console.log("结论：暂不可集成");
    } else if (alreadyMerged) {
      console.log("说明：当前 HEAD 已包含在目标分支中，没有待集成提交");
      console.log("结论：无可集成内容；如需继续开发请先提交新改动");
    } else if ((ab?.ahead ?? 0) === 0) {
      console.log("结论：没有领先目标分支的提交，无需集成");
    } else {
      console.log("结论：未发现冲突或覆盖风险；仍需在 Worktree 内提交并复测后再合并");
    }
    console.log("");
    console.log("人工集成顺序（本工具不会自动执行）：");
    console.log(`  1) cd "${wt.path}" && npm run build && npm test（按改动范围选择命令）`);
    console.log("  2) 提交并复核 git log / git diff --stat");
    console.log(`  3) 在主工作区由集成负责人执行 git merge --no-ff ${wt.branch ?? "<commit>"}`);
    console.log("  4) 合并后重跑受影响测试，确认无回归再考虑 cleanup");
  }

  return risks.length > 0 ? 2 : 0;
}

function resolveTaskWorktreeTarget(mainRoot, target) {
  const list = listWorktrees(mainRoot);
  const byBranch = list.find((wt) => wt.branch === target);
  if (byBranch) return byBranch.path;
  return mainRoot;
}

// ---------------------------------------------------------------- cleanup

function removeNodeModulesLink(worktreePath) {
  const link = join(worktreePath, "node_modules");
  const st = lstatSync(link, { throwIfNoEntry: false });
  if (!st || !st.isSymbolicLink()) return { removed: false, reason: "" };
  try {
    if (process.platform === "win32") rmdirSync(link);
    else unlinkSync(link);
  } catch (err) {
    throw new GuardError(
      `移除 node_modules 链接失败（${err?.code ?? err?.message ?? err}）；` +
      "为避免误删主仓库依赖，已停止清理，请人工处理该链接",
      4,
    );
  }
  return { removed: true, reason: "已先移除 node_modules 链接（不触碰主仓库依赖）" };
}

function runCleanup(args) {
  const { mainRoot } = repoContext();
  const task = validateTaskName(args.task);
  const { wt, isMain } = resolveTaskWorktree(mainRoot, task);
  if (isMain || samePath(wt.path, mainRoot)) {
    throw new GuardError("拒绝清理主工作区（主工作区只做集成/验收，不参与任务清理）", 3);
  }
  if (isInside(wt.path, process.cwd())) {
    throw new GuardError(
      `当前 cwd 位于待清理 Worktree 内（${process.cwd()}），请先切回主工作区再执行 cleanup`,
      3,
    );
  }
  if (wt.locked) {
    throw new GuardError(
      `Worktree 已被 Git 锁定${wt.lockReason ? `（${wt.lockReason}）` : ""}，拒绝自动清理；` +
      "如确认无其他 Agent 使用，请人工执行 git worktree unlock",
      3,
    );
  }
  if (!existsSync(wt.path)) {
    throw new GuardError(
      `Worktree 目录不存在：${wt.path}\n` +
      "本工具不会自动 prune；请人工确认该条目确已废弃后执行 git worktree prune",
      3,
    );
  }
  const cleanCheck = readStatus(wt.path);
  if (!cleanCheck.ok) throw new GuardError(`读取 Worktree 状态失败：${cleanCheck.error}`, 3);
  if (cleanCheck.modified > 0 || cleanCheck.untracked > 0 || cleanCheck.conflicted > 0) {
    throw new GuardError(
      `Worktree 不干净（修改 ${cleanCheck.modified} / 未跟踪 ${cleanCheck.untracked} / 冲突 ${cleanCheck.conflicted}），` +
      "拒绝清理。请保留现场或由所有者先提交/转移内容",
      3,
    );
  }

  const target = args.target ?? DEFAULT_TARGET;
  const targetCommit = resolveCommit(mainRoot, target, "目标分支");
  const head = gitOrDie(["rev-parse", "HEAD"], wt.path, "读取 Worktree HEAD");
  const merged = git(["merge-base", "--is-ancestor", head, targetCommit], mainRoot).status === 0;
  if (!merged) {
    throw new GuardError(
      `HEAD ${shortHead(head)} 尚未合入 ${target}，拒绝清理（防止丢失未集成提交）`,
      3,
    );
  }

  const execute = args.execute === true;
  const deleteBranch = args["delete-branch"] === true;
  const plan = {
    task,
    path: wt.path,
    branch: wt.branch,
    head,
    target,
    execute,
    deleteBranch,
    actions: [
      `git worktree remove "${wt.path}"`,
      ...(deleteBranch && wt.branch ? [`git branch -d ${wt.branch}`] : []),
    ],
    nodeModulesLink: (() => {
      const st = lstatSync(join(wt.path, "node_modules"), { throwIfNoEntry: false });
      return Boolean(st?.isSymbolicLink());
    })(),
  };

  if (!execute) {
    if (args.json) {
      console.log(JSON.stringify({ ...plan, mode: "dry-run" }, null, 2));
    } else {
      console.log(`[dry-run] 可清理：${wt.path}`);
      console.log(`  分支：${wt.branch ?? "detached HEAD"}   HEAD ${shortHead(head)}  已合入 ${target}`);
      console.log(`  将执行：${plan.actions.join("；")}`);
      if (plan.nodeModulesLink) console.log("  node_modules 是共享链接：会先移除链接，不删除主仓库依赖");
      console.log("  这是预览；追加 --execute 才会执行。");
    }
    return 0;
  }

  // execute 前再次复核状态，防止 dry-run 与执行之间出现新改动。
  const recheck = readStatus(wt.path);
  if (!recheck.ok || recheck.modified > 0 || recheck.untracked > 0 || recheck.conflicted > 0) {
    throw new GuardError("执行前复核发现 Worktree 状态变化（出现未提交/未跟踪/冲突），已停止清理", 3);
  }
  const linkResult = removeNodeModulesLink(wt.path);
  const removed = git(["worktree", "remove", wt.path], mainRoot);
  if (removed.status !== 0) {
    throw new GuardError(
      `git worktree remove 失败：${(removed.stderr || removed.stdout).trim()}\n` +
      "目录与 Git 元数据保持原状，请人工检查占用后重试",
      4,
    );
  }
  let branchDeleted = false;
  let branchError = "";
  if (deleteBranch && wt.branch) {
    const del = git(["branch", "-d", wt.branch], mainRoot);
    if (del.status === 0) branchDeleted = true;
    else branchError = (del.stderr || del.stdout).trim();
  }

  if (args.json) {
    console.log(JSON.stringify({
      ...plan, mode: "execute", removed: true, linkRemoved: linkResult.removed, branchDeleted, branchError,
    }, null, 2));
  } else {
    console.log(`[已清理] ${wt.path}`);
    if (linkResult.removed) console.log(`  ${linkResult.reason}`);
    if (deleteBranch && wt.branch) {
      console.log(branchDeleted ? `  已删除已合入分支：${wt.branch}` : `  分支未删除：${branchError}`);
    }
  }
  if (branchError) return 5;
  return 0;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const isValue = next !== undefined && !next.startsWith("--");
      if (!isValue) {
        args[key] = true;
        continue;
      }
      args[key] = next;
      i++;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`用法：node scripts/worktree-guard.mjs <命令> [选项]

命令：
  status   列出所有 Worktree、分支、HEAD、未提交/未跟踪/冲突、锁定与 ahead/behind
  create   为已判定需要隔离的任务创建 Worktree（默认分支 agent/<task>，默认根 <仓库同级>/<仓库名>-worktrees）
  check    只读检查待集成提交、合并冲突、与目标工作区未提交文件的重叠
  cleanup  清理任务 Worktree；默认 dry-run，--execute 才执行

选项：
  --task <name>             任务名（小写短横线，如 capsule-drag）
  --base <ref>              create 的基准提交，默认 HEAD
  --branch <name>           create 的分支名，默认 agent/<task>
  --root <绝对目录>         Worktree 根目录，默认仓库同级 <仓库名>-worktrees
  --link-node-modules       create 时在依赖清单完全一致的前提下共享主仓库 node_modules
  --target <branch>         check/cleanup 的目标分支，默认 main
  --delete-branch           cleanup --execute 时删除已合入的本地任务分支
  --execute                 cleanup 实际执行（默认只预览）
  --json                    输出机器可读 JSON

退出码：
  0 正常
  1 用法/环境错误
  2 check 发现冲突或覆盖风险
  3 cleanup 拒绝执行（不干净/未合入/锁定/主工作区/目录缺失）
  4 清理执行失败（移除 Worktree 或链接失败）
  5 Worktree 已移除但分支删除失败

示例：
  node scripts/worktree-guard.mjs status
  node scripts/worktree-guard.mjs create --task capsule-drag --link-node-modules
  node scripts/worktree-guard.mjs check --task capsule-drag
  node scripts/worktree-guard.mjs cleanup --task capsule-drag
  node scripts/worktree-guard.mjs cleanup --task capsule-drag --delete-branch --execute

说明：create 只在 AGENTS.md §3.3 判定「必须隔离」或记录「建议隔离」理由后执行；
共享工作区并行的任务不需要创建 Worktree。`);
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(resolve(arg)).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? "status";
  if (cmd === "help" || args.help) {
    usage();
    process.exit(0);
  }
  try {
    let code = 0;
    switch (cmd) {
      case "status": code = runStatus(args); break;
      case "create": code = runCreate(args); break;
      case "check": code = runCheck(args); break;
      case "cleanup": code = runCleanup(args); break;
      default:
        console.error(`未知子命令：${cmd}（可用：status | create | check | cleanup）`);
        usage();
        code = 1;
    }
    process.exit(code);
  } catch (err) {
    if (err instanceof GuardError) {
      console.error(`错误：${err.message}`);
      process.exit(err.exitCode);
    }
    console.error(`错误：${err?.stack ?? err}`);
    process.exit(1);
  }
}

export {
  parseWorktreePorcelain,
  parseArgs,
  normalizeRepoPath,
  isInside,
};
