//! 构建调度器有效配置：默认值 → 仓库配置 → 机器配置 → 环境变量，后者覆盖前者。
//!
//! 配置来源（优先级从低到高）：
//!   1) DEFAULT_CONFIG（本文件，文档见 docs/BUILD_SCHEDULER.md）
//!   2) <repo>/build-sched.config.json（可入库，团队共享的调优值）
//!   3) <state home>/config.json（本机覆盖，不入库）
//!   4) 环境变量 TASKDOCK_SCHED_<KEY 的大写下划线形式>，例如 TASKDOCK_SCHED_HEAVY_MIN_AVAIL_MB=4096
//!
//! 只允许覆盖已知字段：未知字段一律报错而不是静默忽略，避免拼错配置却以为生效。

import { readFileSync } from "node:fs";
import { join } from "node:path";

// 数值单位为 MB / 毫秒 / 次数，字段含义见 docs/BUILD_SCHEDULER.md「配置」节。
export const DEFAULT_CONFIG = {
  // 并发槽位：重型槽位同时就是全局构建互斥锁
  heavyConcurrency: 1,
  mediumConcurrency: 1,
  lightConcurrency: 2,
  // 开发服务器（dev 类）独立槽位：不占一次性构建锁
  devConcurrency: 2,
  // 跨分类全局构建并发上限（约束 C，2026-11-16）：heavy/medium/light 合计**同时运行**的构建
  // 不得超过该值；第 N+1 个构建进队列，任一构建结束即自动释放名额（租约/预留随任务收尾删除）。
  // dev 常驻服务由 devConcurrency 独立管理、**不计入**该上限（沿用「dev 不占一次性构建锁」的契约）。
  globalConcurrency: 3,
  // 内存采样与队列重评估间隔（只用于观测：写入 history / status，不参与准入）
  memorySampleMs: 3000,
  pollMs: 1000,
  // 租约心跳与失效判定
  heartbeatMs: 3000,
  leaseTtlMs: 45000,
  // 槽位被占时，每隔该毫秒数才做一次「持有者是否已死」的身份取证（取证要查系统进程，不能每轮都做）
  reclaimProbeMs: 3000,
  hungReclaimMs: 180000,
  // 交给 cargo 的并行编码数（通过 CARGO_BUILD_JOBS 注入，未设置时生效）
  cargoJobs: 2,
  // 默认等待超时（分钟）；0 = 不限（仍会持续输出等待提示）
  defaultWaitTimeoutMin: 20,
  // 默认运行超时（分钟）；0 = 不限
  defaultRunTimeoutMin: 0,
  // 优先级老化：每等待该毫秒数，有效优先级提升一级
  agingStepMs: 300000,
  // 单任务日志上限（MB），超出后停止写入并追加截断标记
  logMaxMb: 32,
  // history.jsonl 保留条数，超出时压缩
  historyMaxEntries: 500,
  // 已结束任务记录在队列目录里的保留时长（等价任务附加方要读结果）
  finishedRetentionMs: 60000,
  // 各分类的预计内存峰值（MB）：用于准入下限与等待原因解释
  estimateHeavyMb: 6000,
  estimateMediumMb: 3000,
  estimateLightMb: 800,
  // 跨分类全局预算（见 docs/BUILD_SCHEDULER.md 4.2 约束 B，2026-11-15 起是唯一的活动约束）：
  //   budgetMb = max(0, 物理内存总量 - systemReserveMb)   ← 硬上限，**不被**任何任务峰值抬高
  // 只看活动任务预留之和（不读 freemem，也不看可用内存读数）。
  // systemReserveMb 是给操作系统/常驻应用/文件缓存留的安全垫（16GB 机器上预算约 12.6GB）；
  // 0 = 用满物理内存（仅用于实验）。
  // 任务预计峰值大于该预算时会被判为**不可准入**（不是排队），见 budgetWarning()。
  systemReserveMb: 3072,
  // 系统保留的**推荐基线**：低于它意味着安全垫被主动缩小（预算随之变大）。
  // 未经危险授权（见 DANGER_AUTH_ENV）时，有效配置会 fail-closed 回到该基线；
  // 已授权时保留申报值，但 status/doctor/history 必须显著记录「实际减少的安全余量」。
  recommendedSystemReserveMb: 3072,
  // 【危险开关，默认关闭】突破「物理内存 - systemReserveMb」这条硬安全边界：
  //   开启后预算被抬到「最大分类预计峰值」，让超过预算的重型任务也能跑，
  //   但会侵占系统保留的安全垫（OOM/卡顿风险），status 会显著告警。
  //   只应在确认机器能承受、且明确知晓风险时临时打开。
  allowReserveBreach: false,
  // 关掉只保留分类槽位并发 + 优先级排队（故障回退用，正常情况必须保持 true）
  budgetEnabled: true,
  // 崩溃残留预留的回收宽限：持有者已证明退出、且没有登记 childPid 时，再等这么久才回收
  // （登记了 childPid 的按「子进程是否仍存活」判定，与本宽限无关）
  reservationOrphanGraceMs: 180000,
  // 重型任务启动前执行一次既有的 scripts/build-guard.mjs precheck（磁盘/缓存）
  diskPrecheck: true,
  // 等价任务去重（只附加到正在运行的等价任务，从不复用已结束的结果）
  dedupe: true,
};

