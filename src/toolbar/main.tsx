//! 投屏控制栏窗口入口：独立透明 WebView，只装载 ProjectionToolbar。
//! 令牌层复用主窗的 styles-themes / styles-flat / styles-ui；样式见 toolbar.css。

import React from "react";
import ReactDOM from "react-dom/client";

import ToolbarApp from "./ToolbarApp";
import ErrorBoundary from "../components/ErrorBoundary";
import TooltipLayer from "../components/ui/TooltipLayer";
import { installGlobalErrorHandlers } from "../lib/globalErrors";
import { initLocale } from "../i18n";
import "../styles-themes.css";
import "../styles-flat.css";
import "../styles-ui.css";
import "./toolbar.css";

initLocale();
installGlobalErrorHandlers({ toast: false });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="投屏控制栏" variant="compact">
      <ToolbarApp />
      <TooltipLayer />
    </ErrorBoundary>
  </React.StrictMode>,
);
