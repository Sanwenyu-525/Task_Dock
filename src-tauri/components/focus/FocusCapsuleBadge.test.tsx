// @vitest-environment jsdom
//! 胶囊专注徽标测试：无会话不占位、运行/暂停/休息的状态与剩余时间展示、可选点击。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/errors", () => ({
  invokeCommand: vi.fn(async () => null),
  errorMessage: (error: { message?: string }) => error?.message ?? "未知错误",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { resetSharedClockForTest } from "../../lib/sharedClock";
import { setLocalePreference } from "../../i18n";
import { invokeCommand } from "../../lib/errors";
import {
  resetFocusEventsForTest,
  useFocusStore,
  type FocusSessionView,
  type FocusSnapshot,
} from "../../store/useFocusStore";
import FocusCapsuleBadge from "./FocusCapsuleBadge";

const invoke = invokeCommand as unknown as Mock<
  (...args: unknown[]) => Promise<unknown>
>;

function session(overrides: Partial<FocusSessionView> = {}): FocusSessionView {
  return {
    id: "s1",
    kind: "focus",
    state: "focusing",
    task_id: null,
    task_title: "",
    task_deleted: false,
    planned_seconds: 1500,
    extension_seconds: 0,
    accumulated_ms: 0,
    remaining_ms: 1500_000,
    started_at: "2026-11-04T01:00:00.000Z",
    running_since: "2026-11-04T01:00:00.000Z",
    paused_at: null,
    pause_reason: null,
    round_index: 1,
    clock_jumps: 0,
    ...overrides,
  };
}

function snapshot(active: FocusSessionView | null): FocusSnapshot {
  return {
    active,
    prefs: {
      focus_minutes: 25,
      short_break_minutes: 5,
      long_break_minutes: 15,
      long_break_every: 4,
      auto_start_break: false,
      auto_start_next: false,
      sedentary_enabled: false,
      sedentary_interval_minutes: 60,
    },
    today: { day: "2026-11-04", focus_ms: 0, break_ms: 0, completed_focus: 0 },
    rounds_since_long: 0,
    sedentary: { enabled: false, interval_minutes: 60, next_at: null },
    server_now: "2026-11-04T01:00:00.000Z",
  };
}

function installStore(active: FocusSessionView | null) {
  const snap = snapshot(active);
  // 徽标挂载时会重新拉取一次真实快照（折叠期间可能错过事件），
  // 这里让 IPC 返回与 store 一致的结果，避免把断言对象冲掉。
  invoke.mockImplementation(async (command: unknown) =>
    command === "focus_history" ? [] : snap,
  );
  useFocusStore.setState({
    snapshot: snap,
    snapshotAt: Date.now(),
    history: [],
    loading: false,
    error: null,
    busyAction: null,
  });
}

beforeEach(() => {
  resetFocusEventsForTest();
  resetSharedClockForTest();
  setLocalePreference("zh-CN");
  invoke.mockReset();
  invoke.mockImplementation(async (command: unknown) =>
    command === "focus_history" ? [] : null,
  );
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

describe("FocusCapsuleBadge", () => {
  it("无活动会话时不渲染任何内容", () => {
    const { container } = render(<FocusCapsuleBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("挂载时重新拉取快照，避免展示折叠期间错过的状态", async () => {
    installStore(session());
    await act(async () => {
      render(<FocusCapsuleBadge />);
    });
    expect(invoke).toHaveBeenCalledWith("focus_snapshot", undefined);
    expect(screen.getByText("专注")).toBeTruthy();
  });

  it("专注中展示状态与剩余时间", () => {
    installStore(session());
    render(<FocusCapsuleBadge />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("专注")).toBeTruthy();
    expect(screen.getByText("25:00")).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "专注，剩余 25:00",
    );
  });

  it("切换到英文后徽标文案与无障碍标签一起更新", () => {
    installStore(session());
    setLocalePreference("en-US");
    render(<FocusCapsuleBadge />);
    expect(screen.getByText("Focus")).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Focus, 25:00 left",
    );
    // 运行时切换语言：同一实例应通过 useLocale 重新渲染。
    act(() => setLocalePreference("zh-CN"));
    expect(screen.getByText("专注")).toBeTruthy();
  });

  it("暂停态显示已暂停，且不显示运行态时间", () => {
    installStore(session({ state: "paused", remaining_ms: 8_000 }));
    render(<FocusCapsuleBadge />);
    expect(screen.getByText("已暂停")).toBeTruthy();
    expect(screen.getByText("00:08")).toBeTruthy();
    const badge = screen.getByRole("status");
    expect(badge.className).toContain("state-paused");
  });

  it("休息态按类型展示短休/长休", () => {
    installStore(session({ kind: "short_break", state: "break", remaining_ms: 300_000 }));
    render(<FocusCapsuleBadge />);
    expect(screen.getByText("短休")).toBeTruthy();
    expect(screen.getByText("05:00")).toBeTruthy();

    cleanup();

    installStore(session({ kind: "long_break", state: "break", remaining_ms: 900_000 }));
    render(<FocusCapsuleBadge />);
    expect(screen.getByText("长休")).toBeTruthy();
    expect(screen.getByText("15:00")).toBeTruthy();
  });

  it("传入 onClick 时渲染为可点击按钮", async () => {
    installStore(session());
    const onClick = vi.fn();
    render(<FocusCapsuleBadge onClick={onClick} />);
    const button = screen.getByRole("button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
