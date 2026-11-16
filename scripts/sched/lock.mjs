//! 跨进程资源租约：全局构建互斥的真正实现。
//!
//! 原语：`mkdir` 是 NTFS/POSIX 上的原子操作（已存在即失败），因此「槽位目录」本身
//! 就是互斥体：`slots/heavy-1` 存在即代表重型构建正在运行，与进程、工作目录、终端无关。
//! 状态目录在 Git 公共目录下（见 state.mjs），所以主工作区与所有 linked worktree
//! 竞争的是同一组槽位——这正是「不同 Worktree 共享同一全局构建资源」的落点。
//!
//! 为什么不用「定时删锁文件」：
//!   - 持有者崩溃后目录仍在，这是**正确的**——旧构建可能还在跑；
//!   - 只有当「持有者身份被证明已消失」且「它启动的子进程树已确认终止」时才回收；
//!   - 身份 = (pid, 进程创建时间, 心跳)，单一 PID 不作为证据（Windows 会复用 PID）。
//!
//! 回收（reclaim）流程是原子的：先把 `slots/heavy-1` 改名为唯一的 `.reclaim-<nonce>`，
//! 竞争回收的两个进程只有一个能改名成功，另一个随即重新走 mkdir 竞争，因此不会出现
//! 「两个进程同时以为自己拿到锁」。
//!
//! 持有者存活但心跳超期（例如整机休眠/调试器暂停）：超过 hungReclaimMs 后按「挂起」回收，
//! 回收前必须先确认并终止它记录的子进程树，否则拒绝回收并继续等待（fail-closed）。

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, appendJsonLine, paths, readJson, rmDirQuiet, slotDir } from "./state.mjs";
import { isPidAlive, killTree, probeProcess, selfIdentity, verifyIdentity, waitForGone } from "./proc.mjs";

export const OWNER_FILE = "owner.json";
export const BEAT_FILE = "heartbeat";

