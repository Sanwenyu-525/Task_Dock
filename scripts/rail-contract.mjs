//! 完整模式左侧导航契约（脚本侧共享常量）。
//!
//! 事实源：src/store/useUiStore.ts 的 `TAB_ORDER` + src/components/FullView.tsx 的 `TAB_META`。
//! Playwright 脚本独立运行、无法直接导入 TS 模块，故在此显式声明八入口；
//! 契约测试 src/components/FullView.navigationContract.test.tsx 会校验
//! 本文件与 `TAB_ORDER`、`FullView` 实际渲染结果一致，导航增删/改名/换序时契约测试失败，
//! 避免脚本侧清单与真实导航漂移。
//!
//! 数组顺序即 Ctrl+1…9 的顺序（任务 / Agent / 行动 / 剪贴板 / 收集箱 / 暂存架 / 历史 / 规划中心 / 设置）。

export const RAIL_ENTRIES = Object.freeze([
  { id: "tasks", label: "任务", shortcut: "Ctrl+1" },
  { id: "agents", label: "Agent", shortcut: "Ctrl+2" },
  { id: "actions", label: "行动", shortcut: "Ctrl+3" },
  { id: "clipboard", label: "剪贴板", shortcut: "Ctrl+4" },
  { id: "inbox", label: "收集箱", shortcut: "Ctrl+5" },
  { id: "shelf", label: "暂存架", shortcut: "Ctrl+6" },
  { id: "history", label: "历史", shortcut: "Ctrl+7" },
  { id: "roadmap", label: "规划中心", shortcut: "Ctrl+8" },
  { id: "settings", label: "设置", shortcut: "Ctrl+9" },
]);

export const RAIL_ITEM_COUNT = RAIL_ENTRIES.length;

/** 入口标签（顺序与 DOM 中 `.rail-item` 的 data-tip 一致）。 */
export const RAIL_LABELS = Object.freeze(RAIL_ENTRIES.map((e) => e.label));

/** 导航顶部「新建任务」按钮；真实 DOM 类名见 FullView.tsx 的 `.rail-new-task`。 */
export const RAIL_ADD_BUTTON = Object.freeze({
  selector: ".rail-new-task",
  ariaLabel: "新建任务",
  tip: "新建任务 (Ctrl+K)",
});
