//! 桌面微件独立窗口入口。
//!
//! 刻意**不**挂载 `App.tsx`：微件窗口只需要「读取快照 → 渲染内容 → 上报几何」，
//! 不启动主窗口的全局监听、调度器、贴边吸附与导航状态。数据由主窗口唯一的
//! `WidgetDesktopBridge` 推送，微件窗口不直接调用业务查询。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// 顺序与主窗口一致：先主题 Token，再组件样式，最后微件窗口的表面层。
import "../styles-themes.css";
import "../components/widgets/widgets.css";
import "./widgets-desktop.css";

import { initLocale } from "../i18n";
import { installNativeDragBridge } from "../lib/dragCursorSession";
import WidgetWindow from "./WidgetWindow";

// 微件窗口按需创建/销毁：跳过偏好镜像对账，避免每个窗口重复发起同一组存储 IPC。
initLocale({ preferences: false });

// 原生拖拽相位桥按 webview 安装：`drag_watch.rs` 在本窗口发出开始/结束（带代次），
// 与主窗同一协议（`drag_signal`），事件只发给自己，不与其他窗口串台。
installNativeDragBridge();

const host = document.getElementById("root");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <WidgetWindow />
    </StrictMode>,
  );
}
