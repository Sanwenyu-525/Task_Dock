// 采集标题生成：纯函数，便于单测。
//
// 用途：用户只拍了照片/只录了音、没有输入文字时，收集箱仍需要一条可同步的正文
// （桌面端 quick_capture 拒绝空内容）。这里生成的是「内容是什么 + 什么时候」的
// 真实元信息，不是伪造的转写或占位文案。
import type { AttachmentKind } from "../../domain/types";

export interface SummaryItem {
  kind: AttachmentKind;
  name?: string;
  durationMs?: number | null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时区的 MM-DD HH:mm（采集标题里的时间，不参与同步时间戳语义） */
export function formatCaptureClock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** 语音时长：`1:12` / `0:07`；非语音返回 null */
export function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${pad(seconds)}`;
}

/** 附件段：`照片 2 张` / `语音 1:12` / `文件 report.pdf` */
export function describeItems(items: readonly SummaryItem[]): string {
  const images = items.filter((item) => item.kind === "image").length;
  const audios = items.filter((item) => item.kind === "audio");
  const files = items.filter((item) => item.kind === "file");

  const parts: string[] = [];
  if (images > 0) parts.push(`照片 ${images} 张`);
  if (audios.length > 0) {
    const totalMs = audios.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
    const duration = formatDuration(totalMs);
    parts.push(duration ? `语音 ${duration}` : `语音 ${audios.length} 段`);
  }
  if (files.length > 0) {
    parts.push(files.length === 1 ? `文件 ${files[0].name || "附件"}` : `文件 ${files.length} 个`);
  }
  return parts.join(" · ");
}

/**
 * 自动标题：`照片 2 张 · 11-14 12:03`。没有任何附件时返回空串，
 * 调用方必须保证这时有用户输入的文字，否则保存会被正文校验拒绝。
 */
export function autoCaptureTitle(items: readonly SummaryItem[], at: number): string {
  const parts = describeItems(items);
  if (!parts) return "";
  return `${parts} · ${formatCaptureClock(at)}`;
}

/** 任务标题：取首行、限 60 字；没有文字时退回自动标题（而不是编一个「未命名任务」）。 */
export function taskTitleFromText(text: string, fallback: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

/** 附件体积展示：B / KB / MB，保留一位小数。只用于 UI，不参与任何判定。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
