import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { bootFail, bootStage } from "./boot/bootProtocol";

/**
 * 主窗 React 挂载层（2026-11-20 Design System 改造期间拆分）。
 *
 * 为什么单独拆出来：多入口构建时 Rollup 会把 `src/main.tsx` 的静态依赖
 * （App / store / 公共组件）收进主入口 chunk，页面 chunk 引用这些共享模块时
 * 会连带执行入口模块顶层的 `createRoot`，导致工作台窗口被主窗 App 覆盖。
 * 现在入口只保留启动编排，挂载逻辑放在本模块并由入口 `import()` 动态加载：
 * 页面 chunk 即使复用这里导出的共享模块，也不会触发主窗挂载。
 */
export function mountMainWindow(): void {
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
}
