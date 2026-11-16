//! 调度器全局状态目录：定位、初始化、原子 JSON 读写、任务记录与日志路径。
//!
//! 状态目录必须跨 Worktree 共享，因此默认落在 Git 公共目录之下
//! （`git rev-parse --git-common-dir` 在主工作区与所有 linked worktree 返回同一个路径）：
//!   <git common dir>/taskdock-build-sched/
//! 该目录永不入库（在 .git 内），也不会被 git clean / checkout 影响构建队列。
//! 非 Git 目录（单元测试、临时目录）退化为 <tmp>/taskdock-sched-<hash>，可用环境变量覆盖：
//!   TASKDOCK_BUILD_SCHED_HOME=<绝对路径>

import { spawnSync } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const STATE_DIR_NAME = "taskdock-build-sched";

// 状态目录布局（写在这里便于 status/doctor 输出与排障）：
//   lock/                    准入互斥（当前未使用；槽位租约即互斥原语）
//   slots/<class>-<n>/       资源槽位租约；heavy-1 即「全局构建互斥锁」
//   reservations/<taskId>.json  跨分类活动台账（全局并发名额计数与崩溃回收，见 admission.mjs）
//   queue/<taskId>.json      任务记录（仅由提交它的进程写入）
//   queue/cancel/<taskId>    取消标记（任何进程可创建，持有者轮询后协作取消）
//   logs/<taskId>.log        每个任务的标准输出/错误原文
//   history.jsonl            已完成任务记录（有界）
//   reclaim-log.jsonl        租约回收审计（谁回收、为什么）
export const SUBDIRS = ["slots", "queue", "cancel", "logs", "reservations"];

