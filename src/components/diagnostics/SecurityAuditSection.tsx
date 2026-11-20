//! 安全审计视图：多源审计事件统一查询、筛选、分页与用户显式清理。
//!
//! 边界与约束（冻结契约 §3.1）：
//! - 分页在合并视图上切片，`limit` 上限 100；不一次性读全量，也不自动滚动到历史；
//! - 每个来源的覆盖状态由后端 `sources[]` 显式返回：`locked` / `notWired` / `error`
//!   必须展示成明确说明，不能伪装成「0 事件」；
//! - 清理只能由用户显式点击并二次确认后调用，启动路径不触发；
//! - 基础模式隐藏 Trace ID、原因码等技术字段；详细（verbose）模式才展示全字段；
//! - 读取失败 ≠ 空列表：失败独立错误态并提供重试；
//! - 不注册定时器 / 后台轮询；离开视图卸载时递增序号丢弃在途响应。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { ConfirmDialog, Select } from "../ui";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import type { MessageKey } from "../../i18n";
import {
  securityAuditPrune,
  securityAuditQuery,
  type SecurityAuditCategory,
  type SecurityAuditEvent,
  type SecurityAuditFilter,
  type SecurityAuditPage,
  type SecurityAuditPruneReport,
  type SecurityAuditSource,
} from "../../lib/bridge";

const PAGE_SIZE = 50; // 契约上限 100；单页 50 条，禁止一次性读全量。

type RangeKey = "1h" | "24h" | "7d" | "all";
const RANGE_HOURS: Record<RangeKey, number> = { "1h": 1, "24h": 24, "7d": 168, all: 0 };

interface AuditDraft {
  source: string;
  category: string;
  result: string;
  device: string;
  range: RangeKey;
}

const INITIAL_DRAFT: AuditDraft = {
  source: "ALL",
  category: "ALL",
  result: "ALL",
  device: "",
  range: "24h",
};

const RESULT_KEYS: Record<string, MessageKey> = {
  ok: "diagnosticsCenter.audit.result.ok",
  denied: "diagnosticsCenter.audit.result.denied",
  failed: "diagnosticsCenter.audit.result.failed",
  unknown: "diagnosticsCenter.audit.result.unknown",
};

const CATEGORY_KEYS: Record<SecurityAuditCategory, MessageKey> = {
  pairing: "diagnosticsCenter.audit.category.pairing",
  auth: "diagnosticsCenter.audit.category.auth",
  deviceRevoke: "diagnosticsCenter.audit.category.deviceRevoke",
  mcp: "diagnosticsCenter.audit.category.mcp",
  vault: "diagnosticsCenter.audit.category.vault",
  personalHub: "diagnosticsCenter.audit.category.personalHub",
  other: "diagnosticsCenter.audit.category.other",
};

const SOURCE_KEYS: Record<SecurityAuditSource, MessageKey> = {
  securityAuditLog: "diagnosticsCenter.audit.sourceLabel.securityAuditLog",
  mcpAuditLog: "diagnosticsCenter.audit.sourceLabel.mcpAuditLog",
  vault: "diagnosticsCenter.audit.sourceLabel.vault",
  personalHub: "diagnosticsCenter.audit.sourceLabel.personalHub",
};

const SOURCE_STATUS_KEYS: Record<string, MessageKey> = {
  available: "diagnosticsCenter.audit.source.available",
  empty: "diagnosticsCenter.audit.source.empty",
  locked: "diagnosticsCenter.audit.source.locked",
  notWired: "diagnosticsCenter.audit.source.notWired",
  error: "diagnosticsCenter.audit.source.error",
};

