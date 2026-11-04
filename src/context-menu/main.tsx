//! 右键菜单弹窗入口：独立透明 WebView 窗口，只装载液态玻璃菜单本体。
//! 令牌层复用主窗的 styles-themes.css（预设 × 明暗），菜单专用样式见
//! styles-context-menu.css；不引入主窗业务代码，保持弹窗轻量。

import React from "react";
import ReactDOM from "react-dom/client";
import ContextMenuApp from "./ContextMenuApp";
import ErrorBoundary from "../components/ErrorBoundary";
import { installGlobalErrorHandlers } from "../lib/globalErrors";
import { initLocale } from "../i18n";
import "../styles-themes.css";
import "./styles-context-menu.css";

initLocale();
// 菜单异常只在本窗口轻量兜底，不写全局持久状态，也不影响主窗口焦点。
installGlobalErrorHandlers({ toast: false });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="右键菜单" variant="compact">
      <ContextMenuApp />
    </ErrorBoundary>
  </React.StrictMode>,
);
