//! 跨进程任务队列：一个任务一个 JSON，谁提交谁写，别人只读。
//!
//! 并发安全模型（避免多进程同时改同一文件）：
//!   - 记录文件只由**提交它的进程**写入（原子 rename），其他进程只读；
//!   - 取消通过 `queue/cancel/<id>` 标记文件表达，不跨进程改别人的记录；
//!   - 槽位抢占由 `mkdir` 原子性决定（见 lock.mjs），优先级在拿到槽位后二次校验；
//!   - 提交进程已退出的残留记录由任意进程的 housekeeping 标记为 cancelled。
//!
//! 优先级：P0(0) < P1(1) < P2(2) < P3(3)，数字越大越低。等待时长按 agingStepMs 折算成
//! 「有效优先级」，每满一个周期提升一级，因此持续涌入的高优先级任务不能永久饿死 P3。

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { atomicWriteJson, appendBoundedJsonLine, paths, readJson, readJsonDir, sha256 } from "./state.mjs";
import { verifyIdentity } from "./proc.mjs";
import { concurrencyForClass } from "./config.mjs";
import { planGlobalConcurrency, readReservations } from "./admission.mjs";

export const PRIORITY_LABEL = { 0: "P0", 1: "P1", 2: "P2", 3: "P3" };
export const ACTIVE_STATUSES = new Set(["queued", "waiting_resources", "running"]);
/**
 * 「还在等槽位」的状态——只用于**优先级先后**判定。
 *
 * 2026-11-15 第二轮缺陷：优先级判定曾用 ACTIVE_STATUSES（含 running），于是**已经在跑**的
 * 高优先级任务被当成"在等同一分类"，后到的低优先级任务会让出刚拿到的槽位、下一轮又被同一条
 * 记录顶回去 → 无限让位（一个 P1 长驻 dev 就能把之后所有 P2 dev 永久饿死）。运行中的任务
 * 已经占有槽位（它体现在 slotUsage/concurrency 里），不能再算作"在前面排队"。
 */
export const WAITING_STATUSES = new Set(["queued", "waiting_resources"]);

export function parsePriority(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim().toUpperCase();
  if (/^P[0-3]$/.test(s)) return Number(s.slice(1));
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
  throw new Error(`优先级只能是 P0/P1/P2/P3（或 0-3），当前：${value}`);
}

export function effectivePriority(task, nowMs, cfg) {
  const enq = Date.parse(task.enqueuedAt ?? 0);
  const waited = Math.max(0, nowMs - (Number.isFinite(enq) ? enq : nowMs));
  const boost = cfg.agingStepMs > 0 ? Math.floor(waited / cfg.agingStepMs) : 0;
  return Math.max(0, Number(task.priority ?? 1) - boost);
}

export function priorityBasis(task, nowMs, cfg) {
  return { base: Number(task.priority ?? 1), effective: effectivePriority(task, nowMs, cfg) };
}

/** 排序键：有效优先级优先，同级按入队时间，再按 id 保证确定性。 */
function orderKey(task, nowMs, cfg) {
  const enq = Number.isFinite(Date.parse(task.enqueuedAt ?? "")) ? Date.parse(task.enqueuedAt) : 0;
  return [effectivePriority(task, nowMs, cfg), enqueueStamp(task, enq)];
}

// enqueuedAt 只有毫秒精度，同毫秒内用 id 尾部十六进制兜底
function enqueueStamp(task, enq) {
  return enq * 1000 + (parseInt(String(task.id).slice(-4), 16) % 1000 || 0);
}

export function compareOrder(a, b, nowMs, cfg) {
  const ka = orderKey(a, nowMs, cfg);
  const kb = orderKey(b, nowMs, cfg);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return String(a.id).localeCompare(String(b.id));
}

export function readQueue(home) {
  const rows = readJsonDir(paths(home).queue);
  return rows.filter((r) => r && typeof r.id === "string");
}

export function readTask(home, id) {
  return readJson(join(paths(home).queue, `${id}.json`));
}

export function writeTask(home, task) {
  task.updatedAt = new Date().toISOString();
  atomicWriteJson(join(paths(home).queue, `${task.id}.json`), task);
  return task;
}

