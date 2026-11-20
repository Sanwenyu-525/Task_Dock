//! 性能诊断页（自 SettingsPanel「性能诊断」分组原样迁移，2026-11-20）。
//! 指标摘要 + 操作工具栏 + 保留策略；快照数据只在页面挂载后按需刷新。
//! 2026-11-20 第二阶段：按「采样 / 指标 / 保留」分组，指标改用 `.settings-kv-*`，
//! 不再借用备份列表类名。

import { useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { NumberInput, Switch } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import SettingsGroup from "../SettingsGroup";
import {
  agentInboxRetry,
  agentRetentionRun,
  performanceDiagnostics,
  type PerformanceDiagnostics,
} from "../../../lib/bridge";
import { getAgentRefreshMetrics } from "../../../store/useAgentsStore";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useUiStore } from "../../../store/useUiStore";
import { useLocale } from "../../../hooks/useLocale";

export default function DiagnosticsSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);
  const [diag, setDiag] = useState<PerformanceDiagnostics | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (!settings) return null;

  const pipe = diag?.pipeline;
  const inboxStats = diag?.file_drop;
  const retention = diag?.retention;
  const frontendMetrics = getAgentRefreshMetrics();

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      showToast(t("settings.opFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function refreshDiag() {
    setBusyKey("diag");
    try {
      setDiag(await performanceDiagnostics());
    } catch (e) {
      showToast(t("settings.diagnostics.diagFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function onRetentionRun() {
    await withBusy("retention", async () => {
      const r = await agentRetentionRun();
      showToast(
        t("settings.diagnostics.retentionDone", { deleted: r.deleted, archived: r.archived }) +
          (r.archive_error
            ? t("settings.diagnostics.archiveError", { error: r.archive_error })
            : ""),
        { kind: r.archive_error ? "error" : "success" },
      );
      await refreshDiag();
    });
  }

  async function onInboxRetry() {
    await withBusy("inbox-retry", async () => {
      const n = await agentInboxRetry();
      showToast(t("settings.diagnostics.inboxRetried", { count: n }), { kind: "success" });
    });
  }

  return (
    <SettingsPageLayout
      icon={Gauge}
      title={t("settings.section.diagnostics")}
      description={t("settings.section.diagnosticsDesc")}
      variant="diagnostic"
    >
      <SettingsGroup
        title={t("settings.diagnostics.group.sampling")}
        description={t("settings.diagnostics.group.samplingDesc")}
      >
        <div className="setting-row">
          <span>{t("settings.diagnostics.enabled")}</span>
          <Switch
            checked={settings.perf_diagnostics_enabled}
            ariaLabel={t("settings.diagnostics.enabled")}
            onChange={(v) => update({ perf_diagnostics_enabled: v })}
          />
        </div>
        <div className="settings-actions-row">
          <button className="btn sm" onClick={refreshDiag} disabled={busyKey === "diag"}>
            {busyKey === "diag" ? <RefreshCw size={12} className="spin" /> : null}{" "}
            {t("settings.diagnostics.refresh")}
          </button>
          <button className="btn sm" onClick={onRetentionRun} disabled={busyKey === "retention"}>
            {busyKey === "retention"
              ? t("settings.diagnostics.pruning")
              : t("settings.diagnostics.prune")}
          </button>
          <button className="btn sm" onClick={onInboxRetry} disabled={busyKey === "inbox-retry"}>
            {t("settings.diagnostics.retryInbox")}
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.diagnostics.group.metrics")}>
        {diag?.enabled && pipe ? (
          <div className="settings-kv-list">
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.queue")}</span>
              <span className="settings-kv-value">
                {t("settings.diagnostics.queueValue", {
                  depth: pipe.queue_depth_events,
                  capacity: pipe.queue_capacity,
                  merged: pipe.events_merged,
                  sampled: pipe.events_sampled,
                  rejected: pipe.overload_rejects,
                })}
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.batches")}</span>
              <span className="settings-kv-value">
                {t("settings.diagnostics.batchesValue", {
                  processed: pipe.events_processed,
                  received: pipe.events_received,
                  batches: pipe.batches,
                  buffer: pipe.merge_buffer,
                })}
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.ingest")}</span>
              <span className="settings-kv-value">
                p50 {pipe.ingest_latency.p50_ms}ms · p95 {pipe.ingest_latency.p95_ms}ms · p99{" "}
                {pipe.ingest_latency.p99_ms}ms
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.write")}</span>
              <span className="settings-kv-value">
                p50 {pipe.db_write_latency.p50_ms}ms · p95 {pipe.db_write_latency.p95_ms}ms ·{" "}
                {pipe.commit_failures}
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.sqlite")}</span>
              <span className="settings-kv-value">
                {t("settings.diagnostics.sqliteValue", {
                  avg: diag.sqlite?.avg_ms ?? "-",
                  calls: diag.sqlite?.calls ?? 0,
                  slow: diag.sqlite?.slow_queries_100ms ?? 0,
                })}
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.fileDrop")}</span>
              <span className="settings-kv-value">
                {t("settings.diagnostics.fileDropValue", {
                  pending: inboxStats?.pending_files ?? 0,
                  bytes: inboxStats?.pending_bytes ?? 0,
                  failed: inboxStats?.failed_files ?? 0,
                  age: inboxStats?.oldest_age_secs ?? 0,
                })}
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.events")}</span>
              <span className="settings-kv-value">
                {t("settings.diagnostics.eventsValue", {
                  total: Number(retention?.total_rows ?? 0),
                  prunable: Number(retention?.prunable_rows ?? 0),
                  protected: Number(retention?.protected_rows ?? 0),
                })}
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.diagnostics.frontend")}</span>
              <span className="settings-kv-value">
                {t("settings.diagnostics.frontendValue", {
                  snapshots: frontendMetrics.snapshotRequests,
                  maxConcurrent: frontendMetrics.maxConcurrent,
                  coalesced: frontendMetrics.coalesced,
                  skipped: frontendMetrics.skippedHidden,
                })}
              </span>
            </div>
          </div>
        ) : (
          <div className="setting-note">
            {diag ? t("settings.diagnostics.off") : t("settings.diagnostics.group.metricsEmpty")}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.diagnostics.group.retention")}
        description={t("settings.diagnostics.group.retentionDesc")}
      >
        <div className="setting-row">
          <span>{t("settings.diagnostics.retentionDays")}</span>
          <NumberInput
            value={settings.agent_event_retention_days}
            min={0}
            max={365}
            ariaLabel={t("settings.diagnostics.retentionDays")}
            onChange={(v) => update({ agent_event_retention_days: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.diagnostics.maxRows")}</span>
          <NumberInput
            value={settings.agent_event_max_rows}
            min={0}
            step={10000}
            ariaLabel={t("settings.diagnostics.maxRows")}
            onChange={(v) => update({ agent_event_max_rows: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.diagnostics.archive")}</span>
          <Switch
            checked={settings.agent_event_archive}
            ariaLabel={t("settings.diagnostics.archive")}
            onChange={(v) => update({ agent_event_archive: v })}
          />
        </div>
        <div className="setting-note">{t("settings.diagnostics.note")}</div>
      </SettingsGroup>
    </SettingsPageLayout>
  );
}
