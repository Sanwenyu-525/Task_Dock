//! 文件类型视觉（图标 + 语义色 + 类型标签）的唯一口径。
//!
//! 头部、右侧检查器、之后的搜索结果都从这里取，避免每个组件各写一套
//! 「扩展名 → 图标 / 颜色」映射。颜色只给 tone 名，具体色值在 CSS 变量里，
//! 这样明暗主题与预设共用同一份语义（不再出现「所有文件都是灰标签」）。

import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { extOf, getPreviewKind, previewTypeLabel } from "./previewKind";

export type FileTone =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "sheet"
  | "slide"
  | "code"
  | "text"
  | "archive"
  | "data"
  | "program"
  | "other";

export interface FileVisual {
  tone: FileTone;
  Icon: LucideIcon;
  /** 头部类型标签（复用 `previewTypeLabel`，不另造词表）。 */
  label: string;
}

export interface FileVisualInput {
  name: string;
  kind?: string;
  category?: string;
}

const BY_CATEGORY: Record<string, { tone: FileTone; Icon: LucideIcon }> = {
  image: { tone: "image", Icon: FileImage },
  video: { tone: "video", Icon: FileVideo },
  audio: { tone: "audio", Icon: FileAudio },
  doc: { tone: "doc", Icon: FileType },
  sheet: { tone: "sheet", Icon: FileSpreadsheet },
  slide: { tone: "slide", Icon: Presentation },
  code: { tone: "code", Icon: FileCode2 },
  text: { tone: "text", Icon: FileText },
  archive: { tone: "archive", Icon: FileArchive },
  data: { tone: "data", Icon: FileJson },
  program: { tone: "program", Icon: FileIcon },
  folder: { tone: "folder", Icon: Folder },
};

const ARCHIVE_EXT = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst"]);

/** 类型视觉：扩展名优先（与 `getPreviewKind` 同一优先级），再退回后端类别。 */
export function fileVisual(input: FileVisualInput): FileVisual {
  if (input.kind === "dir") {
    return { tone: "folder", Icon: Folder, label: "文件夹" };
  }
  const ext = extOf(input.name);
  const kind = getPreviewKind({ name: input.name, category: input.category ?? "other" });
  const label = previewTypeLabel(kind, ext);

  if (ext === "pdf") return { tone: "pdf", Icon: FileText, label };
  if (ARCHIVE_EXT.has(ext)) return { tone: "archive", Icon: FileArchive, label };
  const byCategory = BY_CATEGORY[input.category ?? ""];
  if (byCategory) return { ...byCategory, label };
  if (kind === "image") return { tone: "image", Icon: FileImage, label };
  if (kind === "video") return { tone: "video", Icon: FileVideo, label };
  if (kind === "audio") return { tone: "audio", Icon: FileAudio, label };
  if (kind === "text") {
    return ext && ext !== "txt" && ext !== "text" && ext !== "log"
      ? { tone: "code", Icon: FileCode2, label }
      : { tone: "text", Icon: FileText, label };
  }
  return { tone: "other", Icon: FileIcon, label };
}
