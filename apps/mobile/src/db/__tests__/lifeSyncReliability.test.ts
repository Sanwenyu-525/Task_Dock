// 生活同步可靠性回归：延后持久化、跨页/乱序依赖、同名商品冲突、删除与编辑、
// 重复 push/pull、中断恢复与冲突解决后的购买历史关联。
// 全部使用真实 SQLite 与真实 applyPullChanges/resolveLifeNameConflict，不模拟后端。
import { beforeEach, describe, expect, it } from "vitest";

import type { Change } from "../../lib/sync/protocol";
import {
  applyPullChanges,
  buildPendingOps,
  listSyncConflicts,
  loadSyncCursor,
  resolveLifeNameConflict,
  saveSyncCursor,
} from "../sync";
import { closeDatabase, getDatabase, openDatabase } from "../database";
import { createPurchase } from "../life";

function day(year: number, month: number, date: number): number {
  return new Date(year, month - 1, date, 0, 0, 0, 0).getTime();
}

function itemChange(rev = 1, id = "item-desk"): Change {
  return {
    entity: "life_item",
    id,
    rev,
    deleted: false,
    fields: {
      name: "大米",
      normalizedName: "大米",
      category: "粮油",
      aliases: [],
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
      itemId: "item-desk",
      itemNameSnapshot: "大米",
      quantityValue: "5",
      quantityUnit: "kg",
      unitPriceMinor: null,
      totalPriceMinor: 4800,
      currency: "CNY",
      amountScale: 2,
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

async function deferredRows(): Promise<{ target_id: string; reason: string }[]> {
  return getDatabase().getAllAsync<{ target_id: string; reason: string }>(
    "SELECT target_id, reason FROM life_sync_deferred ORDER BY id",
  );
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
});

describe("AC-SYNC 生活同步可靠性", () => {
  it("AC-SYNC-01/10：同名商品跨设备冲突保留购买历史，解决后关联到目标商品", async () => {
    const local = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
      quantityValue: "5",
      quantityUnit: "kg",
      totalPrice: "48",
      currency: "CNY",
      merchant: "某超市",
    });
    const before = await getDatabase().getFirstAsync<{
      id: string;
      item_id: string | null;
      item_name_snapshot: string;
      total_price_minor: number;
      occurred_at: number;
    }>(
      `SELECT ei.id, ei.item_id, ei.item_name_snapshot, ei.total_price_minor, e.occurred_at
         FROM life_event_items ei JOIN life_events e ON e.id = ei.event_id
        WHERE ei.event_id = ?`,
      [local.eventId],
    );
    expect(before?.item_id).toBe(local.itemId);

    // 桌面端已有同归一化名称、但 ID 不同的商品；手机 pull 不能静默丢掉本机明细。
    const pull = await applyPullChanges([itemChange(7)]);
    expect(pull).toEqual({ applied: 0, deleted: 0, skipped: 1 });
    expect(await deferredRows()).toEqual([
      { target_id: "item-desk", reason: "name_conflict" },
    ]);
    const conflict = (await listSyncConflicts()).find(
      (row) => row.reason === "life_item_name_conflict",
    );
    expect(conflict).toBeTruthy();

    await resolveLifeNameConflict(conflict!);

    const db = getDatabase();
    const remapped = await db.getFirstAsync<{
      item_id: string | null;
      item_name_snapshot: string;
      total_price_minor: number;
      occurred_at: number;
      amount_scale: number;
    }>(
      `SELECT ei.item_id, ei.item_name_snapshot, ei.total_price_minor, e.occurred_at,
              ei.amount_scale
         FROM life_event_items ei JOIN life_events e ON e.id = ei.event_id
        WHERE ei.id = ?`,
      [before!.id],
    );
    expect(remapped).toEqual({
      item_id: "item-desk",
      item_name_snapshot: "大米",
      total_price_minor: 4800,
      occurred_at: day(2026, 11, 3),
      amount_scale: 2,
    });
    const source = await db.getFirstAsync<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM life_items WHERE id = ?",
      [local.itemId],
    );
    expect(source?.deleted_at).not.toBeNull();
    const target = await db.getFirstAsync<{ server_rev: number; normalized_name: string }>(
      "SELECT server_rev, normalized_name FROM life_items WHERE id = 'item-desk'",
    );
    expect(target).toEqual({ server_rev: 7, normalized_name: "大米" });
    expect(await deferredRows()).toEqual([]);
    expect(await listSyncConflicts()).toEqual([]);

    // 明细重新入队后，下一次 push 会把“指向目标商品”的结果带给桌面端。
    const ops = await buildPendingOps();
    const detailOp = ops.find((op) => op.targetId === before!.id);
    expect(detailOp?.op.patch.itemId).toBe("item-desk");
  });

  it("AC-SYNC-02：购买明细先于父级事件到达，父级到达后自动应用", async () => {
    const first = await applyPullChanges([itemChange(1), eventItemChange(1)]);
    expect(first).toEqual({ applied: 1, deleted: 0, skipped: 1 });
    expect(await deferredRows()).toEqual([
      { target_id: "event-item-g", reason: "dependency" },
    ]);
    const second = await applyPullChanges([eventChange(1)]);
    expect(second.applied).toBe(2); // 事件 + 延后明细重放
    expect(
      await getDatabase().getFirstAsync<{ item_id: string; amount_scale: number }>(
        "SELECT item_id, amount_scale FROM life_event_items WHERE id = 'event-item-g'",
      ),
    ).toEqual({ item_id: "item-desk", amount_scale: 2 });
    expect(await deferredRows()).toEqual([]);
  });

  it("AC-SYNC-03：票据关联先于购买事件到达，事件到达后自动应用", async () => {
    const first = await applyPullChanges([linkChange(1)]);
    expect(first).toEqual({ applied: 0, deleted: 0, skipped: 1 });
    expect(await deferredRows()).toEqual([{ target_id: "link-g", reason: "dependency" }]);
    await applyPullChanges([itemChange(1), eventChange(1)]);
    expect(
      await getDatabase().getFirstAsync<{ r: string }>(
        "SELECT r FROM (SELECT id AS r FROM life_document_links WHERE id = 'link-g')",
      ),
    ).toEqual({ r: "link-g" });
    expect(await deferredRows()).toEqual([]);
  });

  it("AC-SYNC-04：发生延后后游标仍推进，重新同步仍可恢复", async () => {
    const first = await applyPullChanges([eventItemChange(1)]);
    expect(first.skipped).toBe(1);
    // 模拟 engine 在 apply 完成后保存游标：延后项已先在 SQLite 持久化，不会被游标跳过。
    await saveSyncCursor("page-1-cursor");
    expect(await loadSyncCursor()).toBe("page-1-cursor");
    expect(await deferredRows()).toEqual([
      { target_id: "event-item-g", reason: "dependency" },
    ]);
    // 测试替身是 :memory: SQLite，无法用 close/open 证明重启；见报告限制说明。
    await applyPullChanges([itemChange(1), eventChange(1)]);
    expect(
      await getDatabase().getFirstAsync<{ item_id: string }>(
        "SELECT item_id FROM life_event_items WHERE id = 'event-item-g'",
      ),
    ).toEqual({ item_id: "item-desk" });
    expect(await deferredRows()).toEqual([]);
  });

  it("AC-SYNC-05：本地存在未发送操作时，服务端更新不覆盖本机编辑", async () => {
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO life_items (id, name, normalized_name, created_at, updated_at, rev, server_rev)
       VALUES ('item-local', '本机大米', '本机大米', 1, 1, 2, 0)`,
    );
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at, state)
       VALUES ('op-local', 'life_item', 'item-local', 0, '{"type":"update"}', 1, 'pending')`,
    );
    const remote = itemChange(9, "item-local");
    remote.fields.name = "桌面大米";
    remote.fields.normalizedName = "桌面大米";
    const result = await applyPullChanges([remote]);
    expect(result).toEqual({ applied: 0, deleted: 0, skipped: 1 });
    expect(
      (await db.getFirstAsync<{ name: string }>("SELECT name FROM life_items WHERE id = 'item-local'"))
        ?.name,
    ).toBe("本机大米");
    expect(await deferredRows()).toEqual([
      { target_id: "item-local", reason: "pending_outbox" },
    ]);
  });

  it("AC-SYNC-06：一端删除、一端编辑，删除被延后而不是静默覆盖本机", async () => {
    await applyPullChanges([itemChange(2), eventChange(2)]);
    const db = getDatabase();
    await db.runAsync(
      `INSERT INTO outbox (op_id, entity, target_id, base_rev, payload, created_at, state)
       VALUES ('op-edit', 'life_event', 'event-g', 2, '{"type":"update"}', 5, 'pending')`,
    );
    const result = await applyPullChanges([
      { ...eventChange(5), deleted: true, fields: {} },
    ]);
    expect(result).toEqual({ applied: 0, deleted: 0, skipped: 1 });
    expect(
      (await db.getFirstAsync<{ deleted_at: number | null }>(
        "SELECT deleted_at FROM life_events WHERE id = 'event-g'",
      ))?.deleted_at,
    ).toBeNull();
    expect(await deferredRows()).toEqual([{ target_id: "event-g", reason: "pending_outbox" }]);
  });

  it("AC-SYNC-07：重复 push 复用 op_id，重复 pull 不产生副本", async () => {
    const saved = await createPurchase({
      name: "大米",
      occurredAt: day(2026, 11, 3),
      totalPrice: "48",
      currency: "CNY",
    });
    const firstOps = await buildPendingOps();
    const secondOps = await buildPendingOps();
    expect(firstOps.map((op) => op.op.op_id)).toEqual(secondOps.map((op) => op.op.op_id));

    await applyPullChanges([itemChange(1), eventChange(1)]);
    await applyPullChanges([itemChange(1), eventChange(1)]);
    const db = getDatabase();
    expect(await db.getAllAsync("SELECT id FROM life_items WHERE normalized_name = '大米'")).toHaveLength(
      1,
    );
    // 本机购买记录仍在，未被服务端同名商品覆盖。
    expect(await db.getAllAsync("SELECT id FROM life_events WHERE id = ?", [saved.eventId])).toHaveLength(
      1,
    );
  });

  it("AC-SYNC-08：同步中断后延后项保留，父级到达后恢复", async () => {
    await applyPullChanges([linkChange(1)]);
    // 测试替身是 :memory: SQLite；真实进程重启后的恢复需真机验证。
    expect((await deferredRows())[0]?.reason).toBe("dependency");
    await applyPullChanges([itemChange(1), eventChange(1)]);
    expect(await deferredRows()).toEqual([]);
    expect(
      await getDatabase().getFirstAsync<{ id: string }>(
        "SELECT id FROM life_document_links WHERE id = 'link-g'",
      ),
    ).toEqual({ id: "link-g" });
  });

  it("AC-SYNC-09：多页同步中父子记录跨页，后一页到达后自动应用", async () => {
    // 第 1 页只有事件；第 2 页才有商品与明细（与正常顺序相反）。
    await applyPullChanges([eventChange(1)]);
    expect(await deferredRows()).toEqual([]);
    await applyPullChanges([itemChange(1), eventItemChange(1)]);
    expect(await deferredRows()).toEqual([]);
    expect(
      await getDatabase().getFirstAsync<{ item_id: string }>(
        "SELECT item_id FROM life_event_items WHERE id = 'event-item-g'",
      ),
    ).toEqual({ item_id: "item-desk" });
  });
});
