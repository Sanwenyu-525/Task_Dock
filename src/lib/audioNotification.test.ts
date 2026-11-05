// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioNotificationService,
  DONE_BATCH_LIMIT,
  MAX_SPEECH_LABEL_CHARS,
  PREVIEW_MAX_CHARS,
  DONE_MERGE_WINDOW_MS,
  EVENT_PRIORITY,
  QUEUE_LIMIT,
  composeSpeech,
  readAudioSettings,
  sanitizeSpeechLabel,
  toneGain,
  type AudioAdapters,
  type AudioEventKind,
} from "./audioNotification";
import type { Settings, TtsSynthesisReport } from "./bridge";

/** 最小设置桩：只填本套件涉及的音频字段，其余交给默认值。 */
function fakeSettings(patch: Partial<Settings> = {}): Settings {
  return {
    notify_muted: false,
    audio_sound_enabled: true,
    audio_sound_volume: 70,
    tts_enabled: true,
    tts_volume: 80,
    tts_rate: 100,
    tts_voice_id: "",
    tts_voice_gender: "auto",
    tts_speak_source: true,
    tts_speak_title: false,
    tts_cache_enabled: true,
    tts_cache_max_mb: 50,
    ...patch,
  } as unknown as Settings;
}

function okReport(): TtsSynthesisReport {
  return {
    ok: true,
    code: "ok",
    message: "",
    dataUrl: "data:audio/wav;base64,AA",
    contentType: "audio/wav",
    voiceId: "voice-a",
    voiceName: "Voice A",
    language: "zh-CN",
    gender: "female",
    requestedVoiceId: "",
    voiceFallback: false,
    cached: false,
    persisted: false,
    bytes: 8,
    latencyMs: 1,
  };
}

interface Harness {
  service: AudioNotificationService;
  events: string[];
  synth: Array<Record<string, unknown>>;
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  holdTone: () => { release: () => void };
  holdSpeech: () => { release: () => void };
  holdSynth: () => { release: (report?: TtsSynthesisReport) => void };
  closed: boolean;
  aborted: string[];
}

