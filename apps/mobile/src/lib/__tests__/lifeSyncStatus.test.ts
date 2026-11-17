import { describe, expect, it } from "vitest";

import type { DeferredLifeChange, LifeDeferReason } from "../../db/lifeSync";
import {
  DEFER_REASON_META,
  deferredStatusLabel,
  deferredTitle,
  formatDeferredTime,
  isAutoRetryable,
  reasonMeta,
  shortTargetId,
} from "../lifeSyncStatus";

const REASONS: LifeDeferReason[] = [
  "dependency",
  "pending_outbox",
  "name_conflict",
  "duplicate_link",
  "invalid",
];

function deferred(reason: LifeDeferReason, entity: DeferredLifeChange["entity"] = "life_item"): DeferredLifeChange {
  return {
    id: 1,
    entity,
    targetId: "item-1234567890",
    serverRev: 3,
    deleted: false,
    fields: {},
    updatedAt: Date.UTC(2026, 10, 17, 1, 5),
    reason,
    firstSeenAt: Date.UTC(2026, 10, 17, 1, 5),
    retryCount: 0,
    lastAttemptAt: null,
  };
}

describe("lifeSyncStatus", () => {
  it("五种延后原因都有可区分的中文标签和处理状态，不统一显示成同步失败", () => {
    const labels = new Set(REASONS.map((reason) => reasonMeta(reason).label));
    expect(labels.size).toBe(5);
    expect(REASONS.map((reason) => deferredStatusLabel(deferred(reason)))).toEqual([
      "等待自动恢复",
      "等待自动恢复",
      "需要选择",
      "需要确认",
      "需要处理",
    ]);
  });

  it("只有 dependency 与 pending_outbox 自动重试；同名冲突必须人工选择", () => {
    for (const reason of ["dependency", "pending_outbox"] as const) {
      expect(reasonMeta(reason).autoRetryable).toBe(true);
      expect(isAutoRetryable(deferred(reason))).toBe(true);
    }
    expect(reasonMeta("name_conflict").autoRetryable).toBe(false);
    expect(isAutoRetryable(deferred("name_conflict"))).toBe(false);
    expect(reasonMeta("name_conflict").manualRetryable).toBe(false);
    expect(reasonMeta("duplicate_link").manualRetryable).toBe(true);
    expect(reasonMeta("invalid").manualRetryable).toBe(true);
  });

  it("invalid 明确说明不会自动无限重试，也不会删除本机数据", () => {
    const meta = DEFER_REASON_META.invalid;
    expect(meta.autoRetryable).toBe(false);
    expect(meta.explanation).toContain("不会删除本机数据");
    expect(meta.suggestion).toContain("手动忽略");
  });

  it("列表标题与短 ID 不泄露整段 JSON，详情时间格式稳定", () => {
    const item = { ...deferred("dependency"), fields: { name: "  大米  " } };
    expect(deferredTitle(item)).toBe("大米");
    expect(deferredTitle({ ...item, fields: {} })).toBe("未命名商品");
    expect(shortTargetId("item-1234567890")).toBe("item-123…");
    expect(shortTargetId("short")).toBe("short");
    expect(formatDeferredTime(new Date(2026, 10, 17, 9, 5).getTime())).toBe("2026-11-17 09:05");
    expect(formatDeferredTime(Number.NaN)).toBe("—");
  });
});
