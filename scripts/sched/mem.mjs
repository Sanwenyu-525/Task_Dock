//! 真实可用物理内存采样（**仅用于观测**：写入 history / status 展示，不参与任何准入判定）。
//!
//! 2026-11-15：原先的「实时可用内存门槛」（约束 A：门槛 = max(分类下限, 预计峰值) + 滞回）
//! 已按用户要求**整体删除**。当前调度器只有两条约束：
//!   1) 分类槽位并发（heavy/medium 各 1、light/dev 各 2）；
//!   2) 跨分类全局预算（reservations 台账，见 budget.mjs）。
//! 可用内存读数保留下来，因为它对事后复盘 OOM 仍然有用。
//!
//! 采样：`os.freemem()` 在 Windows 上取 `GlobalMemoryStatusEx().ullAvailPhys`
//! （可用物理内存，含待机列表），`os.totalmem()` 取 `ullTotalPhys`。
//! 两者都是原生调用（微秒级），不需要起 PowerShell 子进程，因此 3 秒采样间隔对
//! 调度器自身开销可以忽略。
//!
//! 模拟（仅用于验收极端场景，**禁止**靠真实耗内存压测）：
//!   TASKDOCK_SCHED_SIM_FILE=<文件>        每轮重读，文件内容支持 `avail_mb=3000` 或裸数字
//!   TASKDOCK_SCHED_SIM_AVAIL_MB=3000      固定可用内存
//! 模拟值在所有输出里都显式标注 `(模拟)`，避免把模拟结论当成真实测量。

import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

const MB = 1024 * 1024;

function parseSimFile(path) {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!text) return null;
    const kv = /avail_mb\s*=\s*([0-9.]+)/i.exec(text);
    if (kv) return Number(kv[1]);
    const bare = Number(text);
    return Number.isFinite(bare) ? bare : null;
  } catch { return null; }
}

/**
 * 读取一次内存状态。
 * @returns {{availMb:number, totalMb:number, simulated:boolean, source:string, at:string}}
 */
export function readMemory(env = process.env) {
  const totalMb = Math.round(totalmem() / MB);
  const simFile = env.TASKDOCK_SCHED_SIM_FILE;
  const simFixed = env.TASKDOCK_SCHED_SIM_AVAIL_MB;

  if (simFile && simFile.trim() !== "") {
    const v = parseSimFile(simFile);
    if (v !== null) {
      return {
        availMb: Math.max(0, Math.round(v)), totalMb, simulated: true,
        source: `sim-file:${simFile}`, at: new Date().toISOString(),
      };
    }
    // 模拟文件存在但读不出来：继续用真实值，但把原因带在 source 里便于排障
    return {
      availMb: Math.round(freemem() / MB), totalMb, simulated: false,
      source: `real(freemem; 模拟文件不可解析 ${simFile})`, at: new Date().toISOString(),
    };
  }
  if (simFixed !== undefined && simFixed !== "") {
    const v = Number(simFixed);
    if (Number.isFinite(v)) {
      return {
        availMb: Math.max(0, Math.round(v)), totalMb, simulated: true,
        source: "sim-env:TASKDOCK_SCHED_SIM_AVAIL_MB", at: new Date().toISOString(),
      };
    }
  }
  return {
    availMb: Math.round(freemem() / MB), totalMb, simulated: false,
    source: "real(os.freemem = ullAvailPhys)", at: new Date().toISOString(),
  };
}

/**
 * 带采样间隔缓存的采样器：同一进程内每 intervalMs 最多读一次系统调用，
 * 并保留最近 samples 条（固定上限，不增长）供诊断使用。
 */
export function createMemorySampler({ intervalMs, env = process.env, keep = 20 }) {
  let last = null;
  const history = [];
  return {
    current(force = false) {
      const now = Date.now();
      if (!force && last && now - last.atMs < intervalMs) return last.mem;
      const mem = readMemory(env);
      last = { atMs: now, mem };
      history.push({ at: mem.at, availMb: mem.availMb, simulated: mem.simulated });
      while (history.length > keep) history.shift();
      return mem;
    },
    history() { return history.slice(); },
  };
}

export function estimateForClass(cfg, taskClass) {
  if (taskClass === "heavy") return cfg.estimateHeavyMb;
  if (taskClass === "medium") return cfg.estimateMediumMb;
  if (taskClass === "dev") return cfg.estimateMediumMb;
  return cfg.estimateLightMb;
}

export function concurrencyForClass(cfg, taskClass) {
  if (taskClass === "heavy") return cfg.heavyConcurrency;
  if (taskClass === "medium") return cfg.mediumConcurrency;
  if (taskClass === "dev") return cfg.devConcurrency;
  return cfg.lightConcurrency;
}

export function formatMb(mb) {
  if (!Number.isFinite(mb)) return "未知";
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