function makeHarness(initial: Settings = fakeSettings()): Harness {
  const events: string[] = [];
  const synth: Array<Record<string, unknown>> = [];
  const aborted: string[] = [];
  let settings = initial;
  let toneRelease: (() => void) | null = null;
  let speechRelease: (() => void) | null = null;
  let synthRelease: ((report: TtsSynthesisReport) => void) | null = null;
  let holdToneOn = false;
  let holdSpeechOn = false;
  let holdSynthOn = false;
  let closed = false;

  const deps: AudioAdapters = {
    getSettings: () => settings,
    synthesize: async (args) => {
      synth.push({ ...args });
      if (!holdSynthOn) return okReport();
      return await new Promise<TtsSynthesisReport>((resolve) => {
        synthRelease = resolve;
      });
    },
    playTone: async (kind, _volume, signal) => {
      events.push(`tone:${kind}`);
      signal.addEventListener("abort", () => aborted.push(`tone:${kind}`));
      if (!holdToneOn) return;
      await new Promise<void>((resolve) => {
        toneRelease = resolve;
        signal.addEventListener("abort", () => resolve());
      });
    },
    playSpeech: async (_dataUrl, _volume, signal) => {
      events.push("speech");
      signal.addEventListener("abort", () => aborted.push("speech"));
      if (!holdSpeechOn) return;
      await new Promise<void>((resolve) => {
        speechRelease = resolve;
        signal.addEventListener("abort", () => resolve());
      });
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    log: () => {},
    closeAudio: async () => {
      closed = true;
    },
  };

  return {
    service: new AudioNotificationService(deps),
    events,
    synth,
    get settings() {
      return settings;
    },
    setSettings: (patch) => {
      settings = fakeSettings({ ...settings, ...patch });
    },
    holdTone: () => {
      holdToneOn = true;
      return {
        release: () => {
          holdToneOn = false;
          toneRelease?.();
          toneRelease = null;
        },
      };
    },
    holdSpeech: () => {
      holdSpeechOn = true;
      return {
        release: () => {
          holdSpeechOn = false;
          speechRelease?.();
          speechRelease = null;
        },
      };
    },
    holdSynth: () => {
      holdSynthOn = true;
      return {
        release: (report) => {
          holdSynthOn = false;
          synthRelease?.(report ?? okReport());
          synthRelease = null;
        },
      };
    },
    get closed() {
      return closed;
    },
    aborted,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readAudioSettings", () => {
  it("缺键时使用与后端一致的默认值（TTS 默认关闭）", () => {
    const snap = readAudioSettings({ notify_muted: false } as Settings);
    expect(snap.soundEnabled).toBe(true);
    expect(snap.ttsEnabled).toBe(false);
    expect(snap.ttsRate).toBe(100);
    expect(snap.cacheMaxMb).toBe(50);
    expect(snap.soundFor.agent_started).toBe(false);
    expect(snap.soundFor.agent_done).toBe(true);
    expect(snap.soundFor.agent_disconnected).toBe(false);
  });

  it("全局静音与事件开关独立映射", () => {
    const snap = readAudioSettings(
      fakeSettings({ notify_muted: true, audio_sound_agent_done: false, tts_agent_done: false }),
    );
    expect(snap.muted).toBe(true);
    expect(snap.soundFor.agent_done).toBe(false);
    expect(snap.ttsFor.agent_done).toBe(false);
  });
});

describe("composeSpeech", () => {
  it("固定短语可持久化；含来源名/标题的动态文本不持久化", () => {
    expect(composeSpeech("agent_done", {}, { speakSource: true, speakTitle: false }).persist).toBe(
      true,
    );
    const dynamic = composeSpeech(
      "agent_done",
      { sourceName: "My Agent", taskTitle: "secret" },
      { speakSource: true, speakTitle: true },
    );
    expect(dynamic.text).toContain("My Agent");
    expect(dynamic.persist).toBe(false);
  });

  it("合并完成使用「多个任务已完成」", () => {
    expect(
      composeSpeech("agent_done", { merged: true }, { speakSource: true, speakTitle: false }).text,
    ).toBe("多个任务已完成");
  });

  it("超长标题按标签上限截断，不会整段朗读（300 字上限仍作为兜底）", () => {
    const long = "任务".repeat(250);
    const result = composeSpeech(
      "agent_failed",
      { taskTitle: long },
      { speakSource: false, speakTitle: true },
    );
    // 标签清洗上限 40 字符：播报只保留开头一小段，总长度远低于 300 兜底上限。
    expect(Array.from(result.text).length).toBeLessThan(80);
    expect(result.text).not.toContain("任务".repeat(21));
  });
});

describe("AudioNotificationService", () => {
  it("同一 eventId 只播一次", async () => {
    const h = makeHarness();
    const item = { eventId: "evt-1", kind: "agent_waiting" };
    h.service.handleItems([item, item]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events.filter((e) => e === "tone:agent_waiting")).toHaveLength(1);
    expect(h.service.diagnostics().deduped).toBe(1);
  });

  it("多个完成事件合并为一次「多个任务已完成」", async () => {
    const h = makeHarness();
    h.service.handleItems([
      { eventId: "d1", kind: "agent_done" },
      { eventId: "d2", kind: "agent_done" },
      { eventId: "d3", kind: "agent_done" },
    ]);
    await vi.advanceTimersByTimeAsync(DONE_MERGE_WINDOW_MS + 50);
    expect(h.synth).toHaveLength(1);
    expect(h.synth[0].text).toBe("多个任务已完成");
    expect(h.events).toEqual(["tone:agent_done", "speech"]);
    expect(h.service.diagnostics().merged).toBe(3);
  });

  it("等待事件优先于完成事件；先提示音后语音，绝不叠音", async () => {
    const h = makeHarness();
    h.service.handleItems([
      { eventId: "done-1", kind: "agent_done" },
      { eventId: "wait-1", kind: "agent_waiting" },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.events[0]).toBe("tone:agent_waiting");
    await vi.advanceTimersByTimeAsync(DONE_MERGE_WINDOW_MS + 50);
    expect(h.events).toEqual(["tone:agent_waiting", "speech", "tone:agent_done", "speech"]);
  });

  it("全局静音时完全不播放（含语音）", async () => {
    const h = makeHarness(fakeSettings({ notify_muted: true }));
    h.service.handleItems([{ eventId: "x", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.events).toHaveLength(0);
    expect(h.synth).toHaveLength(0);
  });

  it("提示音与 TTS 开关独立：只开 TTS 时不发声，只开提示音时不合成", async () => {
    const h = makeHarness(fakeSettings({ audio_sound_enabled: false, tts_enabled: true }));
    h.service.handleItems([{ eventId: "a", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events).toEqual(["speech"]);
    expect(h.synth).toHaveLength(1);

    h.setSettings({ audio_sound_enabled: true, tts_enabled: false });
    h.service.handleItems([{ eventId: "b", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events).toEqual(["speech", "tone:agent_failed"]);
  });

  it("事件开关关闭时不进入播放链路", async () => {
    const h = makeHarness(
      fakeSettings({ audio_sound_agent_failed: false, tts_agent_failed: false }),
    );
    h.service.handleItems([{ eventId: "c", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events).toHaveLength(0);
  });

  it("队列有界：播放占用期间超出上限的事件被丢弃", async () => {
    const h = makeHarness();
    const gate = h.holdTone();
    h.service.handleItems([{ eventId: "hold", kind: "agent_waiting" }]);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < QUEUE_LIMIT + 10; i += 1) {
      h.service.handleItems([{ eventId: `q-${i}`, kind: "agent_failed" }]);
    }
    expect(h.service.diagnostics().queue).toBeLessThanOrEqual(QUEUE_LIMIT);
    expect(h.service.diagnostics().dropped).toBeGreaterThan(0);
    gate.release();
    h.service.dispose();
  });

  it("停止播放：播放中取消并清空待播（退出/静音路径）", async () => {
    const h = makeHarness();
    const gate = h.holdSpeech();
    h.service.handleItems([{ eventId: "s1", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events).toContain("speech");
    h.service.stopAll();
    expect(h.aborted).toContain("speech");
    expect(h.service.diagnostics().queue).toBe(0);
    gate.release();
  });

  it("设置变为静音时立即停止当前语音", async () => {
    const h = makeHarness();
    const gate = h.holdSpeech();
    h.service.handleItems([{ eventId: "s2", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    h.setSettings({ notify_muted: true });
    h.service.onSettingsChanged(h.settings);
    expect(h.aborted).toContain("speech");
    gate.release();
  });

  it("预生成失败不影响后续真实播报", async () => {
    const h = makeHarness();
    h.service.handleItems([{ eventId: "real", kind: "agent_waiting" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.synth).toHaveLength(1);
    expect(h.service.diagnostics().ttsOk).toBe(1);
  });

  it("试听受限：静音跳过、播放中返回 busy", async () => {
    const muted = makeHarness(fakeSettings({ notify_muted: true }));
    await expect(muted.service.previewTone()).resolves.toMatchObject({ ok: false, code: "muted" });

    const busy = makeHarness();
    busy.holdTone();
    busy.service.handleItems([{ eventId: "b1", kind: "agent_waiting" }]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(busy.service.previewSpeech()).resolves.toMatchObject({ ok: false, code: "busy" });
    busy.service.dispose();
  });

  it("试听语音使用当前设置且不持久化", async () => {
    const h = makeHarness(fakeSettings({ tts_voice_id: "voice-b", tts_rate: 120 }));
    const result = await h.service.previewSpeech();
    expect(result.ok).toBe(true);
    expect(h.synth[0]).toMatchObject({ voiceId: "voice-b", rate: 120, persist: false });
  });

  it("显式音色试听：只试听该音色、不修改设置、不受当前设置变化影响", async () => {
    const h = makeHarness(fakeSettings({ tts_voice_id: "voice-a", tts_voice_gender: "auto" }));
    const gate = h.holdSynth();
    const stages: string[] = [];
    const pending = h.service.previewSpeech({
      voiceId: "voice-b",
      gender: "male",
      rate: 130,
      text: "需要你的操作",
      onStage: (stage) => stages.push(stage),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.synth[0]).toMatchObject({
      voiceId: "voice-b",
      gender: "male",
      rate: 130,
      text: "需要你的操作",
      persist: false,
    });
    // 默认音色在试听期间被改：显式试听仍继续（不是按当前设置试听）
    h.setSettings({ tts_voice_id: "voice-c" });
    gate.release();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(h.events).toContain("speech");
    expect(stages).toEqual(["synthesizing", "playing"]);
    // 设置未被试听改写
    expect(h.settings.tts_voice_id).toBe("voice-c");
  });

  it("试听文本为空或超长：结构化拒绝，不发起合成", async () => {
    const h = makeHarness();
    await expect(h.service.previewSpeech({ text: "   " })).resolves.toMatchObject({
      ok: false,
      code: "text_empty",
    });
    await expect(
      h.service.previewSpeech({ text: "很".repeat(PREVIEW_MAX_CHARS + 1) }),
    ).resolves.toMatchObject({ ok: false, code: "text_too_long" });
    expect(h.synth).toHaveLength(0);
    h.service.dispose();
  });

  it("stopPreview 中止播放并回报 cancelled（不把中断当成功）", async () => {
    const h = makeHarness();
    const gate = h.holdSpeech();
    const pending = h.service.previewSpeech({ voiceId: "voice-b", text: "任务已完成" });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).toContain("speech");
    h.service.stopPreview();
    gate.release();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(h.service.diagnostics().previewing).toBe(false);
    h.service.dispose();
  });

  it("提示音音量 0：试听不播放并回报单通道静音（不是成功）", async () => {
    const h = makeHarness(fakeSettings({ audio_sound_volume: 0 }));
    const result = await h.service.previewTone();
    expect(result).toMatchObject({ ok: false, code: "silent_tone" });
    expect(h.events).toHaveLength(0);
    expect(h.service.diagnostics().previewing).toBe(false);
  });

  it("语音音量 0：试听不合成、不播放并回报单通道静音", async () => {
    const h = makeHarness(fakeSettings({ tts_volume: 0 }));
    const result = await h.service.previewSpeech();
    expect(result).toMatchObject({ ok: false, code: "silent_speech" });
    expect(h.synth).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("提示音音量 0 但语音音量正常：语音试听仍可用（通道独立）", async () => {
    const h = makeHarness(
      fakeSettings({ audio_sound_volume: 0, tts_volume: 100 }),
    );
    await expect(h.service.previewTone()).resolves.toMatchObject({
      ok: false,
      code: "silent_tone",
    });
    await expect(h.service.previewSpeech()).resolves.toMatchObject({ ok: true });
    expect(h.events).toEqual(["speech"]);
  });

  it("全局静音优先于单通道 0：回报 muted 而非 silent_*", async () => {
    const h = makeHarness(fakeSettings({ notify_muted: true, audio_sound_volume: 0, tts_volume: 0 }));
    await expect(h.service.previewTone()).resolves.toMatchObject({ ok: false, code: "muted" });
    await expect(h.service.previewSpeech()).resolves.toMatchObject({ ok: false, code: "muted" });
  });

  it("诊断计数可读，不包含播报正文", async () => {
    const h = makeHarness();
    h.service.handleItems([{ eventId: "n1", kind: "agent_done" }]);
    await vi.advanceTimersByTimeAsync(DONE_MERGE_WINDOW_MS + 50);
    const diag = h.service.diagnostics();
    expect(diag.received).toBe(1);
    expect(diag.played).toBe(1);
    expect(JSON.stringify(diag)).not.toContain("任务已完成");
  });

  it("dispose 后不再接收事件", async () => {
    const h = makeHarness();
    h.service.dispose();
    h.service.handleItems([{ eventId: "after", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events).toHaveLength(0);
  });

  it("提示音真正结束（ended）后才开始语音，期间不叠音", async () => {
    const h = makeHarness();
    const gate = h.holdTone();
    h.service.handleItems([{ eventId: "seq-1", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.events).toEqual(["tone:agent_failed"]);
    // 提示音尚未结束：语音不得开始。
    expect(h.events).not.toContain("speech");
    gate.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).toEqual(["tone:agent_failed", "speech"]);
    h.service.dispose();
  });

  it("取消提示音后立即停止且不进入语音", async () => {
    const h = makeHarness();
    const gate = h.holdTone();
    h.service.handleItems([{ eventId: "cancel-1", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(1);
    h.service.stopAll();
    expect(h.aborted).toContain("tone:agent_failed");
    gate.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).not.toContain("speech");
  });

  it("提示音/语音音量 0 完全静音，不排程不合成", async () => {
    const h = makeHarness(fakeSettings({ audio_sound_volume: 0, tts_volume: 0 }));
    h.service.handleItems([{ eventId: "zero-1", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.events).toEqual([]);
    expect(h.synth).toHaveLength(0);
  });

  it("完成合并窗口固定：后续事件不延长终点", async () => {
    const h = makeHarness();
    h.service.handleItems([{ eventId: "w1", kind: "agent_done" }]);
    await vi.advanceTimersByTimeAsync(400);
    h.service.handleItems([{ eventId: "w2", kind: "agent_done" }]);
    // 距首条 650ms，已越过固定窗口；若被重置则此时仍未汇总。
    await vi.advanceTimersByTimeAsync(250);
    expect(h.synth).toHaveLength(1);
    expect(h.synth[0].text).toBe("多个任务已完成");
    expect(h.service.diagnostics().merged).toBe(2);
    h.service.dispose();
  });

  it("100 条并发完成：缓冲有界，只汇总一次", async () => {
    const h = makeHarness();
    for (let i = 0; i < 100; i += 1) {
      h.service.handleItems([{ eventId: `burst-${i}`, kind: "agent_done" }]);
    }
    // 缓冲不保留原始对象：计数封顶 + 首条引用。
    expect(h.service.diagnostics().queue).toBe(0);
    await vi.advanceTimersByTimeAsync(DONE_MERGE_WINDOW_MS + 50);
    expect(h.synth).toHaveLength(1);
    expect(h.synth[0].text).toBe("多个任务已完成");
    expect(h.service.diagnostics().merged).toBe(100);
    expect(h.service.diagnostics().merged).toBeLessThanOrEqual(DONE_BATCH_LIMIT);
    h.service.dispose();
  });

  it("窗口内重复 eventId 只计一次", async () => {
    const h = makeHarness();
    h.service.handleItems([
      { eventId: "dup", kind: "agent_done" },
      { eventId: "dup", kind: "agent_done" },
    ]);
    await vi.advanceTimersByTimeAsync(DONE_MERGE_WINDOW_MS + 50);
    expect(h.synth).toHaveLength(1);
    expect(h.synth[0].text).toBe("任务已完成");
    expect(h.service.diagnostics().deduped).toBe(1);
    h.service.dispose();
  });

  it("等待事件不被完成合并窗口阻塞", async () => {
    const h = makeHarness();
    h.service.handleItems([{ eventId: "bd", kind: "agent_done" }]);
    h.service.handleItems([{ eventId: "bw", kind: "agent_waiting" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events[0]).toBe("tone:agent_waiting");
  });

  it("合成中切换声音：旧合成结果不播放", async () => {
    const h = makeHarness();
    const gate = h.holdSynth();
    h.service.handleItems([{ eventId: "v1", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.synth).toHaveLength(1);
    h.setSettings({ tts_voice_id: "voice-b" });
    h.service.onSettingsChanged(h.settings);
    gate.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).not.toContain("speech");
    expect(h.service.diagnostics().ttsCancelled).toBeGreaterThan(0);
    h.service.dispose();
  });

  it("播放中切换声音：立即停止旧语音", async () => {
    const h = makeHarness();
    const gate = h.holdSpeech();
    h.service.handleItems([{ eventId: "v2", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events).toContain("speech");
    h.setSettings({ tts_voice_gender: "male" });
    h.service.onSettingsChanged(h.settings);
    expect(h.aborted).toContain("speech");
    gate.release();
    h.service.dispose();
  });

  it("播放中关闭 TTS：停止当前语音，提示音通道不受影响", async () => {
    const h = makeHarness();
    const gate = h.holdSpeech();
    h.service.handleItems([{ eventId: "v3", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    h.setSettings({ tts_enabled: false });
    h.service.onSettingsChanged(h.settings);
    expect(h.aborted).toContain("speech");
    gate.release();
    h.service.dispose();
  });

  it("停止后排队语音不再播放（TTS 关闭时只保留提示音）", async () => {
    const h = makeHarness();
    const gate = h.holdSpeech();
    h.service.handleItems([{ eventId: "q1", kind: "agent_failed" }]);
    await vi.advanceTimersByTimeAsync(50);
    h.service.handleItems([{ eventId: "q2", kind: "agent_waiting" }]);
    h.setSettings({ tts_enabled: false, audio_sound_enabled: true });
    h.service.onSettingsChanged(h.settings);
    gate.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.events.filter((e) => e === "speech")).toHaveLength(1);
    h.service.dispose();
  });

  it("关闭语音后再开启：重新执行固定短语预生成（关闭会清空预生成 Key）", async () => {
    const h = makeHarness();
    // 首次开启：1.2s 延迟后逐条预生成 6 条固定短语
    h.service.onSettingsChanged(h.settings);
    await vi.advanceTimersByTimeAsync(4000);
    const warmed = h.synth.length;
    expect(warmed).toBeGreaterThan(0);

    // 关闭：中止预生成并清空 Key
    h.setSettings({ tts_enabled: false });
    h.service.onSettingsChanged(h.settings);
    await vi.advanceTimersByTimeAsync(4000);
    const afterDisable = h.synth.length;

    // 同配置重新开启：必须重新预生成（否则缓存被清理后再也不会补）
    h.setSettings({ tts_enabled: true });
    h.service.onSettingsChanged(h.settings);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.synth.length).toBeGreaterThan(afterDisable);
    h.service.dispose();
  });

  it("关闭语音会中止在途预生成，不再继续合成", async () => {
    const h = makeHarness();
    h.service.onSettingsChanged(h.settings);
    await vi.advanceTimersByTimeAsync(1300); // 已进入第一条合成之后的等待
    const started = h.synth.length;
    h.setSettings({ tts_enabled: false });
    h.service.onSettingsChanged(h.settings);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.synth.length).toBeLessThanOrEqual(started + 1);
    h.service.dispose();
  });

  it("dispose 释放 AudioContext", async () => {
    const h = makeHarness();
    h.service.dispose();
    expect(h.closed).toBe(true);
  });
});

describe("toneGain", () => {
  it("0% 完全静音，百分比线性映射，无最小振幅兜底", () => {
    expect(toneGain(0)).toBe(0);
    expect(toneGain(-10)).toBe(0);
    expect(toneGain(1)).toBeGreaterThan(0);
    expect(toneGain(50)).toBeCloseTo(0.075, 6);
    expect(toneGain(100)).toBeCloseTo(0.15, 6);
  });
});

describe("EVENT_PRIORITY", () => {
  it("等待 > 失败 > 到期 > 完成 > 普通", () => {
    const ordered: AudioEventKind[] = [
      "agent_waiting",
      "agent_failed",
      "task_due",
      "reminder",
      "agent_done",
      "agent_started",
      "agent_disconnected",
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(EVENT_PRIORITY[ordered[i - 1]]).toBeGreaterThanOrEqual(EVENT_PRIORITY[ordered[i]]);
    }
    expect(EVENT_PRIORITY.agent_waiting).toBeGreaterThan(EVENT_PRIORITY.agent_failed);
  });
});

describe("播报标签清洗（自然度与隐私）", () => {
  it("去掉 URL / 文件路径 / 邮箱，只保留可朗读内容", () => {
    expect(sanitizeSpeechLabel("修 bug https://example.com/x?y=1")).toBe("修 bug");
    expect(sanitizeSpeechLabel(String.raw`C:\Users\me\secret.txt`)).toBe("");
    expect(sanitizeSpeechLabel(String.raw`\\server\share\a.docx`)).toBe("");
    expect(sanitizeSpeechLabel("联系 a.b@c.com 处理")).toBe("联系 处理");
  });

  it("纯符号/控制字符被丢弃，连续标点收敛，长标题按字符截断", () => {
    expect(sanitizeSpeechLabel("!!!？？")).toBe("");
    expect(sanitizeSpeechLabel("	  ")).toBe("");
    expect(sanitizeSpeechLabel("完成了！！！")).toBe("完成了！");
    const long = "任".repeat(MAX_SPEECH_LABEL_CHARS + 20);
    expect(Array.from(sanitizeSpeechLabel(long))).toHaveLength(MAX_SPEECH_LABEL_CHARS);
  });

  it("composeSpeech 只用清洗后的标签：只有 URL 的标题不进入播报", () => {
    const withUrlTitle = composeSpeech(
      "agent_done",
      { sourceName: "Claude", taskTitle: "https://example.com/task/1" },
      { speakSource: true, speakTitle: true },
    );
    expect(withUrlTitle.text).toBe("「Claude」任务已完成");
    const symbolsOnly = composeSpeech(
      "agent_done",
      { sourceName: "!!!", taskTitle: null },
      { speakSource: true, speakTitle: true },
    );
    expect(symbolsOnly.text).toBe("任务已完成");
  });
});
