//! 多目录联合搜索：只扫描用户勾选的已打开窗格，提供深度、类别、扩展名与时间筛选，
//! 结果可跳转到对应窗格目录。取消只停止后续目录调度，已发出的单次 IPC 不可抢占。

import { useEffect, useRef, useState } from "react";
import { Search, Square, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import Select from "../ui/Select";
import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import {
  DEFAULT_SEARCH_OPTIONS,
  parseExtensions,
  searchWorkspace,
  type SearchHit,
  type SearchProgress,
  type SearchSource,
} from "../../lib/filesWorkspace/workspaceSearch";

export interface WorkspaceSearchRequest {
  sources: SearchSource[];
}

interface Props {
  open: boolean;
  sources: SearchSource[];
  onClose: () => void;
  onReveal: (paneId: string, dirPath: string, filePath: string) => void;
}

const CATEGORY_OPTIONS = [
  { value: "", label: "fw.filter.all" },
  { value: "folder", label: "fw.filter.folder" },
  { value: "image", label: "fw.filter.image" },
  { value: "video", label: "fw.filter.video" },
  { value: "audio", label: "fw.filter.audio" },
  { value: "doc", label: "fw.filter.doc" },
  { value: "sheet", label: "fw.filter.sheet" },
  { value: "slide", label: "fw.filter.slide" },
  { value: "code", label: "fw.filter.code" },
  { value: "archive", label: "fw.filter.archive" },
] as const;

export default function WorkspaceSearchDialog({ open, sources, onClose, onReveal }: Props) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [extensions, setExtensions] = useState("");
  const [category, setCategory] = useState<string>("");
  const [depth, setDepth] = useState("2");
  const [recent, setRecent] = useState("any");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [summary, setSummary] = useState<{ truncated: boolean; failedDirs: number; cancelled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 请求代际：只有最新一代允许写结果、进度、状态和清理控制器。 */
  const requestSeq = useRef(0);

  useEffect(() => {
    requestSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (open) {
      setSelected(sources.map((source) => source.paneId));
      setHits([]);
      setSummary(null);
      setError(null);
      setProgress(null);
      setRunning(false);
    }
  }, [open, sources]);

  const run = async () => {
    if (running || selected.length === 0) return;
    abortRef.current?.abort();
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setHits([]);
    setSummary(null);
    setError(null);
    setProgress(null);
    try {
      const result = await searchWorkspace(
        sources.filter((source) => selected.includes(source.paneId)),
        {
          ...DEFAULT_SEARCH_OPTIONS,
          query,
          extensions: parseExtensions(extensions),
          category: category || null,
          modifiedWithinDays: recent === "any" ? null : Number(recent),
          maxDepth: Number(depth),
        },
        (next) => {
          if (seq === requestSeq.current) setProgress(next);
        },
        controller.signal,
      );
      if (seq !== requestSeq.current) return;
      setHits(result.hits);
      setSummary({ truncated: result.truncated, failedDirs: result.failedDirs, cancelled: result.cancelled });
    } catch (e) {
      if (seq !== requestSeq.current) return;
      if ((e as { name?: string }).name === "AbortError") {
        setSummary({ truncated: false, failedDirs: 0, cancelled: true });
      } else {
        setError(errorMessage(e));
      }
    } finally {
      if (seq === requestSeq.current) {
        setRunning(false);
        abortRef.current = null;
      }
    }
  };

  const stop = () => {
    requestSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const toggleSource = (paneId: string) => {
    // 搜索目录变化会让上一代结果失去意义，立即失效并停止运行。
    stop();
    setSummary(null);
    setHits([]);
    setSelected((current) =>
      current.includes(paneId) ? current.filter((id) => id !== paneId) : [...current, paneId],
    );
  };

  const depthOptions = [
    { value: "0", label: t("fw.search.depthCurrent") },
    { value: "1", label: t("fw.search.depth1") },
    { value: "2", label: t("fw.search.depth2") },
    { value: "3", label: t("fw.search.depth3") },
    { value: "4", label: t("fw.search.depth4") },
  ];
  const recentOptions = [
    { value: "any", label: t("fw.search.recentAny") },
    { value: "7", label: t("fw.search.recent7") },
    { value: "30", label: t("fw.search.recent30") },
  ];

  return (
    <Dialog open={open} onClose={onClose} title={t("fw.search.title")} size="lg" className="fw-search-dialog">
      <div className="fw-search-form">
        <label className="fw-search-field fw-search-grow">
          <span>{t("fw.search.keyword")}</span>
          <input
            value={query}
            placeholder={t("fw.search.keywordPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void run();
            }}
          />
        </label>
        <label className="fw-search-field">
          <span>{t("fw.search.extensions")}</span>
          <input value={extensions} placeholder="png, mp4, tsx" onChange={(event) => setExtensions(event.target.value)} />
        </label>
        <div className="fw-search-field">
          <span>{t("fw.search.category")}</span>
          <Select
            value={category}
            options={CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
            onChange={setCategory}
            ariaLabel={t("fw.search.category")}
            size="sm"
            block
          />
        </div>
        <div className="fw-search-field">
          <span>{t("fw.search.depth")}</span>
          <Select value={depth} options={depthOptions} onChange={setDepth} ariaLabel={t("fw.search.depth")} size="sm" block />
        </div>
        <div className="fw-search-field">
          <span>{t("fw.search.recent")}</span>
          <Select value={recent} options={recentOptions} onChange={setRecent} ariaLabel={t("fw.search.recent")} size="sm" block />
        </div>
      </div>

      <div className="fw-search-sources" role="group" aria-label={t("fw.search.sources")}>
        {sources.map((source) => (
          <button
            key={source.paneId}
            type="button"
            className={`fw-search-source${selected.includes(source.paneId) ? " is-on" : ""}`}
            aria-pressed={selected.includes(source.paneId)}
            title={source.path}
            onClick={() => toggleSource(source.paneId)}
          >
            <Square size={9} aria-hidden="true" />
            <span className="fw-search-source-label">{source.label}</span>
            <span className="fw-search-source-path">{source.path}</span>
          </button>
        ))}
      </div>

      {progress && (
        <div className="fw-search-progress" role="status">
          {t("fw.search.progress", {
            dirs: progress.dirsVisited,
            files: progress.filesScanned,
            hits: progress.hits,
          })}
        </div>
      )}

      {summary && (
        <div className="fw-search-summary" role="status">
          {summary.cancelled
            ? t("fw.search.cancelled")
            : t("fw.search.summary", { count: hits.length })}
          {summary.truncated && <span className="fw-search-warn"> · {t("fw.search.truncated")}</span>}
          {summary.failedDirs > 0 && (
            <span className="fw-search-warn"> · {t("fw.search.failedDirs", { count: summary.failedDirs })}</span>
          )}
        </div>
      )}

      {error && (
        <div className="fw-search-summary" role="alert">
          <span className="fw-search-warn">{t("fw.search.failed", { error })}</span>
        </div>
      )}

      <div className="fw-search-results">
        {hits.length === 0 ? (
          <div className="fw-search-empty">{running ? t("fw.search.searching") : t("fw.search.empty")}</div>
        ) : (
          hits.map((hit) => (
            <button
              key={hit.path}
              type="button"
              className="fw-search-row"
              title={hit.path}
              onClick={() => onReveal(hit.paneId, hit.dirPath, hit.path)}
            >
              <span className="fw-search-row-name">{hit.entry.name}</span>
              <span className="fw-search-row-dir">{hit.dirPath}</span>
              <span className="fw-search-row-pane">{hit.paneLabel}</span>
            </button>
          ))
        )}
      </div>

      <div className="fw-dialog-footer">
        <button type="button" className="btn sm" onClick={onClose}>
          <X size={12} aria-hidden="true" />
          {t("common.close")}
        </button>
        {running ? (
          <button type="button" className="btn sm" onClick={stop}>
            {t("fw.search.stop")}
          </button>
        ) : (
          <button type="button" className="btn sm primary" disabled={selected.length === 0} onClick={() => void run()}>
            <Search size={12} aria-hidden="true" />
            {t("fw.search.start")}
          </button>
        )}
      </div>
    </Dialog>
  );
}
