import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/globalErrors";
import { installStartupConsistencyChecks } from "./lib/consistencyChecks";
import { installDiagnosticsFlushHooks } from "./lib/diagnostics";
import { initLocale } from "./i18n";
import "./styles.css";
import "./styles-themes.css";
import "./styles-ui.css";
import "./components/global-search/global-search.css";

initLocale();
installGlobalErrorHandlers();
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