// 存在性/开关型字段（不是数值，不参与数值校验）
const BOOLEAN_KEYS = new Set([
  "diskPrecheck", "dedupe", "budgetEnabled", "allowReserveBreach",
]);

/**
 * 危险操作统一授权：**一个**环境变量，多个逗号分隔的令牌。
 *
 * 背景：2026-11-15 19:22 本机 `config.json` 被外部会话改成 `budgetEnabled=false` + 门槛 1 MB，
 * 调度器当时只是「照配置执行」，`status` 一句「预算已关闭」既没有告警也没拦住任何任务。
 * 从本轮起，凡是**削弱安全边界**的配置都必须带显式、可审计的授权令牌：
 *   - `budget-off`     允许 `budgetEnabled=false`（否则忽略并 fail-closed 回 true）
 *   - `reserve-breach` 允许 `allowReserveBreach=true`（否则忽略并回 false）
 *   - `reserve-lower`  允许 `systemReserveMb` 低于推荐基线（否则有效值回到基线）
 *
 * 授权只对**当前进程**有效，必须在命令前显式设置，不会写回配置；`status`/`doctor`/`history`
 * 会记录令牌与生效结果，供事后审计。
 */
export const DANGER_AUTH_ENV = "TASKDOCK_SCHED_DANGER_AUTH";
export const DANGER_TOKENS = {
  BUDGET_OFF: "budget-off",
  RESERVE_BREACH: "reserve-breach",
  RESERVE_LOWER: "reserve-lower",
};

export function parseDangerTokens(raw) {
  const tokens = String(raw ?? "")
    .split(/[,|;\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return new Set(tokens);
}

/** 明显异常的估算值/系统保留（不是「调优」，而是被改坏）：低于这些值时即使有授权也要报 P0。 */
export const SANITY_FLOORS = {
  estimateHeavyMb: 2000,
  estimateMediumMb: 600,
  estimateLightMb: 200,
  systemReserveMb: 0,
};

// 允许为 0 表示「不限」的字段
const ZERO_MEANS_UNLIMITED = new Set([
  "defaultWaitTimeoutMin", "defaultRunTimeoutMin", "agingStepMs",
  "systemReserveMb", "reservationOrphanGraceMs",
]);
// 必须 >= 1 的字段
const MIN_ONE_KEYS = new Set([
  "heavyConcurrency", "mediumConcurrency", "lightConcurrency", "devConcurrency", "globalConcurrency",
  "memorySampleMs", "pollMs", "heartbeatMs", "historyMaxEntries", "finishedRetentionMs",
]);

export function configEnvName(key) {
  return "TASKDOCK_SCHED_" + key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
}

function readJsonFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `${path} 不是 JSON 对象` };
    }
    return { value: parsed };
  } catch (err) {
    if (err && err.code === "ENOENT") return { missing: true };
    return { error: `${path} 读取失败：${err?.message ?? err}` };
  }
}

