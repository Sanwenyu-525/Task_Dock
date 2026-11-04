import { describe, expect, it } from "vitest";

import { translate } from "../../i18n";
import {
  defaultWidgetItems,
  enabledWidgets,
  moveWidgetBy,
  moveWidgetTo,
  normalizeConfig,
  normalizeLayout,
  widgetDefinition,
  WIDGET_TYPES,
} from "./model";

describe("widget model defaults", () => {
  it("提供全部 6 个微件类型，且顺序编号连续", () => {
    const items = defaultWidgetItems();
    expect(items.map((item) => item.type)).toEqual([...WIDGET_TYPES]);
    expect(items.map((item) => item.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("默认启用现有模块微件，依赖未就绪的微件默认关闭", () => {
    const enabled = new Set(enabledWidgets(defaultWidgetItems()).map((item) => item.type));
    expect(enabled.has("today-tasks")).toBe(true);
    expect(enabled.has("next-reminder")).toBe(true);
    expect(enabled.has("agent-status")).toBe(true);
    expect(enabled.has("quick-actions")).toBe(true);
    expect(enabled.has("focus-timer")).toBe(false);
    expect(enabled.has("efficiency")).toBe(false);
  });

  it("每个类型都有标题/描述键，且中英文文案均非空", () => {
    for (const type of WIDGET_TYPES) {
      const def = widgetDefinition(type);
      expect(translate("zh-CN", def.titleKey).length).toBeGreaterThan(0);
      expect(translate("en-US", def.titleKey).length).toBeGreaterThan(0);
      expect(translate("zh-CN", def.descriptionKey).length).toBeGreaterThan(0);
      expect(translate("en-US", def.descriptionKey).length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeLayout", () => {
  it("保留已保存顺序并重排 sort_order", () => {
    const items = normalizeLayout([
      { type: "quick-actions", enabled: true, size: "lg", sort_order: 7, config: {} },
      { type: "today-tasks", enabled: false, size: "sm", sort_order: 3, config: { maxItems: 3 } },
    ]);
    expect(items[0].type).toBe("quick-actions");
    expect(items[0].sort_order).toBe(0);
    expect(items[0].size).toBe("lg");
    expect(items[1].type).toBe("today-tasks");
    expect(items[1].sort_order).toBe(1);
    expect(items[1].enabled).toBe(false);
    expect(items[1].config.maxItems).toBe(3);
  });

  it("丢弃未知类型与重复类型，并补齐缺失类型", () => {
    const items = normalizeLayout([
      { type: "not-a-widget", enabled: true },
      { type: "today-tasks", enabled: true },
      { type: "today-tasks", enabled: false, size: "lg" },
      "oops",
    ]);
    expect(items).toHaveLength(WIDGET_TYPES.length);
    expect(items.filter((item) => item.type === "today-tasks")).toHaveLength(1);
    expect(items[0].type).toBe("today-tasks");
    expect(items.map((item) => item.type)).toEqual([...WIDGET_TYPES]);
  });

  it("非法尺寸/启用值回落到默认，配置被收敛", () => {
    const items = normalizeLayout([
      { type: "today-tasks", enabled: "yes", size: "huge", config: { maxItems: 99, evil: true } },
      { type: "focus-timer", enabled: true, config: { maxItems: 5 } },
    ]);
    const tasks = items.find((item) => item.type === "today-tasks")!;
    expect(tasks.enabled).toBe(true);
    expect(tasks.size).toBe("md");
    expect(tasks.config).toEqual({ maxItems: 12 });

    const focus = items.find((item) => item.type === "focus-timer")!;
    expect(focus.config).toEqual({});
  });

  it("非数组输入回落默认布局", () => {
    const items = normalizeLayout(null);
    expect(items.map((item) => item.type)).toEqual([...WIDGET_TYPES]);
  });

  it("maxItems 只在 1..12 之间", () => {
    expect(normalizeConfig("today-tasks", { maxItems: 0 }).maxItems).toBe(1);
    expect(normalizeConfig("today-tasks", { maxItems: 4.6 }).maxItems).toBe(5);
    expect(normalizeConfig("today-tasks", { maxItems: Number.NaN }).maxItems).toBe(5);
    expect(normalizeConfig("today-tasks", { maxItems: "3" }).maxItems).toBe(5);
  });
});

describe("排序", () => {
  it("moveWidgetTo 支持首尾移动并重新编号", () => {
    const items = defaultWidgetItems();
    const toTop = moveWidgetTo(items, "efficiency", 0);
    expect(toTop[0].type).toBe("efficiency");
    expect(toTop.map((item) => item.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);

    const toBottom = moveWidgetTo(toTop, "efficiency", 99);
    expect(toBottom[5].type).toBe("efficiency");
  });

  it("moveWidgetTo 对未知 id 与同位置输入保持原数组", () => {
    const items = defaultWidgetItems();
    expect(moveWidgetTo(items, "missing", 0)).toBe(items);
    expect(moveWidgetTo(items, "today-tasks", 0)).toBe(items);
  });

  it("moveWidgetBy 在边界不越界", () => {
    const items = defaultWidgetItems();
    const stays = moveWidgetBy(items, "today-tasks", -1);
    expect(stays[0].type).toBe("today-tasks");

    const down = moveWidgetBy(items, "today-tasks", 1);
    expect(down[0].type).toBe("next-reminder");
    expect(down[1].type).toBe("today-tasks");
  });
});
