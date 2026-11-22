// @vitest-environment jsdom
//! 效率微件数据源一致性测试（B1）。
//!
//! 覆盖：首次加载、新建/完成/删除/编辑/重复推进失效、连续变化合并、在途乱序、
//! IPC 失败与重试、关闭/再次打开、页面卸载、StrictMode 双挂载、多订阅者。
//! 只 mock 统计 IPC；任务 stats 走真实 `useTasksStore`，断言与权威来源一致。

import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskStats } from "../../lib/bridge";
import { __resetLocaleForTests } from "../../i18n";
import { useTasksStore } from "../../store/useTasksStore";
import { useWidgetSource } from "./useWidgetSource";
import { EfficiencyWidget } from "./DependencyWidgets";
import type { TaskAnalytics } from "../tasks/analytics/api";

const { fetchTaskAnalytics } = vi.hoisted(() => ({ fetchTaskAnalytics: vi.fn() }));

vi.mock("../tasks/analytics/api", () => ({ fetchTaskAnalytics }));

import {
  WIDGET_SOURCES,
  __resetEfficiencySourceForTests,
} from "./liveSources";

const DEFINITIONS: TaskAnalytics["definitions"] = {
  completed: "完成数量",
  completion_rate: "完成率口径",
  overdue_rate: "逾期率口径",
  trend: "趋势口径",
  distribution: "分布口径",
  history: "历史口径",
};

function analytics(overrides: {
  completed?: number;
  due?: number;
  overdue?: number;
  rate?: number | null;
} = {}): TaskAnalytics {
  const completed = overrides.completed ?? 2;
  const due = overrides.due ?? 4;
  const overdue = overrides.overdue ?? 1;
  return {
    range: "day",
    range_label: "今日",
    range_start: "2026-11-04",
    range_end: "2026-11-05",
    generated_at: "2026-11-04T02:30:00+00:00",
    summary: {
      completed,
      recurring_completed: 0,
      due,
      due_completed: completed,
      due_overdue: overdue,
      completion_rate: overrides.rate === undefined ? completed / due : overrides.rate,
      overdue_rate: due > 0 ? overdue / due : null,
    },
    trend: [],
    by_category: [],
    by_priority: [],
    definitions: DEFINITIONS,
    history_complete: true,
  };
}

function stats(pending: number): TaskStats {
  return {
    pending,
    overdue: 0,
    due_today: 0,
    completed_today: 0,
    next_due_at: null,
  };
}

/** 用新对象模拟一次任务写入后的 `loadStats()`（引用变化是失效信号）。 */
function setStats(pending: number) {
  useTasksStore.setState({ stats: stats(pending) });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function source() {
  const value = WIDGET_SOURCES.efficiency;
  if (!value) throw new Error("efficiency source 未装配");
  return value;
}

async function openEfficiency() {
  const target = source();
  const onChange = vi.fn();
  const unsubscribe = target.subscribe(onChange);
  await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(target.getSnapshot()).not.toBeNull());
  return { target, onChange, unsubscribe };
}

