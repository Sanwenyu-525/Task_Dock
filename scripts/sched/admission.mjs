//! 跨分类准入：活动台账 + 全局构建并发上限 + 分类槽位，三者共用一个 `.admission` 临界区。
//!
//! 2026-11-16 按用户要求**删除**「按物理内存估算的全局预算」（原约束 B）：不再读物理内存、
//! 不再按 `estimate*Mb`/`reservedMb` 记账、不再有「预算不足/本机装不下」这种准入结论。
//! 现在准入只有两条结构性约束 + 一条排队规则：
//!   1) **全局构建并发**：heavy/medium/light 同时在跑 ≤ `globalConcurrency`（默认 3）；
//!      第 N+1 个排队，任一构建收尾删除自己的台账即**自动释放名额**；
//!   2) **分类槽位**：heavy/medium/light/dev 各自的并发槽位（`mkdir` 原子性 + 租约）；
//!   3) 同分类内按优先级/入队顺序排队（见 queue.mjs）。
//!
//! 台账 `reservations/<taskId>.json` 仍然存在，但只回答一个问题：**此刻谁在跑/谁正在启动**。
//! 它不再记录内存数字；用途只有两个：
//!   - 全局并发名额计数（排队中的任务不写台账，所以不会自己挡自己）；
//!   - 崩溃残留回收（持有者已证明退出 + 子进程已证明结束才删）。
//!
//! 原子性：名额判定、台账写入与槽位占用在**同一个** `slots/.admission` 临界区里完成
//! （复用 lock.mjs 的 mkdir 原子性 + 心跳 + 身份取证，不另造锁体系、不引入常驻守护进程）。
//! 因此两个进程不可能同时认为「还剩最后一个名额」，也不会出现「先占了槽位才发现名额不够」。

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { appendJsonLine, atomicWriteJson, ensureState, paths, readJson, readJsonDir } from "./state.mjs";
import { cmdlineSignature, tryAcquireSlot } from "./lock.mjs";
import { isPidAlive, listProcesses, selfIdentity, verifyIdentity } from "./proc.mjs";

/** 准入临界区的槽位名（`slots/.admission`；以 `.` 开头，不会被槽位统计/状态表当成构建槽位）。 */
export const ADMISSION_SLOT = ".admission";
/** 台账生命周期阶段。 */
export const PHASES = ["queued", "starting", "running", "releasing"];

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- 全局构建并发上限

/** 计入「全局构建并发」的分类：dev 是常驻服务，按既有契约不占一次性构建名额。 */
export const BUILD_CLASSES = ["heavy", "medium", "light"];

/**
 * 全局构建并发上限（纯函数）。
 *
 * 为什么用「活动台账条数」当计数：排队中的任务**不写台账**（台账只在即将启动时创建），
 * 所以 `reservations/*.json` 里的非 dev 条目 = 当前真正在跑或正在启动的构建数。这份台账只在
 * `.admission` 临界区内「读取 → 判定 → 写台账」，因此两个进程不可能同时认为「还剩最后一个名额」。
 * 名额释放不需要额外动作：任务收尾时删除台账条目（releaseReservation）就等于自动归还名额；
 * 崩溃残留由既有的 reclaimStaleReservations 回收。
 *
 * dev 不计入：常驻 dev 服务按既有设计不占一次性构建锁，由 devConcurrency 单独限流。
 * 因此 dev 任务既**不消耗**名额，也**不被**该上限拒绝（`applies=false`）；否则
 * "3 个构建在跑"会顺带把 `npm run tauri dev` 也堵住，超出这条锁的本意。
 *
 * @returns {{applies:boolean, admit:boolean, cap:number|null, active:number, activeTaskIds:string[], scope:string, reason:string|null}}
 */
