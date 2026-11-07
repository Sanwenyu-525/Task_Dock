import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/globalErrors";
import { installNativeDragBridge } from "./lib/dragCursorSession";
import { installStartupConsistencyChecks } from "./lib/consistencyChecks";
import { installDiagnosticsFlushHooks } from "./lib/diagnostics";
import { initLocale } from "./i18n";
import "./styles.css";
import "./styles-themes.css";
import "./styles-ui.css";
import "./components/global-search/global-search.css";

initLocale();
installGlobalErrorHandlers();
// 原生拖拽相位桥：Win32 模态移动循环开始/结束（WM_ENTER/EXITSIZEMOVE）→ 事件带
// 单调代次（`drag_signal`），前端只结束代次匹配的会话——松手后鼠标静止也能立刻
// 从 grabbing 复原，迟到的旧结束信号不会清掉刚开始的新拖拽。浏览器预览下自动跳过。
installNativeDragBridge();
// 诊断队列在窗口关闭前尽量刷盘；一致性校验在设置首次加载后跑一次（无轮询）。
installDiagnosticsFlushHooks();
installStartupConsistencyChecks();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="主窗口">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