function sinceForRange(range: RangeKey): string | undefined {
  const hours = RANGE_HOURS[range];
  if (!hours) return undefined;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function shortTime(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function resultClass(result: string): string {
  if (result === "ok") return "is-ok";
  if (result === "denied") return "is-warn";
  if (result === "failed") return "is-error";
  return "is-neutral";
}

interface SecurityAuditSectionProps {
  /** 详细诊断模式：展示 Trace ID、原因码等技术字段。 */
  verbose: boolean;
}

export default function SecurityAuditSection({ verbose }: SecurityAuditSectionProps) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);

  const [draft, setDraft] = useState<AuditDraft>(INITIAL_DRAFT);
  const [applied, setApplied] = useState<AuditDraft>(INITIAL_DRAFT);
  const [page, setPage] = useState<SecurityAuditPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [pruneReport, setPruneReport] = useState<SecurityAuditPruneReport | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);

  const seqRef = useRef(0);

  const load = useCallback(
    async (nextOffset: number) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      const filter: SecurityAuditFilter = {
        source: applied.source === "ALL" ? undefined : (applied.source as SecurityAuditSource),
        category:
          applied.category === "ALL" ? undefined : (applied.category as SecurityAuditCategory),
        result: applied.result === "ALL" ? undefined : applied.result,
        device: applied.device.trim() ? applied.device.trim() : undefined,
        from: sinceForRange(applied.range),
        limit: PAGE_SIZE,
        offset: nextOffset,
      };
      try {
        const next = await securityAuditQuery(filter);
        if (seq !== seqRef.current) return;
        setPage(next);
        setOffset(nextOffset);
        setExpandedId(null);
      } catch (e) {
        if (seq !== seqRef.current) return;
        setPage(null);
        setError(errorMessage(e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [applied],
  );

  useEffect(() => {
    void load(0);
    return () => {
      seqRef.current += 1;
    };
  }, [load]);

  const sourceOptions = useMemo(
    () => [
      { value: "ALL", label: t("diagnosticsCenter.audit.filter.sourceAll") },
      ...(Object.keys(SOURCE_KEYS) as SecurityAuditSource[]).map((source) => ({
        value: source,
        label: t(SOURCE_KEYS[source]),
      })),
    ],
    [t],
  );

  const categoryOptions = useMemo(
    () => [
      { value: "ALL", label: t("diagnosticsCenter.audit.filter.categoryAll") },
      ...(Object.keys(CATEGORY_KEYS) as SecurityAuditCategory[]).map((category) => ({
        value: category,
        label: t(CATEGORY_KEYS[category]),
      })),
    ],
    [t],
  );

  const resultOptions = useMemo(
    () => [
      { value: "ALL", label: t("diagnosticsCenter.audit.filter.resultAll") },
      ...Object.keys(RESULT_KEYS).map((result) => ({
        value: result,
        label: t(RESULT_KEYS[result]),
      })),
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

  function applyFilter(next: AuditDraft) {
    setApplied(next);
    setDraft(next);
    setPruneReport(null);
  }

  function resetFilter() {
    applyFilter(INITIAL_DRAFT);
  }

  async function copyText(text: string, okMessage: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t("diagnosticsCenter.list.clipboardUnavailable"));
      }
      await navigator.clipboard.writeText(text);
      showToast(okMessage, { kind: "success" });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function eventSummary(event: SecurityAuditEvent): string {
    const lines = [
      `${event.createdAt}`,
      `source=${event.source} category=${event.category} eventType=${event.eventType}`,
      `subject=${event.subject ?? "-"} action=${event.action} result=${event.result}`,
    ];
    if (event.reasonCode) lines.push(`reasonCode=${event.reasonCode}`);
    if (event.traceId) lines.push(`traceId=${event.traceId}`);
    return lines.join("\n");
  }

  async function onPruneConfirm() {
    setPruneBusy(true);
    setPruneError(null);
    try {
      const report = await securityAuditPrune({});
      setPruneReport(report);
      setPruneOpen(false);
      showToast(t("diagnosticsCenter.audit.prune.report", {
        deleted: report.deletedRows,
        remaining: report.remainingRows,
        codes: report.clearedReasonCodes,
      }), { kind: "success" });
      await load(offset);
    } catch (e) {
      setPruneError(errorMessage(e));
      setPruneOpen(false);
    } finally {
      setPruneBusy(false);
    }
  }

  const rows = page?.items ?? [];
  const total = page?.total ?? 0;

  return (
    <section className="diag-audit" aria-label={t("diagnosticsCenter.audit.title")}>
      <div className="diag-section-head">
        <h2 className="diag-center-section-title">{t("diagnosticsCenter.audit.title")}</h2>
        <button
          type="button"
          className="btn sm"
          onClick={() => void load(offset)}
          disabled={loading}
          aria-label={t("diagnosticsCenter.action.refresh")}
          data-tip={t("diagnosticsCenter.action.refresh")}
        >
          <RefreshCw size={12} className={loading ? "spin" : undefined} aria-hidden="true" />
          <span>{t("diagnosticsCenter.action.refresh")}</span>
        </button>
        <button
          type="button"
          className="btn sm danger"
          onClick={() => {
            setPruneError(null);
            setPruneOpen(true);
          }}
          disabled={pruneBusy}
        >
          <Trash2 size={12} aria-hidden="true" />
          <span>{t("diagnosticsCenter.audit.prune.action")}</span>
        </button>
      </div>
      <p className="diag-center-section-hint">{t("diagnosticsCenter.audit.hint")}</p>

      {/* 来源覆盖状态条：不可读来源显式说明，不计为 0 事件。 */}
      {page && page.sources.length > 0 && (
        <ul className="diag-audit-sources" aria-label={t("diagnosticsCenter.audit.sources.title")}>
          {page.sources.map((source) => (
            <li
              key={source.source}
              className={`diag-audit-source is-${source.status}`}
              data-tip={source.note ?? SOURCE_STATUS_KEYS[source.status]}
            >
              <span className="diag-audit-source-name">
                {t(SOURCE_KEYS[source.source])}
              </span>
              <span className={`diag-center-flag ${
                source.status === "available"
                  ? "is-ok"
                  : source.status === "empty"
                    ? "is-neutral"
                    : "is-warn"
              }`}>
                {t(SOURCE_STATUS_KEYS[source.status])}
              </span>
              {source.status === "available" || source.status === "empty" ? (
                <span className="diag-center-mono">{source.total ?? 0}</span>
              ) : (
                <span className="diag-audit-source-note">
                  {source.note ?? t("diagnosticsCenter.audit.source.noteUnavailable")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="diag-center-filters diag-section-filters">
        <div className="diag-center-filter-grid">
          <div className="diag-center-field">
            <span className="diag-center-field-label">{t("diagnosticsCenter.audit.filter.range")}</span>
            <Select
              value={draft.range}
              options={rangeOptions}
              onChange={(value) => setDraft({ ...draft, range: value as RangeKey })}
              ariaLabel={t("diagnosticsCenter.audit.filter.range")}
              size="sm"
              align="start"
              block
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">{t("diagnosticsCenter.audit.filter.source")}</span>
            <Select
              value={draft.source}
              options={sourceOptions}
              onChange={(value) => setDraft({ ...draft, source: value })}
              ariaLabel={t("diagnosticsCenter.audit.filter.source")}
              size="sm"
              align="start"
              block
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">{t("diagnosticsCenter.audit.filter.category")}</span>
            <Select
              value={draft.category}
              options={categoryOptions}
              onChange={(value) => setDraft({ ...draft, category: value })}
              ariaLabel={t("diagnosticsCenter.audit.filter.category")}
              size="sm"
              align="start"
              block
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">{t("diagnosticsCenter.audit.filter.result")}</span>
            <Select
              value={draft.result}
              options={resultOptions}
              onChange={(value) => setDraft({ ...draft, result: value })}
              ariaLabel={t("diagnosticsCenter.audit.filter.result")}
              size="sm"
              align="start"
              block
            />
          </div>
          <div className="diag-center-field">
            <span className="diag-center-field-label">{t("diagnosticsCenter.audit.filter.device")}</span>
            <input
              className="diag-center-input"
              type="search"
              value={draft.device}
              placeholder={t("diagnosticsCenter.audit.filter.devicePlaceholder")}
              aria-label={t("diagnosticsCenter.audit.filter.device")}
              onChange={(event) => setDraft({ ...draft, device: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilter(draft);
              }}
            />
          </div>
          <div className="diag-center-filter-actions">
            <button type="button" className="btn sm" onClick={() => applyFilter(draft)}>
              {t("diagnosticsCenter.filter.apply")}
            </button>
            <button type="button" className="btn sm" onClick={resetFilter}>
              {t("diagnosticsCenter.filter.reset")}
            </button>
          </div>
        </div>
      </div>

      {pruneReport && (
        <div className="diag-center-state is-success" role="status">
          {t("diagnosticsCenter.audit.prune.report", {
            deleted: pruneReport.deletedRows,
            remaining: pruneReport.remainingRows,
            codes: pruneReport.clearedReasonCodes,
          })}
        </div>
      )}
      {pruneError && (
        <div className="diag-center-state is-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{pruneError}</span>
        </div>
      )}

      {error ? (
        <div className="diag-center-state is-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{t("diagnosticsCenter.audit.error", { error })}</span>
          <button type="button" className="btn sm" onClick={() => void load(offset)}>
            {t("common.retry")}
          </button>
        </div>
      ) : loading && !page ? (
        <div className="diag-center-state">{t("diagnosticsCenter.audit.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="diag-center-state diag-center-state-empty">
          <strong>{t("diagnosticsCenter.audit.empty")}</strong>
          <span>{t("diagnosticsCenter.audit.emptyHint")}</span>
        </div>
      ) : (
        <>
          <div className="diag-center-list-head">
            <span className="diag-center-list-meta">
              {t("diagnosticsCenter.audit.pageInfo", { shown: rows.length, matched: total })}
            </span>
          </div>
          <ul className="diag-center-rows">
            {rows.map((event) => {
              const isOpen = expandedId === event.id;
              return (
                <li key={event.id} className="diag-center-row-item">
                  <button
                    type="button"
                    className={`diag-center-row${isOpen ? " is-selected" : ""}`}
                    aria-expanded={isOpen}
                    onClick={() => setExpandedId(isOpen ? null : event.id)}
                  >
                    {isOpen ? (
                      <ChevronDown size={12} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={12} aria-hidden="true" />
                    )}
                    <span className="diag-center-row-body">
                      <span className="diag-center-row-line">
                        <span className={`diag-center-flag ${resultClass(event.result)}`}>
                          {t(RESULT_KEYS[event.result] ?? RESULT_KEYS.unknown)}
                        </span>
                        <span className="diag-center-row-module diag-center-ellipsis">
                          {event.subject ?? event.action}
                        </span>
                        <span className="diag-center-mono diag-audit-source-tag">
                          {t(SOURCE_KEYS[event.source])}
                        </span>
                        <span className="diag-center-row-time" data-tip={event.createdAt}>
                          {shortTime(event.createdAt)}
                        </span>
                      </span>
                      <span className="diag-center-row-line is-sub">
                        <span className="diag-center-row-code">
                          {t(CATEGORY_KEYS[event.category])}
                        </span>
                        <span className="diag-center-row-message diag-center-ellipsis">
                          {event.action}
                        </span>
                        {verbose && event.traceId && (
                          <span className="diag-center-row-code diag-center-mono">
                            {event.traceId}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                  {isOpen && (
                    <dl className="diag-center-details">
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.audit.detail.eventType")}</dt>
                        <dd className="diag-center-mono">{event.eventType}</dd>
                      </div>
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.list.source")}</dt>
                        <dd className="diag-center-mono">{event.source}</dd>
                      </div>
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.audit.filter.category")}</dt>
                        <dd className="diag-center-mono">
                          {t(CATEGORY_KEYS[event.category])}
                        </dd>
                      </div>
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.audit.col.subject")}</dt>
                        <dd className="diag-center-mono diag-center-ellipsis">
                          {event.subject ?? t("diagnosticsCenter.list.none")}
                        </dd>
                      </div>
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.audit.col.action")}</dt>
                        <dd className="diag-center-mono">{event.action}</dd>
                      </div>
                      <div className="diag-center-detail">
                        <dt>{t("diagnosticsCenter.audit.col.result")}</dt>
                        <dd className="diag-center-mono">{event.result}</dd>
                      </div>
                      {verbose && (
                        <div className="diag-center-detail">
                          <dt>{t("diagnosticsCenter.audit.detail.reasonCode")}</dt>
                          <dd className="diag-center-mono">
                            {event.reasonCode ?? t("diagnosticsCenter.list.none")}
                          </dd>
                        </div>
                      )}
                      {verbose && (
                        <div className="diag-center-detail">
                          <dt>{t("diagnosticsCenter.audit.detail.traceId")}</dt>
                          <dd className="diag-center-op">
                            <span className="diag-center-mono diag-center-ellipsis">
                              {event.traceId ?? "—"}
                            </span>
                            {event.traceId && (
                              <button
                                type="button"
                                className="icon-btn sm"
                                aria-label={t("diagnosticsCenter.list.copyOperation")}
                                data-tip={t("diagnosticsCenter.list.copyOperation")}
                                onClick={() =>
                                  void copyText(event.traceId!, t("diagnosticsCenter.list.copyOperationOk"))
                                }
                              >
                                <Copy size={11} aria-hidden="true" />
                              </button>
                            )}
                          </dd>
                        </div>
                      )}
                      <div className="diag-center-detail diag-center-detail-wide">
                        <dt>{t("diagnosticsCenter.list.timestamp")}</dt>
                        <dd className="diag-center-mono">{event.createdAt}</dd>
                      </div>
                      <div className="diag-center-detail diag-center-detail-wide">
                        <dd>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => void copyText(eventSummary(event), t("diagnosticsCenter.audit.copyOk"))}
                          >
                            <Copy size={11} aria-hidden="true" />
                            <span>{t("diagnosticsCenter.audit.copy")}</span>
                          </button>
                        </dd>
                      </div>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="diag-center-pager">
            <button
              type="button"
              className="btn sm"
              onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || loading}
            >
              {t("diagnosticsCenter.list.prev")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => void load(offset + PAGE_SIZE)}
              disabled={!page || total <= offset + rows.length || loading}
            >
              {t("diagnosticsCenter.list.next")}
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pruneOpen}
        title={t("diagnosticsCenter.audit.prune.title")}
        detail={t("diagnosticsCenter.audit.prune.detail")}
        confirmLabel={t("diagnosticsCenter.audit.prune.confirm")}
        danger
        busy={pruneBusy}
        onConfirm={() => void onPruneConfirm()}
        onCancel={() => setPruneOpen(false)}
      />
    </section>
  );
}
