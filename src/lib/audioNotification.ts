//! 统一音频通知服务（v0.13）：
//! 唯一负责「Agent / 任务 / 日程事件 → 提示音 / 语音播报」的调度者。
//!
//! 分层：后端 `audio-event`（真实事件，带唯一 eventId）→ 本服务（去重/合并/优先级/有界队列）
//! → 提示音（Web Audio）或 TTS（Rust WinRT 合成 + 本地缓存，返回 data URL）→ 单实例播放。
//!
//! 契约：
//! - 全局静音 `notify_muted` 绝对优先：不响、不合成、立即停止当前语音、清空待播；
//!   但不清通知历史、不停提醒调度、不停 Agent 采集。
//! - 提示音与 TTS 两个总开关 + 按事件开关彼此独立；不跟随系统通知显示开关
//!   （`notify_agent` / `notify_reminder`），只服从全局静音。
//! - 同一时刻只播一条；同时启用时固定「先提示音、后语音」，绝不叠音。
//! - 队列有界（`QUEUE_LIMIT`），高优先级（等待 > 失败 > 到期 > 完成 > 普通）优先；
//!   低优先级在满载时被丢弃，普通事件不会饿死高优先级。
//! - `agent_done` 在短窗口内合并为「多个任务已完成」，合并基于真实 eventId，不丢等待/失败。
//! - 持久化缓存只允许固定短语音（后端白名单二次校验）；含来源名/任务标题的文本仅内存复用。
//! - 任何播放/合成失败只写 debug 日志，不弹错误通知、不影响业务事件入库。

import { useEffect } from "react";
import type { Settings, TtsSynthesisReport } from "./bridge";
import { onAudioEvent, ttsSynthesize } from "./bridge";
import { useSettingsStore } from "../store/useSettingsStore";

export type AudioEventKind =
  | "agent_started"
  | "agent_done"
  | "agent_waiting"
  | "agent_failed"
  | "agent_disconnected"
  | "task_due"
  | "reminder";

export interface AudioEventItem {
  eventId: string;
  kind: string;
  sourceName?: string | null;
  taskTitle?: string | null;
}

/** 与 Rust `audio::FIXED_PHRASES` 保持一致；只有这些文本允许持久化。 */
export const FIXED_PHRASES = [
  "任务已完成",
  "多个任务已完成",
  "需要你的操作",
  "执行失败",
  "任务提醒时间到",
  "日程提醒时间到",
] as const;

/** 试听用文本：刻意不在固定短语白名单内，避免试听写入持久缓存。 */
const PREVIEW_TEXT = "语音播报已就绪";

const KIND_MAP: Record<string, AudioEventKind> = {
  agent_running: "agent_started",
  agent_started: "agent_started",
  agent_done: "agent_done",
  agent_waiting: "agent_waiting",
  agent_failed: "agent_failed",
  agent_disconnected: "agent_disconnected",
  task_due: "task_due",
  reminder: "reminder",
};

export const EVENT_PRIORITY: Record<AudioEventKind, number> = {
  agent_waiting: 4,
  agent_failed: 3,
  task_due: 2,
  reminder: 2,
  agent_done: 1,
  agent_started: 0,
  agent_disconnected: 0,
};

/** 队列上限：高峰期（多 Agent 并发）只保留最关键的事件。 */
export const QUEUE_LIMIT = 24;
/** 完成事件合并窗口：10 个 Agent 同时完成只播一次。 */
export const DONE_MERGE_WINDOW_MS = 600;
/**
 * 合并缓冲上限：只保留「首条事件 + 计数」，不保存后续对象；
 * 计数也封顶，异常事件洪峰不会让缓冲无界增长。
 */
export const DONE_BATCH_LIMIT = 128;
/** 单个提示音音符的振铃时长（秒），与 Web Audio 调度单位保持一致。 */
const TONE_NOTE_SECONDS = 0.34;
/** 普通事件过期时间：太旧的事件不再补播。 */
const JOB_TTL_MS = 60_000;
const CRITICAL_JOB_TTL_MS = 120_000;
/** 同事件提示音冷却：等待/失败沿用旧胶囊通道的 60s；完成/到期用短冷却防刷屏。 */
const TONE_COOLDOWN_CRITICAL_MS = 60_000;
const TONE_COOLDOWN_NORMAL_MS = 2_500;
/** 去重记忆上限与 TTL。 */
const SEEN_LIMIT = 1024;
const SEEN_TTL_MS = 10 * 60_000;

export interface AudioSettingsSnapshot {
  muted: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  ttsEnabled: boolean;
  ttsVolume: number;
  ttsRate: number;
  ttsVoiceId: string;
  ttsGender: string;
  speakSource: boolean;
  speakTitle: boolean;
  cacheEnabled: boolean;
  cacheMaxMb: number;
  soundFor: Record<AudioEventKind, boolean>;
  ttsFor: Record<AudioEventKind, boolean>;
}

