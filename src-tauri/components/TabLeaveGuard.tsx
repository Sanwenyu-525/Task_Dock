//! 全局未保存离开确认条。
//!
//! 页面切换统一由 `useUiStore.setTab` 拦截；本组件只负责把「待决目标」呈现给用户，
//! 不承载任何编辑器逻辑。用户可继续编辑，或明确放弃后完成切换。

import { AlertTriangle } from "lucide-react";
import { activeTabGuard, useActiveTabGuardId } from "../lib/tabGuard";
import { useUiStore } from "../store/useUiStore";

export default function TabLeaveGuard() {
  const pending = useUiStore((s) => s.pendingTab);
  const confirm = useUiStore((s) => s.confirmPendingTab);
  const cancel = useUiStore((s) => s.cancelPendingTab);
  const activeGuardId = useActiveTabGuardId();

  if (!pending || activeGuardId !== pending.guardId) return null;
  const label = activeTabGuard()?.label() ?? "当前编辑";

  return (
    <div className="tab-leave-guard" role="alert" aria-live="assertive">
      <AlertTriangle size={13} aria-hidden="true" />
      <span className="tab-leave-guard-text">
        「{label}」有未保存的修改，切换页面会丢失。
      </span>
      <span className="flex-spacer" />
      <button className="btn sm" onClick={cancel} data-autofocus>
        继续编辑
      </button>
      <button className="btn sm danger" onClick={confirm}>
        放弃修改并切换
      </button>
    </div>
  );
}
