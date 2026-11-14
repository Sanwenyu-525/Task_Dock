//! 统一工作台窗口入口（U0）。
//!
//! 本文件只负责**初始化与组合**：
//! - 窗口宿主角色由 `main.tsx` 在挂载前设置；
//! - 全部布局、导航、路由与页面组合在 `../workbench/WorkbenchShell`；
//! - 项目工作空间的专业内容在 `ProjectWorkspacePanel`（从旧 WorkspaceApp 迁移，
//!   不再自带第二套导航/顶栏）。
//!
//! 历史说明：旧版 WorkspaceApp 曾是「项目列表 + 项目详情」的专用窗口，现已收敛为
//! 唯一大型完整工作台的组合入口；窗口 label / 几何持久化 / 生命周期保持不变。

import WorkbenchShell from "../workbench/WorkbenchShell";

export default function WorkspaceApp() {
  return <WorkbenchShell />;
}
