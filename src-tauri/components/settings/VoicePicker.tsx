//! 统一音色选择器（设置页「语音播报」分组内）。
//!
//! 设计目标：让用户在**不应用**设置的前提下逐项试听并比较音色。
//! - 行内试听按钮：只播放该音色，不写设置；再次点击停止；切换试听会中止上一条；
//! - 选中（点击行）才写入默认音色，并同步声音偏好，避免偏好与实际播放不一致；
//! - 引擎选择如实展示可用性：未集成的高品质引擎显示为不可用并给出原因，
//!   不伪造音色、不静默回退（后端同样拒绝不可用引擎）；
//! - 列表紧凑可滚动、支持筛选与键盘上下导航，复用设置页既有卡片与 Token。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Play, Square } from "lucide-react";
import { Select } from "../ui";
import {
  getAudioService,
  PREVIEW_MAX_CHARS,
  PREVIEW_PHRASES,
  type AudioPreviewResult,
  type PreviewStage,
} from "../../lib/audioNotification";
import { previewMessage } from "../../lib/audioPreview";
import { useUiStore } from "../../store/useUiStore";
import { useLocale } from "../../hooks/useLocale";
import type { TtsEngineInfo, TtsVoiceInfo } from "../../lib/bridge";

export const AUTO_VOICE_ROW = "__auto__";

type VoiceFilter = "all" | "zh" | "en" | "male" | "female";

interface VoicePickerProps {
  voices: TtsVoiceInfo[];
  engines: TtsEngineInfo[];
  loading: boolean;
  error: string | null;
  /** 当前保存的音色 ID；空串 = 自动 */
  selectedId: string;
  /** 声音偏好：auto | male | female（自动行试听时使用） */
  gender: string;
  rate: number;
  disabled?: boolean;
  /** 用户点击行：null = 自动；调用方负责持久化 */
  onSelect: (voice: TtsVoiceInfo | null) => void;
}

function isChineseVoice(voice: TtsVoiceInfo): boolean {
  return /^zh/i.test(voice.language);
}

function englishOrChineseLabel(voice: TtsVoiceInfo): string {
  return isChineseVoice(voice) ? "zh" : "en";
}

