//! 快速预览：图片/视频/音频/文本代码；Space 打开、Escape 关闭、左右方向键切换。
//! 大文件按需读取，媒体通过短期 token 协议 + Range，不扩大 asset 协议范围。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Minus, Plus } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useLocale } from "../../hooks/useLocale";
import {
  fsOpen,
  fsPreviewImage,
  fsPreviewMediaUrl,
  fsReadText,
  type FsEntry,
  type FsTextPreview,
} from "../../lib/bridge";
import { formatModified, formatSize } from "../../lib/filesWorkspace/fileMeta";
import { joinPath } from "../../lib/filesWorkspace/pathUtils";
import { errorMessage } from "../../lib/errors";

export interface PreviewRequest {
  paneId: string;
  path: string;
  dir: string;
  entries: FsEntry[];
}

interface Props {
  request: PreviewRequest | null;
  onClose: () => void;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function previewKind(entry: FsEntry | null | undefined): "image" | "video" | "audio" | "text" | "unsupported" {
  if (!entry) return "unsupported";
  if (entry.category === "image") return "image";
  if (entry.category === "video") return "video";
  if (entry.category === "audio") return "audio";
  if (entry.category === "text" || entry.category === "code" || entry.category === "data" || entry.category === "doc") {
    return "text";
  }
  const ext = extOf(entry.name);
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif", "ico"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga"].includes(ext)) return "audio";
  if (["txt", "md", "json", "ts", "tsx", "js", "jsx", "css", "html", "rs", "py", "toml", "yaml", "yml", "xml", "csv", "log"].includes(ext)) {
    return "text";
  }
  return "unsupported";
}

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|interface|type|async|await|true|false|null|undefined|pub|fn|struct|enum|match|use|mod|impl|self|mut|new|def|elif|public|private|void|static)\b/g;

/** 轻量语法高亮：按行 token 化，只生成 React 文本节点，不写 innerHTML。 */
function highlightLine(line: string, ext: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const comment = line.indexOf(ext === "py" ? "#" : "//");
  const body = comment >= 0 ? line.slice(0, comment) : line;
  const commentText = comment >= 0 ? line.slice(comment) : "";
  let last = 0;
  const pattern = /("[^"]*"|'[^']*'|`[^`]*`|\b\d+(?:\.\d+)?\b)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (match.index > last) {
      tokens.push(...highlightKeywords(body.slice(last, match.index), tokens.length));
    }
    tokens.push(
      <span key={`s${match.index}`} className="fw-preview-token-string">
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < body.length) tokens.push(...highlightKeywords(body.slice(last), tokens.length));
  if (commentText) {
    tokens.push(
      <span key="comment" className="fw-preview-token-comment">
        {commentText}
      </span>,
    );
  }
  return tokens;
}

