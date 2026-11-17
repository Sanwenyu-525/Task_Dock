// 生活领域落库测试：真实 SQLite 上验证购买历史、实际日期排序、金额定点、名称归一化、
// 票据关联生命周期与空记录查询。对应 AC-01/02/03/04/05/07/10 的数据层部分。
import { beforeEach, describe, expect, it } from "vitest";

import {
  createDocumentLink,
  createPurchase,
  createReceiptEvent,
  deleteDocumentLink,
  deletePurchase,
  getEventDetail,
  getItemHistory,
  listDocumentLinks,
  listItems,
  markDocumentFileUploaded,
  markDocumentUploaded,
  searchLife,
} from "../life";
import { closeDatabase, getDatabase, openDatabase } from "../database";

function day(year: number, month: number, date: number): number {
  return new Date(year, month - 1, date, 0, 0, 0, 0).getTime();
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
});

describe("生活购买记录", () => {
  it("AC-01/02/03：按实际购买日期排序，补录旧记录不会成为最近一次", async () => {
    const first = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
      quantityValue: "5",
      quantityUnit: "kg",
      totalPrice: "48",
      currency: "CNY",
      merchant: "某超市",
      note: "普通袋装大米",
    });
    await createPurchase({
      name: "大米",
      occurredAt: day(2026, 10, 4),
      quantityValue: "5",
      quantityUnit: "kg",
      totalPrice: "46",
      currency: "CNY",
    });
    // 11 月 16 日补录 9 月 6 日的购买：created_at 最新，但 occurred_at 最旧。
    await createPurchase({
      name: "大米",
      occurredAt: day(2026, 9, 6),
      totalPrice: "45",
      currency: "CNY",
    });

    const history = await getItemHistory(first.itemId);
    expect(history).not.toBeNull();
    expect(history?.totalCount).toBe(3);
    expect(history?.purchases.map((row) => row.occurredAt)).toEqual([
      day(2026, 11, 3),
      day(2026, 10, 4),
      day(2026, 9, 6),
    ]);
    expect(history?.purchases[0]?.quantityValue).toBe("5");
    expect(history?.purchases[0]?.quantityUnit).toBe("kg");
    expect(history?.purchases[0]?.totalPriceMinor).toBe(4800);
    expect(history?.purchases[0]?.currency).toBe("CNY");
    // 最近两次间隔 = 30 天（10/4 → 11/3）
    expect(history?.intervalDays).toBe(30);

    // 关闭再打开：数据仍在，证明不是内存态。
    await closeDatabase();
    await openDatabase();
    const reopened = await getItemHistory(first.itemId);
    expect(reopened?.totalCount).toBe(3);
    expect(reopened?.purchases[0]?.occurredAt).toBe(day(2026, 11, 3));
  });

  it("金额用最小货币单位整数累计，数量保留小数并规范去尾零", async () => {
    const one = await createPurchase({
      name: "鸡蛋",
      occurredAt: day(2026, 11, 1),
      quantityValue: "0.250",
      quantityUnit: "kg",
      totalPrice: "0.10",
      currency: "CNY",
    });
    await createPurchase({
      name: "鸡蛋",
      occurredAt: day(2026, 11, 2),
      totalPrice: "0.20",
      currency: "CNY",
    });
    const detail = await getEventDetail(one.eventId);
    expect(detail?.items[0]?.quantityValue).toBe("0.25");
    expect(detail?.items[0]?.totalPriceMinor).toBe(10);
    const second = await createPurchase({
      name: "鸡蛋",
      occurredAt: day(2026, 11, 3),
      totalPrice: "0.20",
      currency: "CNY",
    });
    const secondDetail = await getEventDetail(second.eventId);
    expect(secondDetail?.items[0]?.totalPriceMinor).toBe(20);
  });

  it("同名商品复用同一条 life_item，名称相似但不同商品不强行合并", async () => {
    const a = await createPurchase({ name: "Milk", occurredAt: day(2026, 10, 1) });
    const b = await createPurchase({ name: "milk", occurredAt: day(2026, 11, 1) });
    expect(a.itemId).toBe(b.itemId);

    const rice = await createPurchase({ name: "大米", occurredAt: day(2026, 10, 1) });
    const northeastRice = await createPurchase({
      name: "东北大米",
      occurredAt: day(2026, 11, 1),
    });
    expect(rice.itemId).not.toBe(northeastRice.itemId);

    const items = await listItems("大米");
    expect(items.some((item) => item.name === "大米")).toBe(true);
    expect(items.some((item) => item.name === "东北大米")).toBe(true);
  });

  it("AC-04/05：快捷查询由真实记录产生，空记录不返回演示数据", async () => {
    await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
      totalPrice: "48",
      currency: "CNY",
    });

    const hits = await searchLife("上次什么时候买的大米？");
    expect(hits.some((hit) => hit.kind === "item" && hit.title.includes("大米"))).toBe(true);

    expect(await searchLife("不存在的商品")).toEqual([]);
    expect(await searchLife("   ")).toEqual([]);
  });
});

