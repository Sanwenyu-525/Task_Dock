//! 暂存条目「文件类型」展示：图标 + 短类型名 + 语义色调。
//!
//! 暂存架只存 `kind`（file/image/folder/link/text）与可选 `file_ext`，
//! 不引入新的文件类型枚举。这里按扩展名做**展示层**归类：图标形状回答
//! 「是什么文件」，短类型名（如「PDF 文档」）在胶囊副标题里显式写出来，
//! 不要求用户靠图标猜。未知扩展名仍按普通文件展示，不臆造类型。

import {
  AlignLeft,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Link2,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import type { ShelfItem, ShelfKind } from "./bridge";

export type ShelfFileTone =
  | "doc"
  | "sheet"
  | "slide"
  | "image"
  | "media"
  | "archive"
  | "code"
  | "data"
  | "program"
  | "folder"
  | "link"
  | "text"
  | "other";

export interface ShelfFileTypeUi {
  icon: LucideIcon;
  /** 面向用户的短类型名（含扩展名），例如「PDF 文档」「PNG 图片」「文件夹」。 */
  label: string;
  /** 对应 `file-tone-*` CSS 类的色调。 */
  tone: ShelfFileTone;
  /** 规范化扩展名（小写、不含点）；没有可靠扩展名时为 null。 */
  ext: string | null;
}

interface ExtGroup {
  tone: ShelfFileTone;
  category: string;
  icon: LucideIcon;
  exts: readonly string[];
}

/**
 * 扩展名归类表。同一扩展名只出现一次；顺序不影响结果（构建 Map 时后者覆盖前者，
 * 所以这里刻意保证不重复）。类别名用于拼「EXT 类别」，保持两到四个字。
 */
const EXT_GROUPS: readonly ExtGroup[] = [
  {
    tone: "doc",
    category: "文档",
    icon: FileText,
    exts: [
      "pdf", "doc", "docx", "docm", "dot", "dotx", "rtf", "odt", "wps",
      "pages", "epub", "mobi", "azw", "azw3",
    ],
  },
  {
    tone: "text",
    category: "文本",
    icon: FileText,
    exts: ["txt", "md", "markdown", "log", "text", "nfo"],
  },
  {
    tone: "sheet",
    category: "表格",
    icon: FileSpreadsheet,
    exts: ["xls", "xlsx", "xlsm", "xlsb", "csv", "tsv", "ods", "numbers"],
  },
  {
    tone: "slide",
    category: "演示",
    icon: Presentation,
    exts: ["ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key"],
  },
  {
    tone: "image",
    category: "图片",
    icon: FileImage,
    exts: [
      "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif",
      "tiff", "heic", "heif", "avif", "raw",
    ],
  },
  {
    tone: "media",
    category: "视频",
    icon: FileVideo,
    exts: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "3gp"],
  },
  {
    tone: "media",
    category: "音频",
    icon: FileAudio,
    exts: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff"],
  },
  {
    tone: "archive",
    category: "压缩包",
    icon: FileArchive,
    exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "lz", "cab"],
  },
  {
    tone: "code",
    category: "代码",
    icon: FileCode,
    exts: [
      "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "java",
      "kt", "kts", "c", "cc", "cpp", "h", "hpp", "cs", "rb", "php", "sh",
      "zsh", "ps1", "lua", "r", "swift", "dart", "scala", "html", "htm",
      "css", "scss", "sass", "less", "sql", "vue", "svelte", "astro",
    ],
  },
  {
    tone: "data",
    category: "数据",
    icon: FileCode,
    exts: ["json", "json5", "yaml", "yml", "toml", "xml", "ini", "conf", "cfg", "env", "properties"],
  },
  {
    tone: "program",
    category: "程序",
    icon: File,
    exts: ["exe", "msi", "msix", "appx", "com", "bat", "cmd", "dll", "sys", "lnk"],
  },
  {
    tone: "archive",
    category: "映像",
    icon: FileArchive,
    exts: ["iso", "img", "vhd", "vhdx", "dmg"],
  },
];

const EXT_INDEX = new Map<string, ExtGroup>();
for (const group of EXT_GROUPS) {
  for (const ext of group.exts) EXT_INDEX.set(ext, group);
}

/**
 * 只接受普通扩展名形状（字母/数字，1–12 位，且至少含一个字母），
 * 避免把「发布 2026.11」之类版本号当成后缀。
 */
function normalizeExt(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/^\./, "").toLowerCase();
  if (!value || value.length > 12) return null;
  if (!/^[a-z0-9]+$/.test(value) || !/[a-z]/.test(value)) return null;
  return value;
}

function extFromName(name: string | null | undefined): string | null {
  const value = (name ?? "").trim();
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  return normalizeExt(value.slice(dot + 1));
}

const KIND_FALLBACK: Record<ShelfKind, Omit<ShelfFileTypeUi, "ext">> = {
  file: { icon: File, label: "文件", tone: "other" },
  image: { icon: FileImage, label: "图片", tone: "image" },
  folder: { icon: Folder, label: "文件夹", tone: "folder" },
  link: { icon: Link2, label: "链接", tone: "link" },
  text: { icon: AlignLeft, label: "文本", tone: "text" },
};

type TypeSource = Pick<ShelfItem, "kind" | "display_name" | "original_path" | "file_ext">;

/**
 * 解析条目的展示类型。
 *
 * 优先级：后端 `file_ext` → 显示名/原路径扩展名 → `kind` 兜底。
 * 图片条目即使扩展名未知也保持图片图标；file 条目按扩展名细分。
 */
export function shelfFileTypeUi(item: TypeSource): ShelfFileTypeUi {
  const ext =
    normalizeExt(item.file_ext) ??
    extFromName(item.display_name) ??
    extFromName(item.original_path);
  const fallback = KIND_FALLBACK[item.kind] ?? KIND_FALLBACK.file;

  if (item.kind === "folder" || item.kind === "link" || item.kind === "text") {
    return { ...fallback, ext };
  }

  const group = ext ? EXT_INDEX.get(ext) : undefined;
  if (group) {
    return {
      icon: group.icon,
      label: `${ext!.toUpperCase()} ${group.category}`,
      tone: group.tone,
      ext,
    };
  }
  if (item.kind === "image") {
    return {
      icon: FileImage,
      label: ext ? `${ext.toUpperCase()} 图片` : "图片",
      tone: "image",
      ext,
    };
  }
  return {
    icon: File,
    label: ext ? `${ext.toUpperCase()} 文件` : "文件",
    tone: "other",
    ext,
  };
}
