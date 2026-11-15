// 采集内容的私有存储：拍照 / 相册 / 分享 / 录音产生的原始字节统一复制进
// `Paths.document/capture/`，业务表只保存 file:// URI。
//
// 为什么不直接存来源 URI：
// - 相册与分享给的是 content:// URI，授权随发送方进程/重启失效，下一次打开就变成坏链；
// - 采集记录要能离线留存、应用重启后仍可预览/发送，必须由应用自己持有字节。
//
// 约束：
// - 只在本机处理，不上传；单文件 50MB、单次采集 9 项、合计 200MB 上限，超限在落盘前拒绝；
// - 文件名只保留 basename 并清洗分隔符/控制字符，防止路径穿越；
// - 复制失败不留半成品（先写临时名，成功后改名，失败删除）。
import { Directory, File, FileMode, Paths } from "expo-file-system";

import type { AttachmentKind } from "../../domain/types";
import { AppError } from "../errors";
import { newId } from "../id";
import {
  MAX_CAPTURE_ITEM_BYTES,
  MAX_CAPTURE_ITEMS,
  MAX_CAPTURE_TOTAL_BYTES,
} from "./limits";

export { MAX_CAPTURE_ITEM_BYTES, MAX_CAPTURE_ITEMS, MAX_CAPTURE_TOTAL_BYTES };

const DIR_NAME = "capture";

const MIME_BY_KIND: Record<AttachmentKind, string> = {
  image: "image/jpeg",
  audio: "audio/mp4",
  file: "application/octet-stream",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/gif": ".gif",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/3gpp": ".3gp",
  "text/plain": ".txt",
  "application/pdf": ".pdf",
};

export function captureRoot(): Directory {
  return new Directory(Paths.document, DIR_NAME);
}

/** 幂等创建私有目录；失败按存储错误上抛，不静默降级到缓存目录。 */
export function ensureCaptureRoot(): Directory {
  const root = captureRoot();
  if (!root.exists) root.create({ idempotent: true, intermediates: true });
  return root;
}

/**
 * 只保留文件名本体：去掉任何目录段、`..`、控制字符与首尾空白。
 * 这是安全边界（分享 URI 的 display name 由外部应用提供，不可信），不是展示美化。
 */
export function sanitizeFileName(raw: string | null | undefined, fallback: string): string {
  const input = (raw ?? "").replace(/\\/g, "/");
  const base = input.slice(input.lastIndexOf("/") + 1);
  // 控制字符 + 路径分隔符 + Windows 保留字符一律替换，避免落盘名带歧义
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+$/, "")
    .trim();
  if (!cleaned) return fallback;
  // 保留扩展名，只截断主名
  const dot = cleaned.lastIndexOf(".");
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  return `${stem.slice(0, 60)}${ext.slice(0, 12)}`;
}

export function extensionForMime(mime: string, kind: AttachmentKind): string {
  return EXTENSION_BY_MIME[mime.trim().toLowerCase()] ?? (kind === "image" ? ".jpg" : kind === "audio" ? ".m4a" : ".bin");
}

/** 生成私有存储里的唯一文件名（不依赖外部传入的名字做路径拼接）。 */
export function attachStorageName(kind: AttachmentKind, mime: string, name?: string | null): string {
  const safe = sanitizeFileName(name, "");
  const fallbackStem = kind === "image" ? "photo" : kind === "audio" ? "voice" : "file";
  const stem = safe ? safe.replace(/\.[^.]*$/, "") : fallbackStem;
  return `${kind}-${newId(stem)}${extensionForMime(mime || MIME_BY_KIND[kind], kind)}`;
}

export interface PersistSource {
  uri: string;
  size?: number | null;
  type?: string | null;
  name?: string | null;
}

