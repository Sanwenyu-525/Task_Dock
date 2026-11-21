//! 投屏控制栏窗口入口：scrcpy 投屏窗口的一体化子窗口 WebView。
//! 令牌层复用主窗的 styles-themes / styles-flat / styles-ui；组件样式见
//! projection-controls/projection-controls.css（布局由 Rust 侧计算并广播）。

import React from "react";
import ReactDOM from "react-dom/client";

import ToolbarApp from "./ToolbarApp";
import ErrorBoundary from "../components/ErrorBoundary";
import { installGlobalErrorHandlers } from "../lib/globalErrors";
import { initLocale } from "../i18n";
import "../styles-themes.css";
import "../styles-flat.css";
import "../styles-tokens.css";
import "../styles-ui.css";
import "../components/mobile/virtual-display/projection-controls/projection-controls.css";

initLocale();
installGlobalErrorHandlers({ toast: false });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="投屏控制栏" variant="compact">
      <ToolbarApp />
    </ErrorBoundary>
  </React.StrictMode>,
);
