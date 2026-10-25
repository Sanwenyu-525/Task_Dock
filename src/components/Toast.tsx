//! 轻量 Toast：支持 info/success/error 与可选操作按钮（如「撤销」）。

import { useEffect } from "react";
import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { useUiStore } from "../store/useUiStore";

const KIND_ICON = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const;

export default function Toast() {
  const toast = useUiStore((s) => s.toast);
  const dismiss = useUiStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => dismiss(), toast.action ? 6000 : 4000);
    return () => window.clearTimeout(t);
  }, [toast, dismiss]);

  if (!toast) return null;
  const Icon = KIND_ICON[toast.kind] ?? Info;

  return (
    <div className={`toast kind-${toast.kind}`} role="status" onMouseDown={() => dismiss()}>
      <Icon size={13} className="toast-icon" />
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            toast.action?.run();
            dismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <X size={12} className="toast-close" />
    </div>
  );
}
