import { act } from "react";
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
  cancelActionsRefresh,
  categoryCount,
  hasActionsFeedConsumer,
  scheduleActionsRefresh,
  shouldRefreshActions,
  useActionsStore,
} from "./useActionsStore";
import { useEdgeSnapStore } from "./useEdgeSnapStore";
import { useSettingsStore } from "./useSettingsStore";
import { useUiStore } from "./useUiStore";

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

  it("普通列表加载排队时不会被后续计数刷新降级为 countsOnly", async () => {
    let resolveFirst!: (f: ActionFeed) => void;
    feedMock.mockImplementationOnce(
      () => new Promise<ActionFeed>((r) => (resolveFirst = r)),
    );
    feedMock.mockResolvedValue(
      feedOf({
        items: [itemOf("run:2")],
        counts: countsOf({ failed: 1, intervention: 1 }),
      }),
    );

    // 计数刷新在途时，用户/确认流程要求一次正式的列表刷新，随后又来一次事件计数刷新
    const first = useActionsStore.getState().load({ silent: true, countsOnly: true });
    useActionsStore.getState().load();
    useActionsStore.getState().load({ silent: true, countsOnly: true });
    resolveFirst(feedOf({ counts: countsOf({ failed: 1, intervention: 1 }) }));
    await first;

    // 正式刷新必须保留下来，否则列表会停在旧数据上
    expect(feedMock).toHaveBeenCalledTimes(2);
    expect(useActionsStore.getState().feed?.items.map((i) => i.id)).toEqual(["run:2"]);
  });

  it("A→B→A 后 ack 成功：按原视图重新同步，不残留已处理条目", async () => {
    let calls = 0;
    feedMock.mockImplementation(() => {
      calls += 1;
      // 1 初次加载；2 切到「失败」；3 切回原视图（发出于 ack 完成前，含旧条目）；
      // 4 及以后 ack 之后重新同步，后端已不再返回该条目
      if (calls === 2) {
        return Promise.resolve(
          feedOf({ items: [itemOf("run:3", { kind: "failed" })], db_total: 1 }),
        );
      }
      if (calls <= 3) {
        return Promise.resolve(
          feedOf({
            items: [itemOf("run:1")],
            counts: countsOf({ failed: 1, intervention: 1 }),
          }),
        );
      }
      return Promise.resolve(
        feedOf({ items: [], counts: countsOf({ failed: 0, intervention: 0 }), db_total: 0 }),
      );
    });

    let resolveAck!: (n: number) => void;
    ackMock.mockImplementationOnce(() => new Promise<number>((r) => (resolveAck = r)));

    await useActionsStore.getState().load();
    expect(calls).toBe(1);
    expect(useActionsStore.getState().feed?.items.map((i) => i.id)).toEqual(["run:1"]);

    const ackP = useActionsStore.getState().ack(["run:1"]);
    // 请求在途：切到「失败」再切回原视图；切回后的查询先返回旧数据（仍含 run:1）
    useActionsStore.getState().setFilter({ kind: "failed" });
    useActionsStore.getState().setFilter({ kind: undefined });
    await vi.waitFor(() => expect(calls).toBe(3));
    await vi.waitFor(() =>
      expect(useActionsStore.getState().feed?.items.map((i) => i.id)).toEqual(["run:1"]),
    );

    // 后端此刻才真正处理完
    resolveAck(1);
    await ackP;

    await vi.waitFor(() =>
      expect(useActionsStore.getState().feed?.items).toEqual([]),
    );
    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(calls).toBe(4);
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

// ── 消费者门控（导航显隐与资源生命周期）────────────────────────────────
//
// feed 只有两个 UI 消费者：侧栏徽标（入口可见时渲染）与行动中心页面。
// App 的启动加载与事件聚合刷新以 shouldRefreshActions() 为门控；
// 恢复路径由 FullView / ActionCenterPanel 的可见性 effect 承担。

describe("useActionsStore 消费者门控", () => {
  it("默认设置（布局缺失→全可见）时有消费者", () => {
    expect(hasActionsFeedConsumer()).toBe(true);
    expect(shouldRefreshActions()).toBe(true);
  });

  it("入口隐藏且不在行动页：无消费者，事件不调度聚合刷新", () => {
    useSettingsStore.setState({
      settings: {
        navigation_layout: {
          version: 1,
          left: ["tasks"],
          capsule: ["tasks"],
          known: { left: ["tasks", "actions"], capsule: ["tasks", "actions"] },
        },
      },
    } as never);
    useUiStore.setState({ tab: "tasks" });
    expect(hasActionsFeedConsumer()).toBe(false);
    expect(shouldRefreshActions()).toBe(false);
  });

  it("入口隐藏但 tab=actions（隐藏页仍由「更多」进入）：仍有消费者", () => {
    useSettingsStore.setState({
      settings: {
        navigation_layout: {
          version: 1,
          left: ["tasks"],
          capsule: ["tasks"],
          known: { left: ["tasks", "actions"], capsule: ["tasks", "actions"] },
        },
      },
    } as never);
    useUiStore.setState({ tab: "actions" });
    expect(hasActionsFeedConsumer()).toBe(true);
  });

  it("主界面停靠胶囊期：即使入口可见也不算消费者（docked-full 除外）", () => {
    useSettingsStore.setState({ settings: null });
    useUiStore.setState({ tab: "tasks" });
    act(() => useEdgeSnapStore.setState({ phase: "docked-revealed" }));
    expect(hasActionsFeedConsumer()).toBe(false);
    expect(shouldRefreshActions()).toBe(false);
    act(() => useEdgeSnapStore.setState({ phase: "docked-full" }));
    expect(hasActionsFeedConsumer()).toBe(true);
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
  });

  it("行动中心开关关闭时，即使有消费者也不调度", () => {
    useSettingsStore.setState({
      settings: { actions_enabled: false },
    } as never);
    expect(shouldRefreshActions()).toBe(false);
    useSettingsStore.setState({ settings: null });
  });

  it("临时暂停：自动聚合停止，但手动 load 仍可查看历史", async () => {
    feedMock.mockResolvedValue(feedOf());
    useSettingsStore.setState({
      settings: { mode: "full", actions_enabled: true, actions_paused: true },
    } as never);
    useUiStore.setState({ tab: "actions" });
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
    expect(shouldRefreshActions()).toBe(false);

    // 手动刷新/打开页面不受暂停门控：历史与通知仍可读取。
    await useActionsStore.getState().load();
    expect(feedMock).toHaveBeenCalledTimes(1);
    useSettingsStore.setState({ settings: null });
    useUiStore.setState({ tab: "tasks" });
  });

  it("极简 / 紧凑模式：侧栏与行动页都不渲染，不算消费者（即使入口可见且 tab=actions）", () => {
    useUiStore.setState({ tab: "actions" });
    act(() => useEdgeSnapStore.setState({ phase: "free" }));
    for (const mode of ["compact", "minimal"] as const) {
      useSettingsStore.setState({ settings: { mode } } as never);
      expect(hasActionsFeedConsumer()).toBe(false);
      expect(shouldRefreshActions()).toBe(false);
    }
    // 回到完整模式：同一状态下消费者恢复
    useSettingsStore.setState({ settings: { mode: "full" } } as never);
    expect(hasActionsFeedConsumer()).toBe(true);
    useUiStore.setState({ tab: "tasks" });
    useSettingsStore.setState({ settings: null });
  });

  it("调度窗口内消费者消失：执行前重新验证，不发无消费者的聚合查询", async () => {
    vi.useFakeTimers();
    try {
      feedMock.mockResolvedValue(feedOf());
      useSettingsStore.setState({ settings: { mode: "full" } } as never);
      useUiStore.setState({ tab: "tasks" });
      act(() => useEdgeSnapStore.setState({ phase: "free" }));
      expect(shouldRefreshActions()).toBe(true);

      scheduleActionsRefresh();
      // 去抖窗口内切到紧凑模式：聚合结果已没有 UI 消费者
      useSettingsStore.setState({ settings: { mode: "compact" } } as never);
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(feedMock).not.toHaveBeenCalled();

      // 消费者恢复：由恢复路径（FullView / ActionCenterPanel）显式补一次刷新
      useSettingsStore.setState({ settings: { mode: "full" } } as never);
      await act(async () => {
        await useActionsStore.getState().load({ silent: true, countsOnly: true });
      });
      expect(feedMock).toHaveBeenCalledTimes(1);
    } finally {
      cancelActionsRefresh();
      vi.useRealTimers();
      useSettingsStore.setState({ settings: null });
      useUiStore.setState({ tab: "tasks" });
    }
  });
});