export function removeTask(home, id) {
  try { rmSync(join(paths(home).queue, `${id}.json`), { force: true }); } catch { /* ignore */ }
}

export function cancelMarker(home, id) {
  return join(paths(home).cancel, id);
}

export function requestCancel(home, id, meta = {}) {
  const marker = cancelMarker(home, id);
  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), by: process.pid, ...meta }) + "\n", "utf8");
  return marker;
}

export function isCancelRequested(home, id) {
  return existsSync(cancelMarker(home, id));
}

export function clearCancelMarker(home, id) {
  try { rmSync(cancelMarker(home, id), { force: true }); } catch { /* ignore */ }
}

/** 统计各分类当前占用的槽位（只数目录，不做进程校验，快）。 */
export function slotUsage(home, cfg) {
  const dir = paths(home).slots;
  const usage = { heavy: 0, medium: 0, light: 0, dev: 0 };
  let names = [];
  try { names = readdirSync(dir); } catch { return usage; }
  for (const name of names) {
    const m = /^(heavy|medium|light|dev)-(\d+)$/.exec(name);
    if (!m) continue;
    let st;
    try { st = statSync(join(dir, name)); } catch { continue; }
    if (!st.isDirectory()) continue;
    // 超过配置并发量的历史槽位（配置调小后）不计入，但其目录仍会被回收
    if (Number(m[2]) > concurrencyForClass(cfg, m[1])) continue;
    usage[m[1]] += 1;
  }
  return usage;
}

/**
 * 记录是否「心跳过期」：活跃任务每次轮询都会刷新 updatedAt，
 * 超过租约时间不刷新说明提交进程已经不可能还在正常排队了。
 * 这是**便宜的**存活判据（一次时间比较），精确的进程身份取证只在确有必要时才做。
 */
export function recordStale(task, cfg, now = Date.now()) {
  const updated = Date.parse(task.updatedAt ?? task.enqueuedAt ?? "");
  if (!Number.isFinite(updated)) return true;
  return now - updated > (cfg?.leaseTtlMs ?? 45000);
}

/** 槽位目录里登记的持有者任务 id（用于判断某个 running 记录的槽位是否还占着）。 */
export function slotHolderTaskIds(home) {
  return readJsonDir(paths(home).slots)
    .map((slot) => slot.owner?.taskId)
    .filter(Boolean);
}

/**
 * 判断本任务是否可以开始，并把阻塞原因分成三类，供调度循环区别处理：
 *   - slotFull：本分类槽位被占（可能是**已经死掉的会话留下的陈旧槽位**，需要定期取证回收，
 *     所以不能只凭目录存在就永久拒绝，否则崩溃后就永远排不上）；
 *   - globalCap：全局构建并发已满（heavy/medium/light 合计；等任一构建结束自动释放名额）；
 *   - priorityBlockers：同分类内存在更高/更早的任务在等（心跳过期的僵尸记录不算）。
 * 跨分类不做头阻塞（重型在等时轻量仍可跑）。
 *
 * 2026-11-15 删除「实时可用内存门槛」（约束 A）；2026-11-16 删除「按物理内存估算的全局预算」
 * （约束 B）。现在**没有任何内存维度参与准入**：准入只看槽位 + 全局构建并发 + 优先级。
 *
 * 注意：这里只做**只读评估**（不回收、不写台账），权威判定在 acquireAdmission 的临界区里重做一次。
 */
