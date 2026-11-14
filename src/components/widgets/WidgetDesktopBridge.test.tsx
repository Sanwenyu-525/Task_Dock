// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const registerGate: { current: null | { promise: Promise<void>; release: () => void } } = {
    current: null,
  };
  return {
    registerGate,
    show: vi.fn(),
    publish: vi.fn(async () => true),
    requestListener: vi.fn(async (_payload?: unknown) => () => {}),
    unlisten: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, isTauri: () => true };
});

vi.mock("../../lib/widgets/desktopBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/widgets/desktopBridge")>();
  return {
    ...actual,
    onWidgetSnapshotRequest: vi.fn(async (listener: (payload: unknown) => void) => {
      if (harness.registerGate.current) await harness.registerGate.current.promise;
      harness.requestListener.mockImplementation(async (payload: unknown) => {
        listener(payload);
        return () => {};
      });
      return harness.unlisten;
    }),
    onWidgetAction: vi.fn(async () => () => {}),
    onWidgetBounds: vi.fn(async () => () => {}),
    onWidgetDismissed: vi.fn(async () => () => {}),
    publishWidgetSnapshot: harness.publish,
    showWidgetWindow: harness.show,
    hideWidgetWindow: vi.fn(async () => {}),
    resetWidgetPosition: vi.fn(async () => {}),
  };
});

vi.mock("./liveSources", () => ({ WIDGET_SOURCES: {} }));

vi.mock("../capsule/actions", () => ({
  openFullApp: vi.fn(),
  // 形态收敛后微件的完整功能动作走工作台直达；默认回执 succeeded（测试不关心导航细节）。
  openWorkbenchPageWithToast: vi.fn(async () => ({ status: "succeeded" })),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    activeReminders: vi.fn(async () => []),
    listTasks: vi.fn(async () => ({ items: [], total: 0, hasMore: false, nextCursor: null })),
    fetchTask: vi.fn(async () => null),
    onReminderFired: vi.fn(async () => () => {}),
    onReminderSnoozed: vi.fn(async () => () => {}),
  };
});

import { __resetLocaleForTests, setLocalePreference } from "../../i18n";
import { showWidgetWindow } from "../../lib/widgets/desktopBridge";
import { defaultWidgetItems } from "../../lib/widgets/model";
import { useWidgetsStore } from "../../store/useWidgetsStore";
import WidgetDesktopBridge from "./WidgetDesktopBridge";

const WIDGET_TYPES = defaultWidgetItems().map((item) => item.type);

function seedVisibleLayout() {
  useWidgetsStore.setState({
    hydrated: true,
    widgets: defaultWidgetItems().map((item) => ({
      ...item,
      desktop: { visible: true, topmost: false },
    })),
  });
}

function resolveShow(info: unknown) {
  vi.mocked(showWidgetWindow).mockImplementation(async () => info as never);
}

async function flushMicrotasks() {
  await act(async () => {
    // 六类窗口按队列串行创建，每次 show 完成都会追加微任务。
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
  });
}

describe("主窗微件桥接就绪屏障", () => {
  beforeEach(() => {
    __resetLocaleForTests();
    setLocalePreference("zh-CN");
    harness.registerGate.current = null;
    vi.clearAllMocks();
    seedVisibleLayout();
    resolveShow({
      widgetType: "quick-actions",
      generation: 2,
      width: 320,
      height: 200,
      nx: 0.5,
      ny: 0.5,
      monitor: null,
      topmost: false,
      scale: 1,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useWidgetsStore.setState({ desktopRuntime: {} });
  });

  it("快照请求监听注册完成前不创建任何独立窗口", async () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.registerGate.current = { promise, release };

    render(<WidgetDesktopBridge />);
    await flushMicrotasks();
    expect(harness.show).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await promise;
    });
    await flushMicrotasks();
    expect(harness.show).toHaveBeenCalledTimes(WIDGET_TYPES.length);
  });

  it("窗口创建成功后主动补发当前快照，复用窗口（主窗重载）也能恢复连接", async () => {
    render(<WidgetDesktopBridge />);
    await flushMicrotasks();
    expect(harness.show).toHaveBeenCalledTimes(WIDGET_TYPES.length);
    // 每类窗口创建成功后至少补发一次；epoch 标识主窗会话，generation 为窗口实例。
    expect(harness.publish).toHaveBeenCalled();
    const firstCall = harness.publish.mock.calls[0] as unknown[];
    expect(typeof (firstCall[3] as { epoch: string }).epoch).toBe("string");
    expect((firstCall[3] as { epoch: string }).epoch.length).toBeGreaterThan(0);
    expect((firstCall[3] as { generation?: number }).generation).toBe(2);
  });

  it("主窗重载后重新注册并再次补发，不依赖微件重新请求", async () => {
    const view = render(<WidgetDesktopBridge />);
    await flushMicrotasks();
    const firstCount = harness.publish.mock.calls.length;
    view.unmount();
    cleanup();

    render(<WidgetDesktopBridge />);
    await flushMicrotasks();
    expect(harness.show).toHaveBeenCalledTimes(WIDGET_TYPES.length * 2);
    expect(harness.publish.mock.calls.length).toBeGreaterThan(firstCount);
  });
});
