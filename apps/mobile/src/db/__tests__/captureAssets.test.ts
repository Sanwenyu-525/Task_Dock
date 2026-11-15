// 采集资产仓储测试：真实 SQLite（node:sqlite harness），不改写业务 SQL。
import { beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, openDatabase } from "../database";
import {
  createStagedAsset,
  deleteAsset,
  deleteStagedAssetsOlderThan,
  getAsset,
  listAllDestinations,
  listAssets,
  listDestinations,
  listReferencedPaths,
  listStagedAssets,
  markAssetSaved,
  recoverInterruptedDestinations,
  renameAsset,
  setAssetFavorite,
  setDestination,
} from "../captureAssets";

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
});

async function staged(name = "照片.jpg") {
  const asset = await createStagedAsset({
    kind: "photo",
    source: "camera",
    name,
    localPath: `file:///staging/${name}`,
    mime: "image/jpeg",
    byteSize: 1024,
    width: 4000,
    height: 3000,
  });
  return asset;
}

describe("capture_assets 生命周期", () => {
  it("staged 不进本机暂存列表；保存后 state=saved 且 local 目的地 done", async () => {
    const asset = await staged();
    expect(await listStagedAssets()).toHaveLength(1);
    expect(await listAssets()).toHaveLength(0);

    await markAssetSaved(asset.id, {
      localPath: "file:///library/a.jpg",
      byteSize: 2048,
      sha256: "ab".repeat(32),
      thumbnailPath: "file:///thumbs/a.jpg",
    });

    const saved = await getAsset(asset.id);
    expect(saved?.state).toBe("saved");
    expect(saved?.localPath).toBe("file:///library/a.jpg");
    expect(saved?.byteSize).toBe(2048);
    const destinations = await listDestinations(asset.id);
    expect(destinations).toEqual([
      expect.objectContaining({
        destination: "local",
        state: "done",
        bytesDone: 2048,
      }),
    ]);
    expect(await listAssets()).toHaveLength(1);
    expect(await listStagedAssets()).toHaveLength(0);
  });

  it("目的地状态独立更新：后一次失败不清掉已完成的远端 ID", async () => {
    const asset = await staged();
    await setDestination(asset.id, "desktop", {
      state: "done",
      remoteId: "remote-1",
      bytesDone: 1024,
      bytesTotal: 1024,
    });
    await setDestination(asset.id, "shelf", {
      state: "failed",
      remoteId: "remote-1",
      lastError: "文件已发送到电脑，但加入暂存架失败：配额不足",
    });
    await setDestination(asset.id, "album", {
      state: "done",
      albumUri: "content://media/external/images/media/42",
    });

    const rows = await listDestinations(asset.id);
    const desktop = rows.find((row) => row.destination === "desktop");
    const shelf = rows.find((row) => row.destination === "shelf");
    expect(desktop?.state).toBe("done");
    expect(desktop?.remoteId).toBe("remote-1");
    expect(shelf?.state).toBe("failed");
    expect(shelf?.lastError).toContain("文件已发送到电脑，但加入暂存架失败");
    expect(rows.find((row) => row.destination === "album")?.albumUri).toContain("media/42");

    // 只重试 shelf 成功后，desktop 记录仍是 done，不会被覆盖成别的状态。
    await setDestination(asset.id, "shelf", {
      state: "done",
      remoteId: "remote-1",
      remoteShelfId: "mf-remote-1",
    });
    const after = await listDestinations(asset.id);
    expect(after.find((row) => row.destination === "shelf")?.remoteShelfId).toBe("mf-remote-1");
    expect(after.find((row) => row.destination === "desktop")?.state).toBe("done");
  });

  it("中断的 running 目的地恢复为 failed 且可重试", async () => {
    const asset = await staged();
    await setDestination(asset.id, "desktop", { state: "running", bytesTotal: 1024 });
    const recovered = await recoverInterruptedDestinations();
    expect(recovered).toBe(1);
    const rows = await listDestinations(asset.id);
    expect(rows[0].state).toBe("failed");
    expect(rows[0].lastError).toContain("中断");
  });

  it("过期 staged 会话删除并返回待清理文件；saved 不受影响", async () => {
    const oldStaged = await staged("旧照片.jpg");
    const saved = await staged("已保存.jpg");
    await markAssetSaved(saved.id, {
      localPath: "file:///library/b.jpg",
      byteSize: 1,
      sha256: "cd".repeat(32),
      thumbnailPath: null,
    });

    const paths = await deleteStagedAssetsOlderThan(Date.now() + 1);
    expect(paths).toContain(oldStaged.localPath);
    expect(await getAsset(oldStaged.id)).toBeNull();
    expect(await getAsset(saved.id)).not.toBeNull();
  });

  it("删除资产级联删除目的地，并返回本机文件路径", async () => {
    const asset = await staged();
    await setDestination(asset.id, "desktop", { state: "done", remoteId: "r1" });
    const paths = await deleteAsset(asset.id);
    expect(paths).toEqual([asset.localPath]);
    expect(await getAsset(asset.id)).toBeNull();
    expect(await listAllDestinations()).toHaveLength(0);
  });

  it("重命名/收藏/引用路径只影响本机记录", async () => {
    const asset = await staged("原名.jpg");
    await renameAsset(asset.id, "新名字.jpg");
    await setAssetFavorite(asset.id, true);
    const updated = await getAsset(asset.id);
    expect(updated?.name).toBe("新名字.jpg");
    expect(updated?.favorite).toBe(true);

    await markAssetSaved(asset.id, {
      localPath: "file:///library/c.jpg",
      byteSize: 1,
      sha256: "ef".repeat(32),
      thumbnailPath: "file:///thumbs/c.jpg",
    });
    const referenced = await listReferencedPaths();
    expect(referenced).toEqual(
      expect.arrayContaining(["file:///library/c.jpg", "file:///thumbs/c.jpg"]),
    );
  });
});