export function planGlobalConcurrency({ cfg, entries = [], taskId = null, taskClass = null }) {
  const rawCap = Number(cfg?.globalConcurrency);
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : null;
  // 同一 taskId 的旧记录是重入，不算别人；phase=releasing 也计入（宁可少放行一个，也不超发名额）
  const active = entries.filter((e) => e && e.taskId !== taskId && BUILD_CLASSES.includes(e.taskClass));
  const base = {
    cap,
    active: active.length,
    activeTaskIds: active.slice(0, 8).map((e) => e.taskId),
    scope: "heavy/medium/light（dev 常驻服务不计入）",
  };
  // 请求方自己是 dev：约束不适用（只看它自己的 dev 槽位）
  const applies = taskClass == null ? true : BUILD_CLASSES.includes(taskClass);
  if (!applies) return { ...base, applies: false, admit: true, reason: null };
  if (cap === null) return { ...base, applies: true, admit: true, reason: null };
  if (active.length < cap) return { ...base, applies: true, admit: true, reason: null };
  const who = active.slice(0, 4).map((e) => `${e.taskId}(${e.taskClass})`).join("、");
  return {
    ...base,
    applies: true,
    admit: false,
    reason: `全局构建并发已满（${active.length}/${cap}）：正在运行 ${who}` +
      `${active.length > 4 ? ` 等 ${active.length} 个` : ""}；` +
      "任一构建结束会自动释放名额，按优先级排队即可",
  };
}

// ---------------------------------------------------------------- 活动台账读写