export function evaluateEligibility({ home, task, tasks, cfg }) {
  const now = Date.now();
  // 预留台账只读一次：全局并发（约束 C）与状态展示必须看同一份快照
  const entries = readReservations(home);
  const capEval = planGlobalConcurrency({ cfg, entries, taskId: task.id, taskClass: task.taskClass });
  const usage = slotUsage(home, cfg);
  const concurrency = concurrencyForClass(cfg, task.taskClass);
  const slotFull = usage[task.taskClass] >= concurrency;
  const slotBlockers = slotFull ? [`${task.taskClass} 槽位已满（${usage[task.taskClass]}/${concurrency}）`] : [];
  const capBlockers = capEval.admit ? [] : [capEval.reason];

  // 僵尸记录（提交进程已死、心跳早已停更）不参与排序，否则崩溃一次就会永远堵住同分类队列；
  // 同样地，**运行中**的任务不参与"谁在前"的比较——它已经拿到槽位，不该把后来者挡在门外
  const peers = tasks.filter((t) => t.id !== task.id && WAITING_STATUSES.has(t.status) &&
    t.taskClass === task.taskClass && !recordStale(t, cfg, now));
  const better = peers.filter((t) => compareOrder(t, task, now, cfg) < 0);
  const strictlyHigher = better.filter((t) => effectivePriority(t, now, cfg) < effectivePriority(task, now, cfg));
  const samePriorityAhead = better.filter((t) => effectivePriority(t, now, cfg) === effectivePriority(task, now, cfg));
  const priorityBlockers = [];
  if (strictlyHigher.length > 0) {
    priorityBlockers.push(`同分类有 ${strictlyHigher.length} 个更高优先级任务在前（${strictlyHigher[0].id} ${PRIORITY_LABEL[strictlyHigher[0].priority] ?? ""}）`);
  } else if (samePriorityAhead.length > 0) {
    priorityBlockers.push(`同分类同优先级需排队（前面有 ${samePriorityAhead.length} 个，最早 ${samePriorityAhead[0].id}）`);
  }

  const blockers = [...slotBlockers, ...capBlockers, ...priorityBlockers];
  return {
    eligible: blockers.length === 0,
    blockers,
    slotFull,
    slotBlockers,
    capBlockers,
    priorityBlockers,
    // 槽位被占、全局并发与优先级都没问题：值得定期做一次「持有者是否已死」的回收取证
    slotOnlyBlocked: slotFull && capBlockers.length === 0,
    // 并发名额被占住可能是崩溃残留的台账（名额随任务收尾删除），必须定期去台账取证
    capBlocked: capBlockers.length > 0,
    cap: capEval,
    usage,
    waitingAhead: better.length,
  };
}

export function statusLabel(task) {
  return task.status === "running" ? "running" : "queued";
}

/**
 * 清理残留：提交进程已退出的 queued/waiting 记录标记为 cancelled，
 * 避免「排队进程退出后留下永久无法执行的任务」。
 */
/**
 * 清理残留与过期记录：
 *   - 提交进程已退出的 queued/waiting 记录标记为 cancelled 并归档，
 *     避免「排队进程退出后留下永久无法执行的任务」；
 *   - 已结束且超过保留时长的记录从队列目录移除（结果已进 history.jsonl）。
 */
