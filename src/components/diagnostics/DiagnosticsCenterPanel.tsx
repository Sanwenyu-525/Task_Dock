//! 诊断中心：完整模式左侧导航的独立页面入口（默认隐藏，用户可在「导航自定义」开启）。
//!
//! 边界与约束：
//! - **薄视图**：状态、摘要、查询、导出、清理全部复用 `lib/bridge.ts` 的 diagnostics*
//!   API；前端不重写日志扫描、聚合、恢复判定与导出逻辑。
//! - **按需加载**：只在页面挂载且完整面板可见时请求一次；筛选/刷新/清理后显式再请求。
//!   不注册定时器、不做后台轮询。
//! - **失败 ≠ 空**：读取失败显示「读取失败：<原因>」；只有成功且 0 条时才显示「没有日志」。
//! - **清理需二次确认**：确认后调用后端；CONFLICT / TIMEOUT 等错误原样展示，不自动重试。
//! - 视觉只用语义 Token；窄窗（320/400）下筛选自动换行、长文本截断。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog, Select } from "../ui";
import { errorMessage } from "../../lib/errors";
import {
  diagnosticsClear,
  diagnosticsExport,
  diagnosticsOpenDir,
  diagnosticsQuery,
  diagnosticsStatus,
  diagnosticsSummary,
  type DiagnosticEventRecord,
  type DiagnosticLevel,
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticSummary,
  type DiagnosticSummaryGroup,
  type DiagnosticsStatus,
} from "../../lib/bridge";
import { setClientVerboseMode } from "../../lib/diagnostics";
import type { MessageKey } from "../../i18n";

const PAGE_SIZE = 30;
const RANGE_HOURS: Record<RangeKey, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  all: 0,
};

type RangeKey = "1h" | "24h" | "7d" | "all";
type LevelKey = "ALL" | "WARN" | "ERROR" | "CRITICAL";

interface FilterDraft {
  range: RangeKey;
  module: string;
  level: LevelKey;
  errorCode: string;
  operationId: string;
  keyword: string;
}

const INITIAL_FILTER: FilterDraft = {
  range: "24h",
  module: "ALL",
  level: "ALL",
  errorCode: "ALL",
  operationId: "",
  keyword: "",
};

/** 导出结果：`complete` / `flushIssue` 来自后端导出契约（旧后端缺省时按 truncated 推断）。 */
type ExportOutcome = {
  path: string;
  bytes: number;
  records: number;
  truncated: boolean;
  complete?: boolean;
  flushIssue?: string | null;
};

/** 清理结果：`completed=false` 表示超时/取消，日志未被删除。 */
type ClearOutcome = {
  removedBytes: number;
  completed?: boolean;
  status: DiagnosticsStatus;
};