function safeTaskId(taskId) {
  return String(taskId ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function reservationPath(home, taskId) {
  return join(paths(home).reservations, `${safeTaskId(taskId)}.json`);
}

export function readReservations(home) {
  return readJsonDir(paths(home).reservations).filter((r) => r && typeof r.taskId === "string");
}

export function readReservation(home, taskId) {
  return readJson(reservationPath(home, taskId));
}

/** 创建台账记录（不落盘，调用方在临界区内写）。只记录身份/阶段，不记录内存。 */
export function createReservation({ taskId, taskClass, label = null, detached = false }) {
  const self = selfIdentity();
  return {
    taskId, taskClass,
    label,
    ownerPid: self.pid,
    ownerStartTime: self.startTime,
    ownerStartTimeSource: self.source,
    nonce: randomBytes(6).toString("hex"),
    childPid: null,
    childCmdSignature: null,
    detached: detached === true,
    phase: "queued",
    createdAt: nowIso(),
    heartbeatAt: nowIso(),
  };
}

export function writeReservation(home, entry) {
  ensureState(home);
  atomicWriteJson(reservationPath(home, entry.taskId), entry);
  return entry;
}

/** 心跳：便宜地刷新 heartbeatAt（3s 一次，文件只有几百字节，代价可忽略）。 */
export function startReservationHeartbeat(home, entry, intervalMs) {
  let stopped = false;
  const beat = () => {
    if (stopped || !entry) return;
    entry.heartbeatAt = nowIso();
    try { writeReservation(home, entry); } catch { /* 心跳失败不阻断构建；失效检测会退化为进程证据 */ }
  };
  beat();
  const timer = setInterval(beat, Math.max(200, intervalMs));
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

export function setReservationPhase(home, entry, phase) {
  if (!entry) return;
  entry.phase = PHASES.includes(phase) ? phase : entry.phase;
  entry.heartbeatAt = nowIso();
  try { writeReservation(home, entry); } catch { /* ignore */ }
}

/** 子进程身份必须在 spawn 成功后立刻登记：崩溃回收要靠它证明「旧构建已结束」。 */
export function setReservationChild(home, entry, childRecord) {
  if (!entry || !childRecord) return;
  entry.childPid = Number.isInteger(childRecord.pid) ? childRecord.pid : null;
  entry.childCmdSignature = cmdlineSignature(childRecord.commandLine ?? "");
  // 原始命令行也要留：doctor --reap 用 reapOrphanChild 做签名取证时，比对的是原始串
  entry.childCmdLine = String(childRecord.commandLine ?? "");
  entry.heartbeatAt = nowIso();
  try { writeReservation(home, entry); } catch { /* ignore */ }
}

/**
 * 释放台账条目：只有「身份完全相符」才删。
 * 校验 (ownerPid, ownerStartTime, nonce)——单看 PID 会在系统复用 PID 后误删别人的记录。
 */
export function releaseReservation({ home, entry, reason = "任务结束", log = null }) {
  if (!entry) return { ok: true, detail: "没有台账需要释放" };
  const path = reservationPath(home, entry.taskId);
  const current = readJson(path);
  if (!current) return { ok: true, detail: "台账记录已不存在（可能已被安全回收）" };
  const mismatch = [];
  if (current.nonce !== entry.nonce) mismatch.push("nonce 不符");
  if (Number(current.ownerPid) !== Number(entry.ownerPid)) mismatch.push(`ownerPid 不符（记录 ${current.ownerPid}，本进程 ${entry.ownerPid}）`);
  if (String(current.ownerStartTime ?? "") !== String(entry.ownerStartTime ?? "")) mismatch.push("进程创建时间不符");
  if (mismatch.length) {
    if (log) log(`台账 ${entry.taskId} 不归本进程（${mismatch.join("、")}），拒绝删除`);
    return { ok: false, detail: `台账不归本进程（${mismatch.join("、")}），拒绝删除` };
  }
  try { unlinkSync(path); } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, detail: "台账记录已不存在" };
    return { ok: false, detail: `删除台账失败：${err?.code ?? err}` };
  }
  return { ok: true, detail: `已释放名额（${reason}）` };
}

// ---------------------------------------------------------------- 崩溃残留判定

function heartbeatAgeMs(entry, now) {
  const at = Date.parse(entry.heartbeatAt ?? entry.createdAt ?? "");
  return Number.isFinite(at) ? Math.max(0, now - at) : Number.POSITIVE_INFINITY;
}

/** 默认证据提供者（真实系统）。单测注入替身，避免依赖 PowerShell / 真实进程。 */
export function defaultProbe() {
  return {
    ownerAlive: (pid) => isPidAlive(pid),
    childAlive: (pid) => isPidAlive(pid),
    verify: (entry) => verifyIdentity({
      pid: entry.ownerPid,
      startTime: entry.ownerStartTime ?? null,
      source: entry.ownerStartTimeSource,
    }),
    hasLiveChildOf(pid) {
      const scan = listProcesses();
      if (!scan.ok) return { known: false, alive: false, detail: scan.error ?? "进程枚举失败" };
      const hit = scan.rows.find((r) => r.parentPid === pid);
      return { known: true, alive: Boolean(hit), detail: hit ? `PID ${hit.pid}（${hit.name}）` : "无存活子进程" };
    },
  };
}

/**
 * 判断一条崩溃残留台账能否回收（纯函数 + 可注入证据提供者，便于单测穷举边界）。
 *
 * 顺序刻意这样排：
 *   1) 持有进程 PID 还活着 → 一律按占用处理，**不调 CIM**（热路径必须便宜；
 *      PID 复用造成的"假存活"泄漏由 doctor --reap 的身份取证处置，属于 fail-closed 侧）；
 *   2) 持有进程已死 → 看登记的 childPid：存活就不动（旧构建可能还在跑）；不存在才回收；
 *   3) 没有 childPid（崩在 spawn 与登记之间）→ 只有「非 detached + 超过宽限 + 该进程确实没有
 *      存活子进程」三条同时成立才回收；detached 的孤儿**永不自动回收**。
 */
export function classifyReservation(entry, { cfg, now = Date.now(), probe = defaultProbe() } = {}) {
  const age = heartbeatAgeMs(entry, now);
  const ageText = Number.isFinite(age) ? `${Math.round(age / 1000)}s` : "未知";
  const base = { taskId: entry.taskId, taskClass: entry.taskClass, heartbeatAgeMs: age };

  if (!Number.isInteger(entry.ownerPid)) {
    return { ...base, reclaimable: false, state: "unknown", detail: "台账缺少持有进程 PID（按占用处理，需 doctor --reap 处置）" };
  }
  if (probe.ownerAlive(entry.ownerPid)) {
    return { ...base, reclaimable: false, state: "owner-alive", detail: `持有进程 PID ${entry.ownerPid} 仍存活（心跳 ${ageText} 前），按占用处理` };
  }
  const identity = probe.verify(entry);
  if (identity.state !== "gone") {
    return { ...base, reclaimable: false, state: "unknown", detail: `持有进程身份无法确认为已退出（${identity.detail}），fail-closed` };
  }

  if (Number.isInteger(entry.childPid)) {
    if (probe.childAlive(entry.childPid)) {
      return {
        ...base, reclaimable: false, state: "child-alive",
        detail: `持有进程已退出，但登记的构建子进程 PID ${entry.childPid} 仍存活（旧构建可能还在跑）`,
      };
    }
    return {
      ...base, reclaimable: true, state: "owner-gone-child-gone",
      detail: `持有进程已退出（${identity.detail}），构建子进程 PID ${entry.childPid} 也已结束`,
    };
  }

  if (entry.detached === true) {
    return {
      ...base, reclaimable: false, state: "detached-orphan",
      detail: "台账由 detached 子进程持有且未登记 childPid，无法证明脱离控制台的构建已退出（需 doctor --reap）",
    };
  }
  const grace = Number.isFinite(Number(cfg?.reservationOrphanGraceMs)) ? Number(cfg.reservationOrphanGraceMs) : 0;
  if (age < grace) {
    return { ...base, reclaimable: false, state: "grace", detail: `尚未登记 childPid 且心跳仅 ${ageText} 前（宽限 ${Math.round(grace / 1000)}s 未到）` };
  }
  const kids = probe.hasLiveChildOf(entry.ownerPid);
  if (!kids.known) {
    return { ...base, reclaimable: false, state: "unknown-children", detail: `无法确认持有进程是否留下存活子进程（${kids.detail}）` };
  }
  if (kids.alive) {
    return { ...base, reclaimable: false, state: "child-alive", detail: `持有进程已退出，但仍有子进程存活：${kids.detail}` };
  }
  return {
    ...base, reclaimable: true, state: "owner-gone-no-child",
    detail: `持有进程已退出（${identity.detail}），未登记 childPid 且无存活子进程（宽限 ${Math.round(grace / 1000)}s 已过）`,
  };
}

/** 真正删除一条崩溃残留台账（回收动作）；写审计行。 */
function reclaimReservationFile({ home, entry, audit, detail, log }) {
  const path = reservationPath(home, entry.taskId);
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, detail: "已被其他进程回收" };
    if (audit) {
      appendJsonLine(audit, { at: nowIso(), kind: "reservation-reclaim-failed", taskId: entry.taskId, detail: String(err?.code ?? err) });
    }
    return { ok: false, detail: `删除台账失败：${err?.code ?? err}` };
  }
  if (audit) {
    appendJsonLine(audit, {
      at: nowIso(), kind: "reservation-reclaimed", taskId: entry.taskId, taskClass: entry.taskClass,
      ownerPid: entry.ownerPid, childPid: entry.childPid ?? null, reason: detail,
    });
  }
  if (log) log(`回收崩溃残留台账 ${entry.taskId}（名额已归还）：${detail}`);
  return { ok: true, detail };
}

