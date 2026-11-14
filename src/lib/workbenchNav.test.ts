//! 跨窗口工作台导航事务：回执先到、超时、取消、编号不一致与失败都必须如实收敛。
//!
//! 这里锁定「事件送达 ≠ 导航成功」：只有收到同号 ack 才算 succeeded。

import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  workbenchOpenWindow: vi.fn(),
  onWorkbenchNavAck: vi.fn(),
  workbenchTakeNav: vi.fn(),
  workbenchNavAck: vi.fn(),
}));

vi.mock("./bridge", () => bridge);
vi.mock("./diagnostics", () => ({ logEvent: vi.fn() }));

import { openWorkbench, __resetWorkbenchNavForTests } from "./workbenchNav";

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
    expect(unlistenCalls).toBe(1);
  });

  it("pending / cancelled / failed 原样收敛，不伪装成功", async () => {
    const cases = [
      { status: "pending" as const, error: null },
      { status: "cancelled" as const, error: null },
      { status: "failed" as const, error: "路由被拒绝" },
    ];
    for (const [index, entry] of cases.entries()) {
      const requestId = 200 + index;
      bridge.workbenchOpenWindow.mockImplementation(async () => {
        ackHandler?.({ requestId, status: entry.status, error: entry.error });
        return { requestId, created: true };
      });
      const outcome = await openWorkbench({ tab: "agents" }, { requestId });
      expect(outcome.status).toBe(entry.status);
      expect(outcome.ok).toBe(false);
      expect(outcome.pending).toBe(entry.status === "pending");
      if (entry.error) expect(outcome.error).toBe(entry.error);
    }
  });

  it("超时返回 failed 并带可读原因（不宣称已打开）", async () => {
    bridge.workbenchOpenWindow.mockResolvedValue({ requestId: 301, created: true });
    const outcome = await openWorkbench({ tab: "tasks" }, { requestId: 301, timeoutMs: 5 });
    expect(outcome.status).toBe("failed");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("未在");
  });

  it("命令失败（窗口不可用）如实返回 failed", async () => {
    bridge.workbenchOpenWindow.mockRejectedValue(new Error("主窗口不可用"));
    const outcome = await openWorkbench({ tab: "home" }, { requestId: 401 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("主窗口不可用");
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
