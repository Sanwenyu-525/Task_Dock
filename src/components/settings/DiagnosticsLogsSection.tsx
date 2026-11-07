//! 设置页「诊断与日志」：状态与入口。
//!
//! 边界与约束：
//! - **只读**：列表查询、筛选、分页、导出、清理与目录操作全部由诊断中心承担；
//! - **按需加载**：本组件只在分组展开时挂载（`CollapsibleSection` 折叠即卸载）；
//! - **无持续刷新**：只有首屏与用户点「刷新」时请求，不注册定时器；
//! - 只调用 `diagnostics_status` 与 `diagnostics_summary`，不查询事件明细；
//! - 复用设置页现有视觉（`.setting-row` / `.btn sm` / 语义 Token）与公共组件。

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import {
  diagnosticsSetMode,
  diagnosticsStatus,
  diagnosticsSummary,
  type DiagnosticLevel,
  type DiagnosticSummary,
  type DiagnosticsStatus,
} from "../../lib/bridge";
import { setClientVerboseMode } from "../../lib/diagnostics";

/** 最近异常摘要固定看 24 小时；列表与时间范围由诊断中心提供。 */
const RECENT_HOURS = 24;
/** 设置页只保留最关键的聚合分组，更多内容去诊断中心。 */
const MAX_GROUPS = 8;

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** 请求序号：连续点刷新时丢弃过期响应（不做无上限排队）。 */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setBusy("load");
    try {
      const since = new Date(Date.now() - RECENT_HOURS * 3_600_000).toISOString();
      const [nextStatus, nextSummary] = await Promise.all([
        diagnosticsStatus(),
        diagnosticsSummary({ since, anomaliesOnly: true }),
      ]);
      if (seq !== requestSeq.current) return;
      setStatus(nextStatus);
      setSummary(nextSummary);
      setError(null);
      setClientVerboseMode(nextStatus.mode === "verbose");
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(String(e));
    } finally {
      if (seq === requestSeq.current) setBusy(null);
    }
  }, []);

  // 首屏加载一次；不做轮询。
  useEffect(() => {
    void load();
  }, [load]);

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

  const capacity = status ? status.totalBytes / Math.max(1, status.maxTotalBytes) : 0;
  const groups = summary ? summary.groups.slice(0, MAX_GROUPS) : [];

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
            onClick={() => void load()}
            disabled={busy === "load"}
            aria-label={t("settings.diagnosticsLogs.action.refresh")}
            data-tip={t("settings.diagnosticsLogs.action.refresh")}
          >
            <RefreshCw size={12} className={busy === "load" ? "spin" : undefined} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="setting-note">{t("settings.diagnosticsLogs.mode.hint")}</div>
      {status?.mode === "verbose" && status.verboseRemainingMs > 0 && (
        <div className="setting-note diag-warn">
          {t("settings.diagnosticsLogs.mode.remaining", {
            minutes: Math.ceil(status.verboseRemainingMs / 60000),
          })}
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
      {groups.length > 0 ? (
        <ul className="diag-group-list">
          {groups.map((group) => (
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
    </>
  );
}
