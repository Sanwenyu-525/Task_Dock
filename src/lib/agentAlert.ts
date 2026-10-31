//! Agent 异常提示音（v0.6「异常变响」，v0.7 改由分类胶囊触发）：
//! Agent 进入 waiting / failed 时播放的合成短音。无音频资产、无新轮询、
//! 无新事件——信息源仍是既有 `railStatus().agentTone`。
//!
//! 契约（CapsuleDock 头注释同步维护）：
//! - 仅在「进入异常」时响：同状态 60s 冷却；跨状态（waiting→failed）立即重响；
//! - 设置门：`agent_alert_sound = false` 时不响（设置面板「通知」区）；
//! - WebView2 无手势自动播放被拒时静默跳过（AudioContext 创建失败 /
//!   start 抛错均吞掉并 console.debug），绝不打断用户、绝不弹错误 UI；
//! - 只在**停靠期**响本通道（胶囊是停靠期唯一界面）；未停靠（完整窗口可见）
//!   由系统 Toast（notify_agent）负责，两条通道不刻意叠加。

import { useSettingsStore } from "../store/useSettingsStore";

/** 同状态重响冷却：异常持续期间每分钟最多提醒一次 */
export const AGENT_ALERT_COOLDOWN_MS = 60_000;

export type AgentAlertState = "failed" | "waiting";

const lastPlayedAt = new Map<AgentAlertState, number>();

/** 时间源（测试注入点） */
let nowMs: () => number = () => Date.now();

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = typeof window !== "undefined" ? window.AudioContext : undefined;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/**
 * failed：G4→C4 低双音（下坠感）；waiting：C5 中单音（轻提醒）。
 * 指数包络防爆音，总时长 ≈0.5s，音量克制（峰值 0.15）。
 */
function tone(state: AgentAlertState): boolean {
  const ac = audioContext();
  if (!ac) return false;
  if (ac.state === "suspended") void ac.resume().catch(() => {});
  try {
    const t0 = ac.currentTime + 0.01;
    const notes = state === "failed" ? [392.0, 261.63] : [523.25];
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const start = t0 + i * 0.18;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.34);
    });
    return true;
  } catch (e) {
    console.debug("agent alert tone skipped:", e);
    return false;
  }
}

/** 播放异常提示音；返回是否真的发声（冷却中 / 设置关 / 音频不可用 = false） */
export function playAgentAlert(state: AgentAlertState): boolean {
  if (useSettingsStore.getState().settings?.agent_alert_sound === false) return false;
  const t = nowMs();
  const last = lastPlayedAt.get(state);
  if (last !== undefined && t - last < AGENT_ALERT_COOLDOWN_MS) return false;
  if (!tone(state)) return false;
  lastPlayedAt.set(state, t);
  return true;
}

/** 仅测试用：清空冷却表、时间源与已缓存的 AudioContext */
export function _resetAgentAlertForTest(now: () => number = () => Date.now()): void {
  lastPlayedAt.clear();
  nowMs = now;
  ctx = null;
}
