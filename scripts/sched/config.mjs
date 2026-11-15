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
  // 开发服务器（dev 类）独立槽位：不占一次性构建锁，但受内存准入约束
  devConcurrency: 2,
  // 各分类的准入内存下限（可用物理内存，MB）
  heavyMinAvailMb: 6144,
  mediumMinAvailMb: 4096,
  lightMinAvailMb: 2560,
  // 可用内存读数再扣的安全余量（默认 0：与规范给定阈值严格一致，需要更保守时自行调高）
  safetyReserveMb: 0,
  // 因内存不足等待过之后，恢复准入需要的额外滞回量
  hysteresisMb: 1024,
  // 内存采样与队列重评估间隔
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
  // 跨分类全局预算（见 docs/BUILD_SCHEDULER.md 4.2 约束 B）：
  //   budgetMb = max(0, 物理内存总量 - systemReserveMb)   ← 硬上限，**不被**任何任务峰值抬高
  // 与「实时可用内存门槛」（约束 A，用 os.freemem）互相独立：本轮只看活动任务预留之和，
  // 不读 freemem，避免同一份资源被扣两次。systemReserveMb 是给操作系统/常驻应用/文件缓存
  // 留的安全垫（16GB 机器上预算约 12.6GB）；0 = 用满物理内存（仅用于实验）。
  // 任务预计峰值大于该预算时会被判为**不可准入**（不是排队），见 budgetWarning()。
  systemReserveMb: 3072,
  // 【危险开关，默认关闭】突破「物理内存 - systemReserveMb」这条硬安全边界：
  //   开启后预算被抬到「最大分类预计峰值」，让超过预算的重型任务也能跑，
  //   但会侵占系统保留的安全垫（OOM/卡顿风险），status 会显著告警。
  //   只应在确认机器能承受、且明确知晓风险时临时打开。
  allowReserveBreach: false,
  // 关掉只保留约束 A（故障回退用，正常情况必须保持 true）
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
const BOOLEAN_KEYS = new Set(["diskPrecheck", "dedupe", "budgetEnabled", "allowReserveBreach"]);
// 允许为 0 表示「不限」的字段
const ZERO_MEANS_UNLIMITED = new Set([
  "defaultWaitTimeoutMin", "defaultRunTimeoutMin", "safetyReserveMb", "agingStepMs",
  "systemReserveMb", "reservationOrphanGraceMs",
]);
// 必须 >= 1 的字段
const MIN_ONE_KEYS = new Set([
  "heavyConcurrency", "mediumConcurrency", "lightConcurrency", "devConcurrency",
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

  // 交叉字段一致性：内存滞回量不应大到永不恢复；并发槽位与内存下限的极端组合给出提示性警告
  if (config.hysteresisMb >= config.heavyMinAvailMb) {
    problems.push(
      `hysteresisMb=${config.hysteresisMb} 不小于 heavyMinAvailMb=${config.heavyMinAvailMb}：` +
      "内存回落后重型任务几乎无法恢复准入，请调小滞回量",
    );
  }

  return { config, sources, problems };
}
