import { installGlobalErrorHandlers } from "./lib/globalErrors";
import { installNativeDragBridge } from "./lib/dragCursorSession";
import { installStartupConsistencyChecks } from "./lib/consistencyChecks";
import { installDiagnosticsFlushHooks } from "./lib/diagnostics";
import { installFeatureRegistry } from "./lib/featureRegistry";
import { initLocale } from "./i18n";
import { bootFail, bootStage } from "./boot/bootProtocol";
import "./styles.css";
import "./styles-themes.css";
import "./styles-flat.css";
// Design System v1（2026-11-20）：Token 层必须在 flat 之后、组件层之前。
// 只覆盖取值与新增语义名，不承担结构样式；顺序见文件头注。
import "./styles-tokens.css";
import "./styles-ui.css";
import "./styles-resource.css";
// 主窗与工作台共用同一套页面页头（WorkbenchPageHeader → .wb-page-header/.wb-ph-*）。
// 这份样式原先只在 workspace 入口导入，主窗缺少它时页头退化为默认文档流：
// 图标缩成 19px、动作区整行下沉、标题与按钮错位（2026-11-15 真机截图实测）。
import "./workbench/workbench.css";
import "./components/global-search/global-search.css";
// 公共组件默认视觉放最后：需要压过 base/theme 层的旧按钮/徽标取值。
import "./styles-components.css";
// 页面级适配层在页面 CSS 之后加载：统一工作区分栏、筛选栏、设置卡面。
import "./styles-pages.css";

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
// 功能注册表只登记导航级元数据（ID/代码入口/缓存策略），不 import 任何页面代码。
// 必须在首次渲染前完成，否则 `FeatureView` 会拿到「未注册」。
installFeatureRegistry();

// 主窗 React 挂载放在独立模块里动态加载：入口本身不 import App/React，
// 避免页面 chunk 复用共享模块时连带执行 createRoot（多入口构建踩坑记录见 mainApp.tsx）。
void import("./mainApp").then(
  ({ mountMainWindow }) => mountMainWindow(),
  (e: unknown) => {
    bootFail({
      stage: "mounted",
      message: e instanceof Error ? e.message : String(e),
    });
    throw e;
  },
);
