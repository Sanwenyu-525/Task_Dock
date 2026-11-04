//! Agent 工作时间统计视图（挂载到 Agent 面板「统计」子视图，见集成清单）。
//!
//! i18n 约定：
//! - 所有界面文案取自 `agentStats.*`；会话/运行状态复用既有的 `agent.state.*`；
//! - 时间一律走 `i18n/format`（`formatLocalizedDateTime` / `formatLocalizedPercent`），
//!   不硬编码 `zh-CN` 或月份名；
//! - 错误统一走 `localizedErrorMessage`（结构化错误按 code 本地化，旧格式保留原文），
//!   且保存原始错误对象、渲染时再本地化，切换语言后错误文案随之更新；
//! - 「未知」与「0 分」严格区分：没有任何事件明细时执行/等待/未知显示「未知」，
//!   失败率没有可靠终态时也显示「未知」，都不回退成 0。
//! - 后端 `warnings` 目前是服务端生成的中文句子，前端暂按原文展示（缺结构化 code，
//!   见复查说明中的缺键清单）。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, BarChart3, Clock3, RefreshCw, Timer } from "lucide-react";
import Select from "../../ui/Select";
import { useLocale } from "../../../hooks/useLocale";
import { formatLocalizedDateTime, formatLocalizedPercent } from "../../../i18n/format";
import { localizedErrorMessage } from "../../../i18n/errors";
import type { MessageKey } from "../../../i18n";
import WorkTimeTrend from "./WorkTimeTrend";
import {
  agentWorkTimeStats,
  type SourceOption,
  type SourceStats,
  type StatsOrigin,
  type WorkTimeStats,
} from "./api";
import "./stats.css";

type Preset = "day" | "week" | "month";
type TestOrigin = Exclude<StatsOrigin, "real">;
type Translate = ReturnType<typeof useLocale>["t"];

const PRESETS: readonly Preset[] = ["day", "week", "month"];

const PRESET_KEYS: Record<Preset, MessageKey> = {
  day: "agentStats.range.day",
  week: "agentStats.range.week",
  month: "agentStats.range.month",
};

const TEST_ORIGINS: readonly TestOrigin[] = ["mock", "benchmark", "selftest", "manual"];

const ORIGIN_KEYS: Record<StatsOrigin, MessageKey> = {
  real: "agentStats.origin.real",
  mock: "agentStats.origin.mock",
  benchmark: "agentStats.origin.benchmark",
  selftest: "agentStats.origin.selftest",
  manual: "agentStats.origin.manual",
};

/** 会话/轮次状态值复用既有 `agent.state.*`；未知状态原样展示，不臆造文案。 */
const SESSION_STATUS_KEYS: Record<string, MessageKey> = {
  idle: "agent.state.idle",
  running: "agent.state.running",
  waiting: "agent.state.waiting",
  completed: "agent.state.completed",
  failed: "agent.state.failed",
  disconnected: "agent.state.disconnected",
};

/** 「数据产生于 / 最后」用的紧凑日期时间（本地化，不含年份，避免撑破窄窗）。 */
const STAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

function rangeFor(preset: Preset): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setHours(0, 0, 0, 0);
  if (preset === "week") from.setDate(from.getDate() - 6);
  if (preset === "month") from.setDate(from.getDate() - 29);
  return { from: from.toISOString(), to: to.toISOString() };
}

function fmtDur(t: Translate, sec: number | null | undefined): string {
  if (sec == null) return t("agentStats.unknown");
  if (sec <= 0) return t("agentStats.duration.zero");
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return t("agentStats.duration.hours", { h, m });
  if (m > 0) return t("agentStats.duration.minutes", { m, s });
  return t("agentStats.duration.seconds", { s });
}

