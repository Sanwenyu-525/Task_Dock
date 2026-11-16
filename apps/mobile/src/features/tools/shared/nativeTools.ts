// 开发者工具的原生桥与文件辅助（应用私有目录 + 剪贴板 + 分享 + 图片处理）。
//
// 分层：
// - 原生模块只在 `modules/media-store`（TaskDockMedia）、`modules/clipboard`
//   （TaskDockClipboard）、`modules/share-intent`（ShareIntent）三处；
// - 本文件是唯一把它们暴露给工具页的地方，页面不直接 requireNativeModule；
// - 所有产物都落在 `Paths.document/tool-files/`，不写外部存储、不覆盖用户文件。
//
// 失败语义：原生不可用时抛 AppError("validation")，UI 显示可理解的原因；
// 文件读写失败抛 AppError("storage")，由页面提示并保留原始输入。
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { requireOptionalNativeModule } from "expo-modules-core";

import { AppError } from "../../../lib/errors";
import { utf8Decode, utf8Encode } from "../../../domain/tools/textCodec";

// ── 原生模块类型 ─────────────────────────────────────────

interface NativeCompressResult {
  uri: string;
  path: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  orientation: number;
  mime: string;
  size: number;
  format: string;
}

interface NativeMediaModule {
  compressImageAsync(
    sourceUri: string,
    outputPath: string,
    maxWidth: number,
    maxHeight: number,
    quality: number,
    format: string,
  ): Promise<NativeCompressResult>;
  openImageSessionAsync(
    sourceUri: string,
    maxDimension: number,
  ): Promise<{ id: string; width: number; height: number }>;
  samplePixelsAsync(sessionId: string, xs: number[], ys: number[]): Promise<number[]>;
  closeImageSessionAsync(sessionId: string): Promise<void>;
}

interface NativeClipboardModule {
  getTextAsync(): Promise<string | null>;
  setTextAsync(text: string): Promise<boolean>;
}

interface NativeShareModule {
  shareTextAsync(text: string, subject: string): Promise<boolean>;
  shareFileAsync(fileUri: string, mime: string, subject: string): Promise<boolean>;
}

const media = requireOptionalNativeModule<NativeMediaModule>("TaskDockMedia");
const clipboard = requireOptionalNativeModule<NativeClipboardModule>("TaskDockClipboard");
const share = requireOptionalNativeModule<NativeShareModule>("ShareIntent");

export const mediaToolsAvailable = media != null;
export const clipboardAvailable = clipboard != null;
export const shareOutAvailable = share != null;

function requireMedia(): NativeMediaModule {
  if (!media) {
    throw new AppError("validation", "当前构建缺少图片处理模块，请安装最新版 APK");
  }
  return media;
}

// ── 文件目录 ─────────────────────────────────────────────

const TOOL_DIR_NAME = "tool-files";

function toolDirectory(): Directory {
  const directory = new Directory(Paths.document, TOOL_DIR_NAME);
  if (!directory.exists) {
    directory.create({ idempotent: true, intermediates: true });
  }
  return directory;
}

/** 文件名清洗：去路径分隔符/控制字符，限长，保留扩展名。 */
export function sanitizeFileName(input: string, fallback = "taskdock"): string {
  const base = input.replace(/\\/g, "/").split("/").pop() ?? fallback;
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function uniqueName(name: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 6);
  const safe = sanitizeFileName(name);
  const dot = safe.lastIndexOf(".");
  if (dot > 0) return `${safe.slice(0, dot)}-${stamp}${random}${safe.slice(dot)}`;
  return `${safe}-${stamp}${random}`;
}

/** 生成一个尚不存在的私有文件路径（原生压缩直接写入，避免「先建空文件再覆盖」）。 */
export function reserveToolFilePath(name: string): { uri: string; path: string; fileName: string } {
  const fileName = uniqueName(name);
  const file = new File(toolDirectory(), fileName);
  return { uri: file.uri, path: pathOfUri(file.uri), fileName };
}

/** file:// URI → 原生 File 绝对路径。非 file:// 抛错，避免把 content:// 传给原生写盘。 */
export function pathOfUri(uri: string): string {
  let path = uri;
  if (path.startsWith("file://")) path = path.slice("file://".length);
  try {
    path = decodeURIComponent(path);
  } catch {
    // 保留原样：文件名里的 % 不是合法转义时不能把路径解码坏。
  }
  if (!path.startsWith("/")) throw new AppError("storage", "无法解析文件路径");
  return path;
}

