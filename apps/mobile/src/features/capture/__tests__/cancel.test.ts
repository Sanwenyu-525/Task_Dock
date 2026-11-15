import { describe, expect, it, vi } from "vitest";

import { createTransferCancelToken } from "../cancel";

describe("TransferCancelToken", () => {
  it("首次取消触发一次监听，重复取消不重复触发", () => {
    const token = createTransferCancelToken();
    const listener = vi.fn();
    token.onCancel(listener);

    token.cancel();
    token.cancel();

    expect(token.cancelled).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("取消后注册的监听会立即执行，解除注册不再触发", () => {
    const token = createTransferCancelToken();
    token.cancel();
    const listener = vi.fn();
    const unbind = token.onCancel(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    unbind();
    token.cancel();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("单个监听抛错不影响其他监听", () => {
    const token = createTransferCancelToken();
    const second = vi.fn();
    token.onCancel(() => {
      throw new Error("abort failed");
    });
    token.onCancel(second);

    expect(() => token.cancel()).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
