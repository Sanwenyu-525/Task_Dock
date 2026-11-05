//! 音频设置分组：统一提示音 / 语音播报 / 本地语音缓存。
//!
//! 只做展示与设置写入；音频播放（含试听）统一交给 `lib/audioNotification`，
//! 避免设置页产生第二个音频调度者。语音列表与缓存统计在对应分组展开时读取，
//! 关闭 TTS 时不会在后台初始化语音引擎。

import { useCallback, useEffect, useState } from "react";
import { Bell, HardDrive, Play, RefreshCw, Trash2, Volume2 } from "lucide-react";
import { CollapsibleSection } from "../ui";
import { NumberInput, Select, Switch } from "../ui";
import { formatBytes } from "../../lib/clipboardUi";
import { errorMessage } from "../../lib/errors";
import { getAudioService } from "../../lib/audioNotification";
import { previewMessage } from "../../lib/audioPreview";
import VoicePicker from "./VoicePicker";
import {
  ttsCacheClear,
  ttsCacheStats,
  ttsListVoices,
  type Settings,
  type TtsCacheReport,
  type TtsVoicesReport,
} from "../../lib/bridge";
import {
  type SettingsSectionId,
  type SettingsSectionOpenState,
} from "../../lib/settingsSections";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";

interface AudioSettingsProps {
  openSections: SettingsSectionOpenState;
  onToggle: (sectionId: SettingsSectionId) => void;
}

type BooleanSettingKey =
  | "audio_sound_agent_started"
  | "audio_sound_agent_done"
  | "audio_sound_agent_waiting"
  | "audio_sound_agent_failed"
  | "audio_sound_agent_disconnected"
  | "audio_sound_task_due"
  | "audio_sound_reminder"
  | "tts_agent_started"
  | "tts_agent_done"
  | "tts_agent_waiting"
  | "tts_agent_failed"
  | "tts_agent_disconnected"
  | "tts_task_due"
  | "tts_reminder";

const EVENTS = [
  { sound: "audio_sound_agent_started", tts: "tts_agent_started", label: "settings.audio.event.started" },
  { sound: "audio_sound_agent_done", tts: "tts_agent_done", label: "settings.audio.event.done" },
  { sound: "audio_sound_agent_waiting", tts: "tts_agent_waiting", label: "settings.audio.event.waiting" },
  { sound: "audio_sound_agent_failed", tts: "tts_agent_failed", label: "settings.audio.event.failed" },
  {
    sound: "audio_sound_agent_disconnected",
    tts: "tts_agent_disconnected",
    label: "settings.audio.event.disconnected",
  },
  { sound: "audio_sound_task_due", tts: "tts_task_due", label: "settings.audio.event.taskDue" },
  { sound: "audio_sound_reminder", tts: "tts_reminder", label: "settings.audio.event.reminder" },
] as const;

const DEFAULT_EVENT_ON: Record<string, boolean> = {
  audio_sound_agent_started: false,
  audio_sound_agent_done: true,
  audio_sound_agent_waiting: true,
  audio_sound_agent_failed: true,
  audio_sound_agent_disconnected: false,
  audio_sound_task_due: true,
  audio_sound_reminder: true,
  tts_agent_started: false,
  tts_agent_done: true,
  tts_agent_waiting: true,
  tts_agent_failed: true,
  tts_agent_disconnected: false,
  tts_task_due: true,
  tts_reminder: true,
};

