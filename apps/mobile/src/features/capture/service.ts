// 采集服务：把「拍照 → 本机暂存 / 系统相册 / 发送电脑 / 桌面暂存架」串成一条链路。
//
// 设计原则：
// - 每个目的地独立执行、独立记录状态；一个失败不回滚其他已完成的结果；
// - 所有远端传输复用 `lib/sync/fileIo.uploadLocalFile` 的 192KB 分块 + TLS v2 通道，
//   不另写上传逻辑；超过 200MB 直接报错，不静默压缩；
// - 暂存架是「上传成功 + 导入成功」两步：上传成功但导入失败时，桌面目的地保持 done，
//   暂存架目的地 failed，UI 必须显示「文件已发送到电脑，但加入暂存架失败」；
// - 未配对/老连接/令牌缺失一律 fail-closed（提示重新配对），不降级明文。
import { File as FsFile } from "expo-file-system";

import * as repo from "../../db/captureAssets";
import { loadConnection, readToken } from "../../db/syncConnection";
import { AppError, describeError } from "../../lib/errors";
import { deriveSyncKey } from "../../lib/sync/crypto";
import { isLegacyConnection } from "../../lib/sync/connectionState";
import { isOpaqueFileName, uploadDisplayName, uploadLocalFile } from "../../lib/sync/fileIo";
import {
  createFileClient,
  FILE_CANCELLED_MESSAGE,
  isFileCancelled,
  type FileClient,
  type RemoteFile,
  type RemoteShelfGroup,
} from "../../lib/sync/files";
import {
  classifyTransferFailure,
  reusableRemoteKey,
  transferFailureMessage,
  type TransferFailure,
} from "../../lib/sync/transferError";

import { createPdfFromImages, createThumbnail, resolveDisplayName, saveToSystemGallery, transformImage } from "./album";
import {
  deleteFileQuietly,
  ensureCaptureDirs,
  extensionOf,
  fileExists,
  importToLibrary,
  moveToLibrary,
  sha256OfFile,
  sweepOrphanFiles,
  stageFromTemp,
} from "./files";

/** 与服务端 files::MAX_FILE_BYTES 一致；超过时要求用户自行压缩/拆分。 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 未确认保存的采集会话保留时长：超时后启动清扫，避免临时文件无限增长。 */
const STAGED_RETENTION_MS = 24 * 60 * 60 * 1000;

export type DesktopTarget = "inbox" | "shelf";
export type DestinationChoice = {
  local: boolean;
  album: boolean;
  desktop: boolean;
  desktopTarget: DesktopTarget;
  shelfGroupId: string | null;
};

export interface SendProgress {
  assetId: string;
  index: number;
  count: number;
  done: number;
  total: number;
}

export interface SendOutcome {
  assetId: string;
  state: "done" | "failed" | "cancelled" | "pending";
  remoteId?: string;
  shelfId?: string;
  message?: string;
}

export interface PairingAvailability {
  paired: boolean;
  legacy: boolean;
  serverName: string | null;
  reason: string | null;
}

/** 启动对账：恢复中断状态 + 清理过期 staging 与孤儿文件（只清本模块目录）。 */
export async function initializeCaptureStore(): Promise<{ recovered: number; swept: number }> {
  ensureCaptureDirs();
  const recovered = await repo.recoverInterruptedDestinations();
  const expired = await repo.deleteStagedAssetsOlderThan(Date.now() - STAGED_RETENTION_MS);
  for (const path of expired) deleteFileQuietly(path);
  const referenced = new Set(await repo.listReferencedPaths());
  const swept = await sweepOrphanFiles(referenced, 10 * 60 * 1000);
  return { recovered, swept };
}