const DEFAULT_SOUND: Record<AudioEventKind, boolean> = {
  agent_started: false,
  agent_done: true,
  agent_waiting: true,
  agent_failed: true,
  agent_disconnected: false,
  task_due: true,
  reminder: true,
};
const DEFAULT_TTS: Record<AudioEventKind, boolean> = {
  agent_started: false,
  agent_done: true,
  agent_waiting: true,
  agent_failed: true,
  agent_disconnected: false,
  task_due: true,
  reminder: true,
};

const boolOf = (value: boolean | undefined, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;
const numOf = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** 把持久化设置映射为音频服务快照；旧配置缺键时使用与后端一致的默认值。 */
export function readAudioSettings(s: Settings | null | undefined): AudioSettingsSnapshot {
  return {
    muted: s?.notify_muted === true,
    soundEnabled: boolOf(s?.audio_sound_enabled, true),
    soundVolume: clampPercent(numOf(s?.audio_sound_volume, 70)),
    ttsEnabled: boolOf(s?.tts_enabled, false),
    ttsVolume: clampPercent(numOf(s?.tts_volume, 80)),
    ttsRate: Math.min(200, Math.max(50, numOf(s?.tts_rate, 100))),
    ttsVoiceId: typeof s?.tts_voice_id === "string" ? s.tts_voice_id : "",
    ttsGender:
      s?.tts_voice_gender === "male" || s?.tts_voice_gender === "female"
        ? s.tts_voice_gender
        : "auto",
    speakSource: boolOf(s?.tts_speak_source, true),
    speakTitle: boolOf(s?.tts_speak_title, false),
    cacheEnabled: boolOf(s?.tts_cache_enabled, true),
    cacheMaxMb: Math.min(2048, Math.max(1, numOf(s?.tts_cache_max_mb, 50))),
    soundFor: {
      agent_started: boolOf(s?.audio_sound_agent_started, DEFAULT_SOUND.agent_started),
      agent_done: boolOf(s?.audio_sound_agent_done, DEFAULT_SOUND.agent_done),
      agent_waiting: boolOf(s?.audio_sound_agent_waiting, DEFAULT_SOUND.agent_waiting),
      agent_failed: boolOf(s?.audio_sound_agent_failed, DEFAULT_SOUND.agent_failed),
      agent_disconnected: boolOf(
        s?.audio_sound_agent_disconnected,
        DEFAULT_SOUND.agent_disconnected,
      ),
      task_due: boolOf(s?.audio_sound_task_due, DEFAULT_SOUND.task_due),
      reminder: boolOf(s?.audio_sound_reminder, DEFAULT_SOUND.reminder),
    },
    ttsFor: {
      agent_started: boolOf(s?.tts_agent_started, DEFAULT_TTS.agent_started),
      agent_done: boolOf(s?.tts_agent_done, DEFAULT_TTS.agent_done),
      agent_waiting: boolOf(s?.tts_agent_waiting, DEFAULT_TTS.agent_waiting),
      agent_failed: boolOf(s?.tts_agent_failed, DEFAULT_TTS.agent_failed),
      agent_disconnected: boolOf(s?.tts_agent_disconnected, DEFAULT_TTS.agent_disconnected),
      task_due: boolOf(s?.tts_task_due, DEFAULT_TTS.task_due),
      reminder: boolOf(s?.tts_reminder, DEFAULT_TTS.reminder),
    },
  };
}

function clampPercent(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function eventKindOf(raw: string): AudioEventKind | null {
  return KIND_MAP[raw] ?? null;
}

/** 组播报文本。来源名/标题属于动态内容，默认不持久化（后端还有白名单兜底）。 */
export function composeSpeech(
  kind: AudioEventKind,
  opts: { sourceName?: string | null; taskTitle?: string | null; merged?: boolean },
  settings: Pick<AudioSettingsSnapshot, "speakSource" | "speakTitle">,
): { text: string; persist: boolean } {
  const base =
    kind === "agent_done"
      ? opts.merged
        ? "多个任务已完成"
        : "任务已完成"
      : kind === "agent_waiting"
        ? "需要你的操作"
        : kind === "agent_failed"
          ? "执行失败"
          : kind === "agent_started"
            ? "Agent 开始执行"
            : kind === "agent_disconnected"
              ? "Agent 连接中断"
              : kind === "task_due"
                ? "任务提醒时间到"
                : "日程提醒时间到";
  const labels: string[] = [];
  if (settings.speakSource && opts.sourceName?.trim()) labels.push(opts.sourceName.trim());
  if (settings.speakTitle && opts.taskTitle?.trim()) labels.push(opts.taskTitle.trim());
  const text =
    labels.length > 0 ? `「${labels.join(" · ")}」${base}` : base;
  const clipped = text.length > 300 ? `${text.slice(0, 300)}` : text;
  const persist = (FIXED_PHRASES as readonly string[]).includes(clipped);
  return { text: clipped, persist };
}

interface Job {
  eventId: string;
  kind: AudioEventKind;
  sourceName?: string | null;
  taskTitle?: string | null;
  merged: boolean;
  priority: number;
  seq: number;
  createdAt: number;
}

export interface AudioDiagnostics {
  received: number;
  deduped: number;
  merged: number;
  played: number;
  dropped: number;
  ttsOk: number;
  ttsFail: number;
  /** 因静音/关闭 TTS/切换声音或语速取消的数量（不计成功也不计失败）。 */
  ttsCancelled: number;
  queue: number;
  playing: boolean;
  /** 正在等待后端合成（尚未播放）。 */
  synthesizing: boolean;
  /** 正在实际播放语音。 */
  speaking: boolean;
  /** 试听流程进行中（合成或播放）。 */
  previewing: boolean;
}

/** 试听结果：UI 只按 code 展示简短反馈，不在前端记录播报正文。 */
export interface AudioPreviewResult {
  ok: boolean;
  code: string;
  voiceName?: string;
  fallback?: boolean;
}

export interface AudioAdapters {
  getSettings: () => Settings | null;
  synthesize: (args: {
    text: string;
    voiceId?: string;
    gender?: string;
    rate?: number;
    persist?: boolean;
  }) => Promise<TtsSynthesisReport>;
  playTone: (kind: AudioEventKind, volume: number, signal: AbortSignal) => Promise<void>;
  playSpeech: (dataUrl: string, volume: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  log: (...args: unknown[]) => void;
  /** 服务销毁时释放 AudioContext（可选，测试适配器可省略）。 */
  closeAudio?: () => Promise<void>;
}

/**
 * 提示音增益：0% 必须完全静音，绝不给 0 音量补最小振幅；
 * 100% 对应旧胶囊音量曲线 0.15，百分比线性映射。
 */
export function toneGain(volume: number): number {
  const v = Math.min(100, Math.max(0, volume));
  if (v <= 0) return 0;
  return 0.15 * (v / 100);
}

/** 默认适配器：Web Audio 短音 + `<audio>` data URL 播放 + Tauri IPC。 */
export function createDefaultAdapters(): AudioAdapters {
  let ctx: AudioContext | null = null;
  const audioContext = (): AudioContext | null => {
    if (ctx) return ctx;
    const Ctor = typeof window !== "undefined" ? window.AudioContext : undefined;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
    return ctx;
  };

  const playTone = (
    kind: AudioEventKind,
    volume: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const ac = audioContext();
    if (!ac) return Promise.reject(new Error("audio_unavailable"));
    // 0% 完全静音：不创建节点、不排程，直接视为无声成功。
    const peak = toneGain(volume);
    if (peak <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let nodes: AudioNode[] = [];
      let safety: ReturnType<typeof setTimeout> | null = null;
      let resumeGuard: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (safety) clearTimeout(safety);
        if (resumeGuard) clearTimeout(resumeGuard);
        safety = null;
        resumeGuard = null;
        signal.removeEventListener("abort", onAbort);
        for (const node of nodes) {
          try {
            node.disconnect();
          } catch {
            /* 已断开 */
          }
        }
        nodes = [];
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        // 立即停止尚未结束的振荡器，避免取消后留下尾音。
        for (const node of nodes) {
          const osc = node as OscillatorNode;
          try {
            osc.onended = null;
            if (typeof osc.stop === "function") osc.stop(0);
          } catch {
            /* 已停止 */
          }
        }
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish();

      signal.addEventListener("abort", onAbort);
      const schedule = () => {
        if (settled) return;
        try {
          const notes: number[] =
            kind === "agent_failed"
              ? [392.0, 261.63]
              : kind === "agent_done"
                ? [523.25, 659.25]
                : kind === "task_due" || kind === "reminder"
                  ? [659.25, 659.25]
                  : [523.25];
          const gap = kind === "task_due" || kind === "reminder" ? 0.12 : 0.18;
          const t0 = ac.currentTime + 0.01;
          const oscillators: OscillatorNode[] = [];
          notes.forEach((freq, i) => {
            const osc = ac.createOscillator();
            const gain = ac.createGain();
            const start = t0 + i * gap;
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + TONE_NOTE_SECONDS - 0.02);
            osc.connect(gain).connect(ac.destination);
            nodes.push(osc, gain);
            oscillators.push(osc);
            osc.start(start);
            osc.stop(start + TONE_NOTE_SECONDS);
          });
          // 统一的秒单位：最后音符开始时间 + 音符时长。
          const endAt = t0 + (notes.length - 1) * gap + TONE_NOTE_SECONDS;
          // 结束以 AudioScheduledSourceNode 的 ended 事件为准；计时器只做异常兜底。
          const last = oscillators[oscillators.length - 1];
          if (last) last.onended = () => finish();
          safety = setTimeout(
            () => finish(),
            Math.max(0, (endAt - ac.currentTime) * 1000) + 800,
          );
        } catch (e) {
          finish(new Error(`audio_tone_failed: ${String(e)}`));
        }
      };

      if (ac.state === "suspended") {
        // 自动播放被拒绝/超时：如实失败，不能当作已经响过。
        resumeGuard = setTimeout(() => finish(new Error("audio_resume_timeout")), 3_000);
        void ac.resume().then(
          () => {
            if (resumeGuard) clearTimeout(resumeGuard);
            resumeGuard = null;
            schedule();
          },
          () => finish(new Error("audio_resume_failed")),
        );
      } else {
        schedule();
      }
    });
  };

  const playSpeech = (
    dataUrl: string,
    volume: number,
    signal: AbortSignal,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (volume <= 0) {
        resolve();
        return;
      }
      if (typeof Audio === "undefined") {
        reject(new Error("audio_unavailable"));
        return;
      }
      const audio = new Audio(dataUrl);
      audio.volume = Math.min(1, Math.max(0, volume / 100));
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal.removeEventListener("abort", onAbort);
        audio.onended = null;
        audio.onerror = null;
        audio.onloadedmetadata = null;
        try {
          audio.pause();
        } catch {
          /* 已停止 */
        }
        audio.src = "";
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        const cancelled = signal.aborted;
        cleanup();
        // 主动取消（静音/切换声音/退出）不算播放成功，也不算失败。
        if (cancelled) resolve();
        else if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish();
      const armTimeout = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("playback_timeout")), ms);
      };
      signal.addEventListener("abort", onAbort);
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("playback_failed"));
      audio.onloadedmetadata = () => {
        const duration = audio.duration;
        armTimeout(
          Number.isFinite(duration) && duration > 0
            ? Math.min(duration * 1000 + 3_000, 180_000)
            : 60_000,
        );
      };
      // 元数据迟迟不来时的兜底；拿到真实时长后会替换。
      armTimeout(60_000);
      void Promise.resolve(audio.play()).catch(() => {
        // 自动播放被拒绝/解码失败：交给服务统计为失败，不能计成功。
        finish(new Error("playback_failed"));
      });
    });

  const closeAudio = async () => {
    const current = ctx;
    ctx = null;
    if (current && current.state !== "closed") {
      try {
        await current.close();
      } catch {
        /* 关闭失败不影响退出 */
      }
    }
  };

  return {
    getSettings: () => useSettingsStore.getState().settings,
    synthesize: (args) => ttsSynthesize(args),
    playTone,
    playSpeech,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    log: (...args) => console.debug(...args),
    closeAudio,
  };
}

