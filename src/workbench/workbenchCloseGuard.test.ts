/**
 * @vitest-environment jsdom
 */
//! 工作台窗口关闭协调器：单一事务、同步拦截、保存超时、受理≠销毁。
//!
//! 这些用例锁定 2026-11-19 P0 关闭故障的五条根因：
//! 1. flush 永挂时不能把窗口永久留在「无反馈的拦截态」；
//! 2. 超时不能取消/覆盖底层保存，重试必须复用同一个 Promise；
//! 3. 重复 CloseRequested 只允许一笔有效 flush；
//! 4. close IPC 失败必须回到可重试状态；
//! 5. 关闭许可一旦建立，后续 CloseRequested 必须直接放行。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installWorkbenchCloseGuard,
  type WorkbenchCloseEvent,
  type WorkbenchCloseGuardHandle,
  type WorkbenchCloseSnapshot,
  type WorkbenchCloseState,
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
    label: () => "workspace",
  };
  return {
    window,
    close,
    /** 直接拿到 handler：dispose 之后还能验证「不再处理」。 */
    getHandler: () => handler,
    fire: (event: WorkbenchCloseEvent) => handler?.(event),
  };
}

function event() {
  return { preventDefault: vi.fn() };
}

const guards: WorkbenchCloseGuardHandle[] = [];

async function install(options: {
  flush?: (() => Promise<boolean>) | null;
  onError?: (error: unknown) => void;
  timeoutMs?: number;
  destroyTimeoutMs?: number;
  trace?: (stage: string, fields?: Record<string, unknown>) => void;
  onStateChange?: (snapshot: WorkbenchCloseSnapshot) => void;
}) {
  const fake = fakeWindow();
  const guard = await installWorkbenchCloseGuard({
    window: fake.window,
    getFlush: () => options.flush ?? null,
    onError: options.onError ?? vi.fn(),
    onStateChange: options.onStateChange,
    trace: options.trace,
    // 默认给足销毁兜底时间：单测不等真实窗口销毁。
    destroyTimeoutMs: options.destroyTimeoutMs ?? 60_000,
    timeoutMs: options.timeoutMs,
  });
  guards.push(guard);
  return { fake, guard };
}

