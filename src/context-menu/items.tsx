//! 菜单配置层：只描述「有哪些项、怎么分组、勾选语义」，与业务动作解耦。
//! 动作字符串与 Rust context_menu_action 一一对应，执行统一由
//! ContextMenuApp.runAction 走 invoke，不在此处触达任何状态源。
//!
//! 两个变体共用同一个弹窗（窗口、样式、键盘导航、关闭路径都不复制第二套）：
//! - `tray`：托盘/悬浮栏右键的完整菜单（分组 + 勾选态，读设置快照）；
//! - `tab`：极简标签右键的**三项快捷操作**，无勾选态、无分组标题，
//!   动作由主窗吸附引擎执行（菜单只发命令，不持有窗口状态）。

import {
  Expand,
  Eye,
  Minus,
  Monitor,
  Moon,
  PanelsTopLeft,
  PinOff,
  Plus,
  Power,
  Rocket,
  Shrink,
  Square,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { t, type MessageKey } from "../i18n";

export type MenuAction =
  | "show"
  | "quick-add"
  | "quick-capture"
  | "mode:minimal"
  | "mode:compact"
  | "mode:full"
  | "theme:light"
  | "theme:dark"
  | "theme:system"
  | "snap-form:capsule"
  | "snap-form:full"
  | "autostart"
  | "quit"
  // 极简标签（tab 变体）三项：后端只转发给主窗吸附引擎，不复制业务逻辑
  | "tab:expand"
  | "tab:full"
  | "tab:undock";

/** 菜单变体：同一个弹窗窗口，两套条目。 */
export type MenuVariant = "tray" | "tab";

export interface MenuItemDef {
  key: string;
  label: string;
  icon: LucideIcon;
  action: MenuAction;
  /**
   * 需要随界面语言变化的条目用它代替固定的 `label`：文案在**渲染时**解析，
   * 不用模块加载时的语言快照（托盘菜单的历史条目仍是固定中文，不改动）。
   */
  labelKey?: MessageKey;
  /** 单选组：勾选 = 快照对应字段 === 动作参数（mode / theme / snapForm） */
  radio?: "mode" | "theme" | "snapForm";
  /** 开关型：独立于单选组，勾选 = 快照布尔字段（autostart） */
  toggle?: "autostart";
}

export interface MenuGroupDef {
  key: string;
  label: string;
  labelKey?: MessageKey;
  items: readonly MenuItemDef[];
}

export interface MenuSnapshot {
  mode: string;
  theme: string;
  autostart: boolean;
  visual_preset: string;
  snap_display_mode: string;
}

/** 分组结构：常用操作 / 布局模式 / 吸附方式 / 外观与系统 / 退出操作。 */
export const MENU_GROUPS: readonly MenuGroupDef[] = [
  {
    key: "common",
    label: "常用操作",
    items: [
      { key: "show", label: "显示 / 隐藏", icon: Eye, action: "show" },
      { key: "quick-add", label: "快速添加任务", icon: Plus, action: "quick-add" },
      { key: "quick-capture", label: "快速捕获", icon: Zap, action: "quick-capture" },
    ],
  },
  {
    key: "layout",
    label: "布局模式",
    items: [
      { key: "mode-minimal", label: "极简模式", icon: Minus, action: "mode:minimal", radio: "mode" },
      { key: "mode-compact", label: "紧凑模式", icon: Square, action: "mode:compact", radio: "mode" },
      { key: "mode-full", label: "完整模式", icon: PanelsTopLeft, action: "mode:full", radio: "mode" },
    ],
  },
  {
    key: "snap",
    label: "吸附方式",
    items: [
      {
        key: "snap-form-capsule",
        label: "胶囊隐藏",
        icon: Shrink,
        action: "snap-form:capsule",
        radio: "snapForm",
      },
      {
        key: "snap-form-full",
        label: "完整面板",
        icon: Expand,
        action: "snap-form:full",
        radio: "snapForm",
      },
    ],
  },
  {
    key: "appearance",
    label: "外观与系统",
    items: [
      { key: "theme-light", label: "浅色主题", icon: Sun, action: "theme:light", radio: "theme" },
      { key: "theme-dark", label: "深色主题", icon: Moon, action: "theme:dark", radio: "theme" },
      { key: "theme-system", label: "跟随系统", icon: Monitor, action: "theme:system", radio: "theme" },
      { key: "autostart", label: "开机自启动", icon: Rocket, action: "autostart", toggle: "autostart" },
    ],
  },
  {
    key: "exit",
    label: "退出操作",
    items: [{ key: "quit", label: "退出", icon: Power, action: "quit" }],
  },
];

/** 展平后的菜单项（键盘导航按此顺序，与视觉顺序一致）。 */
export const FLAT_ITEMS: readonly MenuItemDef[] = MENU_GROUPS.flatMap((g) => g.items);

/**
 * 极简标签快捷菜单：**只有三项**，不增加第四个常驻功能。
 * 标签只有「展开 / 完整面板 / 解除吸附」三种有意义的去向，
 * 主题、模式、自启动等长期偏好仍走托盘菜单与设置页。
 */
export const TAB_MENU_GROUPS: readonly MenuGroupDef[] = [
  {
    key: "tab",
    label: "",
    labelKey: "capsule.tabMenu.group",
    items: [
      { key: "tab-expand", label: "", labelKey: "capsule.tabMenu.expand", icon: Expand, action: "tab:expand" },
      {
        key: "tab-full",
        label: "",
        labelKey: "capsule.tabMenu.full",
        icon: PanelsTopLeft,
        action: "tab:full",
      },
      { key: "tab-undock", label: "", labelKey: "capsule.tabMenu.undock", icon: PinOff, action: "tab:undock" },
    ],
  },
];

/** tab 变体的展平项（键盘导航顺序）。 */
export const TAB_FLAT_ITEMS: readonly MenuItemDef[] = TAB_MENU_GROUPS.flatMap((g) => g.items);

/** 按变体取分组与展平项：菜单组件只读这两个函数，不各自维护一份列表。 */
export function menuGroupsFor(variant: MenuVariant): readonly MenuGroupDef[] {
  return variant === "tab" ? TAB_MENU_GROUPS : MENU_GROUPS;
}

export function flatItemsFor(variant: MenuVariant): readonly MenuItemDef[] {
  return variant === "tab" ? TAB_FLAT_ITEMS : FLAT_ITEMS;
}

/** 变体是否展示分组标题（极简标签只有一组三项，标题是冗余信息）。 */
export function showsGroupLabels(variant: MenuVariant): boolean {
  return variant !== "tab";
}

/** 条目文案在渲染时解析：带 `labelKey` 的条目跟随当前界面语言。 */
export function itemLabel(item: MenuItemDef): string {
  return item.labelKey ? t(item.labelKey) : item.label;
}

/** 分组文案同上（tab 变体不渲染分组标题，但 aria-label 仍需要文案）。 */
export function groupLabel(group: MenuGroupDef): string {
  return group.labelKey ? t(group.labelKey) : group.label;
}

/** 该项当前是否勾选：单选组比较快照字段，开关型读布尔字段，普通项恒否。 */
export function isItemChecked(item: MenuItemDef, snap: MenuSnapshot): boolean {
  if (item.radio === "mode") return snap.mode === item.action.slice("mode:".length);
  if (item.radio === "theme") return snap.theme === item.action.slice("theme:".length);
  if (item.radio === "snapForm") {
    // 老库/缺省设置按「胶囊隐藏」展示勾选，与后端默认值一致。
    const form = snap.snap_display_mode === "full" ? "full" : "capsule";
    return form === item.action.slice("snap-form:".length);
  }
  if (item.toggle === "autostart") return snap.autostart;
  return false;
}

/** 打开时的初始焦点：优先第一个勾选项（单选/开关），否则第一项。 */
export function initialActiveIndex(snap: MenuSnapshot | null, variant: MenuVariant = "tray"): number {
  const items = flatItemsFor(variant);
  if (!snap || variant === "tab") return 0;
  const idx = items.findIndex((it) => isItemChecked(it, snap));
  return idx >= 0 ? idx : 0;
}

/** 单选组内必须恰好有一个勾选、动作不重复 —— 供结构守卫测试与运行时校验。 */
export function validateMenuConfig(): string[] {
  const problems: string[] = [];
  const seenActions = new Set<string>();
  for (const item of FLAT_ITEMS) {
    if (seenActions.has(item.action)) problems.push(`动作重复: ${item.action}`);
    seenActions.add(item.action);
  }
  for (const group of ["mode", "theme", "snapForm"] as const) {
    const radios = FLAT_ITEMS.filter((it) => it.radio === group);
    if (radios.length === 0) problems.push(`单选组 ${group} 为空`);
  }
  if (seenActions.size !== FLAT_ITEMS.length) problems.push("存在无效动作项");
  return problems;
}

/**
 * tab 变体的结构守卫：**恰好三项**、动作不重复、不带勾选语义。
 * 这三条是验收契约（「不增加第四个常驻菜单功能」），随单测一起锁定。
 */
export function validateTabMenuConfig(): string[] {
  const problems: string[] = [];
  if (TAB_FLAT_ITEMS.length !== 3) problems.push(`tab 菜单必须恰好 3 项，实际 ${TAB_FLAT_ITEMS.length}`);
  const seen = new Set<string>();
  for (const item of TAB_FLAT_ITEMS) {
    if (seen.has(item.action)) problems.push(`动作重复: ${item.action}`);
    seen.add(item.action);
    if (!item.action.startsWith("tab:")) problems.push(`动作不属于 tab 命名空间: ${item.action}`);
    if (item.radio || item.toggle) problems.push(`tab 菜单不应有勾选语义: ${item.action}`);
    if (!item.labelKey) problems.push(`tab 菜单条目必须可本地化: ${item.key}`);
  }
  return problems;
}
