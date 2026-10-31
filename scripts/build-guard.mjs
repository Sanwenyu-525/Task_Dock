//! 构建产物与磁盘空间守卫（零依赖，Node >= 18）：
//!   node scripts/build-guard.mjs precheck [--min-free-gb N] [--warn-free-gb N]
//!   node scripts/build-guard.mjs report                       # precheck + 缓存目录大小统计
//!   node scripts/build-guard.mjs register --dir <path> --task <name> [--purpose <text>]
//!   node scripts/build-guard.mjs cleanup --dir <path> [--dry-run] [--execute]
//!
//! 用途：
//!   1) 构建前检查目标磁盘剩余空间与缓存目录状况，空间不足时给出清理建议并阻塞
//!      完整构建（package.json 的 pretauri 钩子与 scripts/perf/gate-*.sh 已接入）；
//!   2) 为任务专属隔离构建目录（CARGO_TARGET_DIR）登记归属标记；
//!   3) 任务结束后按归属标记安全回收目录：显式路径 + 仓库内 + 命名白名单 +
//!      归属标记 + 进程占用检查 + 符号链接/联接点边界防护，任何一环无法确认即跳过。
//!
//! 安全边界（cleanup 只删同时满足以下全部条件的目录）：
//!   - 通过 --dir 显式传入，绝不做全盘扫描或通配删除；
//!   - realpath 解析后仍位于本仓库根之内，且目标自身不是符号链接/联接点；
//!   - 目录名匹配 target-<name>，或位于 tmp/ 任务临时区之下；
//!   - 目录内存在本工具签发的 .build-guard-owner.json 归属标记；
//!   - 标记中记录的创建进程 PID 已退出（仍在运行视为其他 Agent 使用中，跳过）。
//! 历史遗留的无标记目录只做占用报告，不做自动删除（见 report / precheck 输出）。

import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync, appendFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep, basename, isAbsolute } from "node:path";

const REPO_ROOT = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const MARKER_NAME = ".build-guard-owner.json";
const LOG_DIR = join(REPO_ROOT, "tmp", "build-guard");
const LOG_FILE = join(LOG_DIR, "cleanup-log.jsonl");

// 已知缓存目录（相对仓库根）。目录名以 target- 开头的都会进 .gitignore。
const KNOWN_CACHES = [
  "src-tauri/target",
  "src-tauri/target-accept",
  "src-tauri/target-accept-dbg",
  "src-tauri/target-measure",
  "src-tauri/target-gate",
  "target-test",
];
// 异常嵌套缓存的特征目录：CARGO_TARGET_DIR 用了相对路径且 cwd 错误时产生。
const NESTED_ANOMALY = "src-tauri/src-tauri";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const isValue = next !== undefined && !next.startsWith("--");
      if (!isValue) { args[key] = true; continue; }
      // 可重复的取值参数累积为数组，其余保持单值
      if (key in args && args[key] !== true) {
        args[key] = [].concat(args[key], next);
      } else args[key] = next;
      i++;
    } else args._.push(a);
  }
  return args;
}

// --dir 的取值必须是非空字符串；布尔值说明 --dir 后面误跟了另一个 flag。
function dirList(value) {
  const list = value === undefined ? [] : [].concat(value);
  return list.filter((v) => typeof v === "string" && v.trim() !== "");
}

function formatGB(bytes) {
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}

// 读取仓库所在盘的剩余空间；工具不可用时返回 null（不臆断）。
function getFreeBytes(repoRoot) {
  const drive = repoRoot.charAt(0).toUpperCase();
  try {
    const r = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `(Get-PSDrive -Name ${drive}).Free`,
    ], { encoding: "utf8", timeout: 20000 });
    const n = Number.parseInt((r.stdout || "").trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch { /* 忽略，走 null 分支 */ }
  return null;
}

function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isSymbolicLink()) continue; // 不追链接，避免越界计数
      if (e.isDirectory()) {
        const sub = dirSizeBytes(p);
        if (sub === null) return null;
        total += sub;
      } else total += statSync(p).size;
    } catch { /* 单个文件失败不阻塞统计 */ }
  }
  return total;
}

