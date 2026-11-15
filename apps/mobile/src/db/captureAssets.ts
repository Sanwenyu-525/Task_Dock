// 移动采集资产仓储：capture_assets（素材元数据）+ capture_destinations（多目的地状态）。
//
// 分层约束：SQL 只出现在本文件；screens/features 通过这里的函数读写。
// 一致性约定：
// - 文件先落盘、再建行（调用方顺序），行建立失败要删除刚复制的文件；
// - 每个目的地独立一行，一个目的地失败不回滚其他目的地；
// - 应用异常退出时，running 状态由 recoverInterruptedDestinations() 标成 failed 可重试。
import { newId } from "../lib/id";

import { getDatabase } from "./database";

export type CaptureKind = "photo" | "scan" | "audio" | "file";
export type CaptureSource = "camera" | "gallery" | "share" | "file_picker" | "scan" | "audio";
/** staged = 已采集但未确认保存；saved = 已进入本机采集暂存。 */
export type CaptureAssetState = "staged" | "saved";
export type CaptureDestinationKind = "local" | "album" | "desktop" | "shelf";
export type CaptureDestinationState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface CaptureAsset {
  id: string;
  kind: CaptureKind;
  source: CaptureSource;
  name: string;
  localPath: string | null;
  mime: string;
  byteSize: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbnailPath: string | null;
  note: string;
  favorite: boolean;
  projectId: string | null;
  state: CaptureAssetState;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface CaptureDestination {
  assetId: string;
  destination: CaptureDestinationKind;
  state: CaptureDestinationState;
  remoteId: string | null;
  remoteShelfId: string | null;
  albumUri: string | null;
  bytesDone: number;
  bytesTotal: number;
  updatedAt: number;
  lastError: string | null;
}

interface AssetRow {
  id: string;
  kind: CaptureKind;
  source: CaptureSource;
  name: string;
  local_path: string | null;
  mime: string;
  byte_size: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumbnail_path: string | null;
  note: string;
  favorite: number;
  project_id: string | null;
  state: CaptureAssetState;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

interface DestinationRow {
  asset_id: string;
  destination: CaptureDestinationKind;
  state: CaptureDestinationState;
  remote_id: string | null;
  remote_shelf_id: string | null;
  album_uri: string | null;
  bytes_done: number;
  bytes_total: number;
  updated_at: number;
  last_error: string | null;
}

const ASSET_COLUMNS = `id, kind, source, name, local_path, mime, byte_size, sha256, width, height,
  duration_ms, thumbnail_path, note, favorite, project_id, state, created_at, updated_at, last_error`;
const DESTINATION_COLUMNS = `asset_id, destination, state, remote_id, remote_shelf_id, album_uri,
  bytes_done, bytes_total, updated_at, last_error`;

function mapAsset(row: AssetRow): CaptureAsset {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    name: row.name,
    localPath: row.local_path,
    mime: row.mime,
    byteSize: row.byte_size,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    thumbnailPath: row.thumbnail_path,
    note: row.note,
    favorite: row.favorite !== 0,
    projectId: row.project_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

function mapDestination(row: DestinationRow): CaptureDestination {
  return {
    assetId: row.asset_id,
    destination: row.destination,
    state: row.state,
    remoteId: row.remote_id,
    remoteShelfId: row.remote_shelf_id,
    albumUri: row.album_uri,
    bytesDone: row.bytes_done,
    bytesTotal: row.bytes_total,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

export async function listAssets(state?: CaptureAssetState): Promise<CaptureAsset[]> {
  const db = getDatabase();
  const rows = state
    ? await db.getAllAsync<AssetRow>(
        `SELECT ${ASSET_COLUMNS} FROM capture_assets WHERE state = ? ORDER BY created_at DESC`,
        [state],
      )
    : await db.getAllAsync<AssetRow>(
        `SELECT ${ASSET_COLUMNS} FROM capture_assets WHERE state = 'saved' ORDER BY created_at DESC`,
      );
  return rows.map(mapAsset);
}

export async function getAsset(id: string): Promise<CaptureAsset | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM capture_assets WHERE id = ?`,
    [id],
  );
  return row ? mapAsset(row) : null;
}

/** 相机/扫描会话中尚未确认保存的素材（按采集顺序，最早在前）。 */
export async function listStagedAssets(): Promise<CaptureAsset[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM capture_assets WHERE state = 'staged' ORDER BY created_at ASC`,
  );
  return rows.map(mapAsset);
}

export interface CreateStagedInput {
  kind: CaptureKind;
  source: CaptureSource;
  name: string;
  localPath: string;
  mime: string;
  byteSize: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

/** 采集后先建 staged 行（文件已复制到应用目录）；确认保存前不会出现在暂存列表。 */
export async function createStagedAsset(input: CreateStagedInput): Promise<CaptureAsset> {
  const db = getDatabase();
  const now = Date.now();
  const asset: CaptureAsset = {
    id: newId("asset"),
    kind: input.kind,
    source: input.source,
    name: input.name,
    localPath: input.localPath,
    mime: input.mime,
    byteSize: input.byteSize,
    sha256: null,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    thumbnailPath: null,
    note: "",
    favorite: false,
    projectId: null,
    state: "staged",
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  await db.runAsync(
    `INSERT INTO capture_assets (${ASSET_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      asset.id,
      asset.kind,
      asset.source,
      asset.name,
      asset.localPath,
      asset.mime,
      asset.byteSize,
      asset.sha256,
      asset.width,
      asset.height,
      asset.durationMs,
      asset.thumbnailPath,
      asset.note,
      asset.favorite ? 1 : 0,
      asset.projectId,
      asset.state,
      asset.createdAt,
      asset.updatedAt,
      asset.lastError,
    ],
  );
  return asset;
}

/** 媒体处理（旋转/裁剪）后覆盖同一 staged 记录的文件元数据。 */
export async function updateAssetMedia(
  id: string,
  input: {
    localPath: string;
    byteSize: number;
    width?: number | null;
    height?: number | null;
    thumbnailPath?: string | null;
    sha256?: string | null;
  },
): Promise<void> {
  const db = getDatabase();
  await db.runAsync(
    `UPDATE capture_assets
        SET local_path = ?, byte_size = ?, width = COALESCE(?, width), height = COALESCE(?, height),
            thumbnail_path = COALESCE(?, thumbnail_path), sha256 = ?, updated_at = ?
      WHERE id = ?`,
    [
      input.localPath,
      input.byteSize,
      input.width ?? null,
      input.height ?? null,
      input.thumbnailPath ?? null,
      input.sha256 ?? null,
      Date.now(),
      id,
    ],
  );
}

/** 进入本机采集暂存：asset 变 saved + local 目的地 done，同一事务提交。 */
export async function markAssetSaved(
  id: string,
  input: { localPath: string; byteSize: number; sha256: string; thumbnailPath: string | null },
): Promise<void> {
  const db = getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE capture_assets
          SET state = 'saved', local_path = ?, byte_size = ?, sha256 = ?,
              thumbnail_path = ?, updated_at = ?, last_error = NULL
        WHERE id = ?`,
      [input.localPath, input.byteSize, input.sha256, input.thumbnailPath, now, id],
    );
    await upsertDestinationInTx(
      db,
      id,
      "local",
      { state: "done", bytesDone: input.byteSize, bytesTotal: input.byteSize },
      now,
    );
  });
}

export async function renameAsset(id: string, name: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE capture_assets SET name = ?, updated_at = ? WHERE id = ?`, [
    name,
    Date.now(),
    id,
  ]);
}

export async function updateAssetNote(id: string, note: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE capture_assets SET note = ?, updated_at = ? WHERE id = ?`, [
    note,
    Date.now(),
    id,
  ]);
}

export async function setAssetFavorite(id: string, favorite: boolean): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE capture_assets SET favorite = ?, updated_at = ? WHERE id = ?`, [
    favorite ? 1 : 0,
    Date.now(),
    id,
  ]);
}

/** 删除记录并返回本地文件路径（调用方负责删文件；相册/桌面副本不受影响）。 */
export async function deleteAsset(id: string): Promise<string[]> {
  const db = getDatabase();
  const row = await db.getFirstAsync<{ local_path: string | null; thumbnail_path: string | null }>(
    "SELECT local_path, thumbnail_path FROM capture_assets WHERE id = ?",
    [id],
  );
  if (!row) return [];
  await db.runAsync("DELETE FROM capture_assets WHERE id = ?", [id]);
  return [row.local_path, row.thumbnail_path].filter((path): path is string => Boolean(path));
}

export async function listDestinations(assetId: string): Promise<CaptureDestination[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<DestinationRow>(
    `SELECT ${DESTINATION_COLUMNS} FROM capture_destinations WHERE asset_id = ?`,
    [assetId],
  );
  return rows.map(mapDestination);
}

/** 列表页一次读取全部目的地状态（避免 N+1 查询）。 */
export async function listAllDestinations(): Promise<CaptureDestination[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<DestinationRow>(
    `SELECT ${DESTINATION_COLUMNS} FROM capture_destinations ORDER BY updated_at DESC`,
  );
  return rows.map(mapDestination);
}

export interface DestinationPatch {
  state: CaptureDestinationState;
  remoteId?: string | null;
  remoteShelfId?: string | null;
  albumUri?: string | null;
  bytesDone?: number;
  bytesTotal?: number;
  lastError?: string | null;
}

type DbLike = ReturnType<typeof getDatabase>;

async function upsertDestinationInTx(
  db: DbLike,
  assetId: string,
  destination: CaptureDestinationKind,
  patch: DestinationPatch,
  now: number,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO capture_destinations
       (${DESTINATION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, destination) DO UPDATE SET
       state = excluded.state,
       remote_id = COALESCE(excluded.remote_id, capture_destinations.remote_id),
       remote_shelf_id = COALESCE(excluded.remote_shelf_id, capture_destinations.remote_shelf_id),
       album_uri = COALESCE(excluded.album_uri, capture_destinations.album_uri),
       bytes_done = excluded.bytes_done,
       bytes_total = excluded.bytes_total,
       updated_at = excluded.updated_at,
       last_error = excluded.last_error`,
    [
      assetId,
      destination,
      patch.state,
      patch.remoteId ?? null,
      patch.remoteShelfId ?? null,
      patch.albumUri ?? null,
      patch.bytesDone ?? 0,
      patch.bytesTotal ?? 0,
      now,
      patch.lastError ?? null,
    ],
  );
}

