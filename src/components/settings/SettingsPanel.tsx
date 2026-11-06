//! 设置面板：外观与主题 / 窗口与快捷键 / 通知 / Agent 接入 / 数据与备份 / 开发者选项。
//! 统一控件风格；高级选项（Agent 接入细节、开发者工具）默认折叠。

import { useCallback, useEffect, useRef, useState } from "react";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Palette, AppWindow, Bell, Database, FlaskConical, Copy, Eye, EyeOff,
  RefreshCw, Navigation, Clipboard, Trash2, Gauge, Layers, Compass, AlertTriangle, HardDrive, LifeBuoy,
} from "lucide-react";
import AgentIcon, { type IconComponent } from "../ui/AgentIcon";
import { CollapsibleSection } from "../ui";
import {
  auditTestData,
  backupNow,
  clipboardCleanup,
  clipboardProbe,
  clipboardRepairConfig,
  clipboardStats,
  clipboardStatus,
  exportData,
  getAgentInboxDir,
  importData,
  inspectBackup,
  listBackups,
  setAutostart,
  setHotkeysEnabled,
  performanceDiagnostics,
  agentRetentionRun,
  agentInboxRetry,
  type AuditTableCounts,
  type BackupEntry,
  type ClipboardConfigError,
  type ClipboardStats,
  type PerformanceDiagnostics,
  type TestDataAudit,
} from "../../lib/bridge";
import { getAgentRefreshMetrics } from "../../store/useAgentsStore";
import { formatBytes, kindLabel } from "../../lib/clipboardUi";
import { formatLocalStamp } from "../../lib/format";
import { useSettingsStore } from "../../store/useSettingsStore";
import {
  VISUAL_PRESETS,
  resolveVisualPreset,
} from "../../lib/theme";
import { useUiStore } from "../../store/useUiStore";
import { errorMessage } from "../../lib/errors";
import { reportError } from "../../lib/errorReport";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { copyText } from "../../lib/clipboard";
import MockControls from "../agents/MockControls";
import AudioSettings from "./AudioSettings";
import ResourceCleanupSection from "./ResourceCleanupSection";
import ReopenOnboardingButton from "../onboarding/ReopenOnboardingButton";
import McpAccessSection from "./McpAccessSection";
import ContextHelpButton from "../help/ContextHelpButton";
import AppManagement from "./AppManagement";
import AppPicker from "../navigation/AppPicker";
import { NumberInput, Select, Switch } from "../ui";
import { ConfirmDialog } from "../ui/Dialog";
import HotkeysSection from "./hotkeys/HotkeysSection";
import NavigationVisibilitySection from "./NavigationVisibilitySection";
import LanguageSetting from "../../i18n/LanguageSetting";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import {
  SETTINGS_SECTION_REVEAL_EVENT,
  consumeSettingsSectionReveal,
  isSettingsSectionId,
  persistSettingsSectionOpenState,
  readSettingsSectionOpenState,
  type SettingsSectionId,
  type SettingsSectionOpenState,
} from "../../lib/settingsSections";

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

/** 可折叠设置分组；展开状态由外层统一持有并持久化，禁止用中文标题作键。 */
function Section({
  sectionId,
  icon: Icon,
  title,
  description,
  open,
  onToggle,
  children,
}: {
  sectionId: SettingsSectionId;
  icon: IconComponent;
  title: string;
  description?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <CollapsibleSection
      id={`settings-${sectionId}`}
      className="settings-collapsible"
      icon={<Icon size={13} />}
      title={title}
      description={description}
      expanded={open}
      onExpandedChange={onToggle}
    >
      {children}
    </CollapsibleSection>
  );
}

