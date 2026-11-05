// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const listeners: Array<(envelope: unknown) => void> = [];
  const unlistens: Array<ReturnType<typeof vi.fn>> = [];
  const gate: { current: { promise: Promise<void>; release: () => void } | null } = {
    current: null,
  };
  return {
    listeners,
    unlistens,
    gate,
    label: { current: "widget-quick-actions" },
    request: vi.fn(async () => {}),
  };
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, isTauri: () => true };
});

vi.mock("@tauri-apps/api/event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/event")>();
  return { ...actual, listen: vi.fn(async () => () => {}) };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: harness.label.current,
    onMoved: vi.fn(async () => () => {}),
    onResized: vi.fn(async () => () => {}),
  }),
}));

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return {
    ...actual,
    getSettings: vi.fn(async () => ({
      theme: "system",
      visual_preset: "",
      material: "solid",
    })),
  };
});

vi.mock("../lib/widgets/desktopBridge", () => ({
  onWidgetSnapshot: vi.fn(async (listener: (envelope: unknown) => void) => {
    if (harness.gate.current) await harness.gate.current.promise;
    harness.listeners.push(listener);
    const unlisten = vi.fn();
    harness.unlistens.push(unlisten);
    return unlisten;
  }),
  requestWidgetSnapshot: harness.request,
  getWidgetWindowInfo: vi.fn(async () => ({
    widgetType: "quick-actions",
    generation: 4,
    width: 320,
    height: 220,
    nx: 0.8,
    ny: 0.2,
    monitor: null,
    topmost: false,
    scale: 1,
  })),
  reportWidgetBounds: vi.fn(async () => {}),
  dismissWidgetWindow: vi.fn(async () => {}),
  dispatchWidgetAction: vi.fn(async () => {}),
  setWidgetTopmost: vi.fn(async () => {}),
}));

import { __resetLocaleForTests, setLocalePreference } from "../i18n";
import { onWidgetSnapshot } from "../lib/widgets/desktopBridge";
import type { DesktopWidgetSnapshot, WidgetSnapshotEnvelope } from "../lib/widgets/desktop";
import { useTasksStore } from "../store/useTasksStore";
import WidgetWindow from "./WidgetWindow";
import widgetDesktopCss from "./widgets-desktop.css?raw";
import widgetsPanelCss from "../components/widgets/widgets.css?raw";

const QUICK_ACTIONS_ENVELOPE = (
  overrides: Partial<WidgetSnapshotEnvelope> = {},
): WidgetSnapshotEnvelope => ({
  widgetType: "quick-actions",
  revision: 1,
  epoch: "epoch-a",
  generation: 4,
  snapshot: { widgetType: "quick-actions", updatedAt: "2026-11-05T00:00:00Z" },
  ...overrides,
});

const TODAY_TASKS_ENVELOPE = (
  overrides: Partial<WidgetSnapshotEnvelope> = {},
): WidgetSnapshotEnvelope => ({
  widgetType: "today-tasks",
  revision: 1,
  epoch: "epoch-a",
  generation: 4,
  snapshot: {
    widgetType: "today-tasks",
    tasks: [],
    stats: null,
    statsError: null,
    error: null,
    configMaxItems: 5,
    updatedAt: "2026-11-05T00:00:00Z",
  },
  ...overrides,
});