export default function AudioSettings({ openSections, onToggle }: AudioSettingsProps) {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);
  const [voices, setVoices] = useState<TtsVoicesReport | null>(null);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [cache, setCache] = useState<TtsCacheReport | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const ttsOpen = openSections.tts;
  const cacheOpen = openSections["tts-cache"];

  // 语音列表只在分组展开时读取；关闭分组后不再持有异步结果。
  useEffect(() => {
    if (!ttsOpen) return;
    let cancelled = false;
    setVoiceLoading(true);
    setVoiceError(null);
    ttsListVoices()
      .then((report) => {
        if (cancelled) return;
        // 防御异常 IPC 载荷：缺字段时按读取失败处理，不抛 TypeError 到 UI。
        if (!report || typeof report !== "object") {
          setVoiceError(t("settings.audio.previewFailed"));
          setVoices(null);
          return;
        }
        if (!report.ok) {
          setVoiceError(report.message || report.code);
          setVoices(null);
        } else {
          setVoices({
            ...report,
            voices: Array.isArray(report.voices) ? report.voices : [],
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setVoiceError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setVoiceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ttsOpen]);

  const loadCache = useCallback(async () => {
    try {
      setCacheError(null);
      setCache(await ttsCacheStats());
    } catch (e) {
      setCacheError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (cacheOpen) void loadCache();
  }, [cacheOpen, loadCache]);

  if (!settings) return null;

  const soundVolume = settings.audio_sound_volume ?? 70;
  const ttsVolume = settings.tts_volume ?? 80;
  const ttsRate = settings.tts_rate ?? 100;
  const cacheMaxMb = settings.tts_cache_max_mb ?? 50;
  const gender = settings.tts_voice_gender ?? "auto";
  const selectedVoice = voices?.voices.find((v) => v.id === settings.tts_voice_id);
  const selectedVoiceUnavailable =
    Boolean(settings.tts_voice_id) &&
    (voices === null ? false : !selectedVoice || !selectedVoice.available);

  const setEvent = (key: BooleanSettingKey, value: boolean) => {
    save({ [key]: value } as Partial<Settings>);
  };

  async function onPreviewTone() {
    setBusy("tone");
    try {
      showToast(previewMessage(await getAudioService().previewTone(), t));
    } finally {
      setBusy(null);
    }
  }

  async function onClearCache() {
    setBusy("cache-clear");
    try {
      const report = await ttsCacheClear();
      showToast(
        t("settings.ttsCache.cleared", {
          files: report.removedFiles,
          bytes: formatBytes(report.freedBytes),
        }),
      );
      await loadCache();
    } catch (e) {
      showToast(t("settings.ttsCache.clearFailed", { error: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function onChangeMax(value: number) {
    try {
      await update({ tts_cache_max_mb: value });
      await loadCache();
    } catch (e) {
      showToast(t("settings.ttsCache.limitFailed", { error: errorMessage(e) }));
    }
  }

  /**
   * 设置写入统一入口：失败必须就地反馈（一项设置写失败不等于界面坏了）。
   *
   * 音频分组里大多是 Switch / 下拉 / 数字框，事件处理器无法 await；不接住
   * rejection 会落到全局未处理异常通道，被当成「后台任务失败」提示，文案与
   * 实际操作对不上。这里给出结构化文案并保持原值（开关由 store 值驱动，自动回弹）。
   */
  function save(patch: Partial<Settings>) {
    void update(patch).catch((e) => {
      showToast(t("settings.audio.saveFailed", { error: errorMessage(e) }), {
        kind: "error",
      });
    });
  }

  return (
    <>
      <CollapsibleSection
        id="settings-audio-sound"
        className="settings-collapsible"
        icon={<Bell size={13} />}
        title={t("settings.section.audioSound")}
        description={t("settings.section.audioSoundDesc")}
        expanded={openSections["audio-sound"]}
        onExpandedChange={() => onToggle("audio-sound")}
      >
        <div className="setting-row">
          <span>{t("settings.audio.soundEnabled")}</span>
          <Switch
            checked={settings.audio_sound_enabled ?? true}
            ariaLabel={t("settings.audio.soundEnabled")}
            onChange={(v) => save({ audio_sound_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.audio.soundVolume")}</span>
          <div className="btn-row">
            <NumberInput
              size="sm"
              min={0}
              max={100}
              value={soundVolume}
              suffix="%"
              ariaLabel={t("settings.audio.soundVolume")}
              onChange={(v) => save({ audio_sound_volume: v })}
            />
            <button
              className="btn sm"
              onClick={onPreviewTone}
              disabled={busy !== null}
              aria-label={t("settings.audio.previewSound")}
            >
              {busy === "tone" ? <RefreshCw size={11} className="spin" /> : <Play size={11} />}{" "}
              {t("settings.audio.preview")}
            </button>
          </div>
        </div>
        {EVENTS.map((event) => (
          <div className="setting-row" key={event.sound}>
            <span>{t(event.label as MessageKey)}</span>
            <Switch
              checked={
                (settings[event.sound] as boolean | undefined) ??
                DEFAULT_EVENT_ON[event.sound]
              }
              ariaLabel={t(event.label as MessageKey)}
              onChange={(v) => setEvent(event.sound as BooleanSettingKey, v)}
            />
          </div>
        ))}
        <div className="setting-note">{t("settings.audio.soundNote")}</div>
      </CollapsibleSection>

      <CollapsibleSection
        id="settings-tts"
        className="settings-collapsible"
        icon={<Volume2 size={13} />}
        title={t("settings.section.tts")}
        description={t("settings.section.ttsDesc")}
        expanded={ttsOpen}
        onExpandedChange={() => onToggle("tts")}
      >
        <div className="setting-row">
          <span>{t("settings.audio.ttsEnabled")}</span>
          <Switch
            checked={settings.tts_enabled ?? false}
            ariaLabel={t("settings.audio.ttsEnabled")}
            onChange={(v) => save({ tts_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.audio.gender")}</span>
          <Select
            value={gender}
            ariaLabel={t("settings.audio.gender")}
            options={[
              { value: "auto", label: t("settings.audio.gender.auto") },
              { value: "female", label: t("settings.audio.gender.female") },
              { value: "male", label: t("settings.audio.gender.male") },
            ]}
            onChange={(value) =>
              // 切换性别偏好时清空显式语音，避免偏好与实际播放不一致。
              save({ tts_voice_gender: value as "auto" | "female" | "male", tts_voice_id: "" })
            }
          />
        </div>
        {/* 统一音色选择器：逐项试听（不应用）、点击行才保存默认音色。 */}
        <VoicePicker
          voices={voices?.voices ?? []}
          engines={voices?.engines ?? []}
          loading={voiceLoading}
          error={voiceError}
          selectedId={settings.tts_voice_id ?? ""}
          gender={gender}
          rate={ttsRate}
          onSelect={(voice) => {
            if (!voice) {
              save({ tts_voice_id: "" });
              return;
            }
            const pickedGender =
              voice.gender === "male" || voice.gender === "female" ? voice.gender : undefined;
            save({
              tts_voice_id: voice.id,
              ...(pickedGender ? { tts_voice_gender: pickedGender } : {}),
            });
          }}
        />
        {selectedVoiceUnavailable && (
          <div className="setting-note">{t("settings.audio.selectedUnavailable")}</div>
        )}
        {voices && !voices.hasChineseFemale && (
          <div className="setting-note">{t("settings.audio.missingFemale")}</div>
        )}
        {voices && !voices.hasChineseMale && (
          <div className="setting-note">{t("settings.audio.missingMale")}</div>
        )}
        {voices && voices.voices.length === 0 && (
          <div className="setting-note">{t("settings.audio.noVoices")}</div>
        )}
        <div className="setting-row">
          <span>{t("settings.audio.ttsVolume")}</span>
          <NumberInput
            size="sm"
            min={0}
            max={100}
            value={ttsVolume}
            suffix="%"
            ariaLabel={t("settings.audio.ttsVolume")}
            onChange={(v) => save({ tts_volume: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.audio.ttsRate")}</span>
          <NumberInput
            size="sm"
            min={50}
            max={200}
            step={5}
            value={ttsRate}
            suffix="%"
            ariaLabel={t("settings.audio.ttsRate")}
            onChange={(v) => save({ tts_rate: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.audio.speakSource")}</span>
          <Switch
            checked={settings.tts_speak_source ?? true}
            ariaLabel={t("settings.audio.speakSource")}
            onChange={(v) => save({ tts_speak_source: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.audio.speakTitle")}</span>
          <Switch
            checked={settings.tts_speak_title ?? false}
            ariaLabel={t("settings.audio.speakTitle")}
            onChange={(v) => save({ tts_speak_title: v })}
          />
        </div>
        {EVENTS.map((event) => (
          <div className="setting-row" key={event.tts}>
            <span>{t(event.label as MessageKey)}</span>
            <Switch
              checked={(settings[event.tts] as boolean | undefined) ?? DEFAULT_EVENT_ON[event.tts]}
              ariaLabel={t(event.label as MessageKey)}
              onChange={(v) => setEvent(event.tts as BooleanSettingKey, v)}
            />
          </div>
        ))}
        <div className="setting-note">{t("settings.audio.ttsNote")}</div>
      </CollapsibleSection>

      <CollapsibleSection
        id="settings-tts-cache"
        className="settings-collapsible"
        icon={<HardDrive size={13} />}
        title={t("settings.section.ttsCache")}
        description={t("settings.section.ttsCacheDesc")}
        expanded={cacheOpen}
        onExpandedChange={() => onToggle("tts-cache")}
      >
        <div className="setting-row">
          <span>{t("settings.ttsCache.enabled")}</span>
          <Switch
            checked={settings.tts_cache_enabled ?? true}
            ariaLabel={t("settings.ttsCache.enabled")}
            onChange={(v) => save({ tts_cache_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.ttsCache.usage")}</span>
          <div className="btn-row">
            <span className="setting-value">
              {cache
                ? t("settings.ttsCache.usageValue", {
                    used: formatBytes(cache.bytes),
                    files: cache.files,
                  })
                : cacheError
                  ? t("settings.ttsCache.readFailed")
                  : t("settings.ttsCache.loading")}
            </span>
            <button
              className="btn sm"
              onClick={() => void loadCache()}
              disabled={busy !== null}
              aria-label={t("settings.ttsCache.refresh")}
            >
              <RefreshCw size={11} /> {t("settings.ttsCache.refresh")}
            </button>
          </div>
        </div>
        {cacheError && (
          <div className="setting-note">
            {t("settings.ttsCache.readError", { error: cacheError })}
          </div>
        )}
        <div className="setting-row">
          <span>{t("settings.ttsCache.limit")}</span>
          <NumberInput
            size="sm"
            min={1}
            max={2048}
            value={cacheMaxMb}
            suffix="MB"
            ariaLabel={t("settings.ttsCache.limit")}
            onChange={(v) => void onChangeMax(v)}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.ttsCache.clear")}</span>
          <button
            className="btn sm"
            onClick={onClearCache}
            disabled={busy !== null}
            aria-label={t("settings.ttsCache.clear")}
          >
            {busy === "cache-clear" ? (
              <RefreshCw size={11} className="spin" />
            ) : (
              <Trash2 size={11} />
            )}{" "}
            {t("settings.ttsCache.clearAction")}
          </button>
        </div>
        <div className="setting-note">{t("settings.ttsCache.note")}</div>
      </CollapsibleSection>
    </>
  );
}