export default function SettingsPanel() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const materialInfo = useSettingsStore((s) => s.materialInfo);
  const reapplyFromSystem = useSettingsStore((s) => s.reapplyFromSystem);
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  const setHelpReturnTab = useUiStore((s) => s.setHelpReturnTab);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [inboxDir, setInboxDir] = useState("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clipStats, setClipStats] = useState<ClipboardStats | null>(null);
  const [clipConfigError, setClipConfigError] = useState<ClipboardConfigError | null>(null);
  const [clipConfigOrigin, setClipConfigOrigin] = useState<string | null>(null);
  const [excludeApps, setExcludeApps] = useState("");
  const [diag, setDiag] = useState<PerformanceDiagnostics | null>(null);
  const [testAudit, setTestAudit] = useState<TestDataAudit | null>(null);
  // 危险操作的应用内确认（替代系统原生 confirm，统一液态玻璃视觉与键盘交互）
  const [pendingDanger, setPendingDanger] = useState<
    | { type: "audit-apply"; count: number }
    | { type: "import"; path: string; partial: boolean; detail: string }
    | null
  >(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  /** 恢复完成后仍可回看的配置告警（快捷键冲突/未知微件/语言回退等）。 */
  const [restoreWarnings, setRestoreWarnings] = useState<string[]>([]);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [pendingPicker, setPendingPicker] = useState(false);
  /** 设置页附属数据（备份/剪贴板统计/剪贴板状态）读取失败：显示真实错误与重试，不伪装成空数据 */
  const [dataLoadError, setDataLoadError] = useState<string | null>(null);
  const snapPhase = useEdgeSnapStore((s) => s.phase);

  // 首次无有效记录时全部折叠；切换立即写入本地偏好（不进业务配置/备份/IPC）。
  const [openSections, setOpenSections] = useState<SettingsSectionOpenState>(() =>
    readSettingsSectionOpenState(),
  );
  const setSectionOpen = useCallback((sectionId: SettingsSectionId, open: boolean) => {
    setOpenSections((prev) => {
      if (prev[sectionId] === open) return prev;
      const next = { ...prev, [sectionId]: open };
      persistSettingsSectionOpenState(next);
      return next;
    });
  }, []);
  const toggleSection = useCallback(
    (sectionId: SettingsSectionId) => {
      setOpenSections((prev) => {
        const next = { ...prev, [sectionId]: !prev[sectionId] };
        persistSettingsSectionOpenState(next);
        return next;
      });
    },
    [],
  );

  // 跨模块定位的 rAF 只在短生命周期内存在；卸载时统一取消，避免操作已卸载页面。
  const scrollRafs = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const id of scrollRafs.current) cancelAnimationFrame(id);
      scrollRafs.current = [];
    },
    [],
  );

  // 工具面板「应用」页的一次性配置意图（消费后立即清除，避免反复自动弹出）。
  const appConfig = useUiStore((s) => s.appConfig);
  const clearAppConfig = useUiStore((s) => s.clearAppConfig);
  useEffect(() => {
    if (!appConfig) return;
    const kind = appConfig.kind;
    clearAppConfig();
    if (kind === "picker") {
      // 胶囊仍处于 Win32 区域裁剪态时先挂起，等解除停靠进入 free 再挂载选择器，
      // 避免大型模态被裁掉。
      setPendingPicker(true);
      return;
    }
    // 管理意图：目标分组原为折叠时先展开，等展开后的 DOM 提交再滚动定位；
    // 否则折叠状态下 `.app-management` 未渲染，scrollIntoView 会静默失效。
    setSectionOpen("apps", true);
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(() => {
        document
          .querySelector('[data-collapsible-section="settings-apps"]')
          ?.scrollIntoView({ block: "start" });
      });
      scrollRafs.current.push(second);
    });
    scrollRafs.current.push(first);
  }, [appConfig, clearAppConfig, setSectionOpen]);

  useEffect(() => {
    if (!pendingPicker || snapPhase !== "free") return;
    setPendingPicker(false);
    setAppPickerOpen(true);
  }, [pendingPicker, snapPhase]);

  // 「更多」菜单里的「自定义导航」：展开目标分区并在 DOM 提交后滚动定位。
  // 设置页尚未挂载时由 sessionStorage 意图兜底；已挂载时直接走事件。
  useEffect(() => {
    const revealSection = (sectionId: SettingsSectionId) => {
      setSectionOpen(sectionId, true);
      const first = requestAnimationFrame(() => {
        const second = requestAnimationFrame(() => {
          const target = document.querySelector(`[data-collapsible-section="settings-${sectionId}"]`);
          // jsdom / 老 WebView 可能没有 scrollIntoView，缺失时只展开不滚动。
          if (target && typeof target.scrollIntoView === "function") {
            target.scrollIntoView({ block: "start" });
          }
        });
        scrollRafs.current.push(second);
      });
      scrollRafs.current.push(first);
    };
    const pending = consumeSettingsSectionReveal();
    if (pending) revealSection(pending);
    const onReveal = (event: Event) => {
      // 事件路径也消费一次性意图，避免下次重新挂载时重复滚动。
      consumeSettingsSectionReveal();
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string" && isSettingsSectionId(id)) revealSection(id);
    };
    window.addEventListener(SETTINGS_SECTION_REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(SETTINGS_SECTION_REVEAL_EVENT, onReveal);
  }, [setSectionOpen]);

  const loadPanelData = useCallback(async () => {
    setDataLoadError(null);
    const [backupResult, statsResult, statusResult] = await Promise.allSettled([
      listBackups(),
      clipboardStats(),
      clipboardStatus(),
    ]);
    // 每项独立落地：一项失败不覆盖其他项，也不把失败清成空数据
    if (backupResult.status === "fulfilled") setBackups(backupResult.value);
    if (statsResult.status === "fulfilled") setClipStats(statsResult.value);
    if (statusResult.status === "fulfilled") {
      setClipConfigError(statusResult.value.configError ?? null);
      setClipConfigOrigin(statusResult.value.configOrigin ?? null);
    }
    const failure = [backupResult, statsResult, statusResult].find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failure) setDataLoadError(errorMessage(failure.reason));
  }, []);

  useEffect(() => {
    void loadPanelData();
  }, [loadPanelData]);

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

  useEffect(() => {
    if (settings) setExcludeApps(settings.clipboard_exclude_apps);
  }, [settings?.clipboard_exclude_apps]);

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

  async function refreshClipStats() {
    try {
      setClipStats(await clipboardStats());
    } catch {
      // 统计失败不影响设置读写
    }
  }

  async function onClipCleanup() {
    setBusyKey("clip-cleanup");
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

  if (!settings) return <div className="empty-hint">{t("settings.loading")}</div>;

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

  async function onCopyInbox() {
    await withBusy("inbox", async () => {
      const dir = await getAgentInboxDir();
      setInboxDir(dir);
      const ok = await copyText(dir);
      showToast(
        ok
          ? t("settings.agent.copied", { value: dir })
          : t("settings.agent.dir", { value: dir }),
        { kind: ok ? "success" : "info" },
      );
    });
  }

  async function onCopyToken() {
    await withBusy("token", async () => {
      const token = useSettingsStore.getState().settings?.http_token ?? "";
      const ok = await copyText(token);
      showToast(
        ok ? t("settings.agent.tokenCopied") : t("settings.agent.copyFailed"),
        { kind: ok ? "success" : "error" },
      );
    });
  }

  const glassDowngraded =
    settings.material === "glass" && materialInfo?.resolved === "solid";
  const pipe = diag?.pipeline;
  const inboxStats = diag?.file_drop;
  const retention = diag?.retention;
  const frontendMetrics = getAgentRefreshMetrics();

  // 添加应用改为内容区子页面：替换设置内容，不叠覆盖式大 Modal；
  // 组件保持挂载，返回后各设置项状态不丢失。
  if (appPickerOpen) {
    return <AppPicker standalone variant="page" onClose={() => setAppPickerOpen(false)} />;
  }

  return (
    <div className="settings-panel">
      {dataLoadError && (
        <div className="setting-note error-text" role="alert">
          {t("settings.loadError", { error: dataLoadError })}
          <button type="button" className="btn sm" onClick={() => void loadPanelData()}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <Section
        sectionId="appearance"
        icon={Palette}
        title={t("settings.section.appearance")}
        open={openSections.appearance}
        onToggle={() => toggleSection("appearance")}
      >
        {/* v0.6：视觉预设（设计语言）与明暗/材质正交，切换即时生效且不影响业务状态 */}
        <div className="setting-row column">
          <span>{t("settings.appearance.preset")}</span>
          <div className="preset-picker" role="radiogroup" aria-label={t("settings.appearance.preset")}>
            {VISUAL_PRESETS.map((id) => {
              const active = resolveVisualPreset(settings.visual_preset) === id;
              const presetLabels =
                id === "frosted"
                  ? {
                      name: t("settings.preset.frosted.name"),
                      tagline: t("settings.preset.frosted.tagline"),
                    }
                  : {
                      name: t("settings.preset.dreamGradient.name"),
                      tagline: t("settings.preset.dreamGradient.tagline"),
                    };
              return (
                <button
                  key={id}
                  role="radio"
                  aria-checked={active}
                  className={`preset-card preset-${id} ${active ? "active" : ""}`}
                  onClick={() => update({ visual_preset: id })}
                  title={presetLabels.tagline}
                >
                  <span className="preset-preview" aria-hidden="true">
                    <span className="pp-rail" />
                    <span className="pp-body">
                      <span className="pp-card c1" />
                      <span className="pp-card c2" />
                      <span className="pp-card c3" />
                      <span className="pp-row" />
                    </span>
                  </span>
                  <span className="preset-meta">
                    <strong>{presetLabels.name}</strong>
                    <em>{presetLabels.tagline}</em>
                  </span>
                  <span className="preset-radio" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
        <div className="setting-row">
          <span>{t("settings.appearance.color")}</span>
          <Select
            ariaLabel={t("settings.appearance.color")}
            size="sm"
            triggerClassName="settings-select-trigger"
            value={settings.theme}
            options={[
              { value: "system", label: t("settings.appearance.theme.system") },
              { value: "light", label: t("settings.appearance.theme.light") },
              { value: "dark", label: t("settings.appearance.theme.dark") },
            ]}
            onChange={(v) => update({ theme: v as never })}
          />
        </div>
        {/* 清透预设已下线，clear_foreground 仅保留键兼容、不再读取。 */}
        <div className="setting-row">
          <span>{t("settings.appearance.material")}</span>
          <Select
            ariaLabel={t("settings.appearance.material")}
            size="sm"
            triggerClassName="settings-select-trigger"
            value={settings.material}
            options={[
              { value: "glass", label: t("settings.appearance.material.glass") },
              { value: "solid", label: t("settings.appearance.material.solid") },
            ]}
            onChange={(v) => update({ material: v as never })}
          />
        </div>
        <LanguageSetting />
        <div className="setting-note">
          {settings.material === "glass" ? (
            materialInfo?.materialError ? (
              // 失败原因与「系统不支持」区分：失败是可通过重试恢复的
              <>{t("settings.appearance.materialFailed", { error: materialInfo.materialError })}
                <button type="button" className="btn sm" onClick={() => reapplyFromSystem()}>
                  {t("settings.appearance.reapply")}
                </button>
              </>
            ) : glassDowngraded ? (
              <>{t("settings.appearance.glassDowngraded", {
                version: materialInfo?.osVersion || t("settings.appearance.versionUnknown"),
              })}</>
            ) : materialInfo?.applied ? (
              materialInfo.effect === "css" ? (
                <>{t("settings.appearance.cssGlass")}</>
              ) : (
                <>{t("settings.appearance.nativeGlass", { effect: materialInfo.effect })}</>
              )
            ) : (
              <>{t("settings.appearance.probing")}</>
            )
          ) : (
            <>{t("settings.appearance.opaque")}</>
          )}
        </div>
      </Section>

      <Section
        sectionId="navigation"
        icon={Compass}
        title={t("settings.section.navigation")}
        description={t("settings.section.navigationDesc")}
        open={openSections.navigation}
        onToggle={() => toggleSection("navigation")}
      >
        <NavigationVisibilitySection />
      </Section>

      <Section
        sectionId="window-hotkeys"
        icon={AppWindow}
        title={t("settings.section.windowHotkeys")}
        open={openSections["window-hotkeys"]}
        onToggle={() => toggleSection("window-hotkeys")}
      >
        <div className="setting-row">
          <span>{t("settings.window.snap")}</span>
          <Switch
            checked={settings.snap_enabled}
            ariaLabel={t("settings.window.snap")}
            onChange={(v) => update({ snap_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.window.snapMode")}</span>
          <Select
            ariaLabel={t("settings.window.snapMode")}
            size="sm"
            triggerClassName="settings-select-trigger"
            disabled={!settings.snap_enabled}
            value={settings.snap_display_mode === "full" ? "full" : "capsule"}
            options={[
              { value: "capsule", label: t("settings.window.snapMode.capsule") },
              { value: "full", label: t("settings.window.snapMode.full") },
            ]}
            onChange={(v) => update({ snap_display_mode: v as "capsule" | "full" })}
          />
        </div>
        <div className="setting-note">{t("settings.window.snapNote")}</div>
        <div className="setting-row">
          <span>{t("settings.window.autostart")}</span>
          <Switch
            checked={settings.autostart}
            disabled={busyKey === "autostart"}
            ariaLabel={t("settings.window.autostart")}
            onChange={(v) => withBusy("autostart", async () => {
              await setAutostart(v);
              await useSettingsStore.getState().load();
            })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.window.hotkeySwitch")}</span>
          <Switch
            checked={settings.hotkey_enabled}
            disabled={busyKey === "hotkey"}
            ariaLabel={t("settings.window.hotkeySwitch")}
            onChange={(v) => withBusy("hotkey", async () => {
              await setHotkeysEnabled(v);
              await useSettingsStore.getState().load();
            })}
          />
        </div>
        <HotkeysSection />
      </Section>

      <Section
        sectionId="features"
        icon={Layers}
        title={t("settings.section.features")}
        description={t("settings.section.featuresDesc")}
        open={openSections.features}
        onToggle={() => toggleSection("features")}
      >
        <div className="setting-row">
          <span>{t("settings.features.workspace")}</span>
          <Switch
            checked={settings.workspace_enabled}
            ariaLabel={t("settings.features.workspace")}
            onChange={(v) => update({ workspace_enabled: v })}
          />
        </div>
        <div className="setting-note">{t("settings.features.workspaceNote")}</div>
        <div className="setting-row">
          <span>{t("settings.features.actions")}</span>
          <Switch
            checked={settings.actions_enabled}
            ariaLabel={t("settings.features.actions")}
            onChange={(v) => update({ actions_enabled: v })}
          />
        </div>
        <div className="setting-note">{t("settings.features.actionsNote")}</div>
        <div className="setting-note">{t("settings.features.clipboardNote")}</div>
      </Section>

      <Section
        sectionId="apps"
        icon={Navigation}
        title={t("settings.section.apps")}
        description={t("settings.section.appsDesc")}
        open={openSections.apps}
        onToggle={() => toggleSection("apps")}
      >
        <AppManagement onRequestAdd={() => setAppPickerOpen(true)} />
      </Section>

      <Section
        sectionId="clipboard"
        icon={Clipboard}
        title={t("settings.section.clipboard")}
        description={t("settings.section.clipboardDesc")}
        open={openSections.clipboard}
        onToggle={() => toggleSection("clipboard")}
      >
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
          </div>
        </div>
        <div className="setting-note">{t("settings.clipboard.cleanupNote")}</div>
      </Section>

      <Section
        sectionId="notifications"
        icon={Bell}
        title={t("settings.section.notifications")}
        open={openSections.notifications}
        onToggle={() => toggleSection("notifications")}
      >
        <div className="setting-row">
          <span>{t("settings.notifications.reminder")}</span>
          <Switch
            checked={settings.notify_reminder}
            ariaLabel={t("settings.notifications.reminder")}
            onChange={(v) => update({ notify_reminder: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.notifications.agent")}</span>
          <Switch
            checked={settings.notify_agent}
            ariaLabel={t("settings.notifications.agent")}
            onChange={(v) => update({ notify_agent: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.notifications.muted")}</span>
          <Switch
            checked={settings.notify_muted}
            ariaLabel={t("settings.notifications.muted")}
            onChange={(v) => update({ notify_muted: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.notifications.aggregate")}</span>
          <Switch
            checked={settings.notify_done_aggregate}
            ariaLabel={t("settings.notifications.aggregate")}
            onChange={(v) => update({ notify_done_aggregate: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.notifications.rateWindow")}</span>
          <div className="btn-row">
            <NumberInput
              size="sm"
              min={10}
              max={3600}
              value={settings.notify_rate_window_secs}
              ariaLabel={t("settings.notifications.rateWindowAria")}
              onChange={(v) => update({ notify_rate_window_secs: v })}
            />
            <NumberInput
              size="sm"
              min={1}
              max={20}
              value={settings.notify_burst_max}
              ariaLabel={t("settings.notifications.burstAria")}
              onChange={(v) => update({ notify_burst_max: v })}
            />
          </div>
        </div>
        <div className="setting-note">{t("settings.notifications.note")}</div>
        <div className="setting-row">
          <span>{t("settings.notifications.overdueGrace")}</span>
          <NumberInput
            value={settings.overdue_grace_hours}
            min={1}
            max={168}
            ariaLabel={t("settings.notifications.overdueGrace")}
            onChange={(v) => update({ overdue_grace_hours: v })}
          />
        </div>
      </Section>

      <AudioSettings openSections={openSections} onToggle={toggleSection} />

      <Section
        sectionId="resource-cleanup"
        icon={HardDrive}
        title={t("settings.section.resourceCleanup")}
        description={t("settings.section.resourceCleanupDesc")}
        open={openSections["resource-cleanup"]}
        onToggle={() => toggleSection("resource-cleanup")}
      >
        <ResourceCleanupSection />
      </Section>

      <Section
        sectionId="help"
        icon={LifeBuoy}
        title={t("settings.section.help")}
        open={openSections.help}
        onToggle={() => toggleSection("help")}
      >
        <div className="setting-row">
          <span>{t("settings.help.center")}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => setTab("help", { after: () => setHelpReturnTab("settings") })}
          >
            {t("settings.help.open")}
          </button>
        </div>
        <div className="setting-row">
          <span>{t("settings.help.onboarding")}</span>
          <ReopenOnboardingButton />
        </div>
      </Section>

      <Section
        sectionId="agent"
        icon={AgentIcon}
        title={t("settings.section.agent")}
        description={t("settings.section.agentDesc")}
        open={openSections.agent}
        onToggle={() => toggleSection("agent")}
      >
        <div className="setting-row">
          <span>{t("settings.agent.http")}</span>
          <Switch
            checked={settings.http_enabled}
            ariaLabel={t("settings.agent.http")}
            onChange={(v) => update({ http_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.port")}</span>
          <NumberInput
            value={settings.http_port}
            min={1024}
            max={65535}
            ariaLabel={t("settings.agent.port")}
            onChange={(v) => update({ http_port: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.token")}</span>
          <div className="token-row">
            <code className="token-box">
              {tokenRevealed ? settings.http_token : `${settings.http_token.slice(0, 4)}${"•".repeat(16)}`}
            </code>
            <button
              className="icon-btn sm"
              data-tip={tokenRevealed ? t("settings.agent.hide") : t("settings.agent.show")}
              aria-label={tokenRevealed ? t("settings.agent.hideToken") : t("settings.agent.showToken")}
              onClick={() => setTokenRevealed((v) => !v)}
            >
              {tokenRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button
              className="icon-btn sm"
              data-tip={t("settings.agent.copyToken")}
              aria-label={t("settings.agent.copyToken")}
              onClick={onCopyToken}
            >
              <Copy size={12} />
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.stale")}</span>
          <NumberInput
            value={settings.stale_run_minutes}
            min={1}
            max={120}
            ariaLabel={t("settings.agent.stale")}
            onChange={(v) => update({ stale_run_minutes: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.inboxDir")}</span>
          <div className="btn-row">
            {inboxDir && <code className="token-box">{inboxDir}</code>}
            <button className="btn sm" onClick={onCopyInbox} disabled={busyKey === "inbox"}>
              {busyKey === "inbox" ? t("settings.agent.fetching") : t("settings.agent.fetchCopy")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.mcpServer")}</span>
          <div className="btn-row">
            <Switch
              checked={settings.mcp_server_enabled}
              ariaLabel={t("settings.agent.mcpServer")}
              onChange={(v) => update({ mcp_server_enabled: v })}
            />
            <ContextHelpButton articleId="help.agents.mcp-authorization" />
          </div>
        </div>
        <McpAccessSection />
      </Section>

      <Section
        sectionId="data"
        icon={Database}
        title={t("settings.section.data")}
        open={openSections.data}
        onToggle={() => toggleSection("data")}
      >
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
        <div className="setting-row">
          <span>{t("settings.data.actions")}</span>
          <div className="btn-row">
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
        {backups.length > 0 && (
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
                    <span className="backup-record-name" title={b.name}>
                      {b.name}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="setting-row">
          <span>{t("settings.data.audit")}</span>
          <div className="btn-row">
            <button className="btn sm" onClick={onAuditPreview} disabled={busyKey === "audit-preview"}>
              {busyKey === "audit-preview" ? <RefreshCw size={12} className="spin" /> : null}{" "}
              {t("settings.data.auditPreview")}
            </button>
            <button className="btn sm" onClick={onAuditApply} disabled={busyKey === "audit-apply"}>
              {busyKey === "audit-apply" ? <RefreshCw size={12} className="spin" /> : null}{" "}
              {t("settings.data.auditApply")}
            </button>
          </div>
        </div>
        {testAudit && (
          <div className="backup-list">
            <div className="backup-item">
              <span>{t("settings.data.provable")}</span>
              <span>
                {t("settings.data.provableValue", {
                  count: sumAuditCounts(testAudit.provable_total),
                  detail:
                    testAudit.provable
                      .map((p) => `${p.origin} ${sumAuditCounts(p.counts)}`)
                      .join(" / ") || t("settings.data.none"),
                })}
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.data.real")}</span>
              <span>
                {t("settings.data.realValue", {
                  events: testAudit.real.events,
                  sessions: testAudit.real.sessions,
                  runs: testAudit.real.runs,
                  notifications: testAudit.real.notifications,
                })}
              </span>
            </div>
            {testAudit.deleted && (
              <div className="backup-item">
                <span>{t("settings.data.deleted")}</span>
                <span>
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
              <div className="backup-item">
                <span>{t("settings.data.snapshot")}</span>
                <span style={{ wordBreak: "break-all" }}>{testAudit.backup_path}</span>
              </div>
            )}
            {testAudit.uncertain.length > 0 && (
              <div className="backup-item">
                <span>{t("settings.data.uncertain")}</span>
                <span>{testAudit.uncertain.map((u) => `${u.kind} ${u.count}`).join(" · ")}</span>
              </div>
            )}
            {testAudit.notes.map((n) => (
              <div className="setting-note" key={n}>{n}</div>
            ))}
          </div>
        )}
        <div className="setting-note">{t("settings.data.auditNote")}</div>
      </Section>

      <Section
        sectionId="diagnostics"
        icon={Gauge}
        title={t("settings.section.diagnostics")}
        description={t("settings.section.diagnosticsDesc")}
        open={openSections.diagnostics}
        onToggle={() => toggleSection("diagnostics")}
      >
        <div className="setting-row">
          <span>{t("settings.diagnostics.enabled")}</span>
          <Switch
            checked={settings.perf_diagnostics_enabled}
            ariaLabel={t("settings.diagnostics.enabled")}
            onChange={(v) => update({ perf_diagnostics_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.diagnostics.snapshot")}</span>
          <div className="btn-row">
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
        </div>
        {diag?.enabled && pipe && (
          <div className="backup-list">
            <div className="backup-item">
              <span>{t("settings.diagnostics.queue")}</span>
              <span>
                {t("settings.diagnostics.queueValue", {
                  depth: pipe.queue_depth_events,
                  capacity: pipe.queue_capacity,
                  merged: pipe.events_merged,
                  sampled: pipe.events_sampled,
                  rejected: pipe.overload_rejects,
                })}
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.diagnostics.batches")}</span>
              <span>
                {t("settings.diagnostics.batchesValue", {
                  processed: pipe.events_processed,
                  received: pipe.events_received,
                  batches: pipe.batches,
                  buffer: pipe.merge_buffer,
                })}
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.diagnostics.ingest")}</span>
              <span>
                p50 {pipe.ingest_latency.p50_ms}ms · p95 {pipe.ingest_latency.p95_ms}ms · p99{" "}
                {pipe.ingest_latency.p99_ms}ms
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.diagnostics.write")}</span>
              <span>
                p50 {pipe.db_write_latency.p50_ms}ms · p95 {pipe.db_write_latency.p95_ms}ms ·{" "}
                {pipe.commit_failures}
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.diagnostics.sqlite")}</span>
              <span>
                {t("settings.diagnostics.sqliteValue", {
                  avg: diag.sqlite?.avg_ms ?? "-",
                  calls: diag.sqlite?.calls ?? 0,
                  slow: diag.sqlite?.slow_queries_100ms ?? 0,
                })}
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.diagnostics.fileDrop")}</span>
              <span>
                {t("settings.diagnostics.fileDropValue", {
                  pending: inboxStats?.pending_files ?? 0,
                  bytes: inboxStats?.pending_bytes ?? 0,
                  failed: inboxStats?.failed_files ?? 0,
                  age: inboxStats?.oldest_age_secs ?? 0,
                })}
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.diagnostics.events")}</span>
              <span>
                {t("settings.diagnostics.eventsValue", {
                  total: Number(retention?.total_rows ?? 0),
                  prunable: Number(retention?.prunable_rows ?? 0),
                  protected: Number(retention?.protected_rows ?? 0),
                })}
              </span>
            </div>
            <div className="backup-item">
              <span>{t("settings.diagnostics.frontend")}</span>
              <span>
                {t("settings.diagnostics.frontendValue", {
                  snapshots: frontendMetrics.snapshotRequests,
                  maxConcurrent: frontendMetrics.maxConcurrent,
                  coalesced: frontendMetrics.coalesced,
                  skipped: frontendMetrics.skippedHidden,
                })}
              </span>
            </div>
          </div>
        )}
        {diag && !diag.enabled && (
          <div className="setting-note">{t("settings.diagnostics.off")}</div>
        )}
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
      </Section>

      <Section
        sectionId="developer"
        icon={FlaskConical}
        title={t("settings.section.developer")}
        description={t("settings.section.developerDesc")}
        open={openSections.developer}
        onToggle={() => toggleSection("developer")}
      >
        <div className="setting-row">
          <span>{t("settings.developer.mock")}</span>
          <Switch
            checked={settings.mock_enabled}
            ariaLabel={t("settings.developer.mock")}
            onChange={(v) => update({ mock_enabled: v })}
          />
        </div>
        <div className="setting-note">{t("settings.developer.note")}</div>
        <MockControls />
      </Section>

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
    </div>
  );
}