function cacheSummary(withSizes) {
  const rows = [];
  for (const rel of [...KNOWN_CACHES, NESTED_ANOMALY]) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    const row = {
      path: rel,
      anomaly: rel === NESTED_ANOMALY,
      kind: st.isSymbolicLink() ? "symlink/junction" : st.isDirectory() ? "dir" : "file",
      mtime: st.mtime?.toISOString() ?? null,
      bytes: withSizes ? dirSizeBytes(abs) : null,
    };
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- precheck

function runPrecheck(args, withSizes) {
  const warnGB = Number.parseFloat(args["warn-free-gb"] ?? "25");
  const minGB = Number.parseFloat(args["min-free-gb"] ?? "12");
  const free = getFreeBytes(REPO_ROOT);
  const caches = cacheSummary(withSizes);
  const problems = [];
  const warnings = [];

  if (free === null) {
    warnings.push("无法读取磁盘剩余空间（PowerShell 不可用），请手动确认后再执行大体积构建");
  } else {
    const freeGB = free / 1024 ** 3;
    console.log(`磁盘剩余空间（${REPO_ROOT.charAt(0)}:）：${formatGB(free)}`);
    if (freeGB < minGB) {
      problems.push(
        `剩余空间 ${formatGB(free)} 低于硬阈值 ${minGB} GB：禁止执行完整 Release/打包构建。` +
        `建议：node scripts/build-guard.mjs report 查看缓存占用，人工确认后清理已完成的任务专属缓存`,
      );
    } else if (freeGB < warnGB) {
      warnings.push(`剩余空间 ${formatGB(free)} 低于预警阈值 ${warnGB} GB，构建前建议先 run report 评估缓存`);
    }
  }

  console.log("构建缓存目录：");
  for (const c of caches) {
    const size = c.bytes === null ? "" : `  ${formatGB(c.bytes)}`;
    const tag = c.anomaly ? "  [异常嵌套，根因见 docs/DEVELOPMENT.md §构建产物]" : "";
    console.log(`  ${c.path}${size}${tag}`);
    if (c.anomaly) {
      warnings.push(
        `检测到异常嵌套构建目录 ${c.path}（CARGO_TARGET_DIR 相对路径 + 错误 cwd 的产物），` +
        `请人工确认后删除；本工具不做无标记目录的自动删除`,
      );
    }
    if (c.kind === "symlink/junction") {
      warnings.push(`缓存目录 ${c.path} 是符号链接/联接点，请人工核查指向`);
    }
  }

  const ctd = process.env.CARGO_TARGET_DIR;
  if (ctd) {
    if (!isAbsolute(ctd)) {
      problems.push(
        `环境变量 CARGO_TARGET_DIR 是相对路径（${ctd}）：会随 cwd 变化产生嵌套/重复缓存目录，` +
        `必须改为绝对路径（历史事故：src-tauri/src-tauri/target-accept）`,
      );
    }
  }

  for (const w of warnings) console.log(`警告：${w}`);
  if (problems.length) {
    for (const p of problems) console.error(`阻塞：${p}`);
    return 2;
  }
  console.log("precheck 通过");
  return 0;
}

// ---------------------------------------------------------------- register

function runRegister(args) {
  const dir = args["dir"];
  const task = args["task"];
  if (!dir || !task) {
    console.error("用法：node scripts/build-guard.mjs register --dir <绝对路径> --task <任务名> [--purpose <用途>]");
    return 1;
  }
  const abs = resolve(dir);
  if (!abs.startsWith(REPO_ROOT + sep)) {
    console.error(`拒绝：${abs} 不在本仓库内，隔离构建目录必须放在仓库内受控位置`);
    return 1;
  }
  if (!basename(abs).startsWith("target-") && !abs.startsWith(join(REPO_ROOT, "tmp") + sep)) {
    console.error(`拒绝：目录名须以 target- 开头，或位于 tmp/ 任务临时区之下（当前：${basename(abs)}）`);
    return 1;
  }
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st) {
    console.error(`拒绝：目录不存在（本工具不代建缓存目录，请先以绝对路径 CARGO_TARGET_DIR 创建）：${abs}`);
    return 1;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    console.error(`拒绝：${abs} 不是普通目录`);
    return 1;
  }
  const marker = {
    task,
    purpose: args.purpose ?? "",
    pid: process.pid,
    createdAt: new Date().toISOString(),
    tool: "scripts/build-guard.mjs",
  };
  writeFileSync(join(abs, MARKER_NAME), JSON.stringify(marker, null, 2) + "\n");
  console.log(`已登记归属：${abs}`);
  console.log(`  task=${task} pid=${process.pid} createdAt=${marker.createdAt}`);
  console.log("任务结束后请执行：node scripts/build-guard.mjs cleanup --dir <该目录> --execute");
  return 0;
}

// ---------------------------------------------------------------- cleanup

function pidAlive(pid) {
  try {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8", timeout: 15000,
    });
    if (r.status !== 0 && !r.stdout) return null; // 工具失败 → 无法确认
    const out = (r.stdout || "").trim();
    if (/no tasks|没有运行的任务|INFO:/i.test(out)) return false;
    return new RegExp(`"${pid}"`).test(out);
  } catch { return null; }
}

function appendLog(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* 日志失败不掩盖主流程结果，已在 stdout 报告 */ }
}

