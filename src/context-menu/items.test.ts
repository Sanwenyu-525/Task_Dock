//! 菜单配置层的结构守卫：分组完整、动作唯一、勾选语义与初始焦点。

import { describe, expect, it } from "vitest";
import {
  FLAT_ITEMS,
  MENU_GROUPS,
  initialActiveIndex,
  isItemChecked,
  validateMenuConfig,
  type MenuSnapshot,
} from "./items";

const snap: MenuSnapshot = {
  mode: "compact",
  theme: "system",
  autostart: true,
  visual_preset: "liquid-glass",
};

describe("菜单配置结构", () => {
  it("按规范提供四组、共 10 项", () => {
    expect(MENU_GROUPS.map((g) => g.label)).toEqual([
      "常用操作",
      "布局模式",
      "外观与系统",
      "退出操作",
    ]);
    expect(FLAT_ITEMS).toHaveLength(10);
  });

  it("通过配置校验（动作唯一、单选组非空）", () => {
    expect(validateMenuConfig()).toEqual([]);
  });

  it("每个动作都有唯一 key，且单选组覆盖全部模式与主题", () => {
    const byAction = new Map(FLAT_ITEMS.map((it) => [it.action, it]));
    expect(byAction.size).toBe(FLAT_ITEMS.length);
    for (const a of ["mode:minimal", "mode:compact", "mode:full"] as const) {
      expect(byAction.get(a)?.radio).toBe("mode");
    }
    for (const a of ["theme:light", "theme:dark", "theme:system"] as const) {
      expect(byAction.get(a)?.radio).toBe("theme");
    }
    expect(byAction.get("autostart")?.toggle).toBe("autostart");
  });
});

describe("isItemChecked", () => {
  it("单选组按快照字段比较", () => {
    const compact = FLAT_ITEMS.find((it) => it.action === "mode:compact")!;
    const full = FLAT_ITEMS.find((it) => it.action === "mode:full")!;
    const system = FLAT_ITEMS.find((it) => it.action === "theme:system")!;
    const dark = FLAT_ITEMS.find((it) => it.action === "theme:dark")!;
    expect(isItemChecked(compact, snap)).toBe(true);
    expect(isItemChecked(full, snap)).toBe(false);
    expect(isItemChecked(system, snap)).toBe(true);
    expect(isItemChecked(dark, snap)).toBe(false);
  });

  it("开机自启动是独立开关，不混入主题单选", () => {
    const autostart = FLAT_ITEMS.find((it) => it.action === "autostart")!;
    expect(isItemChecked(autostart, snap)).toBe(true);
    expect(isItemChecked(autostart, { ...snap, autostart: false })).toBe(false);
    // 主题单选变化不影响自启动
    expect(isItemChecked(autostart, { ...snap, theme: "dark" })).toBe(true);
  });

  it("普通动作项恒不勾选", () => {
    const quit = FLAT_ITEMS.find((it) => it.action === "quit")!;
    expect(isItemChecked(quit, snap)).toBe(false);
  });
});

describe("initialActiveIndex", () => {
  it("无快照时落在第一项", () => {
    expect(initialActiveIndex(null)).toBe(0);
  });

  it("优先第一个勾选项", () => {
    // compact（布局组）在快照里勾选，位于展平序的第 3 项
    expect(initialActiveIndex(snap)).toBe(FLAT_ITEMS.findIndex((it) => it.action === "mode:compact"));
  });

  it("无任何勾选（极端快照）回落第一项", () => {
    expect(initialActiveIndex({ mode: "", theme: "", autostart: false, visual_preset: "" })).toBe(0);
  });
});
