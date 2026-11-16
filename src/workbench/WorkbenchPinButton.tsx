// 工作台自绘标题栏的「置顶 / 取消置顶」按钮。
//
// 归属：功能工具组（主题 / 外观 / 置顶）的最后一项，紧邻窗口控制组的分隔线。
//
// 交互契约：
// - 点击切换**当前 workspace 窗口**的 alwaysOnTop（Tauri window API，不新增业务 IPC）；
// - 状态以真实窗口为准：挂载时 `isAlwaysOnTop()` 回读，窗口重新获得焦点时再回读，
//   切换后也用 `isAlwaysOnTop()` 校准，避免只凭点击意图显示激活态；
// - 激活态走 `.wb-icon-btn.is-on`（accent-soft 底 + accent 描边），不只靠 tooltip；
// - 失败时提示并回读真实状态，不把失败的切换留在界面上；
// - 非 Tauri 环境（jsdom / 浏览器预览）没有窗口 API：按钮仍可聚焦、有清晰名称，
//   动作 no-op，不抛错、不阻断渲染。
//
// 持久化：工作台窗口几何由 Rust 侧持久化，alwaysOnTop 目前没有对应设置键；
// 本轮只做运行期状态，重开工作台回到窗口创建时的 `always_on_top(false)`。
import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pin, PinOff } from "lucide-react";
import { useLocale } from "../hooks/useLocale";
import { errorMessage } from "../lib/errors";
import { useUiStore } from "../store/useUiStore";

/** 只声明本组件真正使用的方法，便于单测注入替身。 */
export interface WorkbenchPinHandle {
  isAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (value: boolean) => Promise<void>;
  /** 可选：Tauri 2 的窗口焦点事件，用于切回窗口时校准状态。 */
  onFocusChanged?: (
    handler: (event: { payload: boolean }) => void,
  ) => Promise<() => void>;
}

function currentWorkbenchWindow(): WorkbenchPinHandle | null {
  try {
    return getCurrentWindow() as unknown as WorkbenchPinHandle;
  } catch {
    // 浏览器预览/单测：@tauri-apps/api 会抛「不在 Tauri 环境」。
    return null;
  }
}

export default function WorkbenchPinButton({
  window: injected,
}: {
  /** 测试注入点；不传时取当前 WebView 窗口。 */
  window?: WorkbenchPinHandle | null;
}) {
  const { t } = useLocale();
  const win = useMemo<WorkbenchPinHandle | null>(
    () => (injected !== undefined ? injected : currentWorkbenchWindow()),
    [injected],
  );
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!win) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    const sync = () => {
      void win
        .isAlwaysOnTop()
        .then((value) => {
          if (!disposed) setPinned(value);
        })
        .catch(() => {});
    };
    // 先查询再订阅：窗口创建后可能已被其他路径置顶（或恢复），不能假设初始为 false。
    sync();
    if (win.onFocusChanged) {
      void win
        .onFocusChanged((event) => {
          // 只关心「重新拿到焦点」；失焦时无需重复查询。
          if (event.payload) sync();
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stop = unlisten;
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      stop?.();
    };
  }, [win]);

  const toggle = async () => {
    if (!win || busy) return;
    const next = !pinned;
    setBusy(true);
    try {
      await win.setAlwaysOnTop(next);
      // 以窗口真实状态收尾；部分平台会拒绝或延迟应用置顶。
      setPinned(await win.isAlwaysOnTop());
    } catch (error: unknown) {
      useUiStore.getState().showToast(
        t("workbench.pinFailed", { error: errorMessage(error) }),
        { kind: "error", code: "workbench.pinFailed" },
      );
      try {
        setPinned(await win.isAlwaysOnTop());
      } catch {
        // 回读也失败时保留上一次已知状态，至少不制造新的假激活态。
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`wb-icon-btn wb-pin-btn${pinned ? " is-on" : ""}`}
      aria-label={t(pinned ? "workbench.unpinWindow" : "workbench.pinWindow")}
      aria-pressed={pinned}
      data-tip={t(pinned ? "workbench.unpinWindow" : "workbench.pinWindow")}
      data-tauri-drag-region="false"
      aria-busy={busy || undefined}
      onClick={() => void toggle()}
    >
      {pinned ? (
        <Pin size={14} aria-hidden="true" />
      ) : (
        <PinOff size={14} aria-hidden="true" />
      )}
    </button>
  );
}
