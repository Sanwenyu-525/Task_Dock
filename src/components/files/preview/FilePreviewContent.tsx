//! 统一文件预览内容：类型判定只看 `previewKind`，各类型渲染复用既有组件。
//!
//! 这里不读文件、不持有所选状态：只接收一个 `FilePreviewTarget`，
//! 输出「加载 / 错误 / 不支持 / 内容」之一。弹窗与右侧检查器都挂这一个组件，
//! 因此不再存在第二套 `FileTextPreview` / `FilePdfPreview` 调用链。

import { FolderOpen } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import ErrorBoundary from "../../ErrorBoundary";
import type { FilePreviewTarget } from "../../../lib/filesWorkspace/previewSelection";
import { getPreviewKind } from "./previewKind";
import FileTextPreview from "./FileTextPreview";
import FileImagePreview from "./FileImagePreview";
import FilePdfPreview from "./FilePdfPreview";
import FileVideoPreview from "./FileVideoPreview";
import FileAudioPreview from "./FileAudioPreview";
import { PreviewUnsupported } from "./PreviewState";

export type { FilePreviewTarget };

export interface FilePreviewContentProps {
  target: FilePreviewTarget;
  variant?: "dialog" | "panel";
  /** 非阻断提示（例如链接无法打开）：交给外层 toast，内容区不抢焦点。 */
  onNotice?: (message: string | null) => void;
}

export default function FilePreviewContent({ target, variant = "dialog", onNotice }: FilePreviewContentProps) {
  const { t } = useLocale();
  const { entry, path, name, size } = target;

  if (entry.kind === "dir") {
    return (
      <div className="fw-preview-folder">
        <span className="fw-preview-folder-icon" aria-hidden="true">
          <FolderOpen size={26} strokeWidth={1.6} />
        </span>
        <p className="fw-preview-folder-name" title={entry.name}>
          {entry.name}
        </p>
        <code className="fw-preview-folder-path" title={path}>
          {path}
        </code>
        <p className="fw-preview-folder-hint">{t("fw.preview.folderHint")}</p>
      </div>
    );
  }

  const kind = getPreviewKind(entry);
  const common = { path, name, size };

  const body = (() => {
    switch (kind) {
      case "image":
        return <FileImagePreview key={path} {...common} />;
      case "text":
        return <FileTextPreview key={path} {...common} variant={variant} onNotice={onNotice} />;
      case "pdf":
        return <FilePdfPreview key={path} {...common} />;
      case "video":
        return <FileVideoPreview key={path} {...common} />;
      case "audio":
        return <FileAudioPreview key={path} {...common} />;
      default:
        return <PreviewUnsupported hint={t("fw.preview.unsupported")} />;
    }
  })();

  return (
    <ErrorBoundary scope="files-preview" variant="compact" resetKey={path} label={t("fw.preview.title")}>
      <div className="fw-preview-content" data-kind={kind}>
        {body}
      </div>
    </ErrorBoundary>
  );
}
