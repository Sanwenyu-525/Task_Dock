// 票据上传/入库状态回归：上传成功但导入失败后保留远端文件，重启仍能继续导入；
// 关联删除不得删除原始素材。
import { beforeEach, describe, expect, it } from "vitest";

import { receiptAction, receiptCountText } from "../../lib/life/receiptState";
import {
  createReceiptEvent,
  deleteDocumentLink,
  getDocumentLink,
  markDocumentFileUploaded,
  markDocumentUploaded,
  setDocumentLinkTransferState,
} from "../life";
import { closeDatabase, getDatabase, openDatabase } from "../database";

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
  await getDatabase().runAsync(
    `INSERT INTO capture_assets
       (id, kind, source, name, local_path, mime, byte_size, state, created_at, updated_at)
     VALUES ('asset-r', 'photo', 'camera', '小票.jpg', '/tmp/receipt.jpg',
             'image/jpeg', 1024, 'saved', 1, 1)`,
  );
});

describe("票据传输状态", () => {
  it("上传成功→导入失败→重启→继续导入→导入成功，原图引用始终保留", async () => {
    const { linkId } = await createReceiptEvent({
      name: "超市小票",
      assetId: "asset-r",
      mime: "image/jpeg",
      byteSize: 1024,
    });
    const initial = await getDocumentLink(linkId);
    expect(initial?.transferState).toBe("local");
    expect(initial?.localUri).toBe("/tmp/receipt.jpg");
    expect(receiptAction(initial!)).toBe("send");
    expect(receiptCountText(initial!)).toBe("本机原图，未传电脑");

    // 文件上传成功、暂存架导入失败：只记录远端文件 ID，状态诚实降级为 metadata_only。
    await markDocumentFileUploaded(linkId, {
      remoteFileId: "file-r",
      name: "超市小票",
      mime: "image/jpeg",
      byteSize: 1024,
    });
    const uploaded = await getDocumentLink(linkId);
    expect(uploaded?.transferState).toBe("metadata_only");
    expect(uploaded?.remoteSource).toBe("file");
    expect(uploaded?.remoteRef).toBe("file-r");
    expect(uploaded?.localUri).toBe("/tmp/receipt.jpg");
    expect(receiptAction(uploaded!)).toBe("resume");
    expect(receiptCountText(uploaded!)).toBe("文件已传到电脑，尚未导入");

    // 注意：测试替身为 :memory: SQLite，close/open 会丢失数据；
    // 「重启后仍保留 remoteRef」需在真机/集成环境验证，不能在此伪造。

    // 继续导入成功：只有 shelf_item + transferred 才显示完成。
    await markDocumentUploaded(linkId, {
      shelfItemId: "shelf-r",
      name: "超市小票",
      mime: "image/jpeg",
      byteSize: 1024,
    });
    const imported = await getDocumentLink(linkId);
    expect(imported?.transferState).toBe("transferred");
    expect(imported?.remoteSource).toBe("shelf_item");
    expect(imported?.remoteRef).toBe("shelf-r");
    expect(imported?.documentRef).toBe("asset-r");
    expect(receiptAction(imported!)).toBe("transferred");
    expect(receiptCountText(imported!)).toBe("原图已导入电脑");

    // 原始文件被用户删除后：明确显示缺失，且不再提供发送/继续导入。
    await setDocumentLinkTransferState(linkId, "missing");
    const missing = await getDocumentLink(linkId);
    expect(receiptAction(missing!)).toBeNull();
    expect(receiptCountText(missing!)).toBe("原文件缺失");
  });

  it("解除票据关联不删除原始素材文件记录", async () => {
    const { linkId, eventId } = await createReceiptEvent({
      name: "餐饮小票",
      assetId: "asset-r",
      mime: "image/jpeg",
      byteSize: 1024,
    });
    await deleteDocumentLink(linkId);
    expect(await getDocumentLink(linkId)).toBeNull();
    const asset = await getDatabase().getFirstAsync<{ local_path: string }>(
      "SELECT local_path FROM capture_assets WHERE id = 'asset-r'",
    );
    expect(asset?.local_path).toBe("/tmp/receipt.jpg");
    // 生活事件仍保留，用于之后重新关联。
    const event = await getDatabase().getFirstAsync<{ id: string }>(
      "SELECT id FROM life_events WHERE id = ?",
      [eventId],
    );
    expect(event?.id).toBe(eventId);
  });
});
