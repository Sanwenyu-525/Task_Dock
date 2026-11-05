// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultWidgetItems,
  desktopPresetSize,
  resolveDesktopWindowSize,
} from "../lib/widgets/model";
import { WIDGETS_STORAGE_KEY } from "../lib/widgets/storage";
import { useWidgetsStore } from "./useWidgetsStore";

function resetStore() {
  localStorage.clear();
  useWidgetsStore.setState({
    widgets: defaultWidgetItems(),
    hydrated: false,
    persistError: null,
    desktopResetSeq: {},
    desktopRetrySeq: {},
    desktopRuntime: {},
  });
}

function storedLayout(): { version: number; widgets: unknown[] } | null {
  const raw = localStorage.getItem(WIDGETS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { version: number; widgets: unknown[] }) : null;
}

function findStored(type: string) {
  return storedLayout()?.widgets.find(
    (item) => typeof item === "object" && item !== null && (item as { type?: string }).type === type,
  ) as Record<string, unknown> | undefined;
}

beforeEach(resetStore);

describe("hydrate", () => {
  it("读取已保存布局并补齐缺失类型", () => {
    localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        widgets: [
          { type: "today-tasks", enabled: false, size: "lg", config: { maxItems: 8 }, sort_order: 9 },
        ],
      }),
    );

    useWidgetsStore.getState().hydrate();

    const state = useWidgetsStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.widgets).toHaveLength(6);
    const tasks = state.widgets.find((item) => item.type === "today-tasks")!;
    expect(tasks.enabled).toBe(false);
    expect(tasks.size).toBe("lg");
    expect(tasks.config.maxItems).toBe(8);
    expect(state.widgets.map((item) => item.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("损坏 JSON 与旧版本回落默认布局", () => {
    localStorage.setItem(WIDGETS_STORAGE_KEY, "{not-json");
    useWidgetsStore.getState().hydrate();
    expect(useWidgetsStore.getState().widgets.map((item) => item.type)).toEqual(
      defaultWidgetItems().map((item) => item.type),
    );

    resetStore();
    localStorage.setItem(WIDGETS_STORAGE_KEY, JSON.stringify({ version: 99, widgets: [] }));
    useWidgetsStore.getState().hydrate();
    expect(useWidgetsStore.getState().widgets.map((item) => item.type)).toEqual(
      defaultWidgetItems().map((item) => item.type),
    );
  });

  it("动作在 hydrate 之前会先读取已保存布局", () => {
    localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({ version: 1, widgets: [{ type: "today-tasks", enabled: false }] }),
    );

    useWidgetsStore.getState().toggle("today-tasks");

    const state = useWidgetsStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.widgets.find((item) => item.type === "today-tasks")!.enabled).toBe(true);
  });
});

describe("布局变更与持久化", () => {
  it("启用/停用会立即写回存储", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().toggle("agent-status", false);

    expect(
      useWidgetsStore.getState().widgets.find((item) => item.type === "agent-status")!.enabled,
    ).toBe(false);
    expect(findStored("agent-status")?.enabled).toBe(false);
  });

  it("尺寸与条目配置会立即写回存储", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().setSize("today-tasks", "lg");
    useWidgetsStore.getState().setConfig("today-tasks", { maxItems: 8 });

    expect(findStored("today-tasks")?.size).toBe("lg");
    expect((findStored("today-tasks")?.config as { maxItems?: number }).maxItems).toBe(8);
  });

  it("拖动排序会改变顺序并重新编号", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().moveTo("efficiency", 0);

    const state = useWidgetsStore.getState();
    expect(state.widgets[0].type).toBe("efficiency");
    expect(state.widgets.map((item) => item.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(findStored("efficiency")?.sort_order).toBe(0);
  });

  it("上移/下移在边界保持稳定", () => {
    useWidgetsStore.getState().hydrate();
    const before = useWidgetsStore.getState().widgets.map((item) => item.type);
    useWidgetsStore.getState().moveBy("today-tasks", -1);
    expect(useWidgetsStore.getState().widgets.map((item) => item.type)).toEqual(before);

    useWidgetsStore.getState().moveBy("today-tasks", 1);
    expect(useWidgetsStore.getState().widgets[0].type).toBe("next-reminder");
  });

  it("恢复默认布局会重置顺序/尺寸/配置", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().moveTo("efficiency", 0);
    useWidgetsStore.getState().setSize("today-tasks", "lg");
    useWidgetsStore.getState().setConfig("today-tasks", { maxItems: 8 });
    useWidgetsStore.getState().toggle("focus-timer", true);

    useWidgetsStore.getState().reset();

    const state = useWidgetsStore.getState();
    expect(state.widgets.map((item) => item.type)).toEqual(
      defaultWidgetItems().map((item) => item.type),
    );
    expect(state.widgets.find((item) => item.type === "today-tasks")!.size).toBe("md");
    expect(state.widgets.find((item) => item.type === "today-tasks")!.config.maxItems).toBe(5);
    expect(state.widgets.find((item) => item.type === "focus-timer")!.enabled).toBe(false);
    expect(findStored("today-tasks")?.size).toBe("md");
  });

  it("存储不可用时只影响持久化，布局在内存中仍生效", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      useWidgetsStore.getState().hydrate();
      useWidgetsStore.getState().toggle("quick-actions", false);
      expect(
        useWidgetsStore.getState().widgets.find((item) => item.type === "quick-actions")!.enabled,
      ).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });

  it("写盘失败会暴露 persistError，下一次成功写入后清除", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      useWidgetsStore.getState().hydrate();
      useWidgetsStore.getState().setDesktop("agent-status", { visible: true });
      expect(useWidgetsStore.getState().persistError).toBeTruthy();
      expect(
        useWidgetsStore.getState().widgets.find((item) => item.type === "agent-status")!.desktop
          .visible,
      ).toBe(true);
    } finally {
      setItem.mockRestore();
    }
    useWidgetsStore.getState().setDesktop("agent-status", { topmost: true });
    expect(useWidgetsStore.getState().persistError).toBeNull();
  });
});

