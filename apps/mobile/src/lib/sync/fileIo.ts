// 文件互传的原生 I/O：系统文件选择、SAF 目录授权、分块读写与打开文件。
//
// 只使用 `expo-file-system` 58 已提供的 API：
// - `File.pickFileAsync({ multipleFiles: true })` 走 Android ACTION_OPEN_DOCUMENT；
// - `Directory.pickDirectoryAsync()` 走 ACTION_OPEN_DOCUMENT_TREE，并持久化 URI 授权；
// - `File.open(mode)` 返回 FileHandle，按 192KB 顺序读写，避免把整文件读进内存；
// - `File.preview()` 交给系统查看器打开，不依赖 expo-sharing。
//
// 注意：SAF content:// URI 不支持 ReadWrite 模式，下载只使用 WriteOnly。

import { Directory, File as FsFile, FileMode } from "expo-file-system";

import { AppError } from "../errors";

import { FILE_CANCELLED_MESSAGE, type FileClient, type RemoteFile } from "./files";

type Handle = ReturnType<FsFile["open"]>;

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  zip: "application/zip",
  apk: "application/vnd.android.package-archive",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "application/octet-stream";
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/** MIME → 扩展名，只用于「选择器没给显示名」时的回退命名。 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
};

/**
 * 上传时使用的文件名。
 *
 * vivo 文件管理器把 `content://` URI 的末段返回成 `document:<数字>`（不是显示名），
 * expo-file-system 的 `File.name` 只做 `Paths.basename(uri)`，因此这里识别这种
 * 非显示名并回退为「手机文件-时间戳.扩展名」；AOSP 选择器返回的路径式 URI 不受影响。
 */
export function uploadDisplayName(file: FsFile): string {
  const raw = (file.name ?? "").trim();
  if (raw && !/^document:\d+$/i.test(raw) && !/^\d+$/.test(raw)) return raw;
  const extension = EXTENSION_BY_MIME[file.type] ?? "";
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `手机文件-${stamp}${extension}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** SAF URI 末段作为展示名；解码失败时退回原 URI。 */
export function directoryLabel(uri: string): string {
  const trimmed = uri.replace(/\/+$/, "");
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(segment) || trimmed;
  } catch {
    return segment || trimmed;
  }
}

export async function pickLocalFiles(): Promise<FsFile[]> {
  const result = await FsFile.pickFileAsync({ multipleFiles: true });
  return result.canceled ? [] : result.result;
}

/** 让用户选择接收目录；返回可持久使用的 SAF URI。 */
export async function pickSaveDirectory(): Promise<string> {
  const directory = await Directory.pickDirectoryAsync();
  return directory.uri;
}

/** FileHandle.readBytes 可能一次读不满；循环补齐，EOF 时提前返回。 */
async function readExactly(handle: Handle, length: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < length) {
    const part = await handle.readBytes(length - total);
    if (part.length === 0) break;
    parts.push(part);
    total += part.length;
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/** 取消意图由调用方持有：client.cancel() 只能中止在途请求，分块之间必须再查一次。 */
function throwIfCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) {
    throw new AppError("network", FILE_CANCELLED_MESSAGE);
  }
}

/**
 * 手机 → 电脑：按服务端返回的 chunk_size 顺序读取并上传。
 * 任一步失败都尝试删除桌面端的半成品记录；删除失败不覆盖原始错误。
 */
export async function uploadLocalFile(
  client: FileClient,
  file: FsFile,
  onProgress: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<RemoteFile> {
  const size = file.size;
  if (!Number.isFinite(size) || size <= 0) {
    throw new AppError("validation", "无法读取文件大小，请重新选择");
  }

  const created = await client.create(uploadDisplayName(file), size);
  let handle: Handle | null = null;
  try {
    handle = file.open(FileMode.ReadOnly);
    for (let index = 0; index < created.chunks; index += 1) {
      throwIfCancelled(isCancelled);
      const expected = Math.min(created.chunk_size, size - index * created.chunk_size);
      const bytes = await readExactly(handle, expected);
      if (bytes.length !== expected) {
        throw new AppError("validation", "读取文件内容不完整，请重试");
      }
      await client.uploadChunk(created.id, index, bytes);
      throwIfCancelled(isCancelled);
      onProgress(index + 1, created.chunks);
    }
  } catch (error) {
    await client.remove(created.id).catch(() => undefined);
    throw error;
  } finally {
    handle?.close();
  }
  return client.complete(created.id);
}

/**
 * 电脑 → 手机：写入用户选择的 SAF 目录，成功后返回本地 URI。
 * 中途失败会删除半成品，避免用户看到一个大小不对的文件。
 */
export async function downloadRemoteFile(
  client: FileClient,
  file: RemoteFile,
  directoryUri: string,
  onProgress: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<string> {
  const directory = new Directory(directoryUri);
  const target = directory.createFile(file.name, mimeForName(file.name));
  let handle: Handle | null = null;
  let completed = false;
  try {
    handle = target.open(FileMode.WriteOnly);
    for (let index = 0; index < file.chunks; index += 1) {
      throwIfCancelled(isCancelled);
      const bytes = await client.downloadChunk(file.id, index);
      throwIfCancelled(isCancelled);
      await handle.writeBytes(bytes);
      onProgress(index + 1, file.chunks);
    }
    completed = true;
  } finally {
    try {
      handle?.close();
    } catch {
      // 取消时底层通道可能已失效；关闭失败不能阻止半成品清理。
    }
    // SAF 的 delete 在文件句柄未关闭时会失败；必须先 close 再删半成品，
    // 否则取消/失败会在用户目录里留下一个大小不对的文件（真机实测）。
    if (!completed) {
      try {
        target.delete();
      } catch {
        // 半成品删除失败不影响错误上抛；用户可手动清理。
      }
    }
  }
  return target.uri;
}

export async function previewLocalFile(uri: string): Promise<void> {
  const file = new FsFile(uri);
  if (!file.exists) {
    throw new AppError("validation", "文件已不存在，请重新下载");
  }
  await file.preview();
}
