//! 预览状态占位（加载 / 错误 / 不支持）：统一各类型预览的空态视觉，
//! 避免每个组件各写一套「转圈 / 红字 / 灰字」。
//!
//! 样式从 `files.css` 抽到 `preview.css`（2026-11-23）：文件工作空间与漫剧等
//! 复用预览组件的面板都从这里拿同一份几何，不再各写一套。

import { AlertTriangle, FileQuestion, Loader2 } from "lucide-react";
import "./preview.css";

export function PreviewLoading({ label }: { label: string }) {
  return (
    <div className="fw-preview-state" role="status" aria-live="polite">
      <Loader2 size={18} className="fw-preview-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function PreviewError({
  title,
  detail,
  hint,
  onRetry,
  retryLabel,
}: {
  title: string;
  detail?: string | null;
  hint: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="fw-preview-state is-error" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <p className="fw-preview-state-title">{title}</p>
      {detail ? <code className="fw-preview-state-detail">{detail}</code> : null}
      <p className="fw-preview-state-hint">{hint}</p>
      {onRetry ? (
        <button type="button" className="btn sm" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function PreviewUnsupported({ hint }: { hint: string }) {
  return (
    <div className="fw-preview-state">
      <FileQuestion size={22} aria-hidden="true" />
      <p>{hint}</p>
    </div>
  );
}