describe("桌面尺寸三态", () => {
  it("切换预设立即放弃手动缩放的自定义宽高", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().setDesktop("today-tasks", { width: 500, height: 320 });
    expect(
      useWidgetsStore.getState().widgets.find((item) => item.type === "today-tasks")!.desktop,
    ).toMatchObject({ width: 500, height: 320 });

    useWidgetsStore.getState().setSize("today-tasks", "md");

    const item = useWidgetsStore.getState().widgets.find((entry) => entry.type === "today-tasks")!;
    expect(item.size).toBe("md");
    expect(item.desktop.width).toBeUndefined();
    expect(item.desktop.height).toBeUndefined();
    expect(resolveDesktopWindowSize("today-tasks", item.size, item.desktop)).toEqual(
      desktopPresetSize("today-tasks", "md"),
    );
  });
});

describe("桌面显示与看板启用相互独立", () => {
  it("旧布局缺少 desktop 字段时补齐安全默认（不显示/不置顶）", () => {
    localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        widgets: [{ type: "today-tasks", enabled: true, size: "md" }],
      }),
    );

    useWidgetsStore.getState().hydrate();

    for (const item of useWidgetsStore.getState().widgets) {
      expect(item.desktop.visible).toBe(false);
      expect(item.desktop.topmost).toBe(false);
      expect(item.desktop.nx).toBeUndefined();
      expect(item.desktop.ny).toBeUndefined();
    }
  });

  it("关闭看板卡片不会清除桌面显示配置", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().setDesktop("today-tasks", { visible: true, topmost: true });
    useWidgetsStore.getState().toggle("today-tasks", false);

    const item = useWidgetsStore.getState().widgets.find((it) => it.type === "today-tasks")!;
    expect(item.enabled).toBe(false);
    expect(item.desktop.visible).toBe(true);
    expect(findStored("today-tasks")?.desktop).toMatchObject({ visible: true, topmost: true });
  });

  it("关闭桌面显示不会停用看板卡片", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().setDesktop("agent-status", { visible: true });
    useWidgetsStore.getState().setDesktop("agent-status", { visible: false });

    const item = useWidgetsStore.getState().widgets.find((it) => it.type === "agent-status")!;
    expect(item.enabled).toBe(true);
    expect(item.desktop.visible).toBe(false);
  });

  it("重置位置清空锚点与显示器并递增内存计数（不落盘计数）", () => {
    useWidgetsStore.getState().hydrate();
    useWidgetsStore.getState().setDesktop("efficiency", {
      visible: true,
      nx: 0.4,
      ny: 0.3,
      monitor: "DISPLAY2",
    });

    useWidgetsStore.getState().resetDesktopPosition("efficiency");

    const item = useWidgetsStore.getState().widgets.find((it) => it.type === "efficiency")!;
    expect(item.desktop.visible).toBe(true);
    expect(item.desktop.nx).toBeUndefined();
    expect(item.desktop.monitor).toBeUndefined();
    expect(useWidgetsStore.getState().desktopResetSeq.efficiency).toBe(1);
    expect(findStored("efficiency")?.desktop).not.toHaveProperty("nx");
    expect(findStored("efficiency")).not.toHaveProperty("desktopResetSeq");
  });
});
