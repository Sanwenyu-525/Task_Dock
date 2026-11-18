import "../styles.css";
import "../styles-themes.css";
import "../styles-flat.css";
import "../styles-ui.css";
// 资源管理页专属样式（2026-11-14 CSS 拆分后唯一入口）：工作台窗口同样承载
// 资源管理页，缺失会导致该页在 workspace 窗口整页无样式（真机验收实测）。
import "../styles-resource.css";
import "./workspace.css";
import "../workbench/workbench.css";
import "../components/global-search/global-search.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "../components/ErrorBoundary";
import { bootFail, bootStage } from "../boot/bootProtocol";
import { initLocale } from "../i18n";
import { setWindowHostRole } from "../lib/windowHost";
import { installNativeDragBridge } from "../lib/dragCursorSession";
import { initWorkbenchWindowFrame } from "../workbench/windowFrame";
import WorkspaceApp from "./WorkspaceApp";

// 宿主角色必须在挂载前确定：业务页面（useFullViewVisible 等）据此判断自己
// 运行在唯一大型工作台，而不是主窗口的贴边/胶囊状态机里。
setWindowHostRole("workbench");
// 顶栏 `data-tauri-drag-region="deep"` 的拖拽光标会话需要原生相位：Rust
// `drag_watch` 在 WM_ENTERSIZEMOVE / WM_EXITSIZEMOVE 时向本窗口发 `window-drag`，
// 松手即撤 grabbing（系统模态移动循环期间 WebView2 收不到 pointerup）。
installNativeDragBridge();
// 主题首帧提示（与主窗口同一 localStorage 键）：设置尚未从 SQLite 读取前，
// 先用上次解析结果避免深色 html 默认值闪一下。
try {
  const hint = JSON.parse(
    localStorage.getItem("taskdock.boot-theme") ?? "null",
  ) as { theme?: string; preset?: string } | null;
  if (hint?.theme) document.documentElement.dataset.theme = hint.theme;
  if (hint?.preset) document.documentElement.dataset.preset = hint.preset;
} catch {
  // 提示损坏/存储被拒：保持 index.html 默认值，设置加载后会覆盖。
}
initLocale();

// 启动协议阶段信号（docs/boot/README.md §3）：本窗口与主窗口共用同一份
// public/boot/boot-watchdog.js。workspace.html 的静态占位先于本模块执行，
// 因此即使模块图加载慢/失败，工作台窗口也不会是纯白页。
bootStage("modules");

// 窗口级圆角/边框：CSS 弧与 Win32 区域同源（读当前预设的 --radius-window
// 下发给 Rust），并同步最大化状态。首帧前注册，启动门与外壳共用同一规则。
const stopWindowFrame = initWorkbenchWindowFrame();
window.addEventListener("pagehide", stopWindowFrame, { once: true });

try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary scope="统一工作台">
        <WorkspaceApp />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (e) {
  // createRoot/render 同步抛错：React 无法接管，按协议 §3 通知看门狗进入 error 态
  // （写一次 UI_BOOT_FATAL），随后原样抛出交给全局错误处理，不吞异常。
  bootFail({
    stage: "mounted",
    message: e instanceof Error ? e.message : String(e),
  });
  throw e;
}
bootStage("mounted");