export interface PersistedFile {
  localUri: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * 用句柄分块复制：SAF content:// / 未知大小来源的主路径，内存占用与分块大小同阶。
 *
 * `limitBytes`（可选）是本次允许写入的最大字节：每写一块累加一次，超限立即抛出，
 * 不再把剩余内容读完——这就避免了「先落盘 2GB 再判断超限、最后删掉」的写法。
 */
async function copyByHandles(source: File, target: File, limitBytes?: number): Promise<number> {
  const CHUNK = 192 * 1024;
  let read: ReturnType<File["open"]> | null = null;
  let write: ReturnType<File["open"]> | null = null;
  let written = 0;
  try {
    read = source.open(FileMode.ReadOnly);
    write = target.open(FileMode.WriteOnly);
    for (let guard = 0; guard < 1_000_000; guard += 1) {
      const bytes = await read.readBytes(CHUNK);
      if (bytes.length === 0) break;
      written += bytes.length;
      if (typeof limitBytes === "number" && written > limitBytes) {
        throw new AppError(
          "validation",
          `单个附件不能超过 ${Math.round(MAX_CAPTURE_ITEM_BYTES / (1024 * 1024))}MB，请换一张/选一个小一点的文件`,
        );
      }
      await write.writeBytes(bytes);
      if (typeof limitBytes === "number" && written > limitBytes) {
        throw new AppError(
          "validation",
          `单个附件不能超过 ${Math.round(MAX_CAPTURE_ITEM_BYTES / (1024 * 1024))}MB，请换一张/选一个小一点的文件`,
        );
      }
    }
    return written;
  } finally {
    try {
      read?.close();
    } catch {
      // 关闭失败不能掩盖复制错误
    }
    try {
      write?.close();
    } catch {
      // 同上
    }
  }
}

/**
 * 把一个来源 URI 复制到调用方指定的目标文件。
 *
 * 仅供需要自己管理目录的调用方复用（例如采集素材库）；复制语义和
 * persistIntoCaptureStore 相同：content:// / 未知大小走句柄分块，file:// 先尝试原生
 * copy，失败再退回句柄；失败删除半成品，绝不把 content:// 写进数据库。
 */
export async function copySourceUriToFile(
  sourceUri: string,
  target: File,
  options: { expectedSize?: number; limitBytes?: number } = {},
): Promise<number> {
  const sourceFile = new File(sourceUri);
  let declaredSize =
    typeof options.expectedSize === "number" && options.expectedSize > 0
      ? options.expectedSize
      : 0;
  if (declaredSize === 0 && !sourceUri.startsWith("content://")) {
    try {
      declaredSize = Math.max(0, sourceFile.size);
    } catch {
      declaredSize = 0;
    }
  }

  try {
    if (sourceUri.startsWith("content://") || declaredSize <= 0) {
      target.create({ intermediates: true });
      await copyByHandles(sourceFile, target, options.limitBytes);
    } else {
      try {
        await sourceFile.copy(target, { overwrite: true });
      } catch {
        // 某些 SAF provider 声明了 size 但 File.copy 仍不可用；目标可能已留下半成品。
        if (target.exists) target.delete();
        target.create({ intermediates: true });
        await copyByHandles(sourceFile, target, options.limitBytes);
      }
    }

    const written = target.size;
    if (written <= 0) throw new AppError("storage", "复制后的文件为空，请重新选择");
    if (declaredSize > 0 && written < declaredSize) {
      throw new AppError("storage", "复制文件不完整，请重试");
    }
    return written;
  } catch (error) {
    try {
      if (target.exists) target.delete();
    } catch {
      // 清理失败不能覆盖原始错误
    }
    if (error instanceof AppError) throw error;
    throw new AppError("storage", "复制文件失败，请检查存储空间后重试", error);
  }
}

/**
 * 把来源字节复制进私有存储。
 *
 * - 先校验大小上限：超限直接拒绝，不产生半成品；
 * - 目标名完全由本地生成（来源名只用于去掉后缀后的人类可读部分）；
 * - 复制失败删除目标，返回错误让调用方决定是否保留暂存项。
 */
export async function persistIntoCaptureStore(
  source: PersistSource,
  options: {
    kind: AttachmentKind;
    name?: string | null;
    /** 本次采集已占用字节，用于合计上限判定 */
    usedBytes?: number;
  },
): Promise<PersistedFile> {
  const size = typeof source.size === "number" && source.size > 0 ? source.size : 0;
  if (size > MAX_CAPTURE_ITEM_BYTES) {
    throw new AppError(
      "validation",
      `单个附件不能超过 ${Math.round(MAX_CAPTURE_ITEM_BYTES / (1024 * 1024))}MB，请换一张/选一个小一点的文件`,
    );
  }
  const used = Math.max(0, options.usedBytes ?? 0);
  if (used + size > MAX_CAPTURE_TOTAL_BYTES) {
    throw new AppError(
      "validation",
      `本次采集附件合计不能超过 ${Math.round(MAX_CAPTURE_TOTAL_BYTES / (1024 * 1024))}MB，请先保存或移除部分内容`,
    );
  }

  const mime = (source.type ?? "").trim() || MIME_BY_KIND[options.kind];
  const name = sanitizeFileName(options.name ?? source.name ?? "", "");
  // 展示名只去掉控制字符：`语音 0:22` 这类带冒号的名称不该被落盘清洗规则改写，
  // 落盘名使用下面的 storageName（完全由本地生成）。
  const displayName = (options.name ?? source.name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const storageName = attachStorageName(options.kind, mime, name);
  const root = ensureCaptureRoot();
  const target = new File(root, storageName);
  const sourceFile = new File(source.uri);

  try {
    // 未知大小（content:// 常见）或 SAF 来源：直接走可计数流式复制，边写边判，
    // 超过单文件/本次合计上限立即中止并删半成品；不能只靠「先写完再校验」。
    const needsStream = size <= 0 || source.uri.startsWith("content://");
    if (needsStream) {
      const remaining = Math.max(0, MAX_CAPTURE_TOTAL_BYTES - used);
      const limit = Math.min(MAX_CAPTURE_ITEM_BYTES, remaining);
      if (remaining <= 0) {
        throw new AppError(
          "validation",
          `本次采集附件合计不能超过 ${Math.round(MAX_CAPTURE_TOTAL_BYTES / (1024 * 1024))}MB，请先保存或移除部分内容`,
        );
      }
      target.create({ intermediates: true });
      const streamed = await copyByHandles(sourceFile, target, limit);
      if (streamed <= 0) throw new AppError("storage", "复制后的文件为空，请重新选择");
    } else {
      try {
        await sourceFile.copy(target, { overwrite: true });
      } catch {
        // content:// 或不支持 copy 的来源：退回句柄复制
        if (target.exists) target.delete();
        target.create({ intermediates: true });
        await copyByHandles(sourceFile, target, Math.min(MAX_CAPTURE_ITEM_BYTES, Math.max(0, MAX_CAPTURE_TOTAL_BYTES - used)));
      }
    }
    const written = target.size;
    if (written <= 0) throw new AppError("storage", "复制后的文件为空，请重新选择");
    // 来源声明的 size 不可信（content:// 常缺省、甚至小于真实字节）：以落盘后的真实字节为准。
    // 超限必须在删除半成品后失败，否则会留下无业务引用的完整大文件。
    if (written > MAX_CAPTURE_ITEM_BYTES) {
      throw new AppError(
        "validation",
        `单个附件不能超过 ${Math.round(MAX_CAPTURE_ITEM_BYTES / (1024 * 1024))}MB，请换一张/选一个小一点的文件`,
      );
    }
    if (used + written > MAX_CAPTURE_TOTAL_BYTES) {
      throw new AppError(
        "validation",
        `本次采集附件合计不能超过 ${Math.round(MAX_CAPTURE_TOTAL_BYTES / (1024 * 1024))}MB，请先保存或移除部分内容`,
      );
    }
    if (size > 0 && written < size) {
      throw new AppError("storage", "复制文件不完整，请重试");
    }
    return {
      localUri: target.uri,
      name: displayName || storageName,
      mime,
      // 以真实字节记账，UI 合计/数据库守卫才能和磁盘一致
      size: written,
    };
  } catch (error) {
    try {
      if (target.exists) target.delete();
    } catch {
      // 清理失败不覆盖原始错误
    }
    if (error instanceof AppError) throw error;
    throw new AppError("storage", "保存到本机私有存储失败，请检查剩余空间后重试", error);
  }
}

/** 删除私有存储中的文件；文件已不存在视为成功（不抛错给业务层）。 */
export function deleteStoredFileQuietly(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // 清理是尽力而为：失败不影响业务状态，用户仍可手动清理
  }
}

export function storedFileSize(uri: string): number {
  try {
    const file = new File(uri);
    return file.exists ? file.size : 0;
  } catch {
    return 0;
  }
}

/**
 * 原生模块返回的是绝对路径（/data/user/0/...），expo-file-system 需要 file:// URI。
 * 集中在这里转换，避免每个调用点各写一份字符串拼接。
 */
export function fileUriFromPath(path: string): string {
  if (path.startsWith("file://") || path.startsWith("content://")) return path;
  return path.startsWith("/") ? `file://${path}` : path;
}

/**
 * file:// URI → 原生模块可用的绝对路径。
 *
 * expo-file-system 返回的 uri 会做百分号编码（中文文件名、空格都会变成 %E8%AD…），
 * 直接截掉 scheme 交给 Kotlin `File(path)` 会得到「文件不存在」。这里统一解码；
 * 解码失败时退回原文，让调用方拿到明确错误而不是静默丢失。
 */
export function pathFromFileUri(uri: string): string {
  const withoutScheme = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  if (withoutScheme.startsWith("content://")) return withoutScheme;
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}
