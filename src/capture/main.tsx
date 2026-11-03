//! 快速捕获窗口入口：独立透明 WebView，只装载液态玻璃捕获卡片。
//! 令牌层复用主窗的 styles-themes.css（预设 × 明暗），捕获专用样式见
//! styles-capture.css；不引入主窗业务代码，保持弹窗轻量、可独立加载。

import React from "react";
import ReactDOM from "react-dom/client";
import CaptureApp from "./CaptureApp";
import "../styles-themes.css";
import "./styles-capture.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CaptureApp />
  </React.StrictMode>,
);
