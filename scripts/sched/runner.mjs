//! 任务执行器：入队 → 等待准入 → 抢槽位 → 起子进程 → 监控 → 收尾。
//!
//! 设计约束（对应需求第四/五/七条）：
//!   - 槽位租约覆盖子进程的**整个生命周期**（起之前拿、退出之后才放），不是「起进程就放锁」；
//!   - 等待期间不停轮询优先级、内存、取消标记，并以 15 秒节流输出等待原因（不静默无限等待）；
//!   - 子进程的标准输出/错误写日志文件，子进程退出码原样返回；
//!   - 取消/超时由「持有者自己」终止自己 spawn 的子进程树——不越权杀别人的进程；
//!     这区别于 lock.mjs 的 reapOrphanChild：后者处置的是**记录在磁盘上**的他人/崩溃遗留进程，
//!     必须先做身份与命令行校验；
//!   - 调度层失败用独立退出码，并在日志尾部写机器可读的 `sched:` 行，
//!     与「代码本身编译失败」区分开。

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyArgv } from "./classify.mjs";
import { concurrencyForClass, createMemorySampler, estimateForClass, formatMb } from "./mem.mjs";
import { appendBoundedJsonLine, ensureState, newTaskId, paths } from "./state.mjs";
import { killTree, selfIdentity, waitForGone } from "./proc.mjs";
import { slotNames, tryAcquireSlot } from "./lock.mjs";
import {
  ACTIVE_STATUSES, PRIORITY_LABEL, clearCancelMarker, computeFingerprint, effectivePriority,
  evaluateEligibility, finalizeOrphanRecord, findRunningEquivalent, housekeeping, isCancelRequested, readQueue, readTask,
  writeTask,
} from "./queue.mjs";

