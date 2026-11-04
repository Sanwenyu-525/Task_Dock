/**
 * @vitest-environment jsdom
 */
//! 统计子视图组件测试：数据渲染、空库 null 口径、范围切换、图表开关、读取失败重试。
//! 只 mock IPC 封装，组件内部的请求代际 / 状态流转走真实实现。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { setLocalePreference, translate } from "../../../i18n";
import type { TaskAnalytics } from "./api";
import TaskAnalyticsPanel from "./TaskAnalyticsPanel";

const { fetchTaskAnalytics } = vi.hoisted(() => ({ fetchTaskAnalytics: vi.fn() }));

vi.mock("./api", () => ({ fetchTaskAnalytics }));

const definitions = {
  completed: "完成数量：范围内真实发生的完成动作。",
  completion_rate: "完成率 = 已完成 / 本期到期任务数（分母含未到期）。",
  overdue_rate: "逾期率 = 逾期 / 本期到期任务数。",
  trend: "趋势按本地日历分桶。",
  distribution: "分类按完成时快照统计。",
  history: "升级前重复任务的历史期次无法还原。",
};

function fixture(overrides: Partial<TaskAnalytics> = {}): TaskAnalytics {
  return {
    range: "day",
    range_label: "今日",
    range_start: "2026-11-04",
    range_end: "2026-11-05",
    generated_at: "2026-11-04T02:30:00Z",
    summary: {
      completed: 2,
      recurring_completed: 1,
      due: 3,
      due_completed: 2,
      due_overdue: 1,
      completion_rate: 2 / 3,
      overdue_rate: 1 / 3,
    },
    trend: [
      {
        key: "2026-11-03",
        label: "11-03",
        start: "2026-11-02T16:00:00Z",
        end: "2026-11-03T16:00:00Z",
        completed: 1,
        due: 2,
        due_completed: 1,
        due_overdue: 1,
        completion_rate: 0.5,
        overdue_rate: 0.5,
      },
      {
        key: "2026-11-04",
        label: "11-04",
        start: "2026-11-03T16:00:00Z",
        end: "2026-11-04T16:00:00Z",
        completed: 2,
        due: 3,
        due_completed: 2,
        due_overdue: 1,
        completion_rate: 2 / 3,
        overdue_rate: 1 / 3,
      },
    ],
    by_category: [
      { category: "工作", completed: 1, share: 0.5 },
      { category: "未分类", completed: 1, share: 0.5 },
    ],
    by_priority: [
      { priority: 0, completed: 0, share: 0 },
      { priority: 1, completed: 1, share: 0.5 },
      { priority: 2, completed: 1, share: 0.5 },
      { priority: 3, completed: 0, share: 0 },
    ],
    definitions,
    ...overrides,
  };
}

function emptyFixture(): TaskAnalytics {
  return fixture({
    summary: {
      completed: 0,
      recurring_completed: 0,
      due: 0,
      due_completed: 0,
      due_overdue: 0,
      completion_rate: null,
      overdue_rate: null,
    },
    trend: fixture().trend.map((p) => ({
      ...p,
      completed: 0,
      due: 0,
      due_completed: 0,
      due_overdue: 0,
      completion_rate: null,
      overdue_rate: null,
    })),
    by_category: [],
    by_priority: fixture().by_priority.map((p) => ({ ...p, completed: 0, share: 0 })),
  });
}

async function renderPanel() {
  render(<TaskAnalyticsPanel />);
  await screen.findByText("今日完成");
}

