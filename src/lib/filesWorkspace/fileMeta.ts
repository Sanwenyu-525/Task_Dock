//! 文件条目展示元数据：类型 → 图标/语义配色、尺寸与时间格式化。
//!
//! 颜色只消费 `--file-tone-*` 语义 Token（styles.css 已定义），不硬编码色值；
//! 图标统一 lucide（与全应用一致），禁止 Emoji 混用。

import {
  Archive,
  File as FileIconBase,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Link as LinkIcon,
  Puzzle,
  Terminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface FileVisual {
  icon: LucideIcon;
  /** `--file-tone-<tone>` 语义色 Token 名（不含 var() 前缀）。 */
  tone: string;
}

/** 后端 category → 图标与配色（与 file_workspace::category_of 对齐）。 */
const CATEGORY_VISUAL: Record<string, FileVisual> = {
  folder: { icon: Folder, tone: "folder" },
  image: { icon: FileImage, tone: "image" },
  video: { icon: FileVideo, tone: "media" },
  audio: { icon: FileMusic, tone: "media" },
  text: { icon: FileText, tone: "text" },
  doc: { icon: FileText, tone: "doc" },
  sheet: { icon: FileSpreadsheet, tone: "sheet" },
  slide: { icon: FileIconBase, tone: "slide" },
  archive: { icon: Archive, tone: "archive" },
  code: { icon: FileCode, tone: "code" },
  data: { icon: Puzzle, tone: "data" },
  program: { icon: Terminal, tone: "program" },
  link: { icon: LinkIcon, tone: "link" },
  other: { icon: FileIconBase, tone: "other" },
};

export function fileVisual(category: string): FileVisual {
  return CATEGORY_VISUAL[category] ?? CATEGORY_VISUAL.other;
}

/** 目录条目 tone 类名（`tone-<x>`；组件里拼 `var(--file-tone-<tone>)`）。 */
export function toneVar(tone: string): string {
  return `var(--file-tone-${tone})`;
}

export function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function formatModified(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export const KIND_LABEL: Record<string, string> = {
  dir: "文件夹",
  file: "文件",
  link: "链接",
  missing: "已丢失",
};

/** 属性面板的类别展示名。 */
export const CATEGORY_LABEL: Record<string, string> = {
  folder: "文件夹",
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本文档",
  doc: "文档",
  sheet: "表格",
  slide: "演示文稿",
  archive: "压缩包",
  code: "代码",
  data: "数据文件",
  program: "应用程序",
  link: "快捷方式",
  other: "文件",
};

/** 可用「打开」语义的目录（文件夹行双击进入）。 */
export function isFolderKind(kind: string): boolean {
  return kind === "dir";
}

/** 空目录图标（空态复用）。 */
export { FolderOpen };
