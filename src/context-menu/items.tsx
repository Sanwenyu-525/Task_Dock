//! 菜单配置层：只描述「有哪些项、怎么分组、勾选语义」，与业务动作解耦。
//! 动作字符串与 Rust context_menu_action 一一对应，执行统一由
//! ContextMenuApp.runAction 走 invoke，不在此处触达任何状态源。

import {
  Expand,
  Eye,
  Minus,
  Monitor,
  Moon,
  PanelsTopLeft,
  Plus,
  Power,
  Rocket,
  Shrink,
  Square,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";

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
  | "quit";

export interface MenuItemDef {
  key: string;
  label: string;
  icon: LucideIcon;
  action: MenuAction;
  /** 单选组：勾选 = 快照对应字段 === 动作参数（mode / theme / snapForm） */
  radio?: "mode" | "theme" | "snapForm";
  /** 开关型：独立于单选组，勾选 = 快照布尔字段（autostart） */
  toggle?: "autostart";
}

export interface MenuGroupDef {
  key: string;
  label: string;
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
export function initialActiveIndex(snap: MenuSnapshot | null): number {
  if (!snap) return 0;
  const idx = FLAT_ITEMS.findIndex((it) => isItemChecked(it, snap));
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