function fmtRate(t: Translate, rate: number | null | undefined): string {
  if (rate == null) return t("agentStats.unknown");
  return formatLocalizedPercent(rate, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtStamp(iso: string): string {
  if (!iso) return "—";
  return formatLocalizedDateTime(iso, STAMP_OPTIONS) || iso;
}

function statusLabel(t: Translate, status: string): string {
  const key = SESSION_STATUS_KEYS[status];
  return key ? t(key) : status;
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "exec" | "wait" | "error" | "muted";
}) {
  return (
    <div className={`astats-card ${tone ? `tone-${tone}` : ""}`}>
      <div className="astats-card-label">
        {icon}
        <span>{label}</span>
      </div>
      <div className="astats-card-value">{value}</div>
      {hint ? <div className="astats-card-hint">{hint}</div> : null}
    </div>
  );
}

function SourceRow({ s }: { s: SourceStats }) {
  const { t } = useLocale();
  // 该来源全部轮次都没有事件明细时，执行/等待不可测量：显示「未知」而不是 0 分
  const measurable = s.runs > 0 && s.runs_without_detail < s.runs;
  const dur = (sec: number) =>
    measurable ? fmtDur(t, sec) : t("agentStats.unknown");
  return (
    <div className="astats-source-row">
      <span className="astats-source-name" data-tip={s.source_id}>
        {s.display_name}
      </span>
      <span>{dur(s.exec_sec)}</span>
      <span>{dur(s.wait_sec)}</span>
      <span>{fmtDur(t, s.span_sec)}</span>
      <span>
        {s.completed} / {s.failed}
      </span>
      <span className={s.failure_rate != null && s.failure_rate > 0 ? "astats-fail" : ""}>
        {fmtRate(t, s.failure_rate)}
      </span>
    </div>
  );
}

export default function AgentStatsView() {
  const { t } = useLocale();
  const [preset, setPreset] = useState<Preset>("week");
  const [originMode, setOriginMode] = useState<"real" | "test">("real");
  const [testOrigin, setTestOrigin] = useState<TestOrigin>("mock");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [data, setData] = useState<WorkTimeStats | null>(null);
  // 来源列表独立保存：切换筛选/刷新时不必等新结果，也不会因清空旧结果而丢掉选项
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [loading, setLoading] = useState(false);
  // 保存原始错误对象：渲染时再本地化，切换语言后文案随之更新
  const [error, setError] = useState<{ raw: unknown } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestSeq = useRef(0);
  const lastScope = useRef<string | null>(null);

  const activeOrigin: StatsOrigin = originMode === "real" ? "real" : testOrigin;

  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;
    // 切换范围/来源/口径时先清空旧结果：避免「测试数据」横幅下面还显示真实数据的数值。
    // 同一口径点「刷新」则保留旧数据，只有新结果到达才替换。
    const scope = `${preset}|${activeOrigin}|${sourceId ?? ""}`;
    if (lastScope.current !== scope) {
      lastScope.current = scope;
      setData(null);
    }
    setLoading(true);
    setError(null);
    const range = rangeFor(preset);
    agentWorkTimeStats({
      from: range.from,
      to: range.to,
      origin: activeOrigin,
      source_id: sourceId,
      bucket: "day",
      timezone_offset_minutes: -new Date().getTimezoneOffset(),
      session_limit: 20,
      max_runs: 5000,
    })
      .then((res) => {
        if (cancelled || requestSeq.current !== seq) return;
        setData(res);
        setSources(res.available_sources);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled || requestSeq.current !== seq) return;
        setError({ raw: e });
        setLoading(false);
      });
    // 卸载后不再写入状态（视图切换/窗口关闭时迟到的响应直接丢弃）
    return () => {
      cancelled = true;
    };
  }, [preset, activeOrigin, sourceId, reloadKey]);

  const visibleSources = sources.filter(
    (s) => !s.hidden && s.category === activeOrigin,
  );
  const sourceOptions = [
    { value: "", label: t("agentStats.allSources") },
    ...visibleSources.map((s) => ({ value: s.id, label: s.display_name })),
  ];

  const totals = data?.totals;
  const reliableTerminals = (totals?.completed ?? 0) + (totals?.failed ?? 0);
  const runCount = totals?.runs ?? 0;
  const detailRuns = totals?.runs_with_detail ?? 0;
  // 没有任何可用事件明细时，执行/等待/未知都不可测量：显示「未知」而不是 0 分
  const durationsMeasurable = runCount > 0 && detailRuns > 0;
  const noDetailSuffix =
    totals && totals.runs_without_detail > 0
      ? t("agentStats.coverage.missingDetail", { n: totals.runs_without_detail })
      : "";
  const durValue = (sec: number | undefined): string => {
    if (runCount === 0) return "—";
    if (!durationsMeasurable) return t("agentStats.unknown");
    return fmtDur(t, sec);
  };

  return (
    <section className="agent-stats" aria-label={t("agentStats.title")}>
      <div className="astats-head">
        <span className="astats-title">
          <BarChart3 size={13} /> {t("agentStats.title")}
        </span>
        <button
          className="btn sm"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          aria-label={t("agentStats.refreshAria")}
        >
          <RefreshCw size={12} className={loading ? "spin" : ""} /> {t("agentStats.refresh")}
        </button>
      </div>

      <div className="astats-filters">
        <div className="seg-group" role="tablist" aria-label={t("agentStats.rangeAria")}>
          {PRESETS.map((p) => (
            <button
              key={p}
              className={`seg-btn ${preset === p ? "active" : ""}`}
              role="tab"
              aria-selected={preset === p}
              onClick={() => setPreset(p)}
            >
              {t(PRESET_KEYS[p])}
            </button>
          ))}
        </div>
        <div className="seg-group" role="tablist" aria-label={t("agentStats.originAria")}>
          <button
            className={`seg-btn ${originMode === "real" ? "active" : ""}`}
            role="tab"
            aria-selected={originMode === "real"}
            onClick={() => {
              setOriginMode("real");
              setSourceId(null);
            }}
          >
            {t("agentStats.origin.real")}
          </button>
          <button
            className={`seg-btn ${originMode === "test" ? "active" : ""}`}
            role="tab"
            aria-selected={originMode === "test"}
            onClick={() => {
              setOriginMode("test");
              setSourceId(null);
            }}
          >
            {t("agentStats.origin.test")}
          </button>
        </div>
        {originMode === "test" && (
          <Select
            value={testOrigin}
            options={TEST_ORIGINS.map((o) => ({ value: o, label: t(ORIGIN_KEYS[o]) }))}
            onChange={(v) => {
              setTestOrigin(v as TestOrigin);
              setSourceId(null);
            }}
            ariaLabel={t("agentStats.testOriginAria")}
            size="sm"
          />
        )}
        <Select
          value={sourceId ?? ""}
          options={sourceOptions}
          onChange={(v) => setSourceId(v === "" ? null : v)}
          ariaLabel={t("agentStats.sourceAria")}
          size="sm"
          block={false}
        />
      </div>

      {originMode === "test" && (
        <div className="astats-warn astats-warn-info">
          <AlertTriangle size={12} />
          <span>{t("agentStats.testWarning", { origin: t(ORIGIN_KEYS[testOrigin]) })}</span>
        </div>
      )}

      {error && (
        <div className="astats-error" role="alert">
          {t("agentStats.error.query", { error: localizedErrorMessage(error.raw) })}
        </div>
      )}

      {loading && !data && <div className="empty-hint">{t("agentStats.loading")}</div>}

      {data && totals && (
        <>
          {data.warnings.length > 0 && (
            <div className="astats-warn">
              <AlertTriangle size={12} />
              <div className="astats-warn-list">
                {data.warnings.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
            </div>
          )}

          <div className="astats-cards">
            <StatCard
              icon={<Activity size={12} />}
              label={t("agentStats.card.span")}
              value={durValue(totals.span_sec)}
              hint={t("agentStats.card.runsHint", { n: totals.runs })}
            />
            <StatCard
              icon={<Timer size={12} />}
              label={t("agentStats.card.exec")}
              value={durValue(totals.exec_sec)}
              hint={`${t("agentStats.card.execHint")}${noDetailSuffix}`}
              tone="exec"
            />
            <StatCard
              icon={<Clock3 size={12} />}
              label={t("agentStats.card.wait")}
              value={durValue(totals.wait_sec)}
              hint={`${t("agentStats.card.waitHint")}${noDetailSuffix}`}
              tone="wait"
            />
            <StatCard
              icon={<BarChart3 size={12} />}
              label={t("agentStats.card.completedFailed")}
              value={`${totals.completed} / ${totals.failed}`}
              hint={t("agentStats.card.interrupted", {
                interrupted: totals.interrupted,
                unresolved: totals.unresolved,
              })}
            />
            <StatCard
              icon={<AlertTriangle size={12} />}
              label={t("agentStats.card.failureRate")}
              value={fmtRate(t, totals.failure_rate)}
              hint={
                reliableTerminals > 0
                  ? t("agentStats.card.failureDenominator", { n: reliableTerminals })
                  : t("agentStats.card.noReliableTerminal")
              }
              tone={totals.failure_rate != null && totals.failure_rate > 0 ? "error" : "muted"}
            />
            <StatCard
              icon={<Clock3 size={12} />}
              label={t("agentStats.card.unknown")}
              value={durValue(totals.unknown_sec)}
              hint={t("agentStats.card.openTail", {
                time: fmtDur(t, totals.open_tail_sec),
              })}
              tone="muted"
            />
          </div>

          <div className="astats-coverage">
            {t("agentStats.coverage.summary", {
              analyzed: data.coverage.runs_analyzed,
              total: data.coverage.runs_in_range,
              events: data.coverage.events_loaded,
              time: fmtStamp(data.generated_at),
            })}
            {totals.runs_without_detail > 0 &&
              t("agentStats.coverage.missingDetail", { n: totals.runs_without_detail })}
            {totals.estimated_runs > 0 &&
              t("agentStats.coverage.estimated", { n: totals.estimated_runs })}
          </div>

          <div className="panel-block">
            <div className="panel-block-head">
              <span>
                <Timer size={12} /> {t("agentStats.trend.title")}
              </span>
              <span className="astats-legend">
                <i className="dot is-exec" /> {t("agentStats.trend.exec")}
                <i className="dot is-wait" /> {t("agentStats.trend.wait")}
                <i className="dot is-unknown" /> {t("agentStats.trend.unknown")}
              </span>
            </div>
            <WorkTimeTrend points={data.trend} />
          </div>

          <div className="panel-block">
            <div className="panel-block-head">
              <span>
                <Activity size={12} /> {t("agentStats.bySource.title")}
              </span>
              <span className="astats-sub">{t("agentStats.bySource.subtitle")}</span>
            </div>
            {data.by_source.length === 0 && (
              <div className="empty-hint">{t("agentStats.bySource.empty")}</div>
            )}
            {data.by_source.length > 0 && (
              <div className="astats-table">
                <div className="astats-source-row astats-source-head">
                  <span>{t("agentStats.table.source")}</span>
                  <span>{t("agentStats.table.exec")}</span>
                  <span>{t("agentStats.table.wait")}</span>
                  <span>{t("agentStats.table.span")}</span>
                  <span>{t("agentStats.table.completedFailed")}</span>
                  <span>{t("agentStats.table.failureRate")}</span>
                </div>
                {data.by_source.map((s) => (
                  <SourceRow key={s.source_id} s={s} />
                ))}
              </div>
            )}
          </div>

          <div className="panel-block">
            <div className="panel-block-head">
              <span>
                <Clock3 size={12} />{" "}
                {t("agentStats.sessions.title", { n: data.coverage.sessions_shown })}
              </span>
              {data.coverage.sessions_total > data.coverage.sessions_shown && (
                <span className="astats-sub">
                  {t("agentStats.sessions.total", { n: data.coverage.sessions_total })}
                </span>
              )}
            </div>
            {data.sessions.length === 0 && (
              <div className="empty-hint">{t("agentStats.sessions.empty")}</div>
            )}
            {data.sessions.map((ses) => {
              const sesMeasurable = ses.runs > 0 && ses.runs_without_detail < ses.runs;
              const sesDur = (sec: number) =>
                sesMeasurable ? fmtDur(t, sec) : t("agentStats.unknown");
              return (
                <div key={ses.session_id} className="astats-session">
                  <div className="astats-session-main">
                    <span className="astats-session-title" data-tip={ses.external_id}>
                      {ses.title || ses.external_id}
                    </span>
                    <span className="astats-session-meta">
                      {ses.source_name} · {statusLabel(t, ses.status)} ·{" "}
                      {t("agentStats.sessions.lastSeen", { time: fmtStamp(ses.last_seen_at) })}
                    </span>
                  </div>
                  <div className="astats-session-metrics">
                    <span>{t("agentStats.sessions.runs", { n: ses.runs })}</span>
                    <span className="astats-exec">
                      {t("agentStats.sessions.exec", { time: sesDur(ses.exec_sec) })}
                    </span>
                    <span>{t("agentStats.sessions.wait", { time: sesDur(ses.wait_sec) })}</span>
                    <span>{t("agentStats.sessions.span", { time: fmtDur(t, ses.span_sec) })}</span>
                    {(ses.failed > 0 || ses.unresolved > 0) && (
                      <span className="astats-fail">
                        {t("agentStats.sessions.failed", {
                          failed: ses.failed,
                          unresolved: ses.unresolved,
                        })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="panel-block">
            <div className="panel-block-head">
              <span>{t("agentStats.definitions.title")}</span>
            </div>
            <div className="astats-note">{t("agentStats.definitions.body")}</div>
            <div className="astats-quality">
              <span>{t("agentStats.quality.missingStart", { n: data.quality.missing_start_runs })}</span>
              <span>{t("agentStats.quality.missingEnd", { n: data.quality.missing_end_runs })}</span>
              <span>{t("agentStats.quality.staleOpen", { n: data.quality.stale_open_runs })}</span>
              <span>{t("agentStats.quality.lateEvents", { n: data.quality.late_events })}</span>
              <span>{t("agentStats.quality.coalesced", { n: data.quality.coalesced_events })}</span>
              <span>{t("agentStats.quality.unreliable", { n: data.quality.unreliable_intervals })}</span>
              <span>{t("agentStats.quality.gap", { time: fmtDur(t, data.quality.gap_unknown_sec) })}</span>
              <span>
                {t("agentStats.quality.windowAttributed", { n: data.quality.window_attributed_runs })}
              </span>
              <span>{t("agentStats.quality.noDetail", { n: data.quality.no_detail_runs })}</span>
              <span>
                {t("agentStats.quality.unattributed", { n: data.quality.unattributed_events })}
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