export async function captureAvailability(): Promise<PairingAvailability> {
  const connection = await loadConnection();
  if (!connection) {
    return { paired: false, legacy: false, serverName: null, reason: "尚未与电脑配对" };
  }
  if (isLegacyConnection(connection)) {
    return {
      paired: false,
      legacy: true,
      serverName: connection.serverName,
      reason: "桌面端已升级加密传输，请重新配对",
    };
  }
  const token = await readToken();
  if (!token) {
    return {
      paired: false,
      legacy: false,
      serverName: connection.serverName,
      reason: "配对令牌缺失，请重新配对",
    };
  }
  return { paired: true, legacy: false, serverName: connection.serverName, reason: null };
}

async function openFileClient(): Promise<{ client: FileClient; serverName: string }> {
  const availability = await captureAvailability();
  if (!availability.paired) {
    throw new AppError("validation", availability.reason ?? "尚未与电脑配对");
  }
  const connection = await loadConnection();
  const token = await readToken();
  if (!connection || !token) {
    throw new AppError("validation", "配对信息不完整，请重新配对");
  }
  return {
    client: createFileClient({
      baseUrl: connection.baseUrl,
      token,
      syncKey: await deriveSyncKey(token),
    }),
    serverName: connection.serverName,
  };
}

function mimeOf(asset: repo.CaptureAsset): string {
  if (asset.mime && asset.mime !== "application/octet-stream") return asset.mime;
  return asset.mime;
}

/**
 * 读取桌面端有效暂存分组（导入前选择）。
 * 老桌面端没有该接口时返回空数组，调用方退回默认分组，不阻断上传；
 * 授权/安全失败仍然抛出（不能把令牌失效当成「没有分组」）。
 */
export async function listShelfGroups(): Promise<RemoteShelfGroup[]> {
  const { client } = await openFileClient();
  try {
    try {
      return await client.shelfGroups();
    } catch (error) {
      const failure = classifyTransferFailure(error, { endpoint: "groups" });
      if (failure.kind === "not_supported") return [];
      throw error;
    }
  } finally {
    client.cancel();
  }
}

/**
 * 保存到本机采集暂存：staging → library，再写 SHA-256 与缩略图，最后一行事务标记 saved。
 * 事务失败时删除已移动的 library 文件，避免孤儿（启动清扫仍会兜底）。
 */
export async function saveToLocal(asset: repo.CaptureAsset): Promise<repo.CaptureAsset> {
  if (asset.state === "saved") return asset;
  const source = asset.localPath;
  if (!source || !fileExists(source)) {
    throw new AppError("validation", "采集文件已不存在，无法保存到本机");
  }
  const ext = extensionOf(source, extensionOf(asset.name));
  const moved = await moveToLibrary(source, ext);
  try {
    const sha256 = await sha256OfFile(moved.uri);
    // 非图片（例如扫描 PDF）没有可用的位图缩略图，列表用类型图标。
    const thumb = asset.mime.startsWith("image/") ? await createThumbnail(moved.uri, 512) : null;
    await repo.markAssetSaved(asset.id, {
      localPath: moved.uri,
      byteSize: moved.size,
      sha256,
      thumbnailPath: thumb?.uri ?? null,
    });
  } catch (error) {
    // 回滚而不是删除：记录仍是 staged 且指向原 staging 路径，只有把字节挪回去，
    // 用户才能重试保存；直接删掉会留下「行在、文件没了」的坏记录（等于丢素材）。
    try {
      const movedBack = new FsFile(moved.uri);
      if (movedBack.exists) {
        await movedBack.move(new FsFile(source), { overwrite: false });
      }
    } catch {
      // 挪不回去才删除，至少不在 library 里留下无行引用的孤儿（启动清扫仍会兜底）。
      deleteFileQuietly(moved.uri);
    }
    throw error;
  }
  const updated = await repo.getAsset(asset.id);
  if (!updated) throw new AppError("storage", "保存后读取素材记录失败");
  return updated;
}

