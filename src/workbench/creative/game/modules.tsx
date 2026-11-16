//! 游戏工作空间专业模块注册表（G1）——由游戏线独占维护。
//!
//! 契约见 `../types.ts`。集成负责人只 import 本导出，不修改本文件。

import type { CreativeModuleMap } from "../types";

export const GAME_CREATIVE_MODULES: CreativeModuleMap = {};
