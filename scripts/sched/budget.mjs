//! 跨分类全局构建预算：把「物理内存总量」切成一个**所有分类共用**的资源池。
//!
//! 为什么需要它（整改前的真实缺口）：
//!   旧实现里「准入 = 本分类槽位还有空 + 本任务自己的内存门槛达标」。不同分类各自读同一份
//!   （3 秒缓存的）`os.freemem()` 快照，各自都合格，合计却可能超卖：Heavy 看到 7GB 起 6000MB
//!   构建，Medium 同时看到同一份 7GB 又起 3000MB，两个都放行、合计 9000MB。
//!
//! 本模块只负责**约束 B**（约束 A 的实时可用内存门槛仍在 mem.mjs，两者互相独立、互不重复扣减）：
//!   预算上限 budgetMb = max(0, totalMb - systemReserveMb)        ← 硬上限，不被任务峰值抬高
//!   放行 ⇔ Σ活动任务预留 + 本任务预计峰值 ≤ budgetMb
//!
//! 2026-11-15 修正（上一轮遗留的缺陷）：旧公式是 `max(totalMb - systemReserveMb, 最大分类预计峰值)`。
//! 在 8GB 机器上 `8192 - 3072 = 5120MB < Heavy 预计 6000MB`，旧公式会把预算**抬到 6000MB**，
//! 于是"系统保留的 3GB 安全垫"被静默侵蚀，正好破坏了本预算要保护的东西。现在：
//!   - 预算严格等于 `totalMb - systemReserveMb`，单个任务峰值更大时判为**不可准入**并给出原因；
//!   - 想突破保留边界只能显式打开 `allowReserveBreach`（默认关闭），此时返回值用
//!     `reserveBreached/breachMb` 明确标注，status 会显著提示风险。
//! 这里**不读** freemem：freemem 已经反映运行中进程的真实占用，如果再用它减一遍预计峰值，
//! 同一份资源就被扣了两次，16GB 机器上第二个任务会永久起不来。
//!
//! 原子性（见 docs/BUILD_SCHEDULER.md 5.7）：
//!   「预算预留」和「分类槽位占用」必须在同一个跨进程临界区里完成——否则会出现
//!   「先占槽位、预算不够 → 槽位被白占 20 分钟」或「两个进程都以为自己拿到了最后一份预算」。
//!   临界区直接复用 lock.mjs 的槽位租约（`slots/.admission`：mkdir 原子性 + 心跳 + 身份取证），
//!   不另造一套锁体系，也不引入常驻守护进程。

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { appendJsonLine, atomicWriteJson, ensureState, paths, readJson, readJsonDir } from "./state.mjs";
import { cmdlineSignature, tryAcquireSlot } from "./lock.mjs";
import { isPidAlive, listProcesses, selfIdentity, verifyIdentity } from "./proc.mjs";
import { estimateForClass, formatMb } from "./mem.mjs";

/** 准入临界区的槽位名（`slots/.admission`；以 `.` 开头，不会被槽位统计/状态表当成构建槽位）。 */
export const ADMISSION_SLOT = ".admission";
/** 预留台账生命周期阶段。 */
export const PHASES = ["queued", "starting", "running", "releasing"];

const MB = 1024 * 1024;
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- 预算公式

/** 各类里最大的预计峰值：用于解释「哪一类任务在这台机器上装不下」，**不再**用作预算下限。 */
export function maxEstimateMb(cfg) {
  return Math.max(
    cfg.estimateHeavyMb, cfg.estimateMediumMb, cfg.estimateLightMb,
    cfg.estimateMediumMb, // dev 类沿用 medium 的峰值
    0,
  );
}

