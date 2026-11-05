/**
 * @vitest-environment jsdom
 */
//! 音频设置分组：语音缺失提示、开关持久化、试听与缓存操作。
//! 只断言设置页行为；真实合成/播放由后端与真机取证覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  interface PreviewResult {
    ok: boolean;
    code: string;
    voiceName?: string;
    fallback?: boolean;
  }
  const settings = {
    notify_muted: false,
    tts_enabled: false,
    tts_voice_id: "",
    tts_voice_gender: "auto",
    tts_volume: 80,
    tts_rate: 100,
    tts_cache_enabled: true,
    tts_cache_max_mb: 50,
    audio_sound_enabled: true,
    audio_sound_volume: 70,
  };
  return {
    settings,
    update: vi.fn(async () => settings),
    toast: vi.fn(),
    previewTone: vi.fn<() => Promise<PreviewResult>>(async () => ({ ok: true, code: "ok" })),
    previewSpeech: vi.fn<() => Promise<PreviewResult>>(async () => ({
      ok: true,
      code: "ok",
      voiceName: "Microsoft Huihui",
      fallback: false,
    })),
    listVoices: vi.fn(),
    cacheStats: vi.fn(),
    cacheClear: vi.fn(),
  };
});

vi.mock("../../store/useSettingsStore", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: mocks.settings, update: mocks.update }),
}));

vi.mock("../../store/useUiStore", () => ({
  useUiStore: (selector: (state: unknown) => unknown) => selector({ showToast: mocks.toast }),
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock("../../lib/audioNotification", () => ({
  getAudioService: () => ({
    previewTone: mocks.previewTone,
    previewSpeech: mocks.previewSpeech,
  }),
}));

vi.mock("../../lib/bridge", () => ({
  ttsListVoices: mocks.listVoices,
  ttsCacheStats: mocks.cacheStats,
  ttsCacheClear: mocks.cacheClear,
}));

import AudioSettings from "./AudioSettings";
import type { SettingsSectionOpenState } from "../../lib/settingsSections";

const OPEN = {
  appearance: false,
  navigation: false,
  "window-hotkeys": false,
  features: false,
  apps: false,
  clipboard: false,
  notifications: false,
  "audio-sound": false,
  tts: true,
  "tts-cache": true,
  agent: false,
  data: false,
  diagnostics: false,
  developer: false,
} as const;

beforeEach(() => {
  mocks.update.mockClear();
  mocks.toast.mockClear();
  mocks.previewTone.mockClear();
  mocks.previewSpeech.mockClear();
  mocks.listVoices.mockReset();
  mocks.cacheStats.mockReset();
  mocks.cacheClear.mockReset();
  mocks.listVoices.mockResolvedValue({
    ok: true,
    code: "ok",
    message: "",
    platform: "windows",
    hasChineseMale: true,
    hasChineseFemale: false,
    voices: [
      {
        id: "female-id",
        name: "Huihui",
        language: "zh-CN",
        gender: "female",
        available: true,
      },
      {
        id: "male-id",
        name: "Kangkang",
        language: "zh-CN",
        gender: "male",
        available: true,
      },
    ],
  });
  mocks.cacheStats.mockResolvedValue({
    ok: true,
    enabled: true,
    bytes: 1024,
    files: 2,
    maxBytes: 50 * 1024 * 1024,
    hits: 3,
    misses: 1,
    writes: 2,
    evictions: 0,
    memoryHits: 0,
  });
  mocks.cacheClear.mockResolvedValue({ ok: true, freedBytes: 1024, removedFiles: 2 });
});

afterEach(() => {
  cleanup();
});

function renderPanel(openSections: SettingsSectionOpenState = OPEN) {
  return render(<AudioSettings openSections={openSections} onToggle={() => {}} />);
}

describe("AudioSettings", () => {
  it("缺中文女声时显示不可用提示，不伪造选项", async () => {
    renderPanel();
    await waitFor(() => expect(mocks.listVoices).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("settings.audio.missingFemale")).toBeTruthy();
    expect(screen.queryByText("settings.audio.missingMale")).toBeNull();
  });

  it("开关写入使用后端键名", () => {
    renderPanel();
    const toggle = screen.getByRole("switch", { name: "settings.audio.ttsEnabled" });
    fireEvent.click(toggle);
    expect(mocks.update).toHaveBeenCalledWith({ tts_enabled: true });
  });

  it("语音读取失败显示错误并允许继续使用其他设置", async () => {
    mocks.listVoices.mockRejectedValueOnce(new Error("WinRT 不可用"));
    renderPanel();
    expect(
      await screen.findByText('settings.audio.voiceLoadFailed|{"error":"WinRT 不可用"}'),
    ).toBeTruthy();
  });

  it("试听与清理按钮走统一服务/命令并反馈结果", async () => {
    renderPanel();
    await waitFor(() => expect(mocks.cacheStats).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "settings.audio.previewSpeech" }));
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
    expect(mocks.toast).toHaveBeenCalledWith(
      'settings.audio.previewVoice|{"voice":"Microsoft Huihui"}',
    );

    fireEvent.click(screen.getByRole("button", { name: "settings.ttsCache.clear" }));
    await waitFor(() => expect(mocks.cacheClear).toHaveBeenCalledTimes(1));
    expect(mocks.toast).toHaveBeenCalledWith(
      'settings.ttsCache.cleared|{"files":2,"bytes":"1.0 KB"}',
    );
  });

  it("缓存统计失败显示真实错误，不显示 0 B", async () => {
    mocks.cacheStats.mockRejectedValueOnce(new Error("目录不可读"));
    renderPanel();
    expect(
      await screen.findByText('settings.ttsCache.readError|{"error":"目录不可读"}'),
    ).toBeTruthy();
    expect(screen.getByText("settings.ttsCache.readFailed")).toBeTruthy();
  });

  it("试听音量 0 时显示单通道静音提示，不显示试听成功", async () => {
    mocks.previewSpeech.mockResolvedValueOnce({ ok: false, code: "silent_speech" });
    renderPanel({ ...OPEN, "audio-sound": true });
    await waitFor(() => expect(mocks.listVoices).toHaveBeenCalled());
    const speechButton = screen.getByRole("button", {
      name: "settings.audio.previewSpeech",
    }) as HTMLButtonElement;
    await waitFor(() => expect(speechButton.disabled).toBe(false));
    fireEvent.click(speechButton);
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
    expect(mocks.toast).toHaveBeenCalledWith("settings.audio.previewSilentSpeech");
    expect(mocks.toast).not.toHaveBeenCalledWith("settings.audio.previewOk");

    mocks.previewTone.mockResolvedValueOnce({ ok: false, code: "silent_tone" });
    const toneButton = screen.getByRole("button", {
      name: "settings.audio.previewSound",
    }) as HTMLButtonElement;
    await waitFor(() => expect(toneButton.disabled).toBe(false));
    fireEvent.click(toneButton);
    await waitFor(() => expect(mocks.previewTone).toHaveBeenCalledTimes(1));
    expect(mocks.toast).toHaveBeenCalledWith("settings.audio.previewSilentTone");
  });
});
