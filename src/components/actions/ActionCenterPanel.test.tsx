/**
 * @vitest-environment jsdom
 */
//! 行动中心：需介入 / 通知 / 历史三层展示，计数与筛选/分页相互独立。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";

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
  ActionFilter,
  ActionItem,
} from "../../lib/bridge";
import { useActionsStore } from "../../store/useActionsStore";
import { useUiStore } from "../../store/useUiStore";

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
  it("首屏只展示 3 个计数，总量/已加载下沉到列表脚注", () => {
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
    expect(screen.queryByText(/需关注/)).toBeNull();
    expect(screen.getByText("需介入 2")).toBeTruthy();
    expect(screen.getByText("通知 3")).toBeTruthy();
    expect(screen.getByText("历史 12")).toBeTruthy();
    expect(screen.queryByText(/当前筛选 \d/)).toBeNull();
    expect(screen.getByText("共 2 条 · 已加载 2 条")).toBeTruthy();
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

describe("ActionCenterPanel 已处理退出反馈", () => {
  it("默认筛选下标记已处理：先提交 ack，真成功后才离场，行随后退出待处理列表", async () => {
    useActionsStore.setState({
      feed: feedOf({
        items: [itemOf("run:1")],
        counts: countsOf({ intervention: 1 }),
      }),
    });
    // 确认后的静默刷新里该行已不在待处理列表（初始 feed 由 setState 预置，不走请求）
    feedMock.mockResolvedValue(feedOf({ items: [], counts: countsOf({ intervention: 1 }) }));
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));

    // 动画不挡在后端前面：点击即 ack，结果未知时不进入离场
    expect(vi.mocked(actionsAck)).toHaveBeenCalledWith(["run:1"]);
    expect(container.querySelector(".action-item.leaving")).toBeNull();

    resolveAck(1);
    // 真成功后才收拢淡出；此时列表刷新已经把它移除，但快照仍在 DOM 中演完离场
    await waitFor(() => expect(container.querySelector(".action-item.leaving")).toBeTruthy());
    await waitFor(() => expect(container.querySelector(".action-item")).toBeNull());
    expect(useUiStore.getState().toast?.message).toContain("退出待处理列表");
  });

  it("后端返回 0（已经被处理过）：不播成功离场、不演首次成功", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockResolvedValue(feedOf({ items: [] }));
    const { actionsAck } = await import("../../lib/bridge");
    vi.mocked(actionsAck).mockResolvedValue(0);
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("info"));
    expect(useUiStore.getState().toast?.message).toContain("已经是已处理");
    expect(container.querySelector(".action-item.leaving")).toBeNull();
  });

  it("离场期间后台整表刷新：快照不被提前卸载，也不重复插入", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    // ack 触发的刷新返回空表；之后的后台刷新返回另一条
    feedMock.mockResolvedValueOnce(feedOf({ items: [] }));
    feedMock.mockResolvedValue(
      feedOf({ items: [itemOf("run:2", { title: "另一个失败" })], counts: countsOf({ intervention: 1 }) }),
    );
    const { actionsAck } = await import("../../lib/bridge");
    vi.mocked(actionsAck).mockResolvedValue(1);
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    await waitFor(() => expect(container.querySelector(".action-item.leaving")).toBeTruthy());

    // 后台整表刷新替换了 feed：离场快照必须继续可见，且只出现一次
    act(() => {
      useActionsStore.setState({
        feed: feedOf({ items: [itemOf("run:2", { title: "另一个失败" })], counts: countsOf({ intervention: 1 }) }),
      });
    });
    const leavingRows = container.querySelectorAll(".action-item.leaving");
    expect(leavingRows).toHaveLength(1);
    expect(leavingRows[0].textContent).toContain("构建失败");
    expect(screen.getByText("另一个失败")).toBeTruthy();

    await waitFor(() => expect(container.querySelector(".action-item.leaving")).toBeNull());
    expect(screen.getByText("另一个失败")).toBeTruthy();
  });

  it("已处理筛选下标记已处理：行不退出列表，只翻状态，不播离场", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
      filter: { category: "intervention", include_acked: true, limit: 40 },
    });
    feedMock.mockResolvedValue(feedOf({ items: [itemOf("run:1", { acked: true })] }));
    const { actionsAck } = await import("../../lib/bridge");
    vi.mocked(actionsAck).mockResolvedValue(1);
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));

    await waitFor(() => expect(vi.mocked(actionsAck)).toHaveBeenCalledWith(["run:1"]));
    await waitFor(() => expect(container.querySelector(".action-item.acked")).toBeTruthy());
    expect(container.querySelector(".action-item.leaving")).toBeNull();
    expect(container.querySelector(".action-item")).not.toBeNull();
  });

  it("历史分类标记已处理：该行仍留在历史列表，不播退出动画", async () => {
    useActionsStore.setState({
      feed: feedOf({
        category: "history",
        items: [itemOf("run:1", { category: "history", kind: "failed" })],
      }),
      filter: { category: "history", include_acked: false, limit: 40 },
    });
    feedMock.mockResolvedValue(
      feedOf({
        category: "history",
        items: [itemOf("run:1", { category: "history", kind: "failed", acked: true })],
      }),
    );
    const { actionsAck } = await import("../../lib/bridge");
    vi.mocked(actionsAck).mockResolvedValue(1);
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));

    await waitFor(() => expect(container.querySelector(".action-item.acked")).toBeTruthy());
    expect(container.querySelector(".action-item.leaving")).toBeNull();
  });

  it("点击后立即切分类：旧请求返回时新列表已加载，不把旧条目插进新视图", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockImplementation(async (f: ActionFilter = {}) =>
      feedOf({
        category: f.category ?? "intervention",
        items:
          (f.category ?? "intervention") === "notification"
            ? [itemOf("run:9", { category: "notification", kind: "reminder", title: "新通知" })]
            : [],
      }),
    );
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    fireEvent.click(screen.getByRole("button", { name: /通知/ }));
    await waitFor(() => expect(useActionsStore.getState().feed?.category).toBe("notification"));
    expect(screen.getByText("新通知")).toBeTruthy();

    // 旧请求此刻才返回：后端已生效，但当前视图不是它发起时的那一个
    await act(async () => {
      resolveAck(1);
      await Promise.resolve();
    });

    expect(screen.queryByText("构建失败")).toBeNull();
    expect(container.querySelector(".action-item.leaving")).toBeNull();
    expect(useActionsStore.getState().feed?.category).toBe("notification");
    // 切筛选已经触发过一次加载；旧请求不得再刷新一次
    expect(feedMock).toHaveBeenCalledTimes(1);
  });

  it("未完成时切优先级：旧请求返回不污染新筛选", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockResolvedValue(feedOf({ items: [] }));
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    act(() => useActionsStore.getState().setFilter({ priority: 0 }));
    await waitFor(() => expect(feedMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveAck(1);
      await Promise.resolve();
    });

    expect(screen.queryByText("构建失败")).toBeNull();
    expect(container.querySelector(".action-item.leaving")).toBeNull();
    expect(useActionsStore.getState().filter.priority).toBe(0);
  });

  it("未完成时切来源：旧请求返回不污染新筛选", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockResolvedValue(feedOf({ items: [] }));
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    act(() => useActionsStore.getState().setFilter({ source_id: "other" }));
    await waitFor(() => expect(feedMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveAck(1);
      await Promise.resolve();
    });

    expect(screen.queryByText("构建失败")).toBeNull();
    expect(container.querySelector(".action-item.leaving")).toBeNull();
    expect(useActionsStore.getState().filter.source_id).toBe("other");
  });

  it("未完成时切任务：旧请求返回不污染新筛选", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockResolvedValue(feedOf({ items: [] }));
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    act(() => useActionsStore.getState().setFilter({ task_id: "task-x" }));
    await waitFor(() => expect(feedMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveAck(1);
      await Promise.resolve();
    });

    expect(screen.queryByText("构建失败")).toBeNull();
    expect(container.querySelector(".action-item.leaving")).toBeNull();
    expect(useActionsStore.getState().filter.task_id).toBe("task-x");
  });

  it("连续快速切换分类：只认最后一次视图，旧请求不演出、不插入", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockImplementation(async (f: ActionFilter = {}) => feedOf({ category: f.category ?? "intervention", items: [] }));
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    fireEvent.click(screen.getByRole("button", { name: /通知/ }));
    fireEvent.click(screen.getByRole("button", { name: /历史/ }));
    await waitFor(() => expect(useActionsStore.getState().feed?.category).toBe("history"));

    await act(async () => {
      resolveAck(1);
      await Promise.resolve();
    });

    expect(useActionsStore.getState().feed?.category).toBe("history");
    expect(screen.queryByText("构建失败")).toBeNull();
    expect(container.querySelector(".action-item.leaving")).toBeNull();
  });

  it("旧请求完成时新筛选已加载：不替换已加载列表，也不多刷一次", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockImplementation(async (f: ActionFilter = {}) =>
      feedOf({ category: f.category ?? "intervention", items: [itemOf("run:9", { title: "新列表条目" })] }),
    );
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    fireEvent.click(screen.getByRole("button", { name: /通知/ }));
    await waitFor(() => expect(screen.getByText("新列表条目")).toBeTruthy());
    const loaded = useActionsStore.getState().feed;

    await act(async () => {
      resolveAck(1);
      await Promise.resolve();
    });

    // 新筛选的列表保持引用不变：旧请求没有触发第二次整表加载
    expect(useActionsStore.getState().feed).toBe(loaded);
    expect(feedMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("构建失败")).toBeNull();
  });

  it("切回原筛选以后端真实数据为准，不复活旧条目", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    // 后端已处理：原筛选再查时该条目不再返回
    feedMock.mockImplementation(async (f: ActionFilter = {}) => feedOf({ category: f.category ?? "intervention", items: [] }));
    const { actionsAck } = await import("../../lib/bridge");
    let resolveAck: (n: number) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((res) => {
        resolveAck = res;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    fireEvent.click(screen.getByRole("button", { name: /通知/ }));
    await waitFor(() => expect(useActionsStore.getState().feed?.category).toBe("notification"));
    await act(async () => {
      resolveAck(1);
      await Promise.resolve();
    });
    // 通知视图不该出现旧筛选的条目与离场快照
    expect(screen.queryByText("构建失败")).toBeNull();
    expect(container.querySelector(".action-item.leaving")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /需介入/ }));
    await waitFor(() => expect(useActionsStore.getState().feed?.category).toBe("intervention"));
    expect(screen.queryByText("构建失败")).toBeNull();
    expect(container.querySelector(".action-item.leaving")).toBeNull();
  });

  it("切换后旧请求失败：不安插离场快照，错误如实提示", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    feedMock.mockResolvedValue(feedOf({ items: [] }));
    const { actionsAck } = await import("../../lib/bridge");
    let rejectAck: (e: Error) => void = () => {};
    vi.mocked(actionsAck).mockReturnValue(
      new Promise<number>((_res, rej) => {
        rejectAck = rej;
      }),
    );
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));
    act(() => useActionsStore.getState().setFilter({ priority: 1 }));
    await waitFor(() => expect(feedMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      rejectAck(new Error("db locked"));
      await Promise.resolve();
    });

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("error"));
    expect(container.querySelector(".action-item.leaving")).toBeNull();
    expect(screen.queryByText("构建失败")).toBeNull();
  });

  it("确认失败：离场状态撤掉，行弹回原位并提示错误", async () => {
    useActionsStore.setState({
      feed: feedOf({ items: [itemOf("run:1")], counts: countsOf({ intervention: 1 }) }),
    });
    const { actionsAck } = await import("../../lib/bridge");
    vi.mocked(actionsAck).mockRejectedValue(new Error("db locked"));
    const { container } = render(<ActionCenterPanel />);
    await screen.findByText("构建失败");

    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("error"));
    const row = container.querySelector<HTMLElement>(".action-item")!;
    expect(row.classList.contains("leaving")).toBe(false);
    expect(row.textContent).toContain("构建失败");
  });
});
