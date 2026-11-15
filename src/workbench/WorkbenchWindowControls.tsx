// 工作台自绘标题栏的窗口控制按钮：最小化 / 最大化-还原 / 关闭。
//
// 背景：workspace 窗口是 `decorations(false)`（见
// src-tauri/src/project_workspace_window.rs），原生标题栏已移除；标题栏由
// `WorkbenchShell` 顶栏承担（品牌 + 页面标题 + 上下文 + 工具 + 这三个按钮），
// 因此不新增一整条独立标题栏，也不改变工作台核心布局。
//
// 交互契约：
// - 关闭走窗口 `close()`：触发 Rust 的 CloseRequested → 保存几何 → 销毁窗口，
//   不 hide、不退出进程；胶囊/托盘/后台服务继续运行（工作台生命周期约定）；
// - 最大化图标跟随**真实**窗口状态（`isMaximized` + `onResized`），最大化时显示
//   「还原」；按钮点击走 `toggleMaximize`，与系统标题栏语义一致；
// - 非 Tauri 环境（jsdom 单测 / 浏览器预览）没有窗口 API：按钮仍可聚焦、有清晰
//   无障碍名称，只是动作为 no-op，不抛错、不阻断渲染。
import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useLocale } from "../hooks/useLocale";

/** 只声明本组件真正使用的方法，便于单测注入替身。 */
export interface WorkbenchWindowHandle {
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
}

function currentWorkbenchWindow(): WorkbenchWindowHandle | null {
  try {
    return getCurrentWindow() as unknown as WorkbenchWindowHandle;
  } catch {
    // 浏览器预览/单测：@tauri-apps/api 会抛「不在 Tauri 环境」。
    return null;
  }
}

export default function WorkbenchWindowControls({
  window: injected,
}: {
  /** 测试注入点；不传时取当前 WebView 窗口。 */
  window?: WorkbenchWindowHandle | null;
}) {
  const { t } = useLocale();
  const win = useMemo<WorkbenchWindowHandle | null>(
    () => (injected !== undefined ? injected : currentWorkbenchWindow()),
    [injected],
  );
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!win) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    const sync = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    };
    // 先查询再订阅：启动时窗口可能已经是最大化（几何恢复）。
    sync();
    void win
      .onResized(() => sync())
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [win]);

  const minimize = () => {
    void win?.minimize().catch(() => {});
  };
  const toggleMaximize = () => {
    void win?.toggleMaximize().catch(() => {});
  };
  const close = () => {
    void win?.close().catch(() => {});
  };

  return (
    // 整簇显式禁用拖动：按钮之间的间隙也不能触发窗口移动，否则误拖会盖掉点击。
    <div
      className="wb-window-controls"
      role="group"
      aria-label={t("workbench.windowControls")}
      data-tauri-drag-region="false"
    >
      <button
        type="button"
        className="wb-window-btn"
        aria-label={t("workbench.windowMinimize")}
        data-tip={t("workbench.windowMinimize")}
        onClick={minimize}
      >
        <Minus size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="wb-window-btn"
        aria-label={
          maximized ? t("workbench.windowRestore") : t("workbench.windowMaximize")
        }
        data-tip={
          maximized ? t("workbench.windowRestore") : t("workbench.windowMaximize")
        }
        aria-pressed={maximized}
        onClick={toggleMaximize}
      >
        {maximized ? (
          <Copy size={12} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Square size={11} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="wb-window-btn is-close"
        aria-label={t("workbench.windowClose")}
        data-tip={t("workbench.windowClose")}
        onClick={close}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