/** 真正写入系统相册（MediaStore）；失败把原因写进 album 目的地，不吞错。 */
export async function saveToAlbum(asset: repo.CaptureAsset): Promise<void> {
  const source = asset.localPath;
  if (!source || !fileExists(source)) {
    const message = "采集文件已不存在，无法保存到相册";
    await repo.setDestination(asset.id, "album", { state: "failed", lastError: message });
    throw new AppError("validation", message);
  }
  await repo.setDestination(asset.id, "album", {
    state: "running",
    bytesTotal: asset.byteSize,
  });
  try {
    const saved = await saveToSystemGallery(source, asset.name, mimeOf(asset));
    await repo.setDestination(asset.id, "album", {
      state: "done",
      albumUri: saved.uri,
      bytesDone: asset.byteSize,
      bytesTotal: asset.byteSize,
    });
  } catch (error) {
    const message = describeError(error);
    await repo.setDestination(asset.id, "album", { state: "failed", lastError: message });
    throw new AppError("storage", message, error);
  }
}

/** 远端可复用记录的索引：只收本设备「已就绪」的 to_desktop 记录（服务端已按设备过滤）。 */
interface RemoteReuseIndex {
  byHash: Map<string, RemoteFile[]>;
  byName: Map<string, RemoteFile[]>;
}

function pushIndex(map: Map<string, RemoteFile[]>, key: string, file: RemoteFile): void {
  const list = map.get(key);
  if (list) list.push(file);
  else map.set(key, [file]);
}

function removeIndexed(map: Map<string, RemoteFile[]>, file: RemoteFile): void {
  for (const [key, list] of map) {
    const index = list.indexOf(file);
    if (index >= 0) {
      list.splice(index, 1);
      if (list.length === 0) map.delete(key);
      return;
    }
  }
}

function buildReuseIndex(files: RemoteFile[]): RemoteReuseIndex {
  const byHash = new Map<string, RemoteFile[]>();
  const byName = new Map<string, RemoteFile[]>();
  for (const file of files) {
    if (file.direction !== "to_desktop" || file.status !== "ready" || file.size <= 0) continue;
    const key = reusableRemoteKey({
      name: file.name,
      size: file.size,
      sha256: file.sha256,
    });
    if (key.withHash) pushIndex(byHash, key.withHash, file);
    pushIndex(byName, key.byName, file);
  }
  return { byHash, byName };
}

/**
 * 找出「上一次已经传完、但手机没来得及写库」的远端记录（重试幂等）。
 *
 * 判定依据优先 SHA-256（忽略文件名：桌面端会把 `< > : " | ? *` 清洗成 `_`）；
 * 本地还没有摘要时才用「同名同大小」做候选，并现场计算本地摘要确认内容一致，
 * 避免误复用同名不同内容的文件。命中后从索引移除，两条素材不会抢同一条记录。
 */
async function takeReusableRemote(
  index: RemoteReuseIndex,
  asset: repo.CaptureAsset,
): Promise<RemoteFile | null> {
  if (!asset.byteSize || asset.byteSize <= 0) return null;
  const key = reusableRemoteKey({
    name: asset.name,
    size: asset.byteSize,
    sha256: asset.sha256,
  });
  let candidate: RemoteFile | null = null;
  if (key.withHash) {
    candidate = index.byHash.get(key.withHash)?.[0] ?? null;
  }
  if (!candidate) {
    const sameName = index.byName.get(key.byName);
    if (sameName && sameName.length === 1 && asset.localPath) {
      const computed = await sha256OfFile(asset.localPath).catch(() => null);
      if (computed && sameName[0].sha256.trim().toLowerCase() === computed.toLowerCase()) {
        candidate = sameName[0];
      }
    }
  }
  if (!candidate) return null;
  removeIndexed(index.byHash, candidate);
  removeIndexed(index.byName, candidate);
  return candidate;
}

/** 暂存架失败：保留「文件已上传」的事实，只把 shelf 目的地标成失败/取消。 */
function shelfFailureOf(error: unknown): {
  failure: TransferFailure;
  message: string;
  state: "pending" | "failed" | "cancelled";
} {
  const failure = classifyTransferFailure(error, { endpoint: "shelf" });
  if (failure.kind === "cancelled") {
    return { failure, message: "暂存架导入已取消", state: "cancelled" };
  }
  const state: "pending" | "failed" = failure.pending ? "pending" : "failed";
  return {
    failure,
    message:
      state === "pending"
        ? `文件已发送到电脑，暂存架暂未导入完成：${transferFailureMessage(failure)}`
        : `文件已发送到电脑，但加入暂存架失败：${transferFailureMessage(failure)}`,
    state,
  };
}

