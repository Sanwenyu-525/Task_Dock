// 采集文件的本地 I/O：暂存目录、持久目录、缩略图、SHA-256 与孤儿清扫。
//
// 目录约定（都在应用私有 document 目录下，应用卸载时会被系统清理）：
// - `taskdock-captures/staging/<id>.<ext>`：相机/扫描会话中尚未确认保存的源文件。
//   拍照后立即从系统缓存复制到这里，保证用户点「保存」时源文件一定还在；
// - `taskdock-captures/library/<时间戳>-<随机>.<ext>`：已保存到本机暂存的持久副本；
// - `taskdock-captures/thumbs/<id>.jpg`：列表缩略图，避免大图在 JS/UI 层反复解码。
//
// 不变量：DB 的 capture_assets 是唯一事实源；启动时按 DB 引用集合清扫孤儿文件，
// 只删除本模块目录内、且明确未被引用的文件，绝不触碰相册、SAF 或桌面端文件。
import { Directory, File, Paths } from "expo-file-system";

import { describeError } from "../../lib/errors";
import { AppError } from "../../lib/errors";
import { newId } from "../../lib/id";
import { copySourceUriToFile } from "../../lib/capture/storage";

const ROOT_DIR = "taskdock-captures";
const STAGING_DIR = "staging";
const LIBRARY_DIR = "library";
const THUMBS_DIR = "thumbs";

export function captureRoot(): Directory {
  return new Directory(Paths.document, ROOT_DIR);
}

export function stagingDirectory(): Directory {
  return new Directory(Paths.document, ROOT_DIR, STAGING_DIR);
}

export function libraryDirectory(): Directory {
  return new Directory(Paths.document, ROOT_DIR, LIBRARY_DIR);
}

export function thumbsDirectory(): Directory {
  return new Directory(Paths.document, ROOT_DIR, THUMBS_DIR);
}

/** 幂等创建采集目录；失败让调用方看到（不能静默进入「保存成功但文件没落盘」）。 */
export function ensureCaptureDirs(): void {
  for (const directory of [
    captureRoot(),
    stagingDirectory(),
    libraryDirectory(),
    thumbsDirectory(),
  ]) {
    if (!directory.exists) {
      directory.create({ intermediates: true, idempotent: true });
    }
  }
}

/** 从 URI/文件名取扩展名；未知时用 jpg（相机默认输出）。 */
export function extensionOf(value: string, fallback = "jpg"): string {
  const clean = value.split(/[?#]/, 1)[0];
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return fallback;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

export function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "pdf":
      return "application/pdf";
    case "m4a":
    case "mp4":
      return ext.toLowerCase() === "m4a" ? "audio/mp4" : "video/mp4";
    case "aac":
      return "audio/aac";
    case "mp3":
      return "audio/mpeg";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 持久副本的存储名：时间戳 + 随机后缀，避免同名冲突；展示名由 DB 保存。 */
export function libraryFileName(ext: string): string {
  return `${stamp()}-${newId("c").slice(-8)}.${ext}`;
}

/**
 * 相机临时文件 → staging 固定副本。
 * 先复制再删临时文件：即使之后系统清理缓存，用户已确认的保存操作仍有可用源。
 */
export async function stageFromTemp(
  tempUri: string,
  extension: string,
): Promise<{ uri: string; size: number }> {
  ensureCaptureDirs();
  const source = new File(tempUri);
  if (!source.exists) {
    throw new AppError("validation", "相机临时文件不可用，请重拍");
  }
  const target = new File(stagingDirectory(), `${newId("staged")}.${extension}`);
  await source.copy(target, { overwrite: true });
  if (!target.exists || target.size <= 0) {
    try {
      target.delete();
    } catch {
      // 目标不存在或不可删时无需补偿。
    }
    throw new AppError("storage", "图片写入失败，请检查存储空间后重试");
  }
  try {
    source.delete();
  } catch {
    // 临时缓存清理失败不影响已落盘的 staging 副本。
  }
  return { uri: target.uri, size: target.size };
}

/**
 * staging → library（同一分区内的移动，不复制大文件）。
 * 调用方随后必须把 DB 行标成 saved；两步之间崩溃时由启动清扫回收无引用文件。
 */
export async function moveToLibrary(
  stagedUri: string,
  extension: string,
): Promise<{ uri: string; size: number }> {
  ensureCaptureDirs();
  const source = new File(stagedUri);
  if (!source.exists) {
    throw new AppError("validation", "采集文件已不存在，请重新拍摄或导入");
  }
  const target = new File(libraryDirectory(), libraryFileName(extension));
  await source.move(target, { overwrite: false });
  if (!target.exists || target.size <= 0) {
    throw new AppError("storage", "保存到本机失败：目标文件不可用");
  }
  return { uri: target.uri, size: target.size };
}

/** 系统分享/相册选择：把 content:// 复制进 library（不可把 content URI 当永久路径）。 */
export async function importToLibrary(
  sourceUri: string,
  extension: string,
): Promise<{ uri: string; size: number }> {
  ensureCaptureDirs();
  const target = new File(libraryDirectory(), libraryFileName(extension));
  // content:// 的 exists/size 不可靠，不能先 File.exists 再 copy；统一走 SAF 句柄
  // 分块复制（storage.ts 的现有机制），支持未知大小、Unicode 文件名和 PDF。
  const size = await copySourceUriToFile(sourceUri, target);
  return { uri: target.uri, size };
}

export async function sha256OfFile(uri: string): Promise<string> {
  const file = new File(uri);
  if (!file.exists) throw new AppError("validation", "文件已不存在，无法计算校验值");
  // 原生增量计算，不把整文件读进 JS 内存。
  return (await file.digest("SHA-256")).toLowerCase();
}

export function fileSizeOf(uri: string): number {
  const file = new File(uri);
  return file.exists ? file.size : 0;
}

export function fileExists(uri: string | null | undefined): boolean {
  if (!uri) return false;
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function deleteFileQuietly(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // 清理失败不影响业务结果；孤儿由启动清扫兜底。
  }
}

function listFiles(directory: Directory): File[] {
  if (!directory.exists) return [];
  try {
    return directory
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.exists);
  } catch {
    return [];
  }
}

/**
 * 孤儿清扫：删除本模块目录内、未被 DB 引用、且超过 staleMs 的文件。
 * 在启动时执行（此时没有进行中的采集写入），避免删掉正在写入的新文件。
 */
export async function sweepOrphanFiles(
  referenced: Set<string>,
  staleMs = 10 * 60 * 1000,
): Promise<number> {
  ensureCaptureDirs();
  const now = Date.now();
  let removed = 0;
  for (const directory of [stagingDirectory(), libraryDirectory(), thumbsDirectory()]) {
    for (const file of listFiles(directory)) {
      if (referenced.has(file.uri)) continue;
      const modified = file.lastModified ?? 0;
      if (now - modified < staleMs) continue;
      try {
        file.delete();
        removed += 1;
      } catch {
        // 单个文件删除失败不阻断其余清扫。
      }
    }
  }
  return removed;
}

/** 保存失败时用于 UI 的错误文案（不吞掉底层原因）。 */
export function fileErrorMessage(error: unknown): string {
  return describeError(error);
}