export default function VoicePicker({
  voices,
  engines,
  loading,
  error,
  selectedId,
  gender,
  rate,
  disabled = false,
  onSelect,
}: VoicePickerProps) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const [filter, setFilter] = useState<VoiceFilter>("all");
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [customText, setCustomText] = useState("");
  const [preview, setPreview] = useState<{ id: string; stage: PreviewStage } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 试听代次：快速连续点击时，只允许最后一次的结果更新 UI / 弹错误。 */
  const previewToken = useRef(0);

  const engineLabel = useCallback(
    (engine: TtsEngineInfo) =>
      engine.id === "system"
        ? t("settings.audio.engine.system")
        : engine.id === "neural"
          ? t("settings.audio.engine.neural")
          : engine.name,
    [t],
  );

  const engineReason = useCallback(
    (engine: TtsEngineInfo) => {
      if (engine.reason === "not_integrated") return t("settings.audio.engine.notIntegrated");
      if (engine.reason === "unsupported_platform") {
        return t("settings.audio.engine.unsupported");
      }
      return engine.detail;
    },
    [t],
  );

  const neural = engines.find((e) => e.id === "neural");
  const filtered = useMemo(() => {
    switch (filter) {
      case "zh":
        return voices.filter(isChineseVoice);
      case "en":
        return voices.filter((v) => !isChineseVoice(v));
      case "male":
        return voices.filter((v) => v.gender === "male");
      case "female":
        return voices.filter((v) => v.gender === "female");
      default:
        return voices;
    }
  }, [voices, filter]);

  /** 试听文本：预设短语或用户自定义（不落盘、不写入设置）。 */
  const previewText = useMemo(() => {
    const custom = customText.trim();
    if (phraseIndex >= PREVIEW_PHRASES.length) return custom;
    return PREVIEW_PHRASES[phraseIndex] ?? "";
  }, [phraseIndex, customText]);

  const stopPreview = useCallback(() => {
    previewToken.current += 1;
    getAudioService().stopPreview();
    setPreview(null);
  }, []);

  // 离开设置页/卸载：停止试听，不遗留播放控制器。
  useEffect(() => {
    return () => {
      previewToken.current += 1;
      getAudioService().stopPreview();
    };
  }, []);

  const togglePreview = useCallback(
    async (rowId: string, voice: TtsVoiceInfo | null) => {
      if (disabled) return;
      // 再次点击同一条：停止。
      if (preview && preview.id === rowId) {
        stopPreview();
        return;
      }
      const text = previewText;
      if (!text) {
        showToast(t("settings.audio.previewTextEmpty"), { kind: "warning" });
        return;
      }
      const token = ++previewToken.current;
      // 先中止上一条，保证同一时刻只有一条试听。
      getAudioService().stopPreview();
      setPreview({ id: rowId, stage: "synthesizing" });
      const result: AudioPreviewResult = await getAudioService().previewSpeech({
        voiceId: voice ? voice.id : "",
        gender: voice && (voice.gender === "male" || voice.gender === "female") ? voice.gender : gender,
        rate,
        text,
        onStage: (stage) => {
          if (previewToken.current === token) setPreview({ id: rowId, stage });
        },
      });
      if (previewToken.current !== token) return;
      setPreview(null);
      // 成功不弹提示（按钮状态即反馈）；回退/失败必须如实说明。
      if (result.ok) {
        if (result.fallback) {
          showToast(previewMessage(result, t), { kind: "warning" });
        }
        return;
      }
      if (result.code !== "cancelled") {
        showToast(previewMessage(result, t), { kind: "error" });
      }
    },
    [disabled, gender, preview, previewText, rate, showToast, stopPreview, t],
  );

  /** 列表内键盘导航：上下/Home/End 在可选行之间移动焦点（Enter/Space 由按钮原生处理）。 */
  const onListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(".voice-pick:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    if (event.key === "ArrowUp") {
      next = current <= 0 ? items.length - 1 : current - 1;
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    event.preventDefault();
    items[next]?.focus();
  }, []);

  const showFilters = voices.length > 4;
  const filters: { id: VoiceFilter; label: string }[] = [
    { id: "all", label: t("settings.audio.filter.all") },
    { id: "zh", label: t("settings.audio.filter.zh") },
    { id: "en", label: t("settings.audio.filter.en") },
    { id: "male", label: t("settings.audio.filter.male") },
    { id: "female", label: t("settings.audio.filter.female") },
  ];

  return (
    <div className="voice-picker">
      {/* 引擎选择：系统引擎恒可用；高品质引擎如实报告未启用状态。 */}
      <div className="voice-engine-row" role="group" aria-label={t("settings.audio.engine")}>
        <span className="voice-row-label">{t("settings.audio.engine")}</span>
        <div className="voice-chips">
          {engines.map((engine) => {
            const active = engine.available;
            return (
              <button
                key={engine.id}
                type="button"
                className={`voice-chip${active ? " is-active" : ""}`}
                aria-pressed={active}
                disabled={!engine.available}
                data-tip={engine.available ? undefined : engineReason(engine)}
                onClick={() => {
                  // 当前版本只有系统引擎可用；不可用引擎不可选，不伪造切换。
                  if (!engine.available) showToast(engineReason(engine), { kind: "info" });
                }}
              >
                {engineLabel(engine)}
              </button>
            );
          })}
        </div>
      </div>
      {neural && !neural.available && (
        <div className="setting-note voice-engine-note">
          {engineReason(neural)}
          {neural.requiresDownload ? ` · ${t("settings.audio.engine.requiresDownload")}` : ""}
        </div>
      )}

      {showFilters && (
        <div className="voice-filter-row" role="group" aria-label={t("settings.audio.filter.label")}>
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`voice-filter${filter === item.id ? " is-active" : ""}`}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {loading && voices.length === 0 && (
        <div className="setting-note">{t("settings.audio.voiceLoading")}</div>
      )}
      {error && (
        <div className="setting-note">{t("settings.audio.voiceLoadFailed", { error })}</div>
      )}

      {!error && (
        <div
          ref={listRef}
          className="voice-list"
          role="radiogroup"
          aria-label={t("settings.audio.voiceList")}
          onKeyDown={onListKeyDown}
        >
          {/* 自动选择：按系统可用声音与偏好自动解析，试听同样不改设置 */}
          <div className={`voice-row${selectedId === "" ? " is-selected" : ""}`}>
            <button
              type="button"
              role="radio"
              aria-checked={selectedId === ""}
              className="voice-pick"
              disabled={disabled}
              onClick={() => onSelect(null)}
            >
              <span className="voice-main">
                <span className="voice-name">{t("settings.audio.voiceAuto")}</span>
                <span className="voice-meta">
                  <em className="voice-badge">{t("settings.audio.autoBadge")}</em>
                </span>
              </span>
              {selectedId === "" && <Check size={13} className="voice-check" aria-hidden />}
            </button>
            <button
              type="button"
              className={`voice-preview${preview?.id === AUTO_VOICE_ROW ? " is-active" : ""}`}
              aria-label={t("settings.audio.previewVoiceAria", {
                voice: t("settings.audio.voiceAuto"),
              })}
              aria-pressed={preview?.id === AUTO_VOICE_ROW}
              disabled={disabled || voices.length === 0}
              onClick={() => void togglePreview(AUTO_VOICE_ROW, null)}
            >
              {preview?.id === AUTO_VOICE_ROW ? (
                preview.stage === "synthesizing" ? (
                  <Loader2 size={12} className="spin" aria-hidden />
                ) : (
                  <Square size={11} aria-hidden />
                )
              ) : (
                <Play size={11} aria-hidden />
              )}
            </button>
          </div>

          {filtered.map((voice) => {
            const selected = selectedId === voice.id;
            const previewing = preview?.id === voice.id;
            const genderLabel =
              voice.gender === "male"
                ? t("settings.audio.gender.male")
                : voice.gender === "female"
                  ? t("settings.audio.gender.female")
                  : t("settings.audio.gender.unknown");
            const rowName = voice.available
              ? `${voice.name} · ${genderLabel}`
              : `${voice.name}${t("settings.audio.voiceUnavailable")}`;
            return (
              <div
                key={voice.id}
                className={`voice-row${selected ? " is-selected" : ""}${
                  voice.available ? "" : " is-unavailable"
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className="voice-pick"
                  disabled={disabled || !voice.available}
                  onClick={() => onSelect(voice)}
                >
                  <span className="voice-main">
                    <span className="voice-name" title={voice.name}>
                      {voice.name}
                    </span>
                    <span className="voice-meta">
                      <em className="voice-badge">{englishOrChineseLabel(voice) === "zh" ? t("settings.audio.lang.zh") : t("settings.audio.lang.en")}</em>
                      <em className="voice-badge">{genderLabel}</em>
                      <em className="voice-badge is-muted">
                        {engineLabel(
                          engines.find((e) => e.id === voice.engine) ?? {
                            id: voice.engine,
                            name: voice.engine,
                            available: true,
                            reason: "",
                            detail: "",
                            requiresDownload: false,
                          },
                        )}
                      </em>
                      {!voice.available && (
                        <em className="voice-badge is-warn">{t("settings.audio.voiceUnavailable")}</em>
                      )}
                    </span>
                  </span>
                  {selected && <Check size={13} className="voice-check" aria-hidden />}
                </button>
                <button
                  type="button"
                  className={`voice-preview${previewing ? " is-active" : ""}`}
                  aria-label={t("settings.audio.previewVoiceAria", { voice: rowName })}
                  aria-pressed={previewing}
                  disabled={disabled || !voice.available}
                  onClick={() => void togglePreview(voice.id, voice)}
                >
                  {previewing ? (
                    preview.stage === "synthesizing" ? (
                      <Loader2 size={12} className="spin" aria-hidden />
                    ) : (
                      <Square size={11} aria-hidden />
                    )
                  ) : (
                    <Play size={11} aria-hidden />
                  )}
                </button>
              </div>
            );
          })}

          {filtered.length === 0 && !loading && (
            <div className="setting-note">{t("settings.audio.filter.empty")}</div>
          )}
        </div>
      )}

      {/* 试听内容：覆盖真实播报句式；自定义文本只在内存中使用，不持久化。 */}
      <div className="voice-preview-text">
        <span className="voice-row-label">{t("settings.audio.previewText")}</span>
        <div className="voice-preview-controls">
          <Select
            value={String(phraseIndex)}
            ariaLabel={t("settings.audio.previewText")}
            options={[
              ...PREVIEW_PHRASES.map((phrase, index) => ({
                value: String(index),
                label: phrase,
              })),
              {
                value: String(PREVIEW_PHRASES.length),
                label: t("settings.audio.previewCustom"),
              },
            ]}
            onChange={(value) => setPhraseIndex(Number(value))}
          />
          {phraseIndex >= PREVIEW_PHRASES.length && (
            <input
              className="voice-custom-input"
              type="text"
              value={customText}
              maxLength={PREVIEW_MAX_CHARS}
              placeholder={t("settings.audio.previewCustomPlaceholder", {
                n: PREVIEW_MAX_CHARS,
              })}
              aria-label={t("settings.audio.previewCustomAria")}
              onChange={(event) => setCustomText(event.target.value)}
            />
          )}
        </div>
      </div>
      <div className="setting-note">{t("settings.audio.previewHint")}</div>
    </div>
  );
}