function validate(key, value, source) {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true" || value === "1") return { ok: true, value: true };
    if (value === "false" || value === "0") return { ok: true, value: false };
    return { ok: false, error: `${source}: ${key} 必须是布尔值（当前 ${JSON.stringify(value)}）` };
  }
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) {
    return { ok: false, error: `${source}: ${key} 必须是数字（当前 ${JSON.stringify(value)}）` };
  }
  if (num < 0) return { ok: false, error: `${source}: ${key} 不能为负数（当前 ${num}）` };
  if (MIN_ONE_KEYS.has(key) && num < 1) {
    return { ok: false, error: `${source}: ${key} 必须 >= 1（当前 ${num}）` };
  }
  if (!ZERO_MEANS_UNLIMITED.has(key) && !MIN_ONE_KEYS.has(key) && num === 0) {
    return { ok: false, error: `${source}: ${key} 必须 > 0（当前 0）` };
  }
  if (!Number.isInteger(num) && !["logMaxMb"].includes(key)) {
    // 只允许整数字段；logMaxMb 允许小数
    return { ok: false, error: `${source}: ${key} 必须是整数（当前 ${num}）` };
  }
  return { ok: true, value: num };
}

/**
 * 计算有效配置。
 * @returns {{config: object, sources: Array<{path:string, applied:string[]}|{env:string}> , problems: string[]}}
 */
export function loadConfig({ repoRoot, stateHome, env = process.env } = {}) {
  const config = { ...DEFAULT_CONFIG };
  const sources = [];
  const problems = [];

  const candidates = [];
  if (repoRoot) candidates.push({ path: join(repoRoot, "build-sched.config.json"), label: "仓库配置" });
  if (stateHome) candidates.push({ path: join(stateHome, "config.json"), label: "机器配置" });

  for (const cand of candidates) {
    const read = readJsonFile(cand.path);
    if (read.missing) continue;
    if (read.error) { problems.push(read.error); continue; }
    const applied = [];
    for (const [key, raw] of Object.entries(read.value)) {
      if (!(key in DEFAULT_CONFIG)) {
        problems.push(`${cand.label} ${cand.path}: 未知字段 ${key}（可用字段见 docs/BUILD_SCHEDULER.md）`);
        continue;
      }
      const v = validate(key, raw, `${cand.label} ${cand.path}`);
      if (!v.ok) { problems.push(v.error); continue; }
      config[key] = v.value;
      applied.push(key);
    }
    sources.push({ kind: "file", label: cand.label, path: cand.path, applied });
  }

  const appliedEnv = [];
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const name = configEnvName(key);
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const v = validate(key, raw, `环境变量 ${name}`);
    if (!v.ok) { problems.push(v.error); continue; }
    config[key] = v.value;
    appliedEnv.push(name);
  }
  if (appliedEnv.length) sources.push({ kind: "env", names: appliedEnv });

  // ---------------------------------------------------------------- 危险授权（fail-closed）
  const tokens = parseDangerTokens(env[DANGER_AUTH_ENV]);
  const danger = {
    authEnv: DANGER_AUTH_ENV,
    tokens: [...tokens],
    budgetOffRequested: false,
    budgetOffAuthorized: false,
    reserveBreachRequested: false,
    reserveBreachAuthorized: false,
    reserveLowerRequested: false,
    reserveLowerAuthorized: false,
    reserveDeclaredMb: Number(config.systemReserveMb),
    reserveBaselineMb: Number(config.recommendedSystemReserveMb),
    blocked: [],
  };

  // ① budgetEnabled=false 只凭配置文件不生效
  if (config.budgetEnabled === false) {
    danger.budgetOffRequested = true;
    if (tokens.has(DANGER_TOKENS.BUDGET_OFF)) {
      danger.budgetOffAuthorized = true;
    } else {
      config.budgetEnabled = true;
      danger.blocked.push("budgetEnabled=false 缺少危险授权，已按 fail-closed 忽略");
      problems.push(
        `${DANGER_AUTH_ENV} 未含 "${DANGER_TOKENS.BUDGET_OFF}"：配置里的 budgetEnabled=false 已` +
        "被**忽略**（继续执行全局预算）。如确需故障排障，请显式设置该授权令牌，事后可在 history 审计。",
      );
    }
  }

  // ② allowReserveBreach=true 同样需要授权
  if (config.allowReserveBreach === true) {
    danger.reserveBreachRequested = true;
    if (tokens.has(DANGER_TOKENS.RESERVE_BREACH)) {
      danger.reserveBreachAuthorized = true;
    } else {
      config.allowReserveBreach = false;
      danger.blocked.push("allowReserveBreach=true 缺少危险授权，已按 fail-closed 关闭");
      problems.push(
        `${DANGER_AUTH_ENV} 未含 "${DANGER_TOKENS.RESERVE_BREACH}"：allowReserveBreach=true 已被忽略` +
        "（不会侵占系统保留）。",
      );
    }
  }

  // ③ systemReserveMb 低于推荐基线：未经授权时有效值回到基线（不写回配置文件）
  const declaredReserve = Number(config.systemReserveMb);
  const baselineReserve = Number(config.recommendedSystemReserveMb);
  if (Number.isFinite(declaredReserve) && Number.isFinite(baselineReserve) && declaredReserve < baselineReserve) {
    danger.reserveLowerRequested = true;
    if (tokens.has(DANGER_TOKENS.RESERVE_LOWER)) {
      danger.reserveLowerAuthorized = true;
    } else {
      config.systemReserveMb = baselineReserve;
      danger.blocked.push(
        `systemReserveMb=${declaredReserve} 低于推荐基线 ${baselineReserve} 且未授权，` +
        `有效值已按 fail-closed 回到 ${baselineReserve}`,
      );
      problems.push(
        `systemReserveMb=${declaredReserve} 低于推荐基线 ${baselineReserve}：未经 ${DANGER_AUTH_ENV}=` +
        `"${DANGER_TOKENS.RESERVE_LOWER}" 授权时，有效预算按基线收紧；减少安全余量必须显式确认并留痕。`,
      );
    }
  }

  // 内部元数据用不可枚举属性挂在 config 上：不污染 `config` 命令输出与深比较，
  // 但 budget/status/doctor/history 可以直接读到（computeBudget 只接收 cfg）。
  const meta = {
    danger,
    sourcesSummary: describeSources(sources),
    sourceOf: sourceOfKeys(sources),
  };
  Object.defineProperty(config, "__schedMeta", { value: meta, enumerable: false, configurable: true });
  Object.defineProperty(config, "__budgetOffAuthorized", { value: danger.budgetOffAuthorized, enumerable: false });
  Object.defineProperty(config, "__dangerTokens", { value: [...tokens], enumerable: false });

  return { config, sources, problems, danger };
}

