//! 性能分析视图：进程生命周期内的有界聚合指标。
//!
//! 边界与约束（冻结契约 §3.2）：
//! - 数据窗口**只有**「进程启动以来」（`window: "process"`），起始时刻用
//!   `startedAt` 说明；前端禁止表述成「最近 24 小时」之类的滚动窗口；
//! - 支持按平均耗时 / P95 / 慢操作次数 / 失败率排序；条目可展开查看完整字段；
//! - 空状态、加载态、失败态相互独立；读取失败提供重试；
//! - 基础模式隐藏指纹条目数等内部聚合细节；详细（verbose）模式才展示；
//! - 只在视图挂载时拉取一次快照，不轮询；卸载时丢弃在途响应。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { diagnosticsMetricsSummary, type DiagnosticsMetricsEntry, type DiagnosticsMetricsSummary } from "../../lib/bridge";
import type { MessageKey } from "../../i18n";

type SortKey = "avgMs" | "p95Ms" | "slowCount" | "failureRate";

const SORT_KEYS: SortKey[] = ["avgMs", "p95Ms", "slowCount", "failureRate"];

function failureRate(entry: DiagnosticsMetricsEntry): number {
  if (entry.count <= 0) return 0;
  return Math.round((entry.failures / entry.count) * 100);
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value)} ms`;
}

function shortTime(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function entryKey(entry: DiagnosticsMetricsEntry): string {
  return `${entry.module}/${entry.action}`;
}

interface PerformanceSectionProps {
  verbose: boolean;
}

export default function PerformanceSection({ verbose }: PerformanceSectionProps) {
  const { t } = useLocale();
  const [summary, setSummary] = useState<DiagnosticsMetricsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("avgMs");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await diagnosticsMetricsSummary();
      if (seq !== seqRef.current) return;
      setSummary(next);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setSummary(null);
      setError(errorMessage(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      seqRef.current += 1;
    };
  }, [load]);

  const sortedEntries = useMemo(() => {
    const entries = [...(summary?.entries ?? [])];
    entries.sort((a, b) => {
      let left: number;
      let right: number;
      switch (sortKey) {
        case "p95Ms":
          left = a.p95Ms;
          right = b.p95Ms;
          break;
        case "slowCount":
          left = a.slowCount;
          right = b.slowCount;
          break;
        case "failureRate":
          left = failureRate(a);
          right = failureRate(b);
          break;
        case "avgMs":
        default:
          left = a.avgMs;
          right = b.avgMs;
          break;
      }
      return right - left;
    });
    return entries;
  }, [summary, sortKey]);

  const sortLabelKey: Record<SortKey, MessageKey> = {
    avgMs: "diagnosticsCenter.perf.sort.avg",
    p95Ms: "diagnosticsCenter.perf.sort.p95",
    slowCount: "diagnosticsCenter.perf.sort.slow",
    failureRate: "diagnosticsCenter.perf.sort.failureRate",
  };

  return (
    <section className="diag-perf" aria-label={t("diagnosticsCenter.perf.title")}>
      <div className="diag-section-head">
        <h2 className="diag-center-section-title">{t("diagnosticsCenter.perf.title")}</h2>
        <button
          type="button"
          className="btn sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t("diagnosticsCenter.action.refresh")}
          data-tip={t("diagnosticsCenter.action.refresh")}
        >
          <RefreshCw size={12} className={loading ? "spin" : undefined} aria-hidden="true" />
          <span>{t("diagnosticsCenter.action.refresh")}</span>
        </button>
      </div>
      <p className="diag-center-section-hint">{t("diagnosticsCenter.perf.hint")}</p>

      {summary && (
        <div className="diag-perf-window" role="status">
          <span className="diag-center-metric-label">
            {t("diagnosticsCenter.perf.window")}
          </span>
          <span className="diag-center-flag is-neutral">
            {t("diagnosticsCenter.perf.windowProcess")}
          </span>
          <span className="diag-center-mono">
            {t("diagnosticsCenter.perf.startedAt", { time: shortTime(summary.startedAt) })}
          </span>
          <span className="diag-center-mono">
            {t("diagnosticsCenter.perf.generatedAt", { time: shortTime(summary.generatedAt) })}
          </span>
          {verbose && (
            <>
              <span className="diag-center-mono">
                {t("diagnosticsCenter.perf.fingerprints", { count: summary.fingerprints })}
              </span>
              {summary.evicted > 0 && (
                <span className="diag-center-mono is-warn">
                  {t("diagnosticsCenter.perf.evicted", { count: summary.evicted })}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {error ? (
        <div className="diag-center-state is-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{t("diagnosticsCenter.perf.error", { error })}</span>
          <button type="button" className="btn sm" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : loading && !summary ? (
        <div className="diag-center-state">{t("diagnosticsCenter.perf.loading")}</div>
      ) : sortedEntries.length === 0 ? (
        <div className="diag-center-state diag-center-state-empty">
          <strong>{t("diagnosticsCenter.perf.empty")}</strong>
        </div>
      ) : (
        <div className="diag-perf-table" role="table" aria-label={t("diagnosticsCenter.perf.title")}>
          <div className="diag-perf-row diag-perf-head" role="row">
            <span role="columnheader" className="diag-perf-name-col">
              {t("diagnosticsCenter.perf.col.module")}
            </span>
            {(SORT_KEYS as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                role="columnheader"
                aria-pressed={sortKey === key}
                className={`diag-perf-sort${sortKey === key ? " is-active" : ""}`}
                onClick={() => setSortKey(key)}
              >
                {t(sortLabelKey[key])}
              </button>
            ))}
            <span role="columnheader" className="diag-perf-num-col">
              {t("diagnosticsCenter.perf.col.count")}
            </span>
          </div>
          {sortedEntries.map((entry) => {
            const key = entryKey(entry);
            const isOpen = expandedKey === key;
            const rate = failureRate(entry);
            return (
              <div key={key} className="diag-perf-row" role="row">
                <button
                  type="button"
                  className="diag-perf-name"
                  aria-expanded={isOpen}
                  onClick={() => setExpandedKey(isOpen ? null : key)}
                >
                  {isOpen ? (
                    <ChevronDown size={12} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" />
                  )}
                  <span className="diag-center-ellipsis" data-tip={key}>
                    {key}
                  </span>
                </button>
                <span role="cell" className="diag-center-mono diag-perf-num-col">
                  {formatMs(entry.avgMs)}
                </span>
                <span role="cell" className="diag-center-mono diag-perf-num-col">
                  {formatMs(entry.p95Ms)}
                </span>
                <span role="cell" className="diag-center-mono diag-perf-num-col">
                  {entry.slowCount}
                </span>
                <span
                  role="cell"
                  className={`diag-center-mono diag-perf-num-col${rate > 0 ? " is-warn" : ""}`}
                >
                  {t("diagnosticsCenter.perf.failureRate", { rate })}
                </span>
                <span role="cell" className="diag-center-mono diag-perf-num-col">
                  {entry.count}
                </span>
                {isOpen && (
                  <dl className="diag-perf-detail" role="cell">
                    <div className="diag-center-detail">
                      <dt>{t("diagnosticsCenter.perf.detail.count")}</dt>
                      <dd className="diag-center-mono">{entry.count}</dd>
                    </div>
                    <div className="diag-center-detail">
                      <dt>{t("diagnosticsCenter.perf.detail.failures")}</dt>
                      <dd className="diag-center-mono">{entry.failures}</dd>
                    </div>
                    <div className="diag-center-detail">
                      <dt>{t("diagnosticsCenter.perf.detail.slowCount")}</dt>
                      <dd className="diag-center-mono">{entry.slowCount}</dd>
                    </div>
                    <div className="diag-center-detail">
                      <dt>{t("diagnosticsCenter.perf.detail.avgMs")}</dt>
                      <dd className="diag-center-mono">{formatMs(entry.avgMs)}</dd>
                    </div>
                    <div className="diag-center-detail">
                      <dt>{t("diagnosticsCenter.perf.detail.maxMs")}</dt>
                      <dd className="diag-center-mono">{formatMs(entry.maxMs)}</dd>
                    </div>
                    <div className="diag-center-detail">
                      <dt>{t("diagnosticsCenter.perf.detail.p95Ms")}</dt>
                      <dd className="diag-center-mono">{formatMs(entry.p95Ms)}</dd>
                    </div>
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
