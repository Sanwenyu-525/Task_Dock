//! 剪贴板 UI 展示辅助（纯函数）。

import { formatDayLabel, formatHM } from "./format";

export const CLIP_KIND_LABELS: Record<string, string> = {
  text: "文字",
  url: "链接",
  html: "富文本",
  image: "图片",
  files: "文件",
  group: "分组",
};

export function kindLabel(kind: string): string {
  return CLIP_KIND_LABELS[kind] ?? kind;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 今天 14:03 · 昨天 09:12 · 10-26 18:00 */
export function clipboardTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDayLabel(d, now)} ${formatHM(d)}`;
}

export function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function groupStatusLabel(status: string): string {
  if (status === "collecting") return "收集中";
  if (status === "closed") return "已结束";
  return status;
}

export function groupModeLabel(mode: string): string {
  return mode === "auto" ? "自动" : "手动";
}

export function sourceLabel(sourceApp: string, sourceTitle: string): string {
  const app =
    sourceApp && sourceApp.toLowerCase() !== "unknown"
      ? fileBaseName(sourceApp)
      : "未知来源";
  return sourceTitle && sourceTitle !== sourceApp ? `${app} · ${sourceTitle}` : app;
}

export const RICH_EMBED_BUDGET = 6 * 1024 * 1024;
export const RICH_HTML_ITEM_LIMIT = 512 * 1024;

export interface CopyPreflight {
  images: number;
  imageBytes: number;
  estimatedEmbedBytes: number;
  willEmbedAllImages: boolean;
  files: number;
  oversizedHtml: number;
  totalBytes: number;
  warnings: string[];
}

/**
 * 复制前预检：区分富文本 / 多文件两种模式，说明图片内嵌预算与降级行为。
 * 只依据已加载的分组数据，不读取图片本体。
 */
export function copyPreflight(
  items: Array<{ kind: string; byte_size: number }>,
): CopyPreflight {
  let images = 0;
  let imageBytes = 0;
  let files = 0;
  let oversizedHtml = 0;
  let totalBytes = 0;
  for (const item of items) {
    const size = Number.isFinite(item.byte_size) ? item.byte_size : 0;
    totalBytes += size;
    if (item.kind === "image") {
      images += 1;
      imageBytes += size;
    } else if (item.kind === "files") {
      files += 1;
    } else if (item.kind === "html" && size > RICH_HTML_ITEM_LIMIT) {
      oversizedHtml += 1;
    }
  }
  const estimatedEmbedBytes = Math.ceil((imageBytes * 4) / 3);
  const willEmbedAllImages = images === 0 || estimatedEmbedBytes <= RICH_EMBED_BUDGET;
  const warnings: string[] = [];
  if (images > 0) {
    if (willEmbedAllImages) {
      warnings.push(
        `富文本会内嵌 ${images} 张图片，约 ${formatBytes(estimatedEmbedBytes)}（上限 6 MB，含 Base64 膨胀）`,
      );
    } else {
      warnings.push(
        `图片总计 ${formatBytes(imageBytes)}，超过富文本 6 MB 内嵌上限，超出部分会降级为占位符；建议改用逐项粘贴或复制文件`,
      );
    }
    warnings.push("部分编辑器不支持富文本图片，必要时请使用逐项粘贴保留原顺序");
  }
  if (files > 0) {
    warnings.push("文件条目在富文本中只保留名称清单；需要文件本体请使用「复制文件」");
  }
  if (oversizedHtml > 0) {
    warnings.push(`${oversizedHtml} 项富文本超过 512 KB，将降级为纯文本`);
  }
  return {
    images,
    imageBytes,
    estimatedEmbedBytes,
    willEmbedAllImages,
    files,
    oversizedHtml,
    totalBytes,
    warnings,
  };
}
