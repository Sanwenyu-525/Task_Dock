//! 小说工作空间专业模块注册表（B2）——由小说线独占维护。
//!
//! 契约见 `../types.ts`：键必须是 `CreativeModuleId`，值是 `CreativeModuleProps` 组件。
//! 集成负责人只在 `../moduleRegistry.ts` 里 import 本导出，不会修改本文件。

import type { CreativeModuleMap } from "../types";
import "./novel.css";
import { CharactersPanel } from "./CharactersPanel";
import { WorldviewPanel } from "./WorldviewPanel";

export const NOVEL_CREATIVE_MODULES: CreativeModuleMap = {
  characters: CharactersPanel,
  worldview: WorldviewPanel,
};