/**
 * 回收所有可安全回收的残留台账，并返回"回收之后"的台账（供名额判定用）。
 * 不可回收的条目保持占用，并带上原因（doctor / status 会展示，便于人工定位）。
 */
export function reclaimStaleReservations({ home, cfg, probe = defaultProbe(), audit = null, log = null, now = Date.now() }) {
  const entries = readReservations(home);
  const removed = [];
  const blocked = [];
  for (const entry of entries) {
    let verdict;
    try {
      verdict = classifyReservation(entry, { cfg, now, probe });
    } catch (err) {
      blocked.push({ taskId: entry.taskId, state: "probe-error", detail: `取证异常：${err?.message ?? err}` });
      continue;
    }
    if (!verdict.reclaimable) {
      if (verdict.state !== "owner-alive") {
        blocked.push({ taskId: entry.taskId, state: verdict.state, detail: verdict.detail });
      }
      continue;
    }
    const r = reclaimReservationFile({ home, entry, audit, detail: verdict.detail, log });
    if (r.ok) removed.push({ taskId: entry.taskId, taskClass: entry.taskClass, detail: verdict.detail });
    else blocked.push({ taskId: entry.taskId, state: "reclaim-failed", detail: r.detail });
  }
  return { removed, blocked, entries: readReservations(home) };
}

// ---------------------------------------------------------------- 原子准入

/**
 * 跨进程原子准入：名额判定 + 活动台账 + 分类槽位，在同一个 `slots/.admission` 临界区里完成。
 *
 * 顺序是硬约束（不得颠倒）：
 *   名额判定 → 写台账 → 拿槽位；任何一步失败都回滚，绝不留下"占了槽位但没登记"的状态。
 *
 * @returns {{ok:true, lease, slot, reservation, cap, reclaimed, ledgerReclaimed, ledgerBlocked}
 *          | {ok:false, held:true, reason, blocked?:boolean, cap?}}
 */