export class AudioNotificationService {
  private readonly deps: AudioAdapters;
  private queue: Job[] = [];
  private seen = new Map<string, number>();
  private lastToneAt = new Map<AudioEventKind, number>();
  /** 完成合并缓冲：只保留首条事件 + 计数，天然有界，不随事件洪峰增长。 */
  private doneBatchFirst: AudioEventItem | null = null;
  private doneBatchCount = 0;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private previewing = false;
  private generation = 0;
  /** 提示音与语音分别持有取消句柄：切换声音不影响正在播放的提示音。 */
  private toneController: AbortController | null = null;
  private speechController: AbortController | null = null;
  private previewController: AbortController | null = null;
  private disposed = false;
  private prewarmGeneration = 0;
  private prewarmKey = "";
  private lastSnap: AudioSettingsSnapshot | null = null;
  /** 语音代次：声音/语速/开关变化时递增，令在途合成结果失效。 */
  private speechEpoch = 0;
  private synthesizing = false;
  private speaking = false;
  private seq = 0;
  private stats = {
    received: 0,
    deduped: 0,
    merged: 0,
    played: 0,
    dropped: 0,
    ttsOk: 0,
    ttsFail: 0,
    ttsCancelled: 0,
  };

  constructor(deps: AudioAdapters) {
    this.deps = deps;
    // 初始快照：首次设置变化即可与真实起点比较，切换声音能立即停旧语音。
    this.lastSnap = readAudioSettings(deps.getSettings());
  }

