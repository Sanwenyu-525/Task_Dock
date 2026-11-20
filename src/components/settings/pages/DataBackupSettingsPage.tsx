//! 数据与备份页（2026-11-20 第二阶段：按业务分组重排，行为不变）。
//!
//! 分组：备份策略 / 备份与恢复 / 备份记录 / 测试数据审计。
//! - 备份记录挂载时读取一次，失败显示真实错误与重试，不伪装成空数据；
//! - 长文件名在卡片内截断并保留 `title`，时间/类型/大小不被挤掉；
//! - 指标改用 `.settings-kv-*`（不再借用备份列表类名），值可换行。

import { useEffect, useState } from "react";
import { AlertTriangle, Database, RefreshCw } from "lucide-react";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { EmptyState, NumberInput, Switch } from "../../ui";
import { ConfirmDialog } from "../../ui/Dialog";
import SettingsPageLayout from "../SettingsPageLayout";
import SettingsGroup from "../SettingsGroup";
import ContextHelpButton from "../../help/ContextHelpButton";
import {
  auditTestData,
  backupNow,
  exportData,
  importData,
  inspectBackup,
  listBackups,
  type AuditTableCounts,
  type BackupEntry,
  type TestDataAudit,
} from "../../../lib/bridge";
import { formatBytes } from "../../../lib/clipboardUi";
import { formatLocalStamp } from "../../../lib/format";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useUiStore } from "../../../store/useUiStore";
import { useLocale } from "../../../hooks/useLocale";
import type { MessageKey } from "../../../i18n";

function sumAuditCounts(c: AuditTableCounts): number {
  return c.events + c.sessions + c.runs + c.instances + c.notifications;
}

/** 备份类型只按后端元数据判断；未知值明确标未知，绝不猜测为完整。 */
function backupKindLabel(
  kind: string | null | undefined,
  t: (key: MessageKey) => string,
): string {
  if (kind === "quick") return t("settings.data.kind.quick");
  if (kind === "full") return t("settings.data.kind.full");
  if (!kind) return t("settings.data.kind.legacy");
  return t("settings.data.kind.unknown");
}

