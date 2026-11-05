// @vitest-environment jsdom
//! 用户偏好镜像对账：恢复覆盖、缺失补齐、冲突优先与防抖镜像。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  getUserPreferences: vi.fn(),
  setUserPreferences: vi.fn(),
}));

vi.mock("./bridge", () => bridgeMocks);
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  LOCALE_STORAGE_KEY,
  WIDGETS_STORAGE_KEY,
  __resetUserPreferencesForTests,
  onAppGridOrderApplied,
  onLocalePreferenceApplied,
  onWidgetsLayoutApplied,
  schedulePreferencesMirror,
  syncUserPreferences,
} from "./userPreferences";
import { readAppGridOrder, writeAppGridOrder } from "./appGridOrder";
import { defaultWidgetItems } from "./widgets/model";

function widgetPayload() {
  return defaultWidgetItems().map((item) => ({
    widget_id: item.widget_id,
    type: item.type,
    enabled: item.enabled,
    config: item.config,
    size: item.size,
    sort_order: item.sort_order,
  }));
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    locale: "en-US",
    widgets: widgetPayload(),
    app_grid_order: null,
    warnings: [],
    apply_restore: false,
    restore_id: null,
    ...overrides,
  };
}

function storedLayoutTypes(): string[] {
  const raw = localStorage.getItem(WIDGETS_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { widgets?: { type: string }[] };
  return (parsed.widgets ?? []).map((item) => item.type);
}

beforeEach(() => {
  localStorage.clear();
  __resetUserPreferencesForTests();
  bridgeMocks.getUserPreferences.mockReset();
  bridgeMocks.setUserPreferences.mockReset();
  bridgeMocks.setUserPreferences.mockResolvedValue(view());
});

afterEach(() => {
  __resetUserPreferencesForTests();
  vi.useRealTimers();
});

describe("恢复后启动", () => {
  it("apply_restore=true 时以文件为准覆盖 localStorage、通知订阅并回执清除标记", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    // 与恢复值顺序不同：确保恢复分支真的覆盖本地布局。
    localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        widgets: [{ type: "efficiency", widget_id: "efficiency", enabled: true }],
      }),
    );
    bridgeMocks.getUserPreferences.mockResolvedValue(
      view({ apply_restore: true, restore_id: "sess-1" }),
    );
    const localeSpy = vi.fn();
    const widgetsSpy = vi.fn();
    const offLocale = onLocalePreferenceApplied(localeSpy);
    const offWidgets = onWidgetsLayoutApplied(widgetsSpy);

    await syncUserPreferences();

    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(storedLayoutTypes()).toEqual(defaultWidgetItems().map((w) => w.type));
    expect(localeSpy).toHaveBeenCalledWith("en-US");
    expect(widgetsSpy).toHaveBeenCalled();
    expect(bridgeMocks.setUserPreferences).toHaveBeenCalledWith(
      "en-US",
      expect.any(Array),
      "sess-1",
      null,
    );
    offLocale();
    offWidgets();
  });

  it("备份恢复应用网格排序：写入 localStorage、通知订阅并随回执提交", async () => {
    bridgeMocks.getUserPreferences.mockResolvedValue(
      view({
        apply_restore: true,
        restore_id: "sess-order",
        app_grid_order: ["__taskdock_app_add__", "app-a"],
      }),
    );
    const orderSpy = vi.fn();
    const off = onAppGridOrderApplied(orderSpy);

    await syncUserPreferences();

    expect(readAppGridOrder()).toEqual(["__taskdock_app_add__", "app-a"]);
    expect(orderSpy).toHaveBeenCalled();
    expect(bridgeMocks.setUserPreferences).toHaveBeenCalledWith(
      "en-US",
      expect.any(Array),
      "sess-order",
      ["__taskdock_app_add__", "app-a"],
    );
    off();
  });

  it("正常启动 local 无排序时从文件补齐；本地已有排序时保持本地并回写", async () => {
    bridgeMocks.getUserPreferences.mockResolvedValue(
      view({ app_grid_order: ["app-remote"] }),
    );
    await syncUserPreferences();
    expect(readAppGridOrder()).toEqual(["app-remote"]);

    // 本地已有手动顺序：远端不同也不能覆盖，回写时使用本地顺序。
    writeAppGridOrder(["app-local"]);
    bridgeMocks.setUserPreferences.mockClear();
    bridgeMocks.getUserPreferences.mockResolvedValue(
      view({ app_grid_order: ["app-remote"] }),
    );
    await syncUserPreferences();
    expect(readAppGridOrder()).toEqual(["app-local"]);
    expect(bridgeMocks.setUserPreferences).toHaveBeenCalledWith(
      "en-US",
      expect.any(Array),
      null,
      ["app-local"],
    );
  });

  it("损坏的远端排序被忽略，不清空本机排序", async () => {
    writeAppGridOrder(["app-local"]);
    bridgeMocks.getUserPreferences.mockResolvedValue(
      view({ app_grid_order: "not-an-array" }),
    );
    await syncUserPreferences();
    expect(readAppGridOrder()).toEqual(["app-local"]);
  });

  it("备份恢复保留桌面窗口字段，并按模型补齐缺失类型", async () => {
    const payload = widgetPayload();
    payload[0] = {
      ...payload[0],
      enabled: false,
      desktop: {
        visible: true,
        topmost: true,
        width: 340,
        height: 280,
        nx: 0.25,
        ny: 0.5,
        monitor: "DISPLAY2",
      },
    } as (typeof payload)[number];
    bridgeMocks.getUserPreferences.mockResolvedValue(
      view({ apply_restore: true, restore_id: "sess-desktop", widgets: payload }),
    );

    await syncUserPreferences();

    const stored = JSON.parse(localStorage.getItem(WIDGETS_STORAGE_KEY)!) as {
      widgets: { type: string; desktop: Record<string, unknown> }[];
    };
    const tasks = stored.widgets.find((item) => item.type === "today-tasks")!;
    expect(tasks.desktop).toMatchObject({
      visible: true,
      topmost: true,
      nx: 0.25,
      ny: 0.5,
      monitor: "DISPLAY2",
    });
    // 未启用桌面窗口的类型回落安全默认，不会被恢复值串到其他微件。
    for (const item of stored.widgets.filter((it) => it.type !== "today-tasks")) {
      expect(item.desktop.visible).toBe(false);
      expect(item.desktop.topmost).toBe(false);
    }
  });

  it("本地已有布局与恢复值相同也会通知 Store 重新读取", async () => {
    localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({ version: 1, widgets: widgetPayload() }),
    );
    bridgeMocks.getUserPreferences.mockResolvedValue(
      view({ apply_restore: true, restore_id: "sess-2" }),
    );
    const widgetsSpy = vi.fn();
    const off = onWidgetsLayoutApplied(widgetsSpy);
    await syncUserPreferences();
    expect(widgetsSpy).toHaveBeenCalled();
    off();
  });
});

