//! 跨窗口工作台导航事务：回执先到、pending 生命周期、取消、编号不一致与失败
//! 都必须如实收敛。这里锁定「事件送达 ≠ 导航成功」，也锁定 pending 不是终态。

import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  workbenchOpenWindow: vi.fn(),
  onWorkbenchNavAck: vi.fn(),
  workbenchTakeNav: vi.fn(),
  workbenchNavAck: vi.fn(),
}));

vi.mock("./bridge", () => bridge);
vi.mock("./diagnostics", () => ({ logEvent: vi.fn() }));

import {
  openWorkbench,
  openWorkbenchAndWait,
  __resetWorkbenchNavForTests,
} from "./workbenchNav";

type AckHandler = (ack: {
  requestId: number;
  status: "succeeded" | "pending" | "cancelled" | "failed";
  error: string | null;
}) => void;

let ackHandler: AckHandler | null = null;
let unlistenCalls = 0;

beforeEach(() => {
  ackHandler = null;
  unlistenCalls = 0;
  __resetWorkbenchNavForTests();
  bridge.workbenchOpenWindow.mockReset();
  bridge.onWorkbenchNavAck.mockReset();
  bridge.workbenchTakeNav.mockReset();
  bridge.workbenchNavAck.mockReset();
  bridge.onWorkbenchNavAck.mockImplementation(async (handler: AckHandler) => {
    ackHandler = handler;
    return () => {
      unlistenCalls += 1;
      ackHandler = null;
    };
  });
});