/** 人类可读的配置来源链（写入 history / status / doctor）。 */
export function describeSources(sources = []) {
  if (!sources.length) return "内置默认值";
  return sources
    .map((s) => (s.kind === "env" ? `env(${s.names.join(",")})` : `${s.label ?? "配置"}:${s.path}`))
    .join(" → ");
}

/** key → 覆盖来源（file label:path / env:NAME / 内置默认值）。 */
export function sourceOfKeys(sources = []) {
  const map = new Map();
  for (const s of sources) {
    if (s.kind === "env") {
      for (const name of s.names ?? []) {
        for (const key of Object.keys(DEFAULT_CONFIG)) {
          if (configEnvName(key) === name) map.set(key, `env:${name}`);
        }
      }
    } else {
      for (const key of s.applied ?? []) map.set(key, `${s.label ?? "配置"}:${s.path}`);
    }
  }
  return map;
}

/**
 * 配置风险清单（纯函数）：`doctor` 用它报 P0/P1，`status` 用它显示一行摘要。
 *
 * 设计原则：**只报不改**。这里不改任何真实配置/阈值，也不替用户「修好」；除了
 * `loadConfig` 的 fail-closed（关预算/侵占保留/降低保留必须有危险授权）之外，
 * 异常值一律以风险项形式暴露，交由人决定。
 *
 * @returns {Array<{level:"P0"|"P1"|"P2", key:string, text:string, current?:any, baseline?:any, source?:string, affectsRunning?:boolean}>}
 */