  /** 后端事件入口（一批 items 来自一次 Agent 批次或提醒 tick）。 */
  handleItems(items: readonly AudioEventItem[]): void {
    if (this.disposed) return;
    const settings = this.deps.getSettings();
    if (!settings) return;
    const snap = readAudioSettings(settings);
    if (snap.muted) return;

    const now = this.deps.now();
    this.pruneSeen(now);
    for (const item of items) {
      this.stats.received += 1;
      const kind = eventKindOf(item.kind);
      if (!kind) continue;
      const eventId = item.eventId?.trim() || `${kind}:${now}`;
      if (this.seen.has(eventId)) {
        this.stats.deduped += 1;
        continue;
      }
      this.seen.set(eventId, now);
      if (this.seen.size > SEEN_LIMIT) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      // 两个通道都关闭的事件不进入队列。
      if (
        !(snap.soundEnabled && snap.soundFor[kind]) &&
        !(snap.ttsEnabled && snap.ttsFor[kind])
      ) {
        continue;
      }
      if (kind === "agent_done") {
        // 固定窗口：首条事件启动计时，后续事件只累加计数，绝不重置窗口终点。
        if (this.doneBatchCount === 0) {
          this.doneBatchFirst = { ...item, eventId, kind };
          this.doneTimer = this.deps.setTimeout(
            () => this.flushDoneBatch(),
            DONE_MERGE_WINDOW_MS,
          );
        }
        this.doneBatchCount = Math.min(DONE_BATCH_LIMIT, this.doneBatchCount + 1);
        continue;
      }
      this.enqueue({
        eventId,
        kind,
        sourceName: item.sourceName,
        taskTitle: item.taskTitle,
        merged: false,
        priority: EVENT_PRIORITY[kind],
        seq: this.seq++,
        createdAt: now,
      });
    }
  }

