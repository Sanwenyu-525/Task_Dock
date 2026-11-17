// 生活实体同步落库测试：pull 幂等、外键顺序、墓碑版本、outbox 锁与 push 载荷。
// 使用真实 SQLite harness，不模拟后端。
import { beforeEach, describe, expect, it } from "vitest";

import type { Change } from "../../lib/sync/protocol";
import { applyPullChanges, buildPendingOps } from "../sync";
import { closeDatabase, getDatabase, openDatabase } from "../database";
import { createPurchase } from "../life";

function day(year: number, month: number, date: number): number {
  return new Date(year, month - 1, date, 0, 0, 0, 0).getTime();
}

function itemChange(rev = 1): Change {
  return {
    entity: "life_item",
    id: "item-g",
    rev,
    deleted: false,
    fields: {
      name: "大米",
      normalizedName: "大米",
      category: "粮油",
      aliases: ["东北大米"],
      note: null,
      createdAt: day(2026, 9, 1),
      updatedAt: day(2026, 11, 3),
    },
    updated_at: day(2026, 11, 3),
  };
}

function eventChange(rev = 1, occurredAt = day(2026, 11, 3)): Change {
  return {
    entity: "life_event",
    id: "event-g",
    rev,
    deleted: false,
    fields: {
      eventType: "purchase",
      title: "大米",
      description: null,
      occurredAt,
      merchant: "某超市",
      source: "manual",
      createdAt: day(2026, 11, 16),
      updatedAt: day(2026, 11, 16),
    },
    updated_at: day(2026, 11, 16),
  };
}

function eventItemChange(rev = 1): Change {
  return {
    entity: "life_event_item",
    id: "event-item-g",
    rev,
    deleted: false,
    fields: {
      eventId: "event-g",
      itemId: "item-g",
      itemNameSnapshot: "大米",
      quantityValue: "5",
      quantityUnit: "kg",
      unitPriceMinor: null,
      totalPriceMinor: 4800,
      currency: "CNY",
      note: null,
      createdAt: day(2026, 11, 16),
      updatedAt: day(2026, 11, 16),
    },
    updated_at: day(2026, 11, 16),
  };
}

function linkChange(rev = 1): Change {
  return {
    entity: "life_document_link",
    id: "link-g",
    rev,
    deleted: false,
    fields: {
      ownerType: "event",
      ownerId: "event-g",
      documentRef: "asset-g",
      documentSource: "capture_asset",
      documentName: "超市小票",
      mime: "image/jpeg",
      byteSize: 1024,
      transferState: "local",
      createdAt: day(2026, 11, 16),
      updatedAt: day(2026, 11, 16),
    },
    updated_at: day(2026, 11, 16),
  };
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
});