async function importRemoteToShelf(
  client: FileClient,
  asset: repo.CaptureAsset,
  remote: RemoteFile,
  groupId: string | null,
): Promise<TransferFailure | null> {
  try {
    const imported = await client.importToShelf(remote.id, groupId);
    await repo.setDestination(asset.id, "shelf", {
      state: "done",
      remoteId: remote.id,
      remoteShelfId: imported.shelf_item_id ?? null,
      bytesDone: asset.byteSize,
      bytesTotal: asset.byteSize,
    });
    return null;
  } catch (error) {
    const { failure, message, state } = shelfFailureOf(error);
    await repo.setDestination(asset.id, "shelf", {
      state,
      remoteId: remote.id,
      lastError: message,
    });
    return { ...failure, message };
  }
}

export interface SendResult {
  outcomes: SendOutcome[];
  offline: boolean;
  message?: string;
  /** true = 授权/安全类失败，调用方必须停止继续发送本批其他文件。 */
  stopBatch?: boolean;
}

/**
 * 发送到电脑：先做一次可连接性检查（list），并按同一套分类决定 pending / failed。
 *
 * 关键语义（P0-01）：
 * - 电脑关闭、断网、超时、429/5xx → pending（保留在本机，允许稍后重试）；
 * - 401/403、TLS 指纹/握手失败、协议版本不支持 → failed + 停止整批，绝不伪装成离线；
 * - 用户取消 → cancelled；
 * - 上传前先用 `list` 结果做幂等复用：上次已传完但没写库的文件不再重传，避免重复文件。
 */