// 调度层退出码（子进程自身的退出码原样透传；用日志尾部 `sched:` 行区分层级）
export const EXIT = {
  ok: 0,
  usage: 2,
  waitTimeout: 3,
  cancelled: 4,
  internal: 5,
  diskBlocked: 6,
};

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(RUNNER_DIR, "..", "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(1, ms)));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- 子进程启动

function pathExts() {
  return (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

/**
 * 解析命令到可执行文件：PATH 查找 + PATHEXT 补全。
 * Node 在 Windows 上不允许 shell:false 直接执行 .cmd/.bat（安全限制），
 * 因此 .cmd/.bat（npm、npx、gradlew 等）统一走 ComSpec。
 */
export function resolveExecutable(cmd, cwd) {
  const hasSep = cmd.includes("/") || cmd.includes("\\");
  const candidates = [];
  const push = (base) => {
    candidates.push(base);
    if (!hasSep) for (const ext of pathExts()) candidates.push(base + ext);
  };
  if (hasSep) {
    push(isAbsolute(cmd) ? cmd : resolve(cwd, cmd));
  } else {
    for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) push(join(dir, cmd));
    push(resolve(cwd, cmd));
  }
  for (const cand of candidates) {
    try {
      if (existsSync(cand)) return { path: cand, needsShell: /\.(bat|cmd)$/i.test(cand) };
    } catch { /* 继续找 */ }
  }
  return null;
}

function quoteWinArg(arg) {
  if (arg === "") return '""';
  if (!/[\s&|<>^()%]/.test(arg)) return arg;
  return `"${arg}"`;
}

/**
 * 构造 spawn 计划。参数含换行或双引号时拒绝（cmd.exe 解析会出现歧义；
 * 构建命令不需要这种参数，确需如此用 --shell-raw 显式承担）。
 */
export function buildSpawnPlan(argv, cwd, extraEnv, { shellRaw = false } = {}) {
  if (argv.length === 0) throw Object.assign(new Error("没有可执行命令"), { exitCode: EXIT.usage });
  const risky = argv.filter((a) => /[\r\n]/.test(a) || a.includes('"'));
  if (risky.length && !shellRaw) {
    throw Object.assign(
      new Error(`参数包含换行或双引号，无法安全地跨 cmd.exe 传递：${JSON.stringify(risky)}（确需如此请加 --shell-raw）`),
      { exitCode: EXIT.usage },
    );
  }
  const resolved = resolveExecutable(argv[0], cwd);
  const display = argv.map(quoteWinArg).join(" ");
  const env = { ...process.env, ...extraEnv };

  if (resolved && !resolved.needsShell) {
    return {
      file: resolved.path, args: argv.slice(1), display, env, viaComspec: false,
      options: { cwd, env, windowsHide: true, shell: false },
    };
  }
  // .cmd/.bat（或 PATH 未命中）：交回 ComSpec，让 Windows 的脚本解析语义生效
  const comspec = process.env.ComSpec || "cmd.exe";
  const line = resolved
    ? [quoteWinArg(resolved.path), ...argv.slice(1).map(quoteWinArg)].join(" ")
    : display;
  return {
    file: comspec,
    // chcp 65001：cmd.exe 自身的中文错误信息走 OEM 代码页（936），不切到 UTF-8 会变成乱码
    args: ["/d", "/s", "/c", `chcp 65001>nul & ${line}`],
    // display 只保留「真实被执行的那条命令行」：它同时是崩溃恢复时校验子进程身份的凭据
    display: line,
    viaComspec: true,
    env,
    options: { cwd, env, windowsHide: true, shell: false, windowsVerbatimArguments: true },
  };
}

// ---------------------------------------------------------------- 日志

function createLogWriter(logPath, maxMb) {
  const fd = openSync(logPath, "a");
  const maxBytes = Math.round(maxMb * 1024 * 1024);
  let written = 0;
  let truncated = false;
  return {
    write(text) {
      if (typeof text !== "string" || text === "") return;
      if (truncated) return;
      if (written + text.length > maxBytes) {
        try { writeSync(fd, `\n[sched] 日志超过 ${maxMb} MB 上限，已停止写盘（输出仍转发到终端）\n`); } catch { /* ignore */ }
        truncated = true;
        return;
      }
      try { writeSync(fd, text); written += text.length; } catch { /* 磁盘异常不阻断构建 */ }
    },
    close() { try { closeSync(fd); } catch { /* ignore */ } },
    get truncated() { return truncated; },
  };
}

// ---------------------------------------------------------------- 主流程

/**
 * 执行一个被调度的任务。返回退出码：子进程码原样透传，调度层失败用 EXIT 常量。
 */
export async function executeTask({
  argv, cwd = process.cwd(), label, priority = 1, explicitClass = null,
  cfg, home, env = process.env, tee = true, dedupe = true, shellRaw = false, detachChild = false,
  waitTimeoutMin = null, runTimeoutMin = null, estimateMb = null, repoRoot = DEFAULT_REPO_ROOT,
  io = { out: process.stdout, err: process.stderr },
}) {
  const err = (msg) => io.err.write(`[sched] ${msg}\n`);
  const out = (msg) => io.out.write(`${msg}\n`);

  if (!Array.isArray(argv) || argv.length === 0) {
    err("用法：node scripts/build-sched.mjs run [选项] -- <命令> [参数...]");
    return EXIT.usage;
  }

  ensureState(home);
  const p = paths(home);
  const classification = classifyArgv(argv, { cwd, explicitClass });
  const taskClass = classification.taskClass;
  const concurrency = concurrencyForClass(cfg, taskClass);
  const waitMs = (waitTimeoutMin === null ? cfg.defaultWaitTimeoutMin : waitTimeoutMin) * 60000;
  const runLimitMs = (runTimeoutMin === null ? cfg.defaultRunTimeoutMin : runTimeoutMin) * 60000;
  const estMb = estimateMb ?? estimateForClass(cfg, taskClass);

  const precheckPath = join(repoRoot, "scripts", "build-guard.mjs");
  const fingerprint = dedupe ? computeFingerprint({ argv, cwd, env }) : null;
  const taskId = newTaskId(taskClass);
  const logPath = join(p.logs, `${taskId}.log`);

  const task = {
    id: taskId,
    label: label ?? argv.join(" "),
    taskClass,
    classReason: classification.reason,
    classRule: classification.rule,
    classOverridden: Boolean(explicitClass),
    priority,
    status: "queued",
    enqueuedAt: nowIso(),
    updatedAt: nowIso(),
    worktree: cwd,
    cwd,
    command: argv,
    envSubset: {
      CARGO_TARGET_DIR: env.CARGO_TARGET_DIR ?? null,
      CARGO_BUILD_JOBS: env.CARGO_BUILD_JOBS ?? null,
    },
    fingerprint: fingerprint ? { hash: fingerprint.hash, parts: fingerprint.parts } : null,
    estimateMb: estMb,
    detached: detachChild,
    owner: ownerIdentity(),
    logPath: `logs/${taskId}.log`,
    waitReason: null,
    child: null,
  };

  err(`任务 ${taskId} 分类=${taskClass}（${classification.reason}）优先级=${PRIORITY_LABEL[priority]}` +
    `${estMb ? `，预计峰值≈${formatMb(estMb)}` : ""}`);

  // ---- 等价任务去重：只附加到「正在运行」的等价任务，不复用已结束的旧结果
  if (fingerprint) {
    const running = findRunningEquivalent(readQueue(home), fingerprint);
    if (running) {
      err(`检测到等价任务正在运行：${running.id}（同命令/同工作区/同依赖与同一代码状态），` +
        "本次不重复执行，共享其结果（退出码与日志）");
      return await attachToRunning({ running, home, cfg, io, tee, taskId });
    }
  }

  writeTask(home, task);

  const sampler = createMemorySampler({ intervalMs: cfg.memorySampleMs, env });
  let memoryWaitSeen = false;
  let lease = null;
  let released = false;
  let lastNoticeAt = 0;
  let lastHousekeepAt = 0;
  let lastReclaimProbeAt = 0;
  let lastWriteAt = Date.now();
  const startWait = Date.now();
  const deadline = waitMs > 0 ? startWait + waitMs : Infinity;
  let lastReason = "";
  const memDuringWait = { startAvailMb: null, minAvailMb: null };

  const releaseLease = () => {
    if (lease && !released) {
      released = true;
      const r = lease.release();
      if (!r.ok) err(`槽位释放异常：${r.detail}`);
    }
  };

  const onSignal = (sig) => {
    err(`收到 ${sig}：终止本任务子进程树并释放槽位后退出`);
    if (task.child?.pid) {
      killTree(task.child.pid);
      waitForGone(task.child.pid, 3000);
    }
    releaseLease();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // 收尾：记录最终状态 → 写历史 → 释放槽位 → 输出机器可读尾行
  async function finish(t, { status, exitCode, reason, memDuringRun }) {
    const finishedAt = nowIso();
    const runMs = t.startedAt ? Date.now() - Date.parse(t.startedAt) : 0;
    const waitTotal = t.startedAt
      ? Date.parse(t.startedAt) - Date.parse(t.enqueuedAt)
      : Date.now() - Date.parse(t.enqueuedAt);

    // 先落最终状态再让 housekeeping 清理：附加方需要读到确定的 exitCode
    try {
      writeTask(home, {
        ...t, status, exitCode: exitCode ?? null, finishedAt,
        finishReason: reason ?? null, memDuringRun: memDuringRun ?? null,
      });
    } catch (e) { err(`写最终状态失败：${e?.message ?? e}`); }

    // 未真正启动的任务也要留下可读记录：否则 `history`/终端里给出的日志路径指向不存在的文件，
    // 事后无法判断"是没抢到资源还是构建本身失败"。
    try {
      if (logPath && !existsSync(logPath)) {
        writeFileSync(logPath,
          `# 任务 ${t.id} 未启动（没有子进程输出）\n` +
          `# status: ${status}\n# exitCode: ${exitCode ?? "-"}\n` +
          `# reason: ${reason ?? "-"}\n` +
          `# enqueuedAt: ${t.enqueuedAt}\n# finishedAt: ${finishedAt}\n` +
          `# waitMs: ${Math.max(0, waitTotal)}\n`, "utf8");
      }
    } catch { /* 日志缺失不应阻塞状态收尾 */ }

    try {
      appendBoundedJsonLine(p.history, {
        event: "finished", id: t.id, label: t.label, taskClass: t.taskClass,
        classRule: t.classRule, priority: t.priority, status,
        exitCode: exitCode ?? null, reason: reason ?? null,
        enqueuedAt: t.enqueuedAt, startedAt: t.startedAt ?? null, finishedAt,
        waitMs: Math.max(0, waitTotal), runMs,
        worktree: t.worktree, command: t.command, cwd: t.cwd,
        logPath: t.logPath, fingerprint: t.fingerprint?.hash ?? null,
        estimateMb: t.estimateMb,
        memDuringRun: memDuringRun ?? null,
        memDuringWait,
        child: t.child ?? null,
      }, cfg.historyMaxEntries);
    } catch (e) { err(`写历史失败：${e?.message ?? e}`); }

    clearCancelMarker(home, t.id);
    releaseLease();

    err(`任务结束：status=${status} exit=${exitCode ?? "null"} id=${t.id}` +
      `${reason ? ` reason=${reason}` : ""} 日志=${logPath}`);
    if (exitCode === 0) out(`[sched] 任务 ${t.id} 成功（${t.taskClass}，用时 ${Math.round(runMs / 1000)}s）`);
    err(`sched: exit=${exitCode ?? "null"} status=${status} class=${t.taskClass} reason=${reason ?? "-"}`);
    return exitCode ?? EXIT.internal;
  }

  try {
    // ------------------------------------------------ 排队等待准入
    while (true) {
      if (isCancelRequested(home, taskId)) {
        return await finish(task, { status: "cancelled", exitCode: EXIT.cancelled, reason: "排队中被取消" });
      }
      const now = Date.now();
      if (now > deadline) {
        return await finish(task, {
          status: "failed", exitCode: EXIT.waitTimeout,
          reason: `等待资源超时（等待上限 ${formatWaitLimit(waitMs)}）：最后阻塞原因：${lastReason || "未知"}`,
        });
      }

      const mem = sampler.current();
      if (memDuringWait.startAvailMb === null) memDuringWait.startAvailMb = mem.availMb;
      if (memDuringWait.minAvailMb === null || mem.availMb < memDuringWait.minAvailMb) memDuringWait.minAvailMb = mem.availMb;

      if (now - lastHousekeepAt > 5000) {
        lastHousekeepAt = now;
        const cleaned = housekeeping({
          home, tasks: readQueue(home), cfg, log: (m) => err(m), retentionMs: cfg.finishedRetentionMs,
        });
        if (cleaned.length) err(`清理了 ${cleaned.length} 条残留/过期记录`);
      }

      const tasks = readQueue(home);
      const elig = evaluateEligibility({ home, task, tasks, cfg, mem, memoryWaitSeen });
      if (!elig.memory.admit) memoryWaitSeen = true;

      const nextStatus = elig.memory.admit ? "queued" : "waiting_resources";
      const reason = elig.blockers.join("；");
      if (task.status !== nextStatus || reason !== lastReason || now - lastWriteAt > 6000) {
        task.status = nextStatus;
        task.waitReason = reason || null;
        task.lastMemoryOk = elig.memory.admit;
        try { writeTask(home, task); } catch { /* 状态写失败不阻断，下轮重试 */ }
        lastWriteAt = now;
      }
      if (reason) lastReason = reason;

      // 注意：槽位目录存在 ≠ 一定有人在跑。崩溃会话留下的陈旧槽位只能靠「身份取证 + 回收」解决，
      // 而取证要查系统进程（较慢），因此按 reclaimProbeMs 节流，不能每轮都做，也不能永不做。
      const slotFree = !elig.slotFull;
      const worthProbing = elig.slotOnlyBlocked && now - lastReclaimProbeAt >= cfg.reclaimProbeMs;
      if (elig.eligible || worthProbing) {
        if (elig.eligible && cfg.dedupe && fingerprint) {
          const again = findRunningEquivalent(readQueue(home), fingerprint);
          if (again) {
            err(`排队期间出现等价任务 ${again.id}，附加共享其结果`);
            return await attachToRunning({ running: again, home, cfg, io, tee, taskId });
          }
        }
        if (worthProbing && !elig.eligible) lastReclaimProbeAt = now;
        for (const slot of slotNames(taskClass, concurrency)) {
          const got = tryAcquireSlot({
            home, name: slot, taskId, taskClass, cfg, label: task.label, log: (m) => err(m),
          });
          if (got.lease) {
            lease = got.lease;
            released = false;
            if (got.reclaimed?.holderTask) {
              const finalized = finalizeOrphanRecord({
                home, taskId: got.reclaimed.holderTask, cfg,
                reason: `调度进程异常退出，槽位被回收（${got.reclaimed.reason}）`,
              });
              if (finalized) err(`已把崩溃遗留任务 ${got.reclaimed.holderTask} 归档为 failed`);
            }
            break;
          }
          lastReason = got.reason;
          if (got.blocked) break; // 无法取证/无法终止时不要空转抢槽位
        }
        if (lease) {
          // 拿到槽位后二次校验优先级：避免低优先级抢在同时入队的高优先级前面
          const conflict = priorityConflict(readQueue(home), task, cfg);
          if (conflict) {
            err(`让出槽位：${conflict}`);
            lease.release();
            lease = null;
            await sleep(cfg.pollMs);
            continue;
          }
          break; // 进入执行
        }
        void slotFree;
      }

      if (now - lastNoticeAt > 15000) {
        lastNoticeAt = now;
        err(`等待中（已 ${Math.round((now - startWait) / 1000)}s）：${reason || "等待调度"}；` +
          "可用 node scripts/build-sched.mjs queue / status 查看队列与资源");
      }
      await sleep(cfg.pollMs);
    }

    // ------------------------------------------------ 执行
    task.status = "running";
    task.startedAt = nowIso();
    task.waitMs = Date.now() - startWait;
    task.waitReason = null;
    writeTask(home, task);
    lease.setPhase("running");

    if (cfg.diskPrecheck && taskClass === "heavy" && existsSync(precheckPath)) {
      const pc = spawnSync(process.execPath, [precheckPath, "precheck"], {
        cwd, encoding: "utf8", timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      });
      if (pc.status !== 0) {
        const tail = `${pc.stdout ?? ""}${pc.stderr ?? ""}`.trim().split(/\r?\n/).slice(-8).join("\n");
        err(`磁盘/缓存 precheck 未通过（退出码 ${pc.status}），不启动重型构建：\n${tail}`);
        return await finish(task, {
          status: "failed", exitCode: EXIT.diskBlocked,
          reason: `磁盘空间或缓存状态不满足构建条件（build-guard precheck 退出码 ${pc.status}）`,
        });
      }
    }

    const childEnv = { TASKDOCK_SCHED_TASK_ID: taskId };
    if (!env.CARGO_BUILD_JOBS) childEnv.CARGO_BUILD_JOBS = String(cfg.cargoJobs);

    let plan;
    try {
      plan = buildSpawnPlan(argv, cwd, childEnv, { shellRaw });
    } catch (buildErr) {
      err(buildErr.message);
      return await finish(task, {
        status: "failed", exitCode: buildErr.exitCode ?? EXIT.usage, reason: buildErr.message,
      });
    }

    const log = createLogWriter(logPath, cfg.logMaxMb);
    log.write(
      `# Task Dock build scheduler — 任务 ${taskId}\n` +
      `# label: ${task.label}\n# class: ${taskClass} (${classification.reason})\n` +
      `# priority: ${PRIORITY_LABEL[priority]}\n# cwd: ${cwd}\n# command: ${plan.display}\n` +
      `# startedAt: ${nowIso()}\n# waitMs: ${Date.now() - startWait}\n# --- 子进程输出开始 ---\n`,
    );

    err(`开始执行：${plan.display}${plan.viaComspec ? "  (via cmd.exe)" : ""}`);
    err(`日志：${logPath}`);

    const child = spawn(plan.file, plan.args, { ...plan.options, detached: detachChild });
    let spawnError = null;
    child.on("error", (e) => { spawnError = e; });

    // 子进程身份：pid + 命令行 + 近似创建时间。
    // 创建时间取 spawn 返回时刻（误差在毫秒级），刻意不查 PowerShell——那会给每个构建
    // 的开头平白加上约 1 秒。回收时以**命令行签名**为主证据（见 lock.mjs 的 reapOrphanChild）。
    const childRecord = {
      pid: child.pid ?? null,
      startTime: new Date().toISOString(),
      startTimeSource: "spawn",
      commandLine: plan.display,
    };
    task.child = childRecord;
    writeTask(home, task);
    lease.setChild(childRecord);

    const memDuringRun = { minAvailMb: null, samples: 0 };
    const outcome = await waitForChild(child, {
      pollMs: cfg.pollMs,
      memorySampleMs: cfg.memorySampleMs,
      sampler,
      runLimitMs,
      home,
      taskId,
      tee, io, log,
      onMemorySample(m) {
        memDuringRun.samples += 1;
        if (memDuringRun.minAvailMb === null || m.availMb < memDuringRun.minAvailMb) memDuringRun.minAvailMb = m.availMb;
      },
      onCancel: () => err("收到取消请求：终止本任务子进程树"),
    });

    log.write(
      `\n# --- 子进程输出结束 ---\n# exitCode: ${outcome.code}\n# signal: ${outcome.signal ?? "null"}\n` +
      `# cancelled: ${outcome.cancelled} timedOut: ${outcome.timedOut}\n# finishedAt: ${nowIso()}\n` +
      (log.truncated ? "# NOTE: 日志已按上限截断\n" : ""),
    );
    log.close();

    if (spawnError && outcome.code === null) {
      return await finish(task, {
        status: "failed", exitCode: EXIT.internal,
        reason: `子进程启动失败：${spawnError.code ?? spawnError.message}`,
        memDuringRun,
      });
    }
    if (outcome.cancelled) {
      return await finish(task, { status: "cancelled", exitCode: EXIT.cancelled, reason: "运行中被取消", memDuringRun });
    }
    if (outcome.timedOut) {
      return await finish(task, {
        status: "failed", exitCode: EXIT.waitTimeout,
        reason: `运行超时（上限 ${Math.round(runLimitMs / 60000)} 分钟），已终止子进程树`,
        memDuringRun,
      });
    }
    const code = outcome.code ?? EXIT.internal;
    return await finish(task, {
      status: code === 0 ? "succeeded" : "failed",
      exitCode: code,
      reason: code === 0
        ? null
        : (outcome.signal ? `子进程被信号 ${outcome.signal} 终止` : `子进程退出码 ${code}`),
      memDuringRun,
    });
  } catch (e) {
    err(`调度器内部错误：${e?.stack ?? e}`);
    if (task.child?.pid) {
      killTree(task.child.pid);
      waitForGone(task.child.pid, 3000);
    }
    try {
      return await finish(task, { status: "failed", exitCode: EXIT.internal, reason: `调度器内部错误：${e?.message ?? e}` });
    } catch {
      return EXIT.internal;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    releaseLease();
  }
}

/**
 * 嵌套调用直通执行：当本进程已经处在另一个被调度的任务内部
 * （典型场景：`npm run tauri build` 的 beforeBuildCommand 是 `npm run build`），
 * 外层任务已经持有资源租约，内层再排队会造成「自己等自己」的死锁，也会重复占用槽位。
 * 因此内层直接执行、输出直通终端，退出码原样返回。
 */
export function runInline({ argv, cwd, shellRaw = false, io = { out: process.stdout, err: process.stderr } }) {
  let plan;
  try {
    plan = buildSpawnPlan(argv, cwd, { TASKDOCK_SCHED_NESTED: "1" }, { shellRaw });
  } catch (e) {
    io.err.write(`[sched] ${e.message}\n`);
    return e.exitCode ?? EXIT.usage;
  }
  io.err.write(`[sched] 嵌套调用直通执行：${plan.display}\n`);
  const r = spawnSync(plan.file, plan.args, { ...plan.options, stdio: "inherit" });
  if (r.error) {
    io.err.write(`[sched] 直通执行失败：${r.error.code ?? r.error.message}\n`);
    return EXIT.internal;
  }
  return typeof r.status === "number" ? r.status : EXIT.internal;
}

// 拿到槽位后的优先级复评（只看同分类内是否出现更高有效优先级任务）
export function priorityConflict(tasks, self, cfg) {
  const now = Date.now();
  const selfEff = effectivePriority(self, now, cfg);
  const higher = tasks.filter((t) => t.id !== self.id && ACTIVE_STATUSES.has(t.status) &&
    t.taskClass === self.taskClass && effectivePriority(t, now, cfg) < selfEff);
  if (!higher.length) return null;
  return `${higher.length} 个更高优先级任务在等待同一分类（如 ${higher[0].id} ${PRIORITY_LABEL[higher[0].priority] ?? ""}）`;
}

function ownerIdentity() {
  const self = selfIdentity();
  return {
    pid: self.pid,
    startTime: self.startTime,
    startTimeSource: self.source,
    commandLine: `node ${process.argv.slice(1).join(" ")}`,
  };
}

// 等待上限的展示：不足 1 分钟按秒显示（避免 "等待上限 0 分钟" 这种容易被读成"不限"的文案）
function formatWaitLimit(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "不限";
  if (ms >= 60000) {
    const min = ms / 60000;
    return Number.isInteger(min) ? `${min} 分钟` : `${min.toFixed(1)} 分钟`;
  }
  return `${Math.round(ms / 1000)} 秒`;
}

/**
 * 等待子进程结束，同时：取消标记轮询、运行超时、内存采样。
 * 终止时直接用自己的 child 句柄（不是磁盘记录），因为这是本进程 spawn 的进程。
 */
function waitForChild(child, opts) {
  return new Promise((resolvePromise) => {
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let lastMemAt = Date.now();
    const startMs = Date.now();

    const kill = (why) => {
      if (!child.pid) return;
      const r = killTree(child.pid);
      const gone = r.ok ? waitForGone(child.pid, 5000) : false;
      if (!gone) opts.io.err.write(`[sched] 终止子进程 ${child.pid} 失败（${why}）：${r.detail}\n`);
    };

    const interval = setInterval(() => {
      if (settled) return;
      if (!cancelled && isCancelRequested(opts.home, opts.taskId)) {
        cancelled = true;
        opts.onCancel?.();
        kill("取消请求");
      }
      if (opts.runLimitMs > 0 && !timedOut && Date.now() - startMs > opts.runLimitMs) {
        timedOut = true;
        kill("运行超时");
      }
      if (Date.now() - lastMemAt >= opts.memorySampleMs) {
        lastMemAt = Date.now();
        try { opts.onMemorySample(opts.sampler.current()); } catch { /* ignore */ }
      }
    }, Math.min(Math.max(opts.pollMs, 200), 1000));

    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      resolvePromise({ code, signal, cancelled, timedOut });
    };

    child.on("exit", (code, signal) => done(code, signal));
    child.on("close", (code, signal) => done(code, signal));
    child.on("error", () => { /* 由 exit/close 兜底 */ });

    if (opts.tee) {
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        opts.log.write(text);
        opts.io.out.write(text);
      });
      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        opts.log.write(`[stderr] ${text}`);
        opts.io.err.write(text);
      });
    } else {
      child.stdout?.on("data", (chunk) => opts.log.write(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk) => opts.log.write(`[stderr] ${chunk.toString("utf8")}`));
    }
  });
}

