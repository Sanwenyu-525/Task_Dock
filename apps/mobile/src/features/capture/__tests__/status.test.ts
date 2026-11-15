// 采集状态收敛测试：只验证纯函数映射，不触碰 SQLite 与原生模块。
import { describe, expect, it } from "vitest";

import type { CaptureAsset, CaptureDestination } from "../../../db/captureAssets";
import { captureStatusOf } from "../status";

const asset = {
  id: "a1",
  kind: "photo",
  source: "camera",
  name: "照片.jpg",
  localPath: "file:///library/a.jpg",
  mime: "image/jpeg",
  byteSize: 1024,
  state: "saved",
} as CaptureAsset;

function dest(
  destination: CaptureDestination["destination"],
  state: CaptureDestination["state"],
): CaptureDestination {
  return {
    assetId: "a1",
    destination,
    state,
    remoteId: null,
    remoteShelfId: null,
    albumUri: null,
    bytesDone: 0,
    bytesTotal: 0,
    updatedAt: 0,
    lastError: null,
  };
}

describe("captureStatusOf", () => {
  it("未保存的 staging 素材优先显示未保存", () => {
    const status = captureStatusOf({ ...asset, state: "staged" }, [dest("local", "done")]);
    expect(status.key).toBe("staged");
  });

  it("只有本机目的地时为仅本机", () => {
    expect(captureStatusOf(asset, [dest("local", "done")]).key).toBe("local_only");
  });

  it("相册成功显示已存相册", () => {
    expect(captureStatusOf(asset, [dest("local", "done"), dest("album", "done")]).key).toBe(
      "album_saved",
    );
  });

  it("上传到收件箱成功显示已发电脑", () => {
    expect(
      captureStatusOf(asset, [dest("local", "done"), dest("desktop", "done")]).key,
    ).toBe("sent_inbox");
  });

  it("上传成功但暂存架失败必须单独显示，不退回有失败", () => {
    const status = captureStatusOf(asset, [
      dest("local", "done"),
      dest("desktop", "done"),
      dest("shelf", "failed"),
    ]);
    expect(status.key).toBe("uploaded_shelf_failed");
    expect(status.label).toContain("暂存架失败");
  });

  it("暂存架成功优先于收件箱成功", () => {
    expect(
      captureStatusOf(asset, [
        dest("local", "done"),
        dest("desktop", "done"),
        dest("shelf", "done"),
      ]).key,
    ).toBe("in_shelf");
  });

  it("离线等待显示等待电脑，而不是失败", () => {
    expect(
      captureStatusOf(asset, [dest("local", "done"), dest("desktop", "pending")]).key,
    ).toBe("waiting_desktop");
  });

  it("running 优先于其他已完成目的地", () => {
    expect(
      captureStatusOf(asset, [dest("local", "done"), dest("desktop", "running")]).key,
    ).toBe("working");
  });

  it("失败与取消在没有成功目的地时分别显示", () => {
    expect(captureStatusOf(asset, [dest("local", "done"), dest("album", "failed")]).key).toBe(
      "failed",
    );
    expect(captureStatusOf(asset, [dest("local", "done"), dest("desktop", "cancelled")]).key).toBe(
      "cancelled",
    );
  });
});
