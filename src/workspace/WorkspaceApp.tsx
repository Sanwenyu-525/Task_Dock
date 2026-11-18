//! 统一工作台窗口入口（U0）。
//!
//! 本文件只负责**初始化与组合**：
//! - 窗口宿主角色由 `main.tsx` 在挂载前设置；
//! - 全部布局、导航、路由与页面组合在 `../workbench/WorkbenchShell`；
//! - 项目工作空间的专业内容在 `ProjectWorkspacePanel`（从旧 WorkspaceApp 迁移，
//!   不再自带第二套导航/顶栏）。
//!
//! 历史上旧版 WorkspaceApp 曾是「项目列表 + 项目详情」的专用窗口，现已收敛为
//! 唯一大型完整工作台的组合入口；窗口 label / 几何持久化 / 生命周期保持不变。
//!
//! 启动占位交接（docs/boot/README.md §3）：workspace.html 的静态占位由
//! `public/boot/boot-watchdog.js` 驱动，React 侧必须在**设置落定**（成功或失败）
//! 后调用 `bootReady()`——失败时外壳会显示 `wb-boot` 错误卡，也算「React 已接管」。
//! 这里不读 `#root` 是否有子节点，避免把「设置加载门」误当成就绪（与主窗口同一判据）。

import { useEffect } from "react";
import { bootReady, bootStage } from "../boot/bootProtocol";
import { useSettingsStore } from "../store/useSettingsStore";
import WorkbenchShell from "../workbench/WorkbenchShell";

export default function WorkspaceApp() {
  const settings = useSettingsStore((s) => s.settings);
  const loadError = useSettingsStore((s) => s.loadError);
  const settingsSettled = settings !== null || loadError !== null;

  useEffect(() => {
    if (!settingsSettled) return;
    bootStage("settings"); // 阶段信号：设置读取落定（只记时间，不写诊断）
    bootReady();
  }, [settingsSettled]);

  return <WorkbenchShell />;
}
