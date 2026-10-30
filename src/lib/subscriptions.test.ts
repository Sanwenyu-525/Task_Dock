import { describe, expect, it, vi } from "vitest";
import { createSubscriptionScope } from "./subscriptions";

function deferred() {
  let resolve!: (fn: () => void) => void;
  const promise = new Promise<() => void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createSubscriptionScope", () => {
  it("延迟兑现的订阅在关闭后立即反订阅", async () => {
    const scope = createSubscriptionScope();
    const pending = deferred();
    const unlisten = vi.fn();
    scope.add(pending.promise);
    scope.dispose();
    expect(unlisten).not.toHaveBeenCalled();
    pending.resolve(unlisten);
    await pending.promise;
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("正常关闭释放全部已建立订阅且幂等", async () => {
    const scope = createSubscriptionScope();
    const a = vi.fn();
    const b = vi.fn();
    scope.add(Promise.resolve(a));
    scope.add(Promise.resolve(b));
    await Promise.resolve();
    await Promise.resolve();
    scope.dispose();
    scope.dispose();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("订阅失败不抛出未处理异常", async () => {
    const scope = createSubscriptionScope();
    scope.add(Promise.reject(new Error("listen failed")));
    await Promise.resolve();
    expect(scope.closed).toBe(false);
    scope.dispose();
    expect(scope.closed).toBe(true);
  });

  it("关闭后添加的订阅即使兑现也不会滞留", async () => {
    const scope = createSubscriptionScope();
    scope.dispose();
    const unlisten = vi.fn();
    scope.add(Promise.resolve(unlisten));
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
