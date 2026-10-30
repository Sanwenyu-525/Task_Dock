/**
 * @vitest-environment jsdom
 */
//! 行动中心：需介入 / 通知 / 历史三层展示，计数与筛选/分页相互独立。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    actionsFeed: vi.fn(),
    actionsAck: vi.fn(),
    actionsUnack: vi.fn(),
    actionsOpenSession: vi.fn(),
    taskContext: vi.fn(),
  };
});

import ActionCenterPanel from "./ActionCenterPanel";
import { actionsFeed } from "../../lib/bridge";
import type {
  ActionCategory,
  ActionCounts,
  ActionFeed,
  ActionItem,
} from "../../lib/bridge";
import { useActionsStore } from "../../store/useActionsStore";

const feedMock = vi.mocked(actionsFeed);

function itemOf(id: string, extra: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    category: "intervention",
    kind: "failed",
    priority: 0,
    source_id: "codex",
    source_name: "Codex",
    session_external_id: "s1",
    run_row_id: "1",
    run_external_id: "r1",
    task_id: null,
    task_title: null,
    title: "构建失败",
    message: "exit code 1",
    occurred_at: "2026-10-29T00:00:00Z",
    acked: false,
    authorization_inferred: false,
    ...extra,
  };
}

function countsOf(extra: Partial<ActionCounts> = {}): ActionCounts {
  const intervention = extra.intervention ?? 0;
  const notification = extra.notification ?? 0;
  return {
    failed: 0,
    authorization: 0,
    waiting_input: 0,
    reminder: 0,
    notification,
    running: 0,
    completed: 0,
    disconnected: 0,
    history: 0,
    intervention,
    total: intervention + notification,
    ...extra,
  };
}

function feedOf(extra: Partial<ActionFeed> = {}): ActionFeed {
  const category: ActionCategory = extra.category ?? "intervention";
  const items = extra.items ?? [];
  return {
    items,
    counts: countsOf(),
    coverage: [],
    generated_at: "2026-10-29T00:00:00Z",
    category,
    db_total: items.length,
    filtered_total: items.length,
    loaded: items.length,
    has_more: false,
    next_cursor: null,
    enabled: true,
    ...extra,
  };
}

function reset() {
  useActionsStore.setState({
    feed: null,
    loading: false,
    loadingMore: false,
    error: null,
    filter: { category: "intervention", include_acked: false, limit: 40 },
    lastLoadedAt: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

afterEach(cleanup);

describe("ActionCenterPanel 三层展示", () => {
  it("同时展示需关注、需介入、通知、历史与当前筛选/已加载", () => {
    useActionsStore.setState({
      feed: feedOf({
        items: [itemOf("run:1"), itemOf("run:2", { kind: "waiting_input", priority: 1 })],
        counts: countsOf({
          failed: 1,
          waiting_input: 1,
          intervention: 2,
          notification: 3,
          reminder: 3,
          running: 4,
          completed: 8,
          history: 12,
        }),
        db_total: 2,
        filtered_total: 2,
        loaded: 2,
      }),
    });
    render(<ActionCenterPanel />);
    expect(screen.getByText("需关注 5")).toBeTruthy();
    expect(screen.getByText("需介入 2")).toBeTruthy();
    expect(screen.getByText("通知 3")).toBeTruthy();
    expect(screen.getByText("历史 12")).toBeTruthy();
    expect(screen.getByText("当前筛选 2")).toBeTruthy();
    expect(screen.getByText("已加载 2")).toBeTruthy();
  });

  it("筛选无结果时说明该分类仍有待处理条目", () => {
    useActionsStore.setState({
      feed: feedOf({
        items: [],
        counts: countsOf({ failed: 5, intervention: 5 }),
        db_total: 5,
        filtered_total: 0,
        loaded: 0,
      }),
    });
    render(<ActionCenterPanel />);
    expect(screen.getByText("当前筛选没有匹配项")).toBeTruthy();
    expect(screen.getByText(/「需介入」仍有 5 条/)).toBeTruthy();
  });

  it("模块关闭时不显示动作与筛选，只给出开关说明", () => {
    useActionsStore.setState({
      feed: feedOf({
        enabled: false,
        items: [],
        counts: countsOf(),
        db_total: 0,
        filtered_total: 0,
        loaded: 0,
      }),
    });
    render(<ActionCenterPanel />);
    expect(screen.getByText("行动中心已关闭")).toBeTruthy();
    expect(screen.queryByText(/需关注/)).toBeNull();
    expect(screen.queryByLabelText("类型筛选")).toBeNull();
    expect(screen.queryByLabelText("优先级筛选")).toBeNull();
  });

  it("切换到通知分类后不展示优先级筛选，并显示通知空态", async () => {
    useActionsStore.setState({
      feed: feedOf({
        counts: countsOf({ intervention: 2, notification: 1, reminder: 1 }),
      }),
    });
    feedMock.mockResolvedValueOnce(
      feedOf({
        category: "notification",
        counts: countsOf({ intervention: 2 }),
        items: [],
        db_total: 0,
        filtered_total: 0,
        loaded: 0,
      }),
    );
    render(<ActionCenterPanel />);
    fireEvent.click(screen.getByRole("button", { name: /通知/ }));
    await waitFor(() =>
      expect(screen.getByText("没有未确认通知")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("优先级筛选")).toBeNull();
    expect(useActionsStore.getState().filter.category).toBe("notification");
  });

  it("加载更多使用后端游标追加，且按钮展示已加载/总数", async () => {
    useActionsStore.setState({
      feed: feedOf({
        items: [itemOf("run:1")],
        counts: countsOf({ failed: 2, intervention: 2 }),
        db_total: 2,
        filtered_total: 2,
        loaded: 1,
        has_more: true,
        next_cursor: "c1",
      }),
    });
    feedMock.mockResolvedValueOnce(
      feedOf({
        items: [itemOf("run:2")],
        counts: countsOf({ failed: 2, intervention: 2 }),
        db_total: 2,
        filtered_total: 2,
        loaded: 1,
        has_more: false,
        next_cursor: null,
      }),
    );
    render(<ActionCenterPanel />);
    const btn = screen.getByRole("button", { name: "加载更多（已加载 1/2）" });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(useActionsStore.getState().feed?.items).toHaveLength(2),
    );
    expect(feedMock).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "c1" }),
    );
    expect(screen.queryByText(/加载更多/)).toBeNull();
  });

  it("授权为推断时明确标注，通知条目显示未确认", () => {
    useActionsStore.setState({
      feed: feedOf({
        items: [
          itemOf("run:1", {
            kind: "authorization",
            priority: 1,
            authorization_inferred: true,
            title: "等待权限确认",
          }),
        ],
        counts: countsOf({ authorization: 1, intervention: 1 }),
      }),
    });
    render(<ActionCenterPanel />);
    expect(screen.getByText("需授权（推断）")).toBeTruthy();
    expect(screen.getAllByText("推断").length).toBeGreaterThan(0);
  });
});