describe("正常启动对账", () => {
  it("localStorage 缺失时从文件补齐并回写文件", async () => {
    bridgeMocks.getUserPreferences.mockResolvedValue(view({ locale: "en-US" }));
    const localeSpy = vi.fn();
    const off = onLocalePreferenceApplied(localeSpy);

    await syncUserPreferences();

    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(storedLayoutTypes()).toEqual(defaultWidgetItems().map((w) => w.type));
    expect(localeSpy).toHaveBeenCalledWith("en-US");
    expect(bridgeMocks.setUserPreferences).toHaveBeenCalledWith(
      "en-US",
      expect.any(Array),
      null,
      null,
    );
    off();
  });

  it("localStorage 与文件冲突时以 localStorage 为准并回写文件", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    const localLayout = defaultWidgetItems()
      .slice()
      .reverse()
      .map((item) => ({ ...item, sort_order: 0 }));
    localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({ version: 1, widgets: localLayout }),
    );
    bridgeMocks.getUserPreferences.mockResolvedValue(view({ locale: "en-US" }));

    await syncUserPreferences();

    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    // 归一化后按本地顺序重排：efficiency 排到第一个（本地反序的第一项）。
    expect(storedLayoutTypes()[0]).toBe("efficiency");
    expect(bridgeMocks.setUserPreferences).toHaveBeenCalledWith(
      "zh-CN",
      expect.any(Array),
      null,
      null,
    );
  });

  it("损坏的 localStorage 语言/布局视为缺失，由文件补齐", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr-FR");
    localStorage.setItem(WIDGETS_STORAGE_KEY, "{not-json");
    bridgeMocks.getUserPreferences.mockResolvedValue(view({ locale: "en-US" }));

    await syncUserPreferences();

    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(storedLayoutTypes()).toHaveLength(defaultWidgetItems().length);
  });
});

describe("变更镜像", () => {
  it("连续变更只触发一次防抖写入", async () => {
    vi.useFakeTimers();
    localStorage.setItem(LOCALE_STORAGE_KEY, "en-US");
    localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({ version: 1, widgets: widgetPayload() }),
    );

    schedulePreferencesMirror(100);
    schedulePreferencesMirror(100);
    schedulePreferencesMirror(100);
    expect(bridgeMocks.setUserPreferences).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);
    expect(bridgeMocks.setUserPreferences).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.setUserPreferences).toHaveBeenCalledWith(
      "en-US",
      expect.any(Array),
      null,
      null,
    );
  });
});
