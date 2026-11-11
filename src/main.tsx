import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/globalErrors";
import { installNativeDragBridge } from "./lib/dragCursorSession";
import { installStartupConsistencyChecks } from "./lib/consistencyChecks";
import { installDiagnosticsFlushHooks } from "./lib/diagnostics";
import { initLocale } from "./i18n";
import { bootFail, bootStage } from "./boot/bootProtocol";
import "./styles.css";
import "./styles-themes.css";
import "./styles-ui.css";
import "./components/global-search/global-search.css";

// 启动协议阶段信号（tmp/acceptance/startup-experience-v1/BOOT_PROTOCOL.md §3）：
// main.tsx 模块开始执行。只记时间不写诊断；此前的异常由 index.html 看门狗捕获。
bootStage("modules");

initLocale();
installGlobalErrorHandlers();
// 原生拖拽相位桥：Win32 模态移动循环开始/结束（WM_ENTER/EXITSIZEMOVE）→ 事件带
// 单调代次（`drag_signal`），前端只结束代次匹配的会话——松手后鼠标静止也能立刻
// 从 grabbing 复原，迟到的旧结束信号不会清掉刚开始的新拖拽。浏览器预览下自动跳过。
installNativeDragBridge();
// 诊断队列在窗口关闭前尽量刷盘；一致性校验在设置首次加载后跑一次（无轮询）。
installDiagnosticsFlushHooks();
installStartupConsistencyChecks();

try {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary scope="主窗口">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} catch (e) {
  // createRoot/render 同步抛错：React 无法接管，按协议 §3 通知看门狗进入 error
  // 态（写一次 UI_BOOT_FATAL），随后原样抛出交给全局错误处理，不吞异常。
  bootFail({
    stage: "mounted",
    message: e instanceof Error ? e.message : String(e),
  });
  throw e;
}
// render() 同步调用已发起（React 已提交第一帧，可能仍是设置加载门）→ mounted 阶段。
bootStage("mounted");
