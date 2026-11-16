//! 进程证据工具：判断「记录里的那个进程」是否还活着。
//!
//! 为什么要 pid + 创建时间：Windows 会复用 PID，仅凭 `tasklist` 里存在同一 PID 无法证明
//! 锁/任务仍属于原持有者。这里把 (pid, startTime) 作为身份，pid 相同但开始时间不同即视为
//! 「原进程已退出、PID 被复用」。
//!
//! 性能约束：`process.kill(pid, 0)` 是原生调用（微秒级），作为热路径的存在性探测；
//! 需要开始时间/CIM 查询时才用 PowerShell（约 200–400ms），只在争用/回收/诊断时调用。
//! PowerShell 不可用或查询失败时返回 `unknown`，调用方必须按「无法确认存活」处理（fail-closed）。

import { spawnSync } from "node:child_process";

const psCache = new Map(); // pid -> {at:ms, value:{startTime:string|null, commandLine:string|null, name:string|null, workingSetBytes:number|null}}
const PS_CACHE_MS = 1000;

function runPowerShell(script, timeout = 20000) {
  const attempts = ["pwsh", "powershell"];
  for (const exe of attempts) {
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout, windowsHide: true,
    });
    if (r.error && r.error.code === "ENOENT") continue;
    if (r.status === 0) return { ok: true, stdout: r.stdout || "" };
    return { ok: false, stderr: (r.stderr || "").trim(), status: r.status };
  }
  return { ok: false, stderr: "找不到 pwsh/powershell" };
}

/** 进程存在性（原生、便宜）。返回 true/false；权限不足时抛错由调用方按 unknown 处理。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    if (err && err.code === "EPERM") return true; // 存在但无权限探测
    return true; // 未知错误按「可能存活」处理，避免误判死亡而回收
  }
}

/**
 * CIM 失败时的回退取证：只用 `Get-Process` 取存在性 + 创建时间（拿不到命令行）。
 *
 * 为什么需要：`verifyIdentity` 依赖 CIM 的 StartTime 来排除 PID 复用。实测出现过
 * 「PID 存在，但无法读取创建时间（CIM 查询失败）」——此时回收按 fail-closed 拒绝，
 * 等待者被卡到超时。CIM（WMI）偶发不可用时，`Get-Process` 往往仍然可用。
 *
 * 注意：读不到（null）**不等于**已退出，这里只返回 null 交由调用方按 unknown 处理；
 * 「不存在」的结论永远只由 `isPidAlive()` 给出，避免把权限不足误判成进程已死。
 */
function probeViaGetProcess(pid) {
  const r = runPowerShell(
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    `if ($p) { [pscustomobject]@{ pid = ${pid}; ` +
    `startTime = $p.StartTime.ToUniversalTime().ToString('o'); name = $p.ProcessName; ` +
    `workingSet = $p.WorkingSet64 } | ConvertTo-Json -Compress } else { 'null' }`,
  );
  if (!r.ok) return null;
  const text = r.stdout.trim();
  if (!text || text === "null") return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  return {
    known: true,
    alive: true,
    startTime: parsed.startTime ?? null,
    commandLine: null,
    name: parsed.name ?? null,
    workingSetBytes: typeof parsed.workingSet === "number" ? parsed.workingSet : null,
  };
}

/**
 * 查询单个进程的 CIM 详情（带 1s 缓存）。
 * @returns {{known:boolean, alive:boolean, startTime:string|null, commandLine:string|null, name:string|null, workingSetBytes:number|null}}
 */