/**
 * 附加到正在运行的等价任务：等待其结束并共享结果。
 * 只共享「正在运行」的任务结果，从不读取历史旧结果（避免复用过期产物）。
 */
async function attachToRunning({ running, home, cfg, io, tee, taskId }) {
  const err = (msg) => io.err.write(`[sched] ${msg}\n`);
  const deadline = Date.now() + cfg.defaultWaitTimeoutMin * 60000;
  let lastNotice = Date.now();
  const logPath = join(paths(home).logs, `${running.id}.log`);

  while (true) {
    if (isCancelRequested(home, taskId)) {
      err(`附加等待中收到取消请求，退出（被附加任务 ${running.id} 不受影响）`);
      err(`sched: exit=${EXIT.cancelled} status=cancelled class=${running.taskClass} reason=attached-cancel`);
      return EXIT.cancelled;
    }
    const rec = readTask(home, running.id);
    if (rec && !ACTIVE_STATUSES.has(rec.status)) {
      const code = rec.exitCode ?? EXIT.internal;
      err(`等价任务 ${rec.id} 结束：status=${rec.status} exit=${code}（本次未重复执行）；日志 ${logPath}`);
      err(`sched: exit=${code} status=${rec.status} class=${rec.taskClass} reason=dedupe-attached-to:${rec.id}`);
      return code;
    }
    if (!rec) {
      const hist = findHistory(paths(home).history, running.id);
      const code = hist?.exitCode ?? EXIT.internal;
      err(`等价任务 ${running.id} 已移出队列，按历史结果返回 exit=${code}；日志 ${logPath}`);
      err(`sched: exit=${code} status=${hist?.status ?? "unknown"} class=${running.taskClass} reason=dedupe-attached-to:${running.id}`);
      return code;
    }
    if (Date.now() > deadline) {
      err(`等待等价任务 ${running.id} 超时，放弃附加（未启动新的构建）`);
      err(`sched: exit=${EXIT.waitTimeout} status=failed class=${running.taskClass} reason=dedupe-attach-timeout`);
      return EXIT.waitTimeout;
    }
    if (Date.now() - lastNotice > 15000) {
      lastNotice = Date.now();
      err(`等待等价任务 ${running.id}（${running.taskClass}）完成中…`);
    }
    await sleep(cfg.pollMs);
  }
}

function findHistory(historyPath, id) {
  try {
    const lines = readFileSync(historyPath, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(`"${id}"`)) continue;
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.id === id) return parsed;
      } catch { /* 继续向前找 */ }
    }
  } catch { /* 历史不存在 */ }
  return null;
}
