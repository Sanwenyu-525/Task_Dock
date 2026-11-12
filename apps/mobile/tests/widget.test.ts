// 小组件/深链纯函数单测（vitest，无新增运行时依赖）。
// 被测对象不碰原生与 SQLite：db 层与原生模块用桩替换，countTasks/selectTasks
// 走真实 domain 纯函数（与任务页同一套排序口径）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../modules/taskdock-widget", () => ({
  taskDockWidgetAvailable: true,
  pushWidgetSnapshot: vi.fn(() => true),
  refreshWidgets: vi.fn(() => true),
  requestPinWidget: vi.fn(() => null),
}));
vi.mock("../src/db/captures", () => ({ listCaptures: vi.fn(async () => []) }));
vi.mock("../src/db/kv", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));
vi.mock("../src/db/tasks", () => ({ listTasks: vi.fn(async () => []) }));

import { pushWidgetSnapshot } from "../modules/taskdock-widget";
import { listCaptures } from "../src/db/captures";
import { getSetting } from "../src/db/kv";
import { listTasks } from "../src/db/tasks";
import type { Capture, Task } from "../src/domain/types";
import { parseWidgetRouteUri } from "../src/lib/nav";
import {
  buildWidgetSnapshot,
  DEFAULT_WIDGET_PREFS,
  notifyWidgetDataChanged,
  parseWidgetPrefs,
  previewCount,
  refreshWidgetSnapshot,
  resolvePreviewContent,
  WIDGET_PREFS_KEY,
  type WidgetPrefs,
  type WidgetSnapshot,
} from "../src/lib/widgetSnapshot";

/** 固定时刻：2026-11-12 12:00 本地时间（下午，便于构造「今天到期」） */
const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime();

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: "",
    status: "pending",
    priority: 0,
    category: null,
    tags: [],
    dueAt: null,
    remindAt: null,
    advanceMinutes: null,
    recurrenceRule: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    completedAt: null,
    rev: 0,
    serverRev: 0,
    ...overrides,
  };
}

function makeCapture(overrides: Partial<Capture> & { id: string; content: string }): Capture {
  return {
    clientId: `cap-${overrides.id}`,
    kind: "text",
    createdAt: NOW - 30_000,
    rev: 0,
    serverRev: 0,
    ...overrides,
  };
}

describe("parseWidgetRouteUri（小组件深链白名单）", () => {
  it("放行白名单 Tab", () => {
    expect(parseWidgetRouteUri("taskdock://route/tasks")).toBe("tasks");
    expect(parseWidgetRouteUri("taskdock://route/inbox")).toBe("inbox");
  });

  it("剥离 query 与 hash", () => {
    expect(parseWidgetRouteUri("taskdock://route/tasks?src=widget")).toBe("tasks");
    expect(parseWidgetRouteUri("taskdock://route/inbox#anchor")).toBe("inbox");
  });

  it("白名单外与错误 scheme 返回 null", () => {
    expect(parseWidgetRouteUri("taskdock://route/notifications")).toBeNull();
    expect(parseWidgetRouteUri("taskdock://route/")).toBeNull();
    expect(parseWidgetRouteUri("taskdock://pair?x=1")).toBeNull();
    expect(parseWidgetRouteUri("otherapp://route/tasks")).toBeNull();
    expect(parseWidgetRouteUri("not a url")).toBeNull();
  });

  it("空值安全", () => {
    expect(parseWidgetRouteUri(null)).toBeNull();
    expect(parseWidgetRouteUri(undefined)).toBeNull();
    expect(parseWidgetRouteUri("")).toBeNull();
  });
});

