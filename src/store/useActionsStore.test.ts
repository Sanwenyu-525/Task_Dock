import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  actionsFeed: vi.fn(),
  actionsAck: vi.fn(),
  actionsUnack: vi.fn(),
  actionsOpenSession: vi.fn(),
}));

import { actionsAck, actionsFeed, actionsUnack } from "../lib/bridge";
import type {
  ActionCategory,
  ActionCounts,
  ActionFeed,
  ActionItem,
} from "../lib/bridge";
import {
  attentionCount,
  categoryCount,
  useActionsStore,
} from "./useActionsStore";

const feedMock = vi.mocked(actionsFeed);
const ackMock = vi.mocked(actionsAck);
const unackMock = vi.mocked(actionsUnack);

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

describe("useActionsStore 计数语义", () => {
  it("徽标只取需介入 + 通知，不含运行/完成历史", async () => {
    feedMock.mockResolvedValueOnce(
      feedOf({
        counts: countsOf({
          failed: 1,
          authorization: 1,
          waiting_input: 0,
          reminder: 1,
          notification: 1,
          intervention: 2,
          running: 9,
          completed: 4,
          history: 14,
        }),
        db_total: 2,
      }),
    );
    await useActionsStore.getState().load();
    const feed = useActionsStore.getState().feed;
    expect(attentionCount(feed)).toBe(3);
    expect(categoryCount(feed, "intervention")).toBe(2);
    expect(categoryCount(feed, "notification")).toBe(1);
    expect(categoryCount(feed, "history")).toBe(14);
  });

  it("确认使用稳定 ID，刷新后徽标减少", async () => {
    feedMock
      .mockResolvedValueOnce(
        feedOf({
          items: [itemOf("run:1"), itemOf("run:2")],
          counts: countsOf({ failed: 2, intervention: 2 }),
        }),
      )
      .mockResolvedValueOnce(
        feedOf({ counts: countsOf({ failed: 1, intervention: 1 }) }),
      );
    ackMock.mockResolvedValueOnce(2);
    await useActionsStore.getState().load();
    expect(attentionCount(useActionsStore.getState().feed)).toBe(2);

    await useActionsStore.getState().ack(["run:1", "run:2"]);
    expect(ackMock).toHaveBeenCalledWith(["run:1", "run:2"]);
    expect(feedMock).toHaveBeenCalledTimes(2);
    expect(attentionCount(useActionsStore.getState().feed)).toBe(1);
  });

  it("恢复已确认动作时同样刷新计数", async () => {
    feedMock
      .mockResolvedValueOnce(
        feedOf({ counts: countsOf({ reminder: 1, notification: 1 }) }),
      )
      .mockResolvedValueOnce(
        feedOf({ counts: countsOf({ reminder: 2, notification: 2 }) }),
      );
    unackMock.mockResolvedValueOnce(1);
    await useActionsStore.getState().load();
    await useActionsStore.getState().unack(["notification:7"]);
    expect(unackMock).toHaveBeenCalledWith(["notification:7"]);
    expect(attentionCount(useActionsStore.getState().feed)).toBe(2);
  });

  it("切换筛选只改变当前筛选数，全局计数不变", async () => {
    const counts = countsOf({ failed: 2, intervention: 2, history: 1, running: 1 });
    feedMock
      .mockResolvedValueOnce(feedOf({ counts, filtered_total: 2 }))
      .mockResolvedValueOnce(feedOf({ counts, filtered_total: 1 }));
    await useActionsStore.getState().load();
    useActionsStore.getState().setFilter({ kind: "failed" });
    await vi.waitFor(() =>
      expect(useActionsStore.getState().feed?.filtered_total).toBe(1),
    );

    const state = useActionsStore.getState();
    expect(state.filter.kind).toBe("failed");
    expect(state.feed?.counts.total).toBe(2);
    expect(attentionCount(state.feed)).toBe(2);
  });

  it("模块关闭时计数为零且不显示动作", async () => {
    feedMock.mockResolvedValueOnce(
      feedOf({ enabled: false, counts: countsOf(), items: [] }),
    );
    await useActionsStore.getState().load();
    const feed = useActionsStore.getState().feed;
    expect(feed?.enabled).toBe(false);
    expect(feed?.items).toEqual([]);
    expect(attentionCount(feed)).toBe(0);
  });

  it("并发刷新合并为单飞，不产生重复请求洪峰", async () => {
    let resolve!: (f: ActionFeed) => void;
    feedMock.mockImplementationOnce(
      () => new Promise<ActionFeed>((r) => (resolve = r)),
    );
    feedMock.mockResolvedValue(
      feedOf({ counts: countsOf({ failed: 1, intervention: 1 }) }),
    );
    const first = useActionsStore.getState().load();
    const second = useActionsStore.getState().load();
    resolve(feedOf({ counts: countsOf({ failed: 1, intervention: 1 }) }));
    await Promise.all([first, second]);
    expect(feedMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(attentionCount(useActionsStore.getState().feed)).toBe(1);
  });
});

describe("useActionsStore 分页与后台刷新", () => {
  it("加载更多按稳定 ID 去重追加，不替换已加载页", async () => {
    feedMock
      .mockResolvedValueOnce(
        feedOf({
          items: [itemOf("run:1"), itemOf("run:2")],
          counts: countsOf({ failed: 3, intervention: 3 }),
          db_total: 3,
          filtered_total: 3,
          loaded: 2,
          has_more: true,
          next_cursor: "c1",
        }),
      )
      .mockResolvedValueOnce(
        feedOf({
          items: [itemOf("run:2"), itemOf("run:3")],
          counts: countsOf({ failed: 3, intervention: 3 }),
          db_total: 3,
          filtered_total: 3,
          loaded: 2,
          has_more: false,
          next_cursor: null,
        }),
      );
    await useActionsStore.getState().load();
    await useActionsStore.getState().loadMore();

    const feed = useActionsStore.getState().feed;
    expect(feedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "c1", category: "intervention" }),
    );
    expect(feed?.items.map((i) => i.id)).toEqual(["run:1", "run:2", "run:3"]);
    expect(feed?.loaded).toBe(3);
    expect(feed?.has_more).toBe(false);
  });

  it("后台计数刷新不覆盖已加载的列表与分页状态", async () => {
    feedMock
      .mockResolvedValueOnce(
        feedOf({
          items: [itemOf("run:1"), itemOf("run:2")],
          counts: countsOf({ failed: 2, intervention: 2 }),
          db_total: 2,
          filtered_total: 8,
          loaded: 2,
          has_more: true,
          next_cursor: "c1",
        }),
      )
      .mockResolvedValueOnce(
        feedOf({
          items: [],
          counts: countsOf({ failed: 3, intervention: 3 }),
          db_total: 3,
          filtered_total: 9,
          loaded: 0,
          has_more: false,
          next_cursor: null,
        }),
      );
    await useActionsStore.getState().load();
    await useActionsStore.getState().load({ silent: true, countsOnly: true });

    const feed = useActionsStore.getState().feed;
    expect(feed?.items.map((i) => i.id)).toEqual(["run:1", "run:2"]);
    expect(feed?.counts.total).toBe(3);
    expect(feed?.has_more).toBe(true);
    expect(feed?.next_cursor).toBe("c1");
  });

  it("分类切换期间的旧分类计数刷新被丢弃", async () => {
    useActionsStore.setState({
      feed: feedOf({ category: "intervention", counts: countsOf({ intervention: 2 }) }),
    });
    feedMock.mockResolvedValueOnce(
      feedOf({ category: "history", counts: countsOf({ history: 5, intervention: 2 }) }),
    );
    await useActionsStore.getState().load({ silent: true, countsOnly: true });
    expect(useActionsStore.getState().feed?.counts.history).toBe(0);
  });

  it("筛选在加载更多期间变化时放弃追加旧页", async () => {
    feedMock.mockResolvedValueOnce(
      feedOf({
        items: [itemOf("run:1")],
        counts: countsOf({ failed: 1, intervention: 1 }),
        db_total: 1,
        filtered_total: 2,
        loaded: 1,
        has_more: true,
        next_cursor: "c1",
      }),
    );
    await useActionsStore.getState().load();

    let resolvePage!: (f: ActionFeed) => void;
    feedMock.mockImplementationOnce(
      () => new Promise<ActionFeed>((r) => (resolvePage = r)),
    );
    const more = useActionsStore.getState().loadMore();
    useActionsStore.setState({ filter: { ...useActionsStore.getState().filter, kind: "failed" } });
    resolvePage(
      feedOf({
        items: [itemOf("run:9")],
        counts: countsOf({ failed: 2, intervention: 2 }),
        db_total: 2,
        filtered_total: 2,
        loaded: 1,
        has_more: false,
        next_cursor: null,
      }),
    );
    await more;

    const feed = useActionsStore.getState().feed;
    expect(feed?.items.map((i) => i.id)).toEqual(["run:1"]);
    expect(useActionsStore.getState().loadingMore).toBe(false);
  });

  it("加载更多期间列表被整体刷新替换时放弃旧游标页", async () => {
    feedMock.mockResolvedValueOnce(
      feedOf({
        items: [itemOf("run:1")],
        counts: countsOf({ failed: 1, intervention: 1 }),
        db_total: 2,
        filtered_total: 2,
        loaded: 1,
        has_more: true,
        next_cursor: "c1",
      }),
    );
    await useActionsStore.getState().load();

    let resolvePage!: (f: ActionFeed) => void;
    feedMock.mockImplementationOnce(
      () => new Promise<ActionFeed>((r) => (resolvePage = r)),
    );
    const more = useActionsStore.getState().loadMore();

    // 分页请求未返回时，一次确认/事件刷新把列表整体替换成新首屏
    feedMock.mockResolvedValueOnce(
      feedOf({
        items: [itemOf("run:2")],
        counts: countsOf({ failed: 1, intervention: 1 }),
        db_total: 1,
        filtered_total: 1,
        loaded: 1,
        has_more: false,
        next_cursor: null,
      }),
    );
    await useActionsStore.getState().load({ silent: true });

    resolvePage(
      feedOf({
        items: [itemOf("run:9")],
        counts: countsOf({ failed: 1, intervention: 1 }),
        db_total: 1,
        filtered_total: 1,
        loaded: 1,
        has_more: false,
        next_cursor: null,
      }),
    );
    await more;

    const feed = useActionsStore.getState().feed;
    expect(feed?.items.map((i) => i.id)).toEqual(["run:2"]);
    expect(useActionsStore.getState().loadingMore).toBe(false);
  });
});