export function configRisks({
  config, defaults = DEFAULT_CONFIG, danger = null, sources = [], problems = [], hasActiveReservations = false,
} = {}) {
  const risks = [];
  const src = sourceOfKeys(sources);
  const srcOf = (key) => src.get(key) ?? "内置默认值";
  const add = (level, key, text, extra = {}) => risks.push({
    level, key, text, source: srcOf(key), affectsRunning: hasActiveReservations, ...extra,
  });

  // ① 配置文件读不出来 / 不是 JSON：最容易被忽略的「静默失效」
  for (const p of problems) {
    if (/读取失败|不是 JSON 对象/.test(String(p))) add("P0", "config", `配置文件不可用：${p}`, { source: "文件" });
  }

  // ② 全局预算被关闭（只有带授权令牌才会真的生效）
  if (config.budgetEnabled === false) {
    add("P0", "budgetEnabled",
      "全局预算已被**显式关闭**（危险授权生效）：跨分类预留不再受「物理 - 系统保留」约束，" +
      "并发任务可能把系统打到 OOM；本次任务在 history 里会标记 budget off",
      { current: false, baseline: true, reason: "budget-off 授权" });
  } else if (danger?.budgetOffRequested) {
    add("P1", "budgetEnabled",
      `配置曾要求关闭全局预算，但缺少 ${DANGER_AUTH_ENV}="${DANGER_TOKENS.BUDGET_OFF}"，已按 fail-closed 忽略`,
      { current: true, baseline: true });
  }

  // ②-1（2026-11-15 删除）实时可用内存门槛（约束 A）已从调度器移除：
  // 不再有「内存不足 → 等待」这回事，因此这里也不再需要记录"门槛被关闭"的 P1 风险。

  // ③ 允许侵占系统保留
  if (config.allowReserveBreach === true) {
    add("P1", "allowReserveBreach",
      "allowReserveBreach 已开启（危险授权生效）：预算可被抬到最大分类峰值，系统保留安全垫会被侵占",
      { current: true, baseline: false, reason: "reserve-breach 授权" });
  } else if (danger?.reserveBreachRequested) {
    add("P1", "allowReserveBreach",
      `配置曾要求开启 allowReserveBreach，但缺少 ${DANGER_AUTH_ENV}="${DANGER_TOKENS.RESERVE_BREACH}"，已被关闭`,
      { current: false, baseline: false });
  }

  // ④ 系统保留低于推荐基线：显示实际减少了多少安全余量
  const declaredReserve = Number.isFinite(Number(danger?.reserveDeclaredMb))
    ? Number(danger.reserveDeclaredMb) : Number(config.systemReserveMb);
  const baselineReserve = Number.isFinite(Number(danger?.reserveBaselineMb))
    ? Number(danger.reserveBaselineMb) : Number(defaults.recommendedSystemReserveMb ?? config.systemReserveMb);
  if (declaredReserve < baselineReserve) {
    const reduced = baselineReserve - declaredReserve;
    const authorized = danger?.reserveLowerAuthorized === true;
    add(declaredReserve <= 0 ? "P0" : "P1", "systemReserveMb",
      `系统保留申报值 ${declaredReserve} MB 低于推荐基线 ${baselineReserve} MB（安全余量减少 ${reduced} MB）` +
      (authorized
        ? `；已凭 ${DANGER_AUTH_ENV}="${DANGER_TOKENS.RESERVE_LOWER}" 授权生效`
        : "；未经授权，有效值已 fail-closed 回到基线"),
      { current: declaredReserve, baseline: baselineReserve });
  }

  // ⑤ 预计峰值/系统保留被改到明显异常（例如 1 MB）：不是调优，是坏配置
  for (const [key, floor] of Object.entries(SANITY_FLOORS)) {
    const value = Number(config[key]);
    if (!Number.isFinite(value) || value < floor) {
      add(key === "systemReserveMb" ? "P0" : "P1", key,
        `${key}=${config[key]} 低于安全下限 ${floor}（默认 ${defaults[key] ?? "-"}）：` +
        "预算台账会按过小的峰值记账，可能导致超卖或侵占系统保留",
        { current: config[key], baseline: defaults[key] ?? floor });
    }
  }

  // ⑥ 环境变量覆盖（高于机器配置，最容易「改了什么却查不到」）
  const envSource = sources.find((s) => s.kind === "env");
  if (envSource?.names?.length) {
    add("P1", "env",
      `环境变量覆盖了 ${envSource.names.length} 项配置：${envSource.names.join(", ")}` +
      "（优先级高于仓库/机器配置；只在当前进程有效，history 会记录来源链）",
      { current: envSource.names.length, baseline: 0, source: "环境变量" });
  }

  // ⑦ 未知字段（拼错即静默不生效，config 已报 problem，这里给 P1）
  for (const p of problems) {
    if (/未知字段/.test(String(p))) add("P1", "unknown", p, { source: "配置文件" });
  }

  return risks;
}