export function acquireAdmission({
  home, taskId, taskClass, label = null, cfg,
  slotNames = [], detached = false, probe = null, log = () => {}, allowSlotReclaim = true,
  auditPath = null,
}) {
  ensureState(home);
  const audit = auditPath ?? paths(home).reclaimLog;
  const probeImpl = probe ?? defaultProbe();

  // ① 进入全局准入临界区（mkdir 原子性；拿不到就本轮放弃，不做阻塞等待）
  const gate = tryAcquireSlot({ home, name: ADMISSION_SLOT, taskId, taskClass: "admission", cfg, label, log });
  if (!gate.lease) {
    return {
      ok: false, held: true, blocked: gate.blocked === true,
      reason: `准入临界区被其他进程占用：${gate.reason}`,
    };
  }

  let reservation = null;
  const rollback = (why) => {
    if (!reservation) return;
    const r = releaseReservation({ home, entry: reservation, reason: why, log });
    if (!r.ok && log) log(`回滚台账失败：${r.detail}`);
    reservation = null;
  };

  try {
    // ② 回收崩溃残留（证明不了已结束就不动，继续占名额）
    let reclaimed = { removed: [], blocked: [], entries: [] };
    try {
      reclaimed = reclaimStaleReservations({ home, cfg, probe: probeImpl, audit, log });
    } catch (err) {
      if (log) log(`回收残留台账时取证异常（按占用处理）：${err?.message ?? err}`);
      reclaimed = { removed: [], blocked: [], entries: readReservations(home) };
    }
    if (reclaimed.blocked.length && log) {
      log(`活动台账：${reclaimed.blocked.length} 条无法安全回收，继续占用名额（如 ${reclaimed.blocked[0].taskId}: ${reclaimed.blocked[0].detail}）`);
    }

    // ③ 全局构建并发上限判定（与写台账在同一个临界区，绝不超发）
    const capPlan = planGlobalConcurrency({ cfg, entries: reclaimed.entries, taskId, taskClass });
    if (!capPlan.admit) {
      return {
        ok: false, held: true, cap: capPlan,
        reason: capPlan.reason, ledgerBlocked: reclaimed.blocked,
      };
    }

    // ④ 先写台账（写不进去就拒绝，绝不去占槽位）
    reservation = createReservation({ taskId, taskClass, label, detached });
    try {
      writeReservation(home, reservation);
    } catch (err) {
      reservation = null;
      return {
        ok: false, held: true, blocked: true,
        reason: `台账登记失败，未占用槽位：${err?.message ?? err}`,
      };
    }

    // ⑤ 再抢分类槽位；失败即回滚台账（绝不"先占槽位再登记失败"）
    let lastReason = "";
    for (const name of slotNames) {
      const got = tryAcquireSlot({
        home, name, taskId, taskClass, cfg, label, log, noReclaim: !allowSlotReclaim,
      });
      if (got.lease) {
        return {
          ok: true, lease: got.lease, slot: name, reservation, cap: capPlan,
          reclaimed: got.reclaimed ?? null, ledgerReclaimed: reclaimed.removed,
          ledgerBlocked: reclaimed.blocked,
        };
      }
      lastReason = got.reason ?? "";
      if (got.blocked) {
        rollback(`槽位 ${name} 无法取证回收`);
        return {
          ok: false, held: true, blocked: true,
          reason: `槽位 ${name} 被占用且无法安全回收：${lastReason}`, ledgerBlocked: reclaimed.blocked,
        };
      }
    }
    rollback("没有可用槽位");
    return {
      ok: false, held: true, ledgerBlocked: reclaimed.blocked,
      reason: lastReason || `${taskClass} 槽位已满（${slotNames.length} 个槽位都不空闲）`,
    };
  } finally {
    // ⑥ 释放临界区（无论成功失败）
    gate.lease.release();
  }
}

/** status/doctor 用快照：台账条目 + 便宜的身份/心跳判断（不调 CIM）。 */
export function admissionSnapshot({ home, cfg, probe = null }) {
  const entries = readReservations(home);
  const probeImpl = probe ?? defaultProbe();
  const rows = entries.map((e) => {
    let verdict = null;
    try { verdict = classifyReservation(e, { cfg, probe: probeImpl }); } catch { /* 展示用，失败不影响台账 */ }
    const age = heartbeatAgeMs(e, Date.now());
    return {
      taskId: e.taskId, taskClass: e.taskClass, phase: e.phase ?? null,
      ownerPid: e.ownerPid ?? null, childPid: e.childPid ?? null, detached: e.detached === true,
      heartbeatAgeMs: Number.isFinite(age) ? Math.round(age) : null,
      state: verdict?.state ?? null, note: verdict?.detail ?? null,
    };
  });
  return {
    entries: rows, count: rows.length,
    // 全局构建并发只读视图（status/queue 用）：cap=null 表示未启用上限
    global: planGlobalConcurrency({ cfg, entries }),
  };
}
