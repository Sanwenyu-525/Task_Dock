//! 受控图片：只接受平台资产 ID（`va_…`），通过后端 `collab_asset_read` 取内容。
//! 不读取任意本地路径、不加载外部 URL。

import { useEffect, useState, type CSSProperties } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { assetDataUrl, collabAssetRead } from "../../../lib/collab";
import { errorMessage } from "../../../lib/errors";

export interface AssetImageProps {
  assetId: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  onNaturalSize?: (width: number, height: number) => void;
}

export default function AssetImage({
  assetId,
  alt,
  className,
  style,
  onNaturalSize,
}: AssetImageProps) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSrc("");
    setError("");
    if (!assetId.startsWith("va_")) {
      setError("未选择图片资产");
      return;
    }
    collabAssetRead(assetId)
      .then((content) => {
        if (!cancelled) setSrc(assetDataUrl(content));
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  if (error) {
    return (
      <div className={`asset-image-fallback ${className ?? ""}`} style={style}>
        <ImageOff size={14} />
        <span>{error}</span>
      </div>
    );
  }
  if (!src) {
    return (
      <div className={`asset-image-fallback ${className ?? ""}`} style={style}>
        <Loader2 size={14} className="spin" />
        <span>加载图片…</span>
      </div>
    );
  }
  return (
    <img
      className={className}
      style={style}
      src={src}
      alt={alt}
      onLoad={(e) =>
        onNaturalSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
      }
    />
  );
}