export default function DataBackupSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [testAudit, setTestAudit] = useState<TestDataAudit | null>(null);
  /** 恢复完成后仍可回看的配置告警（快捷键冲突/未知微件/语言回退等）。 */
  const [restoreWarnings, setRestoreWarnings] = useState<string[]>([]);
  // 危险操作的应用内确认（替代系统原生 confirm，统一液态玻璃视觉与键盘交互）
  const [pendingDanger, setPendingDanger] = useState<
    | { type: "audit-apply"; count: number }
    | { type: "import"; path: string; partial: boolean; detail: string }
    | null
  >(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  /** 备份列表读取失败：显示真实错误与重试，不伪装成空数据。 */
  const [dataLoadError, setDataLoadError] = useState<string | null>(null);

  useEffect(() => {
    void loadBackups();
  }, []);

  async function loadBackups(): Promise<boolean> {
    setDataLoadError(null);
    try {
      setBackups(await listBackups());
      return true;
    } catch (e) {
      setDataLoadError(String(e));
      return false;
    }
  }

  if (!settings) return null;

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

  async function onExport() {
    await withBusy("export", async () => {
      const path = await save({
        defaultPath: `task-dock-export-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await exportData(path);
      showToast(t("settings.agent.copied", { value: path }), { kind: "success" });
    });
  }

  async function onImport() {
    await withBusy("import", async () => {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "Task Dock backup", extensions: ["jsonl", "json"] }],
      });
      if (!path || Array.isArray(path)) return;
      const meta = await inspectBackup(path);
      const truncated = meta.truncated_tables ?? [];
      const lines = [
        meta.partial
          ? t("settings.data.importPartial")
          : meta.format === "legacy-json"
            ? t("settings.data.importLegacy")
            : t("settings.data.importFull"),
        truncated.length
          ? t("settings.data.importTruncated", {
              tables: truncated.join(t("settings.data.listSeparator")),
            })
          : "",
        meta.config_included
          ? t("settings.data.importConfigIncluded")
          : t("settings.data.importConfigAbsent"),
        t("settings.data.importRollback"),
        t("settings.data.importContinue"),
      ].filter(Boolean);
      // 危险操作：改走应用内确认框（保留完整风险说明；确认后 runImport 执行）
      setPendingDanger({
        type: "import",
        path,
        partial: meta.partial,
        detail: lines.join("\n\n"),
      });
    });
  }

  /** 确认恢复备份：执行期间禁用重复提交，失败保留错误反馈 */
  async function runImport() {
    if (pendingDanger?.type !== "import" || dangerBusy) return;
    setDangerBusy(true);
    try {
      const outcome = await importData(pendingDanger.path, pendingDanger.partial);
      setBackups(await listBackups());
      // 配置恢复是非致命环节：数据已恢复时，冲突/降级必须持续可见，不能只闪一条 Toast。
      setRestoreWarnings(outcome.warnings ?? []);
      showToast(
        t("settings.data.importRestored", { message: outcome.message }) +
          (outcome.assets || outcome.archives
            ? t("settings.data.importAssets", {
                assets: outcome.assets,
                archives: outcome.archives,
              })
            : ""),
        { kind: "success" },
      );
      if (outcome.config?.included) {
        showToast(
          t("settings.data.importConfigSummary", {
            locale: outcome.config.locale ?? t("common.unknown"),
            widgets: outcome.config.widgets,
            hotkeys: outcome.config.hotkeys_applied,
          }),
          { kind: "info" },
        );
      }
    } catch (e) {
      showToast(t("settings.data.importFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setDangerBusy(false);
      setPendingDanger(null);
    }
  }

  async function onAuditPreview() {
    await withBusy("audit-preview", async () => {
      const r = await auditTestData(false);
      setTestAudit(r);
      const n = sumAuditCounts(r.provable_total);
      showToast(
        n > 0
          ? t("settings.data.auditFound", { count: n })
          : t("settings.data.auditNone"),
        { kind: "success" },
      );
    });
  }

  async function onAuditApply() {
    await withBusy("audit-apply", async () => {
      const preview = testAudit ?? (await auditTestData(false));
      setTestAudit(preview);
      const n = sumAuditCounts(preview.provable_total);
      if (n === 0) {
        showToast(t("settings.data.auditNoneToClean"), { kind: "success" });
        return;
      }
      // 危险操作：改走应用内确认框（保留完整风险说明；确认后 runAuditApply 执行）
      setPendingDanger({ type: "audit-apply", count: n });
    });
  }

  /** 确认清理测试数据：执行期间禁用重复提交，失败保留错误反馈 */
  async function runAuditApply() {
    if (pendingDanger?.type !== "audit-apply" || dangerBusy) return;
    setDangerBusy(true);
    try {
      const r = await auditTestData(true);
      setTestAudit(r);
      const deleted = r.deleted ? sumAuditCounts(r.deleted) : 0;
      showToast(
        r.backup_path
          ? t("settings.data.auditCleaned", { count: deleted, path: r.backup_path })
          : r.notes[0] ?? t("settings.data.auditNoDelete"),
        { kind: r.fk_violations > 0 ? "error" : "success" },
      );
    } catch (e) {
      showToast(t("settings.data.auditFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setDangerBusy(false);
      setPendingDanger(null);
    }
  }

  return (
    <SettingsPageLayout
      icon={Database}
      title={t("settings.section.data")}
      description={t("settings.section.dataDesc")}
      variant="list"
    >
      {dataLoadError && (
        <div className="setting-note error-text" role="alert">
          {t("settings.loadError", { error: dataLoadError })}
          <button type="button" className="btn sm" onClick={() => void loadBackups()}>
            {t("common.retry")}
          </button>
        </div>
      )}

      <SettingsGroup title={t("settings.data.group.policy")} description={t("settings.data.group.policyDesc")}>
        <div className="setting-row">
          <span>{t("settings.data.autoBackup")}</span>
          <div className="btn-row">
            <Switch
              checked={settings.auto_backup}
              ariaLabel={t("settings.data.autoBackup")}
              onChange={(v) => update({ auto_backup: v })}
            />
            <ContextHelpButton articleId="help.troubleshooting.backup" />
          </div>
        </div>
        <div className="setting-row">
          <span>{t("settings.data.retainDays")}</span>
          <NumberInput
            value={settings.backup_retain_days}
            min={1}
            max={90}
            ariaLabel={t("settings.data.retainDays")}
            onChange={(v) => update({ backup_retain_days: v })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.data.group.actions")} description={t("settings.data.group.actionsDesc")}>
        <div className="settings-actions-row">
          <button
            className="btn sm"
            disabled={busyKey === "backup"}
            onClick={() => withBusy("backup", async () => {
              const p = await backupNow(false);
              setBackups(await listBackups());
              showToast(t("settings.data.quickBackupDone", { path: p }), { kind: "success" });
            })}
          >
            {busyKey === "backup" ? <RefreshCw size={12} className="spin" /> : null}{" "}
            {t("settings.data.quickBackup")}
          </button>
          <button
            className="btn sm"
            disabled={busyKey === "backup-full"}
            onClick={() => withBusy("backup-full", async () => {
              const p = await backupNow(true);
              setBackups(await listBackups());
              showToast(t("settings.data.fullBackupDone", { path: p }), { kind: "success" });
            })}
          >
            {busyKey === "backup-full" ? <RefreshCw size={12} className="spin" /> : null}{" "}
            {t("settings.data.fullBackup")}
          </button>
          <button className="btn sm" onClick={onExport} disabled={busyKey === "export"}>
            {t("settings.data.export")}
          </button>
          <button className="btn sm" onClick={onImport} disabled={busyKey === "import"}>
            {t("settings.data.import")}
          </button>
        </div>
        {restoreWarnings.length > 0 && (
          <div className="setting-note" role="status">
            <strong>
              <AlertTriangle size={12} aria-hidden="true" /> {t("settings.data.importWarnings")}
            </strong>
            <ul>
              {restoreWarnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.data.group.records")}
        description={t("settings.data.group.recordsDesc")}
        actions={
          <button
            type="button"
            className="btn sm"
            onClick={() => void loadBackups()}
            disabled={busyKey === "refresh"}
          >
            <RefreshCw size={11} /> {t("settings.data.refresh")}
          </button>
        }
      >
        {backups.length > 0 ? (
          <div className="backup-list backup-record-list">
            {backups.slice(0, 8).map((b) => {
              // 只展示真实 modified 元数据（含本地时区）；不从文件名推断时间。
              const stamp = formatLocalStamp(b.modified);
              const truncatedTables = b.truncated_tables ?? [];
              return (
                <div key={b.name} className="backup-item backup-record">
                  <div className="backup-record-head">
                    <span className="backup-record-kind">{backupKindLabel(b.kind, t)}</span>
                    <span className="backup-record-flags">
                      {b.partial && <span className="chip">{t("settings.data.partial")}</span>}
                      {truncatedTables.length > 0 && (
                        <span
                          className="chip"
                          title={t("settings.data.truncatedTitle", {
                            tables: truncatedTables.join(t("settings.data.listSeparator")),
                          })}
                        >
                          {t("settings.data.truncated", { count: truncatedTables.length })}
                        </span>
                      )}
                      {b.extended_modules && (
                        <span className="chip">{t("settings.data.extended")}</span>
                      )}
                      {b.config_included && (
                        <span className="chip">{t("settings.data.configIncluded")}</span>
                      )}
                    </span>
                    <span className="backup-record-size">{formatBytes(b.size)}</span>
                  </div>
                  <div className="backup-record-sub">
                    <span className="backup-record-time">
                      {stamp
                        ? t("settings.data.stamp", {
                            date: stamp.date,
                            time: stamp.time,
                            zone: stamp.zone,
                          })
                        : t("settings.data.timeUnknown")}
                    </span>
                    <span className="backup-record-name" title={b.name} dir="ltr">
                      {b.name}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : dataLoadError ? null : (
          <EmptyState
            title={t("settings.data.empty.title")}
            hint={t("settings.data.empty.hint")}
            action={
              <button
                className="btn sm"
                disabled={busyKey === "backup"}
                onClick={() => withBusy("backup", async () => {
                  const p = await backupNow(false);
                  setBackups(await listBackups());
                  showToast(t("settings.data.quickBackupDone", { path: p }), { kind: "success" });
                })}
              >
                {t("settings.data.quickBackup")}
              </button>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.data.group.audit")} description={t("settings.data.group.auditDesc")}>
        <div className="settings-actions-row">
          <button className="btn sm" onClick={onAuditPreview} disabled={busyKey === "audit-preview"}>
            {busyKey === "audit-preview" ? <RefreshCw size={12} className="spin" /> : null}{" "}
            {t("settings.data.auditPreview")}
          </button>
          <button className="btn sm" onClick={onAuditApply} disabled={busyKey === "audit-apply"}>
            {busyKey === "audit-apply" ? <RefreshCw size={12} className="spin" /> : null}{" "}
            {t("settings.data.auditApply")}
          </button>
        </div>
        {testAudit && (
          <div className="settings-kv-list">
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.data.provable")}</span>
              <span className="settings-kv-value">
                {t("settings.data.provableValue", {
                  count: sumAuditCounts(testAudit.provable_total),
                  detail:
                    testAudit.provable
                      .map((p) => `${p.origin} ${sumAuditCounts(p.counts)}`)
                      .join(" / ") || t("settings.data.none"),
                })}
              </span>
            </div>
            <div className="settings-kv-row">
              <span className="settings-kv-label">{t("settings.data.real")}</span>
              <span className="settings-kv-value">
                {t("settings.data.realValue", {
                  events: testAudit.real.events,
                  sessions: testAudit.real.sessions,
                  runs: testAudit.real.runs,
                  notifications: testAudit.real.notifications,
                })}
              </span>
            </div>
            {testAudit.deleted && (
              <div className="settings-kv-row">
                <span className="settings-kv-label">{t("settings.data.deleted")}</span>
                <span className="settings-kv-value">
                  {t("settings.data.realValue", {
                    events: testAudit.deleted.events,
                    sessions: testAudit.deleted.sessions,
                    runs: testAudit.deleted.runs,
                    notifications: testAudit.deleted.notifications,
                  })}
                </span>
              </div>
            )}
            {testAudit.backup_path && (
              <div className="settings-kv-row">
                <span className="settings-kv-label">{t("settings.data.snapshot")}</span>
                <span className="settings-kv-value">
                  <code>{testAudit.backup_path}</code>
                </span>
              </div>
            )}
            {testAudit.uncertain.length > 0 && (
              <div className="settings-kv-row">
                <span className="settings-kv-label">{t("settings.data.uncertain")}</span>
                <span className="settings-kv-value">
                  {testAudit.uncertain.map((u) => `${u.kind} ${u.count}`).join(" · ")}
                </span>
              </div>
            )}
          </div>
        )}
        {testAudit?.notes.map((n) => (
          <div className="setting-note" key={n}>{n}</div>
        ))}
        <div className="setting-note">{t("settings.data.auditNote")}</div>
      </SettingsGroup>

      {/* 危险操作统一确认框：深浅主题一致、危险标识、执行中禁用重复提交 */}
      <ConfirmDialog
        open={pendingDanger !== null}
        danger
        title={
          pendingDanger?.type === "audit-apply"
            ? t("settings.danger.auditTitle")
            : pendingDanger?.type === "import"
              ? pendingDanger.partial
                ? t("settings.danger.importPartialTitle")
                : t("settings.danger.importTitle")
              : ""
        }
        detail={
          pendingDanger?.type === "audit-apply"
            ? t("settings.danger.auditDetail", { count: pendingDanger.count })
            : pendingDanger?.type === "import"
              ? pendingDanger.detail
              : undefined
        }
        confirmLabel={t("settings.danger.confirm")}
        busy={dangerBusy}
        onConfirm={() => {
          if (pendingDanger?.type === "audit-apply") void runAuditApply();
          else if (pendingDanger?.type === "import") void runImport();
        }}
        onCancel={() => {
          if (!dangerBusy) setPendingDanger(null);
        }}
      />
    </SettingsPageLayout>
  );
}
