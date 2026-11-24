//! 视频预览：保留浏览器原生控制条（播放/暂停/进度/音量/全屏），
//! 失败时给出可操作的错误态（编码不支持 / 文件被占用）。
//!
//! 生命周期：视频元素按媒体 URL 重建；旧元素在卸载时**显式** `pause()`、清空 `src`
//! 并 `load()`，页面切走/弹窗关闭/版本切换都不会留下后台播放器。

import { useRef, type RefObject } from "react";
import { useLocale } from "../../../hooks/useLocale";
import { useMediaPreviewUrl } from "./useMediaPreviewUrl";
import { PreviewError, PreviewLoading } from "./PreviewState";
import { extOf } from "./previewKind";
import { stopMediaElement, useStopMediaOnUnmount } from "./mediaLifecycle";

interface Props {
  path: string;
  name: string;
  size: number | null;
  /** 版本键：同一路径被外部改写时重新取媒体 URL 并释放旧 token。 */
  revisionKey?: string;
}

interface VideoElementProps {
  url: string;
  elementRef: RefObject<HTMLVideoElement | null>;
  fallback: string;
  onReady: () => void;
  onError: (el: HTMLVideoElement) => void;
}

/** 只负责一个具体 URL 的 `<video>`：卸载（含 URL 变化）时停止并清源。 */
function VideoElement({ url, elementRef, fallback, onReady, onError }: VideoElementProps) {
  useStopMediaOnUnmount(elementRef);
  return (
    <video
      ref={elementRef}
      className="fw-preview-video"
      src={url}
      controls
      preload="metadata"
      playsInline
      onLoadedMetadata={() => onReady()}
      onError={(e) => onError(e.currentTarget)}
    >
      {fallback}
    </video>
  );
}

export default function FileVideoPreview({ path, name, revisionKey }: Props) {
  const { t } = useLocale();
  const media = useMediaPreviewUrl(path, revisionKey);
  const videoRef = useRef<HTMLVideoElement>(null);

  if (media.error) {
    return (
      <PreviewError
        title={t("fw.preview.error", { error: media.error })}
        hint={
          extOf(name)
            ? t("fw.preview.videoCodecHint", { ext: extOf(name).toUpperCase() })
            : t("fw.preview.fallbackOpen")
        }
        onRetry={media.retry}
        retryLabel={t("common.retry")}
      />
    );
  }

  return (
    <div className="fw-preview-video-wrap">
      {media.loading && (
        <div className="fw-preview-media-loading">
          <PreviewLoading label={t("fw.preview.loading")} />
        </div>
      )}
      {media.url && (
        <VideoElement
          key={media.url}
          url={media.url}
          elementRef={videoRef}
          fallback={t("fw.preview.videoUnsupported")}
          onReady={media.markReady}
          onError={(el) => {
            stopMediaElement(el);
            media.markError(t("fw.preview.playbackFailed"));
          }}
        />
      )}
    </div>
  );
}
