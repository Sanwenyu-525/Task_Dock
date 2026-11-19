// 工作台自绘标题栏的窗口控制按钮：最小化 / 最大化-还原 / 关闭。
//
// 背景：workspace 窗口是 `decorations(false)`（见
// src-tauri/src/project_workspace_window.rs），原生标题栏已移除；标题栏由
// `WorkbenchShell` 顶栏承担（品牌 + 页面标题 + 上下文 + 工具 + 这三个按钮），
// 因此不新增一整条独立标题栏，也不改变工作台核心布局。
//
// 关闭契约（2026-11-19 P0 关闭专项重构）：
// - 关闭生命周期由 **统一关闭协调器**（`workbenchCloseGuard`）持有，本组件只
//   通过 `closeState` 渲染，不再自己维护 `closing`；
// - `win.close()` 的 Promise 只代表「关闭请求被受理」，**不代表窗口已销毁**，
//   因此绝不能用它的 resolve 解锁按钮（旧实现的核心缺陷）；
// - 点击走 `onRequestClose`，与 Alt+F4 共用同一笔关闭事务；
// - 关闭中按钮 disabled 且 tooltip 说明「正在保存并关闭工作台」；保存失败/
//   超时由外壳回传 `closeMessage`，恢复可点击并解释原因；
// - 非 Tauri 环境（jsdom 单测 / 浏览器预览）没有窗口 API：按钮仍可聚焦、有清晰
//   无障碍名称，只是动作为 no-op，不抛错、不阻断渲染。
import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useLocale } from "../hooks/useLocale";
import { logEvent } from "../lib/diagnostics";
import { errorMessage } from "../lib/errors";
import type { WorkbenchCloseState } from "./workbenchCloseGuard";

/** 只声明本组件真正使用的方法，便于单测注入替身。 */
export interface WorkbenchWindowHandle {
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  /** 窗口 label（诊断用）；旧替身/非 Tauri 环境可缺省。 */
  label?: () => string;
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
  closeState = "idle",
  closeMessage = null,
  onRequestClose,
}: {
  /** 测试注入点；不传时取当前 WebView 窗口。 */
  window?: WorkbenchWindowHandle | null;
  /** 统一关闭协调器状态：saving / retrying-close / closed 一律不可再点。 */
  closeState?: WorkbenchCloseState;
  /** 协调器给出的失败/超时提示（展示在 tooltip，不吞掉原因）。 */
  closeMessage?: string | null;
  /** X 按钮统一入口；不传时退化为直接 `win.close()`（仅预览/旧调用）。 */
  onRequestClose?: () => void;
}) {
  const { t } = useLocale();
  const win = useMemo<WorkbenchWindowHandle | null>(
    () => (injected !== undefined ? injected : currentWorkbenchWindow()),
    [injected],
  );
  const [maximized, setMaximized] = useState(false);
  /**
   * 同一 tick 内的重复点击拦截：state 更新是异步批处理的，disabled 生效前
   * 第二次 click 已经进来。协调器本身也会拒绝重复事务，这里是第一道闸。
   * 关闭状态由 `closeState` 驱动，回到可交互态时自动复位。
   */
  const clickLock = useRef(false);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  const closing =
    closeState === "saving" ||
    closeState === "retrying-close" ||
    closeState === "closed";

  useEffect(() => {
    if (!closing) clickLock.current = false;
  }, [closing]);

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

  const label = (() => {
    try {
      return win?.label?.() ?? "unknown";
    } catch {
      return "unknown";
    }
  })();

  const close = () => {
    if (closing || clickLock.current) return;
    clickLock.current = true;
    setFallbackError(null);
    logEvent({
      level: "INFO",
      module: "workbench",
      action: "window-control",
      event: "close-requested",
      window_id: label,
    });
    if (onRequestClose) {
      // 统一事务：保存 → 真正关闭；状态由协调器回传，本组件不猜生命周期。
      onRequestClose();
      return;
    }
    // 兼容预览/旧调用：没有协调器时直接走窗口 close，并如实记录受理/失败。
    if (!win) {
      logEvent({
        level: "WARN",
        module: "workbench",
        action: "window-control",
        event: "close-no-window",
        status: "cancelled",
        window_id: label,
      });
      clickLock.current = false;
      return;
    }
    logEvent({
      level: "INFO",
      module: "workbench",
      action: "window-control",
      event: "close-fallback-requested",
      window_id: label,
    });
    void win
      .close()
      .then(() => {
        logEvent({
          level: "INFO",
          module: "workbench",
          action: "window-control",
          event: "close-request-accepted",
          status: "success",
          window_id: label,
        });
      })
      .catch((error) => {
        const message = errorMessage(error);
        logEvent({
          level: "ERROR",
          module: "workbench",
          action: "window-control",
          event: "close-fallback-failed",
          status: "failed",
          window_id: label,
          message,
        });
        setFallbackError(message);
        clickLock.current = false;
      });
  };

  const saving =
    closeState === "saving" || closeState === "retrying-close";
  const tip =
    closeMessage ??
    fallbackError ??
    (saving ? t("workbench.windowCloseSaving") : t("workbench.windowClose"));

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
        aria-busy={saving || undefined}
        data-tip={tip}
        title={tip}
        disabled={closing}
        onClick={close}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
