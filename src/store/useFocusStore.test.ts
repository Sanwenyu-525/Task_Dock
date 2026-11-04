// @vitest-environment jsdom
//! 专注 store 测试：快照权威性、展示级倒计时、重复开始单飞、状态迁移与失败处理。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../lib/errors", async (importOriginal) => {
  // 只替换 IPC 入口；normalizeError 等错误归一化逻辑保持真实实现，
  // 以便覆盖 store 的 localizedErrorMessage 分支。
  const actual = await importOriginal<typeof import("../lib/errors")>();
  return { ...actual, invokeCommand: vi.fn() };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { invokeCommand } from "../lib/errors";
import { setLocalePreference, t } from "../i18n";
import {
  SESSION_KIND_LABEL,
  SESSION_KIND_KEYS,
  SESSION_STATE_LABEL,
  SESSION_STATE_KEYS,
  formatRemaining,
  remainingFromSnapshot,
  resetFocusEventsForTest,
  useFocusStore,
  type FocusPrefs,
  type FocusSnapshot,
  type FocusSessionView,
} from "./useFocusStore";

const invoke = invokeCommand as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

const PREFS: FocusPrefs = {
  focus_minutes: 25,
  short_break_minutes: 5,
  long_break_minutes: 15,
  long_break_every: 4,
  auto_start_break: false,
  auto_start_next: false,
  sedentary_enabled: false,
  sedentary_interval_minutes: 60,
};

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

function snapshot(active: FocusSessionView | null, overrides: Partial<FocusSnapshot> = {}): FocusSnapshot {
  return {
    active,
    prefs: PREFS,
    today: { day: "2026-11-04", focus_ms: 0, break_ms: 0, completed_focus: 0 },
    rounds_since_long: 0,
    sedentary: { enabled: false, interval_minutes: 60, next_at: null },
    server_now: "2026-11-04T01:00:00.000Z",
    ...overrides,
  };
}

function resetStore() {
  useFocusStore.setState({
    snapshot: null,
    snapshotAt: 0,
    history: [],
    loading: false,
    error: null,
    busyAction: null,
  });
}