const FLUSH_ISSUE_KEYS: Record<string, MessageKey> = {
  queue_full: "diagnosticsCenter.export.reason.queue_full",
  timeout: "diagnosticsCenter.export.reason.timeout",
  not_flushed: "diagnosticsCenter.export.reason.not_flushed",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 日志时间戳只保留「月-日 时:分:秒」，完整值放 data-tip。 */
function shortTime(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function levelClass(level: DiagnosticLevel): string {
  return `diag-level diag-level-${level.toLowerCase()}`;
}

function groupKey(group: DiagnosticSummaryGroup): string {
  return `${group.module}|${group.action}|${group.errorCode ?? "-"}`;
}

function sinceForRange(range: RangeKey): string | undefined {
  const hours = RANGE_HOURS[range];
  if (!hours) return undefined;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** 把草稿转成 IPC 查询参数。`offset` 省略时导出/摘要不传分页参数。 */
function buildFilter(draft: FilterDraft, offset?: number): DiagnosticQuery {
  return {
    levels: draft.level === "ALL" ? undefined : [draft.level],
    modules: draft.module === "ALL" ? undefined : [draft.module],
    errorCodes: draft.errorCode === "ALL" ? undefined : [draft.errorCode],
    operationId: draft.operationId.trim() ? draft.operationId.trim() : undefined,
    text: draft.keyword.trim() ? draft.keyword.trim() : undefined,
    since: sinceForRange(draft.range),
    // 本页是「异常列表」：级别筛选最低 WARN，与摘要口径一致。
    anomaliesOnly: true,
    limit: offset === undefined ? undefined : PAGE_SIZE,
    offset,
  };
}

export default function DiagnosticsCenterPanel() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const fullVisible = useFullViewVisible();

  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [health, setHealth] = useState<DiagnosticSummary | null>(null);
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [page, setPage] = useState<DiagnosticPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [lastExport, setLastExport] = useState<{
    path: string;
    complete: boolean;
    truncated: boolean;
    flushIssue: string | null;
  } | null>(null);

  const [draft, setDraft] = useState<FilterDraft>(INITIAL_FILTER);
  // 只有「已应用」的筛选会触发请求：输入框打字不产生 IPC。
  const [applied, setApplied] = useState<FilterDraft>(INITIAL_FILTER);

  /** 请求序号：快速切换筛选时丢弃过期响应（不做无上限排队）。 */
  const requestSeq = useRef(0);

  const load = useCallback(
    async (nextOffset: number) => {
      const seq = ++requestSeq.current;
      setBusy("load");
      try {
        const listFilter = buildFilter(applied, nextOffset);
        // 分面摘要不按模块/错误码收窄，否则选中后下拉只剩自己、无法再切换。
        const facetFilter = buildFilter(
          { ...applied, module: "ALL", errorCode: "ALL" },
          undefined,
        );
        const [nextStatus, nextHealth, nextFacets, nextPage] = await Promise.all([
          diagnosticsStatus(),
          diagnosticsSummary({ since: sinceForRange("24h"), anomaliesOnly: true }),
          diagnosticsSummary(facetFilter),
          diagnosticsQuery(listFilter),
        ]);
        if (seq !== requestSeq.current) return;
        setStatus(nextStatus);
        setHealth(nextHealth);
        setSummary(nextFacets);
        setPage(nextPage);
        setOffset(nextOffset);
        setLoadError(null);
        setLoaded(true);
        setClientVerboseMode(nextStatus.mode === "verbose");
      } catch (e) {
        if (seq !== requestSeq.current) return;
        // 读取失败绝不能退化成「没有日志」：清空数据并进入独立错误态。
        setLoadError(errorMessage(e));
        setStatus(null);
        setHealth(null);
        setSummary(null);
        setPage(null);
      } finally {
        if (seq === requestSeq.current) setBusy(null);
      }
    },
    [applied],
  );

  // 只在完整面板可见（页面真正显示）时加载；离开/停靠后不再请求。
  useEffect(() => {
    if (!fullVisible) return;
    void load(0);
  }, [fullVisible, load]);

  function applyFilter(next: FilterDraft) {
    setDraft(next);
    setApplied(next);
  }

  const moduleOptions = useMemo(() => {
    const options = [{ value: "ALL", label: t("diagnosticsCenter.filter.moduleAll") }];
    const seen = new Set<string>();
    for (const item of summary?.byModule ?? []) {
      seen.add(item.key);
      options.push({ value: item.key, label: `${item.key} (${item.count})` });
    }
    // 当前选中项必须始终可选，否则筛选后下拉会显示占位符。
    if (draft.module !== "ALL" && !seen.has(draft.module)) {
      options.push({ value: draft.module, label: draft.module });
    }
    return options;
  }, [summary, draft.module, t]);

  const codeOptions = useMemo(() => {
    const options = [{ value: "ALL", label: t("diagnosticsCenter.filter.codeAll") }];
    const seen = new Set<string>();
    for (const item of summary?.byCode ?? []) {
      seen.add(item.key);
      options.push({ value: item.key, label: `${item.key} (${item.count})` });
    }
    if (draft.errorCode !== "ALL" && !seen.has(draft.errorCode)) {
      options.push({ value: draft.errorCode, label: draft.errorCode });
    }
    return options;
  }, [summary, draft.errorCode, t]);

  const levelOptions = useMemo(
    () => [
      { value: "ALL", label: t("diagnosticsCenter.filter.levelAll") },
      { value: "WARN", label: "WARN" },
      { value: "ERROR", label: "ERROR" },
      { value: "CRITICAL", label: "CRITICAL" },
    ],
    [t],
  );

  const rangeOptions = useMemo(
    () => [
      { value: "1h", label: t("diagnosticsCenter.range.1h") },
      { value: "24h", label: t("diagnosticsCenter.range.24h") },
      { value: "7d", label: t("diagnosticsCenter.range.7d") },
      { value: "all", label: t("diagnosticsCenter.range.all") },
    ],
    [t],
  );

  /** 最近 24 小时的最近异常（按 lastSeen，而非聚合次数排序）。 */
  const latestAnomaly = useMemo(() => {
    let latest: DiagnosticSummaryGroup | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const group of health?.groups ?? []) {
      const at = Date.parse(group.lastSeen);
      if (!Number.isFinite(at)) continue;
      if (at > latestAt) {
        latest = group;
        latestAt = at;
      }
    }
    return latest;
  }, [health]);

  /** 从摘要分组回填「已恢复」：事件行本身没有恢复判定，摘要才有。 */
  const recoveredGroups = useMemo(() => {
    const map = new Set<string>();
    for (const group of summary?.groups ?? []) {
      if (group.recovered) map.add(groupKey(group));
    }
    return map;
  }, [summary]);

  async function copyText(text: string, okMessage: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t("diagnosticsCenter.list.clipboardUnavailable"));
      }
      await navigator.clipboard.writeText(text);
      showToast(okMessage, { kind: "success" });
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function onCopyOperation(operationId: string) {
    await copyText(operationId, t("diagnosticsCenter.list.copyOperationOk"));
  }

  async function onCopySummary() {
    const lines: string[] = [`Task Dock ${t("diagnosticsCenter.title")}`];
    if (status) {
      lines.push(
        `session=${status.sessionId} mode=${status.mode} files=${status.files.length} size=${formatBytes(status.totalBytes)} written=${status.written} dropped=${status.dropped} aggregated=${status.aggregated} failures=${status.failures}`,
      );
    }
    if (health) {
      lines.push(
        `errors24h=${health.errors} warnings24h=${health.warnings} generatedAt=${health.generatedAt}${health.truncated ? " (truncated)" : ""}`,
      );
    }
    if (summary) {
      lines.push(
        `errors=${summary.errors} warnings=${summary.warnings} total=${summary.total} scanned=${summary.scanned}${summary.truncated ? " (truncated)" : ""}`,
      );
      for (const group of summary.groups.slice(0, 15)) {
        lines.push(
          `${group.level} ${group.module}/${group.action} code=${group.errorCode ?? "-"} count=${group.count} last=${group.lastSeen}${group.recovered ? " recovered" : ""}${group.sampleMessage ? ` :: ${group.sampleMessage}` : ""}`,
        );
      }
    }
    if (lines.length === 1) return;
    await copyText(lines.join("\n"), t("diagnosticsCenter.toast.copied"));
  }

  async function onExport() {
    setBusy("export");
    setActionError(null);
    try {
      const filter = buildFilter(applied);
      delete filter.offset;
      delete filter.limit;
      const result = (await diagnosticsExport(filter)) as ExportOutcome;
      const complete = result.complete ?? !result.truncated;
      setLastExport({
        path: result.path,
        complete,
        truncated: result.truncated,
        flushIssue: result.flushIssue ?? null,
      });
      showToast(
        t("diagnosticsCenter.toast.exported", {
          records: result.records,
          size: formatBytes(result.bytes),
        }),
        { kind: complete ? "success" : "warning" },
      );
    } catch (e) {
      // 原样展示后端错误（磁盘满、权限不足等），不做静默重试。
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function onOpenDir() {
    setActionError(null);
    try {
      await diagnosticsOpenDir();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function onClear() {
    setBusy("clear");
    setActionError(null);
    try {
      const result = (await diagnosticsClear()) as ClearOutcome;
      setStatus(result.status);
      setConfirmClear(false);
      if (result.completed === false) {
        // 后端已超时/取消：日志未被删除，不自动重试。
        showToast(t("diagnosticsCenter.toast.clearIncomplete"), { kind: "warning" });
      } else {
        showToast(
          t("diagnosticsCenter.toast.cleared", { size: formatBytes(result.removedBytes) }),
          { kind: "success" },
        );
      }
      await load(0);
    } catch (e) {
      // CONFLICT / TIMEOUT 等并发清理错误：展示后端原文，不重试。
      const message = errorMessage(e);
      setActionError(message);
      setConfirmClear(false);
      showToast(message, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  /** 导出报告不完整时的原因（flushIssue + 截断），用于可解释警告。 */
  const exportIncompleteReason = useMemo(() => {
    if (!lastExport || lastExport.complete) return null;
    const reasons: string[] = [];
    if (lastExport.flushIssue) {
      const key = FLUSH_ISSUE_KEYS[lastExport.flushIssue];
      reasons.push(key ? t(key) : t("diagnosticsCenter.export.reason.unknown"));
    }
    if (lastExport.truncated) reasons.push(t("diagnosticsCenter.export.reason.truncated"));
    if (reasons.length === 0) reasons.push(t("diagnosticsCenter.export.reason.unknown"));
    return reasons.join(" ");
  }, [lastExport, t]);

  const verboseMinutes =
    status?.mode === "verbose" && status.verboseRemainingMs > 0
      ? Math.ceil(status.verboseRemainingMs / 60_000)
      : 0;

  return (
    <div className="diag-center">
      <header className="diag-center-head">
        <div className="diag-center-head-text">
          <h1 className="diag-center-title">{t("diagnosticsCenter.title")}</h1>
          <p className="diag-center-subtitle">{t("diagnosticsCenter.subtitle")}</p>
        </div>
        <div className="diag-center-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => void load(offset)}
            disabled={busy === "load" || !fullVisible}
            aria-label={t("diagnosticsCenter.action.refresh")}
            data-tip={t("diagnosticsCenter.action.refresh")}
          >
            <RefreshCw
              size={12}
              className={busy === "load" ? "spin" : undefined}
              aria-hidden="true"
            />
            <span>{t("diagnosticsCenter.action.refresh")}</span>
          </button>
          <button type="button" className="btn sm" onClick={() => void onCopySummary()}>
            <Copy size={12} aria-hidden="true" />
            <span>{t("diagnosticsCenter.action.copySummary")}</span>
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void onExport()}
            disabled={busy === "export"}
          >
            <Download size={12} aria-hidden="true" />
            <span>{t("diagnosticsCenter.action.export")}</span>
          </button>
          <button type="button" className="btn sm" onClick={() => void onOpenDir()}>
            <FolderOpen size={12} aria-hidden="true" />
            <span>{t("diagnosticsCenter.action.openDir")}</span>
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => setConfirmClear(true)}
            disabled={busy === "clear"}
          >
            <Trash2 size={12} aria-hidden="true" />
            <span>{t("diagnosticsCenter.action.clear")}</span>
          </button>
        </div>
      </header>

      {loadError && (
        <div className="diag-center-state is-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{t("diagnosticsCenter.list.error", { error: loadError })}</span>
        </div>
      )}
      {actionError && (
        <div className="diag-center-state is-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}
      {status?.degraded && (
        <div className="diag-center-note is-warn" role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>
            {t("diagnosticsCenter.overview.degraded")}
            {status.lastError ? ` (${status.lastError})` : ""}
          </span>
        </div>
      )}

      <section className="diag-center-overview" aria-label={t("diagnosticsCenter.overview.title")}>
        <h2 className="diag-center-section-title">{t("diagnosticsCenter.overview.title")}</h2>
        <div className="diag-center-metrics">
          <div className="diag-center-metric">
            <span className="diag-center-metric-label">
              {t("diagnosticsCenter.overview.errors")}
            </span>
            <span className="diag-center-metric-value is-error">
              {health ? health.errors : "—"}
            </span>
          </div>
          <div className="diag-center-metric">
            <span className="diag-center-metric-label">
              {t("diagnosticsCenter.overview.warnings")}
            </span>
            <span className="diag-center-metric-value is-warn">
              {health ? health.warnings : "—"}
            </span>
          </div>
          <div className="diag-center-metric diag-center-metric-wide">
            <span className="diag-center-metric-label">
              {t("diagnosticsCenter.overview.latest")}
            </span>
            <span className="diag-center-metric-value">
              {latestAnomaly ? (
                <span className="diag-center-latest" data-tip={latestAnomaly.lastSeen}>
                  <span className={levelClass(latestAnomaly.level)}>{latestAnomaly.level}</span>
                  <span className="diag-center-ellipsis">
                    {latestAnomaly.module}/{latestAnomaly.action}
                  </span>
                  <span className="diag-center-mono">
                    {shortTime(latestAnomaly.lastSeen)}
                  </span>
                </span>
              ) : health ? (
                t("diagnosticsCenter.overview.latestNone")
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="diag-center-metric">
            <span className="diag-center-metric-label">
              {t("diagnosticsCenter.overview.mode")}
            </span>
            <span className="diag-center-metric-value">
              {status
                ? status.mode === "verbose"
                  ? t("diagnosticsCenter.overview.modeVerbose")
                  : t("diagnosticsCenter.overview.modeNormal")
                : "—"}
              {verboseMinutes > 0 && (
                <span className="diag-center-metric-hint">
                  {t("diagnosticsCenter.overview.remaining", { minutes: verboseMinutes })}
                </span>
              )}
            </span>
          </div>
        </div>
      </section>

      <section className="diag-center-filters" aria-label={t("diagnosticsCenter.filter.title")}>
        <h2 className="diag-center-section-title">{t("diagnosticsCenter.filter.title")}</h2>
        <div className="diag-center-filter-grid">
          <div className="diag-center-field">
            <span className="diag-center-field-label">
              {t("diagnosticsCenter.filter.range")}
            </span>
            <Select
              value={draft.range}
              options={rangeOptions}
              onChange={(value) => applyFilter({ ...draft, range: value as RangeKey })}
              ariaLabel={t("diagnosticsCenter.filter.range")}
              size="sm"
              align="start"
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">
              {t("diagnosticsCenter.filter.level")}
            </span>
            <Select
              value={draft.level}
              options={levelOptions}
              onChange={(value) => applyFilter({ ...draft, level: value as LevelKey })}
              ariaLabel={t("diagnosticsCenter.filter.level")}
              size="sm"
              align="start"
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">
              {t("diagnosticsCenter.filter.module")}
            </span>
            <Select
              value={draft.module}
              options={moduleOptions}
              onChange={(value) => applyFilter({ ...draft, module: value })}
              ariaLabel={t("diagnosticsCenter.filter.module")}
              size="sm"
              align="start"
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">
              {t("diagnosticsCenter.filter.code")}
            </span>
            <Select
              value={draft.errorCode}
              options={codeOptions}
              onChange={(value) => applyFilter({ ...draft, errorCode: value })}
              ariaLabel={t("diagnosticsCenter.filter.code")}
              size="sm"
              align="start"
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">
              {t("diagnosticsCenter.filter.operation")}
            </span>
            <div className="diag-center-input-row">
              <input
                className="diag-center-input diag-center-mono"
                type="text"
                value={draft.operationId}
                placeholder={t("diagnosticsCenter.filter.operationPlaceholder")}
                aria-label={t("diagnosticsCenter.filter.operation")}
                onChange={(event) =>
                  setDraft({ ...draft, operationId: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyFilter(draft);
                }}
              />
              <button
                type="button"
                className="icon-btn sm"
                disabled={!draft.operationId.trim()}
                aria-label={t("diagnosticsCenter.list.copyOperation")}
                data-tip={t("diagnosticsCenter.list.copyOperation")}
                onClick={() => void onCopyOperation(draft.operationId.trim())}
              >
                <Copy size={11} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">
              {t("diagnosticsCenter.filter.keyword")}
            </span>
            <input
              className="diag-center-input"
              type="search"
              value={draft.keyword}
              placeholder={t("diagnosticsCenter.filter.keywordPlaceholder")}
              aria-label={t("diagnosticsCenter.filter.keyword")}
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilter(draft);
              }}
            />
          </div>
          <div className="diag-center-filter-actions">
            <button type="button" className="btn sm" onClick={() => applyFilter(draft)}>
              {t("diagnosticsCenter.filter.apply")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => applyFilter(INITIAL_FILTER)}
            >
              {t("diagnosticsCenter.filter.reset")}
            </button>
          </div>
        </div>
      </section>

      {lastExport && (
        <div className="diag-center-export">
          <span className="diag-center-export-label">
            {t("diagnosticsCenter.export.last")}
          </span>
          <span className="diag-center-mono diag-center-ellipsis" data-tip={lastExport.path}>
            {lastExport.path}
          </span>
          <span
            className={`diag-center-flag ${lastExport.complete ? "is-ok" : "is-warn"}`}
            data-tip={exportIncompleteReason ?? undefined}
          >
            {lastExport.complete
              ? t("diagnosticsCenter.export.complete")
              : t("diagnosticsCenter.export.incompleteFlag")}
          </span>
          {exportIncompleteReason && (
            <div className="diag-center-note is-warn" role="status">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>
                {t("diagnosticsCenter.export.incomplete", {
                  reason: exportIncompleteReason,
                })}
              </span>
            </div>
          )}
        </div>
      )}

      <section className="diag-center-list" aria-label={t("diagnosticsCenter.list.title")}>
        <div className="diag-center-list-head">
          <h2 className="diag-center-section-title">{t("diagnosticsCenter.list.title")}</h2>
          {page && (
            <span className="diag-center-list-meta">
              {t("diagnosticsCenter.list.pageInfo", {
                shown: page.items.length,
                matched: page.matched,
              })}
            </span>
          )}
        </div>

        {loadError ? null : !loaded ? (
          <div className="diag-center-state">{t("diagnosticsCenter.list.loading")}</div>
        ) : page && page.items.length > 0 ? (
          <ul className="diag-center-rows">
            {page.items.map((item: DiagnosticEventRecord, index) => {
              const rowKey = `${item.timestamp}-${index}`;
              const isOpen = expanded === rowKey;
              const recovered = recoveredGroups.has(
                `${item.module}|${item.action}|${item.error_code ?? "-"}`,
              );
              return (
                <li key={rowKey} className="diag-center-row-item">
                  <button
                    type="button"
                    className="diag-center-row"
                    aria-expanded={isOpen}
                    aria-label={
                      isOpen
                        ? t("diagnosticsCenter.list.collapse")
                        : t("diagnosticsCenter.list.expand")
                    }
                    onClick={() => setExpanded(isOpen ? null : rowKey)}
                  >
                    {isOpen ? (
                      <ChevronDown size={12} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={12} aria-hidden="true" />
                    )}
                    <span className={levelClass(item.level)}>{item.level}</span>
                    <span className="diag-center-time" data-tip={item.timestamp}>
                      {shortTime(item.timestamp)}
                    </span>
                    <span className="diag-center-module">{item.module}</span>
                    <span className="diag-center-action diag-center-ellipsis">
                      {item.action}
                    </span>
                    {item.error_code && (
                      <span className="diag-center-code diag-center-ellipsis">
                        {item.error_code}
                      </span>
                    )}
                    {item.stage && <span className="diag-center-stage">{item.stage}</span>}
                    {item.count > 1 && (
                      <span className="diag-center-count">×{item.count}</span>
                    )}
                    {recovered && (
                      <span className="diag-center-recovered">
                        {t("diagnosticsCenter.list.recovered")}
                      </span>
                    )}
                  </button>
                  {isOpen && (
                    <dl className="diag-center-details">
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.list.duration")}</dt>
                        <dd className="diag-center-mono">
                          {item.duration_ms !== undefined
                            ? `${item.duration_ms} ms`
                            : t("diagnosticsCenter.list.none")}
                        </dd>
                      </div>
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.list.window")}</dt>
                        <dd className="diag-center-mono diag-center-ellipsis">
                          {item.window_id ?? t("diagnosticsCenter.list.none")}
                        </dd>
                      </div>
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.list.session")}</dt>
                        <dd className="diag-center-mono diag-center-ellipsis">
                          {item.session_id}
                        </dd>
                      </div>
                      <div className="diag-center-detail diag-center-detail-wide">
                        <dt>{t("diagnosticsCenter.list.operation")}</dt>
                        <dd className="diag-center-op">
                          <span className="diag-center-mono diag-center-ellipsis">
                            {item.operation_id ?? t("diagnosticsCenter.list.none")}
                          </span>
                          {item.operation_id && (
                            <button
                              type="button"
                              className="icon-btn sm"
                              aria-label={t("diagnosticsCenter.list.copyOperation")}
                              data-tip={t("diagnosticsCenter.list.copyOperation")}
                              onClick={() => void onCopyOperation(item.operation_id!)}
                            >
                              <Copy size={11} aria-hidden="true" />
                            </button>
                          )}
                        </dd>
                      </div>
                      <div className="diag-center-detail diag-center-detail-wide">
                        <dt>{t("diagnosticsCenter.list.message")}</dt>
                        <dd className="diag-center-message">
                          {item.message ?? t("diagnosticsCenter.list.none")}
                        </dd>
                      </div>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="diag-center-state">
            <strong>{t("diagnosticsCenter.list.empty")}</strong>
            <span>{t("diagnosticsCenter.list.emptyHint")}</span>
          </div>
        )}

        {!loadError && (page?.truncated || (page?.skipped ?? 0) > 0) && (
          <div className="diag-center-note">
            {page?.truncated && <span>{t("diagnosticsCenter.list.truncated")}</span>}
            {(page?.skipped ?? 0) > 0 && (
              <span>{t("diagnosticsCenter.list.skipped", { count: page!.skipped })}</span>
            )}
          </div>
        )}

        <div className="diag-center-pager">
          <button
            type="button"
            className="btn sm"
            onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || busy === "load"}
          >
            {t("diagnosticsCenter.list.prev")}
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void load(offset + PAGE_SIZE)}
            disabled={
              !page || page.matched <= offset + page.items.length || busy === "load"
            }
          >
            {t("diagnosticsCenter.list.next")}
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmClear}
        title={t("diagnosticsCenter.clear.title")}
        detail={t("diagnosticsCenter.clear.detail")}
        confirmLabel={t("diagnosticsCenter.clear.confirm")}
        danger
        busy={busy === "clear"}
        onConfirm={() => void onClear()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
