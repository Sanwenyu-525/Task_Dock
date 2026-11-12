//! 快速捕获窗口入口：独立透明 WebView，只装载液态玻璃捕获卡片。
//! 令牌层复用主窗的 styles-themes.css（预设 × 明暗），捕获专用样式见
//! styles-capture.css；不引入主窗业务代码，保持弹窗轻量、可独立加载。

import React from "react";
import ReactDOM from "react-dom/client";
import CaptureApp from "./CaptureApp";
import ErrorBoundary from "../components/ErrorBoundary";
import TooltipLayer from "../components/ui/TooltipLayer";
import { installGlobalErrorHandlers } from "../lib/globalErrors";
import { installNativeDragBridge } from "../lib/dragCursorSession";
import { initLocale } from "../i18n";
import "../styles-themes.css";
// 悬停提示沿用主窗同一套 .ui-tooltip / .ui-popover 基元，不另写一套提示样式。
import "../styles-ui.css";
import "./styles-capture.css";

initLocale();
// 小窗没有 Toast 宿主：异步异常只记录诊断，不把提示发到不可见窗口。
installGlobalErrorHandlers({ toast: false });
// 头部拖拽走原生移动循环：松手瞬间由 WM_EXITSIZEMOVE 相位结束 grabbing 光标会话。
installNativeDragBridge();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="快速捕获" variant="compact">
      <CaptureApp />
      {/* 独立窗口也有图标按钮：挂全局提示层，data-tip 才不是死声明 */}
      <TooltipLayer />
    </ErrorBoundary>
  </React.StrictMode>,
);