afterEach(() => {
  while (guards.length > 0) guards.pop()?.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("installWorkbenchCloseGuard · 基本路径", () => {
  it("没有正文守卫：不拦截，窗口走原生关闭", async () => {
    const { fake } = await install({ flush: null });
    const e = event();
    fake.fire(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("flush 成功：首次同步拦截，二次 close 直接放行", async () => {
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    const { fake } = await install({ flush });

    const first = event();
    fake.fire(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();

    d.resolve(true);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));

    // 协调器自己发起的 close() 会再触发一次 CloseRequested：必须放行。
    const second = event();
    fake.fire(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flush 返回 false：保持窗口并报告原因，之后可重试", async () => {
    const flush = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onError = vi.fn();
    const { fake } = await install({ flush, onError });

    fake.fire(event());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain("正文尚未保存");
    expect(fake.close).not.toHaveBeenCalled();

    fake.fire(event());
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("flush 抛错：不关闭且错误不被吞掉", async () => {
    const onError = vi.fn();
    const flush = vi.fn().mockRejectedValue(new Error("磁盘只读"));
    const { fake } = await install({ flush, onError });

    fake.fire(event());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain("磁盘只读");
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("多次 CloseRequested：每次都同步拦截，但只跑一笔 flush", async () => {
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    const { fake } = await install({ flush });

    const e1 = event();
    const e2 = event();
    const e3 = event();
    fake.fire(e1);
    fake.fire(e2);
    fake.fire(e3);
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    expect(e2.preventDefault).toHaveBeenCalledTimes(1);
    expect(e3.preventDefault).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);

    d.resolve(true);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
  });
});

describe("installWorkbenchCloseGuard · 保存超时", () => {
  it("flush 永久 Pending：超时后给明确反馈，不关闭、不取消保存", async () => {
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    const onError = vi.fn();
    const states: WorkbenchCloseState[] = [];
    const { fake, guard } = await install({
      flush,
      onError,
      timeoutMs: 30,
      onStateChange: (snapshot) => states.push(snapshot.state),
    });

    fake.fire(event());
    expect(states).toContain("saving");
    expect(guard.getState().state).toBe("saving");

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const message = String(onError.mock.calls[0][0]);
    expect(message).toContain("仍在进行");
    expect(message).toContain("稍后重试");
    // 超时不等于失败：状态给 failed（可重试）但底层保存仍标记在途。
    expect(guard.getState()).toMatchObject({
      state: "failed",
      reason: "flush-timeout",
      flushPending: true,
    });
    expect(fake.close).not.toHaveBeenCalled();
    expect(states).toContain("failed");
  });

  it("超时后原始 Promise 成功：再次点击复用同一 Promise 并完成关闭", async () => {
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    const onError = vi.fn();
    const { fake } = await install({ flush, onError, timeoutMs: 25 });

    fake.fire(event());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(flush).toHaveBeenCalledTimes(1);

    // 用户重试：不得启动第二次保存，必须等原来那笔。
    const retry = event();
    fake.fire(retry);
    expect(retry.preventDefault).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);

    d.resolve(true);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("超时后先完成保存再重试：新事务直接通过（flush 立即返回 true）", async () => {
    const d = deferred<boolean>();
    const flush = vi.fn();
    flush.mockImplementationOnce(() => d.promise);
    flush.mockResolvedValueOnce(true);
    const onError = vi.fn();
    const { fake } = await install({ flush, onError, timeoutMs: 25 });

    fake.fire(event());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 1000 });

    d.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    fake.fire(event());
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
  });
});

describe("installWorkbenchCloseGuard · 关闭 IPC 与生命周期", () => {
  it("close IPC reject：回到可重试状态并暴露错误", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const onError = vi.fn();
    const { fake } = await install({ flush, onError });
    fake.close.mockRejectedValueOnce(new Error("IPC 断连"));

    fake.fire(event());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain("IPC 断连");

    // allowClose 必须回滚：再次关闭仍要拦截并重新走事务。
    const retry = event();
    fake.fire(retry);
    expect(retry.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(2));
  });

  it("close IPC 永不返回：等待受理同样有上限，超时后回到可重试状态", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const onError = vi.fn();
    const { fake, guard } = await install({ flush, onError, destroyTimeoutMs: 60 });
    const hang = deferred<void>();
    fake.close.mockImplementation(() => hang.promise);

    fake.fire(event());
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
    // 不能停在 retrying-close：必须有明确失败原因交给调用方展示。
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain("既未销毁也未返回受理结果");
    expect(guard.getState().state).toBe("failed");

    // 回到 failed 后必须真的可以重试：再次拦截并重新发起 close()。
    fake.close.mockResolvedValue(undefined);
    const retry = event();
    fake.fire(retry);
    expect(retry.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(2));
  });

  it("dispose 后不再处理任何关闭事件", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const { fake, guard } = await install({ flush });
    const handler = fake.getHandler();
    expect(handler).not.toBeNull();

    guard.stop();

    const e = event();
    await handler?.(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("allowClose 不会被错误重置：关闭受理后重复事件一律放行", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const { fake } = await install({ flush });

    fake.fire(event());
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 3; i += 1) {
      const e = event();
      fake.fire(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("按钮入口与系统关闭共用同一笔事务", async () => {
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    const { fake, guard } = await install({ flush });

    guard.requestClose();
    // 用户同时按 Alt+F4：只能并入，不得再跑一次 flush。
    const native = event();
    fake.fire(native);
    expect(native.preventDefault).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);

    d.resolve(true);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
  });
});

describe("installWorkbenchCloseGuard · 诊断", () => {
  it("按顺序记录关闭阶段，供终端与 Rust 日志对齐", async () => {
    const stages: string[] = [];
    const flush = vi.fn().mockResolvedValue(true);
    const { fake } = await install({
      flush,
      trace: (stage) => stages.push(stage),
    });

    fake.fire(event());
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));

    expect(stages[0]).toBe("CLOSE_GUARD_INSTALLED");
    expect(stages).toContain("CLOSE_GUARD_PREVENTED");
    expect(stages).toContain("CLOSE_GUARD_REQUESTED");
    expect(stages).toContain("CLOSE_GUARD_FLUSH_STARTED");
    expect(stages).toContain("CLOSE_GUARD_FLUSH_COMPLETED");
    expect(stages).toContain("CLOSE_GUARD_RETRY_CLOSE_STARTED");
    expect(stages).toContain("CLOSE_GUARD_RETRY_CLOSE_ACCEPTED");
  });

  it("重复请求记录 DUPLICATE，不产生第二笔事务", async () => {
    const stages: string[] = [];
    const d = deferred<boolean>();
    const flush = vi.fn(() => d.promise);
    const { fake } = await install({ flush, trace: (stage) => stages.push(stage) });

    fake.fire(event());
    fake.fire(event());
    expect(stages.filter((stage) => stage === "CLOSE_GUARD_DUPLICATE")).toHaveLength(1);
    expect(flush).toHaveBeenCalledTimes(1);
    d.resolve(true);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
  });
});
