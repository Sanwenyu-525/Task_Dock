//! 注册中心一致性契约：入口身份、归属、默认顺序与快捷键展示。
//!
//! 这些断言锁住「唯一元数据源」的边界：任何新增入口必须补齐左侧归属与默认值，
//! 且不得改变已发布的 Ctrl+数字语义。

import { describe, expect, it } from "vitest";
import {
  NAV_ENTRIES,
  allEntryIds,
  defaultVisibleIds,
  entriesForSurface,
  leftEntryForTab,
  navEntry,
  navLabel,
  type NavSurface,
} from "./navigationRegistry";
import { RAIL_ORDER, TAB_ORDER } from "../store/useUiStore";
import { translate } from "../i18n";

/** 按已发布 TAB_ORDER 推导某逻辑 Tab 的展示快捷键（Ctrl+1…9、Ctrl+0）。 */
function shortcutForTab(tab: string): string | null {
  const index = TAB_ORDER.indexOf(tab as never);
  if (index < 0) return null;
  return index === 9 ? "Ctrl+0" : `Ctrl+${index + 1}`;
}

describe("导航注册中心", () => {
  it("入口 ID 唯一，界面声明合法，胶囊入口均有分类身份", () => {
    const ids = NAV_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of NAV_ENTRIES) {
      expect(entry.surfaces.length).toBeGreaterThan(0);
      for (const surface of entry.surfaces) {
        expect(["left", "capsule"]).toContain(surface);
      }
      if (entry.surfaces.includes("capsule")) {
        expect(entry.capsuleCategory).toBeTruthy();
      }
    }
  });

  it("每个逻辑 Tab 都有左侧入口（inbox/shelf 由合并入口覆盖）", () => {
    for (const tab of TAB_ORDER) {
      const entry = leftEntryForTab(tab);
      expect(entry, `缺少左侧入口：${tab}`).toBeTruthy();
      expect(entry?.surfaces).toContain("left");
    }
  });

  it("左侧视觉顺序与已发布 RAIL_ORDER 完全一致", () => {
    const flattened = entriesForSurface("left").flatMap((entry) => [...entry.tabs]);
    expect(flattened).toEqual([...RAIL_ORDER]);
  });

  it("各界面默认顺序唯一，且默认可见入口来自该界面", () => {
    const surfaces: NavSurface[] = ["left", "capsule"];
    for (const surface of surfaces) {
      const orders = entriesForSurface(surface).map((entry) => entry.defaults[surface].order);
      expect(new Set(orders).size).toBe(orders.length);
      expect(defaultVisibleIds(surface)).toEqual(
        entriesForSurface(surface)
          .filter((entry) => entry.defaults[surface].visible)
          .map((entry) => entry.id),
      );
      expect(allEntryIds(surface)).toEqual(entriesForSurface(surface).map((entry) => entry.id));
    }
  });

  it("快捷键展示与 TAB_ORDER 一一对应，视觉入口不占用数字键", () => {
    for (const entry of entriesForSurface("left")) {
      const expected =
        entry.tabs
          .map((tab) => shortcutForTab(tab))
          .filter((value): value is string => value !== null)
          .join(" / ") || undefined;
      expect(entry.shortcut, `${entry.id} 快捷键展示漂移`).toBe(expected);
    }
  });

  it("按 ID 查询不会把未知入口当作已注册", () => {
    expect(navEntry("tasks")?.label).toBe("任务");
    expect(navEntry("not-a-real-entry")).toBeUndefined();
  });

  it("每个入口都有唯一翻译 Key；中英文标签由 Key 决定，ID/顺序/快捷键不受影响", () => {
    const keys = NAV_ENTRIES.map((entry) => entry.labelKey);
    expect(keys.every((key) => typeof key === "string" && key.startsWith("nav."))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);

    const before = NAV_ENTRIES.map((entry) => ({
      id: entry.id,
      label: entry.label,
      order: entry.defaults.left.order,
      shortcut: entry.shortcut,
    }));
    expect(navLabel(navEntry("tasks")!, (key) => translate("zh-CN", key))).toBe("任务");
    expect(navLabel(navEntry("tasks")!, (key) => translate("en-US", key))).toBe("Tasks");
    expect(navLabel(navEntry("settings")!, (key) => translate("en-US", key))).toBe("Settings");
    // 翻译 Key 只是文案层，入口身份元数据不变
    expect(
      NAV_ENTRIES.map((entry) => ({
        id: entry.id,
        label: entry.label,
        order: entry.defaults.left.order,
        shortcut: entry.shortcut,
      })),
    ).toEqual(before);
  });
});
