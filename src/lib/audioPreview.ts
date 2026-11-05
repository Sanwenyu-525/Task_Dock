//! 试听结果 → 用户文案（设置页提示音与逐音色试听共用）。
//!
//! 只做结构化 code 到本地化文案的映射，不在这里弹 Toast：调用方决定
//! 成功静默（按钮状态即反馈）还是失败提示。

import type { MessageKey } from "../i18n";
import type { AudioPreviewResult } from "./audioNotification";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function previewMessage(result: AudioPreviewResult, t: Translate): string {
  if (result.ok) {
    if (result.fallback && result.voiceName) {
      return t("settings.audio.previewFallback", { voice: result.voiceName });
    }
    if (result.voiceName) return t("settings.audio.previewVoice", { voice: result.voiceName });
    return t("settings.audio.previewOk");
  }
  switch (result.code) {
    case "muted":
      return t("settings.audio.previewMuted");
    case "silent_tone":
      return t("settings.audio.previewSilentTone");
    case "silent_speech":
      return t("settings.audio.previewSilentSpeech");
    case "busy":
      return t("settings.audio.previewBusy");
    case "no_voice":
    case "noVoice":
      return t("settings.audio.previewNoVoice");
    case "unsupported":
      return t("settings.audio.previewUnsupported");
    case "cancelled":
      return t("settings.audio.previewCancelled");
    case "engine_unavailable":
      return t("settings.audio.previewEngineUnavailable");
    case "text_empty":
      return t("settings.audio.previewTextEmpty");
    case "text_too_long":
      return t("settings.audio.previewTextTooLong");
    default:
      return t("settings.audio.previewFailed");
  }
}
