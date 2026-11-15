//! Profile 图标 token → lucide 组件（2026-11-15，A 阶段）。
//!
//! `workspaceProfiles.ts` 是纯数据（不依赖 React），只声明图标 token；
//! 真实图标映射收敛在这里，新增类型时必须同步补一行，避免「类型里加了
//! `book-open`、界面却仍显示默认文件夹」的声明漂移。
//! 缺失/未知 token 回落到 `layers`（与通用 Profile 一致，不显示空白图标）。

import { BookOpen, Clapperboard, Code2, Gamepad2, Layers, type LucideIcon } from "lucide-react";

import type { WorkspaceProfile } from "./workspaceProfiles";

export const WORKSPACE_PROFILE_ICONS: Record<WorkspaceProfile["icon"], LucideIcon> = {
  code: Code2,
  gamepad: Gamepad2,
  clapperboard: Clapperboard,
  layers: Layers,
  "book-open": BookOpen,
};

export function workspaceProfileIcon(icon: WorkspaceProfile["icon"]): LucideIcon {
  return WORKSPACE_PROFILE_ICONS[icon] ?? Layers;
}