/** 生成预算相关的风险/不可准入提示文案（纯函数，status / queue / 文档共用一套说法）。 */
export function budgetWarning({ reserveExhausted, reserveBreached, peakExceedsBudget, reserveMb, totalMb, hardLimitMb, budgetMb, peakEstimateMb }) {
  if (reserveExhausted) {
    return `系统保留 ${formatMb(reserveMb)} ≥ 物理内存 ${formatMb(totalMb)}：全局预算为 0，任何分类都无法准入（请调小 systemReserveMb）`;
  }
  if (reserveBreached) {
    return `⚠ 已显式开启 allowReserveBreach：预算 ${formatMb(budgetMb)} 高于「物理 - 系统保留」硬上限 ${formatMb(hardLimitMb)}，` +
      `系统保留的 ${formatMb(reserveMb)} 安全垫已被侵占 ${formatMb(budgetMb - hardLimitMb)}，OOM/卡顿风险由使用者承担`;
  }
  if (reserveMb <= 0 && totalMb > 0) {
    // systemReserveMb=0 是"把安全垫整块取消"的显式配置（不是任务峰值抬高预算，但同样是风险）。
    return `⚠ systemReserveMb=0：预算等于物理内存 ${formatMb(totalMb)}，没有给操作系统/常驻应用留安全垫，并行任务可能把系统打到 OOM`;
  }
  if (peakExceedsBudget) {
    return `本机预算 ${formatMb(budgetMb)}（物理 ${formatMb(totalMb)} - 系统保留 ${formatMb(reserveMb)}）` +
      ` 小于最大分类预计峰值 ${formatMb(peakEstimateMb)}：该类任务在本机**无法准入**（需要更大物理内存，或显式调小 systemReserveMb）`;
  }
  return null;
}

/**
 * 计算全局预算上限（纯函数，便于单测）。
 *
 * 公式：`budgetMb = max(0, totalMb - systemReserveMb)`。
 * 这是**硬上限**：任何任务的预计峰值都不会把它抬高（旧实现的夹取会把 8GB 机器的预算从 5GB
 * 抬到 6GB，等于偷偷吃掉系统保留的安全边界）。任务峰值超过它时由 planAdmission 明确拒绝。
 *
 * 唯一例外是显式配置 `allowReserveBreach=true`（默认关闭）：预算被抬到「最大分类预计峰值」
 * 以保证该类任务仍能跑，返回值带 `reserveBreached/breachMb/warning` 供 status 显著提示。
 */
export function computeBudget({ cfg, totalMb }) {
  const reserve = Number.isFinite(Number(cfg.systemReserveMb)) ? Number(cfg.systemReserveMb) : 0;
  const total = Number.isFinite(Number(totalMb)) ? Number(totalMb) : 0;
  const raw = Math.round(total - reserve);
  const hardLimitMb = Math.max(0, raw);
  const peakMb = maxEstimateMb(cfg);
  const breachAllowed = cfg.allowReserveBreach === true;
  const budgetMb = breachAllowed ? Math.max(hardLimitMb, peakMb) : hardLimitMb;
  const breachMb = Math.max(0, budgetMb - hardLimitMb);
  const reserveBreached = breachAllowed && breachMb > 0;
  const peakExceedsBudget = peakMb > budgetMb;
  const reserveExhausted = raw <= 0;
  const warning = budgetWarning({
    reserveExhausted, reserveBreached, peakExceedsBudget,
    reserveMb: reserve, totalMb: total, hardLimitMb, budgetMb, peakEstimateMb: peakMb,
  });
  return {
    enabled: cfg.budgetEnabled !== false,
    totalMb: total,
    reserveMb: reserve,
    rawMb: raw,
    // 安全上限（物理 - 系统保留）：永不因任务峰值而提高
    hardLimitMb,
    // 生效预算：只有 allowReserveBreach=true 时才可能高于 hardLimitMb
    budgetMb,
    peakEstimateMb: peakMb,
    breachAllowed,
    reserveBreached,
    breachMb,
    peakExceedsBudget,
    reserveExhausted,
    // 兼容上一轮的展示字段：clamped 现在**只**代表"已显式允许突破保留边界"
    clamped: reserveBreached,
    clampFloorMb: peakMb,
    warning,
  };
}

