/**
 * @vitest-environment jsdom
 */
//! 历史面板：全局未读、筛选/分页口径、刷新空隙与订阅生命周期。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  notificationPage: vi.fn(),
  notificationInboxStats: vi.fn(),
  listAgentEvents: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  clearNotifications: vi.fn(),
  onNotification: vi.fn(),
  onAgentChanged: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import HistoryPanel from "./HistoryPanel";
import type { AgentEventPage, AgentEventRow, NotificationPage, NotificationRow } from "../../lib/bridge";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function notif(id: string, createdAt = "2026-10-29T10:00:00Z", unread = true): NotificationRow {
  return {
    id,
    kind: "reminder",
    title: `提醒 ${id}`,
    body: "",
    ref_type: "task",
    ref_id: `task-${id}`,
    occurrence: null,
    is_read: !unread,
    created_at: createdAt,
  };
}

function event(id: string, receivedAt = "2026-10-29T10:00:00Z"): AgentEventRow {
  return {
    id,
    source_id: "codex",
    session_external_id: "s1",
    run_external_id: "r1",
    event_type: "status",
    state: "failed",
    message: `事件 ${id}`,
    received_at: receivedAt,
  };
}

function notificationPageOf(items: NotificationRow[], extra: Partial<NotificationPage> = {}): NotificationPage {
  return { items, has_more: false, filtered_total: items.length, ...extra };
}