describe("parseWidgetPrefs（kv 损坏容错）", () => {
  it("空值与垃圾 JSON 回默认值", () => {
    expect(parseWidgetPrefs(null)).toEqual(DEFAULT_WIDGET_PREFS);
    expect(parseWidgetPrefs("")).toEqual(DEFAULT_WIDGET_PREFS);
    expect(parseWidgetPrefs("not-json{")).toEqual(DEFAULT_WIDGET_PREFS);
    expect(parseWidgetPrefs("42")).toEqual(DEFAULT_WIDGET_PREFS);
    expect(parseWidgetPrefs("null")).toEqual(DEFAULT_WIDGET_PREFS);
  });

  it("合法值完整往返", () => {
    const prefs: WidgetPrefs = { size: "2x2", content: "captures", appearance: "dark" };
    expect(parseWidgetPrefs(JSON.stringify(prefs))).toEqual(prefs);
  });

  it("单个字段非法只回退该字段", () => {
    const parsed = parseWidgetPrefs(
      JSON.stringify({ size: "9x9", content: "captures", appearance: "dark" }),
    );
    expect(parsed).toEqual({ size: DEFAULT_WIDGET_PREFS.size, content: "captures", appearance: "dark" });
  });

  it("未知字段被忽略", () => {
    const parsed = parseWidgetPrefs(
      JSON.stringify({ ...DEFAULT_WIDGET_PREFS, evil: "payload" }),
    );
    expect(parsed).toEqual(DEFAULT_WIDGET_PREFS);
    expect("evil" in parsed).toBe(false);
  });
});

describe("buildWidgetSnapshot（真实 domain 计数 + 桩数据）", () => {
  beforeEach(() => {
    // buildWidgetSnapshot 内部用 Date.now() 取「今天」口径；固定时钟到 NOW，
    // 否则真实日期跨天后（2026-11-13 实测）「今天到期」用例随日期漂移失败。
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listTasks).mockResolvedValue([]);
    vi.mocked(listCaptures).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const dueTodayPending = makeTask({ id: "t1", title: "今天到期未完成", dueAt: NOW - 3600_000 });
  const dueTodayPending2 = makeTask({ id: "t2", title: "今天第二件", dueAt: NOW - 60_000, priority: 3 });
  const futureTask = makeTask({ id: "t3", title: "以后", dueAt: NOW + 7 * 86_400_000 });
  const noDateTask = makeTask({ id: "t4", title: "无日期" });

  it("today：计数只含今天到期未完成", async () => {
    vi.mocked(listTasks).mockResolvedValue([dueTodayPending, dueTodayPending2, futureTask, noDateTask]);
    const snapshot = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "today" });
    expect(snapshot.todayCount).toBe(2);
    expect(snapshot.pendingCount).toBe(4);
    expect(snapshot.content).toBe("today");
    expect(snapshot.items.map((item) => item.t)).toEqual(["今天第二件", "今天到期未完成"]);
    expect(snapshot.items.every((item) => !item.done)).toBe(true);
  });

  it("pending：行与计数覆盖全部未完成（含无日期）", async () => {
    vi.mocked(listTasks).mockResolvedValue([dueTodayPending, futureTask, noDateTask]);
    const snapshot = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "pending" });
    expect(snapshot.pendingCount).toBe(3);
    expect(snapshot.items).toHaveLength(3);
  });

  it("captures：取最新几条且 done 恒 false", async () => {
    const captures = [
      makeCapture({ id: "c1", content: "最新一条" }),
      makeCapture({ id: "c2", content: "次新一条" }),
    ];
    vi.mocked(listCaptures).mockResolvedValue(captures);
    const snapshot = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "captures" });
    expect(snapshot.captureCount).toBe(2);
    expect(snapshot.items.map((item) => item.t)).toEqual(["最新一条", "次新一条"]);
    expect(snapshot.items.every((item) => !item.done)).toBe(true);
  });

  it("标题取首行并截断到 60 字加省略号", async () => {
    const longLine = "长".repeat(70);
    vi.mocked(listCaptures).mockResolvedValue([
      makeCapture({ id: "c1", content: `${longLine}\n第二行不该出现` }),
    ]);
    const snapshot = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "captures" });
    const title = snapshot.items[0]?.t ?? "";
    expect(title.startsWith("长".repeat(60))).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toHaveLength(61);
    expect(title).not.toContain("第二行");
  });

  it("行数上限 4", async () => {
    vi.mocked(listCaptures).mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => makeCapture({ id: `c${i}`, content: `条目${i}` })),
    );
    const snapshot = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "captures" });
    expect(snapshot.items).toHaveLength(4);
  });

  it("各 content 的空态文案", async () => {
    const today = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "today" });
    expect(today.empty).toBe("今天没有到期任务");
    const pending = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "pending" });
    expect(pending.empty).toBe("没有待办任务");
    const captures = await buildWidgetSnapshot({ ...DEFAULT_WIDGET_PREFS, content: "captures" });
    expect(captures.empty).toBe("收集箱是空的");
  });

  it("从 kv 读取偏好（widget_prefs）", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === WIDGET_PREFS_KEY
        ? JSON.stringify({ size: "2x2", content: "pending", appearance: "dark" })
        : null,
    );
    vi.mocked(listTasks).mockResolvedValue([noDateTask]);
    const snapshot = await buildWidgetSnapshot();
    expect(snapshot.content).toBe("pending");
    expect(snapshot.appearance).toBe("dark");
    expect(snapshot.items.map((item) => item.t)).toEqual(["无日期"]);
  });
});