export function sumReserved(entries = []) {
  let total = 0;
  for (const e of entries) {
    const v = Number(e?.reservedMb);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/**
 * 约束 B 判定（纯函数）：只看「活动任务预留之和 + 本任务预计峰值」与预算上限的关系。
 * 不读 freemem，不重复扣减正在运行任务的真实占用。
 *
 * @returns {{admit:boolean, reason:string, budgetMb:number, reservedMb:number, availableMb:number, estimateMb:number}}
 */
export function planAdmission({ budget, entries = [], taskId = null, estimateMb }) {
  const est = Number.isFinite(Number(estimateMb)) ? Math.max(0, Math.round(Number(estimateMb))) : 0;
  // 同一 taskId 的旧预留是「重入」而不是「另一个任务」：先排除，避免自己和自己抢预算
  const others = entries.filter((e) => e && e.taskId !== taskId);
  const reservedMb = sumReserved(others);
  const base = {
    budgetMb: budget.budgetMb,
    hardLimitMb: Number.isFinite(Number(budget.hardLimitMb)) ? Number(budget.hardLimitMb) : budget.budgetMb,
    reserveMb: Number.isFinite(Number(budget.reserveMb)) ? Number(budget.reserveMb) : 0,
    reservedMb,
    estimateMb: est,
    availableMb: Math.max(0, budget.budgetMb - reservedMb),
    reserveBreached: budget.reserveBreached === true,
    infeasible: false,
  };
  if (!budget.enabled) {
    return {
      ...base, admit: true,
      reason: `全局预算已关闭（budgetEnabled=false），仅按实时可用内存门槛准入`,
    };
  }
  if (est > budget.budgetMb) {
    // 单个任务的预计峰值就大于本机预算：不是"排队"，而是"这台机器装不下"。
    // 旧实现会用夹取把预算抬到峰值来放行，等于侵占系统保留的安全边界——现在明确判为不可准入。
    const why = budget.reserveExhausted
      ? `系统保留 ${formatMb(base.reserveMb)} ≥ 物理内存 ${formatMb(budget.totalMb)}，全局预算为 0`
      : `本机全局预算上限 ${formatMb(budget.budgetMb)}（物理 ${formatMb(budget.totalMb)} - 系统保留 ${formatMb(base.reserveMb)}）`;
    return {
      ...base, admit: false, infeasible: true,
      reason: `任务预计峰值 ${formatMb(est)} > ${why}：本机装不下，不会自我放行（不是排队问题，等待也不会放行）`,
      hint: `需要更大物理内存，或显式调小 systemReserveMb；` +
        `allowReserveBreach（默认关闭）可强制抬高预算，但会侵占系统保留的安全边界并在 status 里显著告警`,
    };
  }
  const need = reservedMb + est;
  const budgetText = `预算 ${formatMb(budget.budgetMb)}（物理 ${formatMb(budget.totalMb)} - 系统保留 ${formatMb(base.reserveMb)}）` +
    `${base.reserveBreached ? `〔⚠ 已突破保留边界 ${formatMb(budget.breachMb ?? 0)}〕` : ""}`;
  if (need <= budget.budgetMb) {
    return {
      ...base, admit: true,
      reason: `全局预算充足：已预留 ${formatMb(reservedMb)} + 本次 ${formatMb(est)} ≤ ${budgetText}`,
    };
  }
  return {
    ...base, admit: false,
    reason: `全局构建预算不足：已预留 ${formatMb(reservedMb)}（${others.length} 个活动任务）+ 本次预计 ${formatMb(est)}` +
      ` = ${formatMb(need)} > ${budgetText}`,
    hint: `预算由物理内存减去系统保留决定，不会被任务峰值抬高；` +
      `单个任务确实需要更多内存时，用 --estimate-mb 如实声明，或等已预留任务结束后重试`,
  };
}

// ---------------------------------------------------------------- 预留台账读写

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

/** 创建预留记录（不落盘，调用方在临界区内写）。 */
export function createReservation({ taskId, taskClass, reservedMb, label = null, detached = false }) {
  const self = selfIdentity();
  return {
    taskId, taskClass,
    reservedMb: Math.round(reservedMb),
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
 * 释放预留：只有「身份完全相符」才删。
 * 校验 (ownerPid, ownerStartTime, nonce)——单看 PID 会在系统复用 PID 后误删别人的预留。
 */
export function releaseReservation({ home, entry, reason = "任务结束", log = null }) {
  if (!entry) return { ok: true, detail: "没有预留需要释放" };
  const path = reservationPath(home, entry.taskId);
  const current = readJson(path);
  if (!current) return { ok: true, detail: "预留记录已不存在（可能已被安全回收）" };
  const mismatch = [];
  if (current.nonce !== entry.nonce) mismatch.push("nonce 不符");
  if (Number(current.ownerPid) !== Number(entry.ownerPid)) mismatch.push(`ownerPid 不符（记录 ${current.ownerPid}，本进程 ${entry.ownerPid}）`);
  if (String(current.ownerStartTime ?? "") !== String(entry.ownerStartTime ?? "")) mismatch.push("进程创建时间不符");
  if (mismatch.length) {
    if (log) log(`预留 ${entry.taskId} 不归本进程（${mismatch.join("、")}），拒绝删除`);
    return { ok: false, detail: `预留不归本进程（${mismatch.join("、")}），拒绝删除` };
  }
  try { unlinkSync(path); } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, detail: "预留记录已不存在" };
    return { ok: false, detail: `删除预留失败：${err?.code ?? err}` };
  }
  return { ok: true, detail: `已释放预留 ${formatMb(Number(entry.reservedMb) || 0)}（${reason}）` };
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
 * 判断一条崩溃残留预留能否回收（纯函数 + 可注入证据提供者，便于单测穷举边界）。
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
  const base = { taskId: entry.taskId, taskClass: entry.taskClass, reservedMb: entry.reservedMb, heartbeatAgeMs: age };

  if (!Number.isInteger(entry.ownerPid)) {
    return { ...base, reclaimable: false, state: "unknown", detail: "预留记录缺少持有进程 PID（按占用处理，需 doctor --reap 处置）" };
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
      detail: "预留由 detached 子进程持有且未登记 childPid，无法证明脱离控制台的构建已退出（需 doctor --reap）",
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

/** 真正删除一条崩溃残留预留（回收动作）；写审计行。 */
function reclaimReservationFile({ home, entry, audit, detail, log }) {
  const path = reservationPath(home, entry.taskId);
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, detail: "已被其他进程回收" };
    if (audit) {
      appendJsonLine(audit, { at: nowIso(), kind: "reservation-reclaim-failed", taskId: entry.taskId, detail: String(err?.code ?? err) });
    }
    return { ok: false, detail: `删除预留失败：${err?.code ?? err}` };
  }
  if (audit) {
    appendJsonLine(audit, {
      at: nowIso(), kind: "reservation-reclaimed", taskId: entry.taskId, taskClass: entry.taskClass,
      reservedMb: entry.reservedMb, ownerPid: entry.ownerPid, childPid: entry.childPid ?? null, reason: detail,
    });
  }
  if (log) log(`回收崩溃残留预留 ${entry.taskId}（${formatMb(Number(entry.reservedMb) || 0)}）：${detail}`);
  return { ok: true, detail };
}

/**
 * 回收所有可安全回收的残留预留，并返回"回收之后"的台账（供预算判定用）。
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
      blocked.push({ taskId: entry.taskId, state: "probe-error", detail: `取证异常：${err?.message ?? err}`, reservedMb: entry.reservedMb });
      continue;
    }
    if (!verdict.reclaimable) {
      if (verdict.state !== "owner-alive") {
        blocked.push({ taskId: entry.taskId, state: verdict.state, detail: verdict.detail, reservedMb: entry.reservedMb });
      }
      continue;
    }
    const r = reclaimReservationFile({ home, entry, audit, detail: verdict.detail, log });
    if (r.ok) removed.push({ taskId: entry.taskId, taskClass: entry.taskClass, reservedMb: entry.reservedMb, detail: verdict.detail });
    else blocked.push({ taskId: entry.taskId, state: "reclaim-failed", detail: r.detail, reservedMb: entry.reservedMb });
  }
  return { removed, blocked, entries: readReservations(home) };
}

// ---------------------------------------------------------------- 原子准入

/**
 * 跨进程原子准入：预算预留 + 分类槽位，在同一个 `slots/.admission` 临界区里完成。
 *
 * 顺序是硬约束（不得颠倒）：
 *   预算判定 → 写预留 → 拿槽位；任何一步失败都回滚，绝不留下"占了槽位但没预算"的状态。
 *
 * @returns {{ok:true, lease, slot, reservation, budget, plan, reclaimed, ledgerReclaimed}
 *          | {ok:false, held:true, reason, blocked?:boolean, budget, plan?}}
 */
export function acquireAdmission({
  home, taskId, taskClass, estimateMb = null, label = null, cfg, totalMb,
  slotNames = [], detached = false, probe = null, log = () => {}, allowSlotReclaim = true,
  auditPath = null,
}) {
  ensureState(home);
  const budget = computeBudget({ cfg, totalMb });
  const est = Number.isFinite(Number(estimateMb)) ? Math.round(Number(estimateMb)) : estimateForClass(cfg, taskClass);
  const audit = auditPath ?? paths(home).reclaimLog;
  const probeImpl = probe ?? defaultProbe();

  // ① 进入全局准入临界区（mkdir 原子性；拿不到就本轮放弃，不做阻塞等待）
  const gate = tryAcquireSlot({ home, name: ADMISSION_SLOT, taskId, taskClass: "admission", cfg, label, log });
  if (!gate.lease) {
    return {
      ok: false, held: true, blocked: gate.blocked === true, budget,
      reason: `准入临界区被其他进程占用：${gate.reason}`,
    };
  }

  let reservation = null;
  const rollback = (why) => {
    if (!reservation) return;
    const r = releaseReservation({ home, entry: reservation, reason: why, log });
    if (!r.ok && log) log(`回滚预留失败：${r.detail}`);
    reservation = null;
  };

  try {
    // ② 回收崩溃残留（证明不了已结束就不动，继续占用预算）
    let reclaimed = { removed: [], blocked: [], entries: [] };
    try {
      reclaimed = reclaimStaleReservations({ home, cfg, probe: probeImpl, audit, log });
    } catch (err) {
      if (log) log(`回收残留预留时取证异常（按占用处理）：${err?.message ?? err}`);
      reclaimed = { removed: [], blocked: [], entries: readReservations(home) };
    }
    if (reclaimed.blocked.length && log) {
      log(`预留台账：${reclaimed.blocked.length} 条无法安全回收，继续占用预算（如 ${reclaimed.blocked[0].taskId}: ${reclaimed.blocked[0].detail}）`);
    }

    // ③ 约束 B 判定
    const plan = planAdmission({ budget, entries: reclaimed.entries, taskId, estimateMb: est });
    if (!plan.admit) {
      return { ok: false, held: true, budget, plan, reason: plan.reason, ledgerBlocked: reclaimed.blocked };
    }

    // ④ 先写预留（写不进去就拒绝，绝不去占槽位）
    reservation = createReservation({ taskId, taskClass, reservedMb: plan.estimateMb, label, detached });
    try {
      writeReservation(home, reservation);
    } catch (err) {
      reservation = null;
      return {
        ok: false, held: true, blocked: true, budget, plan,
        reason: `预留登记失败，未占用槽位：${err?.message ?? err}`,
      };
    }

    // ⑤ 再抢分类槽位；失败即回滚预留（绝不"先占槽位再预留失败"）
    let lastReason = "";
    for (const name of slotNames) {
      const got = tryAcquireSlot({
        home, name, taskId, taskClass, cfg, label, log, noReclaim: !allowSlotReclaim,
      });
      if (got.lease) {
        return {
          ok: true, lease: got.lease, slot: name, reservation, budget, plan,
          reclaimed: got.reclaimed ?? null, ledgerReclaimed: reclaimed.removed,
          ledgerBlocked: reclaimed.blocked,
        };
      }
      lastReason = got.reason ?? "";
      if (got.blocked) {
        rollback(`槽位 ${name} 无法取证回收`);
        return {
          ok: false, held: true, blocked: true, budget, plan,
          reason: `槽位 ${name} 被占用且无法安全回收：${lastReason}`, ledgerBlocked: reclaimed.blocked,
        };
      }
    }
    rollback("没有可用槽位");
    return {
      ok: false, held: true, budget, plan, ledgerBlocked: reclaimed.blocked,
      reason: lastReason || `${taskClass} 槽位已满（${slotNames.length} 个槽位都不空闲）`,
    };
  } finally {
    // ⑥ 释放临界区（无论成功失败）
    gate.lease.release();
  }
}

/** status/doctor 用快照：台账条目 + 便宜的身份/心跳判断（不调 CIM）。 */
export function budgetSnapshot({ home, cfg, totalMb, probe = null }) {
  const budget = computeBudget({ cfg, totalMb });
  const entries = readReservations(home);
  const probeImpl = probe ?? defaultProbe();
  const rows = entries.map((e) => {
    let verdict = null;
    try { verdict = classifyReservation(e, { cfg, probe: probeImpl }); } catch { /* 展示用，失败不影响台账 */ }
    return {
      taskId: e.taskId, taskClass: e.taskClass, reservedMb: e.reservedMb, phase: e.phase ?? null,
      ownerPid: e.ownerPid ?? null, childPid: e.childPid ?? null, detached: e.detached === true,
      heartbeatAgeMs: Number.isFinite(heartbeatAgeMs(e, Date.now())) ? Math.round(heartbeatAgeMs(e, Date.now())) : null,
      state: verdict?.state ?? null, note: verdict?.detail ?? null,
    };
  });
  const reservedMb = sumReserved(entries);
  return {
    ...budget, reservedMb, availableMb: Math.max(0, budget.budgetMb - reservedMb),
    entries: rows, count: rows.length,
  };
}
