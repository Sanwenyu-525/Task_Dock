//! 诊断中心「按需加载」分区：页面代码加载与实例生命周期的实时视图。
//!
//! 数据全部来自 `lib/featureRuntime` 的**内存**记录（本窗口内），因此：
//! - 不读数据库、不发 IPC、不轮询：打开面板只做一次快照，runtime 变更时订阅重绘；
//! - 生产环境零额外开销（runtime 只在加载/切换时更新一个对象）；
//! - 「重复加载」= 加载请求数 − 真实 import 次数，正常应恒为 0；
//!   它变大意味着有代码绕开了 `loadFeature` 直接 import。
//!
//! 边界：这是诊断视图，不提供「清理/重置」按钮 —— 重置会丢失本窗口的加载历史，
//! 让排查断线；需要复现请在重启后重新走一遍路径。

import { useSyncExternalStore } from "react";
import { useLocale } from "../../hooks/useLocale";
import {
  getFeatureRuntimeRevision,
  getFeatureRuntimeSummary,
  listFeatureEvents,
  listFeatureSnapshots,
  subscribeFeatureRuntime,
} from "../../lib/featureRuntime";

function formatMs(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value)} ms`;
}

export default function FeatureLoadSection() {
  const { t } = useLocale();
  // 订阅运行时：加载/切换/释放时重绘；快照用 revision（内容在渲染时读取）。
  useSyncExternalStore(
    subscribeFeatureRuntime,
    getFeatureRuntimeRevision,
    getFeatureRuntimeRevision,
  );

  const summary = getFeatureRuntimeSummary();
  // 只列「真正参与过加载」的功能：已登记但从未进入的页面不属于运行态信息。
  const rows = listFeatureSnapshots().filter(
    (row) => row.loadExecutions > 0 || row.state === "failed",
  );
  const events = listFeatureEvents().slice(-8).reverse();
  const deduped = Math.max(0, summary.loadRequests - summary.loadExecutions);

  return (
    <section className="diag-center-overview" aria-label={t("diagnosticsCenter.featureLoad.title")}>
      <h2 className="diag-center-section-title">{t("diagnosticsCenter.featureLoad.title")}</h2>
      <p className="diag-center-section-hint">{t("diagnosticsCenter.featureLoad.hint")}</p>

      <div className="diag-center-metrics">
        <div className="diag-center-metric">
          <span className="diag-center-metric-label">
            {t("diagnosticsCenter.featureLoad.loaded")}
          </span>
          <span className="diag-center-metric-value">
            {summary.loaded}
            <span className="diag-center-metric-hint">/ {summary.total}</span>
          </span>
        </div>
        <div className="diag-center-metric">
          <span className="diag-center-metric-label">
            {t("diagnosticsCenter.featureLoad.active")}
          </span>
          <span className="diag-center-metric-value">{summary.active}</span>
        </div>
        <div className="diag-center-metric">
          <span className="diag-center-metric-label">
            {t("diagnosticsCenter.featureLoad.failed")}
          </span>
          <span
            className={`diag-center-metric-value${summary.failed > 0 ? " is-error" : ""}`}
          >
            {summary.failed}
          </span>
        </div>
        <div className="diag-center-metric">
          <span className="diag-center-metric-label">
            {t("diagnosticsCenter.featureLoad.deduped")}
          </span>
          <span className="diag-center-metric-value">{deduped}</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="diag-center-section-hint">{t("diagnosticsCenter.featureLoad.empty")}</p>
      ) : (
        <div className="diag-feature-table" role="table" aria-label={t("diagnosticsCenter.featureLoad.title")}>
          <div className="diag-feature-row diag-feature-head" role="row">
            <span role="columnheader">{t("diagnosticsCenter.featureLoad.col.page")}</span>
            <span role="columnheader">{t("diagnosticsCenter.featureLoad.col.state")}</span>
            <span role="columnheader">{t("diagnosticsCenter.featureLoad.col.loadMs")}</span>
            <span role="columnheader">{t("diagnosticsCenter.featureLoad.col.counts")}</span>
          </div>
          {rows.map((row) => (
            <div className="diag-feature-row" role="row" key={row.id}>
              <span className="diag-feature-name" role="cell" data-tip={row.id}>
                {row.label}
                <em className="diag-feature-id">{row.id}</em>
              </span>
              <span className={`diag-feature-state is-${row.state}`} role="cell">
                {row.state}
              </span>
              <span className="diag-center-mono" role="cell">
                {formatMs(row.loadMs)}
              </span>
              <span className="diag-center-mono" role="cell">
                {row.loads}/{row.activations}/{row.instanceReleases}
              </span>
            </div>
          ))}
        </div>
      )}

      {events.length > 0 && (
        <ul className="diag-feature-events" aria-label={t("diagnosticsCenter.featureLoad.events")}>
          {events.map((event, index) => (
            <li key={`${event.at}-${event.id}-${index}`} className="diag-feature-event">
              <span className="diag-center-mono">{event.kind}</span>
              <span className="diag-feature-id">{event.id}</span>
              {typeof event.durationMs === "number" && (
                <span className="diag-center-mono">{event.durationMs} ms</span>
              )}
              {event.detail && <span className="diag-feature-id">{event.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
