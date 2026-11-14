import "../styles.css";
import "../styles-themes.css";
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
import { initLocale } from "../i18n";
import { setWindowHostRole } from "../lib/windowHost";
import WorkspaceApp from "./WorkspaceApp";

// 宿主角色必须在挂载前确定：业务页面（useFullViewVisible 等）据此判断自己
// 运行在唯一大型工作台，而不是主窗口的贴边/胶囊状态机里。
setWindowHostRole("workbench");
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="统一工作台">
      <WorkspaceApp />
    </ErrorBoundary>
  </StrictMode>,
);