/** 等待 debounce 窗口过去，用于断言「没有发生额外查询」。 */
function waitForDebounce() {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

function Probe() {
  const snapshot = useWidgetSource(WIDGET_SOURCES.efficiency);
  return <span data-testid="probe">{snapshot ? snapshot.completedToday : "waiting"}</span>;
}

beforeEach(() => {
  __resetEfficiencySourceForTests();
  __resetLocaleForTests();
  fetchTaskAnalytics.mockReset();
  fetchTaskAnalytics.mockResolvedValue(analytics());
  useTasksStore.setState({ stats: stats(3), statsError: null });
});

afterEach(() => {
  cleanup();
});

describe("效率微件数据源", () => {
  it("无订阅者不查询；首次订阅查询一次并映射权威数值", async () => {
    expect(fetchTaskAnalytics).not.toHaveBeenCalled();

    const { target, onChange } = await openEfficiency();

    expect(fetchTaskAnalytics).toHaveBeenCalledTimes(1);
    expect(fetchTaskAnalytics).toHaveBeenCalledWith("day");
    expect(target.getSnapshot()).toEqual({
      completedToday: 2,
      dueToday: 4,
      overdue: 1,
      pending: 3,
      completionRate: 50,
    });
    expect(onChange).toHaveBeenCalled();
    // useSyncExternalStore 依赖稳定引用：未发布新快照前必须是同一对象。
    expect(target.getSnapshot()).toBe(target.getSnapshot());
  });

  it("新建/完成/删除/编辑/重复推进都通过 stats 引用变化触发重查", async () => {
    const { target } = await openEfficiency();
    fetchTaskAnalytics.mockResolvedValue(
      analytics({ completed: 7, due: 9, overdue: 2, rate: 7 / 9 }),
    );

    // 五种写入最终都走 refresh → loadStats，产生新的 stats 对象；
    // 数据源不区分动作类型，只认引用变化。
    const pendings = [2, 4, 3, 5, 1];
    for (let i = 0; i < pendings.length; i += 1) {
      setStats(pendings[i]);
      await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(2 + i));
      await waitFor(() => {
        const snapshot = target.getSnapshot();
        expect(snapshot?.pending).toBe(pendings[i]);
        expect(snapshot?.completedToday).toBe(7);
        expect(snapshot?.dueToday).toBe(9);
        expect(snapshot?.overdue).toBe(2);
      });
    }
  });

  it("连续快速修改合并为一次查询，最终以最后一次 stats 为准", async () => {
    await openEfficiency();
    fetchTaskAnalytics.mockResolvedValue(analytics({ completed: 4, due: 6, overdue: 1 }));

    setStats(4);
    setStats(5);
    setStats(6);
    await waitForDebounce();

    expect(fetchTaskAnalytics).toHaveBeenCalledTimes(2);
    expect(source().getSnapshot()?.pending).toBe(6);
    expect(source().getSnapshot()?.completedToday).toBe(4);
  });

  it("查询在途时再次变化：旧响应不覆盖缓存，结束后自动补查", async () => {
    const { target } = await openEfficiency();
    const second = deferred<TaskAnalytics>();
    fetchTaskAnalytics.mockImplementationOnce(() => second.promise);

    setStats(5);
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(2));

    const third = deferred<TaskAnalytics>();
    fetchTaskAnalytics.mockImplementationOnce(() => third.promise);

    // 第二次查询在途时又有新变化：第二次的响应已经过期。
    setStats(6);
    second.resolve(analytics({ completed: 50, due: 60, overdue: 10 }));
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(3));
    // 旧响应不得写入：完成/到期仍是第一次成功的数据，pending 用最新 stats。
    expect(target.getSnapshot()?.completedToday).toBe(2);
    expect(target.getSnapshot()?.dueToday).toBe(4);
    expect(target.getSnapshot()?.pending).toBe(6);

    third.resolve(analytics({ completed: 9, due: 12, overdue: 3, rate: 0.75 }));
    await waitFor(() => expect(target.getSnapshot()?.completedToday).toBe(9));
    expect(target.getSnapshot()?.completionRate).toBe(75);
  });

  it("查询失败保留旧数据并标记 stale，重试成功后清除", async () => {
    const { target } = await openEfficiency();
    fetchTaskAnalytics.mockRejectedValueOnce(new Error("统计服务不可用"));

    setStats(7);
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(target.getSnapshot()?.stale).toBe(true));
    // 失败不清零、不伪造：旧统计仍在，pending 用最新 stats。
    expect(target.getSnapshot()).toMatchObject({
      completedToday: 2,
      dueToday: 4,
      overdue: 1,
      pending: 7,
      stale: true,
    });

    fetchTaskAnalytics.mockResolvedValueOnce(
      analytics({ completed: 8, due: 10, overdue: 2, rate: 0.8 }),
    );
    act(() => target.retry?.());

    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(target.getSnapshot()?.completedToday).toBe(8));
    expect(target.getSnapshot()?.stale).toBeUndefined();
  });

  it("从未成功时保持等待接入，不把未知当成 0", async () => {
    fetchTaskAnalytics.mockRejectedValue(new Error("still down"));
    const target = source();
    const unsubscribe = target.subscribe(() => {});

    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(1));
    await waitForDebounce();
    expect(target.getSnapshot()).toBeNull();

    unsubscribe();
  });

  it("从未成功时微件显示等待接入而不是 0 值", async () => {
    fetchTaskAnalytics.mockRejectedValue(new Error("still down"));
    render(<EfficiencyWidget source={source()} />);

    await screen.findByText("等待统计模块数据…");
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("数据可能已过期")).toBeNull();
  });

  it("全部订阅释放后取消待执行刷新与监听，再次打开时按缓存有效性重查", async () => {
    const { target, unsubscribe } = await openEfficiency();

    // 关闭时还有一次待执行刷新：必须被取消，不能在无订阅者时继续 IPC。
    setStats(9);
    unsubscribe();
    await waitForDebounce();
    expect(fetchTaskAnalytics).toHaveBeenCalledTimes(1);

    // 关闭期间任务数据变化（stats 引用已不同）：重新打开必须重查。
    setStats(10);
    fetchTaskAnalytics.mockResolvedValue(analytics({ completed: 6, due: 8, overdue: 2 }));
    const reopen = target.subscribe(() => {});
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(target.getSnapshot()?.pending).toBe(10));
    await waitFor(() => expect(target.getSnapshot()?.completedToday).toBe(6));

    // 监听已重新挂上：再次写入仍会刷新。
    setStats(11);
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(3));
    reopen();
  });

  it("StrictMode 双挂载共享同一在途请求，卸载后不再刷新", async () => {
    fetchTaskAnalytics.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(analytics()), 20)),
    );

    const { unmount } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("2"));
    expect(fetchTaskAnalytics).toHaveBeenCalledTimes(1);

    unmount();
    setStats(8);
    await waitForDebounce();
    expect(fetchTaskAnalytics).toHaveBeenCalledTimes(1);
  });

  it("多个订阅者共享同一请求与失效信号，最后一个释放后停止查询", async () => {
    const target = source();
    const a = target.subscribe(() => {});
    const b = target.subscribe(() => {});
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(1));

    setStats(5);
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(2));

    a();
    setStats(6);
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(3));

    b();
    setStats(7);
    await waitForDebounce();
    expect(fetchTaskAnalytics).toHaveBeenCalledTimes(3);
  });

  it("失败态微件保留旧数字、显示过期提示并可重试", async () => {
    fetchTaskAnalytics.mockResolvedValueOnce(analytics());
    fetchTaskAnalytics.mockRejectedValueOnce(new Error("boom"));
    fetchTaskAnalytics.mockResolvedValueOnce(
      analytics({ completed: 8, due: 10, overdue: 2, rate: 0.8 }),
    );

    render(<EfficiencyWidget source={source()} />);
    await screen.findByText("50%");
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);

    act(() => setStats(3));
    await screen.findByText("数据可能已过期");
    expect(screen.getByText("50%")).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "重试" }).click();
    });
    await screen.findByText("80%");
    expect(screen.queryByText("数据可能已过期")).toBeNull();
  });
});
