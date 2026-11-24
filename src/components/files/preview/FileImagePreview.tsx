//! 图片预览：原始字节 → Blob URL（保留 GIF 动画、不注入 SVG 源码），
//! 解码失败或超大图回退到 Windows Shell 解码（PNG data URL）。
//!
//! 安全：SVG 只作为 `<img src=blob:...>` 的图片资源，绝不以 HTML 注入页面。

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Scan } from "lucide-react";
import { fsPreviewImage, fsReadBinary } from "../../../lib/bridge";
import { useLocale } from "../../../hooks/useLocale";
import { errorMessage } from "../../../lib/errors";
import { IMAGE_MAX_BYTES, IMAGE_ORIGINAL_BYTES, SVG_MAX_BYTES, extOf } from "./previewKind";
import {
  base64ToBytes,
  createObjectUrlTracker,
  type ObjectUrlTracker,
} from "./mediaToken";
import { PreviewError, PreviewLoading } from "./PreviewState";

interface Props {
  path: string;
  name: string;
  size: number | null;
  /** 版本键：同一路径被外部改写时重新读取字节并吊销旧 Blob URL。 */
  revisionKey?: string;
}

export default function FileImagePreview({ path, name, size, revisionKey }: Props) {
  const { t } = useLocale();
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(100);

  const trackerRef = useRef<ObjectUrlTracker | null>(null);
  if (!trackerRef.current) trackerRef.current = createObjectUrlTracker();
  const activeUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const fallbackTriedRef = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    cancelledRef.current = false;
    const tracker = trackerRef.current!;
    fallbackTriedRef.current = false;

    const swapImage = (url: string | null) => {
      const previous = activeUrlRef.current;
      if (previous && previous !== url) tracker.revoke(previous);
      activeUrlRef.current = url;
      setSrc(url);
    };

    const loadShell = async () => {
      try {
        const url = await fsPreviewImage(path);
        if (cancelled) return;
        if (url) {
          fallbackTriedRef.current = true;
          swapImage(url);
          setError(null);
        } else {
          setError(t("fw.preview.imageUnavailable"));
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    setError(null);
    setFit(true);
    setZoom(100);
    swapImage(null);

    void (async () => {
      const ext = extOf(name);
      const originalLimit = ext === "svg" ? SVG_MAX_BYTES : IMAGE_ORIGINAL_BYTES;
      // 超大图不整文件读进 WebView：直接让 Shell 解码成适配尺寸的 PNG。
      if (size !== null && size > originalLimit) {
        await loadShell();
        return;
      }
      try {
        const binary = await fsReadBinary(path, IMAGE_MAX_BYTES);
        if (cancelled) return;
        if (binary.truncated) {
          // 超过后端上限：只拿到前缀字节，不可能解码成完整图片。
          await loadShell();
          return;
        }
        const bytes = base64ToBytes(binary.base64);
        const blob = new Blob([bytes.buffer as ArrayBuffer], {
          type: binary.mime || "application/octet-stream",
        });
        const url = tracker.create(blob);
        if (!url) {
          await loadShell();
          return;
        }
        swapImage(url);
        setLoading(false);
      } catch {
        if (!cancelled) await loadShell();
      }
    })();

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      const previous = activeUrlRef.current;
      if (previous) tracker.revoke(previous);
      activeUrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, name, size, revisionKey, reloadKey]);

  // Blob 解码失败（不支持的编码/文件损坏）：仅回退一次到 Shell 解码。
  const onImageError = () => {
    if (fallbackTriedRef.current) {
      setError(t("fw.preview.imageUnavailable"));
      setLoading(false);
      return;
    }
    fallbackTriedRef.current = true;
    void fsPreviewImage(path)
      .then((url) => {
        if (cancelledRef.current) return;
        if (!url) {
          setError(t("fw.preview.imageUnavailable"));
          return;
        }
        const tracker = trackerRef.current!;
        const previous = activeUrlRef.current;
        if (previous) tracker.revoke(previous);
        activeUrlRef.current = url;
        setSrc(url);
        setError(null);
      })
      .catch((e) => {
        if (!cancelledRef.current) setError(errorMessage(e));
      });
  };

  if (loading) return <PreviewLoading label={t("fw.preview.loading")} />;
  if (error) {
    return (
      <PreviewError
        title={t("fw.preview.error", { error })}
        hint={t("fw.preview.fallbackOpen")}
        onRetry={() => setReloadKey((value) => value + 1)}
        retryLabel={t("common.retry")}
      />
    );
  }
  if (!src) return <PreviewError title={t("fw.preview.imageUnavailable")} hint={t("fw.preview.fallbackOpen")} />;

  const toggleFit = () => {
    setFit((value) => !value);
    setZoom(100);
  };

  return (
    <div className="fw-preview-image">
      <div className="fw-preview-image-viewport" data-fit={fit ? "true" : "false"}>
        <img
          src={src}
          alt={name}
          draggable={false}
          onError={onImageError}
          onDoubleClick={toggleFit}
          style={
            fit
              ? { maxWidth: "100%", maxHeight: "100%" }
              : { zoom: zoom / 100, maxWidth: "none", maxHeight: "none" }
          }
        />
      </div>
      <div className="fw-preview-hud" role="group" aria-label={t("fw.preview.zoomControls")}>
        <button
          type="button"
          className="fw-icon-btn"
          aria-label={t("fw.preview.zoomOut")}
          disabled={!fit && zoom <= 25}
          onClick={() => {
            setFit(false);
            setZoom((value) => Math.max(25, value - 25));
          }}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        <span className="fw-preview-hud-value">{fit ? t("fw.preview.fit") : `${zoom}%`}</span>
        <button
          type="button"
          className="fw-icon-btn"
          aria-label={t("fw.preview.zoomIn")}
          disabled={!fit && zoom >= 400}
          onClick={() => {
            setFit(false);
            setZoom((value) => Math.min(400, value + 25));
          }}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
        <span className="fw-preview-hud-sep" aria-hidden="true" />
        <button
          type="button"
          className={`fw-preview-hud-btn${fit ? " is-on" : ""}`}
          aria-pressed={fit}
          onClick={() => {
            setFit(true);
            setZoom(100);
          }}
        >
          <Maximize2 size={12} aria-hidden="true" />
          {t("fw.preview.fitAction")}
        </button>
        <button
          type="button"
          className={`fw-preview-hud-btn${!fit && zoom === 100 ? " is-on" : ""}`}
          aria-pressed={!fit && zoom === 100}
          onClick={() => {
            setFit(false);
            setZoom(100);
          }}
        >
          <Scan size={12} aria-hidden="true" />
          {t("fw.preview.actualSize")}
        </button>
      </div>
    </div>
  );
}
