//! 小说 B2 模块共享的轻量 UI 辅助：错误文案、归档提示、加载失败重试、标签编辑器。
//!
//! 只复用语义 Token 与既有 `ui/*` 基元；本目录内的新样式写在 `novel.css`。

import { useEffect, useState } from "react";
import { errorMessage } from "../../../lib/errors";

/** 把 IPC 拒绝值归一为可读文案（与正文面板同一套规则）。 */
export function errorText(error: unknown): string {
  return errorMessage(error);
}

/** 归档项目只读横幅：说明为什么写入口置灰。 */
export function ArchivedBanner() {
  return (
    <div className="novel-banner novel-banner-archived" role="status">
      项目已归档，人物与世界观只读；恢复为进行中后才能新增、编辑或解绑。
    </div>
  );
}

/** 列表加载失败：可见错误 + 明确重试入口（不静默吞错）。 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="novel-load-error" role="alert">
      <span>{message}</span>
      <button type="button" className="novel-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

/** 标签编辑器：逗号/顿号/分号分隔输入，去重，上限 20 个。 */
export function TagEditor({
  tags,
  onChange,
  disabled,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(tags.join("，"));

  useEffect(() => {
    setText(tags.join("，"));
  }, [tags]);

  function commit(next: string) {
    setText(next);
    const parsed = next
      .split(/[,，;；]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const unique = Array.from(new Set(parsed)).slice(0, 20);
    onChange(unique);
  }

  return (
    <div className="novel-tag-editor">
      <input
        type="text"
        className="novel-input"
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? "用逗号分隔，最多 20 个标签"}
        aria-label="标签"
        onChange={(event) => commit(event.target.value)}
      />
      {tags.length > 0 && (
        <div className="novel-tag-row" aria-hidden="true">
          {tags.map((tag) => (
            <span key={tag} className="novel-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
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
    <label className="novel-field" htmlFor={htmlFor}>
      <span className="novel-field-label">
        {label}
        {hint ? <em className="novel-field-hint">{hint}</em> : null}
      </span>
      {children}
    </label>
  );
}
