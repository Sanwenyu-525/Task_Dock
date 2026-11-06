//! 设置页「诊断与日志」：最近异常、日志筛选、诊断模式、容量与导出。
//!
//! 边界与约束：
//! - **只读**：除「清理历史日志」外不改任何数据；清理只删除诊断目录内本模块文件；
//! - **按需加载**：本组件只在分组展开时挂载（`CollapsibleSection` 折叠即卸载）；
//! - **不分页扫全量**：查询走 IPC 分页（每页 30 条），后端另有行数/时间预算；
//! - **无持续刷新**：只有用户点「刷新」或改变筛选时请求，不注册定时器；
//! - 复用设置页现有视觉（`.setting-row` / `.btn sm` / 语义 Token）与公共组件。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Download,
  FolderOpen,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui/Dialog";
import { Select } from "../ui";
import {
  diagnosticsClear,
  diagnosticsExport,
  diagnosticsSetMode,
  diagnosticsOpenDir,
  diagnosticsQuery,
  diagnosticsStatus,
  diagnosticsSummary,
  type DiagnosticEventRecord,
  type DiagnosticLevel,
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticSummary,
  type DiagnosticsStatus,
} from "../../lib/bridge";
import { setClientVerboseMode } from "../../lib/diagnostics";

const PAGE_SIZE = 30;
const RANGE_HOURS: Record<string, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
};

type RangeKey = "1h" | "24h" | "7d" | "all";
type LevelKey = "ALL" | "WARN" | "ERROR" | "CRITICAL";

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

