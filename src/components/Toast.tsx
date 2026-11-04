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
  // 悬停给出完整诊断：错误码 + 技术细节，正文保持简洁安全
  const tip =
    toast.kind === "error" || toast.kind === "warning"
      ? [toast.code, toast.message, toast.detail].filter(Boolean).join(" · ")
      : undefined;

  return (
    <div
      className={`toast kind-${toast.kind}`}
      // 错误用 alert（立即播报），其余用 status；Toast 不是导航目标，不抢焦点
      role={toast.kind === "error" ? "alert" : "status"}
      aria-atomic="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon size={13} className="toast-icon" aria-hidden="true" />
      {/* 单行省略避免撑破布局；错误文案可能很长，hover 时用 data-tip 给出完整内容以便诊断 */}
      <span className="toast-message" data-tip={tip}>
        {toast.message}
      </span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            // 操作本身失败不能把异常抛进事件处理链（会触发未处理异常兜底）
            try {
              toast.action?.run();
            } catch {
              // 具体失败由 action 内部统一上报
            }
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
