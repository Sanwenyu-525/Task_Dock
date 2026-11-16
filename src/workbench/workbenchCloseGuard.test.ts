/**
 * @vitest-environment jsdom
 */
//! 工作台窗口关闭握手：阻止 → flush → 成功才 close，失败保持窗口。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installWorkbenchCloseGuard,
  type WorkbenchCloseEvent,
  type WorkbenchCloseWindow,
} from "./workbenchCloseGuard";

type CloseHandler = (event: WorkbenchCloseEvent) => void | Promise<void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeWindow() {
  let handler: CloseHandler | null = null;
  const close = vi.fn(async () => {});
  const window: WorkbenchCloseWindow = {
    onCloseRequested: vi.fn(async (next: CloseHandler) => {
      handler = next;
      return () => {
        handler = null;
      };
    }),
    close,
  };
  return {
    window,
    close,
    fire: (event: WorkbenchCloseEvent) => handler?.(event),
  };
}

function event() {
  return { preventDefault: vi.fn() };
}

describe("installWorkbenchCloseGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("没有正文守卫：不拦截，窗口走原生关闭", async () => {
    const fake = fakeWindow();
    await installWorkbenchCloseGuard({ window: fake.window, getFlush: () => null, onError: vi.fn() });
    const e = event();
    fake.fire(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("有脏稿：先同步阻止，flush 成功后才 close", async () => {
    const fake = fakeWindow();
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    await installWorkbenchCloseGuard({ window: fake.window, getFlush: () => flush, onError: vi.fn() });

    const e = event();
    fake.fire(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();

    d.resolve(true);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("保存失败：保持窗口并报告错误，允许再次尝试", async () => {
    const fake = fakeWindow();
    const onError = vi.fn();
    const flush = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await installWorkbenchCloseGuard({ window: fake.window, getFlush: () => flush, onError });

    fake.fire(event());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(fake.close).not.toHaveBeenCalled();
    expect(String(onError.mock.calls[0][0])).toContain("正文尚未保存");

    fake.fire(event());
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("重复关闭只执行一轮有效 flush", async () => {
    const fake = fakeWindow();
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    await installWorkbenchCloseGuard({ window: fake.window, getFlush: () => flush, onError: vi.fn() });

    const e1 = event();
    const e2 = event();
    fake.fire(e1);
    fake.fire(e2);
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    expect(e2.preventDefault).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);

    d.resolve(true);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
  });

  it("flush 抛错：不关闭且错误不被吞掉", async () => {
    const fake = fakeWindow();
    const onError = vi.fn();
    const flush = vi.fn().mockRejectedValue(new Error("磁盘只读"));
    await installWorkbenchCloseGuard({ window: fake.window, getFlush: () => flush, onError });

    fake.fire(event());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain("磁盘只读");
    expect(fake.close).not.toHaveBeenCalled();
  });
});