describe("refreshWidgetSnapshot / notifyWidgetDataChanged（推送与去抖）", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listTasks).mockResolvedValue([]);
    vi.mocked(listCaptures).mockResolvedValue([]);
    vi.mocked(pushWidgetSnapshot).mockClear().mockImplementation(() => true);
  });

  it("推送 JSON 契约：v=1 且只含白名单字段", async () => {
    const snapshot = await refreshWidgetSnapshot();
    expect(snapshot).not.toBeNull();
    expect(pushWidgetSnapshot).toHaveBeenCalledTimes(1);
    const raw = vi.mocked(pushWidgetSnapshot).mock.calls[0]?.[0] ?? "";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "appearance",
        "captureCount",
        "content",
        "empty",
        "items",
        "pendingCount",
        "todayCount",
        "updatedAt",
        "v",
      ].sort(),
    );
  });

  it("原生推送失败时仍返回快照（预览可用）且不抛异常", async () => {
    vi.mocked(pushWidgetSnapshot).mockImplementation(() => false);
    const snapshot = await refreshWidgetSnapshot();
    expect(snapshot).not.toBeNull();
  });

  it("400ms 去抖：连续多次数据变化只读库推送一次", async () => {
    vi.useFakeTimers();
    try {
      notifyWidgetDataChanged();
      notifyWidgetDataChanged();
      notifyWidgetDataChanged();
      await vi.advanceTimersByTimeAsync(399);
      expect(pushWidgetSnapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(pushWidgetSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 真机回归：偏好与快照瞬时不同步时，标题/计数/行必须同一口径。
// 现象：内容选中「今天任务」却显示「待办 0」，下面列着待办行。
describe("小组件预览口径（偏好 vs 快照）", () => {
  function snapshotWith(content: WidgetSnapshot["content"]): WidgetSnapshot {
    return {
      v: 1,
      updatedAt: NOW,
      content,
      appearance: "system",
      todayCount: 0,
      pendingCount: 14,
      captureCount: 3,
      items: [{ t: "开会", done: false }],
      empty: "没有待办任务",
    };
  }

  it("快照为待办、偏好仍停在今天时，标题与计数都按快照待办取", () => {
    const snapshot = snapshotWith("pending");
    const content = resolvePreviewContent("today", snapshot);
    expect(content).toBe("pending");
    expect(previewCount(content, snapshot)).toBe(14);
  });

  it("没有快照时沿用偏好内容，计数为 0", () => {
    expect(resolvePreviewContent("today", null)).toBe("today");
    expect(previewCount("today", null)).toBe(0);
  });

  it("收集箱内容取 captureCount，今天内容取 todayCount", () => {
    const snapshot = snapshotWith("pending");
    expect(previewCount("captures", snapshot)).toBe(3);
    expect(previewCount("today", snapshot)).toBe(0);
  });
});
