//! 跨 Tab 模块初始化入口（主窗口与完整工作台都必须调用）。
//!
//! Tauri 不同 WebView 的 JavaScript 模块状态是隔离的：动作表 / 事件总线不会天然共享，
//! 所以每个窗口都要执行一次注册。注册本身幂等（`ensureAction`），重复调用无副作用。
//!
//! 事件订阅也在这一层建立：面板在 dock / drawer 之间切换会导致组件重挂载，
//! 但批次监听只会建立一次，不会因为切换形态而重复订阅或重复请求后端。

import { useTransferStore } from "../../store/useTransferStore";
import { currentWindowLabel } from "./contextResolver";
import { TRANSFER_EVENTS, subscribe } from "./eventBus";
import { installTaskActions, uninstallTaskActions } from "./modules/tasks";
import { installTrayActions, uninstallTrayActions } from "./modules/tray";
import { getContext } from "./transferClient";
import type { TransferContext } from "./types";

let initialized = false;
let unwire: (() => void) | null = null;

function wireEvents(): void {
  if (unwire) return;
  let label = "";
  void currentWindowLabel().then((value) => {
    label = value;
  });
  const offBatch = subscribe(
    TRANSFER_EVENTS.batchChanged,
    (payload) => useTransferStore.getState().handleBatchEvent(payload),
    "cross-tab-core",
  );
  const offContext = subscribe(
    TRANSFER_EVENTS.contextChanged,
    (payload) => {
      const next = payload as TransferContext | null;
      if (!next) return;
      // 上下文按窗口隔离：只接受本窗口 label 的那一份。
      if (next.window && label && next.window !== label) return;
      useTransferStore.getState().setContext(next);
    },
    "cross-tab-core",
  );
  unwire = () => {
    offBatch();
    offContext();
  };
  // 初始上下文只读一次（内存态，不落库）。
  void getContext()
    .then((context) => useTransferStore.getState().setContext(context))
    .catch(() => {
      // 后端暂不可用时不影响工作篮主流程。
    });
}

export function initializeCrossTabModules(): void {
  if (initialized) return;
  initialized = true;
  installTrayActions();
  installTaskActions();
  wireEvents();
}

export function disposeCrossTabModules(): void {
  if (!initialized) return;
  initialized = false;
  uninstallTrayActions();
  uninstallTaskActions();
  unwire?.();
  unwire = null;
}

/** 诊断 / 测试：本窗口是否已完成注册。 */
export function crossTabModulesReady(): boolean {
  return initialized;
}
