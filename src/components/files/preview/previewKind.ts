//! 预览类型判定的唯一入口（纯函数）。
//!
//! 容器与各类型预览组件都从这里取「是什么 / 能不能内嵌 / 上限多少 / 语言标签」，
//! 禁止在组件内再维护第二份扩展名白名单：加一种格式只改这一个文件。

import type { FsEntry } from "../../../lib/bridge";

export type PreviewKind = "image" | "pdf" | "text" | "video" | "audio" | "unsupported";

/** 文本预览单次读取上限（也是「已截断」提示的口径）。 */
export const TEXT_PREVIEW_BYTES = 512 * 1024;
/** 超过该大小的图片改用 Windows Shell 解码（保留动图时优先走原始字节）。 */
export const IMAGE_ORIGINAL_BYTES = 24 * 1024 * 1024;
/** 图片原始字节读取硬上限（后端默认值，超限按截断处理 → 放弃内嵌预览）。 */
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
/** SVG 是文本型矢量图，单独收紧上限。 */
export const SVG_MAX_BYTES = 8 * 1024 * 1024;
/** PDF 原始字节上限（与后端 fs_read_binary 的钳制上限一致）。 */
export const PDF_MAX_BYTES = 64 * 1024 * 1024;
/** 超过该长度的文本关闭逐行语法高亮，避免一次生成过多 DOM 节点。 */
export const HIGHLIGHT_MAX_CHARS = 160_000;

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "svg",
  "avif",
  "ico",
  "tif",
  "tiff",
]);

const PDF_EXT = new Set(["pdf"]);

const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "mkv", "avi"]);

const AUDIO_EXT = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga"]);

const TEXT_EXT = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "json",
  "jsonc",
  "csv",
  "tsv",
  "log",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "jsx",
  "tsx",
  "py",
  "rs",
  "sql",
  "ini",
  "cfg",
  "conf",
  "sh",
  "bat",
  "cmd",
  "ps1",
  "c",
  "h",
  "cpp",
  "hpp",
  "java",
  "go",
  "env",
  "gitignore",
]);

/** 语言标签（用于文本预览头部，不参与「是否支持」判定）。 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript (JSX)",
  json: "JSON",
  jsonc: "JSON with Comments",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  rs: "Rust",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  csv: "CSV",
  tsv: "TSV",
  log: "Log",
  ini: "INI",
  cfg: "Config",
  conf: "Config",
  sh: "Shell",
  bat: "Batch",
  cmd: "Batch",
  ps1: "PowerShell",
  c: "C",
  h: "C Header",
  cpp: "C++",
  hpp: "C++ Header",
  java: "Java",
  go: "Go",
  txt: "Plain Text",
  text: "Plain Text",
};

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  if (dot === 0) return name.slice(1).toLowerCase(); // .env / .gitignore 按扩展名处理
  if (dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 预览类型判定：**扩展名优先**（用户对文件名的直觉），未知扩展名再退回后端
 * `category`；`doc`（DOCX/XLSX/PPTX）等二进制格式保持 unsupported，绝不丢给文本读取。
 */
export function getPreviewKind(
  entry: Pick<FsEntry, "name" | "category"> & { kind?: string } | null | undefined,
): PreviewKind {
  if (!entry) return "unsupported";
  if (entry.kind === "dir") return "unsupported";
  const ext = extOf(entry.name);
  if (PDF_EXT.has(ext)) return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (TEXT_EXT.has(ext)) return "text";
  switch (entry.category) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "text":
    case "code":
      return "text";
    default:
      return "unsupported";
  }
}

export function isPreviewSupported(entry: Parameters<typeof getPreviewKind>[0]): boolean {
  return getPreviewKind(entry) !== "unsupported";
}

/**
 * 单次读取上限（字节）。`null` = 走流式协议，不做整文件读取。
 * 文本返回的是「最多读取的前缀长度」，超过即截断提示，不是拒绝预览。
 */
export function getPreviewSizeLimit(kind: PreviewKind, ext = ""): number | null {
  switch (kind) {
    case "image":
      return ext.toLowerCase() === "svg" ? SVG_MAX_BYTES : IMAGE_MAX_BYTES;
    case "pdf":
      return PDF_MAX_BYTES;
    case "text":
      return TEXT_PREVIEW_BYTES;
    default:
      return null;
  }
}

export function previewLanguage(ext: string): string {
  return LANGUAGE_BY_EXT[ext.toLowerCase()] ?? (ext ? ext.toUpperCase() : "Plain Text");
}

/** 需要等宽字体 + 行号 + 轻量高亮的类型（纯文本也显示行号，但不做关键字染色）。 */
export function isCodeLike(ext: string): boolean {
  const normalized = ext.toLowerCase();
  if (!normalized) return false;
  return normalized !== "txt" && normalized !== "text" && normalized !== "log";
}

/** 预览头部的类型徽标：优先扩展名，其次 kind。 */
export function previewTypeLabel(kind: PreviewKind, ext: string): string {
  if (kind === "unsupported") return ext ? ext.toUpperCase() : "?";
  if (kind === "text") return previewLanguage(ext);
  if (ext) return ext.toUpperCase();
  switch (kind) {
    case "image":
      return "IMAGE";
    case "pdf":
      return "PDF";
    case "video":
      return "VIDEO";
    case "audio":
      return "AUDIO";
    default:
      return "?";
  }
}
