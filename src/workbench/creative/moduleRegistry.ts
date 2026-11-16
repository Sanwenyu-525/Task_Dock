//! 创作工作台模块注册表装配点（2026-11-16，集成负责人独占）。
//!
//! 五条开发线各自维护自己的 `modules.tsx`（导出名固定，见 `types.ts`）；
//! 本文件是**唯一**把它们挂到统一壳层的地方，避免五条线并发改
//! `ProjectWorkspacePanel.tsx`。
//!
//! 装配规则：
//! 1. 按 `kind` 分桶：同一个模块 ID（如 `assets`）在游戏与漫剧下互不干扰；
//! 2. 桶里没有对应键时，壳层渲染「尚未接入」占位（`CREATIVE_MODULE_PENDING_TEXT`），
//!    不显示空白页、不伪造数据；
//! 3. 新增领域 = 在这里加一行 import + 一个桶键，不改壳层渲染逻辑。

import type { WorkspaceKind } from "../../lib/bridge";
import { COMIC_CREATIVE_MODULES } from "./comic/modules";
import { DEV_CREATIVE_MODULES } from "./development/modules";
import { GAME_CREATIVE_MODULES } from "./game/modules";
import { GENERAL_CREATIVE_MODULES } from "./general/modules";
import { NOVEL_CREATIVE_MODULES } from "./novel/modules";
import type { CreativeModuleMap } from "./types";

/** 类型 → 该类型已交付的专业模块实现。 */
export const CREATIVE_MODULES_BY_KIND: Record<WorkspaceKind, CreativeModuleMap> = {
  novel: NOVEL_CREATIVE_MODULES,
  game: GAME_CREATIVE_MODULES,
  ai_comic: COMIC_CREATIVE_MODULES,
  general: GENERAL_CREATIVE_MODULES,
  development: DEV_CREATIVE_MODULES,
};

/** 取某类型某模块的实现；无实现时返回 undefined（由壳层降级）。 */
export function resolveCreativeModule(kind: WorkspaceKind, moduleId: string) {
  const map = CREATIVE_MODULES_BY_KIND[kind];
  if (!map) return undefined;
  return map[moduleId as keyof CreativeModuleMap] as
    | CreativeModuleMap[keyof CreativeModuleMap]
    | undefined;
}
