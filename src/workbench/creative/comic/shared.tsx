//! 漫剧 C1 模块共享轻量 UI 辅助：错误文案、归档提示、加载失败重试、表单字段外壳。
//!
//! 只复用语义 Token 与既有 `ws-*` 基元；本目录内的新布局样式写在 `comic.css`。

import { errorMessage } from "../../../lib/errors";

/** 把 IPC 拒绝值归一为可读文案（与正文面板同一套规则）。 */
export function errorText(error: unknown): string {
  return errorMessage(error);
}

/** 归档项目只读横幅：说明为什么写入口置灰。 */
export function ArchivedBanner() {
  return (
    <div className="ws-notice" data-tone="info" role="status">
      <span>项目已归档，剧集、分镜、角色与素材只读；恢复为进行中后才能新增、编辑或删除。</span>
    </div>
  );
}

/** 列表加载失败：可见错误 + 明确重试入口（不静默吞错）。 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="ws-notice" data-tone="error" role="alert">
      <span>{message}</span>
      <button type="button" className="ws-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

/** 表单字段外壳：标签 + 控件。 */
export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="comic-field" htmlFor={htmlFor}>
      <span className="comic-field-label">
        {label}
        {hint ? <em className="comic-field-hint">{hint}</em> : null}
      </span>
      {children}
    </label>
  );
}
