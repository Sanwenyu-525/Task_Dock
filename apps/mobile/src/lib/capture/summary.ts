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
    // 单文件才展示文件名；名字取不到可读值时退回数量，不把 document id 当标题。
    const name = files.length === 1 ? readableFileName(files[0].name) : "";
    parts.push(name ? `文件 ${name}` : `文件 ${files.length} 个`);
  }
  return parts.join(" · ");
}

/**
 * 系统分享给的文件名清洗（纯展示用，不参与落盘命名）。
 *
 * 分享方经常只给 content:// 的 document id，投递到 JS 层是 `document%3A1000069262`：
 * 解码后仍然只是一个不透明 id，把它当标题会得到「文件 document%3A1000069262」这种
 * 用户看不懂的正文。这里解码合法的百分号编码（`report%20final.pdf` → `report final.pdf`），
 * 并把「像 id 而不是文件名」的结果判为不可读，由调用方退回数量描述。
 */
export function readableFileName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) return "";
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // 非法百分号编码（单个 % 等）：保留原始串，不做猜测
    decoded = name;
  }
  // `document:1000069262` / `image:1234` 这类 content provider id 没有扩展名且是 pure id
  if (/^[a-z][a-z0-9+.-]*:\d+$/i.test(decoded)) return "";
  return decoded;
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
