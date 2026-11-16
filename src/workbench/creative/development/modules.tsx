//! 开发工作空间专业模块注册表（D1）——由开发线独占维护。
//!
//! 契约见 `../types.ts`：键必须是 `CreativeModuleId`，值是 `CreativeModuleProps` 组件。
//! 导出名称 `DEV_CREATIVE_MODULES` 保持契约约定不变；集成负责人只 import 本导出。

import type { CreativeModuleMap } from "../types";
import "./development.css";
import AgentsPanel from "./AgentsPanel";
import BuildTracePanel from "./BuildTracePanel";
import GitRiskPanel from "./GitRiskPanel";

export const DEV_CREATIVE_MODULES: CreativeModuleMap = {
  git: GitRiskPanel,
  agents: AgentsPanel,
  builds: BuildTracePanel,
};
