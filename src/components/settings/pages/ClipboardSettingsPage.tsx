//! 智能剪贴板页（自 SettingsPanel「智能剪贴板」分组原样迁移，2026-11-20）。
//!
//! 数据读取时机从「分组展开时」变为「页面挂载时」（统计 + 配置状态）。
//! 排除名单草稿：失焦提交 + 页面卸载前 flush（原「分类切换前 flushDrafts」
//! 迁移为卸载守卫，语义等价且覆盖更多切换路径）。

import { useEffect, useRef, useState } from "react";
import { Clipboard, RefreshCw, Trash2 } from "lucide-react";
import { NumberInput, Switch } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import {
  clipboardCleanup,
  clipboardEncryptHistoryMigrate,
  clipboardProbe,
  clipboardRepairConfig,
  clipboardStats,
  clipboardStatus,
  type ClipboardConfigError,
  type ClipboardStats,
} from "../../../lib/bridge";
import { formatBytes, kindLabel } from "../../../lib/clipboardUi";
import { errorMessage } from "../../../lib/errors";
import { reportError } from "../../../lib/errorReport";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useUiStore } from "../../../store/useUiStore";
import { useLocale } from "../../../hooks/useLocale";

export default function ClipboardSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);
  const [clipStats, setClipStats] = useState<ClipboardStats | null>(null);
  const [clipConfigError, setClipConfigError] = useState<ClipboardConfigError | null>(null);
  const [clipConfigOrigin, setClipConfigOrigin] = useState<string | null>(null);
  const [excludeApps, setExcludeApps] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** 读取失败显示真实错误与重试，不把失败伪装成空数据。 */
  const [dataLoadError, setDataLoadError] = useState<string | null>(null);
  const mountedRef = useRef(false);

  // 外部设置同步（修复配置后重读等）驱动本地草稿回正。
  useEffect(() => {
    if (settings) setExcludeApps(settings.clipboard_exclude_apps);
  }, [settings?.clipboard_exclude_apps]);

  const loadData = async (): Promise<boolean> => {
    setDataLoadError(null);
    const failures: unknown[] = [];
    // 统计与状态各自落地：一项失败不覆盖另一项，也不把失败清成空数据。
    const [statsResult, statusResult] = await Promise.allSettled([
      clipboardStats(),
      clipboardStatus(),
    ]);
    if (statsResult.status === "fulfilled") setClipStats(statsResult.value);
    else failures.push(statsResult.reason);
    if (statusResult.status === "fulfilled") {
      setClipConfigError(statusResult.value.configError ?? null);
      setClipConfigOrigin(statusResult.value.configOrigin ?? null);
    } else {
      failures.push(statusResult.reason);
    }
    if (failures.length > 0) {
      setDataLoadError(errorMessage(failures[0]));
      return false;
    }
    return true;
  };

  // 页面挂载读取一次；失败可重试。
  useEffect(() => {
    mountedRef.current = true;
    void loadData();
  }, []);

  /**
   * 排除名单草稿守卫：输入后未失焦就切换页面时，卸载前显式提交一次。
   * 失败仍走原有 Toast 反馈，不静默吞掉。
   * 经 ref 转发最新闭包：空依赖的卸载 effect 若直接捕获首渲染闭包，
   * 会拿到过期草稿值导致静默丢失。
   */
  const flushDraftsRef = useRef<() => void>(() => {});
  flushDraftsRef.current = () => {
    if (!mountedRef.current || !settings) return;
    if (excludeApps === settings.clipboard_exclude_apps) return;
    update({ clipboard_exclude_apps: excludeApps }).catch((e) =>
      showToast(t("settings.clipboard.excludeSaveFailed", { error: String(e) }), {
        kind: "error",
      }),
    );
  };
  useEffect(
    () => () => {
      flushDraftsRef.current();
      mountedRef.current = false;
    },
    [],
  );

  if (!settings) return null;

  async function onRepairClipboard(resume: boolean) {
    setBusyKey("clip-repair");
    try {
      await clipboardRepairConfig(resume);
      await useSettingsStore.getState().load();
      const status = await clipboardStatus();
      setClipConfigError(status.configError ?? null);
      setClipConfigOrigin(status.configOrigin ?? null);
      setClipStats(await clipboardStats());
      showToast(
        resume
          ? t("settings.clipboard.repairedResume")
          : t("settings.clipboard.repairedPause"),
        { kind: "success" },
      );
    } catch (e) {
      reportError(e, { operation: "修复剪贴板配置" });
    } finally {
      setBusyKey(null);
    }
  }

  async function refreshClipStats() {
    try {
      setClipStats(await clipboardStats());
    } catch {
      // 统计失败不影响设置读写
    }
  }

  /**
   * 加密现有历史：后端先做可核对备份（失败即中止），再加密正文与历史图片。
   * 界面只展示计数与备份哈希前缀，不回显正文或密钥。
   */
  async function onEncryptHistory() {
    setBusyKey("clip-encrypt");
    try {
      const r = await clipboardEncryptHistoryMigrate();
      await refreshClipStats();
      showToast(
        t("settings.clipboard.encryptDone", {
          items: r.report.encryptedItems,
          assets: r.assetsEncrypted,
          backup: r.backup.dir,
        }),
        { kind: "success" },
      );
    } catch (e) {
      showToast(t("settings.clipboard.encryptFailed", { error: errorMessage(e) }), {
        kind: "error",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function onClipCleanup() {    setBusyKey("clip-cleanup");
    try {
      const r = await clipboardCleanup();
      await refreshClipStats();
      showToast(
        t("settings.clipboard.cleanupDone", {
          items: r.items_deleted,
          groups: r.groups_closed,
          bytes: formatBytes(r.bytes_freed),
        }),
        { kind: "success" },
      );
    } catch (e) {
      showToast(t("settings.clipboard.cleanupFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function onClipProbe() {
    setBusyKey("clip-probe");
    try {
      const r = await clipboardProbe();
      if (r.readable) {
        showToast(
          t("settings.clipboard.probeReadable", {
            kind: kindLabel(r.kind ?? ""),
            bytes: formatBytes(r.bytes ?? 0),
            files: r.fileCount ? t("settings.clipboard.probeFiles", { count: r.fileCount }) : "",
          }),
          { kind: "success" },
        );
      } else {
        showToast(
          t("settings.clipboard.probeUnreadable", {
            reason: r.reason ?? t("settings.clipboard.unsupported"),
          }),
          { kind: "info" },
        );
      }
    } catch (e) {
      showToast(t("settings.clipboard.probeFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <SettingsPageLayout
      icon={Clipboard}
      title={t("settings.section.clipboard")}
      description={t("settings.section.clipboardDesc")}
      variant="list"
    >
      {dataLoadError && (
        <div className="setting-note error-text" role="alert">
          {t("settings.loadError", { error: dataLoadError })}
          <button type="button" className="btn sm" onClick={() => void loadData()}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {clipConfigError && (
        <div className="setting-row setting-row-block clip-config-error" role="alert">
          <strong>{t("settings.clipboard.configErrorTitle")}</strong>
          <span>{clipConfigError.message}</span>
          <span>{t("settings.clipboard.configErrorNote")}</span>
          <div className="clip-config-actions">
            <button
              className="btn sm"
              disabled={busyKey === "clip-repair"}
              onClick={() => void onRepairClipboard(true)}
            >
              {t("settings.clipboard.repairResume")}
            </button>
            <button
              className="btn sm"
              disabled={busyKey === "clip-repair"}
              onClick={() => void onRepairClipboard(false)}
            >
              {t("settings.clipboard.repairPause")}
            </button>
          </div>
        </div>
      )}
      {!clipConfigError && clipConfigOrigin === "legacy_upgrade_paused" && (
        <div className="setting-row setting-row-block" role="status">
          <strong>{t("settings.clipboard.legacyTitle")}</strong>
          <span>{t("settings.clipboard.legacyNote")}</span>
        </div>
      )}
      <div className="setting-row">
        <span>{t("settings.clipboard.enabled")}</span>
        <Switch
          checked={settings.clipboard_enabled}
          ariaLabel={t("settings.clipboard.enabled")}
          onChange={(v) => update({ clipboard_enabled: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.paused")}</span>
        <Switch
          checked={settings.clipboard_paused}
          ariaLabel={t("settings.clipboard.paused")}
          onChange={(v) => update({ clipboard_paused: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.images")}</span>
        <Switch
          checked={settings.clipboard_capture_images}
          ariaLabel={t("settings.clipboard.images")}
          onChange={(v) => update({ clipboard_capture_images: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.ocrAuto")}</span>
        {/* 后端采集热路径尚未实现自动 OCR：保持读取既有配置用于如实展示，
            但不提供可操作入口，避免用户打开一个实际不生效的开关。 */}
        <Switch
          checked={settings.clipboard_ocr_auto ?? false}
          disabled
          ariaLabel={t("settings.clipboard.ocrAuto")}
          onChange={(v) => update({ clipboard_ocr_auto: v })}
        />
      </div>
      <div className="setting-note">{t("settings.clipboard.ocrAutoNote")}</div>
      <div className="setting-row">
        <span>{t("settings.clipboard.files")}</span>
        <Switch
          checked={settings.clipboard_capture_files}
          ariaLabel={t("settings.clipboard.files")}
          onChange={(v) => update({ clipboard_capture_files: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.html")}</span>
        <Switch
          checked={settings.clipboard_capture_html}
          ariaLabel={t("settings.clipboard.html")}
          onChange={(v) => update({ clipboard_capture_html: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.autoGroup")}</span>
        <Switch
          checked={settings.clipboard_auto_group}
          ariaLabel={t("settings.clipboard.autoGroup")}
          onChange={(v) => update({ clipboard_auto_group: v })}
        />
      </div>
      <div className="setting-note">{t("settings.clipboard.autoGroupNote")}</div>
      <div className="setting-row">
        <span>{t("settings.clipboard.groupWindow")}</span>
        <NumberInput
          value={settings.clipboard_group_window_secs}
          min={5}
          max={600}
          ariaLabel={t("settings.clipboard.groupWindow")}
          onChange={(v) => update({ clipboard_group_window_secs: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.retentionDays")}</span>
        <NumberInput
          value={settings.clipboard_retention_days}
          min={1}
          max={3650}
          ariaLabel={t("settings.clipboard.retentionDays")}
          onChange={(v) => update({ clipboard_retention_days: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.maxItems")}</span>
        <NumberInput
          value={settings.clipboard_max_items}
          min={20}
          max={50000}
          ariaLabel={t("settings.clipboard.maxItems")}
          onChange={(v) => update({ clipboard_max_items: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.maxStorage")}</span>
        <NumberInput
          value={settings.clipboard_max_storage_mb}
          min={16}
          max={102400}
          ariaLabel={t("settings.clipboard.maxStorage")}
          onChange={(v) => update({ clipboard_max_storage_mb: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.pasteInterval")}</span>
        <NumberInput
          value={settings.clipboard_paste_interval_ms}
          min={100}
          max={5000}
          step={50}
          ariaLabel={t("settings.clipboard.pasteInterval")}
          onChange={(v) => update({ clipboard_paste_interval_ms: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.pasteIntervalHtml")}</span>
        <NumberInput
          value={settings.clipboard_paste_interval_html_ms}
          min={100}
          max={5000}
          step={50}
          ariaLabel={t("settings.clipboard.pasteIntervalHtml")}
          onChange={(v) => update({ clipboard_paste_interval_html_ms: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.pasteIntervalImage")}</span>
        <NumberInput
          value={settings.clipboard_paste_interval_image_ms}
          min={100}
          max={5000}
          step={50}
          ariaLabel={t("settings.clipboard.pasteIntervalImage")}
          onChange={(v) => update({ clipboard_paste_interval_image_ms: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.pasteIntervalFiles")}</span>
        <NumberInput
          value={settings.clipboard_paste_interval_files_ms}
          min={100}
          max={5000}
          step={50}
          ariaLabel={t("settings.clipboard.pasteIntervalFiles")}
          onChange={(v) => update({ clipboard_paste_interval_files_ms: v })}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.sensitiveFilter")}</span>
        <Switch
          checked={settings.clipboard_sensitive_filter}
          ariaLabel={t("settings.clipboard.sensitiveFilter")}
          onChange={(v) => update({ clipboard_sensitive_filter: v })}
        />
      </div>
      <div className="setting-note">{t("settings.clipboard.sensitiveNote")}</div>
      <div className="setting-row">
        <span>{t("settings.clipboard.encryptHistory")}</span>
        <Switch
          checked={Boolean(settings.clipboard_encrypt_history)}
          ariaLabel={t("settings.clipboard.encryptHistory")}
          onChange={(v) => update({ clipboard_encrypt_history: v })}
        />
      </div>
      <div className="setting-note">{t("settings.clipboard.encryptNote")}</div>
      <div className="setting-row setting-row-block">
        <span>{t("settings.clipboard.exclude")}</span>
        <textarea
          className="setting-textarea"
          rows={2}
          value={excludeApps}
          placeholder="keepass.exe, 1password.exe"
          aria-label={t("settings.clipboard.excludeAria")}
          onChange={(e) => setExcludeApps(e.target.value)}
          onBlur={() => {
            if (excludeApps !== settings.clipboard_exclude_apps) {
              update({ clipboard_exclude_apps: excludeApps }).catch((e) =>
                showToast(t("settings.clipboard.excludeSaveFailed", { error: String(e) }), {
                  kind: "error",
                }),
              );
            }
          }}
        />
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.usage")}</span>
        <span className="setting-value">
          {clipStats
            ? t("settings.clipboard.usageValue", {
                items: clipStats.items,
                groups: clipStats.groups,
                used: formatBytes(clipStats.asset_bytes),
                max: formatBytes(clipStats.max_storage_bytes),
              })
            : t("settings.clipboard.reading")}
        </span>
      </div>
      <div className="setting-row">
        <span>{t("settings.clipboard.maintenance")}</span>
        <div className="btn-row">
          <button className="btn sm" onClick={refreshClipStats} disabled={busyKey !== null}>
            <RefreshCw size={11} /> {t("settings.clipboard.refreshStats")}
          </button>
          <button className="btn sm" onClick={onClipProbe} disabled={busyKey !== null}>
            {t("settings.clipboard.probe")}
          </button>
          <button className="btn sm" onClick={onClipCleanup} disabled={busyKey !== null}>
            {busyKey === "clip-cleanup" ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />}{" "}
            {t("settings.clipboard.cleanup")}
          </button>
          <button
            className="btn sm"
            onClick={onEncryptHistory}
            disabled={busyKey !== null || !settings.clipboard_encrypt_history}
          >
            {busyKey === "clip-encrypt" ? <RefreshCw size={11} className="spin" /> : null}
            {t("settings.clipboard.encryptExisting")}
          </button>
        </div>
      </div>
      <div className="setting-note">{t("settings.clipboard.cleanupNote")}</div>
      <div className="setting-note">{t("settings.clipboard.encryptExistingNote")}</div>
    </SettingsPageLayout>
  );
}