describe("openWorkbench", () => {
  it("回执先于命令响应到达也能正确收敛为成功", async () => {
    bridge.workbenchOpenWindow.mockImplementation(async ({ requestId }: { requestId: number }) => {
      // 模拟工作台在 invoke 返回之前就回执（窗口已存在时的常见时序）。
      ackHandler?.({ requestId, status: "succeeded", error: null });
      return { requestId, created: false };
    });
    const outcome = await openWorkbench({ tab: "tasks" }, { requestId: 101 });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.ok).toBe(true);
    expect(outcome.created).toBe(false);
    expect(outcome.settled).toBeTruthy();
    await expect(outcome.settled).resolves.toMatchObject({ status: "succeeded" });
    expect(unlistenCalls).toBe(1);
  });

  it("pending 返回后保留监听，最终 succeeded 可追踪", async () => {
    bridge.workbenchOpenWindow.mockImplementation(async ({ requestId }: { requestId: number }) => {
      ackHandler?.({ requestId, status: "pending", error: null });
      return { requestId, created: true };
    });
    const outcome = await openWorkbench(
      { tab: "workspace", projectId: "p2" },
      { requestId: 201 },
    );
    expect(outcome.status).toBe("pending");
    expect(outcome.pending).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(unlistenCalls).toBe(0);

    const handler = ackHandler;
    expect(handler).toBeTruthy();
    handler?.({ requestId: 201, status: "succeeded", error: null });

    const final = await outcome.settled;
    expect(final.status).toBe("succeeded");
    expect(final.ok).toBe(true);
    expect(unlistenCalls).toBe(1);

    // 终态之后的重复回执不得改写已收敛结果。
    const settledAgain = outcome.settled;
    handler?.({ requestId: 201, status: "failed", error: "迟到回执" });
    await Promise.resolve();
    await expect(settledAgain).resolves.toMatchObject({ status: "succeeded" });
  });

  it("pending → cancelled / failed 都收敛到最终结果，不被当成超时", async () => {
    for (const [index, entry] of [
      { status: "cancelled" as const, error: null },
      { status: "failed" as const, error: "项目切换失败" },
    ].entries()) {
      ackHandler = null;
      unlistenCalls = 0;
      bridge.onWorkbenchNavAck.mockImplementation(async (handler: AckHandler) => {
        ackHandler = handler;
        return () => {
          unlistenCalls += 1;
          ackHandler = null;
        };
      });
      const requestId = 210 + index;
      bridge.workbenchOpenWindow.mockImplementation(async () => {
        ackHandler?.({ requestId, status: "pending", error: null });
        return { requestId, created: false };
      });
      const outcome = await openWorkbench({ tab: "tasks" }, { requestId });
      expect(outcome.status).toBe("pending");
      (ackHandler as AckHandler | null)?.({ requestId, status: entry.status, error: entry.error });
      const final = await outcome.settled;
      expect(final.status).toBe(entry.status);
      if (entry.error) expect(final.error).toContain(entry.error);
      expect(unlistenCalls).toBe(1);
    }
  });

  it("pending 超时收敛为 failed（不永远停在 pending）", async () => {
    bridge.workbenchOpenWindow.mockImplementation(async ({ requestId }: { requestId: number }) => {
      ackHandler?.({ requestId, status: "pending", error: null });
      return { requestId, created: false };
    });
    const outcome = await openWorkbench(
      { tab: "tasks" },
      { requestId: 220, pendingTimeoutMs: 10 },
    );
    expect(outcome.status).toBe("pending");
    const final = await outcome.settled;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("等待工作台确认超时");
    expect(unlistenCalls).toBe(1);
  });

  it("重复 pending 不重复计时，也不改写初始结果", async () => {
    bridge.workbenchOpenWindow.mockImplementation(async ({ requestId }: { requestId: number }) => {
      ackHandler?.({ requestId, status: "pending", error: null });
      return { requestId, created: false };
    });
    const outcome = await openWorkbench(
      { tab: "tasks" },
      { requestId: 230, pendingTimeoutMs: 10_000 },
    );
    const handler = ackHandler;
    handler?.({ requestId: 230, status: "pending", error: null });
    expect(outcome.status).toBe("pending");
    handler?.({ requestId: 230, status: "succeeded", error: null });
    await expect(outcome.settled).resolves.toMatchObject({ status: "succeeded" });
  });

  it("超时返回 failed 并带可读原因（不宣称已打开）", async () => {
    bridge.workbenchOpenWindow.mockResolvedValue({ requestId: 301, created: true });
    const outcome = await openWorkbench({ tab: "tasks" }, { requestId: 301, timeoutMs: 5 });
    expect(outcome.status).toBe("failed");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("未在");
    await expect(outcome.settled).resolves.toMatchObject({ status: "failed" });
  });

  it("命令失败（窗口不可用）如实返回 failed", async () => {
    bridge.workbenchOpenWindow.mockRejectedValue(new Error("主窗口不可用"));
    const outcome = await openWorkbench({ tab: "home" }, { requestId: 401 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("主窗口不可用");
    await expect(outcome.settled).resolves.toMatchObject({ status: "failed" });
  });

  it("回执编号与请求不一致时拒绝把结果记到错误对象上", async () => {
    bridge.workbenchOpenWindow.mockImplementation(async () => {
      ackHandler?.({ requestId: 999, status: "succeeded", error: null });
      return { requestId: 999, created: false };
    });
    const outcome = await openWorkbench({ tab: "tasks" }, { requestId: 501 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("编号不一致");
  });

  it("订阅失败时直接失败，不发命令也不假成功", async () => {
    bridge.onWorkbenchNavAck.mockRejectedValue(new Error("event denied"));
    const outcome = await openWorkbench({ tab: "tasks" }, { requestId: 601 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("订阅工作台回执");
    expect(bridge.workbenchOpenWindow).not.toHaveBeenCalled();
  });
});

describe("openWorkbenchAndWait", () => {
  it("pending 时等待最终确认，而不是把 pending 当结果返回", async () => {
    bridge.workbenchOpenWindow.mockImplementation(async ({ requestId }: { requestId: number }) => {
      ackHandler?.({ requestId, status: "pending", error: null });
      return { requestId, created: false };
    });
    const waiting = openWorkbenchAndWait({ tab: "workspace" }, { requestId: 701 });
    await vi.waitFor(() => expect(ackHandler).toBeTruthy());
    ackHandler?.({ requestId: 701, status: "pending", error: null });
    await vi.waitFor(() => expect(unlistenCalls).toBe(0));
    ackHandler?.({ requestId: 701, status: "cancelled", error: null });
    await expect(waiting).resolves.toMatchObject({ status: "cancelled" });
  });
});