// 返回 {ok:boolean, action:string, reason?:string, bytes?:number}
function vetCleanupTarget(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, action: "reject", reason: "--dir 需要一个路径值" };
  }
  const fail = (reason) => ({ ok: false, action: "reject", reason });
  const abs = resolve(rawPath);
  if (!isAbsolute(rawPath)) return fail("路径必须是绝对路径（相对路径会随 cwd 漂移，本工具拒绝解析）");
  // 边界粗筛先行：仓库外路径无论是否存在一律拒绝，不给"目录不存在"的歧义输出
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + sep)) {
    return fail("目标不在本仓库内，拒绝处理（本工具只清理仓库内的任务构建缓存）");
  }

  let st;
  try { st = lstatSync(abs, { throwIfNoEntry: false }); } catch { return fail("lstat 失败"); }
  if (!st) return { ok: false, action: "absent", reason: "目录不存在（视为已完成清理）" };
  if (st.isSymbolicLink()) return fail("目标是符号链接/联接点，拒绝删除以防止越界");
  if (!st.isDirectory()) return fail("目标不是目录");

  let real;
  try { real = realpathSync(abs); } catch { return fail("realpath 解析失败"); }
  if (!real.startsWith(REPO_ROOT + sep)) return fail(`realpath 解析为 ${real}，越出仓库根边界`);
  if (real !== abs && realpathSync(dirname(abs)) !== dirname(real)) {
    return fail("路径中段包含链接重定向，拒绝处理");
  }

  const name = basename(real);
  const underTmp = real.startsWith(join(REPO_ROOT, "tmp") + sep);
  if (!name.startsWith("target-") && !underTmp) {
    return fail(`目录名 ${name} 不在白名单（target-* 或 tmp/ 子目录）`);
  }
  if (real === REPO_ROOT) return fail("拒绝删除仓库根");

  let marker;
  try {
    marker = JSON.parse(readFileSync(join(real, MARKER_NAME), "utf8"));
  } catch {
    return fail(`缺少归属标记 ${MARKER_NAME}（历史遗留目录请人工确认后手动删除）`);
  }
  if (!marker || typeof marker.pid !== "number" || typeof marker.task !== "string") {
    return fail("归属标记字段不完整，无法确认归属");
  }
  const alive = pidAlive(marker.pid);
  if (alive === null) return fail("无法确认标记 PID 的存活状态（tasklist 失败），按占用中处理");
  if (alive) return fail(`标记 PID ${marker.pid}（task=${marker.task}）仍在运行，视为使用中，跳过`);

  return { ok: true, action: "candidate", abs, real, marker };
}

function runCleanup(args) {
  const dirs = dirList(args["dir"]);
  if (!dirs.length) {
    console.error("用法：node scripts/build-guard.mjs cleanup --dir <绝对路径> [--dir ...] [--dry-run] [--execute]");
    console.error("安全说明：默认 dry-run；只有追加 --execute 才真正删除。");
    return 1;
  }
  const execute = args["execute"] === true || args["execute"] === "true";
  let exit = 0;
  let freed = 0;

  for (const d of dirs) {
    const vet = vetCleanupTarget(d);
    const label = vet.abs ?? resolve(d);
    if (!vet.ok) {
      if (vet.action === "absent") {
        console.log(`[跳过-已完成] ${label}：${vet.reason}`);
        appendLog({ mode: execute ? "execute" : "dry-run", path: label, action: "absent" });
        continue;
      }
      console.error(`[拒绝] ${label}：${vet.reason}`);
      appendLog({ mode: execute ? "execute" : "dry-run", path: label, action: "reject", reason: vet.reason });
      exit = exit || 3;
      continue;
    }
    const size = dirSizeBytes(vet.real);
    const sizeText = size === null ? "未知" : formatGB(size);
    if (!execute) {
      console.log(`[dry-run 可清理] ${vet.real}  ${sizeText}  归属 task=${vet.marker.task} pid=${vet.marker.pid}(已退出)`);
      appendLog({ mode: "dry-run", path: vet.real, action: "candidate", bytes: size });
      continue;
    }
    // --execute：删除前复核目标仍是普通目录且未被替换为链接
    const re = lstatSync(vet.real, { throwIfNoEntry: false });
    if (!re || re.isSymbolicLink() || !re.isDirectory()) {
      console.error(`[拒绝] ${vet.real}：删除前复核发现目标状态变化，放弃`);
      appendLog({ mode: "execute", path: vet.real, action: "reject", reason: "delete-time recheck failed" });
      exit = 3;
      continue;
    }
    try {
      rmSync(vet.real, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
      console.log(`[已清理] ${vet.real}  释放 ${sizeText}`);
      appendLog({ mode: "execute", path: vet.real, action: "removed", bytes: size, task: vet.marker.task });
      freed += size ?? 0;
    } catch (err) {
      console.error(`[失败] ${vet.real}：${err?.code ?? err?.message ?? err}（可能被进程占用；不掩盖上方构建结果）`);
      appendLog({ mode: "execute", path: vet.real, action: "failed", reason: String(err?.code ?? err) });
      exit = exit || 4;
    }
  }
  if (execute) console.log(`本次实际释放：${formatGB(freed)}；明细记录：${LOG_FILE}`);
  return exit;
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? "precheck";
switch (cmd) {
  case "precheck": process.exit(runPrecheck(args, false));
  case "report": process.exit(runPrecheck(args, true));
  case "register": process.exit(runRegister(args));
  case "cleanup": process.exit(runCleanup(args));
  default:
    console.error(`未知子命令：${cmd}（可用：precheck | report | register | cleanup）`);
    process.exit(1);
}
