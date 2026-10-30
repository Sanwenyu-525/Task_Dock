//! 模态对话框与确认框。
//!
//! 两套主题共用同一结构：遮罩 + 面板 + 头/体/脚。Escape 由全局弹层栈处理，
//! 因此确认框永远优先于下层抽屉/菜单被关闭；关闭后焦点回到打开它的控件。

import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useFocusTrap, useOverlayLayer } from "./overlay";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** 面板的无障碍名称（不给则用标题文本兜底） */
  ariaLabel?: string;
  /** 点击遮罩关闭（危险确认框应关掉它） */
  dismissOnScrim?: boolean;
  /** 面板上额外的 class（如任务编辑器的 modal） */
  panelClassName?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  className,
  ariaLabel,
  dismissOnScrim = true,
  panelClassName,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(open, panelRef);
  useOverlayLayer("dialog", open, onClose);

  if (!open) return null;

  return createPortal(
    <div
      className={`ui-dialog-mask ${className ?? ""}`}
      onMouseDown={(e) => {
        if (dismissOnScrim && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`ui-dialog size-${size} ${panelClassName ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
      >
        <header className="ui-dialog-head">
          <span className="ui-dialog-title">{title}</span>
          <button type="button" className="icon-btn sm" aria-label="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="ui-dialog-body">{children}</div>
        {footer ? <footer className="ui-dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 危险操作确认框：主按钮用 danger 样式，默认聚焦在「取消」上。 */
export function ConfirmDialog({
  open,
  title,
  detail,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="sm"
      dismissOnScrim={false}
      ariaLabel={title}
      className="ui-confirm-mask"
      title={
        <span className={`ui-confirm-title ${danger ? "is-danger" : ""}`}>
          {danger ? <AlertTriangle size={14} aria-hidden="true" /> : null}
          {title}
        </span>
      }
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus={danger ? undefined : true}
          >
            {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      {detail ? <p className="ui-confirm-detail">{detail}</p> : null}
    </Dialog>
  );
}