  /** 合并窗口结束：1 条 = 普通完成；>=2 条 = 「多个任务已完成」，只播一次。 */
  flushDoneBatch(): void {
    if (this.doneTimer) {
      this.deps.clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    const first = this.doneBatchFirst;
    const count = this.doneBatchCount;
    this.doneBatchFirst = null;
    this.doneBatchCount = 0;
    if (!first || count === 0) return;
    const merged = count > 1;
    if (merged) this.stats.merged += count;
    this.enqueue({
      eventId: merged ? `merged-done:${first.eventId}` : first.eventId,
      kind: "agent_done",
      sourceName: merged ? null : first.sourceName,
      taskTitle: merged ? null : first.taskTitle,
      merged,
      priority: EVENT_PRIORITY.agent_done,
      seq: this.seq++,
      createdAt: this.deps.now(),
    });
  }

  private enqueue(job: Job): void {
    if (this.queue.some((j) => j.eventId === job.eventId)) return;
    if (this.queue.length >= QUEUE_LIMIT) {
      // 满载：关键事件保留，低优先级（队列中最低）被丢弃。
      let lowestIdx = -1;
      let lowestPriority = Number.POSITIVE_INFINITY;
      this.queue.forEach((j, i) => {
        if (j.priority < lowestPriority) {
          lowestPriority = j.priority;
          lowestIdx = i;
        }
      });
      if (job.priority > lowestPriority && lowestIdx >= 0) {
        this.queue.splice(lowestIdx, 1);
        this.stats.dropped += 1;
      } else {
        this.stats.dropped += 1;
        return;
      }
    }
    this.queue.push(job);
    // 稳定排序：优先级高先播；同优先级按到达顺序。
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    void this.pump();
  }

  private async pump(): Promise<void> {
    // 试听占用唯一的播放通道；结束后由 preview 的 finally 继续泵队列。
    if (this.pumping || this.previewing || this.disposed) return;
    this.pumping = true;
    const generation = this.generation;
    try {
      while (this.queue.length > 0) {
        if (!this.isActive(generation)) break;
        const job = this.queue.shift()!;
        if (this.isExpired(job)) {
          this.stats.dropped += 1;
          continue;
        }
        await this.execute(job, generation);
      }
    } finally {
      this.pumping = false;
    }
    // 执行期间若又有新任务入队（例如被 stopAll 清空后重新启用），继续泵。
    if (!this.disposed && this.queue.length > 0) void this.pump();
  }

  private isExpired(job: Job): boolean {
    const ttl =
      job.priority >= EVENT_PRIORITY.agent_failed ? CRITICAL_JOB_TTL_MS : JOB_TTL_MS;
    return this.deps.now() - job.createdAt > ttl;
  }

  private isActive(generation: number): boolean {
    if (this.disposed || generation !== this.generation) return false;
    const settings = this.deps.getSettings();
    if (!settings) return false;
    const snap = readAudioSettings(settings);
    return !snap.muted;
  }

  private async execute(job: Job, generation: number): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings) return;
    const snap = readAudioSettings(settings);
    if (snap.muted || !this.isActive(generation)) return;