beforeEach(() => {
  resetStore();
  resetFocusEventsForTest();
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

describe("展示级剩余时间", () => {
  it("运行中的会话按快照之后经过的时间递减，但不低于 0", () => {
    const active = session({ remaining_ms: 10_000 });
    expect(remainingFromSnapshot(active, 1000, 2000)).toBe(9_000);
    expect(remainingFromSnapshot(active, 1000, 6000)).toBe(5_000);
    expect(remainingFromSnapshot(active, 1000, 20_000)).toBe(0);
  });

  it("暂停的会话不递减，休息与专注同样按快照推算", () => {
    const paused = session({ state: "paused", remaining_ms: 8_000 });
    expect(remainingFromSnapshot(paused, 1000, 99_000)).toBe(8_000);

    const rest = session({ kind: "short_break", state: "break", remaining_ms: 300_000 });
    expect(remainingFromSnapshot(rest, 1000, 31_000)).toBe(270_000);
  });

  it("无活动会话返回 null；格式化输出 mm:ss", () => {
    expect(remainingFromSnapshot(null, 0, 10)).toBeNull();
    expect(formatRemaining(null)).toBe("--:--");
    expect(formatRemaining(65_000)).toBe("01:05");
    expect(formatRemaining(3_600_000)).toBe("1:00:00");
  });
});

describe("开始与会话单飞", () => {
  it("start 成功写入快照与快照时刻", async () => {
    invoke.mockResolvedValue(snapshot(session()));
    await useFocusStore.getState().start("task-1");

    expect(invoke).toHaveBeenCalledWith("focus_start", { taskId: "task-1" });
    const state = useFocusStore.getState();
    expect(state.snapshot?.active?.state).toBe("focusing");
    expect(state.snapshotAt).toBeGreaterThan(0);
  });

  it("已有活动会话时重复点击开始不再发出 IPC", async () => {
    useFocusStore.setState({ snapshot: snapshot(session()) });
    await useFocusStore.getState().start();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("并发点击开始时只发出一次 IPC", async () => {
    let resolve!: (value: FocusSnapshot) => void;
    invoke.mockReturnValue(new Promise<FocusSnapshot>((r) => {
      resolve = r;
    }));

    const a = useFocusStore.getState().start();
    const b = useFocusStore.getState().start();
    expect(invoke).toHaveBeenCalledTimes(1);

    resolve(snapshot(session()));
    await Promise.all([a, b]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().busyAction).toBeNull();
  });

  it("开始失败时保留原快照并暴露错误", async () => {
    const existing = snapshot(null);
    useFocusStore.setState({ snapshot: existing });
    invoke.mockRejectedValue({ code: "CONFLICT", message: "已有进行中的专注" });

    await useFocusStore.getState().start();

    const state = useFocusStore.getState();
    expect(state.snapshot).toBe(existing);
    expect(state.error).toBe("已有进行中的专注");
    expect(state.busyAction).toBeNull();
  });

  it("仅通用错误码使用本地化文案，校验/冲突保留后端的真实原因", async () => {
    setLocalePreference("zh-CN");
    invoke.mockRejectedValue({ code: "DATABASE_BUSY", message: "database is locked" });
    await useFocusStore.getState().start();
    expect(useFocusStore.getState().error).toBe(t("errors.DATABASE_BUSY"));

    invoke.mockRejectedValue({ code: "VALIDATION_ERROR", message: "所选任务不存在或已被删除" });
    await useFocusStore.getState().start();
    expect(useFocusStore.getState().error).toBe("所选任务不存在或已被删除");

    invoke.mockRejectedValue("磁盘写入失败：磁盘已满");
    await useFocusStore.getState().start();
    expect(useFocusStore.getState().error).toBe("磁盘写入失败：磁盘已满");
  });
});

describe("会话文案键", () => {
  afterEach(() => {
    setLocalePreference("zh-CN");
  });

  it("键名映射覆盖全部状态与类型，标签投影跟随当前语言", () => {
    expect(Object.keys(SESSION_STATE_KEYS)).toHaveLength(5);
    expect(Object.keys(SESSION_KIND_KEYS)).toHaveLength(3);

    setLocalePreference("zh-CN");
    expect(SESSION_KIND_LABEL.focus).toBe("专注");
    expect(SESSION_KIND_LABEL.short_break).toBe("短休息");
    expect(SESSION_KIND_LABEL.long_break).toBe("长休息");
    expect(SESSION_STATE_LABEL.completed).toBe("已完成");

    setLocalePreference("en-US");
    expect(SESSION_KIND_LABEL.focus).toBe("Focus");
    expect(SESSION_KIND_LABEL.short_break).toBe("Short break");
    expect(SESSION_KIND_LABEL.long_break).toBe("Long break");
    expect(SESSION_STATE_LABEL.paused).toBe("Paused");
    expect(SESSION_STATE_LABEL.cancelled).toBe("Abandoned");
  });
});

describe("快照加载", () => {
  it("快照时刻在快照返回后立即记录，不把历史请求时延算进倒计时", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T10:00:00.000Z"));
    let resolveHistory!: (value: unknown) => void;
    invoke.mockImplementation((command: unknown) => {
      if (command === "focus_snapshot") return Promise.resolve(snapshot(session()));
      return new Promise((resolve) => {
        resolveHistory = resolve;
      });
    });

    const flushMicrotasks = async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };

    const loading = useFocusStore.getState().load();
    await flushMicrotasks(); // 让 load 记录快照时刻并发起历史请求
    expect(typeof resolveHistory).toBe("function");

    // 历史请求再拖 5 秒返回：快照时刻不能被它推后。
    vi.setSystemTime(new Date("2026-11-04T10:00:05.000Z"));
    resolveHistory([]);
    await loading;

    expect(useFocusStore.getState().snapshotAt).toBe(
      new Date("2026-11-04T10:00:00.000Z").getTime(),
    );
    expect(useFocusStore.getState().snapshot?.active?.id).toBe("s1");
  });
});

describe("暂停 / 继续 / 结束的状态守卫", () => {
  it("仅运行中的会话可以暂停", async () => {
    useFocusStore.setState({ snapshot: snapshot(session({ state: "paused" })) });
    await useFocusStore.getState().pause();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("暂停成功切到 paused", async () => {
    invoke.mockResolvedValue(snapshot(session({ state: "paused" })));
    useFocusStore.setState({ snapshot: snapshot(session()) });

    await useFocusStore.getState().pause();

    expect(invoke).toHaveBeenCalledWith("focus_pause", undefined);
    expect(useFocusStore.getState().snapshot?.active?.state).toBe("paused");
  });

  it("仅暂停态可以继续", async () => {
    useFocusStore.setState({ snapshot: snapshot(session()) });
    await useFocusStore.getState().resume();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("结束与放弃在无活动会话时不发 IPC", async () => {
    await useFocusStore.getState().finish();
    await useFocusStore.getState().cancel();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("休息控制", () => {
  it("延长休息仅对休息会话生效", async () => {
    useFocusStore.setState({ snapshot: snapshot(session()) });
    await useFocusStore.getState().extendBreak(5);
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue(
      snapshot(session({ kind: "long_break", state: "break", remaining_ms: 1_200_000 })),
    );
    useFocusStore.setState({
      snapshot: snapshot(session({ kind: "short_break", state: "break" })),
    });
    await useFocusStore.getState().extendBreak(5);
    expect(invoke).toHaveBeenCalledWith("focus_extend_break", { minutes: 5 });
  });

  it("已有活动会话时不能直接开始休息", async () => {
    useFocusStore.setState({ snapshot: snapshot(session()) });
    await useFocusStore.getState().startBreak();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("偏好更新", () => {
  it("保存后重新拉取快照，展示新值", async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const command = args[0] as string;
      if (command === "focus_update_prefs") return PREFS;
      if (command === "focus_snapshot") {
        return snapshot(null, { prefs: { ...PREFS, focus_minutes: 30 } });
      }
      if (command === "focus_history") return [];
      return null;
    });

    await useFocusStore.getState().updatePrefs({ focus_minutes: 30 });

    expect(invoke).toHaveBeenCalledWith("focus_update_prefs", {
      patch: { focus_minutes: 30 },
    });
    expect(useFocusStore.getState().snapshot?.prefs.focus_minutes).toBe(30);
  });
});
