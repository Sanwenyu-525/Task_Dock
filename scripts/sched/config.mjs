//! 构建调度器有效配置：默认值 → 仓库配置 → 机器配置 → 环境变量，后者覆盖前者。
//!
//! 配置来源（优先级从低到高）：
//!   1) DEFAULT_CONFIG（本文件，文档见 docs/BUILD_SCHEDULER.md）
//!   2) <repo>/build-sched.config.json（可入库，团队共享的调优值）
//!   3) <state home>/config.json（本机覆盖，不入库）
//!   4) 环境变量 TASKDOCK_SCHED_<KEY 的大写下划线形式>，例如 TASKDOCK_SCHED_GLOBAL_CONCURRENCY=2
//!
//! 只允许覆盖已知字段：未知字段一律报错而不是静默忽略，避免拼错配置却以为生效。

import { readFileSync } from "node:fs";
import { join } from "node:path";

// 字段含义见 docs/BUILD_SCHEDULER.md「配置」节。
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
  // 队列重评估间隔
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
  // ------------------------------------------------ 2026-11-16 已删除：全局内存预算（约束 B）
  // 原 systemReserveMb / recommendedSystemReserveMb / allowReserveBreach / budgetEnabled
  // 以及配套的危险授权（DANGER_AUTH_ENV）全部移除：准入不再读物理内存、不再按预计峰值记账。
  // 旧配置文件里残留这些键会被当作**未知字段**报出来（P1），不会被静默生效。
  // 崩溃残留台账的回收宽限：持有者已证明退出、且没有登记 childPid 时，再等这么久才回收
  // （登记了 childPid 的按「子进程是否仍存活」判定，与本宽限无关）
  reservationOrphanGraceMs: 180000,
  // 重型任务启动前执行一次既有的 scripts/build-guard.mjs precheck（磁盘/缓存）
  diskPrecheck: true,
  // 等价任务去重（只附加到正在运行的等价任务，从不复用已结束的结果）
  dedupe: true,
};

// 存在性/开关型字段（不是数值，不参与数值校验）
const BOOLEAN_KEYS = new Set(["diskPrecheck", "dedupe"]);

// 允许为 0 表示「不限」的字段
const ZERO_MEANS_UNLIMITED = new Set([
  "defaultWaitTimeoutMin", "defaultRunTimeoutMin", "agingStepMs", "reservationOrphanGraceMs",
]);
// 必须 >= 1 的字段
const MIN_ONE_KEYS = new Set([
  "heavyConcurrency", "mediumConcurrency", "lightConcurrency", "devConcurrency", "globalConcurrency",
  "pollMs", "heartbeatMs", "historyMaxEntries", "finishedRetentionMs",
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

  return { config, sources, problems };
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
 * 设计原则：**只报不改**。这里不改任何真实配置/阈值，也不替用户「修好」。
 * 2026-11-16 删除全局内存预算后，本函数不再有「预算关闭 / 侵占系统保留 / 峰值被改小」
 * 这类风险项，只保留与配置来源、未知字段、配置不可读相关的检查。
 *
 * @returns {Array<{level:"P0"|"P1"|"P2", key:string, text:string, current?:any, baseline?:any, source?:string, affectsRunning?:boolean}>}
 */
export function configRisks({ config, sources = [], problems = [], hasActiveReservations = false } = {}) {
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

  // ② 环境变量覆盖（高于机器配置，最容易「改了什么却查不到」）
  const envSource = sources.find((s) => s.kind === "env");
  if (envSource?.names?.length) {
    add("P1", "env",
      `环境变量覆盖了 ${envSource.names.length} 项配置：${envSource.names.join(", ")}` +
      "（优先级高于仓库/机器配置；只在当前进程有效，history 会记录来源链）",
      { current: envSource.names.length, baseline: 0, source: "环境变量" });
  }

  // ③ 未知字段（拼错即静默不生效，config 已报 problem，这里给 P1）
  for (const p of problems) {
    if (/未知字段/.test(String(p))) add("P1", "unknown", p, { source: "配置文件" });
  }

  return risks;
}

/** 分类 → 并发槽位数（槽位命名与准入共用同一份口径，避免两处数字漂移）。 */
export function concurrencyForClass(cfg, taskClass) {
  if (taskClass === "heavy") return Math.max(0, Number(cfg?.heavyConcurrency ?? 0));
  if (taskClass === "medium") return Math.max(0, Number(cfg?.mediumConcurrency ?? 0));
  if (taskClass === "light") return Math.max(0, Number(cfg?.lightConcurrency ?? 0));
  if (taskClass === "dev") return Math.max(0, Number(cfg?.devConcurrency ?? 0));
  return 0;
}