describe("TaskAnalyticsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchTaskAnalytics.mockReset();
    fetchTaskAnalytics.mockResolvedValue(fixture());
  });

  afterEach(() => {
    cleanup();
  });

  it("渲染完成 / 到期 / 完成率 / 逾期率与分布", async () => {
    await renderPanel();

    expect(screen.getByText("今日完成")).toBeTruthy();
    expect(screen.getByText("本期到期")).toBeTruthy();
    expect(screen.getByText("完成率")).toBeTruthy();
    expect(screen.getByText("逾期率")).toBeTruthy();
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByText("33%")).toBeTruthy();
    expect(screen.getByText("其中重复任务 1 次")).toBeTruthy();
    expect(screen.getByText("工作")).toBeTruthy();
    expect(screen.getByText("P2 中")).toBeTruthy();
    // 口径说明改为词典文案：后端返回的中文字符串不再直接展示。
    expect(screen.getByText("指标口径")).toBeTruthy();
    expect(screen.queryByText(definitions.completion_rate)).toBeNull();
    expect(screen.getByText(translate("zh-CN", "taskAnalytics.definitions.completionRate"))).toBeTruthy();
  });

  it("空库时比率显示 — 而不是 0%，并给出空分布提示", async () => {
    fetchTaskAnalytics.mockResolvedValue(emptyFixture());
    render(<TaskAnalyticsPanel />);
    await screen.findByText("今日完成");
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("本期暂无完成记录")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("切换范围会重新查询并展示新口径标签", async () => {
    fetchTaskAnalytics.mockResolvedValueOnce(fixture()).mockResolvedValueOnce(
      fixture({ range: "week", range_label: "本周" }),
    );
    await renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "周" }));
    await screen.findByText("本周完成");
    expect(fetchTaskAnalytics).toHaveBeenLastCalledWith("week");
  });

  it("切换范围后，旧范围的晚到响应不会覆盖新范围", async () => {
    let resolveDay: (value: TaskAnalytics) => void = () => {};
    fetchTaskAnalytics
      .mockImplementationOnce(
        () =>
          new Promise<TaskAnalytics>((resolve) => {
            resolveDay = resolve;
          }),
      )
      .mockResolvedValueOnce(fixture({ range: "week", range_label: "本周" }));

    render(<TaskAnalyticsPanel />);
    await userEvent.click(screen.getByRole("button", { name: "周" }));
    await screen.findByText("本周完成");

    await act(async () => {
      resolveDay(fixture({ range: "day", range_label: "今日" }));
      await Promise.resolve();
    });

    expect(screen.queryByText("今日完成")).toBeNull();
    expect(screen.getByText("本周完成")).toBeTruthy();
  });

  it("图表开关会隐藏图表并持久化", async () => {
    await renderPanel();
    const chart = screen.getByRole("img", { name: /完成与逾期趋势/ });
    expect(chart).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "关闭图表" }));
    expect(screen.queryByRole("img", { name: /完成与逾期趋势/ })).toBeNull();
    // 图表开关只控制趋势图；分类 / 优先级分布不属于图表，关闭后仍应可见。
    expect(screen.getByText("分类分布")).toBeTruthy();
    expect(screen.getByText("优先级分布")).toBeTruthy();
    expect(localStorage.getItem("task-analytics:charts-visible")).toBe("0");

    await userEvent.click(screen.getByRole("button", { name: "显示图表" }));
    expect(screen.getByRole("img", { name: /完成与逾期趋势/ })).toBeTruthy();
  });

  it("读取失败时展示错误并可重试", async () => {
    fetchTaskAnalytics.mockRejectedValueOnce(new Error("统计服务不可用")).mockResolvedValueOnce(fixture());
    render(<TaskAnalyticsPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("统计读取失败");
    expect(alert.textContent).toContain("统计服务不可用");

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetchTaskAnalytics).toHaveBeenCalledTimes(2));
    await screen.findByText("今日完成");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("切换语言后，卡片 / 分布 / 口径与未分类标签跟随词典", async () => {
    setLocalePreference("en-US");
    try {
      render(<TaskAnalyticsPanel />);
      await screen.findByText("Today completed");
      expect(screen.getByText("Due this period")).toBeTruthy();
      expect(screen.getByText("Completion rate")).toBeTruthy();
      expect(screen.getByText("Overdue rate")).toBeTruthy();
      expect(screen.getByText("Category distribution")).toBeTruthy();
      expect(screen.getByText("Priority distribution")).toBeTruthy();
      expect(screen.getByText("P2 Medium")).toBeTruthy();
      expect(screen.getByText("Uncategorized")).toBeTruthy();
      expect(screen.getByText("Metric definitions")).toBeTruthy();
      expect(screen.getByText(translate("en-US", "taskAnalytics.definitions.completionRate"))).toBeTruthy();
      // 后端中文文案与未分类字面量不再泄漏到英文界面。
      expect(screen.queryByText("今日完成")).toBeNull();
      expect(screen.queryByText("未分类")).toBeNull();
    } finally {
      setLocalePreference("zh-CN");
    }
  });
});