export async function sendToDesktop(
  assets: repo.CaptureAsset[],
  options: {
    target: DesktopTarget;
    shelfGroupId?: string | null;
    onProgress?: (progress: SendProgress) => void;
    isCancelled?: () => boolean;
    /** 批量中的位置：逐条调用时仍能显示「第 2/5 张」而不是 1/1。 */
    batch?: { index: number; count: number };
  },
): Promise<SendResult> {
  if (assets.length === 0) return { outcomes: [], offline: false };
  const outcomes: SendOutcome[] = [];

  /** 把从 from 起的素材统一标记为同一个结果（批量终止时使用）。 */
  async function markFrom(from: number, failure: TransferFailure): Promise<void> {
    const state: SendOutcome["state"] = failure.pending ? "pending" : "failed";
    const message = transferFailureMessage(failure);
    for (let index = from; index < assets.length; index += 1) {
      const asset = assets[index];
      await repo.setDestination(asset.id, "desktop", {
        state,
        bytesTotal: asset.byteSize,
        lastError: message,
      });
      if (options.target === "shelf") {
        await repo.setDestination(asset.id, "shelf", { state, lastError: message });
      }
      outcomes.push({ assetId: asset.id, state, message });
    }
  }

  // 未配对/令牌失效不是「电脑暂时离线」：直接标 failed 并给出配对原因，
  // 不能提示「等待电脑连接」，否则用户会以为稍后自动重试就能成功。
  const availability = await captureAvailability();
  if (!availability.paired) {
    const message = availability.reason ?? "尚未与电脑配对";
    await markFrom(0, {
      kind: "auth",
      pending: false,
      retryable: false,
      stopsBatch: true,
      message,
    });
    return { outcomes, offline: false, message, stopBatch: true };
  }

  let client: FileClient | null = null;
  let reuse: RemoteReuseIndex = { byHash: new Map(), byName: new Map() };
  try {
    ({ client } = await openFileClient());
    reuse = buildReuseIndex(await client.list());
  } catch (error) {
    client?.cancel();
    const failure = classifyTransferFailure(error, { endpoint: "list" });
    await markFrom(0, failure);
    return {
      outcomes,
      offline: failure.pending,
      message: transferFailureMessage(failure),
      stopBatch: failure.stopsBatch,
    };
  }

  const activeClient = client;
  try {
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      if (options.isCancelled?.()) {
        await repo.setDestination(asset.id, "desktop", { state: "cancelled" });
        outcomes.push({ assetId: asset.id, state: "cancelled" });
        continue;
      }
      const source = asset.localPath;
      if (!source || !fileExists(source)) {
        const message = "采集文件已不存在，无法发送";
        await repo.setDestination(asset.id, "desktop", { state: "failed", lastError: message });
        outcomes.push({ assetId: asset.id, state: "failed", message });
        continue;
      }
      if (asset.byteSize > MAX_UPLOAD_BYTES) {
        const message = "文件超过 200MB 上限，请压缩或拆分后重试";
        await repo.setDestination(asset.id, "desktop", { state: "failed", lastError: message });
        outcomes.push({ assetId: asset.id, state: "failed", message });
        continue;
      }

      await repo.setDestination(asset.id, "desktop", {
        state: "running",
        bytesTotal: asset.byteSize,
      });
      try {
        // 幂等复用：上次已完整上传（可能应用在写库前被杀）就不重复上传。
        const remote =
          (await takeReusableRemote(reuse, asset)) ??
          (await uploadLocalFile(
            activeClient,
            new FsFile(source),
            (done, total) => {
              options.onProgress?.({
                assetId: asset.id,
                index: options.batch?.index ?? index,
                count: options.batch?.count ?? assets.length,
                done,
                total,
              });
            },
            options.isCancelled,
            asset.name,
          ));
        await repo.setDestination(asset.id, "desktop", {
          state: "done",
          remoteId: remote.id,
          bytesDone: asset.byteSize,
          bytesTotal: asset.byteSize,
        });

        if (options.target === "shelf") {
          const shelfFailure = await importRemoteToShelf(
            activeClient,
            asset,
            remote,
            options.shelfGroupId ?? null,
          );
          if (!shelfFailure) {
            outcomes.push({ assetId: asset.id, state: "done", remoteId: remote.id });
          } else {
            // 上传已成功：桌面目的地保持 done，暂存架单独 pending/failed（UI 必须分开显示）。
            const shelfState =
              shelfFailure.kind === "cancelled"
                ? "cancelled"
                : shelfFailure.pending
                  ? "pending"
                  : "failed";
            outcomes.push({
              assetId: asset.id,
              state: shelfState,
              remoteId: remote.id,
              message: shelfFailure.message ?? transferFailureMessage(shelfFailure),
            });
            if (shelfFailure.stopsBatch) {
              await markFrom(index + 1, shelfFailure);
              return {
                outcomes,
                offline: false,
                message: transferFailureMessage(shelfFailure),
                stopBatch: true,
              };
            }
          }
        } else {
          outcomes.push({ assetId: asset.id, state: "done", remoteId: remote.id });
        }
      } catch (error) {
        if (isFileCancelled(error)) {
          await repo.setDestination(asset.id, "desktop", {
            state: "cancelled",
            lastError: FILE_CANCELLED_MESSAGE,
          });
          outcomes.push({ assetId: asset.id, state: "cancelled" });
          continue;
        }
        const failure = classifyTransferFailure(error, { endpoint: "upload" });
        const message = transferFailureMessage(failure);
        const state: SendOutcome["state"] = failure.pending ? "pending" : "failed";
        await repo.setDestination(asset.id, "desktop", {
          state,
          bytesTotal: asset.byteSize,
          lastError: message,
        });
        outcomes.push({ assetId: asset.id, state, message });
        if (failure.stopsBatch) {
          await markFrom(index + 1, failure);
          return { outcomes, offline: false, message, stopBatch: true };
        }
      }
    }
  } finally {
    activeClient.cancel();
  }
  return { outcomes, offline: false };
}