export function housekeeping({ home, tasks, cfg, log, retentionMs = cfg.finishedRetentionMs ?? 60000 }) {
  const now = Date.now();
  const changed = [];

  // 过期终态记录：附加方读取的窗口已过，可以直接清掉
  for (const t of tasks) {
    if (ACTIVE_STATUSES.has(t.status)) continue;
    const finished = Number.isFinite(Date.parse(t.finishedAt ?? "")) ? Date.parse(t.finishedAt) : null;
    if (finished === null || now - finished < retentionMs) continue;
    try {
      removeTask(home, t.id);
      clearCancelMarker(home, t.id);
      changed.push({ id: t.id, reason: "已结束记录过期清理" });
    } catch { /* ignore */ }
  }

  for (const t of tasks) {
    if (!ACTIVE_STATUSES.has(t.status)) continue;
    // 并发扫描守卫：本快照可能是几秒前读的，收尾前必须复核落盘记录——
    // 另一个等待者的 housekeeping 可能已经把它落成终态并删除，避免重复归档/重复写历史。
    const onDisk = readTask(home, t.id);
    if (!onDisk || !ACTIVE_STATUSES.has(onDisk.status)) continue;
    // 便宜的存活判据优先：心跳还在刷新说明提交进程仍在正常排队，不需要查系统进程
    if (!recordStale(onDisk, cfg, now)) continue;
    if (onDisk.status === "running") {
      // 运行中的记录只有确认「槽位也不再由它持有」时才收尾——否则交给槽位回收流程，
      // 因为绝不能因为记录心跳停了就放行新构建（旧构建可能还活着）。
      if (slotHolderTaskIds(home).includes(t.id)) continue;
    }
    const idCheck = ownerLiveness(onDisk);
    if (idCheck.alive) continue;
    // 历史已有终态记录：只清掉残留的队列记录与取消标记，不再往 history.jsonl 追加第二条
    // （并发扫描曾把同一 succeeded 任务重复写成多条矛盾 failed 记录）。
    const alreadyHistoried = historyHasTerminal(home, t.id);
    if (alreadyHistoried) {
      try {
        removeTask(home, t.id);
        clearCancelMarker(home, t.id);
        changed.push({ id: t.id, reason: "历史已有终态记录，清理残留队列记录" });
      } catch { /* 单条失败不阻塞其他任务 */ }
      continue;
    }
    const orphan = {
      ...onDisk,
      status: onDisk.status === "running" ? "failed" : "cancelled",
      finishedAt: new Date().toISOString(),
      finishReason: onDisk.status === "running"
        ? `调度进程已退出且槽位已释放，记录由清理流程收尾（${idCheck.detail}）`
        : `提交进程已退出（${idCheck.detail}），排队任务不再可执行`,
      updatedAt: new Date().toISOString(),
    };
    try {
      atomicWriteJson(join(paths(home).queue, `${t.id}.json`), orphan);
      appendBoundedJsonLine(paths(home).history, {
        event: "finished", id: t.id, label: t.label, taskClass: t.taskClass,
        priority: t.priority, status: orphan.status, exitCode: onDisk.status === "running" ? onDisk.exitCode ?? null : null,
        enqueuedAt: onDisk.enqueuedAt, startedAt: null, finishedAt: orphan.finishedAt,
        waitMs: now - Date.parse(onDisk.enqueuedAt ?? now), runMs: 0,
        worktree: onDisk.worktree, command: onDisk.command, reason: orphan.finishReason,
        recoveredBy: "housekeeping",
      }, cfg.historyMaxEntries);
      removeTask(home, t.id);
      clearCancelMarker(home, t.id);
      changed.push({ id: t.id, reason: orphan.finishReason });
      if (log) log(`清理残留排队任务 ${t.id}：${orphan.finishReason}`);
    } catch { /* 单条失败不阻塞其他任务 */ }
  }
  return changed;
}

/**
 * 把一个「提交进程已死、但记录仍停在 running」的孤儿任务落成终态。
 * 只允许在确认原提交进程已退出后调用（回收槽位时、doctor --reap 时），
 * 这样 queue/history 不会永远显示幽灵运行中任务。
 */
export function finalizeOrphanRecord({ home, taskId, cfg, reason }) {
  if (!taskId) return null;
  const rec = readTask(home, taskId);
  if (!rec || !ACTIVE_STATUSES.has(rec.status)) return null;
  const liveness = ownerLiveness(rec);
  if (liveness.alive) return null;
  const finishedAt = new Date().toISOString();
  const final = {
    ...rec, status: "failed", exitCode: null, finishedAt,
    finishReason: reason ?? `调度进程异常退出后由回收流程标记（${liveness.detail}）`,
    updatedAt: finishedAt,
  };
  atomicWriteJson(join(paths(home).queue, `${taskId}.json`), final);
  appendBoundedJsonLine(paths(home).history, {
    event: "finished", id: rec.id, label: rec.label, taskClass: rec.taskClass,
    priority: rec.priority, status: "failed", exitCode: null, reason: final.finishReason,
    enqueuedAt: rec.enqueuedAt, startedAt: rec.startedAt ?? null, finishedAt,
    waitMs: rec.startedAt ? Date.parse(rec.startedAt) - Date.parse(rec.enqueuedAt) : null,
    runMs: rec.startedAt ? Date.parse(finishedAt) - Date.parse(rec.startedAt) : 0,
    worktree: rec.worktree, command: rec.command, recoveredBy: "slot-reclaim",
  }, cfg.historyMaxEntries);
  clearCancelMarker(home, taskId);
  return final;
}

// ---------------------------------------------------------------- 去重指纹

