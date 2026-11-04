//! 完整模式左侧导航契约（脚本侧共享常量）。
//!
//! 事实源：src/store/useUiStore.ts 的 `TAB_ORDER` / `RAIL_ORDER` + src/components/FullView.tsx
//! 的 `TAB_META` / `RAIL_ENTRIES`。Playwright 脚本独立运行、无法直接导入 TS 模块，故在此
//! 显式声明。v0.8 起「收集箱」与「暂存架」在侧边栏合并为单一视觉入口「收集与暂存」
//! （页面内双子页签）；v0.9 新增「工作流」视觉入口；v0.10 新增「应用」视觉入口，
//! 因此 **10 个视觉入口 ≠ 10 个逻辑 Tab**：
//! - `RAIL_ENTRIES`：视觉入口（渲染顺序、data-tip、aria-label 的事实源）；
//! - `LOGICAL_TABS`：逻辑 Tab 顺序（= useUiStore.TAB_ORDER，快捷键 Ctrl+1…9 与 Ctrl+0 的
//!   事实源，Ctrl+5=快速收集 inbox、Ctrl+6=文件暂存 shelf、Ctrl+0=设置，
//!   旧 setTab 调用不受视觉合并影响）；
//! - `RAIL_ONLY_TABS`：仅视觉入口、不占快捷键的 Tab（当前为 apps）。
//! 契约测试 src/components/FullView.navigationContract.test.tsx 校验两者与真实渲染一致，
//! 导航增删/改名/换序时契约测试失败，避免脚本侧清单与真实导航漂移。

export const LOGICAL_TABS = Object.freeze([
  "tasks",
  "agents",
  "actions",
  "clipboard",
  "inbox",
  "shelf",
  "workflows",
  "history",
  "roadmap",
  "settings",
]);

/** 仅视觉入口、不分配 Ctrl+数字的 Tab（避免既有快捷键语义漂移）。 */
export const RAIL_ONLY_TABS = Object.freeze(["apps", "widgets"]);

export const RAIL_ENTRIES = Object.freeze([
  { id: "tasks", label: "任务", shortcut: "Ctrl+1" },
  { id: "agents", label: "Agent", shortcut: "Ctrl+2" },
  { id: "apps", label: "应用", shortcut: "" },
  { id: "widgets", label: "微件", shortcut: "" },
  { id: "actions", label: "行动", shortcut: "Ctrl+3" },
  { id: "clipboard", label: "剪贴板", shortcut: "Ctrl+4" },
  {
    id: "collection",
    label: "收集与暂存",
    shortcut: "Ctrl+5 / Ctrl+6",
    tabs: ["inbox", "shelf"],
  },
  { id: "workflows", label: "工作流", shortcut: "Ctrl+7" },
  { id: "history", label: "历史", shortcut: "Ctrl+8" },
  { id: "roadmap", label: "规划中心", shortcut: "Ctrl+9" },
  { id: "settings", label: "设置", shortcut: "Ctrl+0" },
]);

export const RAIL_ITEM_COUNT = RAIL_ENTRIES.length;

/** 视觉入口标签（顺序与 DOM 中 `.rail-item` 的 data-tip 基础文案一致）。 */
export const RAIL_LABELS = Object.freeze(RAIL_ENTRIES.map((e) => e.label));

/** 导航顶部「新建任务」按钮；真实 DOM 类名见 FullView.tsx 的 `.rail-new-task`。 */
export const RAIL_ADD_BUTTON = Object.freeze({
  selector: ".rail-new-task",
  ariaLabel: "新建任务",
  tip: "新建任务 (Ctrl+K)",
});
