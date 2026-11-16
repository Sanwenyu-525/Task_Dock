/**
 * @vitest-environment jsdom
 */
//! 应用退出握手前端处理器：复用工作台正文守卫，失败/超时必须回执 false。

import { describe, expect, it, vi } from "vitest";
import { createAppExitHandler } from "./workbenchExitGuard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createAppExitHandler", () => {
  it("无正文守卫时快速回执成功", async () => {
    const ack = vi.fn(async () => true);
    const handler = createAppExitHandler({ getFlush: () => null, ack });
    await expect(handler(1)).resolves.toBe(true);
    expect(ack).toHaveBeenCalledWith(1, true);
  });

  it("有脏稿时等待 flush 成功再回执 true", async () => {
    const d = deferred<boolean>();
    const ack = vi.fn(async () => true);
    const handler = createAppExitHandler({ getFlush: () => () => d.promise, ack });
    const result = handler(2);
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    d.resolve(true);
    await expect(result).resolves.toBe(true);
    expect(ack).toHaveBeenCalledWith(2, true);
  });

  it("flush 失败回执 false，不伪装成功", async () => {
    const ack = vi.fn(async () => true);
    const handler = createAppExitHandler({
      getFlush: () => async () => false,
      ack,
    });
    await expect(handler(3)).resolves.toBe(false);
    expect(ack).toHaveBeenCalledWith(3, false);
  });

  it("flush 抛错也回执 false 并报告错误", async () => {
    const ack = vi.fn(async () => true);
    const onError = vi.fn();
    const handler = createAppExitHandler({
      getFlush: () => async () => {
        throw new Error("保存路径不可写");
      },
      ack,
      onError,
    });
    await expect(handler(4)).resolves.toBe(false);
    expect(ack).toHaveBeenCalledWith(4, false);
    expect(String(onError.mock.calls[0][0])).toContain("保存路径不可写");
  });

  it("同一 requestId 只处理一次", async () => {
    const ack = vi.fn(async () => true);
    const flush = vi.fn(async () => true);
    const handler = createAppExitHandler({ getFlush: () => flush, ack });
    await expect(handler(5)).resolves.toBe(true);
    await expect(handler(5)).resolves.toBe(false);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("后端回执被拒绝时返回 false 并报错", async () => {
    const ack = vi.fn(async () => false);
    const onError = vi.fn();
    const handler = createAppExitHandler({ getFlush: () => null, ack, onError });
    await expect(handler(6)).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
