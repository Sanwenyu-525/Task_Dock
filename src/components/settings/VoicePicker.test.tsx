/**
 * @vitest-environment jsdom
 */
//! 统一音色选择器（VoicePicker）：
//! - 逐项试听只发生在该音色上，**不写入任何设置**；再次点击停止；
//! - 切换试听先中止上一条；失败/回退如实提示；
//! - 点击行才是「选择默认音色」；不可用音色不可选、引擎不可用如实展示；
//! - 筛选只在音色较多时出现；键盘上下移动焦点；自定义试听文本不持久化。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  previewSpeech: vi.fn(
    async (
      _opts?: unknown,
    ): Promise<{ ok: boolean; code: string; voiceName?: string; fallback?: boolean }> => ({
      ok: true,
      code: "ok",
      voiceName: "Huihui",
      fallback: false,
    }),
  ),
  stopPreview: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/audioNotification", () => ({
  getAudioService: () => ({
    previewSpeech: mocks.previewSpeech,
    stopPreview: mocks.stopPreview,
  }),
  PREVIEW_PHRASES: ["任务已完成", "需要你的操作", "你的日程提醒时间到了"],
  PREVIEW_MAX_CHARS: 40,
}));

vi.mock("../../store/useUiStore", () => ({
  useUiStore: (selector: (s: { showToast: typeof mocks.toast }) => unknown) =>
    selector({ showToast: mocks.toast }),
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import VoicePicker, { AUTO_VOICE_ROW } from "./VoicePicker";
import type { TtsEngineInfo, TtsVoiceInfo } from "../../lib/bridge";

const ENGINES: TtsEngineInfo[] = [
  {
    id: "system",
    name: "系统语音",
    available: true,
    reason: "",
    detail: "",
    requiresDownload: false,
  },
  {
    id: "neural",
    name: "高品质语音",
    available: false,
    reason: "not_integrated",
    detail: "",
    requiresDownload: true,
  },
];

const VOICES: TtsVoiceInfo[] = [
  { id: "f-zh", name: "Huihui", language: "zh-CN", gender: "female", engine: "system", available: true },
  { id: "m-zh", name: "Kangkang", language: "zh-CN", gender: "male", engine: "system", available: true },
  { id: "f-en", name: "Zira", language: "en-US", gender: "female", engine: "system", available: true },
  { id: "m-en", name: "David", language: "en-US", gender: "male", engine: "system", available: true },
  { id: "gone", name: "Removed Voice", language: "zh-CN", gender: "female", engine: "system", available: false },
];

const baseProps = {
  voices: VOICES,
  engines: ENGINES,
  loading: false,
  error: null as string | null,
  selectedId: "f-zh",
  gender: "auto",
  rate: 100,
};

function renderPicker(overrides: Partial<typeof baseProps> = {}, onSelect = vi.fn()) {
  const utils = render(<VoicePicker {...baseProps} {...overrides} onSelect={onSelect} />);
  return { ...utils, onSelect };
}

/** 音色行的试听按钮（aria-label 以「试听」开头，自动行同样适用）。 */
const previewButton = (name: string) =>
  screen.getByRole("button", { name: `settings.audio.previewVoiceAria|{"voice":"${name}"}` });

beforeEach(() => {
  mocks.previewSpeech.mockClear();
  mocks.stopPreview.mockClear();
  mocks.toast.mockClear();
  mocks.previewSpeech.mockImplementation(async () => ({
    ok: true,
    code: "ok",
    voiceName: "Huihui",
    fallback: false,
  }));
});

afterEach(() => {
  cleanup();
});

describe("VoicePicker", () => {
  it("列出系统音色与引擎状态；未集成的高品质引擎不可用且说明原因", () => {
    renderPicker();
    expect(screen.getByRole("radio", { name: /Huihui/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Kangkang/ })).toBeTruthy();
    const neural = screen.getByRole("button", {
      name: "settings.audio.engine.neural",
    }) as HTMLButtonElement;
    expect(neural.disabled).toBe(true);
    expect(screen.getByText(/settings.audio.engine.notIntegrated/)).toBeTruthy();
    // 当前选中的音色有 aria-checked，其余没有
    expect(
      screen.getByRole("radio", { name: /Huihui/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: /Kangkang/ }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("逐项试听：只试听该音色，不修改默认音色（不触发 onSelect）", async () => {
    const { onSelect } = renderPicker();
    fireEvent.click(previewButton("Huihui · settings.audio.gender.female"));
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
    const opts = mocks.previewSpeech.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.voiceId).toBe("f-zh");
    expect(opts.gender).toBe("female");
    expect(opts.text).toBe("任务已完成");
    expect(opts.persist).toBeUndefined();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("播放中再次点击同一试听按钮：停止播放，不新增合成", async () => {
    let release!: (v: unknown) => void;
    mocks.previewSpeech.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }) as never,
    );
    renderPicker();
    const button = previewButton("Huihui · settings.audio.gender.female");
    fireEvent.click(button);
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
    // 合成/播放未结束时再次点击：只停止，不再发起第二次合成
    // （第一次开始试听前也会先清空播放通道，因此 stopPreview 共 2 次）
    fireEvent.click(button);
    expect(mocks.stopPreview).toHaveBeenCalledTimes(2);
    expect(mocks.previewSpeech).toHaveBeenCalledTimes(1);
    // 服务中止后返回 cancelled（真实适配器的行为）
    release({ ok: false, code: "cancelled" });
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
  });

  it("切换试听会先中止上一条", async () => {
    renderPicker();
    fireEvent.click(previewButton("Huihui · settings.audio.gender.female"));
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
    fireEvent.click(previewButton("Kangkang · settings.audio.gender.male"));
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(2));
    expect(mocks.stopPreview).toHaveBeenCalled();
    const second = mocks.previewSpeech.mock.calls[1][0] as Record<string, unknown>;
    expect(second.voiceId).toBe("m-zh");
    expect(second.gender).toBe("male");
  });

  it("试听失败如实提示，不修改设置", async () => {
    mocks.previewSpeech.mockResolvedValueOnce({ ok: false, code: "no_voice" });
    const { onSelect } = renderPicker();
    fireEvent.click(previewButton("Huihui · settings.audio.gender.female"));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("settings.audio.previewNoVoice", {
        kind: "error",
      }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("试听回退（所选声音不可用）给出警告，不假装是目标声音", async () => {
    mocks.previewSpeech.mockResolvedValueOnce({
      ok: true,
      code: "ok",
      voiceName: "Yaoyao",
      fallback: true,
    });
    renderPicker();
    fireEvent.click(previewButton("Kangkang · settings.audio.gender.male"));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'settings.audio.previewFallback|{"voice":"Yaoyao"}',
        { kind: "warning" },
      ),
    );
  });

  it("点击行才选择默认音色；不可用音色不可选", () => {
    const { onSelect } = renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /Kangkang/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "m-zh" }));
    const removed = screen.getByRole("radio", { name: /Removed Voice/ }) as HTMLButtonElement;
    expect(removed.disabled).toBe(true);
  });

  it("筛选只在音色较多时出现，且只影响列表展示", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: "settings.audio.filter.male" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "settings.audio.filter.male" }));
    expect(screen.getByRole("radio", { name: /Kangkang/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Huihui/ })).toBeNull();

    cleanup();
    renderPicker({ voices: VOICES.slice(0, 2) });
    expect(screen.queryByRole("button", { name: "settings.audio.filter.male" })).toBeNull();
  });

  it("自动行：aria-checked 随空选中态，试听按声音偏好下发", async () => {
    renderPicker({ selectedId: "", gender: "female" });
    const auto = screen.getByRole("radio", { name: /settings.audio.voiceAuto/ });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(previewButton("settings.audio.voiceAuto"));
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
    const opts = mocks.previewSpeech.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.voiceId).toBe("");
    expect(opts.gender).toBe("female");
  });

  it("自定义试听文本：受长度上限约束，只用于本次试听", async () => {
    renderPicker();
    const select = screen.getByRole("combobox", { name: "settings.audio.previewText" });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "settings.audio.previewCustom" }));
    const input = screen.getByRole("textbox", {
      name: "settings.audio.previewCustomAria",
    }) as HTMLInputElement;
    expect(input.maxLength).toBe(40);
    fireEvent.change(input, { target: { value: "自定义试听内容" } });
    fireEvent.click(previewButton("Huihui · settings.audio.gender.female"));
    await waitFor(() => expect(mocks.previewSpeech).toHaveBeenCalledTimes(1));
    expect((mocks.previewSpeech.mock.calls[0][0] as Record<string, unknown>).text).toBe(
      "自定义试听内容",
    );
  });

  it("键盘：上下键在行之间移动焦点，Home/End 到首尾", () => {
    renderPicker();
    const group = screen.getByRole("radiogroup", { name: "settings.audio.voiceList" });
    const first = screen.getByRole("radio", { name: /settings.audio.voiceAuto/ }) as HTMLElement;
    first.focus();
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Huihui/ }));
    fireEvent.keyDown(group, { key: "End" });
    // 不可用音色不可选，键盘只在可选行之间移动
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /David/ }));
    fireEvent.keyDown(group, { key: "Home" });
    expect(document.activeElement).toBe(first);
    // 自动行常量与列表首行一致（防止选择器与实现漂移）
    expect(AUTO_VOICE_ROW).toBe("__auto__");
  });
});
