//! 轻量 Toast 队列：info/success/warning/error 四态 + 可选操作按钮（如「撤销」）。
//!
//! 交互契约：
//! - 点击正文不关闭（无操作意义的关闭容易被误触）；关闭只走关闭按钮；
//! - hover / 按钮聚焦时暂停自动消失计时器，移开后重新计时；
//! - 错误/警告停留更久（8s），普通提示 4s，带操作按钮 6s；
//! - 自动消失计时器随卸载清理，不泄漏；动画尊重 prefers-reduced-motion（CSS）。

import { useEffect, useState } from "react";
import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from "lucide-react";
import { useUiStore, type ToastData } from "../store/useUiStore";

const KIND_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
} as const;

function durationFor(toast: ToastData): number {
  if (toast.action) return 6000;
  if (toast.kind === "error" || toast.kind === "warning") return 8000;
  return 4000;
}

function ToastItem({ toast }: { toast: ToastData }) {
  const dismiss = useUiStore((s) => s.dismissToast);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = window.setTimeout(() => dismiss(toast.id), durationFor(toast));
    return () => window.clearTimeout(t);
  }, [paused, toast, dismiss]);

  const Icon = KIND_ICON[toast.kind] ?? Info;

  return (
    <div
      className={`toast kind-${toast.kind}`}
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon size={13} className="toast-icon" aria-hidden="true" />
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.run();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        onClick={() => dismiss(toast.id)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function Toast() {
  const toasts = useUiStore((s) => s.toasts);

  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="操作提示">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