/** 推进微任务（监听注册、请求 IPC、状态落盘）。 */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("桌面微件窗口首帧连接", () => {
  beforeEach(() => {
    __resetLocaleForTests();
    setLocalePreference("zh-CN");
    harness.listeners.length = 0;
    harness.unlistens.length = 0;
    harness.gate.current = null;
    harness.label.current = "widget-quick-actions";
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("监听注册成功后才请求首帧，避免请求发往尚未订阅的窗口", async () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.gate.current = { promise, release };

    render(<WidgetWindow />);
    await flushMicrotasks();
    expect(harness.request).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await promise;
    });
    await flushMicrotasks();
    expect(harness.request).toHaveBeenCalledTimes(1);
  });

  it("接受首帧后进入已连接态，标题条与按钮区分离", async () => {
    render(<WidgetWindow />);
    await flushMicrotasks();
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(screen.getByText("等待主窗口数据…")).toBeTruthy();

    act(() => harness.listeners[0](QUICK_ACTIONS_ENVELOPE()));
    expect(screen.queryByText("等待主窗口数据…")).toBeNull();

    const drag = document.querySelector(".wd-drag");
    expect(drag).not.toBeNull();
    expect(drag?.getAttribute("data-tauri-drag-region")).not.toBeNull();
    // 按钮只在 .wd-tools 中，不能落在可拖动区。
    expect(drag?.querySelector("button")).toBeNull();
  });

  it("首帧请求丢失时有界自动重试，收到快照后停止", async () => {
    render(<WidgetWindow />);
    await flushMicrotasks();
    expect(harness.request).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByText("尚未连接到主窗口")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    await flushMicrotasks();
    expect(harness.request).toHaveBeenCalledTimes(2);
    // 重试会重建订阅：旧监听已释放，监听数量不累积。
    expect(harness.listeners).toHaveLength(2);
    expect(harness.unlistens[0]).toHaveBeenCalledTimes(1);

    act(() => harness.listeners[1](QUICK_ACTIONS_ENVELOPE({ revision: 2 })));
    expect(screen.queryByText("尚未连接到主窗口")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(harness.request).toHaveBeenCalledTimes(2);
  });

  it("达到重试上限后停止自动重试，保留手动入口", async () => {
    render(<WidgetWindow />);
    await flushMicrotasks();

    for (const delay of [4000, 1200, 4000, 2400, 4000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }
    expect(harness.request).toHaveBeenCalledTimes(3);
    expect(screen.getByText("重试")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(harness.request).toHaveBeenCalledTimes(3);
  });

  it("重复 revision 不重复更新业务 Store", async () => {
    harness.label.current = "widget-today-tasks";
    const setState = vi.spyOn(useTasksStore, "setState");
    render(<WidgetWindow />);
    await flushMicrotasks();
    const baseline = setState.mock.calls.length;

    act(() => harness.listeners[0](TODAY_TASKS_ENVELOPE({ revision: 1 })));
    expect(setState.mock.calls.length).toBe(baseline + 1);

    act(() =>
      harness.listeners[0](
        TODAY_TASKS_ENVELOPE({
          revision: 1,
          snapshot: {
            ...(TODAY_TASKS_ENVELOPE().snapshot as Extract<
              DesktopWidgetSnapshot,
              { widgetType: "today-tasks" }
            >),
            updatedAt: "2026-11-05T00:01:00Z",
          },
        }),
      ),
    );
    expect(setState.mock.calls.length).toBe(baseline + 1);
  });

  it("旧窗口代际的快照被忽略", async () => {
    harness.label.current = "widget-today-tasks";
    const setState = vi.spyOn(useTasksStore, "setState");
    render(<WidgetWindow />);
    await flushMicrotasks();
    const baseline = setState.mock.calls.length;

    act(() => harness.listeners[0](TODAY_TASKS_ENVELOPE({ generation: 3, revision: 9 })));
    expect(setState.mock.calls.length).toBe(baseline);
    expect(screen.getByText("等待主窗口数据…")).toBeTruthy();
  });

  it("主窗重载（epoch 变化）后新 revision 仍被接受", async () => {
    harness.label.current = "widget-today-tasks";
    const setState = vi.spyOn(useTasksStore, "setState");
    render(<WidgetWindow />);
    await flushMicrotasks();
    const baseline = setState.mock.calls.length;

    act(() => harness.listeners[0](TODAY_TASKS_ENVELOPE({ revision: 8, epoch: "epoch-a" })));
    expect(setState.mock.calls.length).toBe(baseline + 1);

    act(() =>
      harness.listeners[0](
        TODAY_TASKS_ENVELOPE({
          revision: 1,
          epoch: "epoch-b",
          snapshot: {
            ...(TODAY_TASKS_ENVELOPE().snapshot as Extract<
              DesktopWidgetSnapshot,
              { widgetType: "today-tasks" }
            >),
            updatedAt: "2026-11-05T00:02:00Z",
          },
        }),
      ),
    );
    expect(setState.mock.calls.length).toBe(baseline + 2);
  });

  it("订阅失败与请求失败给出不同原因", async () => {
    vi.mocked(onWidgetSnapshot).mockRejectedValueOnce(new Error("listen-boom"));
    render(<WidgetWindow />);
    await flushMicrotasks();
    expect(screen.getByText("无法订阅主窗口数据")).toBeTruthy();
    cleanup();

    harness.request.mockRejectedValueOnce(new Error("ipc-boom"));
    render(<WidgetWindow />);
    await flushMicrotasks();
    expect(screen.getByText("无法向主窗口请求数据")).toBeTruthy();
  });

  it("窗口卸载后释放监听与重试定时器", async () => {
    const view = render(<WidgetWindow />);
    await flushMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    view.unmount();
    expect(harness.unlistens[0]).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(harness.request).toHaveBeenCalledTimes(1);
  });
});

describe("拖动区光标语义", () => {
  const widgetCss = widgetDesktopCss;
  const panelCss = widgetsPanelCss;

  it("微件标题条可拖动区为 grab，按下为 grabbing", () => {
    expect(widgetCss).toMatch(/\.wd-drag\s*\{[^}]*cursor:\s*grab/);
    expect(widgetCss).toMatch(/\.wd-drag:active\s*\{[^}]*cursor:\s*grabbing/);
  });

  it("排序手柄默认 grab，拖动卡片期间为 grabbing", () => {
    expect(panelCss).toMatch(/\.widget-grip\s*\{[^}]*cursor:\s*grab/);
    expect(panelCss).toMatch(/\.widget-card\.dragging\s+\.widget-grip\s*\{[^}]*cursor:\s*grabbing/);
  });
});
