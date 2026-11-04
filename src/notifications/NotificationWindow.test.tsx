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
  it("查看详情：携带可靠对象 ID 调用导航命令并关闭卡片", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_failed" })]);
    await waitFor(() => expect(screen.getByText("查看失败详情")).toBeTruthy());
    fireEvent.click(screen.getByText("查看失败详情"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "notification_navigate",
        expect.objectContaining({
          target: "agents",
          sourceId: "codex",
          sessionId: "s1",
          refId: "run-1",
        }),
      );
    });
  });

  it("缺少会话信息时退化为打开 Agent 页面，按钮文案准确", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_done", sourceId: undefined, sessionId: undefined })]);
    await waitFor(() => expect(screen.getByText("打开 Agent 面板")).toBeTruthy());
    fireEvent.click(screen.getByText("打开 Agent 面板"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "notification_navigate",
        expect.objectContaining({ target: "agents", sourceId: null, sessionId: null }),
      );
    });
  });

  it("等待卡「立即处理」携带来源与会话定位 Agent 轮次", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_waiting", title: "等待确认" })]);
    await waitFor(() => expect(screen.getByText("立即处理")).toBeTruthy());
    fireEvent.click(screen.getByText("立即处理"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "notification_navigate",
        expect.objectContaining({
          target: "agents",
          sourceId: "codex",
          sessionId: "s1",
          refId: "run-1",
        }),
      );
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

  it("跳转失败给卡内 role=alert 反馈，不静默失败且保留卡片", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_settings" || cmd === "fit_notification_window") {
        return Promise.resolve(cmd === "get_settings" ? { theme: "dark", visual_preset: "" } : null);
      }
      if (cmd === "notification_navigate") return Promise.reject(new Error("会话已结束"));
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
    // 导航失败不关闭卡片
    expect(document.querySelector(".ntf-card")).toBeTruthy();
  });

  it("导航结果 located=false 时保留通知并展示原因", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_settings") return Promise.resolve({ theme: "dark", visual_preset: "" });
      if (cmd === "notification_navigate") {
        return Promise.resolve({ tab: "agents", located: false, reason: "本地无此会话记录" });
      }
      return Promise.resolve(null);
    });
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_failed" })]);
    await waitFor(() => expect(screen.getByText("查看失败详情")).toBeTruthy());
    fireEvent.click(screen.getByText("查看失败详情"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("本地无此会话记录");
    });
    expect(document.querySelector(".ntf-card")).toBeTruthy();
  });
});

describe("窗口生命周期", () => {
  it("订阅建立后声明 UI 就绪，避免窗口显示了却没人消费事件", async () => {
    render(<NotificationWindow />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("notification_ui_ready", undefined);
    });
  });

  it("完成卡无补充信息时不显示无意义的「展开详情」", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_done", body: "codex · 已生成报告" })]);
    await waitFor(() => expect(document.querySelector(".ntf-card")).toBeTruthy());
    expect(screen.queryByText("展开详情")).toBeNull();
  });

  it("失败卡正文较长时提供就地展开，完整错误走详情", async () => {
    render(<NotificationWindow />);
    const body = "codex · 编译失败：\n" + "详细日志".repeat(20);
    emitShow([cardData({ kind: "agent_failed", body })]);
    await waitFor(() => expect(screen.getByText("展开详情")).toBeTruthy());
  });

  it("启动快照读取失败后，下一轮展示前补取设置并按快照渲染", async () => {
    let attempts = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_settings") {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("IPC 未就绪"))
          : Promise.resolve({ theme: "light", visual_preset: "frosted" });
      }
      return Promise.resolve(null);
    });
    render(<NotificationWindow />);
    await waitFor(() => expect(attempts).toBe(1));
    // 首次读取失败后快照缺失：展示事件到达时必须再取一次，不能永久按系统明暗渲染
    emitShow([cardData({ kind: "agent_done", title: "Agent 本轮执行完成" })]);
    await waitFor(() => expect(document.documentElement.dataset.preset).toBe("frosted"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(attempts).toBe(2);
  });

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

describe("窗口高度上报（裁切回归）", () => {
  const fitCalls = () =>
    invokeMock.mock.calls
      .filter(([cmd]) => cmd === "fit_notification_window")
      .map(([, args]) => args as { height: number });

  const realGcs = window.getComputedStyle.bind(window);

  beforeEach(() => {
    // jsdom 没有布局：固定栈内容高度（含栈自身 padding 的 scrollHeight），
    // 并把根容器计算样式归零，模拟真实测量链路 scrollHeight + rootPadding + 2。
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 203,
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      if ((el as HTMLElement).classList?.contains("ntf-root")) {
        return { paddingTop: "0px", paddingBottom: "0px" } as unknown as CSSStyleDeclaration;
      }
      return realGcs(el);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  it("首帧同步上报完整内容高度，窗口不需要等异步动画回调才长高", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_failed", title: "Agent 执行失败" })]);
    await waitFor(() => expect(document.querySelector(".ntf-card")).toBeTruthy());
    await waitFor(() => expect(fitCalls().length).toBeGreaterThan(0));
    // 203（含 padding）+ 0（根容器）+ 2（分数 DPI 容差）
    expect(fitCalls()[0]).toEqual({ height: 205 });
  });

  it("同一轮展示内高度未变化时不重复上报（展开/收起、RO 与字体回调共用去重）", async () => {
    render(<NotificationWindow />);
    const body = "codex · 编译失败：\n" + "详细日志".repeat(20);
    emitShow([cardData({ kind: "agent_failed", title: "Agent 执行失败", body })]);
    await waitFor(() => expect(fitCalls().length).toBe(1));
    fireEvent.click(screen.getByText("展开详情"));
    await waitFor(() => expect(screen.getByText("收起详情")).toBeTruthy());
    // 本轮内测量高度未变：不得因为重渲染/观察器回调再报一次
    expect(fitCalls()).toEqual([{ height: 205 }]);
  });

  it("新的一轮展示必须重新上报（后端不可见时已重置高度缓存）", async () => {
    render(<NotificationWindow />);
    const card = cardData({ kind: "agent_failed", title: "Agent 执行失败" });
    emitShow([card]);
    await waitFor(() => expect(fitCalls().length).toBe(1));
    emitShow([{ ...card, id: "n2", refId: "run-2" }]);
    await waitFor(() => expect(fitCalls().length).toBe(2));
    expect(fitCalls()[1]).toEqual({ height: 205 });
  });

  it("卡片离场期间不上报塌缩高度，窗口不会先缩到最小再隐藏", async () => {
    render(<NotificationWindow />);
    emitShow([cardData({ kind: "agent_failed", title: "Agent 执行失败" })]);
    await waitFor(() => expect(fitCalls().length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    await waitFor(() => expect(document.querySelector(".ntf-slot.leaving")).toBeTruthy());
    // 离场 150ms 内槽位从 1fr 收到 0fr：此时测量会得到塌缩高度，必须跳过
    expect(fitCalls()).toEqual([{ height: 205 }]);
  });
});