describe("生活同步 pull", () => {
  it("按商品→事件→明细→关联落库，实际购买日期保留", async () => {
    const result = await applyPullChanges([
      itemChange(),
      eventChange(),
      eventItemChange(),
      linkChange(),
    ]);
    expect(result).toEqual({ applied: 4, deleted: 0, skipped: 0 });

    const db = getDatabase();
    const event = await db.getFirstAsync<{ occurred_at: number }>(
      "SELECT occurred_at FROM life_events WHERE id = 'event-g'",
    );
    expect(event?.occurred_at).toBe(day(2026, 11, 3));
    const item = await db.getFirstAsync<{ normalized_name: string; server_rev: number }>(
      "SELECT normalized_name, server_rev FROM life_items WHERE id = 'item-g'",
    );
    expect(item).toEqual({ normalized_name: "大米", server_rev: 1 });
    const eventItem = await db.getFirstAsync<{ total_price_minor: number; quantity_value: string }>(
      "SELECT total_price_minor, quantity_value FROM life_event_items WHERE id = 'event-item-g'",
    );
    expect(eventItem).toEqual({ total_price_minor: 4800, quantity_value: "5" });
    const link = await db.getFirstAsync<{ owner_id: string; transfer_state: string }>(
      "SELECT owner_id, transfer_state FROM life_document_links WHERE id = 'link-g'",
    );
    expect(link).toEqual({ owner_id: "event-g", transfer_state: "local" });
  });

  it("重复拉取不产生副本，旧版本不覆盖新版本", async () => {
    await applyPullChanges([itemChange(3), eventChange(3), eventItemChange(3), linkChange(3)]);
    const result = await applyPullChanges([
      itemChange(3),
      eventChange(3),
      eventItemChange(3),
      linkChange(3),
    ]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(4);

    // 旧 rev 晚到：保持 rev 3 的内容。
    const stale = await applyPullChanges([
      {
        ...itemChange(2),
        fields: { ...itemChange(2).fields, name: "旧名称" },
      },
    ]);
    expect(stale.skipped).toBe(1);
    const db = getDatabase();
    const row = await db.getFirstAsync<{ name: string; server_rev: number }>(
      "SELECT name, server_rev FROM life_items WHERE id = 'item-g'",
    );
    expect(row).toEqual({ name: "大米", server_rev: 3 });
    expect(
      await db.getAllAsync<{ id: string }>("SELECT id FROM life_items WHERE normalized_name = '大米'"),
    ).toHaveLength(1);
  });

  it("外键顺序错误时跳过关联，事件到达后重放可落库", async () => {
    const first = await applyPullChanges([linkChange(1)]);
    expect(first.skipped).toBe(1);
    // 事件到达后重放同一变更
    await applyPullChanges([itemChange(1), eventChange(1)]);
    const replay = await applyPullChanges([linkChange(1)]);
    expect(replay.applied).toBe(1);
    expect(
      await getDatabase().getFirstAsync<{ id: string }>(
        "SELECT id FROM life_document_links WHERE id = 'link-g'",
      ),
    ).toEqual({ id: "link-g" });
  });

  it("墓碑按版本生效；旧墓碑不会复活或删除新记录", async () => {
    await applyPullChanges([itemChange(5), eventChange(5)]);
    const tombstone = await applyPullChanges([
      { ...eventChange(5), deleted: true, fields: {} },
    ]);
    expect(tombstone.deleted).toBe(1);
    const db = getDatabase();
    expect(
      (await db.getFirstAsync<{ deleted_at: number | null }>(
        "SELECT deleted_at FROM life_events WHERE id = 'event-g'",
      ))?.deleted_at,
    ).not.toBeNull();

    // 旧墓碑 rev 4 晚到，不能改变 rev 5 的墓碑状态（仍是删除，不回退内容）。
    const staleTombstone = await applyPullChanges([
      { ...eventChange(4), deleted: true, fields: {} },
    ]);
    expect(staleTombstone.skipped).toBe(1);
  });

  it("本地有 pending outbox 时，pull 不覆盖本机编辑", async () => {
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO life_items (id, name, normalized_name, created_at, updated_at, rev, server_rev)
       VALUES ('item-local', '本机大米', '本机大米', 1, 1, 2, 0)`,
    );
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at, state)
       VALUES ('op-local', 'life_item', 'item-local', 0, '{"type":"update"}', 1, 'pending')`,
    );
    const remote = itemChange(9);
    remote.id = "item-local";
    remote.fields.name = "桌面大米";
    remote.fields.normalizedName = "桌面大米";
    const result = await applyPullChanges([remote]);
    expect(result.skipped).toBe(1);
    const row = await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM life_items WHERE id = 'item-local'",
    );
    expect(row?.name).toBe("本机大米");
  });
});

describe("生活同步 push 载荷", () => {
  it("createPurchase 的三条 outbox 生成 camelCase 补丁并保留定点金额", async () => {
    const saved = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
      quantityValue: "5",
      quantityUnit: "kg",
      totalPrice: "48.00",
      currency: "CNY",
      merchant: "某超市",
    });
    const ops = await buildPendingOps();
    const byEntity = new Map(ops.map((op) => [op.entity, op]));
    expect(byEntity.has("life_item")).toBe(true);
    expect(byEntity.has("life_event")).toBe(true);
    expect(byEntity.has("life_event_item")).toBe(true);

    const eventOp = byEntity.get("life_event");
    expect(eventOp?.targetId).toBe(saved.eventId);
    expect(eventOp?.op.patch.occurredAt).toBe(day(2026, 11, 3));
    expect(eventOp?.op.patch.merchant).toBe("某超市");
    const itemOp = byEntity.get("life_event_item");
    expect(itemOp?.op.patch.itemNameSnapshot).toBe("大米");
    expect(itemOp?.op.patch.quantityValue).toBe("5");
    expect(itemOp?.op.patch.totalPriceMinor).toBe(4800);
    expect(itemOp?.op.patch.currency).toBe("CNY");
    expect(typeof itemOp?.op.patch.totalPriceMinor).toBe("number");
  });
});
