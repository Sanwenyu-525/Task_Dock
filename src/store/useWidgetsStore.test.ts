// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultWidgetItems } from "../lib/widgets/model";
import { WIDGETS_STORAGE_KEY } from "../lib/widgets/storage";
import { useWidgetsStore } from "./useWidgetsStore";

function resetStore() {
  localStorage.clear();
  useWidgetsStore.setState({ widgets: defaultWidgetItems(), hydrated: false });
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
});