    // 音量 0 等同该通道静音：不排程、不合成。
    const toneOn = snap.soundEnabled && snap.soundFor[job.kind] && snap.soundVolume > 0;
    const ttsOn = snap.ttsEnabled && snap.ttsFor[job.kind] && snap.ttsVolume > 0;
    if (!toneOn && !ttsOn) return;

    let tonePlayed = false;
    if (toneOn && this.toneReady(job.kind)) {
      const controller = new AbortController();
      this.toneController = controller;
      try {
        // 只有真实结束（ended / 兜底超时）才返回，再进入语音，避免叠音。
        await this.deps.playTone(job.kind, snap.soundVolume, controller.signal);
        if (!controller.signal.aborted) {
          this.lastToneAt.set(job.kind, this.deps.now());
          tonePlayed = true;
        }
      } catch (e) {
        // 自动播放被拒绝等：如实记录失败，但仍可在有语音时降级播报。
        this.deps.log("audio tone failed:", e);
      } finally {
        if (this.toneController === controller) this.toneController = null;
      }
    }
    if (!this.isActive(generation)) return;
    if (!ttsOn) {
      if (tonePlayed) this.stats.played += 1;
      return;
    }

    const { text, persist } = composeSpeech(job.kind, job, snap);
    const epoch = this.speechEpoch;
    let report: TtsSynthesisReport;
    this.synthesizing = true;
    try {
      report = await this.deps.synthesize({
        text,
        voiceId: snap.ttsVoiceId || undefined,
        gender: snap.ttsGender,
        rate: snap.ttsRate,
        persist,
      });
    } catch (e) {
      this.stats.ttsFail += 1;
      this.deps.log("audio speech request failed:", e);
      if (tonePlayed) this.stats.played += 1;
      return;
    } finally {
      this.synthesizing = false;
    }
    // 合成期间静音/关闭/切换声音或语速：在途结果直接作废，不播放旧声音。
    if (!this.isActive(generation)) return;
    if (epoch !== this.speechEpoch) {
      this.stats.ttsCancelled += 1;
      if (tonePlayed) this.stats.played += 1;
      return;
    }
    const after = readAudioSettings(this.deps.getSettings());
    if (
      !after.ttsEnabled ||
      !after.ttsFor[job.kind] ||
      after.ttsVolume <= 0 ||
      after.ttsVoiceId !== snap.ttsVoiceId ||
      after.ttsGender !== snap.ttsGender ||
      after.ttsRate !== snap.ttsRate
    ) {
      this.stats.ttsCancelled += 1;
      if (tonePlayed) this.stats.played += 1;
      return;
    }
    if (!report.ok || !report.dataUrl) {
      this.stats.ttsFail += 1;
      // 只记录错误码，不记录播报正文（可能含任务标题/来源名）。
      this.deps.log("audio speech unavailable:", report.code);
      if (tonePlayed) this.stats.played += 1;
      return;
    }
    if (report.voiceFallback) {
      this.deps.log("audio speech voice fallback:", report.code);
    }
    const controller = new AbortController();
    this.speechController = controller;
    this.speaking = true;
    try {
      await this.deps.playSpeech(report.dataUrl, snap.ttsVolume, controller.signal);
      if (controller.signal.aborted) {
        // 静音/切声音/退出取消：不计成功也不计失败。
        this.stats.ttsCancelled += 1;
        if (tonePlayed) this.stats.played += 1;
        return;
      }
      this.stats.ttsOk += 1;
      this.stats.played += 1;
    } catch (e) {
      // 合成成功但扬声器播放失败：不能计成功。
      this.stats.ttsFail += 1;
      this.deps.log("audio speech playback failed:", e);
      if (tonePlayed) this.stats.played += 1;
    } finally {
      this.speaking = false;
      if (this.speechController === controller) this.speechController = null;
    }
  }

  private toneReady(kind: AudioEventKind): boolean {
    const cooldown =
      kind === "agent_waiting" || kind === "agent_failed"
        ? TONE_COOLDOWN_CRITICAL_MS
        : TONE_COOLDOWN_NORMAL_MS;
    const last = this.lastToneAt.get(kind);
    return last === undefined || this.deps.now() - last >= cooldown;
  }

  private pruneSeen(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at > SEEN_TTL_MS) this.seen.delete(id);
    }
  }

  /** 设置变化：静音/关闭时立即停止；语音相关变化触发异步预生成（不阻塞播报）。 */
  onSettingsChanged(settings: Settings | null): void {
    if (this.disposed) return;
    const snap = readAudioSettings(settings);
    const prev = this.lastSnap;
    this.lastSnap = snap;
    if (snap.muted) {
      this.stopAll();
      return;
    }
    if (!snap.soundEnabled && !snap.ttsEnabled) {
      this.stopAll();
      return;
    }
    if (prev) {
      // 提示音音量降到 0：停止正在播放的提示音（语音不受影响）。
      if (snap.soundVolume <= 0 && prev.soundVolume > 0) {
        this.toneController?.abort();
        this.toneController = null;
      }
      const voiceChanged =
        prev.ttsVoiceId !== snap.ttsVoiceId ||
        prev.ttsGender !== snap.ttsGender ||
        prev.ttsRate !== snap.ttsRate;
      const speechSilenced = snap.ttsVolume <= 0 && prev.ttsVolume > 0;
      if (!snap.ttsEnabled && prev.ttsEnabled) {
        // 关闭语音：立即停当前播放，拒绝在途合成与排队语音；提示音照常。
        this.stopSpeech();
        this.previewController?.abort();
        this.previewController = null;
      } else if (voiceChanged || speechSilenced) {
        // 切男/女声、具体语音或语速：旧声音/旧参数一律不再播放（含试听）。
        this.stopSpeech();
        this.previewController?.abort();
        this.previewController = null;
      }
    }
    if (!snap.ttsEnabled || !snap.cacheEnabled) {
      this.prewarmGeneration += 1;
      return;
    }
    const key = [
      snap.ttsVoiceId,
      snap.ttsGender,
      snap.ttsRate,
      snap.cacheEnabled,
      snap.cacheMaxMb,
    ].join("|");
    if (key !== this.prewarmKey) {
      this.prewarmKey = key;
      void this.prewarm();
    }
  }

  private async prewarm(): Promise<void> {
    const generation = ++this.prewarmGeneration;
    const settings = this.deps.getSettings();
    if (!settings) return;
    const snap = readAudioSettings(settings);
    if (!snap.ttsEnabled || !snap.cacheEnabled || snap.muted) return;
    // 延后启动，避免与启动渲染/首批播报争抢资源。
    await new Promise<void>((resolve) => this.deps.setTimeout(resolve, 1200));
    for (const phrase of FIXED_PHRASES) {
      if (generation !== this.prewarmGeneration || this.disposed) return;
      // 有真实播报待处理时让路（预生成绝不成为播报前置依赖）。
      let waited = 0;
      while ((this.queue.length > 0 || this.pumping) && waited < 5) {
        await new Promise<void>((resolve) => this.deps.setTimeout(resolve, 500));
        waited += 1;
        if (generation !== this.prewarmGeneration || this.disposed) return;
      }
      if (this.queue.length > 0 || this.pumping) continue;
      try {
        await this.deps.synthesize({
          text: phrase,
          voiceId: snap.ttsVoiceId || undefined,
          gender: snap.ttsGender,
          rate: snap.ttsRate,
          persist: true,
        });
      } catch {
        // 预生成失败不阻塞、不提示；真正播报时会重新尝试并给出反馈。
      }
      await new Promise<void>((resolve) => this.deps.setTimeout(resolve, 120));
    }
  }

  /**
   * 设置页试听提示音：由本服务统一播放，避免与真实通知叠音。
   * 只服从全局静音；试听期间若有真实播报在跑，直接返回 busy 而不是抢占。
   */
  async previewTone(): Promise<AudioPreviewResult> {
    if (this.disposed) return { ok: false, code: "disposed" };
    const snap = readAudioSettings(this.deps.getSettings());
    if (snap.muted) return { ok: false, code: "muted" };
    if (this.pumping) return { ok: false, code: "busy" };
    this.previewController?.abort();
    // 单通道音量 0：明确回报「静音」，不排程、不误报试听成功。
    if (snap.soundVolume <= 0) return { ok: false, code: "silent_tone" };
    const controller = new AbortController();
    this.previewController = controller;
    this.previewing = true;
    try {
      await this.deps.playTone("agent_done", snap.soundVolume, controller.signal);
      return controller.signal.aborted
        ? { ok: false, code: "cancelled" }
        : { ok: true, code: "ok" };
    } catch {
      return { ok: false, code: "failed" };
    } finally {
      if (this.previewController === controller) this.previewController = null;
      this.endPreview();
    }
  }

  /** 试听结束：释放独占通道，并把期间到达的真实通知继续播。 */
  private endPreview(): void {
    this.previewing = false;
    if (!this.disposed && !this.pumping && this.queue.length > 0) void this.pump();
  }

  /**
   * 设置页试听语音：按当前设置合成（不持久化），成功后单实例播放。
   * 显式略过 TTS 总开关，便于用户在开启前先确认声音；仍服从全局静音。
   */
  async previewSpeech(): Promise<AudioPreviewResult> {
    if (this.disposed) return { ok: false, code: "disposed" };
    const snap = readAudioSettings(this.deps.getSettings());
    if (snap.muted) return { ok: false, code: "muted" };
    if (this.pumping) return { ok: false, code: "busy" };
    this.previewController?.abort();
    // 语音音量 0：不做无意义的合成与播放，明确回报单通道静音。
    if (snap.ttsVolume <= 0) return { ok: false, code: "silent_speech" };
    const controller = new AbortController();
    this.previewController = controller;
    this.previewing = true;
    try {
      const report = await this.deps.synthesize({
        text: PREVIEW_TEXT,
        voiceId: snap.ttsVoiceId || undefined,
        gender: snap.ttsGender,
        rate: snap.ttsRate,
        persist: false,
      });
      if (controller.signal.aborted) return { ok: false, code: "cancelled" };
      if (!report.ok || !report.dataUrl) {
        return { ok: false, code: report.code || "failed" };
      }
      // 合成期间切换了声音/语速：试听结果作废，避免听到旧声音。
      const after = readAudioSettings(this.deps.getSettings());
      if (
        after.ttsVoiceId !== snap.ttsVoiceId ||
        after.ttsGender !== snap.ttsGender ||
        after.ttsRate !== snap.ttsRate
      ) {
        return { ok: false, code: "cancelled" };
      }
      if (this.pumping) return { ok: false, code: "busy" };
      await this.deps.playSpeech(report.dataUrl, snap.ttsVolume, controller.signal);
      return {
        ok: true,
        code: "ok",
        voiceName: report.voiceName,
        fallback: report.voiceFallback,
      };
    } catch {
      return { ok: false, code: "failed" };
    } finally {
      if (this.previewController === controller) this.previewController = null;
      this.endPreview();
    }
  }

  /** 语音关闭/静音/切声音：停止当前语音并让在途合成结果失效；提示音不受影响。 */
  private stopSpeech(): void {
    this.speechEpoch += 1;
    this.speechController?.abort();
    this.speechController = null;
  }

  /** 全局静音/两通道关闭/退出：停止播放并清空待播。 */
  stopAll(): void {
    this.generation += 1;
    this.speechEpoch += 1;
    this.prewarmGeneration += 1;
    this.queue = [];
    this.doneBatchFirst = null;
    this.doneBatchCount = 0;
    if (this.doneTimer) {
      this.deps.clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    this.toneController?.abort();
    this.toneController = null;
    this.speechController?.abort();
    this.speechController = null;
    this.previewController?.abort();
    this.previewController = null;
  }

  diagnostics(): AudioDiagnostics {
    return {
      ...this.stats,
      queue: this.queue.length,
      playing: this.pumping,
      synthesizing: this.synthesizing,
      speaking: this.speaking,
      previewing: this.previewing,
    };
  }

  dispose(): void {
    this.stopAll();
    this.disposed = true;
    // 释放 AudioContext；失败不影响退出。
    const closing = this.deps.closeAudio?.();
    if (closing) void closing.catch(() => {});
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

// ── 主窗口单例：只有 App 根节点挂载，通知/菜单等窗口不引用本模块 ──
let singleton: AudioNotificationService | null = null;

export function getAudioService(): AudioNotificationService {
  if (!singleton || singleton.isDisposed()) {
    singleton = new AudioNotificationService(createDefaultAdapters());
  }
  return singleton;
}

/** 仅测试用：重置单例，避免测试互相污染。 */
export function _resetAudioServiceForTest(): void {
  singleton?.dispose();
  singleton = null;
}

/**
 * 在 App 根节点挂载一次：订阅后端事件与设置变化；卸载/退出时释放。
 * 用 window 标记防止 React 严格模式或重复挂载产生第二个调度所有者。
 */
export function useAudioNotifications(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const marker = globalThis as { __TD_AUDIO_OWNER__?: boolean };
    if (marker.__TD_AUDIO_OWNER__) return;
    marker.__TD_AUDIO_OWNER__ = true;
    const service = getAudioService();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const unsubscribe = useSettingsStore.subscribe((state) =>
      service.onSettingsChanged(state.settings),
    );
    service.onSettingsChanged(useSettingsStore.getState().settings);
    void onAudioEvent((payload) => {
      if (!disposed) service.handleItems(payload.items ?? []);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    const onBeforeUnload = () => service.stopAll();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      disposed = true;
      unlisten?.();
      unsubscribe();
      window.removeEventListener("beforeunload", onBeforeUnload);
      service.dispose();
      singleton = null;
      marker.__TD_AUDIO_OWNER__ = false;
    };
  }, []);
}
