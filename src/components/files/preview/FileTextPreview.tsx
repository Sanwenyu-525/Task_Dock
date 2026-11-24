//! 文本 / 代码 / Markdown 预览：唯一文本渲染通道。
//!
//! 一次读盘，三种展示：
//! - 源码（普通文本 / 代码）：等宽、行号、语义高亮、自动换行；
//! - Markdown 阅读：安全 AST → React 元素（不注入 HTML、不加载远程资源）；
//! - Markdown 源码：Markdown 语法着色 + 行号 + 换行。
//!
//! 模式切换、搜索、换行、行号、字号全部只操作已读入内存的内容，
//! **绝不重新调用文件读取 IPC**（`useTextPreview` 是唯一读取点）。
//!
//! 安全：只生成 React 文本节点，不使用 `dangerouslySetInnerHTML`；
//! 链接只经 `openExternalUrl`（http/https/mailto）打开。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CaseSensitive,
  Check,
  Code2,
  Copy,
  CopyCheck,
  FileWarning,
  ListOrdered,
  ListTree,
  Minus,
  Plus,
  Table2,
  WrapText,
} from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { copyText } from "../../../lib/clipboard";
import { errorMessage } from "../../../lib/errors";
import { openExternalUrl } from "../../../lib/externalLinks";
import { formatSize } from "../../../lib/filesWorkspace/fileMeta";
import SearchField from "../../ui/SearchField";
import {
  HIGHLIGHT_MAX_CHARS,
  TEXT_RENDER_MAX_LINES,
  extOf,
  isDelimitedExt,
  isJsonExt,
  isMarkdownExt,
} from "./previewKind";
import {
  createHighlightCursor,
  highlightLanguageOf,
  highlightSource,
  tokenizeLine,
  type HighlightLanguage,
} from "./codeHighlight";
import { parseMarkdown } from "./markdownParse";
import { parseCsvText } from "./csvParse";
import { buildJsonTree } from "./jsonTree";
import {
  findTextMatches,
  getNextMatch,
  normalizeNewlines,
} from "./textSearch";
import { renderTextWithMatches, renderTokens } from "./tokenRender";
import MarkdownView from "./FileMarkdownView";
import CsvTableView from "./CsvTableView";
import JsonTreeView from "./JsonTreeView";
import { PreviewError, PreviewLoading } from "./PreviewState";
import { useTextPreview } from "./useTextPreview";

interface Props {
  path: string;
  name: string;
  size: number | null;
  /** 版本键：同一路径的新版本必须重新读盘（目录轮询但版本未变时不重读）。 */
  revisionKey?: string;
  /** 面板里空间更窄：工具栏压缩、标题字号下降（不改任何能力）。 */
  variant?: "dialog" | "panel";
  onNotice?: (message: string | null) => void;
}

type ViewMode = "reading" | "source";

const FONT_MIN = 11;
const FONT_MAX = 20;