function highlightKeywords(text: string, offset: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  KEYWORDS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEYWORDS.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      <span key={`k${offset}-${match.index}`} className="fw-preview-token-keyword">
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function QuickPreviewDialog({ request, onClose }: Props) {
  const { t } = useLocale();
  const [index, setIndex] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [text, setText] = useState<FsTextPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [fit, setFit] = useState(true);

  const files = useMemo(
    () => (request ? request.entries.filter((entry) => entry.kind !== "dir") : []),
    [request],
  );
  const current = files[index] ?? null;
  const kind = previewKind(current);
  const currentPath = current && request ? joinPath(request.dir, current.name) : request?.path ?? "";

  useEffect(() => {
    if (!request) return;
    const found = files.findIndex((entry) => joinPath(request.dir, entry.name) === request.path);
    setIndex(found >= 0 ? found : 0);
    setZoom(100);
    setFit(true);
  }, [request, files]);

  useEffect(() => {
    if (!request || !current) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setImageUrl(null);
    setMediaUrl(null);
    setText(null);
    const path = joinPath(request.dir, current.name);
    void (async () => {
      try {
        if (kind === "image") {
          const url = await fsPreviewImage(path);
          if (cancelled) return;
          if (url) setImageUrl(url);
          else setError(t("fw.preview.imageUnavailable"));
        } else if (kind === "video" || kind === "audio") {
          const url = await fsPreviewMediaUrl(path);
          if (!cancelled) setMediaUrl(url);
        } else if (kind === "text") {
          const preview = await fsReadText(path);
          if (!cancelled) setText(preview);
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.name, request?.dir, kind]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        setIndex((value) => Math.max(0, value - 1));
      } else if (event.key === "ArrowRight" && index < files.length - 1) {
        event.preventDefault();
        setIndex((value) => Math.min(files.length - 1, value + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, index, files.length]);

  if (!request) return null;

  const canOpen = kind === "unsupported" || error !== null;
  const ext = current ? extOf(current.name) : "";
  const codeLike = current?.category === "code" || ["ts", "tsx", "js", "jsx", "css", "html", "rs", "py", "json", "toml", "yaml", "yml", "xml"].includes(ext);

  return (
    <Dialog
      open
      onClose={onClose}
      title={current?.name ?? request.path.split(/[\\/]/).pop() ?? ""}
      size="lg"
      ariaLabel={t("fw.preview.title")}
      className="fw-preview-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button type="button" className="btn" onClick={() => void fsOpen(currentPath)} disabled={!currentPath}>
            <ExternalLink size={13} aria-hidden="true" />
            {t("fw.preview.openDefault")}
          </button>
        </>
      }
    >
      <div className="fw-preview-toolbar">
        <div className="fw-preview-nav">
          <button
            type="button"
            className="fw-icon-btn"
            disabled={index <= 0}
            aria-label={t("fw.preview.previous")}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="fw-preview-counter">
            {index + 1} / {files.length}
          </span>
          <button
            type="button"
            className="fw-icon-btn"
            disabled={index >= files.length - 1}
            aria-label={t("fw.preview.next")}
            onClick={() => setIndex((value) => Math.min(files.length - 1, value + 1))}
          >
            <ChevronRight size={14} />
          </button>
        </div>
        {current && (
          <span className="fw-preview-meta">
            {formatSize(current.size)} · {formatModified(current.modifiedMs)} · {ext.toUpperCase() || current.category}
          </span>
        )}
        {kind === "image" && imageUrl && (
          <div className="fw-preview-zoom">
            <button
              type="button"
              className="fw-icon-btn"
              aria-label={t("fw.preview.zoomOut")}
              onClick={() => {
                setFit(false);
                setZoom((value) => Math.max(25, value - 25));
              }}
            >
              <Minus size={13} />
            </button>
            <span>{fit ? t("fw.preview.fit") : `${zoom}%`}</span>
            <button
              type="button"
              className="fw-icon-btn"
              aria-label={t("fw.preview.zoomIn")}
              onClick={() => {
                setFit(false);
                setZoom((value) => Math.min(400, value + 25));
              }}
            >
              <Plus size={13} />
            </button>
            <button type="button" className="btn" onClick={() => { setFit(true); setZoom(100); }}>
              {t("fw.preview.fitAction")}
            </button>
          </div>
        )}
      </div>

      <div className="fw-preview-stage">
        {loading && <div className="fw-preview-state">{t("fw.preview.loading")}</div>}
        {!loading && error && (
          <div className="fw-preview-state is-error">
            <p>{t("fw.preview.error", { error })}</p>
          </div>
        )}
        {!loading && !error && kind === "image" && imageUrl && (
          <div className="fw-preview-image-scroll">
            <img
              src={imageUrl}
              alt={current?.name ?? ""}
              style={fit ? { maxWidth: "100%", maxHeight: "100%" } : { width: `${zoom}%`, maxWidth: "none" }}
            />
          </div>
        )}
        {!loading && !error && kind === "video" && mediaUrl && (
          <video className="fw-preview-video" src={mediaUrl} controls preload="metadata">
            {t("fw.preview.videoUnsupported")}
          </video>
        )}
        {!loading && !error && kind === "audio" && mediaUrl && (
          <div className="fw-preview-audio">
            <div className="fw-preview-audio-name">{current?.name}</div>
            <audio src={mediaUrl} controls preload="metadata" />
            <div className="fw-preview-audio-meta">
              {formatSize(current?.size ?? null)} · {formatModified(current?.modifiedMs ?? null)}
            </div>
          </div>
        )}
        {!loading && !error && kind === "text" && text && (
          <div className="fw-preview-text">
            {text.truncated && <p className="fw-preview-truncated">{t("fw.preview.truncated")}</p>}
            <pre>
              {codeLike
                ? text.content.split("\n").map((line, lineIndex) => (
                    <div key={lineIndex} className="fw-preview-code-line">
                      <span className="fw-preview-line-number">{lineIndex + 1}</span>
                      <span>{highlightLine(line, ext)}</span>
                    </div>
                  ))
                : text.content}
            </pre>
          </div>
        )}
        {!loading && !error && kind === "unsupported" && (
          <div className="fw-preview-state">
            <p>{t("fw.preview.unsupported")}</p>
          </div>
        )}
      </div>

      <p className="fw-preview-hint">
        {t("fw.preview.hint")}
        {canOpen ? ` · ${t("fw.preview.fallbackOpen")}` : ""}
      </p>
    </Dialog>
  );
}