function eventPageOf(items: AgentEventRow[], extra: Partial<AgentEventPage> = {}): AgentEventPage {
  return { items, has_more: false, filtered_total: items.length, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.notificationPage.mockResolvedValue(notificationPageOf([]));
  bridge.listAgentEvents.mockResolvedValue(eventPageOf([]));
  bridge.notificationInboxStats.mockResolvedValue({ unread: 0, total: 0 });
  bridge.onNotification.mockResolvedValue(() => {});
  bridge.onAgentChanged.mockResolvedValue(() => {});
  bridge.markNotificationRead.mockResolvedValue(undefined);
  bridge.markAllNotificationsRead.mockResolvedValue(undefined);
  bridge.clearNotifications.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("HistoryPanel 订阅生命周期", () => {
  it("卸载后才兑现的监听 Promise 会被立即反订阅", async () => {
    const notification = deferred<() => void>();
    const agent = deferred<() => void>();
    bridge.onNotification.mockReturnValue(notification.promise);
    bridge.onAgentChanged.mockReturnValue(agent.promise);

    const { unmount } = render(<HistoryPanel />);
    await waitFor(() => expect(bridge.onNotification).toHaveBeenCalled());
    unmount();

    const offNotification = vi.fn();
    const offAgent = vi.fn();
    notification.resolve(offNotification);
    agent.resolve(offAgent);
    await notification.promise;
    await agent.promise;
    await Promise.resolve();

    expect(offNotification).toHaveBeenCalledTimes(1);
    expect(offAgent).toHaveBeenCalledTimes(1);
  });

  it("挂载期间建立的监听在卸载时释放", async () => {
    const offNotification = vi.fn();
    const offAgent = vi.fn();
    bridge.onNotification.mockResolvedValue(offNotification);
    bridge.onAgentChanged.mockResolvedValue(offAgent);

    const { unmount } = render(<HistoryPanel />);
    await waitFor(() => expect(bridge.onAgentChanged).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    unmount();

    expect(offNotification).toHaveBeenCalledTimes(1);
    expect(offAgent).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryPanel 全局未读与筛选", () => {
  it("未读数来自全库统计，不受首页 100 条限制", async () => {
    bridge.notificationPage.mockResolvedValue(
      notificationPageOf([notif("n1")], { has_more: true, filtered_total: 2000 }),
    );
    bridge.notificationInboxStats.mockResolvedValue({ unread: 1200, total: 2000 });
    render(<HistoryPanel />);
    expect(await screen.findByText("1200 条未读 / 共 2000")).toBeTruthy();
    expect(bridge.notificationInboxStats).toHaveBeenCalled();
  });

  it("时间筛选从第一页重新查询，并把 since 传给两条数据流", async () => {
    render(<HistoryPanel />);
    await waitFor(() => expect(bridge.listAgentEvents).toHaveBeenCalled());
    bridge.notificationPage.mockResolvedValue(notificationPageOf([], { filtered_total: 0 }));
    bridge.listAgentEvents.mockResolvedValue(eventPageOf([], { filtered_total: 0 }));

    fireEvent.click(screen.getByRole("button", { name: "近 3 天" }));
    await waitFor(() => {
      const calls = bridge.listAgentEvents.mock.calls;
      const last = calls[calls.length - 1];
      expect(last[1].since).toBeTruthy();
      expect(last[1].before).toBeUndefined();
    });
    const lastNotification = bridge.notificationPage.mock.calls.at(-1)?.[0];
    expect(lastNotification?.since).toBeTruthy();
    expect(lastNotification?.before).toBeUndefined();
  });

  it("清空通知后 Agent 事件仍在时间轴中", async () => {
    bridge.notificationPage.mockResolvedValue(notificationPageOf([notif("n1")]));
    bridge.listAgentEvents.mockResolvedValue(eventPageOf([event("e1")]));
    render(<HistoryPanel />);
    await screen.findByText("提醒 n1");
    expect(screen.getByText("事件 e1")).toBeTruthy();

    // 第一次点击进入确认，第二次才真正清空
    fireEvent.click(screen.getByRole("button", { name: /清空/ }));
    bridge.notificationPage.mockResolvedValue(notificationPageOf([]));
    fireEvent.click(screen.getByRole("button", { name: /确认清空/ }));

    await waitFor(() => expect(bridge.clearNotifications).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("提醒 n1")).toBeNull());
    expect(screen.getByText("事件 e1")).toBeTruthy();
  });
});

describe("HistoryPanel 分页与刷新空隙", () => {
  it("加载更早事件使用最旧 ID 作游标并展示已加载/总数", async () => {
    bridge.listAgentEvents
      .mockResolvedValueOnce(
        eventPageOf(
          [
            { ...event("e-new", "2026-10-29T10:02:00Z"), source_id: "codex" },
            { ...event("e-old", "2026-10-29T10:01:00Z"), source_id: "qoder" },
          ],
          { has_more: true, filtered_total: 250 },
        ),
      )
      .mockResolvedValueOnce(
        eventPageOf(
          [{ ...event("e-older", "2026-10-29T10:00:00Z"), source_id: "trae" }],
          { has_more: false, filtered_total: 250 },
        ),
      );
    render(<HistoryPanel />);
    const more = await screen.findByRole("button", {
      name: "加载更早的 Agent 事件（已加载 2/250）",
    });
    fireEvent.click(more);
    await screen.findByText("事件 e-older");
    expect(bridge.listAgentEvents).toHaveBeenLastCalledWith(
      100,
      expect.objectContaining({ before: "e-old" }),
    );
    expect(screen.queryByText(/加载更早的 Agent 事件/)).toBeNull();
    expect(screen.getByText("事件 e-new")).toBeTruthy();
  });

  it("刷新页与已加载页不重叠时提示刷新，不合并出带缺口的时间轴", async () => {
    bridge.listAgentEvents
      .mockResolvedValueOnce(eventPageOf([event("e1")], { filtered_total: 1 }))
      .mockResolvedValue(eventPageOf([event("e3")], { filtered_total: 2 }));
    const holder: { cb?: (p: { changed?: boolean }) => void } = {};
    bridge.onAgentChanged.mockImplementation((cb: (p: { changed?: boolean }) => void) => {
      holder.cb = cb;
      return Promise.resolve(() => {});
    });
    render(<HistoryPanel />);
    await screen.findByText("事件 e1");

    holder.cb?.({ changed: true });
    expect(await screen.findByText(/当前列表与最新数据之间还有未加载的空隙/)).toBeTruthy();
    // 旧页仍保留，不会被不连续的“最新页”替换
    expect(screen.getByText("事件 e1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "刷新到最新" }));
    await screen.findByText("事件 e3");
    expect(screen.queryByText("事件 e1")).toBeNull();
    expect(screen.queryByText(/未加载的空隙/)).toBeNull();
  });

  it("首屏为空后到达的新事件会重新启用「加载更早」", async () => {
    bridge.listAgentEvents
      .mockResolvedValueOnce(eventPageOf([], { has_more: false, filtered_total: 0 }))
      .mockResolvedValue(
        eventPageOf([event("e-new", "2026-10-29T10:05:00Z")], {
          has_more: true,
          filtered_total: 250,
        }),
      );
    const holder: { cb?: (p: { changed?: boolean }) => void } = {};
    bridge.onAgentChanged.mockImplementation((cb: (p: { changed?: boolean }) => void) => {
      holder.cb = cb;
      return Promise.resolve(() => {});
    });
    render(<HistoryPanel />);
    await screen.findByText("暂无历史记录");

    holder.cb?.({ changed: true });
    await screen.findByText("事件 e-new");
    const more = await screen.findByRole("button", {
      name: "加载更早的 Agent 事件（已加载 1/250）",
    });
    expect(more).toBeTruthy();
  });
});