export async function setDestination(
  assetId: string,
  destination: CaptureDestinationKind,
  patch: DestinationPatch,
): Promise<void> {
  const db = getDatabase();
  await upsertDestinationInTx(db, assetId, destination, patch, Date.now());
}

/** 应用启动时调用：中断的 running 目的地统一转 failed（可重试），不假装成功。 */
export async function recoverInterruptedDestinations(): Promise<number> {
  const db = getDatabase();
  const result = await db.runAsync(
    `UPDATE capture_destinations
        SET state = 'failed',
            last_error = COALESCE(last_error, '应用在传输过程中中断，请重试'),
            updated_at = ?
      WHERE state = 'running'`,
    [Date.now()],
  );
  return result.changes;
}

/** 删除过期 staged 素材（未确认保存的采集会话），返回需要清理的文件路径。 */
export async function deleteStagedAssetsOlderThan(cutoff: number): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<{ id: string; local_path: string | null; thumbnail_path: string | null }>(
    "SELECT id, local_path, thumbnail_path FROM capture_assets WHERE state = 'staged' AND created_at < ?",
    [cutoff],
  );
  if (rows.length === 0) return [];
  const paths: string[] = [];
  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      if (row.local_path) paths.push(row.local_path);
      if (row.thumbnail_path) paths.push(row.thumbnail_path);
      await db.runAsync("DELETE FROM capture_assets WHERE id = ?", [row.id]);
    }
  });
  return paths;
}

/** 本机所有被记录引用的文件路径：孤儿清扫的唯一白名单。 */
export async function listReferencedPaths(): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<{ path: string }>(
    `SELECT local_path AS path FROM capture_assets WHERE local_path IS NOT NULL
     UNION
     SELECT thumbnail_path AS path FROM capture_assets WHERE thumbnail_path IS NOT NULL`,
  );
  return rows.map((row) => row.path);
}
