/**
 * @vitest-environment jsdom
 */
//! 通知窗口集成测试：六状态渲染、重复事件就地更新、动作分发、
//! 主题落地与空栈隐藏。Tauri IPC（invoke / listen）打桩，
//! 业务断言只看调用参数与 DOM 状态。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type InvokeArgs = Record<string, unknown>;
const invokeMock = vi.fn<(cmd: string, args?: InvokeArgs) => Promise<unknown>>();
const listenHandlers = new Map<string, (e: { payload?: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: InvokeArgs) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (e: { payload?: unknown }) => void) => {
    listenHandlers.set(event, cb);
    return Promise.resolve(() => listenHandlers.delete(event));
  },
}));

import NotificationWindow from "./NotificationWindow";
import type { NotificationCardData } from "./notificationTypes";

function cardData(overrides: Partial<NotificationCardData> = {}): NotificationCardData {
  return {
    id: "n1",
    kind: "agent_running",
    title: "Agent 正在执行",
    body: "codex · 整理本周项目报告",
    createdAt: new Date().toISOString(),
    sourceId: "codex",
    sessionId: "s1",
    refId: "run-1",
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  listenHandlers.clear();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_settings") {
      return Promise.resolve({ theme: "dark", visual_preset: "liquid-glass" });
    }
    if (cmd === "hide_notification_window" || cmd === "fit_notification_window") {
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function emitShow(cards: NotificationCardData[]) {
  const handler = listenHandlers.get("notification-show");
  expect(handler, "窗口必须订阅 notification-show").toBeDefined();
  handler!({ payload: cards });
}

describe("六状态渲染", () => {
  const cases: Array<[string, string, string]> = [
    ["agent_running", "Agent 正在执行", "agent_running"],
    ["agent_waiting", "Agent 等待你的操作", "agent_waiting"],
    ["agent_done", "Agent 本轮执行完成", "agent_done"],
    ["agent_failed", "Agent 执行失败", "agent_failed"],
    ["agent_disconnected", "Agent 连接中断", "agent_disconnected"],
    ["digest", "3 条状态更新已合并", "digest"],
  ];

  for (const [kind, title, state] of cases) {
    it(`渲染 ${kind} 模板`, async () => {
      render(<NotificationWindow />);
      emitShow([cardData({ kind, title })]);
      await waitFor(() => {
        expect(screen.getByText(title)).toBeTruthy();
      });
      const el = document.querySelector(`.ntf-card[data-state="${state}"]`);
      expect(el, `data-state=${state} 的卡片应存在`).toBeTruthy();
    });
  }
});

describe("真实数据边界", () => {
  it("执行中卡不伪造百分比（不确定进度，无数字标签）", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_running" })]);
    await waitFor(() => expect(screen.getByText("Agent 正在执行")).toBeTruthy());
    expect(document.querySelector(".ntf-progress-fill.indeterminate")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
  });

  it("断连卡必须显示「不代表任务执行失败」说明", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_disconnected", title: "Agent 连接中断" })]);
    await waitFor(() => expect(screen.getByText("Agent 连接中断")).toBeTruthy());
    expect(document.body.textContent).toContain("连接中断，不代表任务执行失败");
  });

  it("失败与断连卡没有伪造的重试/重连按钮", async () => {
    render(<NotificationWindow />);
    emitShow([
      cardData({ refId: "r1", kind: "agent_failed" }),
      cardData({ refId: "r2", kind: "agent_disconnected" }),
    ]);
    await waitFor(() => {
      expect(document.querySelectorAll(".ntf-card")).toHaveLength(2);
    });
    expect(screen.queryByText("重试")).toBeNull();
    expect(screen.queryByText("重新连接")).toBeNull();
  });
});

describe("重复事件与队列", () => {
  it("同一轮次新事件更新既有卡片，不重复创建", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ refId: "run-1", kind: "agent_running" })]);
    emitShow([cardData({ refId: "run-1", kind: "agent_waiting", id: "n2", title: "等待确认" })]);
    await waitFor(() => {
      const cards = document.querySelectorAll(".ntf-card");
      expect(cards).toHaveLength(1);
    });
    expect(screen.getByText("等待确认")).toBeTruthy();
    expect(screen.queryByText("Agent 正在执行")).toBeNull();
  });

  it("队列容量 3：第 4 条普通卡折叠为紫色摘要", async () => {
    render(<NotificationWindow />);
    for (let i = 1; i <= 4; i++) {
      emitShow([cardData({ refId: `r${i}`, kind: "agent_done", title: `完成 ${i}` })]);
    }
    await waitFor(() => {
      expect(document.querySelectorAll(".ntf-card:not(.digest)").length).toBeLessThanOrEqual(3);
    });
    const digest = document.querySelector('.ntf-card[data-state="digest"]');
    expect(digest).toBeTruthy();
  });
});

describe("动作分发", () => {
  it("查看详情：调用导航命令并关闭卡片", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_failed" })]);
    await waitFor(() => expect(screen.getByText("查看详情")).toBeTruthy());
    fireEvent.click(screen.getByText("查看详情"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("notification_navigate", { target: "agents" });
    });
  });

  it("等待卡「立即处理」携带来源与会话跳转 Agent 会话", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_waiting", title: "等待确认" })]);
    await waitFor(() => expect(screen.getByText("立即处理")).toBeTruthy());
    fireEvent.click(screen.getByText("立即处理"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_agent_session", {
        sourceId: "codex",
        sessionId: "s1",
      });
    });
  });

  it("等待卡「稍后提醒」回传完整卡片载荷并关闭", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_waiting", title: "等待确认" })]);
    await waitFor(() => expect(screen.getByText("稍后提醒")).toBeTruthy());
    fireEvent.click(screen.getByText("稍后提醒"));
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "notification_snooze");
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({ minutes: 10 });
      const payload = (call![1] as { card: Record<string, unknown> }).card;
      expect(payload).toMatchObject({ kind: "agent_waiting", sourceId: "codex", sessionId: "s1" });
    });
  });

  it("跳转失败给卡内 role=alert 反馈，不静默失败", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_settings" || cmd === "fit_notification_window") {
        return Promise.resolve(cmd === "get_settings" ? { theme: "dark", visual_preset: "" } : null);
      }
      if (cmd === "open_agent_session") return Promise.reject(new Error("会话已结束"));
      return Promise.resolve(null);
    });
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_waiting", title: "等待确认" })]);
    await waitFor(() => expect(screen.getByText("立即处理")).toBeTruthy());
    fireEvent.click(screen.getByText("立即处理"));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("跳转失败");
    });
  });
});

describe("窗口生命周期", () => {
  it("队列为空时请求隐藏窗口；主题快照落到 data-theme", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_done" })]);
    await waitFor(() => expect(document.querySelector(".ntf-card")).toBeTruthy());
    // 关闭唯一卡片 → 请求隐藏
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("hide_notification_window", undefined);
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.preset).toBe("liquid-glass");
  });
});
