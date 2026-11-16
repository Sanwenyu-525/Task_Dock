//! 通用线前端模块注册（U1）。
//!
//! 注册两个契约 §5.2 规定的模块键：
//! - `milestones`：阶段/里程碑 + 进度与交付物汇总（D2、D4）
//! - `materials`：项目资料（D3）
//!
//! 概览（`overview`）属于公共壳层，不在本文件改动。
//! 导出名称 `GENERAL_CREATIVE_MODULES` 保持契约约定不变。

import type { CreativeModuleMap } from "../types";
import MilestonesPanel from "./MilestonesPanel";
import MaterialsPanel from "./MaterialsPanel";

export const GENERAL_CREATIVE_MODULES: CreativeModuleMap = {
  milestones: MilestonesPanel,
  materials: MaterialsPanel,
};
