// 分享载荷队列（JS 层）单测：验证「同一 Intent 双通道到达不重复入队」、有界队列、
// 订阅/取消与取消清空。原生模块在测试环境缺失（requireOptionalNativeModule → null），
// 因此这里只覆盖 JS 队列语义；Kotlin 侧的 Intent 解析与冷启动闩需真机验证。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShareIntentPayload } from "../modules/share-intent";
import {
  consumePendingShare,
  discardPendingShare,
  offerShare,
  pullInitialShare,
  subscribePendingShare,
} from "../src/lib/pendingShare";

function payload(offerId: number, text = `text-${offerId}`): ShareIntentPayload {
  return {
    offerId,
    text,
    truncated: false,
    originalLength: text.length,
    receivedAt: offerId,
  };
}

describe("pendingShare 队列", () => {
  beforeEach(() => {
    discardPendingShare();
  });

  // lastOfferId 是模块级单调量，各用例使用递增区间的 id，互不干扰。
  it("按 offerId 去重：同一载荷经事件与拉取双通道到达只入队一次", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingShare(listener);

    expect(offerShare(payload(1001))).toBe(true);
    expect(offerShare(payload(1001))).toBe(false); // 双通道重放
    expect(offerShare(payload(1000))).toBe(false); // 更旧的载荷
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(consumePendingShare()?.offerId).toBe(1001);
  });

  it("队列上限 5：连续分享只保留最近 5 条，按先进先出取走", () => {
    for (let index = 0; index < 7; index += 1) {
      offerShare(payload(2000 + index));
    }

    const taken: number[] = [];
    for (;;) {
      const next = consumePendingShare();
      if (!next) break;
      taken.push(next.offerId);
    }
    expect(taken).toEqual([2002, 2003, 2004, 2005, 2006]);
  });

  it("取消订阅后不再收到通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingShare(listener);
    unsubscribe();

    offerShare(payload(3000));
    expect(listener).not.toHaveBeenCalled();
  });

  it("discardPendingShare 清空队列（返回/取消不留待处理载荷）", () => {
    offerShare(payload(4000));
    discardPendingShare();

    expect(consumePendingShare()).toBeNull();
  });

  it("原生模块缺失时 pullInitialShare 安全返回 false（不抛异常）", () => {
    expect(pullInitialShare()).toBe(false);
  });
});
