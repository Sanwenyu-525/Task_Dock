//! 视频预览：保留浏览器原生控制条（播放/暂停/进度/音量/全屏），
//! 失败时给出可操作的错误态（编码不支持 / 文件被占用）。

import { useLocale } from "../../../hooks/useLocale";
import { useMediaPreviewUrl } from "./useMediaPreviewUrl";
import { PreviewError, PreviewLoading } from "./PreviewState";
import { extOf } from "./previewKind";

interface Props {
  path: string;
  name: string;
  size: number | null;
}

export default function FileVideoPreview({ path, name }: Props) {
  const { t } = useLocale();
  const media = useMediaPreviewUrl(path);

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
        <video
          className="fw-preview-video"
          src={media.url}
          controls
          preload="metadata"
          playsInline
          onLoadedMetadata={media.markReady}
          onError={() => media.markError(t("fw.preview.playbackFailed"))}
        >
          {t("fw.preview.videoUnsupported")}
        </video>
      )}
    </div>
  );
}
