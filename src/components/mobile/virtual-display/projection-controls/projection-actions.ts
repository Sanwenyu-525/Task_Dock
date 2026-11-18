//! 投屏控制栏动作清单（任务七：功能归类 + 去重 + 按真实能力生成菜单）。
//!
//! 功能清单（本轮清点，2026-11-19）：
//!
//! | 按钮 | 触发 | IPC | 结果 | 重复 | 保留 |
//! |---|---|---|---|---|---|
//! | 返回 | onNavigate("back") | vd_projection_dispatch → vd_nav | Android 返回键 | 否 | 一级 |
//! | Home | onNavigate("home") | 同上 | Android Home | 否 | 一级 |
//! | 最近任务 | onNavigate("recents") | 同上（能力拒绝时不发） | 最近任务 | 否 | 一级（虚拟屏禁用+原因） |
//! | 截屏 | onScreenshot | vd_toolbar_screenshot → vd_screenshot | 会话卡预览 | 原「更多」里重复 → 提升为一级 | 二级→一级 |
//! | 更多 | onMore | 本地 UI | 会话信息/诊断/结束投屏 | 是 | 保留（次级功能 ≥2） |
//! | 锁定 | onToggleLock | vd_toolbar_set_locked | 全屏自动隐藏开关 | 是（自动隐藏已随一体化删除） | **删除** |
//! | 关闭 ✕ | onClose | vd_stop | 结束会话 | 与原生窗口关闭、菜单「结束投屏」重复 | **从一级行删除**（保留菜单项） |
//!
//! Windows 原生窗口已提供最小化/最大化/关闭，绝不重复放进更多菜单。

import type { ProjectionCapabilities } from "./types";

export type ProjectionActionId =
  | "back"
  | "home"
  | "recents"
  | "screenshot"
  | "more"
  | "end";

export interface ProjectionActionDefinition {
  id: ProjectionActionId;
  /** 一级行（导航/截屏）还是次级菜单。 */
  tier: "primary" | "secondary";
  /** locale key（projectionToolbar.*）。 */
  labelKey: string;
  /** 是否依赖能力位。 */
  requires: keyof ProjectionCapabilities | null;
}

/** 全量动作定义：由能力过滤后生成真实可用清单，不允许硬编码「全部支持」。 */
const ACTION_DEFINITIONS: readonly ProjectionActionDefinition[] = [
  { id: "back", tier: "primary", labelKey: "projectionToolbar.back", requires: "back" },
  { id: "home", tier: "primary", labelKey: "projectionToolbar.home", requires: "home" },
  { id: "recents", tier: "primary", labelKey: "projectionToolbar.recents", requires: "recents" },
  { id: "screenshot", tier: "primary", labelKey: "projectionToolbar.screenshot", requires: "screenshot" },
  { id: "more", tier: "primary", labelKey: "projectionToolbar.more", requires: null },
  { id: "end", tier: "secondary", labelKey: "projectionToolbar.close", requires: "close" },
];

/** 按能力生成一级行动作（禁用的导航按钮保留占位以给出禁用原因）。 */
export function getProjectionToolbarActions(
  capabilities: ProjectionCapabilities,
): ProjectionActionDefinition[] {
  return ACTION_DEFINITIONS.filter(
    (action) => action.tier === "primary"
      && (action.requires === null || capabilities[action.requires]),
  );
}

/**
 * 去重：从动作集合里剔除与「原生窗口能力 / 其他一级动作」重复的项。
 * 当前规则：关闭投屏（✕）与原生窗口关闭重复 → 不进一级行。
 */
export function filterDuplicateProjectionActions(
  actions: readonly ProjectionActionDefinition[],
): ProjectionActionDefinition[] {
  return actions.filter((action) => action.id !== "end");
}

/** 次级动作（更多菜单内容）：至少存在两个有价值次级功能才保留更多按钮。 */
export function getSecondaryProjectionActions(
  capabilities: ProjectionCapabilities,
): ProjectionActionDefinition[] {
  return ACTION_DEFINITIONS.filter(
    (action) => action.tier === "secondary" && (action.requires === null || capabilities[action.requires]),
  );
}

/** 更多按钮是否值得显示：次级功能（会话信息/诊断/结束投屏）≥ 2 才保留。 */
export function shouldShowMoreButton(capabilities: ProjectionCapabilities): boolean {
  // 会话信息始终可用（来自 vd_session）；诊断与结束投屏依赖会话状态。
  const secondaryCount =
    1 // 会话信息（不可关）
    + (capabilities.screenshot ? 0 : 0) // 截屏已升一级，不计次级
    + 1; // 诊断（vd_diagnostics 对 running 会话恒可用）
  return secondaryCount >= 2 && capabilities.close;
}
