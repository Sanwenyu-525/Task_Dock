//! 创作工作台专业模块共享契约（B2 / G1 / C1 / U1 / D1，2026-11-16）。
//!
//! ## 归属
//! 本文件由**集成负责人**独占维护（与 workspaceProfiles.ts / ProjectWorkspacePanel.tsx /
//! bridge.ts 同级）。五条开发线只**读取**本文件的类型与常量，不得修改；确需新增模块 ID
//! 或字段，向集成负责人提需求单。
//!
//! ## 为什么需要这一层
//! 五个专业工作台不能各写一套导航与容器：统一工作台已经持有项目上下文、模块 tab、
//! 归档态、错误横幅与导航门禁。专业模块只负责**内容区**，由壳层按模块 ID 装配，
//! 这样五条线可以并行开发而不会在 `ProjectWorkspacePanel.tsx` 里互相覆盖。
//!
//! ## 两条硬规则（与 workspaceProfiles.ts 同源）
//! 1. **能力状态必须诚实**：模块渲染出按钮，才允许把对应能力升级为 available；
//!    只有登记没有适配器的能力保持 planned，界面不得渲染可点击的生成/构建按钮。
//! 2. **模块缺失必须可见降级**：注册表里没有实现的模块，壳层渲染「尚未接入」占位，
//!    不显示空白页、不静默隐藏、不伪造数据。

import type { ComponentType } from "react";
import type { WorkspaceKind } from "../../lib/bridge";

/**
 * 专业模块 ID（全部工作空间共享一张并集表）。
 *
 * 同一个 ID 可以被不同类型复用（例如 game 与 ai_comic 都用 `assets`），
 * 因为注册表按 `WorkspaceKind` 分桶，不存在跨类型串页。
 */
export type CreativeModuleId =
  // 既有模块（P1-01 起）
  | "overview"
  | "manuscript"
  | "items"
  | "links"
  | "settings"
  // 小说 B2
  | "characters"
  | "worldview"
  // 游戏 G1
  | "assets"
  | "builds"
  // AI 漫剧 C1
  | "episodes"
  | "shots"
  // 通用 U1
  | "milestones"
  | "materials"
  // 开发 D1
  | "git"
  | "agents";

/** 壳层向专业模块统一的提示通道（与 ProjectPanelNoticeKind 对齐）。 */
export type CreativeNoticeKind = "ok" | "error" | "info";

/**
 * 专业模块统一入参。
 *
 * 壳层只传**已经过项目门禁的事实**：项目 ID、类型、归档态、根目录状态。
 * 专业模块不得自行 `invoke("workspace_project_get")` 反查项目，避免二次来源。
 */
export interface CreativeModuleProps {
  /** 当前项目 ID（切项目时壳层会换 key 重挂，模块内不得缓存跨项目状态）。 */
  projectId: string;
  projectName: string;
  /** 项目类型（模块可据此二次防御：非本类型直接只读降级）。 */
  kind: WorkspaceKind;
  /** 归档项目 = 只读：所有写入口必须置灰并给出原因，不允许仅靠后端拒绝。 */
  archived: boolean;
  /** 项目根目录（可能为空 = 未设置）。 */
  rootPath: string | null;
  /** 根目录当前是否存在（false = 目录失效，只提示不阻断读取）。 */
  rootExists: boolean;
  /** 已关联的开发项目 ID（开发工作台跳转用，可能为空）。 */
  devProjectId: string | null;
  /** 统一提示通道：成功/失败/信息都走壳层横幅，便于验收观察。 */
  onNotice: (kind: CreativeNoticeKind, text: string) => void;
  /** 请求壳层切到另一个模块（跨模块跳转必须走它，不自己改 state）。 */
  switchModule: (id: CreativeModuleId) => void;
}

/** 单个类型的模块注册表：模块 ID → 内容区组件。未列出的 ID 由壳层渲染占位。 */
export type CreativeModuleMap = Partial<
  Record<CreativeModuleId, ComponentType<CreativeModuleProps>>
>;

/**
 * 每个专业领域目录必须导出的注册表名称（壳层按此名装配，写在契约里避免集成期改名）。
 *
 * - 小说：`src/workbench/creative/novel/modules.tsx` → `NOVEL_CREATIVE_MODULES`
 * - 游戏：`src/workbench/creative/game/modules.tsx` → `GAME_CREATIVE_MODULES`
 * - 漫剧：`src/workbench/creative/comic/modules.tsx` → `COMIC_CREATIVE_MODULES`
 * - 通用：`src/workbench/creative/general/modules.tsx` → `GENERAL_CREATIVE_MODULES`
 * - 开发：`src/workbench/creative/development/modules.tsx` → `DEV_CREATIVE_MODULES`
 */
export type CreativeModuleMapName =
  | "NOVEL_CREATIVE_MODULES"
  | "GAME_CREATIVE_MODULES"
  | "COMIC_CREATIVE_MODULES"
  | "GENERAL_CREATIVE_MODULES"
  | "DEV_CREATIVE_MODULES";

/** 壳层占位文案：模块已登记但实现未接入时的唯一允许展示。 */
export const CREATIVE_MODULE_PENDING_TEXT = "该模块尚未接入本轮实现，集成完成后可用。";
