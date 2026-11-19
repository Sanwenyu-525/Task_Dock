//! 音频预览：TaskDock 视觉规范的自定义控制条（播放/暂停、进度、音量、时长），
//! 而不是把浏览器默认 `<audio>` 直接摆进对话框。

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Music2, Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { useMediaPreviewUrl } from "./useMediaPreviewUrl";
import { PreviewError } from "./PreviewState";

interface Props {
  path: string;
  name: string;
  size: number | null;
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export default function FileAudioPreview({ path, name }: Props) {
  const { t } = useLocale();
  const media = useMediaPreviewUrl(path);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // 切换文件/重试时重置播放态（音频元素随 URL 重建）。
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [media.url]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        media.markError(t("fw.preview.playbackFailed"));
      }
    } else {
      audio.pause();
    }
  };

  const onSeek = (value: number) => {
    const audio = audioRef.current;
    setCurrent(value);
    if (audio && Number.isFinite(value)) audio.currentTime = value;
  };

  const onVolume = (value: number) => {
    const audio = audioRef.current;
    const nextMuted = value === 0;
    setVolume(value);
    setMuted(nextMuted);
    if (audio) {
      audio.volume = value;
      // 从静音拖动音量时必须同步解除 muted，否则「有音量但没声音」。
      audio.muted = nextMuted;
    }
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    const next = !muted;
    setMuted(next);
    if (audio) audio.muted = next;
  };

  if (media.error) {
    return (
      <PreviewError
        title={t("fw.preview.error", { error: media.error })}
        hint={t("fw.preview.fallbackOpen")}
        onRetry={media.retry}
        retryLabel={t("common.retry")}
      />
    );
  }

  const progress = duration > 0 ? (current / duration) * 100 : 0;
  const volumePercent = muted ? 0 : Math.round(volume * 100);

  return (
    <div className="fw-preview-audio">
      <div className="fw-preview-audio-art" aria-hidden="true">
        <Music2 size={34} />
      </div>
      <div className="fw-preview-audio-title" title={name}>
        {name}
      </div>
      <div className="fw-preview-audio-controls">
        <button
          type="button"
          className="fw-preview-audio-play"
          aria-label={playing ? t("fw.preview.audio.pause") : t("fw.preview.audio.play")}
          aria-pressed={playing}
          disabled={!media.url}
          onClick={() => void togglePlay()}
        >
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <div className="fw-preview-audio-track">
          <input
            type="range"
            className="fw-preview-range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(current, duration || 0)}
            aria-label={t("fw.preview.audio.seek")}
            style={{ "--fw-range-progress": `${progress}%` } as CSSProperties}
            onChange={(e) => onSeek(Number(e.target.value))}
          />
          <div className="fw-preview-audio-times">
            <span>{clock(current)}</span>
            <span>{duration > 0 ? clock(duration) : media.loading ? t("fw.preview.loading") : "--:--"}</span>
          </div>
        </div>
        <div className="fw-preview-audio-volume">
          <button
            type="button"
            className="fw-icon-btn"
            aria-label={muted ? t("fw.preview.audio.unmute") : t("fw.preview.audio.mute")}
            onClick={toggleMute}
          >
            {muted || volume === 0 ? (
              <VolumeX size={15} aria-hidden="true" />
            ) : volume < 0.5 ? (
              <Volume1 size={15} aria-hidden="true" />
            ) : (
              <Volume2 size={15} aria-hidden="true" />
            )}
          </button>
          <input
            type="range"
            className="fw-preview-range is-volume"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            aria-label={t("fw.preview.audio.volume")}
            style={{ "--fw-range-progress": `${volumePercent}%` } as CSSProperties}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
        </div>
      </div>
      {media.url && (
        <audio
          ref={audioRef}
          className="fw-preview-audio-el"
          src={media.url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0);
            media.markReady();
          }}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setCurrent(0);
          }}
          onError={() => media.markError(t("fw.preview.playbackFailed"))}
        />
      )}
    </div>
  );
}