/** 写文本文件（UTF-8），返回 uri/路径；用于片段导出与临时结果。 */
export function writeToolTextFile(name: string, content: string): { uri: string; path: string; size: number } {
  try {
    const directory = toolDirectory();
    const file = directory.createFile(uniqueName(name), "text/plain");
    const handle = file.open(FileMode.WriteOnly);
    try {
      handle.writeBytes(utf8Encode(content));
    } finally {
      handle.close();
    }
    return { uri: file.uri, path: pathOfUri(file.uri), size: file.size ?? 0 };
  } catch (error) {
    throw new AppError("storage", `写入文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 读取用户选择的文本文件。大文件先拦在上限外，避免把 50MB 日志读进 JS。 */
export async function readTextFile(uri: string, maxBytes = 2_000_000): Promise<string> {
  const file = new File(uri);
  if (!file.exists) throw new AppError("validation", "文件不存在或没有读取权限");
  const size = Number(file.size ?? 0);
  if (size > maxBytes) {
    throw new AppError("validation", `文件 ${formatBytes(size)}，超过 ${formatBytes(maxBytes)} 上限`);
  }
  const handle = file.open(FileMode.ReadOnly);
  try {
    const parts: Uint8Array[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = await handle.readBytes(256 * 1024);
      if (chunk.length === 0) break;
      parts.push(chunk);
      total += chunk.length;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    const decoded = utf8Decode(merged);
    if (!decoded.ok) throw new AppError("validation", `文件不是 UTF-8 文本：${decoded.message}`);
    return decoded.text;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("storage", `读取文件失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    handle.close();
  }
}

export function fileSize(uri: string): number {
  try {
    const file = new File(uri);
    return Number(file.size ?? 0);
  } catch {
    return 0;
  }
}

export function deleteToolFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // 清理失败不影响主流程；不覆盖原始结果。
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── 图片：真正重编码压缩 / 取色会话 ─────────────────────

export interface CompressOutput {
  uri: string;
  path: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  mime: string;
  size: number;
  format: string;
}

export async function compressImage(
  sourceUri: string,
  options: {
    maxWidth: number;
    maxHeight: number;
    quality: number;
    format: "jpeg" | "png" | "webp";
  },
): Promise<CompressOutput> {
  const module = requireMedia();
  // 输出名与源文件无关，避免同名覆盖；扩展名由格式决定。
  const extension = options.format === "jpeg" ? "jpg" : options.format;
  const target = reserveToolFilePath(`compressed.${extension}`);
  const result = await module.compressImageAsync(
    sourceUri,
    target.path,
    Math.round(options.maxWidth),
    Math.round(options.maxHeight),
    Math.round(options.quality),
    options.format,
  );
  return {
    uri: result.uri,
    path: result.path,
    width: Number(result.width) || 0,
    height: Number(result.height) || 0,
    sourceWidth: Number(result.sourceWidth) || 0,
    sourceHeight: Number(result.sourceHeight) || 0,
    mime: result.mime,
    size: Number(result.size) || 0,
    format: result.format,
  };
}

export async function openColorSession(
  sourceUri: string,
  maxDimension = 1600,
): Promise<{ id: string; width: number; height: number }> {
  const module = requireMedia();
  const session = await module.openImageSessionAsync(sourceUri, maxDimension);
  return { id: session.id, width: Number(session.width) || 0, height: Number(session.height) || 0 };
}

/** 返回 ARGB（0..4294967295）；越界为 -1。 */
export async function sampleColorPixels(
  sessionId: string,
  points: { x: number; y: number }[],
): Promise<number[]> {
  const module = requireMedia();
  const xs = points.map((point) => Math.round(point.x));
  const ys = points.map((point) => Math.round(point.y));
  const values = await module.samplePixelsAsync(sessionId, xs, ys);
  return values.map((value) => Number(value));
}

export async function closeColorSession(sessionId: string): Promise<void> {
  if (!media) return;
  try {
    await media.closeImageSessionAsync(sessionId);
  } catch {
    // 关闭失败不影响页面退出。
  }
}

// ── 剪贴板 ───────────────────────────────────────────────

export async function readClipboard(): Promise<string | null> {
  if (!clipboard) throw new AppError("validation", "当前构建没有剪贴板模块，请安装最新版 APK");
  try {
    return await clipboard.getTextAsync();
  } catch (error) {
    throw new AppError("validation", `读取剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeClipboard(text: string): Promise<void> {
  if (!clipboard) throw new AppError("validation", "当前构建没有剪贴板模块，请安装最新版 APK");
  try {
    const ok = await clipboard.setTextAsync(text);
    if (!ok) throw new Error("系统拒绝了写入");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("validation", `写入剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 主动分享 ─────────────────────────────────────────────

export async function shareOutText(text: string, subject = ""): Promise<void> {
  if (!share) throw new AppError("validation", "当前构建没有系统分享模块，请安装最新版 APK");
  if (!text.trim()) throw new AppError("validation", "没有可分享的内容");
  try {
    await share.shareTextAsync(text, subject);
  } catch (error) {
    throw new AppError("validation", `打开分享面板失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function shareOutFile(uri: string, mime: string, subject = ""): Promise<void> {
  if (!share) throw new AppError("validation", "当前构建没有系统分享模块，请安装最新版 APK");
  if (!uri.startsWith("file://")) throw new AppError("validation", "只能分享应用私有目录内的文件");
  try {
    const ok = await share.shareFileAsync(uri, mime, subject);
    if (!ok) throw new Error("系统没有接受分享请求");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("validation", `打开分享面板失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
