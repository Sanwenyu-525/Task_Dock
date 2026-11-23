//! AI 漫剧工作空间专业模块注册表（C1）——由漫剧线独占维护。
//!
//! 契约见 `../types.ts`：键必须是 `CreativeModuleId`，值是 `CreativeModuleProps` 组件。
//! 集成负责人只在 `../moduleRegistry.ts` 里 import 本导出，不会修改本文件。

import type { CreativeModuleMap } from "../types";
import "./comic.css";
import { EpisodesPanel } from "./EpisodesPanel";
import { ShotsPanel } from "./ShotsPanel";
import { CharactersPanel } from "./CharactersPanel";
import { AssetsPanel } from "./AssetsPanel";
import { PromptsPanel } from "./PromptsPanel";

export const COMIC_CREATIVE_MODULES: CreativeModuleMap = {
  episodes: EpisodesPanel,
  shots: ShotsPanel,
  characters: CharactersPanel,
  assets: AssetsPanel,
  prompts: PromptsPanel,
};