export default function FileTextPreview({ path, name, size, revisionKey, variant = "dialog", onNotice }: Props) {
  const { t } = useLocale();
  const { preview, loading, error, retry } = useTextPreview(path, revisionKey);
  const ext = extOf(name);
  const markdown = isMarkdownExt(ext);
  const delimited = isDelimitedExt(ext);
  const json = isJsonExt(ext);
  /** Markdown 阅读、CSV 表格、JSON 树形都属于「结构化 ↔ 源码」双模式。 */
  const structured = markdown || delimited || json;
  const language: HighlightLanguage = highlightLanguageOf(ext);

  const [mode, setMode] = useState<ViewMode>(structured ? "reading" : "source");
  /** CSV 表头手动覆盖：`null` = 沿用启发式判断。 */
  const [csvHeader, setCsvHeader] = useState<boolean | null>(null);
  const [wrap, setWrap] = useState(true);
  const [lineNumbers, setLineNumbers] = useState(true);
  const [fontSize, setFontSize] = useState(12);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatch, setActiveMatch] = useState(-1);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [selectionAvailable, setSelectionAvailable] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // 同一实例切换文件（面板/弹窗都可能复用）：重置视图状态，避免把上一个文件的
  // 搜索命中与阅读模式带到新文件上。
  useEffect(() => {
    setMode(structured ? "reading" : "source");
    setQuery("");
    setActiveMatch(-1);
    setCsvHeader(null);
  }, [path, structured]);

  const content = preview?.content ?? "";
  const viewContent = useMemo(() => normalizeNewlines(content), [content]);

  const allLines = useMemo(() => (viewContent ? viewContent.split("\n") : []), [viewContent]);
  const capped = allLines.length > TEXT_RENDER_MAX_LINES;
  const lines = useMemo(
    () => (capped ? allLines.slice(0, TEXT_RENDER_MAX_LINES) : allLines),
    [allLines, capped],
  );
  const visibleContent = useMemo(
    () => (capped ? lines.join("\n") : viewContent),
    [capped, lines, viewContent],
  );
  const lineStarts = useMemo(() => {
    const starts = new Array<number>(lines.length);
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
      starts[i] = offset;
      offset += lines[i].length + 1;
    }
    return starts;
  }, [lines]);

  const highlight = useMemo(
    () => highlightSource(visibleContent, language, HIGHLIGHT_MAX_CHARS),
    [visibleContent, language],
  );

  // 结构化视图与源码视图共用同一份已读入内容：表格/树必须从**完整**文本解析
  // （不能只喂前 5000 行——JSON 会被截成非法，CSV 会静默漏行），
  // 预算由 `csvParse` / `jsonTree` 自己的行、列、节点上限承担。
  const csvTable = useMemo(
    () => (delimited ? parseCsvText(viewContent, { ext, header: csvHeader ?? "auto" }) : null),
    [delimited, viewContent, ext, csvHeader],
  );
  const jsonDoc = useMemo(() => (json ? buildJsonTree(viewContent) : null), [json, viewContent]);
  const jsonFailed = Boolean(jsonDoc && !jsonDoc.ok);
  // 解析失败不留半成品树：强制回源码模式，由提示条说明原因。
  const effectiveMode: ViewMode = jsonFailed ? "source" : mode;

  const markdownDoc = useMemo(
    () => (markdown && effectiveMode === "reading" ? parseMarkdown(visibleContent) : null),
    [markdown, effectiveMode, visibleContent],
  );

  // 搜索与渲染同口径：只扫描**实际渲染**的文本（超过 `TEXT_RENDER_MAX_LINES`
  // 时不偷偷扫描未渲染的尾部，否则会出现「计数 1 条但 DOM 里没有可定位命中」）。
  // 超出渲染预算时在工具栏明示范围受限（见 meta 里的 `searchScopeCapped`）。
  const search = useMemo(
    () => findTextMatches(visibleContent, query, { caseSensitive }),
    [visibleContent, query, caseSensitive],
  );

  // 查询/大小写/文件变化后重新定位到首个命中；清空查询即清除全部高亮。
  useEffect(() => {
    setActiveMatch(search.matches.length > 0 ? 0 : -1);
  }, [search]);

  // 命中定位：滚动到当前命中（jsdom 无布局时静默跳过）。
  useEffect(() => {
    if (activeMatch < 0) return;
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-match-index="${activeMatch}"]`);
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center" });
    }
  }, [activeMatch, mode, lines.length]);

  // 是否存在可复制的选区（只在内容区内才算）。
  useEffect(() => {
    const onSelectionChange = () => {
      const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
      const text = selection?.toString() ?? "";
      const anchor = selection?.anchorNode ?? null;
      setSelectionAvailable(Boolean(text.trim()) && Boolean(anchor && scrollRef.current?.contains(anchor)));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await copyText(content);
    setCopyState(ok ? "ok" : "fail");
    window.setTimeout(() => setCopyState("idle"), 1600);
  }, [content]);

  const onCopySelection = useCallback(async () => {
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    const text = selection?.toString() ?? "";
    if (!text) return;
    const ok = await copyText(text);
    setCopyState(ok ? "ok" : "fail");
    window.setTimeout(() => setCopyState("idle"), 1600);
  }, []);

  const openLink = useCallback(
    (href: string) => {
      void openExternalUrl(href).catch((cause) => {
        onNotice?.(errorMessage(cause));
      });
    },
    [onNotice],
  );

  const step = (direction: 1 | -1) => {
    const next = getNextMatch(search.matches, activeMatch, direction);
    if (next >= 0) setActiveMatch(next);
  };

  if (loading) return <PreviewLoading label={t("fw.preview.loading")} />;
  if (error) {
    return (
      <PreviewError
        title={t("fw.preview.error", { error })}
        detail={name}
        hint={t("fw.preview.fallbackOpen")}
        onRetry={retry}
        retryLabel={t("common.retry")}
      />
    );
  }
  if (!preview) {
    return <PreviewError title={t("fw.preview.error", { error: name })} hint={t("fw.preview.fallbackOpen")} />;
  }

  const lossyEncoding = (preview.encoding ?? "").includes("lossy") || content.includes("\uFFFD");
  const showSource = !structured || effectiveMode === "source";
  /** 文件内搜索只对「文本 / Markdown」可用：表格与 JSON 树没有字符偏移，不假装能查找。 */
  const showSearch = markdown || showSource;
  const degraded = showSource && highlight.degraded;

  return (
    <div className="fw-preview-text" data-variant={variant}>
      <div className="fw-preview-toolbar" role="toolbar" aria-label={t("fw.preview.toolbarAria")}>
        {structured && (
          <div
            className="fw-preview-segment"
            role="group"
            aria-label={
              markdown
                ? t("fw.preview.md.modeAria")
                : delimited
                  ? t("fw.preview.csv.modeAria")
                  : t("fw.preview.json.modeAria")
            }
          >
            <button
              type="button"
              className={`fw-preview-segment-btn${effectiveMode === "reading" ? " is-active" : ""}`}
              aria-pressed={effectiveMode === "reading"}
              disabled={jsonFailed}
              data-tip={jsonFailed ? t("fw.preview.json.fallbackHint") : undefined}
              onClick={() => setMode("reading")}
            >
              {markdown ? (
                <BookOpen size={12} aria-hidden="true" />
              ) : delimited ? (
                <Table2 size={12} aria-hidden="true" />
              ) : (
                <ListTree size={12} aria-hidden="true" />
              )}
              {/* 标签在窄检查器里由容器查询隐藏，只留图标 + tooltip，避免工具栏换成两三行。 */}
              <span className="fw-preview-segment-label">
                {markdown
                  ? t("fw.preview.md.reading")
                  : delimited
                    ? t("fw.preview.csv.mode")
                    : t("fw.preview.json.mode")}
              </span>
            </button>
            <button
              type="button"
              className={`fw-preview-segment-btn${effectiveMode === "source" ? " is-active" : ""}`}
              aria-pressed={effectiveMode === "source"}
              onClick={() => setMode("source")}
            >
              <Code2 size={12} aria-hidden="true" />
              <span className="fw-preview-segment-label">
                {markdown ? t("fw.preview.md.source") : t("fw.preview.sourceMode")}
              </span>
            </button>
          </div>
        )}

        {delimited && !showSource && csvTable && (
          <button
            type="button"
            className={`fw-icon-btn${csvTable.headerDetected ? " is-on" : ""}`}
            aria-label={t("fw.preview.csv.headerToggle")}
            aria-pressed={csvTable.headerDetected}
            data-tip={t("fw.preview.csv.headerToggleHint")}
            onClick={() => setCsvHeader(!csvTable.headerDetected)}
          >
            <span className="fw-preview-font-btn" aria-hidden="true">
              H1
            </span>
          </button>
        )}

        {showSearch && (
          <div className="fw-preview-search">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={t("fw.preview.findPlaceholder")}
              ariaLabel={t("fw.preview.find")}
              clearLabel={t("fw.preview.findClear")}
              size="compact"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <span className="fw-preview-search-count" aria-live="polite">
              {query.trim().length === 0
                ? null
                : search.matches.length > 0
                  ? t("fw.preview.matchCount", {
                      index: activeMatch + 1,
                      total: search.matches.length,
                    })
                  : t("fw.preview.noMatch")}
            </span>
            <button
              type="button"
              className={`fw-icon-btn fw-preview-case${caseSensitive ? " is-on" : ""}`}
              aria-label={t("fw.preview.caseSensitive")}
              aria-pressed={caseSensitive}
              data-tip={t("fw.preview.caseSensitiveHint")}
              onClick={() => setCaseSensitive((value) => !value)}
            >
              <CaseSensitive size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="fw-icon-btn"
              aria-label={t("fw.preview.prevMatch")}
              data-tip={t("fw.preview.prevMatch")}
              disabled={search.matches.length === 0}
              onClick={() => step(-1)}
            >
              <Minus size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="fw-icon-btn"
              aria-label={t("fw.preview.nextMatch")}
              data-tip={t("fw.preview.nextMatch")}
              disabled={search.matches.length === 0}
              onClick={() => step(1)}
            >
              <Plus size={13} aria-hidden="true" />
            </button>
          </div>
        )}

        {(showSource || (delimited && !showSource)) && (
          <div className="fw-preview-toolbar-group">
            <button
              type="button"
              className={`fw-icon-btn${wrap ? " is-on" : ""}`}
              aria-label={t("fw.preview.wrap")}
              aria-pressed={wrap}
              data-tip={t("fw.preview.wrap")}
              onClick={() => setWrap((value) => !value)}
            >
              <WrapText size={14} aria-hidden="true" />
            </button>
            {showSource && (
              <button
                type="button"
                className={`fw-icon-btn${lineNumbers ? " is-on" : ""}`}
                aria-label={t("fw.preview.lineNumbers")}
                aria-pressed={lineNumbers}
                data-tip={t("fw.preview.lineNumbers")}
                onClick={() => setLineNumbers((value) => !value)}
              >
                <ListOrdered size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        <div className="fw-preview-toolbar-group">
          <button
            type="button"
            className="fw-icon-btn"
            aria-label={t("fw.preview.fontSmaller")}
            data-tip={t("fw.preview.fontSmaller")}
            disabled={fontSize <= FONT_MIN}
            onClick={() => setFontSize((value) => Math.max(FONT_MIN, value - 1))}
          >
            <span className="fw-preview-font-btn" aria-hidden="true">
              A-
            </span>
          </button>
          <span className="fw-preview-font-value" aria-hidden="true">
            {fontSize}
          </span>
          <button
            type="button"
            className="fw-icon-btn"
            aria-label={t("fw.preview.fontLarger")}
            data-tip={t("fw.preview.fontLarger")}
            disabled={fontSize >= FONT_MAX}
            onClick={() => setFontSize((value) => Math.min(FONT_MAX, value + 1))}
          >
            <span className="fw-preview-font-btn" aria-hidden="true">
              A+
            </span>
          </button>
        </div>

        <div className="fw-preview-toolbar-group fw-preview-toolbar-group--copy">
          <button
            type="button"
            className="btn sm"
            disabled={!selectionAvailable}
            aria-label={t("fw.preview.copySelection")}
            data-tip={t("fw.preview.copySelection")}
            onClick={() => void onCopySelection()}
          >
            <CopyCheck size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn sm"
            aria-label={
              copyState === "ok"
                ? t("fw.preview.copied")
                : copyState === "fail"
                  ? t("fw.preview.copyFailed")
                  : t("fw.preview.copy")
            }
            data-tip={t("fw.preview.copy")}
            onClick={() => void onCopy()}
          >
            {copyState === "ok" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            <span className="fw-preview-copy-label">
              {copyState === "ok"
                ? t("fw.preview.copied")
                : copyState === "fail"
                  ? t("fw.preview.copyFailed")
                  : t("fw.preview.copy")}
            </span>
          </button>
        </div>
      </div>

      <div className="fw-preview-text-meta">
        <span className="fw-preview-chip">{t("fw.preview.encodingLabel", { encoding: preview.encoding })}</span>
        <span className="fw-preview-chip">{t("fw.preview.sizeLabel", { size: formatSize(size ?? preview.size) })}</span>
        {showSource && <span className="fw-preview-chip">{t("fw.preview.lineCount", { count: allLines.length })}</span>}
        {csvTable && (
          <>
            <span className="fw-preview-chip">
              {t("fw.preview.csv.shape", { rows: csvTable.rowCount, columns: csvTable.columnCount })}
            </span>
            <span className="fw-preview-chip">
              {t("fw.preview.csv.delimiterChip", {
                delimiter: csvTable.delimiter === "\t" ? t("fw.preview.csv.tab") : csvTable.delimiter,
              })}
            </span>
          </>
        )}
        {jsonDoc?.ok && (
          <>
            <span className="fw-preview-chip">{t("fw.preview.json.nodesChip", { count: jsonDoc.nodes })}</span>
            <span className="fw-preview-chip">{t("fw.preview.json.depthChip", { depth: jsonDoc.depth })}</span>
          </>
        )}
        {jsonFailed && <span className="fw-preview-chip is-warn">{t("fw.preview.json.fallbackChip")}</span>}
        {preview.truncated && (
          <span className="fw-preview-chip is-warn">
            <FileWarning size={11} aria-hidden="true" />
            {t("fw.preview.truncatedShort")}
          </span>
        )}
        {showSearch && search.truncated && (
          <span className="fw-preview-chip is-warn">{t("fw.preview.searchTruncated")}</span>
        )}
        {showSearch && capped && (
          <span className="fw-preview-chip is-warn">
            {t("fw.preview.searchScopeCapped", { limit: TEXT_RENDER_MAX_LINES })}
          </span>
        )}
      </div>

      {preview.truncated && <p className="fw-preview-truncated">{t("fw.preview.truncated")}</p>}
      {lossyEncoding && <p className="fw-preview-encoding">{t("fw.preview.encodingWarning")}</p>}
      {degraded && <p className="fw-preview-encoding">{t("fw.preview.highlightOff")}</p>}
      {capped && showSource && (
        <p className="fw-preview-encoding">
          {t("fw.preview.renderCapped", { limit: TEXT_RENDER_MAX_LINES })}
        </p>
      )}
      {markdownDoc?.truncated && <p className="fw-preview-encoding">{t("fw.preview.md.truncated")}</p>}
      {jsonDoc?.error && jsonDoc.error.code !== "empty" && (
        <p className="fw-preview-encoding">
          {jsonDoc.error.code === "too-large"
            ? t("fw.preview.json.tooLarge")
            : jsonDoc.error.position > 0
              ? t("fw.preview.json.invalid", {
                  message: jsonDoc.error.message,
                  position: jsonDoc.error.position,
                })
              : t("fw.preview.json.invalidNoPosition", { message: jsonDoc.error.message })}
        </p>
      )}
      {jsonDoc?.ok && jsonDoc.truncated && (
        <p className="fw-preview-encoding">{t("fw.preview.json.truncated", { nodes: jsonDoc.nodes })}</p>
      )}

      <div
        ref={scrollRef}
        className={`fw-preview-text-scroll${markdownDoc ? " is-markdown" : ""}`}
        data-wrap={wrap ? "true" : "false"}
        data-line-numbers={lineNumbers ? "true" : "false"}
        style={{ ["--fw-preview-font-size" as string]: `${fontSize}px` }}
      >
        {markdownDoc ? (
          <MarkdownView
            blocks={markdownDoc.blocks}
            matches={search.matches}
            activeMatch={activeMatch}
            onOpenLink={openLink}
          />
        ) : csvTable && !showSource ? (
          <CsvTableView table={csvTable} wrap={wrap} />
        ) : jsonDoc?.ok && !showSource ? (
          <JsonTreeView doc={jsonDoc} />
        ) : (
          <div className="fw-preview-code">
            {lines.length === 0 ? (
              <p className="fw-preview-empty-text">{t("fw.preview.emptyFile")}</p>
            ) : (
              lines.map((line, index) => (
                <div className="fw-preview-code-line" key={index}>
                  {lineNumbers && (
                    <span className="fw-preview-line-number" aria-hidden="true">
                      {index + 1}
                    </span>
                  )}
                  <span className="fw-preview-code-text">
                    {degraded
                      ? renderTextWithMatches(line, lineStarts[index], search.matches, activeMatch)
                      : renderTokens(
                          highlight.lines[index] ??
                            tokenizeLine(line, language, createHighlightCursor()),
                          lineStarts[index],
                          search.matches,
                          activeMatch,
                        )}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export type { Props as FileTextPreviewProps };