export function probeProcess(pid, { fresh = false } = {}) {
  const unknown = { known: false, alive: isPidAlive(pid), startTime: null, commandLine: null, name: null, workingSetBytes: null };
  if (!Number.isInteger(pid) || pid <= 0) return { ...unknown, alive: false };
  const cached = psCache.get(pid);
  if (!fresh && cached && Date.now() - cached.at < PS_CACHE_MS) return cached.value;

  const r = runPowerShell(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
    `if ($p) { ` +
    `  $t = $null; try { $t = (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch {}; ` +
    `  [pscustomobject]@{ ` +
    `    pid = ${pid}; startTime = $t; name = $p.Name; ` +
    `    commandLine = $p.CommandLine; workingSet = $p.WorkingSetSize ` +
    `  } | ConvertTo-Json -Compress } else { 'null' }`,
  );
  if (!r.ok) {
    // CIM 不可用时退回 Get-Process：拿到创建时间就能排除 PID 复用；拿不到仍是 unknown（fail-closed）
    const fb = probeViaGetProcess(pid);
    const value = fb ?? unknown;
    psCache.set(pid, { at: Date.now(), value });
    return value;
  }
  const text = r.stdout.trim();
  if (text === "null" || text === "") {
    const value = { ...unknown, alive: false, known: true };
    psCache.set(pid, { at: Date.now(), value });
    return value;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return unknown; }
  const value = {
    known: true,
    alive: true,
    startTime: parsed.startTime ?? null,
    commandLine: parsed.commandLine ?? null,
    name: parsed.name ?? null,
    workingSetBytes: typeof parsed.workingSet === "number" ? parsed.workingSet : null,
  };
  // CIM 给不出创建时间时再补一次 Get-Process：否则 verifyIdentity 只能回 unknown，
  // 崩溃残留的槽位就会一直卡着（实测过这种情况）
  if (!value.startTime) {
    const fb = probeViaGetProcess(pid);
    if (fb?.startTime) value.startTime = fb.startTime;
  }
  psCache.set(pid, { at: Date.now(), value });
  return value;
}

/**
 * 自己的身份：pid + 创建时间。
 * 刻意**不查 PowerShell**（单次 ~1s，会让每个构建提交都多等一秒）：
 * `process.uptime()` 直接给出本进程已运行时长，据此反推创建时间，
 * 精度足以排除 PID 复用（比对时用 2s 容差）。
 */
export function selfIdentity() {
  const created = new Date(Date.now() - process.uptime() * 1000);
  return { pid: process.pid, startTime: created.toISOString(), source: "uptime" };
}

// uptime 推导的创建时间与 CIM 的 StartTime 之间允许的误差
const UPTIME_TOLERANCE_MS = 2000;

/**
 * 校验「记录的身份」是否仍是同一个进程。
 * @param {{pid:number, startTime?:string|null, source?:string}} identity
 * @param {{fresh?:boolean, probe?:Function}} [opts] `probe` 仅用于单测注入（默认走真实 CIM 查询）
 * @returns {{state:'same'|'gone'|'unknown', detail:string}}
 *
 * 2026-11-15 修复（第二轮）：原来 `probe.known && probe.alive && probe.startTime === null`
 * 会一路掉到最后的 `gone`（"PID 已被复用"），而"读不到创建时间"根本**证明不了** PID 被复用。
 * 这个假阴性会连锁两件事：等价任务去重被跳过（同一构建跑两遍）、崩溃回收把**活着的**构建的
 * 槽位/名额判成可回收（并发超卖）。现在这种情形返回 `unknown`，由调用方按 fail-closed 处理。
 */
export function verifyIdentity(identity, opts = {}) {
  const probeOf = (pid) => (typeof opts.probe === "function" ? opts.probe(pid, opts) : probeProcess(pid, opts));
  if (!identity || !Number.isInteger(identity.pid)) {
    return { state: "gone", detail: "记录中没有进程身份（pid）" };
  }
  if (!isPidAlive(identity.pid)) return { state: "gone", detail: `PID ${identity.pid} 已不存在` };
  if (!identity.startTime) {
    // 没有记录开始时间：无法排除 PID 复用，保守返回 unknown（不据此回收）
    const probe = probeOf(identity.pid);
    return {
      state: "unknown",
      detail: `PID ${identity.pid} 存在，但记录缺少创建时间，无法排除 PID 复用` +
        (probe.known ? `（当前进程 ${probe.name ?? "?"}，开始于 ${probe.startTime ?? "未知"}）` : ""),
    };
  }
  const probe = probeOf(identity.pid);
  if (!probe.known) {
    return { state: "unknown", detail: `PID ${identity.pid} 存在，但无法读取创建时间（CIM 查询失败）` };
  }
  if (!probe.alive) return { state: "gone", detail: `PID ${identity.pid} 查询结果为不存在` };
  // 「进程在、但读不到开始时间」= 证据不足，不是"被复用"
  if (!probe.startTime) {
    return {
      state: "unknown",
      detail: `PID ${identity.pid} 存在，但读不到创建时间（无法排除 PID 复用），按无法确认存活处理`,
    };
  }
  if (probe.startTime === identity.startTime) {
    return { state: "same", detail: `PID ${identity.pid} 仍是创建于 ${identity.startTime} 的原进程` };
  }
  if (identity.source === "uptime") {
    const a = Date.parse(identity.startTime);
    const b = Date.parse(probe.startTime);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= UPTIME_TOLERANCE_MS) {
      return { state: "same", detail: `PID ${identity.pid} 创建时间吻合（差 ${Math.abs(a - b)}ms，容差 ${UPTIME_TOLERANCE_MS}ms）` };
    }
  }
  return {
    state: "gone",
    detail: `PID ${identity.pid} 已被复用：记录创建时间 ${identity.startTime}，当前进程创建时间 ${probe.startTime ?? "未知"}`,
  };
}