function nonce() {
  return randomBytes(6).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function beatAgeMs(dir) {
  for (const name of [BEAT_FILE, OWNER_FILE]) {
    try {
      return Date.now() - statSync(join(dir, name)).mtimeMs;
    } catch { /* 试下一个 */ }
  }
  try { return Date.now() - statSync(dir).mtimeMs; } catch { return Number.POSITIVE_INFINITY; }
}

function normalizeCmd(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 命令行签名：去掉引号、统一斜杠、转小写、丢掉首个 token（可执行文件本体）与 cmd.exe 包装前缀。
 * 之所以丢首个 token：同一命令经不同路径启动会得到
 * `node D:/x/fake.mjs a` 与 `"C:\\nvm4w\\nodejs\\node.exe" D:\\x\\fake.mjs a`，参数部分才是可比部分。
 * .cmd 命令的真实进程是 `cmd.exe /d /s /c "chcp 65001>nul & npm.cmd run build"`，
 * 因此还要把 cmd.exe 的包装前缀一并剥掉，才能和记录里的 `npm.cmd run build` 比中。
 */
const WRAPPER_TOKEN = /^(\/d|\/s|\/c|\/q|chcp|65001>nul|&|>nul)$/;

export function cmdlineSignature(text) {
  const norm = String(text ?? "")
    .replace(/\\/g, "/")
    .replace(/["']/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return "";
  const tokens = norm.split(" ").filter(Boolean);
  if (tokens.length > 1) tokens.shift(); // 可执行文件本体
  while (tokens.length && WRAPPER_TOKEN.test(tokens[0])) tokens.shift();
  return tokens.join(" ");
}

function signaturesMatch(a, b) {
  const sa = cmdlineSignature(a);
  const sb = cmdlineSignature(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  if (sa.length >= 12 && sb.includes(sa)) return true;
  if (sb.length >= 12 && sa.includes(sb)) return true;
  return false;
}

/**
 * 终止「记录中属于本调度器的孤儿子进程树」。
 * 三条硬约束：
 *   1) 只有调度器自己 spawn 的进程才归本调度器处置（记录里有它的 pid + 命令行）；
 *   2) 动手前必须比对命令行签名——PID 可能已被系统复用，光看 pid 存活会误杀别人的进程；
 *   3) 任何一条证据缺失或对不上就**拒绝终止**（fail-closed），宁可卡住等人工/doctor 介入，
 *      也不做「未经授权终止其他会话进程」的事。
 */
export function reapOrphanChild({ child, taskId, audit, reason }) {
  if (!child || !Number.isInteger(child.pid)) {
    return { ok: true, detail: "记录中没有子进程，无需回收" };
  }
  const probe = probeProcess(child.pid, { fresh: true });
  if (!probe.alive) {
    return { ok: true, detail: `子进程 PID ${child.pid} 已不存在，无需终止` };
  }
  const recorded = child.commandLine;
  if (!normalizeCmd(recorded)) {
    return { ok: false, detail: `记录中缺少子进程命令行，无法确认 PID ${child.pid} 属于本任务，拒绝终止` };
  }
  const actual = probe.commandLine ?? "";
  if (!signaturesMatch(recorded, actual)) {
    return {
      ok: false,
      detail: `PID ${child.pid} 命令行与记录不符，拒绝终止（可能已被复用）\n  记录：${normalizeCmd(recorded).slice(0, 140)}\n  实际：${normalizeCmd(actual).slice(0, 140)}`,
    };
  }
  const killed = killTree(child.pid);
  const gone = killed.ok ? waitForGone(child.pid, 8000) : false;
  if (audit) {
    appendJsonLine(audit, {
      at: nowIso(), kind: "reap-orphan", taskId, pid: child.pid,
      reason, killed: killed.ok, gone, detail: killed.detail,
    });
  }
  if (!gone) {
    return { ok: false, detail: `子进程 PID ${child.pid} 仍存活，无法安全回收租约（${killed.detail}）` };
  }
  return { ok: true, detail: `已终止孤儿构建进程树 PID ${child.pid}（${reason}）` };
}

/**
 * 评估并（必要时）回收一个已存在的槽位目录。
 *
 * `allowHungReclaim` / `allowChildKill` 供**后台扫描**收紧边界：
 *   - 竞争路径（默认 true）：持有者存活但心跳停滞超过 hungReclaimMs 时按挂起回收；
 *     持有者已死但子进程树仍在跑时，比对命令行签名后终止它（这是既有契约）。
 *   - 后台扫描（false）：只回收「持有者已死 + 子进程已结束」的槽位，绝不主动终止
 *     任何仍在运行的构建进程，也绝不按"挂起"回收——那些留给竞争路径/doctor --reap。
 * @returns {{reclaimed:boolean, reason:string, detail?:string, blocked?:boolean}}
 */
function tryReclaim({
  dir, name, cfg, taskId, auditPath, log, allowHungReclaim = true, allowChildKill = true,
}) {
  const owner = readJson(join(dir, OWNER_FILE));
  const age = beatAgeMs(dir);
  const record = { at: nowIso(), kind: "reclaim-eval", slot: name, holderTask: owner?.taskId ?? null, beatAgeMs: Math.round(age), by: taskId };

  // 目录刚被创建但 owner.json 还没落地（崩溃窗口）：给一个极短的宽限，超时才按「空壳」处理
  if (!owner) {
    if (age < 3000) {
      return { reclaimed: false, reason: `槽位 ${name} 刚被创建（${Math.round(age)}ms），等待其登记元数据` };
    }
    if (isDirEmptyish(dir)) {
      const moved = renameSync(dir, `${dir}.reclaim-${nonce()}`);
      rmDirQuiet(moved);
      appendJsonLine(auditPath, { ...record, kind: "reclaim-orphan-dir", reason: "无 owner.json 的空壳槽位" });
      if (log) log(`回收无主槽位 ${name}（${Math.round(age)}ms 未见元数据）`);
      return { reclaimed: true, reason: "空壳槽位（无 owner.json）", holderTask: null };
    }
    return { reclaimed: false, blocked: true, reason: `槽位 ${name} 无 owner.json 且目录非空` };
  }

  const identity = verifyIdentity({ pid: owner.pid, startTime: owner.startTime ?? null, source: owner.startTimeSource });
  const holderLabel = `task=${owner.taskId ?? "?"} pid=${owner.pid} 心跳 ${Math.round(age)}ms 前`;

  if (identity.state === "unknown") {
    // 无法证明死亡就不回收（fail-closed）。心跳过期也不动，避免误抢活着的会话。
    return {
      reclaimed: false, blocked: true,
      reason: `无法确认槽位 ${name} 的持有者是否已退出（${identity.detail}）；心跳 ${Math.round(age)}ms 前。按占用中处理`,
    };
  }

  if (identity.state === "same" && age < cfg.hungReclaimMs) {
    return { reclaimed: false, reason: `槽位 ${name} 由存活进程持有（${holderLabel}），等待其释放` };
  }
  if (identity.state === "same" && !allowHungReclaim) {
    return {
      reclaimed: false, blocked: true,
      reason: `槽位 ${name} 的持有者仍存活但心跳停滞 ${Math.round(age)}ms（> ${cfg.hungReclaimMs}ms）；` +
        "后台扫描不按挂起回收，留待竞争路径或 doctor --reap 处置",
    };
  }

  const why = identity.state === "gone"
    ? `持有者已退出（${identity.detail}）`
    : `持有者存活但心跳停滞 ${Math.round(age)}ms（> ${cfg.hungReclaimMs}ms 挂起阈值）`;

  // 后台扫描的硬边界：只回收"旧构建也已经结束"的槽位。子进程还活着就拒绝回收，
  // 哪怕命令签名能对上也不杀——被动扫描不该影响任何正在进行的构建。
  if (!allowChildKill && owner.child && Number.isInteger(owner.child.pid) && isPidAlive(owner.child.pid)) {
    return {
      reclaimed: false, blocked: true,
      reason: `槽位 ${name}：${why}，但登记的构建子进程 PID ${owner.child.pid} 仍存活；` +
        "后台扫描不终止他人构建，留待竞争路径或 doctor --reap 处置",
    };
  }

  // 回收前必须确认旧构建进程树已经结束，否则会把「仍在跑的重型构建」和新任务叠在一起
  const orphan = reapOrphanChild({
    child: owner.child ?? null, taskId: owner.taskId ?? null, audit: auditPath, reason: `回收槽位 ${name}`,
  });
  if (!orphan.ok) {
    return {
      reclaimed: false, blocked: true,
      reason: `拒绝回收槽位 ${name}：${why}，但旧构建进程无法安全终止——${orphan.detail}`,
    };
  }

  const moved = `${dir}.reclaim-${nonce()}`;
  try {
    renameSync(dir, moved);
  } catch (err) {
    // 另一个进程抢先回收：不是错误，重新回主循环竞争 mkdir 即可
    return { reclaimed: false, reason: `槽位 ${name} 已被其他进程回收（${err?.code ?? err}），重新竞争` };
  }
  rmDirQuiet(moved);
  appendJsonLine(auditPath, { ...record, kind: "reclaimed", reason: why, orphan: orphan.detail });
  if (log) log(`回收槽位 ${name}：${why}；${orphan.detail}`);
  return { reclaimed: true, reason: why, detail: orphan.detail, holderTask: owner.taskId ?? null };
}

/** 准入临界区槽位名（与 admission.mjs 的 ADMISSION_SLOT 一致；在此处独立定义，避免循环依赖）。 */
const ADMISSION_SLOT_NAME = ".admission";

/**
 * 后台槽位扫描：回收「已经没人持有、却因为没有竞争者而永远不释放」的槽位。
 *
 * 背景（2026-11-15 实测）：回收此前只在**竞争同一个槽位**时才发生。于是调度进程崩溃后留下的
 * 槽位会一直挂着——本机实测 heavy-1 挂了 16 分钟、dev-1 挂了 2.5 小时；如果留下的是准入临界区
 * `slots/.admission`，**所有分类**的准入都会被它卡住，等待者只能干等到 `--wait-timeout` 超时。
 *
 * 保守边界（宁可漏收，不可误收）：
 *   - 心跳仍新鲜（< leaseTtlMs）→ 不取证直接跳过（避免每轮 CIM，也避免误判刚创建的槽位）；
 *   - 持有者身份无法确认（identity=unknown）→ 不动（fail-closed）；
 *   - 子进程仍存活 → 不动（后台扫描绝不终止任何正在运行的构建）；
 *   - 持有者存活但心跳停滞 → 不按挂起回收（留给竞争路径 / doctor --reap）。
 */
export function reapStaleSlots({ home, cfg, log = () => {}, limit = 4 }) {
  const dir = paths(home).slots;
  const audit = paths(home).reclaimLog;
  const reclaimed = [];
  const blocked = [];
  let scanned = 0;
  let names = [];
  try { names = readdirSync(dir); } catch { return { scanned: 0, reclaimed, blocked }; }

  for (const name of names) {
    if (name.includes(".reclaim-") || name.includes(".release-")) continue;
    if (name.startsWith(".") && name !== ADMISSION_SLOT_NAME) continue;
    const slotPath = join(dir, name);
    let st;
    try { st = statSync(slotPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const age = beatAgeMs(slotPath);
    // 心跳新鲜说明持有者大概率还在正常轮询：这一轮连取证都不做（CIM 是 200–400ms 的重操作）
    if (!(age > (cfg.leaseTtlMs ?? 45000))) continue;
    if (scanned >= limit) break;
    scanned += 1;
    let r;
    try {
      r = tryReclaim({
        dir: slotPath, name, cfg, taskId: "housekeeping-sweep", auditPath: audit, log,
        allowHungReclaim: false, allowChildKill: false,
      });
    } catch (err) {
      blocked.push({ slot: name, reason: `扫描异常：${err?.message ?? err}`, blocked: true });
      continue;
    }
    if (r.reclaimed) {
      reclaimed.push({ slot: name, reason: r.reason, detail: r.detail ?? null, holderTask: r.holderTask ?? null });
    } else {
      blocked.push({ slot: name, reason: r.reason, blocked: r.blocked === true });
    }
  }
  return { scanned, reclaimed, blocked };
}

function isDirEmptyish(dir) {
  try {
    const entries = readdirSync(dir).filter((n) => n !== OWNER_FILE && n !== BEAT_FILE && !n.startsWith("."));
    return entries.length === 0;
  } catch {
    return false; // 读不了就当非空，交给正常身份判定路径
  }
}

export class Lease {
  constructor({ dir, name, taskId, owner, auditPath }) {
    this.dir = dir;
    this.name = name;
    this.taskId = taskId;
    this.owner = owner;
    this.auditPath = auditPath;
    this.timer = null;
    this.released = false;
    this.ownerPath = join(dir, OWNER_FILE);
    this.beatPath = join(dir, BEAT_FILE);
  }

  /** 启动心跳。定时器 unref()，不会因为心跳阻止进程退出。 */
  startHeartbeat(intervalMs) {
    const beat = () => {
      if (this.released) return;
      const iso = nowIso();
      try {
        writeFileSync(this.beatPath, iso + "\n", "utf8");
        const t = new Date();
        utimesSync(this.beatPath, t, t);
        // 心跳同时刷新 owner.json 的 mtime，便于 use 侧仅凭 mtime 判断新鲜度
        utimesSync(this.ownerPath, t, t);
      } catch { /* 心跳失败不阻断构建；失效检测会自动退化为进程证据 */ }
    };
    beat();
    this.timer = setInterval(beat, Math.max(200, intervalMs));
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this;
  }

  /** 登记子进程身份（必须在 spawn 成功后立即调用，回收依赖它）。 */
  setChild(child) {
    this.owner.child = child;
    try {
      atomicWriteJson(this.ownerPath, this.owner);
    } catch { /* 记录失败时回收会退化为「拒绝回收」，不会误杀 */ }
  }

  setPhase(phase) {
    this.owner.phase = phase;
    try { atomicWriteJson(this.ownerPath, this.owner); } catch { /* ignore */ }
  }

  /** 释放租约；只在自己仍是持有者（nonce 相符）时删除。 */
  release() {
    if (this.released) return { ok: true, detail: "已释放" };
    this.released = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const current = readJson(this.ownerPath);
    if (!current || current.nonce !== this.owner.nonce) {
      return { ok: false, detail: `槽位 ${this.name} 已不属于本进程（nonce 不符），不删除` };
    }
    // Windows 下若目录内文件被其他进程短暂打开，删除可能失败：改名后重试，改名失败说明已被回收
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      return { ok: true, detail: "已删除槽位目录" };
    } catch (err) {
      try {
        renameSync(this.dir, `${this.dir}.release-${nonce()}`);
        rmDirQuiet(`${this.dir}.release-${nonce()}`);
        return { ok: true, detail: `删除失败（${err?.code ?? err}），已改名后清理` };
      } catch (err2) {
        if (this.auditPath) {
          appendJsonLine(this.auditPath, {
            at: nowIso(), kind: "release-failed", slot: this.name, taskId: this.taskId,
            detail: String(err2?.code ?? err2),
          });
        }
        return { ok: false, detail: `槽位 ${this.name} 释放失败：${err2?.code ?? err2}` };
      }
    }
  }
}

/**
 * 非阻塞竞争一个命名槽位：能拿到就返回租约，拿不到立刻返回原因（由调用方继续排队）。
 * 阻塞式等待不适合本调度器——等待期间必须持续做优先级复评与取消检查。
 *
 * `noReclaim: true` 表示本轮不做"持有者是否已死"的取证（调用方按 reclaimProbeMs 自己节流，
 * 取证要查系统进程，不能每轮都做）。用于准入临界区的合并申请路径。
 * @returns {{lease:Lease} | {held:true, reason:string, blocked?:boolean}}
 */
export function tryAcquireSlot({ home, name, taskId, taskClass, cfg, label, log, noReclaim = false }) {
  const dir = slotDir(home, name);
  const p = paths(home);
  let reclaimedInfo = null;
  const attempt = () => {
    try { mkdirSync(dir); return true; } catch (err) {
      if (err?.code === "EEXIST") return false;
      try { mkdirSync(p.slots, { recursive: true }); } catch { /* ignore */ }
      throw err;
    }
  };

  let created;
  try {
    created = attempt();
  } catch (err) {
    return { held: true, blocked: true, reason: `无法创建槽位目录 ${dir}：${err?.code ?? err}` };
  }

  if (!created) {
    if (noReclaim) {
      return { held: true, reason: `槽位 ${name} 已被占用（本轮未做持有者取证）` };
    }
    const evalResult = tryReclaim({ dir, name, cfg, taskId, auditPath: p.reclaimLog, log });
    if (!evalResult.reclaimed) {
      return { held: true, blocked: evalResult.blocked === true, reason: evalResult.reason };
    }
    reclaimedInfo = { holderTask: evalResult.holderTask ?? null, reason: evalResult.reason, detail: evalResult.detail ?? null };
    try { created = attempt(); } catch (err) {
      return { held: true, blocked: true, reason: `回收后仍无法创建槽位 ${dir}：${err?.code ?? err}` };
    }
    if (!created) return { held: true, reason: `槽位 ${name} 被其他进程抢占，重新排队` };
  }

  const owner = {
    taskId, taskClass: taskClass ?? null, slot: name,
    pid: process.pid, nonce: nonce(), startedAt: nowIso(),
    label: label ?? null, host: process.env.COMPUTERNAME ?? null, child: null,
  };
  const self = selfIdentity();
  owner.startTime = self.startTime; // 由 uptime 推导（不查 PowerShell），比对时按 2s 容差
  owner.startTimeSource = self.source;
  try {
    atomicWriteJson(join(dir, OWNER_FILE), owner);
  } catch (err) {
    rmDirQuiet(dir);
    return { held: true, blocked: true, reason: `槽位登记失败：${err?.message ?? err}` };
  }
  const lease = new Lease({ dir, name, taskId, owner, auditPath: p.reclaimLog });
  lease.startHeartbeat(cfg.heartbeatMs);
  return { lease, reclaimed: reclaimedInfo };
}

export function sleep(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, Math.max(1, ms));
}

/** 槽位快照（status/doctor 用）。verify=true 时做进程身份校验（较慢）。 */
export function snapshotSlots(home, { verify = false } = {}) {
  const dir = paths(home).slots;
  const out = [];
  let names = [];
  try {
    if (!statSync(dir).isDirectory()) return out;
    names = readdirSync(dir);
  } catch { return out; }
  for (const name of names) {
    if (name.startsWith(".") || name.includes(".reclaim-") || name.includes(".release-")) continue;
    const slotPath = join(dir, name);
    let st;
    try { st = statSync(slotPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const owner = readJson(join(slotPath, OWNER_FILE));
    const age = beatAgeMs(slotPath);
    const alive = owner && Number.isInteger(owner.pid) ? isPidAlive(owner.pid) : null;
    let identity = null;
    if (verify && owner && Number.isInteger(owner.pid)) {
      identity = verifyIdentity({ pid: owner.pid, startTime: owner.startTime ?? null, source: owner.startTimeSource });
    }
    out.push({
      slot: name,
      taskId: owner?.taskId ?? null,
      taskClass: owner?.taskClass ?? null,
      label: owner?.label ?? null,
      pid: owner?.pid ?? null,
      startTime: owner?.startTime ?? null,
      startedAt: owner?.startedAt ?? null,
      heartbeatAgeMs: Number.isFinite(age) ? Math.round(age) : null,
      pidAlive: alive,
      identity: identity?.state ?? null,
      identityDetail: identity?.detail ?? null,
      child: owner?.child ?? null,
      stale: Number.isFinite(age) ? age > 45000 : true,
      dir: slotPath,
    });
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot));
}

/** 构造槽位名：<class>-<序号>。轻量有 2 个槽位，其余 1 个。 */
export function slotNames(taskClass, concurrency) {
  const names = [];
  for (let i = 1; i <= concurrency; i++) names.push(`${taskClass}-${i}`);
  return names;
}
