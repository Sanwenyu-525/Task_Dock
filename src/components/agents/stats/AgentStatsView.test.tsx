/**
 * @vitest-environment jsdom
 */
//! Agent 工作时间统计视图（只读口径展示）：
//! 1. 打开即查一次，不轮询、不订阅；切换范围/来源/刷新才重查；
//! 2. 失败率没有可靠终态时显示「未知」，不退化成 0%；
//! 3. 没有任何事件明细时执行/等待/未知显示「未知」，不显示 0 分；
//! 4. 查询失败给出错误文案，刷新可重试；结构化错误按 code 本地化；
//! 5. 切换语言后文案与错误随之更新（消费 agentStats.* / agent.state.* 键）。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invokeCommand: vi.fn() }));

// 只替换 IPC 调用，保留真实的 normalizeError / AppError，让错误文案走真实本地化链路
vi.mock("../../../lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/errors")>();
  return { ...actual, invokeCommand: ipc.invokeCommand };
});
// 产品代码使用统一 Select（浮层 + aria-activedescendant）；测试里换成原生 select 以便直接触发筛选。
vi.mock("../../ui/Select", () => ({
  default: (props: {
    value: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    onChange: (value: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

import AgentStatsView from "./AgentStatsView";
import { __resetLocaleForTests, setLocalePreference } from "../../../i18n";
import type { WorkTimeStats } from "./api";

function stats(
  totalsPatch: Partial<WorkTimeStats["totals"]> = {},
  sourcePatch: Partial<WorkTimeStats["by_source"][number]> = {},
  sessionPatch: Partial<WorkTimeStats["sessions"][number]> = {},
): WorkTimeStats {
  return {
    generated_at: "2026-11-04T04:00:00+00:00",
    range: {
      from: "2026-10-29T00:00:00+00:00",
      to: "2026-11-04T04:00:00+00:00",
      origin: "real",
      source_id: null,
      bucket: "day",
      timezone_offset_minutes: 480,
    },
    coverage: {
      runs_in_range: 2,
      runs_analyzed: 2,
      run_limit: 5000,
      runs_truncated: false,
      events_loaded: 10,
      event_limit: 150000,
      events_truncated: false,
      sessions_total: 1,
      sessions_shown: 1,
    },
    totals: {
      runs: 2,
      runs_with_detail: 2,
      runs_without_detail: 0,
      completed: 1,
      failed: 1,
      interrupted: 0,
      unresolved: 0,
      unverified_terminal: 0,
      failure_rate: 0.5,
      span_sec: 3600,
      exec_sec: 1800,
      wait_sec: 600,
      idle_sec: 0,
      unknown_sec: 300,
      open_tail_sec: 0,
      estimated_runs: 0,
      window_attributed_runs: 0,
      ...totalsPatch,
    },
    by_source: [
      {
        source_id: "codex",
        display_name: "Codex",
        runs: 2,
        runs_without_detail: 0,
        completed: 1,
        failed: 1,
        unresolved: 0,
        failure_rate: 0.5,
        span_sec: 3600,
        exec_sec: 1800,
        wait_sec: 600,
        unknown_sec: 300,
        ...sourcePatch,
      },
    ],
    sessions: [
      {
        session_id: "s1",
        source_id: "codex",
        source_name: "Codex",
        external_id: "sess-1",
        title: "会话一",
        status: "running",
        last_seen_at: "2026-11-04T03:00:00+00:00",
        runs: 2,
        runs_without_detail: 0,
        completed: 1,
        failed: 1,
        unresolved: 0,
        span_sec: 3600,
        exec_sec: 1800,
        wait_sec: 600,
        open_tail_sec: 0,
        ...sessionPatch,
      },
    ],
    trend: [
      {
        bucket: "2026-11-04",
        start_at: "2026-11-04",
        runs: 2,
        completed: 1,
        failed: 1,
        exec_sec: 1800,
        wait_sec: 600,
        unknown_sec: 300,
      },
    ],
    quality: {
      missing_start_runs: 0,
      missing_end_runs: 0,
      stale_open_runs: 0,
      late_events: 0,
      unknown_timestamp_events: 0,
      coalesced_events: 0,
      unreliable_intervals: 0,
      gap_unknown_sec: 0,
      no_detail_runs: 0,
      window_attributed_runs: 0,
      unattributed_events: 0,
    },
    available_sources: [
      { id: "codex", display_name: "Codex", category: "real", hidden: false },
      { id: "mock", display_name: "Mock 模拟器", category: "mock", hidden: false },
    ],
    warnings: [],
  };
}

function card(label: string): HTMLElement {
  // 同一文案可能同时出现在卡片标签和来源表头：只取带 .astats-card 的那个
  const el = screen
    .getAllByText(label)
    .map((n) => n.closest(".astats-card"))
    .find((n): n is HTMLElement => n !== null);
  if (!el) throw new Error(`找不到卡片: ${label}`);
  return el;
}

function cardValue(label: string): string {
  const value = card(label).querySelector(".astats-card-value");
  return value?.textContent ?? "";
}

beforeEach(() => {
  ipc.invokeCommand.mockReset();
  __resetLocaleForTests();
});

afterEach(() => {
  cleanup();
  __resetLocaleForTests();
});

describe("AgentStatsView", () => {
  it("打开时只查询一次，默认只看真实来源", async () => {
    ipc.invokeCommand.mockResolvedValue(stats());
    render(<AgentStatsView />);
    await waitFor(() => expect(screen.getByText("执行时长")).toBeTruthy());
    expect(ipc.invokeCommand).toHaveBeenCalledTimes(1);
    const [command, args] = ipc.invokeCommand.mock.calls[0] as [
      string,
      { query: Record<string, unknown> },
    ];
    expect(command).toBe("agent_work_time_stats");
    expect(args.query.origin).toBe("real");
    expect(typeof args.query.timezone_offset_minutes).toBe("number");

    // 不轮询：等待一段时间后仍然只有一次查询
    await new Promise((r) => setTimeout(r, 30));
    expect(ipc.invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("没有可靠终态时失败率显示未知并提供分母说明", async () => {
    ipc.invokeCommand.mockResolvedValue(
      stats({ completed: 0, failed: 0, failure_rate: null, unverified_terminal: 2 }),
    );
    render(<AgentStatsView />);
    await waitFor(() => expect(screen.getAllByText("失败率").length).toBeGreaterThan(0));
    const failureCard = card("失败率");
    expect(cardValue("失败率")).toBe("未知");
    expect(within(failureCard).getByText("无可靠终态，无法计算")).toBeTruthy();
    expect(failureCard.textContent).not.toContain("0.0%");
  });

  it("没有任何事件明细时执行/等待/未知显示未知而不是 0 分", async () => {
    ipc.invokeCommand.mockResolvedValue(
      stats({
        runs_with_detail: 0,
        runs_without_detail: 2,
        exec_sec: 0,
        wait_sec: 0,
        unknown_sec: 0,
      }, { runs_without_detail: 2, exec_sec: 0, wait_sec: 0 }),
    );
    render(<AgentStatsView />);
    await waitFor(() => expect(screen.getByText("执行时长")).toBeTruthy());
    for (const label of ["执行时长", "等待时长", "未知 / 进行中"]) {
      expect(cardValue(label)).toBe("未知");
    }
    // 来源行同样不得把不可测量的时长显示成 0 分（第 2、3 列是执行/等待）
    const sourceRow = screen
      .getByText("Codex", { selector: ".astats-source-name" })
      .closest(".astats-source-row");
    const cells = Array.from(sourceRow?.querySelectorAll(":scope > span") ?? []);
    expect(cells[1]?.textContent).toBe("未知");
    expect(cells[2]?.textContent).toBe("未知");
    // 跨度来自轮次起止，与事件明细无关，仍应给出数值
    expect(cells[3]?.textContent).not.toBe("未知");
  });

  it("切换测试数据与来源会按新参数重查", async () => {
    ipc.invokeCommand.mockResolvedValue(stats());
    render(<AgentStatsView />);
    await waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("测试数据"));
    await waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledTimes(2));
    const second = ipc.invokeCommand.mock.calls[1] as [string, { query: Record<string, unknown> }];
    expect(second[1].query.origin).toBe("mock");
    expect(second[1].query.source_id).toBeNull();

    // 新结果的来源列表到达后才可选（mock 类别来源）
    await waitFor(() => expect(screen.getByRole("option", { name: "Mock 模拟器" })).toBeTruthy());
    const select = screen.getByLabelText("来源筛选") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "mock" } });
    await waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledTimes(3));
    const third = ipc.invokeCommand.mock.calls[2] as [string, { query: Record<string, unknown> }];
    expect(third[1].query.origin).toBe("mock");
    expect(third[1].query.source_id).toBe("mock");
  });

  it("查询失败给出错误文案，刷新可重试", async () => {
    ipc.invokeCommand.mockRejectedValueOnce(new Error("数据库忙"));
    ipc.invokeCommand.mockResolvedValue(stats());
    render(<AgentStatsView />);
    await waitFor(() => expect(screen.getByText(/查询失败：数据库忙/)).toBeTruthy());
    expect(screen.queryByText("执行时长")).toBeNull();

    fireEvent.click(screen.getByLabelText("刷新统计"));
    await waitFor(() => expect(screen.getByText("执行时长")).toBeTruthy());
    expect(screen.queryByText(/查询失败/)).toBeNull();
  });

  it("英文界面使用 agentStats.* 文案，未知仍显示 Unknown 而不是 0", async () => {
    ipc.invokeCommand.mockResolvedValue(
      stats({
        runs_with_detail: 0,
        runs_without_detail: 2,
        completed: 0,
        failed: 0,
        failure_rate: null,
        exec_sec: 0,
        wait_sec: 0,
        unknown_sec: 0,
      }),
    );
    act(() => {
      setLocalePreference("en-US");
    });
    render(<AgentStatsView />);
    await waitFor(() => expect(screen.getByText("Execution time")).toBeTruthy());

    expect(screen.getByText("Work time stats")).toBeTruthy();
    expect(screen.getByLabelText("Refresh stats")).toBeTruthy();
    expect(screen.getByText("Last 7 days")).toBeTruthy();
    expect(screen.getByText("Real data")).toBeTruthy();
    expect(screen.getByText("Test data")).toBeTruthy();
    // 未知 ≠ 0：英文界面同样显示 Unknown，不显示 0 min
    expect(cardValue("Execution time")).toBe("Unknown");
    expect(cardValue("Wait time")).toBe("Unknown");
    expect(cardValue("Failure rate")).toBe("Unknown");
    expect(screen.getByText("No reliable endings; cannot compute")).toBeTruthy();
    // 会话状态复用 agent.state.*，不显示后端原始枚举
    await waitFor(() => expect(screen.getByText(/· Running · last/)).toBeTruthy());
  });

  it("结构化错误按 code 本地化，切换语言后错误文案随之更新", async () => {
    ipc.invokeCommand.mockRejectedValueOnce({
      code: "DATABASE_BUSY",
      message: "db busy",
      category: "database",
      severity: "error",
      retryable: true,
    });
    ipc.invokeCommand.mockResolvedValue(stats());
    render(<AgentStatsView />);
    await waitFor(() =>
      expect(screen.getByText("查询失败：数据库正忙，请稍后重试")).toBeTruthy(),
    );

    act(() => {
      setLocalePreference("en-US");
    });
    expect(
      screen.getByText("Query failed: The database is busy. Try again shortly."),
    ).toBeTruthy();
  });
});