export interface ImportOutcome {
  created: repo.CaptureAsset[];
  failures: string[];
}

function extensionFromMime(mime: string): string {
  const sub = mime.split("/")[1]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (sub === "jpeg") return "jpg";
  if (/^[a-z0-9]{1,8}$/.test(sub)) return sub;
  return "bin";
}

/**
 * 相册/系统文件导入：系统选择器返回 content:// 时先复制进应用 library，
 * 再写 SHA-256、缩略图与 saved 记录。单个文件失败不影响其余文件。
 * 不做「扫描整个相册」——只处理用户在当前系统选择器里明确选中的文件。
 */
export async function importLocalFiles(
  files: FsFile[],
  options: {
    source?: "gallery" | "file_picker";
    onProgress?: (index: number, count: number, name: string) => void;
  } = {},
): Promise<ImportOutcome> {
  const created: repo.CaptureAsset[] = [];
  const failures: string[] = [];
  ensureCaptureDirs();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    // 系统选择器给的名字不可信（vivo 会返回 `document:1000069262`）；
    // 先用 ContentResolver 取真实 DISPLAY_NAME，取不到才用时间戳兜底名。
    let displayName = uploadDisplayName(file);
    let resolvedMime = "";
    let resolvedSize = 0;
    if (isOpaqueFileName(file.name) && file.uri.startsWith("content://")) {
      const resolved = await resolveDisplayName(file.uri);
      if (resolved) {
        displayName = resolved.name;
        resolvedMime = resolved.mime;
        resolvedSize = resolved.size;
      }
    }
    options.onProgress?.(index, files.length, displayName);
    if (!file.exists) {
      failures.push(`${displayName}：文件不可读取`);
      continue;
    }
    const declaredSize = file.size > 0 ? file.size : resolvedSize;
    if (declaredSize <= 0 && file.uri.startsWith("file://")) {
      failures.push(`${displayName}：文件为空`);
      continue;
    }
    const mime = file.type || resolvedMime || "application/octet-stream";
    const ext = extensionOf(file.name || file.uri, extensionFromMime(mime));
    let copied: { uri: string; size: number } | null = null;
    let stagedId: string | null = null;
    let thumbnailUri: string | null = null;
    try {
      copied = await importToLibrary(file.uri, ext);
      const sha256 = await sha256OfFile(copied.uri);
      const thumb = mime.startsWith("image/") ? await createThumbnail(copied.uri, 512) : null;
      thumbnailUri = thumb?.uri ?? null;
      const staged = await repo.createStagedAsset({
        kind: mime.startsWith("image/") ? "photo" : "file",
        source: options.source ?? "file_picker",
        name: displayName,
        localPath: copied.uri,
        mime,
        byteSize: copied.size,
        width: null,
        height: null,
      });
      stagedId = staged.id;
      await repo.markAssetSaved(staged.id, {
        localPath: copied.uri,
        byteSize: copied.size,
        sha256,
        thumbnailPath: thumbnailUri,
      });
      const saved = await repo.getAsset(staged.id);
      if (saved) created.push(saved);
    } catch (error) {
      const cleanupErrors: string[] = [];
      // 先删数据库行：只有记录删成功后才删文件，避免留下「行还在、文件没了」的数据丢失。
      let recordRemoved = true;
      if (stagedId) {
        try {
          const paths = await repo.deleteAsset(stagedId);
          for (const path of paths) {
            deleteFileForCleanup(path, cleanupErrors);
          }
        } catch (cleanupError) {
          recordRemoved = false;
          cleanupErrors.push(`清理资产记录失败：${describeError(cleanupError)}`);
        }
      }
      if (recordRemoved) {
        deleteFileForCleanup(copied?.uri, cleanupErrors);
        if (thumbnailUri !== copied?.uri) deleteFileForCleanup(thumbnailUri, cleanupErrors);
      }
      failures.push(
        `${displayName}：${describeError(error)}${
          cleanupErrors.length > 0 ? `；清理未完成：${cleanupErrors.join("；")}` : ""
        }`,
      );
    }
  }
  return { created, failures };
}