const GIT_FILES = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "rust-toolchain.toml", "src-tauri/rust-toolchain.toml", "vite.config.ts", "tsconfig.json", "build-sched.config.json"];
const ENV_KEYS = ["CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "NODE_ENV", "RUSTFLAGS", "TASKDOCK_PROFILE_DEV_DEBUG", "TAURI_ENV_DEBUG", "CI"];

function gitOutput(cwd, args) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20000, windowsHide: true });
    if (r.status !== 0) return null;
    return (r.stdout || "").trim();
  } catch { return null; }
}

/**
 * 计算等价性指纹。**只有在全部关键输入都相同时**两个任务才算等价：
 * 命令、工作目录（不同 worktree 产物不同，必须区分）、相关环境变量、
 * 依赖清单内容、工具链版本、Git 提交与未提交修改。
 * 任何一项取不到（例如非 Git 目录）都只影响指纹的稳定性，不影响「不等价就不复用」的原则。
 */
export function computeFingerprint({ argv, cwd, env = process.env }) {
  const parts = {
    version: 1,
    command: argv.map((a) => a.replace(/\\/g, "/")).join(" "),
    cwd: resolve(cwd).toLowerCase().replace(/\\/g, "/"),
    env: {},
    files: {},
    git: {},
    toolchain: {},
  };
  for (const key of ENV_KEYS) if (env[key] !== undefined) parts.env[key] = String(env[key]);

  for (const rel of GIT_FILES) {
    const abs = join(cwd, rel);
    try {
      const buf = readFileSync(abs);
      parts.files[rel] = sha256(buf);
    } catch { /* 文件不存在：跳过，等价性判定自动更严格 */ }
  }

  const head = gitOutput(cwd, ["rev-parse", "HEAD"]);
  if (head) parts.git.head = head;
  const status = gitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status !== null) parts.git.status = sha256(status);

  const cargoVersion = spawnVersion("cargo", cwd);
  if (cargoVersion) parts.toolchain.cargo = cargoVersion;
  const rustcVersion = spawnVersion("rustc", cwd);
  if (rustcVersion) parts.toolchain.rustc = rustcVersion;
  parts.toolchain.node = process.version;

  const hash = sha256(JSON.stringify(parts));
  return { hash, parts };
}

function spawnVersion(cmd, cwd) {
  try {
    const r = spawnSync(cmd, ["--version"], { cwd, encoding: "utf8", timeout: 15000, windowsHide: true });
    if (r.status !== 0) return null;
    return (r.stdout || "").trim();
  } catch { return null; }
}

/**
 * 判断「提交该记录的进程是否还在」。
 * 'gone' → 明确已退出（PID 不存在或被复用）；'same' → 身份一致；
 * 'unknown' → 无法取证时一律 fail-closed 按存活保留：取证失败（CIM/权限/读不到创建时间）
 * 不等于进程已退出，不能再用「记录超过 45s 未更新」的时间兜底把活着但探不到的任务收尾。
 * 真正的残留交给槽位/台账回收路径与 doctor --reap 用命令行签名取证处置。
 */
export function ownerLiveness(task) {
  const check = verifyIdentity({ pid: task.owner?.pid, startTime: task.owner?.startTime ?? null, source: task.owner?.startTimeSource });
  if (check.state === "same") return { alive: true, detail: check.detail };
  if (check.state === "gone") return { alive: false, detail: check.detail };
  return {
    alive: true,
    detail: `无法确认进程身份（${check.detail}），fail-closed 按存活保留，留待取证回收`,
  };
}

/** history.jsonl 中是否已存在该任务的终态记录（用于 housekeeping 防重复归档）。 */
function historyHasTerminal(home, id) {
  const hist = paths(home).history;
  let text;
  try { text = readFileSync(hist, "utf8"); } catch { return false; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.id === id) return true;
  }
  return false;
}

/**
 * 查找正在运行的等价任务。**只附加到 running 且提交进程仍存活**的任务，
 * 从不复用已结束的历史结果——「无法证明等价」与「产物已过期」两种风险都不承担。
 */
export function findRunningEquivalent(tasks, fingerprint) {
  return tasks.find((t) => t.status === "running" && t.fingerprint?.hash &&
    t.fingerprint.hash === fingerprint.hash && ownerLiveness(t).alive) ?? null;
}