describe("生活票据关联", () => {
  it("AC-07：票据只引用稳定素材 ID，删除关联不删除原文件", async () => {
    const purchase = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
      totalPrice: "48",
      currency: "CNY",
    });
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO capture_assets (id, kind, source, name, local_path, mime, state, created_at, updated_at)
       VALUES ('asset-receipt', 'photo', 'camera', 'receipt.jpg', '/tmp/receipt.jpg', 'image/jpeg', 'saved', 1, 1)`,
    );

    const linkId = await createDocumentLink({
      ownerType: "event",
      ownerId: purchase.eventId,
      documentRef: "asset-receipt",
      documentSource: "capture_asset",
      documentName: "超市小票",
      mime: "image/jpeg",
      byteSize: 1024,
      transferState: "local",
    });
    const links = await listDocumentLinks("event", purchase.eventId);
    expect(links.map((link) => link.id)).toContain(linkId);
    expect(links[0]?.localUri).toBe("/tmp/receipt.jpg");

    await deleteDocumentLink(linkId);
    expect(await listDocumentLinks("event", purchase.eventId)).toEqual([]);
    // 原素材仍在：解除关联不是删除素材。
    const asset = await db.getFirstAsync<{ id: string; local_path: string }>(
      "SELECT id, local_path FROM capture_assets WHERE id = 'asset-receipt'",
    );
    expect(asset).toEqual({ id: "asset-receipt", local_path: "/tmp/receipt.jpg" });
  });

  it("重复关联幂等；生活记录删除后不能产生悬空关联", async () => {
    const purchase = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
    });
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO capture_assets (id, kind, source, name, local_path, mime, state, created_at, updated_at)
       VALUES ('asset-dup', 'scan', 'scanner', 'ticket.pdf', '/tmp/ticket.pdf', 'application/pdf', 'saved', 1, 1)`,
    );
    const input = {
      ownerType: "event" as const,
      ownerId: purchase.eventId,
      documentRef: "asset-dup",
      documentSource: "capture_asset" as const,
      documentName: "票据",
      mime: "application/pdf",
    };
    const first = await createDocumentLink(input);
    const second = await createDocumentLink(input);
    expect(second).toBe(first);
    expect(await listDocumentLinks("event", purchase.eventId)).toHaveLength(1);

    await deletePurchase(purchase.eventId);
    await expect(
      createDocumentLink({
        ...input,
        documentRef: "asset-dup",
      }),
    ).rejects.toThrow(/不存在/);
  });

  it("仅保存票据时生成可继续关联的生活事件，元数据与文件状态分开", async () => {
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO capture_assets (id, kind, source, name, local_path, mime, byte_size, state, created_at, updated_at)
       VALUES ('asset-plain', 'scan', 'scanner', 'scan.jpg', '/tmp/scan.jpg', 'image/jpeg', 2048, 'saved', 1, 1)`,
    );
    const receipt = await createReceiptEvent({
      name: "扫描票据",
      assetId: "asset-plain",
      mime: "image/jpeg",
      byteSize: 2048,
      occurredAt: day(2026, 11, 16),
    });
    const detail = await getEventDetail(receipt.eventId);
    expect(detail?.eventType).toBe("general");
    expect(detail?.links[0]?.documentSource).toBe("capture_asset");
    expect(detail?.links[0]?.documentRef).toBe("asset-plain");
    expect(detail?.links[0]?.transferState).toBe("local");
  });

  it("上传成功但暂存导入失败时保留远端文件 ID，重试可复用而非重复上传", async () => {
    const purchase = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
    });
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO capture_assets (id, kind, source, name, local_path, mime, state, created_at, updated_at)
       VALUES ('asset-retry', 'photo', 'camera', 'receipt.jpg', '/tmp/receipt.jpg', 'image/jpeg', 'saved', 1, 1)`,
    );
    const linkId = await createDocumentLink({
      ownerType: "event",
      ownerId: purchase.eventId,
      documentRef: "asset-retry",
      documentSource: "capture_asset",
      documentName: "小票",
      mime: "image/jpeg",
      transferState: "local",
    });

    await markDocumentFileUploaded(linkId, {
      remoteFileId: "file-upload-1",
      name: "小票.jpg",
    });
    let link = (await listDocumentLinks("event", purchase.eventId))[0];
    expect(link).toMatchObject({
      documentSource: "capture_asset",
      documentRef: "asset-retry",
      remoteRef: "file-upload-1",
      remoteSource: "file",
      transferState: "metadata_only",
      documentName: "小票.jpg",
    });

    await markDocumentUploaded(linkId, { shelfItemId: "shelf-receipt-1" });
    link = (await listDocumentLinks("event", purchase.eventId))[0];
    expect(link).toMatchObject({
      documentSource: "capture_asset",
      remoteRef: "shelf-receipt-1",
      remoteSource: "shelf_item",
      transferState: "transferred",
    });
  });

  it("原图经文件互传入库后，关联切到 shelf_item 并标记 transferred", async () => {
    const purchase = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
    });
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO capture_assets (id, kind, source, name, local_path, mime, state, created_at, updated_at)
       VALUES ('asset-send', 'photo', 'camera', 'receipt.jpg', '/tmp/receipt.jpg', 'image/jpeg', 'saved', 1, 1)`,
    );
    const linkId = await createDocumentLink({
      ownerType: "event",
      ownerId: purchase.eventId,
      documentRef: "asset-send",
      documentSource: "capture_asset",
      documentName: "小票",
      mime: "image/jpeg",
      byteSize: 1024,
      transferState: "local",
    });

    await markDocumentUploaded(linkId, {
      shelfItemId: "shelf-receipt-1",
      name: "小票.jpg",
      mime: "image/jpeg",
      byteSize: 1024,
    });

    const links = await listDocumentLinks("event", purchase.eventId);
    expect(links[0]).toMatchObject({
      documentSource: "capture_asset",
      documentRef: "asset-send",
      remoteRef: "shelf-receipt-1",
      remoteSource: "shelf_item",
      transferState: "transferred",
      documentName: "小票.jpg",
    });
    expect(links[0]?.localUri).toBe("/tmp/receipt.jpg");
    const outbox = await db.getAllAsync<{ payload: string }>(
      "SELECT payload FROM outbox WHERE entity = 'life_document_link' AND target_id = ? AND state = 'pending'",
      [linkId],
    );
    expect(outbox.some((row) => row.payload.includes('"update"'))).toBe(true);
  });
});
