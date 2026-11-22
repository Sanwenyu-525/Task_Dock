// @vitest-environment jsdom
//! 专注工作台 i18n 消费测试：
//! - 全部可见文案来自 `focus.*` 键（中文 / 英文两套目录）；
//! - 暂停原因保持真实语义（app_restart / unconfirmed_gap / manual）；
//! - 历史行、时长与任务删除标记按当前语言组合；
//! - 运行时切换语言后同一实例重新渲染。
//!
//! 断言使用两套目录中的真实文案（不 mock `t`），键名错误会由 TypeScript 拦截。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("../../lib/bridge", () => ({
  listTasks: vi.fn(async () => []),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../../lib/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/errors")>();
  return { ...actual, invokeCommand: vi.fn() };
});

import { invokeCommand } from "../../lib/errors";
import { getMissingKeys, resetMissingKeys, setLocalePreference } from "../../i18n";
import {
  resetFocusEventsForTest,
  useFocusStore,
  type FocusHistoryItem,
  type FocusPrefs,
  type FocusSessionView,
  type FocusSnapshot,
} from "../../store/useFocusStore";
import FocusWorkspace from "./FocusWorkspace";

const invoke = invokeCommand as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

const PREFS: FocusPrefs = {
  focus_minutes: 25,
  short_break_minutes: 5,
  long_break_minutes: 15,
  long_break_every: 4,
  auto_start_break: false,
  auto_start_next: false,
  sedentary_enabled: true,
  sedentary_interval_minutes: 60,
};

function session(overrides: Partial<FocusSessionView> = {}): FocusSessionView {
  return {
    id: "s1",
    kind: "focus",
    state: "paused",
    task_id: "task-1",
    task_title: "整理需求",
    task_deleted: false,
    planned_seconds: 1500,
    extension_seconds: 0,
    accumulated_ms: 60_000,
    remaining_ms: 1_440_000,
    started_at: "2026-11-04T01:00:00.000Z",
    running_since: null,
    paused_at: "2026-11-04T01:10:00.000Z",
    pause_reason: "app_restart",
    round_index: 1,
    clock_jumps: 0,
    ...overrides,
  };
}

function historyItem(overrides: Partial<FocusHistoryItem> = {}): FocusHistoryItem {
  return {
    id: "h1",
    kind: "focus",
    state: "completed",
    task_id: "task-2",
    task_title: "整理需求",
    task_deleted: true,
    planned_seconds: 300,
    accumulated_ms: 120_000,
    started_at: "2026-11-04T01:05:00.000Z",
    ended_at: "2026-11-04T01:07:00.000Z",
    round_index: 1,
    ...overrides,
  };
}

function snapshot(active: FocusSessionView | null): FocusSnapshot {
  return {
    active,
    prefs: PREFS,
    today: { day: "2026-11-04", focus_ms: 120_000, break_ms: 0, completed_focus: 2 },
    rounds_since_long: 2,
    sedentary: { enabled: true, interval_minutes: 60, next_at: null },
    server_now: "2026-11-04T01:10:00.000Z",
  };
}

function installStore(active: FocusSessionView | null, history: FocusHistoryItem[] = []) {
  const snap = snapshot(active);
  // 工作台挂载时会先 load()（快照 + 历史），让 IPC 返回同一份数据避免冲掉断言对象。
  invoke.mockImplementation(async (command: unknown) =>
    command === "focus_history" ? history : snap,
  );
  useFocusStore.setState({
    snapshot: snap,
    snapshotAt: Date.now(),
    history,
    loading: false,
    error: null,
    busyAction: null,
  });
}

beforeEach(() => {
  resetFocusEventsForTest();
  resetMissingKeys();
  setLocalePreference("zh-CN");
  invoke.mockReset();
  useFocusStore.setState({
    snapshot: null,
    snapshotAt: 0,
    history: [],
    loading: false,
    error: null,
    busyAction: null,
  });
});

afterEach(() => {
  cleanup();
  setLocalePreference("zh-CN");
});

describe("FocusWorkspace 中文文案", () => {
  it("暂停会话：标题、阶段、暂停原因、统计与按钮均取 focus.* 键", async () => {
    installStore(session());
    await act(async () => {
      render(<FocusWorkspace />);
    });

    expect(screen.getByRole("heading", { name: "专注与休息" })).toBeTruthy();
    expect(
      screen.getByText("番茄钟与久坐提醒；结束专注不会改变任务状态。"),
    ).toBeTruthy();
    expect(screen.getByText("已暂停 · 专注")).toBeTruthy();
    expect(
      screen.getByText("应用重启后已自动暂停；退出期间不计入有效专注时长。"),
    ).toBeTruthy();
    expect(screen.getByText("今日专注")).toBeTruthy();
    expect(screen.getByText("完成轮次")).toBeTruthy();
    expect(screen.getByText("长休进度")).toBeTruthy();
    expect(screen.getByText("继续")).toBeTruthy();
    expect(screen.getByText("结束")).toBeTruthy();
    expect(screen.getByText("放弃")).toBeTruthy();
    expect(screen.getByText("最近记录")).toBeTruthy();
  });

  it("历史行按 kind/state/时长/任务快照组合，任务删除降级为快照标题", async () => {
    installStore(session(), [historyItem()]);
    const { container } = render(<FocusWorkspace />);
    await act(async () => {});

    const row = container.querySelector(".focus-history li");
    expect(row?.getAttribute("data-tip")).toBe(
      "专注 · 已完成 · 2 分钟 · 整理需求（任务已删除）",
    );
    expect(row?.querySelector(".focus-history-time")?.textContent).not.toBe("");
  });

  it("无活动会话：准备开始、不关联任务与开始按钮", async () => {
    installStore(null);
    await act(async () => {
      render(<FocusWorkspace />);
    });

    expect(screen.getByText("准备开始")).toBeTruthy();
    expect(screen.getByText("开始专注")).toBeTruthy();
    expect(screen.getByText("开始休息")).toBeTruthy();
    expect(screen.getAllByText("不关联任务").length).toBeGreaterThan(0);
  });
});

describe("FocusWorkspace 英文文案", () => {
  it("切换语言后同一实例重新渲染英文，历史行清晰器同步", async () => {
    installStore(session(), [historyItem()]);
    setLocalePreference("en-US");
    const { container } = render(<FocusWorkspace />);
    await act(async () => {});

    expect(screen.getByRole("heading", { name: "Focus & breaks" })).toBeTruthy();
    expect(screen.getByText("Paused · Focus")).toBeTruthy();
    expect(
      screen.getByText(
        "Paused automatically after the app restarted; time while closed is not counted.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Focus today")).toBeTruthy();
    expect(screen.getByText("Rounds completed")).toBeTruthy();
    expect(screen.getByText("Resume")).toBeTruthy();
    expect(screen.getByText("Abandon")).toBeTruthy();
    expect(
      container.querySelector(".focus-history li")?.getAttribute("data-tip"),
    ).toBe("Focus · Completed · 2 min · 整理需求 (task deleted)");
    // 英文目录里不允许回退到中文：任何缺失键都会记录在这里。
    expect(getMissingKeys()).toEqual([]);

    // 运行时切回中文：同一实例必须重新渲染。
    act(() => setLocalePreference("zh-CN"));
    expect(screen.getByRole("heading", { name: "专注与休息" })).toBeTruthy();
    expect(screen.getByText("已暂停 · 专注")).toBeTruthy();
  });
});