/** 导入失败清理文件时保留诊断：不能把删除失败静默吞掉，否则会留下无法解释的孤儿。 */
function deleteFileForCleanup(uri: string | null | undefined, errors: string[]): void {
  if (!uri) return;
  try {
    const file = new FsFile(uri);
    if (file.exists) file.delete();
  } catch (error) {
    errors.push(`删除文件失败（${uri.split("/").pop() ?? "未知文件"}）：${describeError(error)}`);
  }
}

function scanPdfName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `扫描-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}.pdf`
  );
}

/**
 * 多页图片合成一个 A4 PDF 并进入 staging：
 * - 页序 = pages 数组顺序（重排在 UI 侧完成）；
 * - 任一页文件丢失时整体失败，绝不生成缺页 PDF；
 * - PDF 落盘成功后才删除页面 staging 记录（页面已嵌入 PDF），失败时原页保持不动。
 */
export async function createScanPdf(
  pages: repo.CaptureAsset[],
  options: { name?: string } = {},
): Promise<repo.CaptureAsset> {
  if (pages.length === 0) throw new AppError("validation", "还没有扫描页，请先拍摄");
  for (const page of pages) {
    if (!page.localPath || !fileExists(page.localPath)) {
      throw new AppError("validation", `扫描页「${page.name}」文件已丢失，请重拍后再导出`);
    }
  }
  const result = await createPdfFromImages(pages.map((page) => page.localPath as string));
  const staged = await stageFromTemp(result.uri, "pdf");
  let asset: repo.CaptureAsset | null = null;
  try {
    asset = await repo.createStagedAsset({
      kind: "scan",
      source: "scan",
      name: options.name ?? scanPdfName(),
      localPath: staged.uri,
      mime: "application/pdf",
      byteSize: staged.size,
      width: null,
      height: null,
    });
    const sha256 = await sha256OfFile(staged.uri);
    await repo.updateAssetMedia(asset.id, {
      localPath: staged.uri,
      byteSize: staged.size,
      sha256,
      width: null,
      height: null,
      thumbnailPath: null,
    });
  } catch (error) {
    deleteFileQuietly(staged.uri);
    if (asset) await repo.deleteAsset(asset.id).catch(() => []);
    throw error;
  }
  // PDF 已落盘：删除页面文件，避免同一批扫描图在 staging 里重复占用空间。
  for (const page of pages) {
    const paths = await repo.deleteAsset(page.id).catch(() => []);
    for (const path of paths) deleteFileQuietly(path);
  }
  const saved = await repo.getAsset(asset.id);
  if (!saved) throw new AppError("storage", "PDF 生成后读取记录失败");
  return saved;
}

/**
 * 仅重试暂存架的结构化结果（页面批量循环的统一契约）。
 *
 * 业务失败不抛异常：调用方必须能区分 pending / failed / cancelled，
 * 并根据 stopBatch 决定是否终止整批；成功的前序项目不回滚。
 */
export interface ShelfImportRetryResult {
  state: "done" | "pending" | "failed" | "cancelled";
  remoteId: string;
  remoteShelfId?: string | null;
  failure?: TransferFailure;
  message: string;
  /** true = 授权/TLS 等错误，页面必须停止后续项目。 */
  stopBatch: boolean;
}

