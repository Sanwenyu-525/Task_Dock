//! 通知窗口入口：独立透明 WebView，只装载六状态液态玻璃通知卡片。
//! 令牌层复用主窗的 styles-themes.css（预设 × 明暗），通知专用样式见
//! styles-notifications.css；不引入主窗业务代码，保持弹窗轻量。

import React from "react";
import ReactDOM from "react-dom/client";
import NotificationWindow from "./NotificationWindow";
import ErrorBoundary from "../components/ErrorBoundary";
import { installGlobalErrorHandlers } from "../lib/globalErrors";
import { initLocale } from "../i18n";
import "../styles-themes.css";
import "./styles-notifications.css";

initLocale();
// 通知窗口渲染异常时只轻量兜底：不标记通知为已完成，也不向不可见窗口发 Toast。
installGlobalErrorHandlers({ toast: false });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="通知窗口" variant="compact">
      <NotificationWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
