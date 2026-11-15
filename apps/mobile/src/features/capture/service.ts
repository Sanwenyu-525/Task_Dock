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
import { uploadDisplayName, uploadLocalFile } from "../../lib/sync/fileIo";
import {
  createFileClient,
  FILE_CANCELLED_MESSAGE,
  isFileCancelled,
  type FileClient,
  type RemoteFile,
  type RemoteShelfGroup,
} from "../../lib/sync/files";

import { createPdfFromImages, createThumbnail, saveToSystemGallery, transformImage } from "./album";
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
 * 老桌面端没有该接口时返回空数组，调用方退回默认分组，不阻断上传。
 */
export async function listShelfGroups(): Promise<RemoteShelfGroup[]> {
  const { client } = await openFileClient();
  try {
    return await client.shelfGroups();
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
    deleteFileQuietly(moved.uri);
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

async function importRemoteToShelf(
  client: FileClient,
  asset: repo.CaptureAsset,
  remote: RemoteFile,
  groupId: string | null,
): Promise<void> {
  try {
    const imported = await client.importToShelf(remote.id, groupId);
    await repo.setDestination(asset.id, "shelf", {
      state: "done",
      remoteId: remote.id,
      remoteShelfId: imported.shelf_item_id ?? null,
      bytesDone: asset.byteSize,
      bytesTotal: asset.byteSize,
    });
  } catch (error) {
    const message = isFileCancelled(error)
      ? "暂存架导入已取消"
      : `文件已发送到电脑，但加入暂存架失败：${describeError(error)}`;
    await repo.setDestination(asset.id, "shelf", {
      state: isFileCancelled(error) ? "cancelled" : "failed",
      remoteId: remote.id,
      lastError: message,
    });
    throw new AppError("network", message, error);
  }
}

/**
 * 发送到电脑：先做一次可连接性检查（list），不可达时把目的地置为 pending 并返回，
 * 文件仍保留在本机（离线待发送），用户可以稍后重试。
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
): Promise<{ outcomes: SendOutcome[]; offline: boolean; message?: string }> {
  if (assets.length === 0) return { outcomes: [], offline: false };
  // 未配对/令牌失效不是「电脑暂时离线」：直接标 failed 并给出配对原因，
  // 不能提示「等待电脑连接」，否则用户会以为稍后自动重试就能成功。
  const availability = await captureAvailability();
  if (!availability.paired) {
    const message = availability.reason ?? "尚未与电脑配对";
    for (const asset of assets) {
      await repo.setDestination(asset.id, "desktop", { state: "failed", lastError: message });
      if (options.target === "shelf") {
        await repo.setDestination(asset.id, "shelf", { state: "failed", lastError: message });
      }
    }
    return {
      outcomes: assets.map((asset) => ({ assetId: asset.id, state: "failed", message })),
      offline: false,
      message,
    };
  }
  let client: FileClient;
  try {
    ({ client } = await openFileClient());
    await client.list();
  } catch (error) {
    const message = `电脑端暂时不可达：${describeError(error)}`;
    for (const asset of assets) {
      await repo.setDestination(asset.id, "desktop", {
        state: "pending",
        bytesTotal: asset.byteSize,
        lastError: "等待电脑连接，可稍后重试",
      });
      if (options.target === "shelf") {
        await repo.setDestination(asset.id, "shelf", {
          state: "pending",
          lastError: "等待电脑连接，可稍后重试",
        });
      }
    }
    return { outcomes: [], offline: true, message };
  }

  const outcomes: SendOutcome[] = [];
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
        const remote = await uploadLocalFile(
          client,
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
        );
        await repo.setDestination(asset.id, "desktop", {
          state: "done",
          remoteId: remote.id,
          bytesDone: asset.byteSize,
          bytesTotal: asset.byteSize,
        });

        if (options.target === "shelf") {
          try {
            await importRemoteToShelf(client, asset, remote, options.shelfGroupId ?? null);
            outcomes.push({ assetId: asset.id, state: "done", remoteId: remote.id });
          } catch (error) {
            // 上传已成功：桌面目的地保持 done，暂存架单独 failed（UI 必须分开显示）。
            outcomes.push({
              assetId: asset.id,
              state: "failed",
              remoteId: remote.id,
              message: describeError(error),
            });
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
        const message = describeError(error);
        await repo.setDestination(asset.id, "desktop", { state: "failed", lastError: message });
        outcomes.push({ assetId: asset.id, state: "failed", message });
      }
    }
  } finally {
    client.cancel();
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
    const displayName = uploadDisplayName(file);
    options.onProgress?.(index, files.length, displayName);
    if (!file.exists) {
      failures.push(`${displayName}：文件不可读取`);
      continue;
    }
    if (file.size <= 0) {
      failures.push(`${displayName}：文件为空`);
      continue;
    }
    const mime = file.type || "application/octet-stream";
    const ext = extensionOf(file.name || file.uri, extensionFromMime(mime));
    let copied: { uri: string; size: number } | null = null;
    try {
      copied = await importToLibrary(file.uri, ext);
      const sha256 = await sha256OfFile(copied.uri);
      const thumb = mime.startsWith("image/") ? await createThumbnail(copied.uri, 512) : null;
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
      await repo.markAssetSaved(staged.id, {
        localPath: copied.uri,
        byteSize: copied.size,
        sha256,
        thumbnailPath: thumb?.uri ?? null,
      });
      const saved = await repo.getAsset(staged.id);
      if (saved) created.push(saved);
    } catch (error) {
      if (copied) deleteFileQuietly(copied.uri);
      failures.push(`${displayName}：${describeError(error)}`);
    }
  }
  return { created, failures };
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

/** 只重试暂存架：桌面端已有 remote id 时不再重传文件。 */export async function retryShelfImport(
  asset: repo.CaptureAsset,
  remoteId: string,
  shelfGroupId: string | null,
): Promise<void> {
  const { client } = await openFileClient();
  try {
    const imported = await client.importToShelf(remoteId, shelfGroupId);
    await repo.setDestination(asset.id, "shelf", {
      state: "done",
      remoteId,
      remoteShelfId: imported.shelf_item_id ?? null,
    });
  } catch (error) {
    const message = `文件已发送到电脑，但加入暂存架失败：${describeError(error)}`;
    await repo.setDestination(asset.id, "shelf", { state: "failed", lastError: message });
    throw new AppError("network", message, error);
  } finally {
    client.cancel();
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
    const hasFailure = destinations.some(
      (item) => item.state === "failed" || item.state === "cancelled" || item.state === "running",
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
