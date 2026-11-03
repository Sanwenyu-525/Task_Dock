//! 通知窗口入口：独立透明 WebView，只装载六状态液态玻璃通知卡片。
//! 令牌层复用主窗的 styles-themes.css（预设 × 明暗），通知专用样式见
//! styles-notifications.css；不引入主窗业务代码，保持弹窗轻量。

import React from "react";
import ReactDOM from "react-dom/client";
import NotificationWindow from "./NotificationWindow";
import "../styles-themes.css";
import "./styles-notifications.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NotificationWindow />
  </React.StrictMode>,
);