/** 收集本机进程快照（一次 CIM 查询拿多个字段），供开发服务器扫描使用。 */
export function listProcesses({ names = [] } = {}) {
  const filter = names.length
    ? names.map((n) => `Name='${String(n).replace(/'/g, "''")}'`).join(" OR ")
    : null;
  const r = runPowerShell(
    `$items = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue` +
    (filter ? ` -Filter "${filter}"` : "") +
    ` | Select-Object ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, CreationDate; ` +
    `@($items) | ConvertTo-Json -Compress -Depth 3`,
    30000,
  );
  if (!r.ok) return { ok: false, error: r.stderr || "CIM 查询失败", rows: [] };
  const text = r.stdout.trim();
  if (!text) return { ok: true, rows: [] };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "CIM 输出无法解析", rows: [] }; }
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((p) => ({
    pid: Number(p.ProcessId),
    parentPid: Number(p.ParentProcessId),
    name: p.Name ?? "",
    commandLine: p.CommandLine ?? "",
    workingSetBytes: typeof p.WorkingSetSize === "number" ? p.WorkingSetSize : null,
    creationDate: p.CreationDate ?? null,
  }));
  return { ok: true, rows };
}

/** 列出 LISTEN 状态的端口与所属 PID（用于开发服务器端口冲突检测）。 */
export function listListeners() {
  const r = runPowerShell(
    `try { @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ` +
    `Select-Object LocalAddress, LocalPort, OwningProcess) | ConvertTo-Json -Compress -Depth 3 } ` +
    `catch { 'null' }`,
    30000,
  );
  if (!r.ok) return { ok: false, error: r.stderr || "Get-NetTCPConnection 失败", rows: [] };
  const text = r.stdout.trim();
  if (!text || text === "null") return { ok: true, rows: [] };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "监听端口输出无法解析", rows: [] }; }
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((x) => ({
    address: x.LocalAddress,
    port: Number(x.LocalPort),
    pid: Number(x.OwningProcess),
  }));
  return { ok: true, rows };
}

/**
 * 终止整棵进程树（taskkill /T /F）。只允许用于调度器自己启动的子进程，
 * 调用方必须是租约回收路径，并且先比对命令行，确认目标确是记录中的构建进程。
 * @returns {{ok:boolean, detail:string}}
 */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, detail: "无效 PID" };
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (r.status === 0) return { ok: true, detail: out || "已终止" };
  // 128/1 常见于「进程已不存在」，此时视为成功（目标已消失）
  if (/not found|找不到|没有运行|no running instance/i.test(out)) {
    return { ok: true, detail: `${out}（进程已不存在）` };
  }
  return { ok: false, detail: out || `taskkill 退出码 ${r.status}` };
}

/** 轮询等待进程消失，最多 timeoutMs。 */
export function waitForGone(pid, timeoutMs = 5000, intervalMs = 200) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!isPidAlive(pid)) return true;
    sleepSync(intervalMs);
  }
  return !isPidAlive(pid);
}

// 同步 sleep：仅在回收/等待进程消失的短路径中使用（不用于并发控制）
function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}
