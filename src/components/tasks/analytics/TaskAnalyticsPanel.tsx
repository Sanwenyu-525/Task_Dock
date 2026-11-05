/**
 * 任务统计子视图（`tasks.stats-trends`）。
 *
 * 边界：
 * - 仅在打开该子视图时按需查询；无轮询、无后台定时器，卸载后在途请求的结果被忽略
 *   （IPC 本身不支持取消，不会因卸载产生定时器或后续查询）。
 * - 不展示「效率评分 / AI 评分」等无数据支撑的指标；完成率、逾期率的口径来自词典，
 *   与后端 `DEFINITIONS` 的语义保持一致，不在前端另写一份。
 * - 图表可选（开关状态本地保存），关闭后只保留数值卡片与分布列表，减少渲染负担。
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";

import { useLocale } from "../../../hooks/useLocale";
import { formatLocalizedDate, formatLocalizedNumber, formatLocalizedPercent, formatLocalizedTime } from "../../../i18n/format";
import { localizedErrorMessage } from "../../../i18n/errors";
import type { MessageKey } from "../../../i18n";
import { fetchTaskAnalytics, type AnalyticsRange, type TaskAnalytics } from "./api";
import "./analytics.css";

const RANGES: { id: AnalyticsRange; labelKey: MessageKey }[] = [
  { id: "day", labelKey: "taskAnalytics.range.day" },
  { id: "week", labelKey: "taskAnalytics.range.week" },
  { id: "month", labelKey: "taskAnalytics.range.month" },
];

const RANGE_LABEL_KEYS: Record<AnalyticsRange, MessageKey> = {
  day: "taskAnalytics.rangeLabel.day",
  week: "taskAnalytics.rangeLabel.week",
  month: "taskAnalytics.rangeLabel.month",
};

const PRIORITY_KEYS: Record<number, MessageKey> = {
  0: "taskAnalytics.priority.p0",
  1: "taskAnalytics.priority.p1",
  2: "taskAnalytics.priority.p2",
  3: "taskAnalytics.priority.p3",
};

/** 后端 `normalize_category` 把空分类写成这个字面量；展示时映射为本地化「未分类」。 */
const UNCATEGORIZED_CATEGORY = "未分类";

const CHARTS_KEY = "task-analytics:charts-visible";

function readChartsVisible(): boolean {
  try {
    return localStorage.getItem(CHARTS_KEY) !== "0";
  } catch {
    return true;
  }
}

function percent(ratio: number | null): string {
  // 未知分母（null / 非有限值）保持「—」，不伪装成 0%。
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return formatLocalizedPercent(ratio);
}

/** 趋势桶标签由本地日期生成，避免使用后端返回的中文月份（`11月`）或固定 `%m-%d`。 */
function trendPointLabel(range: AnalyticsRange, start: string): string {
  return range === "month"
    ? formatLocalizedDate(start, { month: "short" })
    : formatLocalizedDate(start, { month: "numeric", day: "2-digit" });
}

