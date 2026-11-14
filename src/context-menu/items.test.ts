//! 菜单配置层的结构守卫：分组完整、动作唯一、勾选语义与初始焦点。

import { describe, expect, it } from "vitest";
import {
  FLAT_ITEMS,
  MENU_GROUPS,
  TAB_FLAT_ITEMS,
  TAB_MENU_GROUPS,
  flatItemsFor,
  groupLabel,
  initialActiveIndex,
  isItemChecked,
  itemLabel,
  showsGroupLabels,
  validateMenuConfig,
  validateTabMenuConfig,
  type MenuSnapshot,
} from "./items";

const snap: MenuSnapshot = {
  mode: "compact",
  theme: "system",
  autostart: true,
  visual_preset: "liquid-glass",
  snap_display_mode: "capsule",
};

describe("菜单配置结构", () => {
  it("按规范提供五组、共 14 项", () => {
    expect(MENU_GROUPS.map((g) => g.label)).toEqual([
      "常用操作",
      "界面形态",
      "吸附方式",
      "外观与系统",
      "退出操作",
    ]);
    expect(FLAT_ITEMS).toHaveLength(14);
    expect(FLAT_ITEMS.some((it) => it.action === "quick-capture")).toBe(true);
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
    // 形态收敛：打开完整工作台是一次性动作，不参与任何勾选组
    const openWorkbench = byAction.get("open-workbench")!;
    expect(openWorkbench).toBeTruthy();
    expect(openWorkbench.radio).toBeUndefined();
    expect(openWorkbench.toggle).toBeUndefined();
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
    // compact（界面形态组，兼容项殿后）在快照里勾选，按展平序定位
    expect(initialActiveIndex(snap)).toBe(FLAT_ITEMS.findIndex((it) => it.action === "mode:compact"));
  });

  it("吸附方式缺省时按「胶囊隐藏」勾选（老库兼容）", () => {
    // 除吸附方式外都无勾选：`snap_display_mode` 为空按 capsule 处理，
    // 因此落点在吸附组的「胶囊隐藏」，而不是第一项。
    expect(
      initialActiveIndex({
        mode: "",
        theme: "",
        autostart: false,
        visual_preset: "",
        snap_display_mode: "",
      }),
    ).toBe(FLAT_ITEMS.findIndex((it) => it.action === "snap-form:capsule"));
  });
});

// ── 极简标签快捷菜单（tab 变体）────────────────────────────────
//
// 契约：恰好三项、动作唯一且都在 `tab:` 命名空间、不带勾选语义、
// 条目文案必须可本地化。这三条对应验收标准「不增加第四个常驻菜单功能」。

describe("tab 变体结构", () => {
  it("恰好三项，顺序为 展开 / 完整面板 / 退出吸附", () => {
    expect(TAB_FLAT_ITEMS.map((it) => it.action)).toEqual([
      "tab:expand",
      "tab:full",
      "tab:undock",
    ]);
    expect(TAB_MENU_GROUPS).toHaveLength(1);
    expect(TAB_MENU_GROUPS[0].items).toHaveLength(3);
  });

  it("结构守卫无问题", () => {
    expect(validateTabMenuConfig()).toEqual([]);
  });

  it("托盘菜单不受影响（仍是五组 14 项）", () => {
    expect(validateMenuConfig()).toEqual([]);
    expect(flatItemsFor("tray")).toHaveLength(14);
    expect(flatItemsFor("tab")).toHaveLength(3);
  });

  it("tab 变体不渲染分组标题（三项不需要分组）", () => {
    expect(showsGroupLabels("tab")).toBe(false);
    expect(showsGroupLabels("tray")).toBe(true);
  });

  it("初始焦点恒为第一项（无勾选语义）", () => {
    expect(initialActiveIndex(snap, "tab")).toBe(0);
    expect(initialActiveIndex(null, "tab")).toBe(0);
  });

  it("文案通过 labelKey 在渲染时解析（跟随界面语言）", () => {
    const expand = TAB_FLAT_ITEMS[0];
    expect(expand.labelKey).toBe("capsule.tabMenu.expand");
    expect(itemLabel(expand)).toBe("展开工具面板");
    expect(groupLabel(TAB_MENU_GROUPS[0])).toBe("极简标签");
  });
});
