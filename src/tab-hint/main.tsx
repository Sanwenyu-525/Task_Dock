//! 极简标签悬停提示窗口入口：独立透明 WebView，只装载一条玻璃提示条。
//!
//! 为什么单独开窗：极简标签的原生可见区只有 10×46（`SetWindowRgn`），
//! 主窗内的 TooltipLayer 浮层会被裁成残片；而扩大主窗区域又是明令禁止的。
//! 令牌层复用主窗的 styles-themes.css（预设 × 明暗），提示专用样式见
//! styles-tab-hint.css；不引入主窗业务代码，保持弹窗轻量。
//!
//! 窗口本身不抢焦点、不接收鼠标（Rust 侧 `set_ignore_cursor_events`），
//! 因此悬停提示不会打断标签的单击 / 拖动 / 右键。

import React from "react";
import ReactDOM from "react-dom/client";
import TabHintApp from "./TabHintApp";
import ErrorBoundary from "../components/ErrorBoundary";
import { installGlobalErrorHandlers } from "../lib/globalErrors";
import { initLocale } from "../i18n";
import "../styles-themes.css";
import "./styles-tab-hint.css";

initLocale();
// 提示窗口异常只轻量兜底：不向不可见窗口发 Toast，也不影响主窗交互。
installGlobalErrorHandlers({ toast: false });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="标签提示" variant="compact">
      <TabHintApp />
    </ErrorBoundary>
  </React.StrictMode>,
);
