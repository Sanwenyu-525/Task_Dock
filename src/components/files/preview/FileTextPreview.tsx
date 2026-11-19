//! 文本 / 代码预览：等宽字体、行号、轻量高亮、编码与截断提示、内容复制。
//!
//! 安全：只生成 React 文本节点，**不使用** `dangerouslySetInnerHTML`；
//! 后端最多读取 512 KiB 并拒绝二进制，前端不会因为读取失败展示空白页。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, FileWarning } from "lucide-react";
import { fsReadText, type FsTextPreview } from "../../../lib/bridge";
import { useLocale } from "../../../hooks/useLocale";
import { errorMessage } from "../../../lib/errors";
import { copyText } from "../../../lib/clipboard";
import { formatSize } from "../../../lib/filesWorkspace/fileMeta";
import {
  HIGHLIGHT_MAX_CHARS,
  TEXT_PREVIEW_BYTES,
  extOf,
  isCodeLike,
  previewLanguage,
} from "./previewKind";
import { PreviewError, PreviewLoading } from "./PreviewState";

interface Props {
  path: string;
  name: string;
  size: number | null;
}

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|interface|type|async|await|true|false|null|undefined|pub|fn|struct|enum|match|use|mod|impl|self|mut|new|def|elif|public|private|void|static)\b/g;

/** 语言按注释符号区分：# / // ；字符串与数字单独染色。 */
function commentToken(ext: string): string {
  if (["py", "sh", "yaml", "yml", "toml", "ini", "cfg", "conf", "ps1"].includes(ext)) return "#";
  return "//";
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

/** 轻量语法高亮：按行 token 化，只生成 React 文本节点。 */
function highlightLine(line: string, ext: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const marker = commentToken(ext);
  const comment = line.indexOf(marker);
  const hasComment = comment >= 0 && !(marker === "//" && line.slice(0, comment).includes("http:"));
  const body = hasComment ? line.slice(0, comment) : line;
  const commentText = hasComment ? line.slice(comment) : "";
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

export default function FileTextPreview({ path, name, size }: Props) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<FsTextPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [reloadKey, setReloadKey] = useState(0);

  const ext = extOf(name);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    setCopyState("idle");
    fsReadText(path, TEXT_PREVIEW_BYTES)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  const content = preview?.content ?? "";
  const lineCount = useMemo(() => (content ? content.split("\n").length : 0), [content]);
  const codeLike = isCodeLike(ext);
  const highlighting = codeLike && content.length <= HIGHLIGHT_MAX_CHARS;
  const lines = useMemo(
    () => (highlighting ? content.split("\n") : []),
    [content, highlighting],
  );
  const lossyEncoding = (preview?.encoding ?? "").includes("lossy") || content.includes("\uFFFD");

  const onCopy = async () => {
    const ok = await copyText(content);
    setCopyState(ok ? "ok" : "fail");
    window.setTimeout(() => setCopyState("idle"), 1600);
  };

  if (loading) return <PreviewLoading label={t("fw.preview.loading")} />;
  if (error) {
    return (
      <PreviewError
        title={t("fw.preview.error", { error })}
        detail={name}
        hint={t("fw.preview.fallbackOpen")}
        onRetry={() => setReloadKey((value) => value + 1)}
        retryLabel={t("common.retry")}
      />
    );
  }
  if (!preview) {
    return <PreviewError title={t("fw.preview.error", { error: name })} hint={t("fw.preview.fallbackOpen")} />;
  }

  return (
    <div className="fw-preview-text">
      <div className="fw-preview-info">
        <span className="fw-preview-chip is-strong">{previewLanguage(ext)}</span>
        <span className="fw-preview-chip">{t("fw.preview.encodingLabel", { encoding: preview.encoding })}</span>
        <span className="fw-preview-chip">
          {t("fw.preview.sizeLabel", { size: formatSize(size ?? preview.size) })}
        </span>
        <span className="fw-preview-chip">{t("fw.preview.lineCount", { count: lineCount })}</span>
        {preview.truncated && (
          <span className="fw-preview-chip is-warn">
            <FileWarning size={11} aria-hidden="true" />
            {t("fw.preview.truncatedShort")}
          </span>
        )}
        <span className="fw-preview-info-spacer" />
        <button type="button" className="btn sm" onClick={() => void onCopy()}>
          {copyState === "ok" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copyState === "ok"
            ? t("fw.preview.copied")
            : copyState === "fail"
              ? t("fw.preview.copyFailed")
              : t("fw.preview.copy")}
        </button>
      </div>

      {preview.truncated && <p className="fw-preview-truncated">{t("fw.preview.truncated")}</p>}
      {lossyEncoding && <p className="fw-preview-encoding">{t("fw.preview.encodingWarning")}</p>}
      {codeLike && !highlighting && (
        <p className="fw-preview-encoding">{t("fw.preview.highlightOff")}</p>
      )}

      <div className="fw-preview-text-scroll">
        {highlighting ? (
          <pre>
            {lines.map((line, lineIndex) => (
              <div key={lineIndex} className="fw-preview-code-line">
                <span className="fw-preview-line-number">{lineIndex + 1}</span>
                <span className="fw-preview-code-text">{highlightLine(line, ext)}</span>
              </div>
            ))}
          </pre>
        ) : (
          <pre className="is-plain">{content}</pre>
        )}
      </div>
    </div>
  );
}