export default function DiagnosticsLogsSection() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);

  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [page, setPage] = useState<DiagnosticPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [level, setLevel] = useState<LevelKey>("ALL");
  const [moduleFilter, setModuleFilter] = useState("ALL");
  const [range, setRange] = useState<RangeKey>("24h");
  const [text, setText] = useState("");

  /** 请求序号：筛选快速切换时丢弃过期响应（不做无上限排队）。 */
  const requestSeq = useRef(0);

  const buildFilter = useCallback(
    (nextOffset: number): DiagnosticQuery => {
      const since =
        range === "all"
          ? undefined
          : new Date(Date.now() - (RANGE_HOURS[range] ?? 24) * 3_600_000).toISOString();
      return {
        levels: level === "ALL" ? undefined : [level],
        modules: moduleFilter === "ALL" ? undefined : [moduleFilter],
        since,
        text: text.trim() ? text.trim() : undefined,
        limit: PAGE_SIZE,
        offset: nextOffset,
      };
    },
    [level, moduleFilter, range, text],
  );

  const load = useCallback(
    async (nextOffset: number) => {
      const seq = ++requestSeq.current;
      setBusy("load");
      try {
        const filter = buildFilter(nextOffset);
        const [nextStatus, nextSummary, nextPage] = await Promise.all([
          diagnosticsStatus(),
          diagnosticsSummary({ ...filter, anomaliesOnly: true, limit: undefined, offset: 0 }),
          diagnosticsQuery(filter),
        ]);
        if (seq !== requestSeq.current) return;
        setStatus(nextStatus);
        setSummary(nextSummary);
        setPage(nextPage);
        setOffset(nextOffset);
        setError(null);
        setClientVerboseMode(nextStatus.mode === "verbose");
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setError(String(e));
      } finally {
        if (seq === requestSeq.current) setBusy(null);
      }
    },
    [buildFilter],
  );

  // 首屏加载一次；筛选变化时回到第一页（不做轮询）。
  useEffect(() => {
    void load(0);
  }, [load]);

  const moduleOptions = useMemo(() => {
    const options = [{ value: "ALL", label: t("settings.diagnosticsLogs.filter.moduleAll") }];
    for (const item of summary?.byModule ?? []) {
      options.push({ value: item.key, label: `${item.key} (${item.count})` });
    }
    return options;
  }, [summary, t]);

  const levelOptions = useMemo(
    () => [
      { value: "ALL", label: t("settings.diagnosticsLogs.filter.levelAll") },
      { value: "WARN", label: "WARN" },
      { value: "ERROR", label: "ERROR" },
      { value: "CRITICAL", label: "CRITICAL" },
    ],
    [t],
  );

  const rangeOptions = useMemo(
    () => [
      { value: "1h", label: t("settings.diagnosticsLogs.range.1h") },
      { value: "24h", label: t("settings.diagnosticsLogs.range.24h") },
      { value: "7d", label: t("settings.diagnosticsLogs.range.7d") },
      { value: "all", label: t("settings.diagnosticsLogs.range.all") },
    ],
    [t],
  );

  async function setMode(mode: "normal" | "verbose") {
    setBusy("mode");
    try {
      const next = await diagnosticsSetMode(mode, mode === "verbose" ? 30 : undefined);
      setStatus(next);
      setClientVerboseMode(next.mode === "verbose");
      showToast(
        next.mode === "verbose"
          ? t("settings.diagnosticsLogs.toast.verboseOn")
          : t("settings.diagnosticsLogs.toast.verboseOff"),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onExport() {
    setBusy("export");
    try {
      const filter = buildFilter(0);
      delete filter.offset;
      const result = await diagnosticsExport(filter);
      setLastExport(result.path);
      showToast(
        t("settings.diagnosticsLogs.toast.exported", {
          records: result.records,
          size: formatBytes(result.bytes),
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    setBusy("clear");
    try {
      const result = await diagnosticsClear();
      setStatus(result.status);
      setConfirmClear(false);
      showToast(
        t("settings.diagnosticsLogs.toast.cleared", {
          size: formatBytes(result.removedBytes),
        }),
      );
      await load(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onOpenDir() {
    try {
      await diagnosticsOpenDir();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onCopySummary() {
    try {
      const lines: string[] = [];
      lines.push(`Task Dock ${t("settings.diagnosticsLogs.copy.header")}`);
      if (status) {
        lines.push(
          `session=${status.sessionId} mode=${status.mode} files=${status.files.length} size=${formatBytes(status.totalBytes)} written=${status.written} dropped=${status.dropped} aggregated=${status.aggregated} failures=${status.failures}`,
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
      if (!lines.length) return;
      await navigator.clipboard.writeText(lines.join("\n"));
      showToast(t("settings.diagnosticsLogs.toast.copied"));
    } catch (e) {
      setError(String(e));
    }
  }

  const capacity = status ? status.totalBytes / Math.max(1, status.maxTotalBytes) : 0;

  return (
    <>
      {error && (
        <div className="setting-note diag-error" role="alert">
          <AlertTriangle size={12} aria-hidden="true" /> {error}
        </div>
      )}

      <div className="setting-row diag-row">
        <span>{t("settings.diagnosticsLogs.status.dir")}</span>
        <span className="diag-mono diag-path" data-tip={status?.logDir ?? ""}>
          {status ? status.logDir : "—"}
        </span>
      </div>
      <div className="setting-row diag-row">
        <span>{t("settings.diagnosticsLogs.status.capacity")}</span>
        <span className="diag-mono">
          {status
            ? t("settings.diagnosticsLogs.status.capacityValue", {
                used: formatBytes(status.totalBytes),
                max: formatBytes(status.maxTotalBytes),
                files: status.files.length,
                maxFiles: status.maxArchiveFiles + 1,
              })
            : "—"}
        </span>
      </div>
      <div className="diag-capacity-bar" aria-hidden="true">
        <div
          className={`diag-capacity-fill${capacity > 0.9 ? " is-high" : ""}`}
          style={{ width: `${Math.min(100, Math.round(capacity * 100))}%` }}
        />
      </div>
      <div className="setting-row diag-row">
        <span>{t("settings.diagnosticsLogs.status.counters")}</span>
        <span className="diag-mono">
          {status
            ? t("settings.diagnosticsLogs.status.countersValue", {
                written: status.written,
                dropped: status.dropped,
                queueFull: status.queueFull,
                aggregated: status.aggregated,
                rotations: status.rotations,
                failures: status.failures,
              })
            : "—"}
        </span>
      </div>
      <div className="setting-row diag-row">
        <span>{t("settings.diagnosticsLogs.status.session")}</span>
        <span
          className="diag-mono diag-path"
          data-tip={status ? `${status.sessionId} · ${status.startedAt}` : undefined}
        >
          {status
            ? `${status.sessionId.slice(0, 8)} · ${shortTime(status.startedAt)}`
            : "—"}
        </span>
      </div>
      {status?.degraded && (
        <div className="setting-note diag-warn">
          {t("settings.diagnosticsLogs.status.degraded")}
          {status.lastError ? `（${status.lastError}）` : ""}
        </div>
      )}

      <div className="setting-row diag-row">
        <span>{t("settings.diagnosticsLogs.mode.label")}</span>
        <div className="btn-row">
          {status?.mode === "verbose" ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => void setMode("normal")}
              disabled={busy === "mode"}
            >
              {t("settings.diagnosticsLogs.mode.restore")}
            </button>
          ) : (
            <button
              type="button"
              className="btn sm"
              onClick={() => void setMode("verbose")}
              disabled={busy === "mode"}
            >
              {t("settings.diagnosticsLogs.mode.enable")}
            </button>
          )}
          <button
            type="button"
            className="btn sm icon-only"
            onClick={() => void load(offset)}
            disabled={busy === "load"}
            aria-label={t("settings.diagnosticsLogs.action.refresh")}
            data-tip={t("settings.diagnosticsLogs.action.refresh")}
          >
            <RefreshCw size={12} className={busy === "load" ? "spin" : undefined} aria-hidden="true" />
          </button>
        </div>
      </div>
      {/* 日志管理：按钮独立成块，避免挤压左侧标签导致逐字换行。 */}
      <div className="diag-actions">
        <button type="button" className="btn sm" onClick={() => void onOpenDir()}>
          <FolderOpen size={12} aria-hidden="true" />{" "}
          {t("settings.diagnosticsLogs.action.openDir")}
        </button>
        <button type="button" className="btn sm" onClick={() => void onCopySummary()}>
          <Copy size={12} aria-hidden="true" /> {t("settings.diagnosticsLogs.action.copy")}
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => void onExport()}
          disabled={busy === "export"}
        >
          <Download size={12} aria-hidden="true" /> {t("settings.diagnosticsLogs.action.export")}
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => setConfirmClear(true)}
          disabled={busy === "clear"}
        >
          <Trash2 size={12} aria-hidden="true" /> {t("settings.diagnosticsLogs.action.clear")}
        </button>
      </div>
      <div className="setting-note">{t("settings.diagnosticsLogs.mode.hint")}</div>
      {status?.mode === "verbose" && status.verboseRemainingMs > 0 && (
        <div className="setting-note diag-warn">
          {t("settings.diagnosticsLogs.mode.remaining", {
            minutes: Math.ceil(status.verboseRemainingMs / 60000),
          })}
        </div>
      )}
      {lastExport && (
        <div className="setting-note diag-mono diag-path" data-tip={lastExport}>
          {t("settings.diagnosticsLogs.export.last")}: {lastExport}
        </div>
      )}

      <div className="diag-actions">
        <button
          type="button"
          className="btn sm"
          onClick={() => useUiStore.getState().setTab("diagnostics")}
        >
          {t("settings.diagnosticsLogs.openCenter")}
        </button>
      </div>

      <div className="diag-subtitle">{t("settings.diagnosticsLogs.recent.title")}</div>
      {summary && summary.groups.length > 0 ? (
        <ul className="diag-group-list">
          {summary.groups.map((group) => (
            <li
              key={`${group.module}|${group.action}|${group.errorCode ?? "-"}`}
              className="diag-group-item"
            >
              <span className={levelClass(group.level)}>{group.level}</span>
              <span className="diag-module">{group.module}</span>
              <span className="diag-action">{group.action}</span>
              {group.errorCode && <span className="diag-code">{group.errorCode}</span>}
              <span className="diag-count" data-tip={t("settings.diagnosticsLogs.recent.countTip")}>
                ×{group.count}
              </span>
              <span className="diag-time" data-tip={group.lastSeen}>
                {shortTime(group.lastSeen)}
              </span>
              {group.recovered && (
                <span className="diag-recovered">
                  {t("settings.diagnosticsLogs.recent.recovered")}
                </span>
              )}
              {group.sampleMessage && (
                <span className="diag-sample" data-tip={group.sampleMessage}>
                  {group.sampleMessage}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="setting-note">{t("settings.diagnosticsLogs.recent.empty")}</div>
      )}
      {summary?.truncated && (
        <div className="setting-note">{t("settings.diagnosticsLogs.recent.truncated")}</div>
      )}

      <div className="diag-subtitle">{t("settings.diagnosticsLogs.list.title")}</div>
      <div className="diag-filters">
        <div className="btn-row">
          <Select
            value={level}
            options={levelOptions}
            onChange={(value) => setLevel(value as LevelKey)}
            ariaLabel={t("settings.diagnosticsLogs.filter.level")}
            size="sm"
          />
          <Select
            value={moduleFilter}
            options={moduleOptions}
            onChange={setModuleFilter}
            ariaLabel={t("settings.diagnosticsLogs.filter.module")}
            size="sm"
          />
          <Select
            value={range}
            options={rangeOptions}
            onChange={(value) => setRange(value as RangeKey)}
            ariaLabel={t("settings.diagnosticsLogs.filter.range")}
            size="sm"
          />
          <input
            className="diag-search"
            type="search"
            value={text}
            placeholder={t("settings.diagnosticsLogs.filter.placeholder")}
            aria-label={t("settings.diagnosticsLogs.filter.placeholder")}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </div>

      {page && page.items.length > 0 ? (
        <ul className="diag-event-list">
          {page.items.map((item: DiagnosticEventRecord, index) => (
            <li
              key={`${item.timestamp}-${index}`}
              className="diag-event-item"
              data-tip={item.message ?? undefined}
            >
              <span className={levelClass(item.level)}>{item.level}</span>
              <span className="diag-time">{shortTime(item.timestamp)}</span>
              <span className="diag-module">{item.module}</span>
              <span className="diag-action">{item.action}</span>
              {item.stage && <span className="diag-stage">{item.stage}</span>}
              {item.error_code && <span className="diag-code">{item.error_code}</span>}
              {item.count > 1 && <span className="diag-count">×{item.count}</span>}
              {item.duration_ms !== undefined && (
                <span className="diag-duration">{item.duration_ms}ms</span>
              )}
              {item.window_id && <span className="diag-window">{item.window_id}</span>}
              {item.operation_id && (
                <span className="diag-op" data-tip={item.operation_id}>
                  {item.operation_id.slice(0, 8)}
                </span>
              )}
              {item.message && <span className="diag-sample">{item.message}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="setting-note">{t("settings.diagnosticsLogs.list.empty")}</div>
      )}

      <div className="setting-row">
        <span className="diag-mono">
          {page
            ? t("settings.diagnosticsLogs.list.pageInfo", {
                shown: page.items.length,
                matched: page.matched,
              })
            : "—"}
          {page?.truncated ? ` · ${t("settings.diagnosticsLogs.list.truncated")}` : ""}
          {page && page.skipped > 0
            ? ` · ${t("settings.diagnosticsLogs.list.skipped", { count: page.skipped })}`
            : ""}
        </span>
        <div className="btn-row">
          <button
            type="button"
            className="btn sm"
            onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || busy === "load"}
          >
            {t("settings.diagnosticsLogs.list.prev")}
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void load(offset + PAGE_SIZE)}
            disabled={!page || page.matched <= offset + page.items.length || busy === "load"}
          >
            {t("settings.diagnosticsLogs.list.next")}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t("settings.diagnosticsLogs.clear.title")}
        detail={t("settings.diagnosticsLogs.clear.detail")}
        confirmLabel={t("settings.diagnosticsLogs.clear.confirm")}
        danger
        busy={busy === "clear"}
        onConfirm={() => void onClear()}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