/** 只重试暂存架：桌面端已有 remote id 时不再重传文件。 */
export async function retryShelfImport(
  asset: repo.CaptureAsset,
  remoteId: string,
  shelfGroupId: string | null,
): Promise<ShelfImportRetryResult> {
  // 未配对/旧连接不是「桌面端暂时离线」：直接 failed 并停止整批。
  const availability = await captureAvailability();
  if (!availability.paired) {
    const message = availability.reason ?? "尚未与电脑配对";
    await repo.setDestination(asset.id, "shelf", {
      state: "failed",
      remoteId,
      lastError: message,
    });
    return {
      state: "failed",
      remoteId,
      failure: {
        kind: "auth",
        pending: false,
        retryable: false,
        stopsBatch: true,
        message,
      },
      message,
      stopBatch: true,
    };
  }
  let client: FileClient | null = null;
  try {
    ({ client } = await openFileClient());
    const imported = await client.importToShelf(remoteId, shelfGroupId);
    await repo.setDestination(asset.id, "shelf", {
      state: "done",
      remoteId,
      remoteShelfId: imported.shelf_item_id ?? null,
    });
    return {
      state: "done",
      remoteId,
      remoteShelfId: imported.shelf_item_id ?? null,
      message: "已加入暂存架",
      stopBatch: false,
    };
  } catch (error) {
    const { failure, message, state } = shelfFailureOf(error);
    await repo.setDestination(asset.id, "shelf", {
      state,
      remoteId,
      lastError: message,
    });
    return {
      state,
      remoteId,
      failure,
      message,
      stopBatch: failure.stopsBatch,
    };
  } finally {
    client?.cancel();
  }
}

/** 旋转/裁剪：结果替换 staging 源文件，随后上传/保存都使用新文件。 */
export async function transformStagedAsset(
  asset: repo.CaptureAsset,
  options: {
    rotate?: number;
    crop?: { x: number; y: number; width: number; height: number } | null;
  },
): Promise<repo.CaptureAsset> {
  if (asset.state !== "staged") {
    throw new AppError("validation", "已保存的素材不支持在此继续裁剪；请从暂存列表重新编辑");
  }
  if (!asset.localPath || !fileExists(asset.localPath)) {
    throw new AppError("validation", "采集文件已不存在");
  }
  const result = await transformImage(asset.localPath, {
    rotate: options.rotate ?? 0,
    crop: options.crop ?? null,
    quality: 95,
  });
  const staged = await stageFromTemp(result.uri, extensionOf(result.uri, "jpg"));
  const previous = asset.localPath;
  const nextName =
    (options.rotate || options.crop) && !/\.(jpe?g)$/i.test(asset.name)
      ? asset.name.replace(/\.[^.]+$/, "") + ".jpg"
      : asset.name;
  const thumb = await createThumbnail(staged.uri, 512);
  await repo.updateAssetMedia(asset.id, {
    localPath: staged.uri,
    byteSize: staged.size,
    width: result.width,
    height: result.height,
    thumbnailPath: thumb?.uri ?? null,
    sha256: null,
  });
  if (nextName !== asset.name) {
    await repo.renameAsset(asset.id, nextName);
  }
  deleteFileQuietly(previous);
  deleteFileQuietly(asset.thumbnailPath);
  const updated = await repo.getAsset(asset.id);
  if (!updated) throw new AppError("storage", "更新素材记录失败");
  return updated;
}

/**
 * 采集会话收尾：
 * - 已保存到本机的素材保留（state=saved）；
 * - 没保存到本机、但所有已选目的地都成功的 staged 素材，删除 staging 文件与记录；
 * - 任一目的地失败/取消时保留 staging，方便重试，绝不静默丢弃。
 */
export async function cleanupStagedAfterRun(assetIds: string[]): Promise<number> {
  let removed = 0;
  for (const id of assetIds) {
    const asset = await repo.getAsset(id);
    if (!asset || asset.state === "saved") continue;
    const destinations = await repo.listDestinations(id);
    // pending 也必须保留：上传成功但暂存架待重试时，记录/文件一旦删除，
    // 用户就没有入口再触发 shelf 导入（remoteId 也会随记录丢失）。
    const hasFailure = destinations.some(
      (item) =>
        item.state === "pending" ||
        item.state === "failed" ||
        item.state === "cancelled" ||
        item.state === "running",
    );
    const hasSuccess = destinations.some((item) => item.state === "done");
    if (!hasFailure && hasSuccess) {
      const paths = await repo.deleteAsset(id);
      for (const path of paths) deleteFileQuietly(path);
      removed += 1;
    }
  }
  return removed;
}