export default function TaskAnalyticsPanel() {
  const { t } = useLocale();
  const [range, setRange] = useState<AnalyticsRange>("day");
  const [rawData, setData] = useState<TaskAnalytics | null>(null);
  // 挂载后 effect 必然发起首次查询，初始即为加载态，避免首帧只有工具栏。
  const [loading, setLoading] = useState(true);
  /** 保留原始错误，渲染时再按当前语言本地化；切换语言后错误文案也会跟着变。 */
  const [error, setError] = useState<unknown | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [chartsVisible, setChartsVisible] = useState(readChartsVisible);
  /** 只认最后一次请求：旧范围的响应不能晚到覆盖新范围，也不能让旧「更新中」提前结束。 */
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTaskAnalytics(range)
      .then((next) => {
        if (cancelled || seq !== requestSeq.current) return;
        setData(next);
        setError(null);
      })
      .catch((e) => {
        if (cancelled || seq !== requestSeq.current) return;
        setError(e);
      })
      .finally(() => {
        if (cancelled || seq !== requestSeq.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, reloadKey]);

  const toggleCharts = () => {
    setChartsVisible((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CHARTS_KEY, next ? "1" : "0");
      } catch {
        // 本地存储不可用（隐私模式）时只影响本次会话，不影响统计功能
      }
      return next;
    });
  };

  const changeRange = (next: AnalyticsRange) => {
    if (next === range) return;
    // 切范围时先清空旧数据，避免「周」的数字短暂挂在「月」标签下
    setData(null);
    setError(null);
    setLoading(true);
    setRange(next);
  };

  const priorityLabel = (priority: number): string => {
    const key = PRIORITY_KEYS[priority];
    return key ? t(key) : `P${formatLocalizedNumber(priority)}`;
  };

  // 渲染层再按 range 校验一次：即使旧响应在 effect 清理前落地，也不会把旧范围的数字
  // 挂在新范围标签下（后端回包自带 range，可据此丢弃）。
  const data = rawData && rawData.range === range ? rawData : null;
  const summary = data?.summary;
  const completed = summary?.completed ?? 0;
  const recurringCompleted = summary?.recurring_completed ?? 0;
  const due = summary?.due ?? 0;
  const dueCompleted = summary?.due_completed ?? 0;
  const dueOverdue = summary?.due_overdue ?? 0;
  const rangeLabel = t(RANGE_LABEL_KEYS[range]);
  const updatedTime = data ? formatLocalizedTime(data.generated_at) : "";
  const maxCount = data
    ? Math.max(1, ...data.trend.map((p) => Math.max(p.completed, p.due_overdue)))
    : 1;

  return (
    <div className="analytics-panel" role="region" aria-label={t("taskAnalytics.title")}>
      <div className="analytics-head">
        <div className="seg-group subtle" role="group" aria-label={t("taskAnalytics.rangeAria")}>
          {RANGES.map((item) => (
            <button
              key={item.id}
              className={`seg-btn ${range === item.id ? "active" : ""}`}
              aria-pressed={range === item.id}
              onClick={() => changeRange(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        <span className="flex-spacer" />
        {loading && data && <span className="analytics-refreshing">{t("taskAnalytics.refreshing")}</span>}
        <button
          className={`icon-btn sm ${chartsVisible ? "active" : ""}`}
          data-tip={chartsVisible ? t("taskAnalytics.charts.hide") : t("taskAnalytics.charts.show")}
          aria-label={chartsVisible ? t("taskAnalytics.charts.hide") : t("taskAnalytics.charts.show")}
          aria-pressed={chartsVisible}
          onClick={toggleCharts}
        >
          <BarChart3 size={13} />
        </button>
        <button
          className="icon-btn sm"
          data-tip={t("taskAnalytics.refresh")}
          aria-label={t("taskAnalytics.refresh")}
          disabled={loading}
          onClick={() => setReloadKey((n) => n + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {!data && loading && (
        <div className="analytics-empty" role="status">
          {t("taskAnalytics.loading")}
        </div>
      )}

      {!data && error !== null && (
        <div className="analytics-empty error-text" role="alert">
          <AlertTriangle size={16} />
          <span>{t("taskAnalytics.loadFailed", { error: localizedErrorMessage(error) })}</span>
          <button className="btn sm" onClick={() => setReloadKey((n) => n + 1)}>
            {t("taskAnalytics.retry")}
          </button>
        </div>
      )}

      {data && (
        <>
          {error !== null && (
            <div className="analytics-inline-error error-text" role="status">
              {t("taskAnalytics.refreshFailed", { error: localizedErrorMessage(error) })}
            </div>
          )}

          {data.history_complete === false && (
            <div className="analytics-inline-error" role="status">
              <AlertTriangle size={12} aria-hidden="true" />{" "}
              <span>{t("taskAnalytics.historyIncomplete")}</span>
            </div>
          )}

          <div className="analytics-cards">
            <div className="analytics-card" data-tip={t("taskAnalytics.definitions.completed")}>
              {/* 完成动作计数：与概览/胶囊的「今日完成」（按任务行计，重复任务完成后
                  保持 pending）不是同一指标。词典当前只有 taskAnalytics.completed
                  （{range}完成），没有「次数」变体；这里刻意不使用 priority.hint
                  （完成数量），避免与任务数量混淆。 */}
              <span className="analytics-card-label">{t("taskAnalytics.completed", { range: rangeLabel })}</span>
              <span className="analytics-card-value">{formatLocalizedNumber(completed)}</span>
              {recurringCompleted > 0 && (
                <span className="analytics-card-sub">
                  {t("taskAnalytics.recurringCompleted", { count: formatLocalizedNumber(recurringCompleted) })}
                </span>
              )}
            </div>
            <div className="analytics-card">
              <span className="analytics-card-label">{t("taskAnalytics.dueThisPeriod")}</span>
              <span className="analytics-card-value">{formatLocalizedNumber(due)}</span>
              <span className="analytics-card-sub">
                {t("taskAnalytics.dueCompleted", { count: formatLocalizedNumber(dueCompleted) })}
              </span>
            </div>
            <div className="analytics-card" data-tip={t("taskAnalytics.definitions.completionRate")}>
              <span className="analytics-card-label">{t("taskAnalytics.completionRate")}</span>
              <span className="analytics-card-value">{percent(summary?.completion_rate ?? null)}</span>
              <span className="analytics-card-sub">{t("taskAnalytics.completionRateHint")}</span>
            </div>
            <div className="analytics-card" data-tip={t("taskAnalytics.definitions.overdueRate")}>
              <span className="analytics-card-label">{t("taskAnalytics.overdueRate")}</span>
              <span className="analytics-card-value">{percent(summary?.overdue_rate ?? null)}</span>
              <span className="analytics-card-sub">
                {t("taskAnalytics.overdueRateHint", {
                  overdue: formatLocalizedNumber(dueOverdue),
                  due: formatLocalizedNumber(due),
                })}
              </span>
            </div>
          </div>

          {chartsVisible && (
            <section className="analytics-section">
              <div className="analytics-section-head">
                <h4>{t("taskAnalytics.trend.title")}</h4>
                <span className="analytics-legend">
                  <span className="analytics-legend-dot completed" />
                  {t("taskAnalytics.trend.completed")}
                  <span className="analytics-legend-dot overdue" />
                  {t("taskAnalytics.trend.overdue")}
                </span>
              </div>
              <div
                className="analytics-chart"
                role="img"
                aria-label={t("taskAnalytics.trend.aria", { range: rangeLabel })}
                data-tip={t("taskAnalytics.definitions.trend")}
              >
                {data.trend.map((point) => {
                  const label = trendPointLabel(range, point.start) || point.key;
                  return (
                    <div
                      key={point.key}
                      className="analytics-bar-col"
                      data-tip={t("taskAnalytics.trend.pointTip", {
                        label,
                        completed: formatLocalizedNumber(point.completed),
                        overdue: formatLocalizedNumber(point.due_overdue),
                        rate: percent(point.completion_rate),
                      })}
                    >
                      <div className="analytics-bars" aria-hidden="true">
                        <span
                          className="analytics-bar completed"
                          style={{ height: `${(point.completed / maxCount) * 100}%` }}
                        />
                        <span
                          className="analytics-bar overdue"
                          style={{ height: `${(point.due_overdue / maxCount) * 100}%` }}
                        />
                      </div>
                      <span className="analytics-bar-label">{label}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {completed > 0 ? (
            <>
              <section className="analytics-section" data-tip={t("taskAnalytics.definitions.distribution")}>
                <div className="analytics-section-head">
                  <h4>{t("taskAnalytics.distribution.title")}</h4>
                  <span className="analytics-hint">{t("taskAnalytics.distribution.hint")}</span>
                </div>
                {data.by_category.map((item) => {
                  const name =
                    item.category === UNCATEGORIZED_CATEGORY
                      ? t("taskAnalytics.category.uncategorized")
                      : item.category;
                  return (
                    <div className="analytics-dist-row" key={item.category}>
                      <div className="analytics-dist-head">
                        <span className="analytics-dist-name" data-tip={name}>
                          {name}
                        </span>
                        <span className="analytics-dist-value">
                          {formatLocalizedNumber(item.completed)} · {percent(item.share)}
                        </span>
                      </div>
                      <div className="analytics-dist-track">
                        <span style={{ width: `${item.share * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </section>

              <section className="analytics-section">
                <div className="analytics-section-head">
                  <h4>{t("taskAnalytics.priority.title")}</h4>
                  <span className="analytics-hint">{t("taskAnalytics.priority.hint")}</span>
                </div>
                {data.by_priority.map((item) => (
                  <div className="analytics-dist-row" key={item.priority}>
                    <div className="analytics-dist-head">
                      <span className="analytics-dist-name">{priorityLabel(item.priority)}</span>
                      <span className="analytics-dist-value">
                        {formatLocalizedNumber(item.completed)} · {percent(item.share)}
                      </span>
                    </div>
                    <div className="analytics-dist-track">
                      <span style={{ width: `${item.share * 100}%` }} />
                    </div>
                  </div>
                ))}
              </section>
            </>
          ) : (
            <div className="analytics-empty">{t("taskAnalytics.distribution.empty")}</div>
          )}

          <div className="analytics-defs">
            <span className="analytics-defs-title">{t("taskAnalytics.definitions.title")}</span>
            <ul>
              <li>{t("taskAnalytics.definitions.completed")}</li>
              <li>{t("taskAnalytics.definitions.completionRate")}</li>
              <li>{t("taskAnalytics.definitions.overdueRate")}</li>
              <li>{t("taskAnalytics.definitions.trend")}</li>
              <li>{t("taskAnalytics.definitions.distribution")}</li>
              <li>{t("taskAnalytics.definitions.history")}</li>
            </ul>
          </div>

          {updatedTime && (
            <div className="analytics-foot">{t("taskAnalytics.updatedAt", { time: updatedTime })}</div>
          )}
        </>
      )}
    </div>
  );
}
