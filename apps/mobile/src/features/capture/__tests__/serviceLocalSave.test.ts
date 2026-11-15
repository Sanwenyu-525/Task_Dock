// P0-02 采集资产生命周期：本地保存必须做到「文件真实存在 + 数据库行 + SHA-256 一致」，
// 且保存失败时不能把素材搞丢（记录还在但没有字节就是数据丢失）。
//
// 用真实 SQLite + 内存文件系统；只替换相册/缩略图原生边界。
import { beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({
  thumbnailError: null as null | Error,
  galleryError: null as null | Error,
}));

vi.mock("../album", () => ({
  createPdfFromImages: vi.fn(),
  createThumbnail: async () => {
    if (media.thumbnailError) throw media.thumbnailError;
    return null;
  },
  resolveDisplayName: async () => null,
  saveToSystemGallery: async () => {
    if (media.galleryError) throw media.galleryError;
    return { uri: "content://media/external/images/1", displayName: "照片.jpg", size: 32 };
  },
  transformImage: vi.fn(),
}));

import * as repo from "../../../db/captureAssets";
import { closeDatabase, openDatabase } from "../../../db/database";
import { __activeFiles, __resetFs, __seedFile } from "../../../test/mocks/expo-file-system";
import { File as FsFile } from "expo-file-system";

import { importLocalFiles, saveToAlbum, saveToLocal } from "../service";

import { createHash } from "node:crypto";

const STAGING_DIR = "file:///data/user/0/dev.taskdock.mobile/files/taskdock-captures/staging";

async function stagedAsset(bytes = new Uint8Array(32).fill(9)) {
  const file = __seedFile(STAGING_DIR, "照片.jpg", bytes);
  return repo.createStagedAsset({
    kind: "photo",
    source: "camera",
    name: "照片.jpg",
    localPath: file.uri,
    mime: "image/jpeg",
    byteSize: bytes.length,
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
  await openDatabase();
  __resetFs();
  media.thumbnailError = null;
  media.galleryError = null;
});

describe("保存到本机（文件 + 行 + 摘要）", () => {
  it("移动成功：staging 不再存在、library 有文件、SHA-256 与内容一致、目的地 local=done", async () => {
    const bytes = new Uint8Array(32).fill(9);
    const asset = await stagedAsset(bytes);
    const saved = await saveToLocal(asset);

    expect(saved.state).toBe("saved");
    expect(saved.localPath ?? "").toContain("/library/");
    expect(saved.sha256).toBe(
      createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
    );
    expect(__activeFiles()).not.toContain(asset.localPath);
    expect(__activeFiles()).toContain(saved.localPath);

    const destinations = await repo.listDestinations(asset.id);
    expect(destinations.find((item) => item.destination === "local")?.state).toBe("done");
  });

  it("重新读取（同一进程内）仍是 saved，且路径可访问（进程重启需真机验证）", async () => {
    const asset = await stagedAsset();
    const saved = await saveToLocal(asset);

    const reloaded = await repo.getAsset(asset.id);
    expect(reloaded?.state).toBe("saved");
    expect(reloaded?.localPath).toBe(saved.localPath);
    expect(__activeFiles()).toContain(saved.localPath);
  });

  it("保存失败（缩略图异常）时回滚：staging 文件仍在，记录仍为 staged，可以重试", async () => {
    const asset = await stagedAsset();
    media.thumbnailError = new Error("thumbnail boom");

    await expect(saveToLocal(asset)).rejects.toThrow();

    const after = await repo.getAsset(asset.id);
    expect(after?.state).toBe("staged");
    expect(after?.localPath).toBe(asset.localPath);
    expect(__activeFiles()).toContain(asset.localPath);
    expect(__activeFiles().some((uri) => uri.includes("/library/"))).toBe(false);
  });
});

describe("系统文件导入失败后的数据库/文件清理（P1）", () => {
  const PICK_DIR = "file:///data/user/0/dev.taskdock.mobile/cache/picked";

  function pickedFile(name = "导入.jpg") {
    const file = __seedFile(PICK_DIR, name, new Uint8Array(32).fill(5), "image/jpeg");
    return new FsFile(file.uri);
  }

  it("markAssetSaved 失败：删除资产行、library 副本与缩略图，不留下指向已删文件的记录", async () => {
    const spy = vi
      .spyOn(repo, "markAssetSaved")
      .mockRejectedValueOnce(new Error("db write failed"));

    const result = await importLocalFiles([pickedFile()], { source: "gallery" });

    expect(result.created).toHaveLength(0);
    expect(result.failures[0]).toContain("db write failed");
    expect(await repo.listAssets()).toHaveLength(0);
    expect(__activeFiles().some((uri) => uri.includes("/library/"))).toBe(false);
    spy.mockRestore();
  });

  it("createStagedAsset 失败：删除已复制的 library 文件，不创建数据库行", async () => {
    const spy = vi
      .spyOn(repo, "createStagedAsset")
      .mockRejectedValueOnce(new Error("insert failed"));

    const result = await importLocalFiles([pickedFile()], { source: "gallery" });

    expect(result.created).toHaveLength(0);
    expect(result.failures[0]).toContain("insert failed");
    expect(await repo.listAssets()).toHaveLength(0);
    expect(__activeFiles().some((uri) => uri.includes("/library/"))).toBe(false);
    spy.mockRestore();
  });

  it("缩略图生成失败：清理已复制文件，不创建数据库行", async () => {
    media.thumbnailError = new Error("thumbnail boom");
    const result = await importLocalFiles([pickedFile()], { source: "gallery" });

    expect(result.created).toHaveLength(0);
    expect(result.failures[0]).toContain("thumbnail boom");
    expect(await repo.listAssets()).toHaveLength(0);
    expect(__activeFiles().some((uri) => uri.includes("/library/"))).toBe(false);
  });

  it("多文件导入：一条失败不影响其余文件，只保留成功记录", async () => {
    const spy = vi
      .spyOn(repo, "markAssetSaved")
      .mockRejectedValueOnce(new Error("first failed"));

    const result = await importLocalFiles([pickedFile("第一张.jpg"), pickedFile("第二张.jpg")], {
      source: "gallery",
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.name).toBe("第二张.jpg");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("first failed");
    expect(await repo.listAssets()).toHaveLength(1);
    spy.mockRestore();
  });
});

describe("保存到系统相册（独立性）", () => {
  it("相册写入失败只影响 album 目的地，不改动本机记录", async () => {
    const asset = await stagedAsset();
    media.galleryError = new Error("MediaStore 拒绝写入");

    await expect(saveToAlbum(asset)).rejects.toThrow();

    const album = (await repo.listDestinations(asset.id)).find(
      (item) => item.destination === "album",
    );
    expect(album?.state).toBe("failed");
    expect(album?.lastError ?? "").toContain("MediaStore");
    const after = await repo.getAsset(asset.id);
    expect(after?.state).toBe("staged");
    expect(__activeFiles()).toContain(asset.localPath);
  });
});
