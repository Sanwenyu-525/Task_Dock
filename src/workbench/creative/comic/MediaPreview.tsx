//! 漫剧素材预览原语：列表缩略图 + 详情大图 + 视频/其它占位。
//!
//! ## 为什么集中在这里
//! 素材、分镜、角色参考图都要「路径 → 可见画面」，三处各写一套会出现三种加载策略与
//! 三种失败降级。这里统一：
//! - 缩略图走 `requestThumbnail`（文件工作空间同一队列：并发 ≤3、有界缓存、后端 Shell 解码）；
//! - 大图复用文件工作空间的 `FileImagePreview`（Blob 预览 + Shell 回退 + 缩放/适应）；
//! - 视频与其它类型只给占位，**不**在一期引入解码器；
//! - 文件缺失只提示，不删除记录、不伪造空图。
//!
//! ## 安全
//! 不通过 `convertFileSrc` 或 `asset://` 直接暴露任意路径：全部经已登记的
//! `fs_thumbnail` / `fs_read_binary` / `fs_preview_image` 命令读取，后端自行钳制大小与类型。

import { useEffect, useState } from "react";
import { FileQuestion, Film, ImageOff } from "lucide-react";
import FileImagePreview from "../../../components/files/preview/FileImagePreview";
import { requestThumbnail } from "../../../components/files/preview/thumbnails";
import { basename } from "../../../lib/filesWorkspace/pathUtils";
import type { MediaKind } from "./types";

/** 列表缩略图边长（与文件工作空间同一档，命中同一份缓存）。 */
export const COMIC_THUMB_PX = 96;

export interface MediaThumbProps {
  path: string;
  kind: MediaKind;
  /** 读侧计算的文件存在性；false = 不再发起解码，直接占位。 */
  exists: boolean;
  /** 无图片时的替代说明（如「文件缺失」「视频」）。 */
  placeholder?: string;
}

/** 列表/卡片缩略图：图片按需解码；视频、缺失文件、解码失败都回落占位图标。 */
export function MediaThumb({ path, kind, exists, placeholder }: MediaThumbProps) {
  const [url, setUrl] = useState<string | null>(null);
  const canDecode = kind === "image" && exists && path.trim().length > 0;

  useEffect(() => {
    setUrl(null);
    if (!canDecode) return;
    return requestThumbnail(path, COMIC_THUMB_PX, setUrl);
  }, [canDecode, path]);

  if (url) {
    return (
      <span className="comic-thumb" data-state="ready">
        <img src={url} alt="" draggable={false} loading="lazy" />
      </span>
    );
  }

  const Icon = kind === "video" ? Film : kind === "other" ? FileQuestion : ImageOff;
  const label = placeholder ?? (kind === "video" ? "视频" : kind === "other" ? "其它" : "无缩略图");
  return (
    <span className="comic-thumb" data-state={canDecode ? "loading" : "empty"} title={label}>
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

export interface MediaPreviewProps {
  path: string;
  kind: MediaKind;
  exists: boolean;
  /** 无障碍名称（通常为版本标注）。 */
  label: string;
}

/**
 * 详情大图：只在真正打开详情/对比时挂载，避免「一次解码整页原图」。
 * 图片复用文件工作空间的通用预览组件；其余类型与缺失文件只给明确占位。
 */
export function MediaPreview({ path, kind, exists, label }: MediaPreviewProps) {
  if (!path.trim()) {
    return (
      <div className="comic-preview-placeholder" role="status">
        <FileQuestion size={22} strokeWidth={1.4} aria-hidden="true" />
        <p>该版本没有登记文件路径。</p>
      </div>
    );
  }
  if (!exists) {
    return (
      <div className="comic-preview-placeholder" data-tone="error" role="status">
        <ImageOff size={22} strokeWidth={1.4} aria-hidden="true" />
        <p>文件缺失：引用路径当前不存在，记录仍保留，路径恢复后自动可预览。</p>
      </div>
    );
  }
  if (kind === "image") {
    return (
      <div className="comic-media-preview">
        <FileImagePreview path={path} name={basename(path) || label} size={null} />
      </div>
    );
  }
  return (
    <div className="comic-preview-placeholder" role="status">
      {kind === "video" ? (
        <Film size={22} strokeWidth={1.4} aria-hidden="true" />
      ) : (
        <FileQuestion size={22} strokeWidth={1.4} aria-hidden="true" />
      )}
      <p>
        {kind === "video"
          ? "视频素材一期只登记与预览占位，内嵌播放器尚未接入；文件本身未复制、未改动。"
          : "该类型暂不支持内嵌预览，仅保留登记信息。"}
      </p>
    </div>
  );
}
