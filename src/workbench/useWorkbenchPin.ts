// 工作台「置顶」状态 hook（2026-11-16 从 `WorkbenchPinButton` 抽出）。
//
// 顶栏窄窗把置顶收进「更多」菜单后，两个入口必须共用同一份状态与写入逻辑；
// 行为与契约保持不变：
// - 状态以真实窗口为准：挂载时 `isAlwaysOnTop()` 回读，重新获得焦点时再回读；
// - 切换后用 `isAlwaysOnTop()` 校准，失败的切换不留在界面上；
// - 非 Tauri 环境（jsdom / 浏览器预览）没有窗口 API：动作 no-op，不抛错。

import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLocale } from "../hooks/useLocale";
import { errorMessage } from "../lib/errors";
import { useUiStore } from "../store/useUiStore";

/** 只声明本模块真正使用的方法，便于单测注入替身。 */
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

export interface WorkbenchPinState {
  pinned: boolean;
  busy: boolean;
  toggle: () => Promise<void>;
  label: string;
}

/**
 * @param injected 测试注入窗口；传 `undefined` 表示取当前 WebView 窗口，
 *                 传 `null` 表示显式禁用（预览/无窗口环境）。
 */
export function useWorkbenchPin(injected?: WorkbenchPinHandle | null): WorkbenchPinState {
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

  return {
    pinned,
    busy,
    toggle,
    label: t(pinned ? "workbench.unpinWindow" : "workbench.pinWindow"),
  };
}