function gitCommonDirFromFs(cwd) {
  let dir = resolve(cwd);
  while (true) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let st;
      try { st = statSync(dotGit); } catch { return null; }
      if (st.isDirectory()) return dotGit;
      if (st.isFile()) {
        let text;
        try { text = readFileSync(dotGit, "utf8"); } catch { return null; }
        const m = /^gitdir:\s*(.+)$/mi.exec(text);
        if (!m) return null;
        const gitDir = resolve(dir, m[1].trim());
        if (!existsSync(gitDir)) return null;
        // linked worktree：<gitdir>/commondir 指向主仓库的 .git，必须与主工作区共享状态。
        const commonFile = join(gitDir, "commondir");
        if (existsSync(commonFile)) {
          try {
            const rel = readFileSync(commonFile, "utf8").trim();
            const common = resolve(gitDir, rel);
            if (rel && existsSync(common)) return common;
          } catch { /* 退回单 worktree 的 gitdir */ }
        }
        return gitDir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitCommonDir(cwd, env) {
  try {
    const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, env, encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    if (r.status === 0) {
      const line = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (line) {
        const abs = isAbsolute(line) ? line : resolve(cwd, line);
        if (existsSync(abs)) return abs;
      }
    }
  } catch { /* 走文件系统探测 */ }
  // Git 不在 PATH（很常见的被裁剪 shell / 服务环境）时，不能静默退回 tmpdir：
  // 那会让同一仓库的不同进程使用不同锁与活动台账。直接读取 .git 指针即可恢复同一状态目录。
  return gitCommonDirFromFs(cwd);
}

/**
 * 解析状态目录。优先级：环境变量 > Git 公共目录 > 系统临时目录（按路径哈希区分）。
 * @returns {{home:string, source:string, gitCommonDir:string|null}}
 */
export function resolveStateHome({ cwd = process.cwd(), env = process.env } = {}) {
  const override = env.TASKDOCK_BUILD_SCHED_HOME;
  if (override && override.trim() !== "") {
    if (!isAbsolute(override)) {
      throw new Error(`TASKDOCK_BUILD_SCHED_HOME 必须是绝对路径（当前 ${override}）`);
    }
    return { home: resolve(override), source: "env:TASKDOCK_BUILD_SCHED_HOME", gitCommonDir: null };
  }
  const common = gitCommonDir(cwd, env);
  if (common) {
    return { home: join(common, STATE_DIR_NAME), source: "git-common-dir", gitCommonDir: common };
  }
  const key = createHash("sha256").update(resolve(cwd).toLowerCase()).digest("hex").slice(0, 12);
  return { home: join(tmpdir(), `${STATE_DIR_NAME}-${key}`), source: "tmpdir-fallback", gitCommonDir: null };
}

/** 创建（幂等）状态目录结构。写操作前必须调用。 */
export function ensureState(home) {
  for (const sub of SUBDIRS) mkdirSync(join(home, sub), { recursive: true });
  return home;
}

export function paths(home) {
  return {
    home,
    slots: join(home, "slots"),
    reservations: join(home, "reservations"),
    queue: join(home, "queue"),
    cancel: join(home, "cancel"),
    logs: join(home, "logs"),
    history: join(home, "history.jsonl"),
    reclaimLog: join(home, "reclaim-log.jsonl"),
    config: join(home, "config.json"),
  };
}

export function slotDir(home, name) {
  return join(home, "slots", name);
}

/**
 * 原子写 JSON：同目录临时文件 → fsync → rename 覆盖。
 * Windows 下 Node 的 rename 使用 MoveFileEx(REPLACE_EXISTING)，可覆盖已存在文件。
 * 目标写不进去时抛错，由调用方决定是否降级（绝不静默丢状态）。
 */
// Windows 上 rename 覆盖一个正被其他进程打开的目标文件会返回 EPERM/EBUSY（杀毒/索引/另一个
// 调度进程正在读这条记录都会触发）。这类失败是可重试的：短退避后重试，最终仍失败才抛出。
// 注意：这里必须同步（调用点都是同步收尾路径），用 Atomics.wait 做短睡眠。
function renameWithRetry(tmp, target) {
  const codes = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
  const buf = new Int32Array(new SharedArrayBuffer(4));
  let lastErr = null;
  for (let i = 0; i < 200; i++) {
    try { renameSync(tmp, target); return; } catch (err) {
      lastErr = err;
      if (!codes.has(err?.code)) throw err;
      // 5ms 起、20ms 封顶，累计最多约 2s：机器被重负载或杀软拖慢时仍能等到写窗口
      Atomics.wait(buf, 0, 0, i < 4 ? 5 : 20);
    }
  }
  // 最后手段：直接原地覆盖写（放弃原子性，但绝不丢状态）。读方对半写文件已按"记录不存在"处理，
  // 下次轮询会重新写一遍，比"状态永远写不进去"安全。
  const text = readFileSync(tmp, "utf8");
  writeFileSync(target, text, "utf8");
  try { unlinkSync(tmp); } catch { /* ignore */ }
  void lastErr;
}

export function atomicWriteJson(target, value) {
  const dir = resolve(target, "..");
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const text = JSON.stringify(value, null, 2) + "\n";
  let fd = -1;
  try {
    fd = openSync(tmp, "wx");
    writeSync(fd, text);
    try { fsyncSync(fd); } catch { /* fsync 在部分 FS 上不可用，不阻塞写入 */ }
    closeSync(fd);
    fd = -1;
    renameWithRetry(tmp, target);
  } catch (err) {
    if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function atomicWriteText(target, text) {
  const dir = resolve(target, "..");
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, text, "utf8");
  try { renameWithRetry(tmp, target); } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function readJson(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch { return null; }
}

/** 读取目录下所有 .json 记录；损坏/半写文件按不存在处理，不抛出。 */
export function readJsonDir(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json") || e.name.startsWith(".")) continue;
    const v = readJson(join(dir, e.name));
    if (v && typeof v === "object") out.push(v);
  }
  return out;
}

export function appendJsonLine(path, entry) {
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(path, line, "utf8");
}

/**
 * 有界追加：条目数超过 limit 时压缩为「最后 limit 条」。
 * 只在追加时按行数判断，读全文件仅发生在这一个压缩点，且压缩失败不影响主流程。
 */
export function appendBoundedJsonLine(path, entry, limit) {
  appendJsonLine(path, entry);
  let lineCount = 0;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const ch of text) if (ch === "\n") lineCount++;
  if (lineCount <= limit * 2) return;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const kept = lines.slice(-limit);
  try { atomicWriteText(path, kept.join("\n") + "\n"); } catch { /* 压缩失败不影响已写入的条目 */ }
}

export function newTaskId(taskClass) {
  const prefix = { heavy: "h", medium: "m", light: "l" }[taskClass] ?? "x";
  const ts = Date.now().toString(36);
  return `${prefix}-${ts}-${randomBytes(3).toString("hex")}`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function fileSizeIfExists(path) {
  try { return statSync(path).size; } catch { return null; }
}

export function rmDirQuiet(path) {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
}
