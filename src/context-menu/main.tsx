//! 右键菜单弹窗入口：独立透明 WebView 窗口，只装载液态玻璃菜单本体。
//! 令牌层复用主窗的 styles-themes.css（预设 × 明暗），菜单专用样式见
//! styles-context-menu.css；不引入主窗业务代码，保持弹窗轻量。

import React from "react";
import ReactDOM from "react-dom/client";
import ContextMenuApp from "./ContextMenuApp";
import "../styles-themes.css";
import "./styles-context-menu.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ContextMenuApp />
  </React.StrictMode>,
);
