//! 游戏工作空间专业模块注册表（G1）——由游戏线独占维护。
//!
//! 契约见 `../types.ts`：键必须是 `CreativeModuleId`，值是 `CreativeModuleProps` 组件。
//! 本轮只注册 `assets`（资源）与 `builds`（构建与测试）两个键；集成负责人只在
//! `../moduleRegistry.ts` 里 import 本导出，不会修改本文件。

import type { CreativeModuleMap } from "../types";
import "./game.css";
import GameAssetsPanel from "./GameAssetsPanel";
import GameBuildsPanel from "./GameBuildsPanel";

export const GAME_CREATIVE_MODULES: CreativeModuleMap = {
  assets: GameAssetsPanel,
  builds: GameBuildsPanel,
};
