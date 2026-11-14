//! Android 屏幕与控制（ADB + scrcpy）。
//!
//! 两种模式共用同一个 scrcpy 会话服务：
//! - 屏幕镜像：显示手机实体屏，电脑与手机共享画面；
//! - 独立虚拟屏：在手机上创建第二显示并启动指定应用。
//!
//! 本组件只做设备/模式/应用选择与会话状态展示；画面、输入法与键鼠全部由
//! scrcpy 独立窗口提供。所有按钮都连接真实后端命令，没有占位操作。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  AppWindow,
  Camera,
  ChevronRight,
  CircleAlert,
  Image as ImageIcon,
  Loader2,
  LocateFixed,
  Monitor,
  MonitorSmartphone,
  Play,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Square,
  Stethoscope,
  Usb,
  Wifi,
} from "lucide-react";

import {
  shelfAddPaths,
  vdDevices,
  vdDiagnostics,
  vdFocus,
  vdListApps,
  vdProbe,
  vdReconnect,
  vdScreenshot,
  vdScreenshotExport,
  vdSessions,
  vdStart,
  vdStop,
  type VdApp,
  type VdAppList,
  type VdDevice,
  type VdDiagnostics,
  type VdMode,
  type VdProbe,
  type VdScreenshot,
  type VdSession,
  type VdSessionStatus,
} from "../../lib/bridge";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n/messages";
import { CollapsibleSection, Combobox, Dialog, Select, StatusBadge, Switch } from "../ui";
import { ConfirmDialog } from "../ui/Dialog";
import { useUiStore } from "../../store/useUiStore";
import "./virtual-display.css";

const DEFAULT_SIZE = "1080x1920/384";
const SIZE_OPTIONS: { value: string; labelKey: MessageKey; hint: string }[] = [
  {
    value: "1080x1920/384",
    labelKey: "virtualDisplay.size.portrait",
    hint: "1080×1920 / 384",
  },
  {
    value: "1920x1080/384",
    labelKey: "virtualDisplay.size.landscape",
    hint: "1920×1080 / 384",
  },
];

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "操作失败";
}

/** 从 `adb version` / `scrcpy --version` 首行提取版本号，避免长行截断。 */
function shortVersion(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+(?:\.\d+)+/);
  return match ? match[0] : raw;
}

function formatDuration(startedAt: string, now: number): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || now < start) return null;
  const total = Math.floor((now - start) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function deviceStateKey(state: string): MessageKey {
  if (state === "device") return "virtualDisplay.state.device";
  if (state === "unauthorized") return "virtualDisplay.state.unauthorized";
  if (state === "offline") return "virtualDisplay.state.offline";
  if (state === "authorizing") return "virtualDisplay.state.authorizing";
  if (state === "connecting") return "virtualDisplay.state.connecting";
  return "virtualDisplay.state.unknown";
}

function deviceTone(state: string): "success" | "warning" | "danger" | "neutral" {
  if (state === "device") return "success";
  if (state === "unauthorized" || state === "offline") return "danger";
  if (state === "authorizing" || state === "connecting") return "warning";
  return "neutral";
}

function sessionStatusKey(status: VdSessionStatus): MessageKey {
  return `virtualDisplay.session.${status}`;
}

function stageKey(stage: string): MessageKey | null {
  if (stage === "process") return "virtualDisplay.session.stage.process";
  if (stage === "display") return "virtualDisplay.session.stage.display";
  if (stage === "app") return "virtualDisplay.session.stage.app";
  if (stage === "video") return "virtualDisplay.session.stage.video";
  if (stage === "ready") return "virtualDisplay.session.stage.ready";
  return null;
}

function isActiveSession(session: VdSession): boolean {
  return (
    session.status === "starting" ||
    session.status === "running" ||
    session.status === "stopping"
  );
}

function sessionTitle(session: VdSession, mirrorLabel: string, virtualLabel: string): string {
  if (session.mode === "mirror") return mirrorLabel;
  return session.app_label ?? session.package ?? virtualLabel;
}

function connectionLabelKey(connection: VdDevice["connection"]): MessageKey {
  if (connection === "usb") return "virtualDisplay.connection.usb";
  if (connection === "wifi") return "virtualDisplay.connection.wifi";
  if (connection === "mdns") return "virtualDisplay.connection.mdns";
  return "virtualDisplay.connection.other";
}

export default function VirtualDisplaySection() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);

  const [probe, setProbe] = useState<VdProbe | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [devices, setDevices] = useState<VdDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [adbOk, setAdbOk] = useState(true);
  const [serial, setSerial] = useState("");
  const selectedUidRef = useRef("");

  const [apps, setApps] = useState<VdApp[]>([]);
  const [appListMeta, setAppListMeta] = useState<{
    uid: string;
    launchableKnown: boolean;
  } | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [includeAll, setIncludeAll] = useState(false);

  const [mode, setMode] = useState<VdMode>("virtual");
  const [packageName, setPackageName] = useState("");
  const [manual, setManual] = useState(false);
  const [manualPackage, setManualPackage] = useState("");
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [clipboardSync, setClipboardSync] = useState(false);
  const [allowMulti, setAllowMulti] = useState(false);

  const [sessions, setSessions] = useState<VdSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshBusy, setRefreshBusy] = useState(false);

  const [shot, setShot] = useState<{ sessionId: string; data: VdScreenshot } | null>(null);
  const [shotBusy, setShotBusy] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diag, setDiag] = useState<VdDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnectBusy, setReconnectBusy] = useState(false);

  const mountedRef = useRef(true);
  const devicesInFlight = useRef(false);
  const sessionsInFlight = useRef(false);
  const appSeq = useRef(0);

  const refreshProbe = useCallback(async () => {
    setProbeBusy(true);
    try {
      const next = await vdProbe();
      if (mountedRef.current) setProbe(next);
    } catch (err) {
      if (mountedRef.current) setError(toMessage(err));
    } finally {
      if (mountedRef.current) setProbeBusy(false);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    if (devicesInFlight.current) return;
    devicesInFlight.current = true;
    try {
      const list = await vdDevices();
      if (!mountedRef.current) return;
      setDevices(list.devices);
      setAdbOk(list.adb_ok);
      setDeviceError(list.error);
      setSerial((current) => {
        const stillThere = list.devices.find(
          (device) => device.serial === current || device.transports.includes(current),
        );
        if (stillThere) {
          selectedUidRef.current = stillThere.uid;
          return stillThere.serial;
        }
        // transport 轮换（mDNS 端口变化）时按物理设备身份保持选择。
        const byUid = list.devices.find((device) => device.uid === selectedUidRef.current);
        if (byUid) return byUid.serial;
        const online = list.devices.filter((device) => device.state === "device");
        const preferred = online[0] ?? list.devices[0];
        selectedUidRef.current = preferred?.uid ?? "";
        return preferred?.serial ?? "";
      });
    } catch (err) {
      if (mountedRef.current) setDeviceError(toMessage(err));
    } finally {
      devicesInFlight.current = false;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (sessionsInFlight.current) return;
    sessionsInFlight.current = true;
    try {
      const list = await vdSessions();
      if (mountedRef.current) setSessions(list);
    } catch {
      // 轮询失败不覆盖已有状态：下一轮会重试。
    } finally {
      sessionsInFlight.current = false;
    }
  }, []);

  const selectedDevice = useMemo(
    () =>
      devices.find(
        (device) => device.serial === serial || device.transports.includes(serial),
      ) ?? null,
    [devices, serial],
  );
  const selectedUid = selectedDevice?.uid ?? "";

  const loadApps = useCallback(
    async (targetSerial: string, targetUid: string, wantAll: boolean) => {
      if (!targetSerial) {
        setApps([]);
        setAppsError(null);
        setAppListMeta(null);
        return;
      }
      const seq = ++appSeq.current;
      setAppsLoading(true);
      setAppsError(null);
      try {
        const list: VdAppList = await vdListApps(targetSerial, wantAll);
        if (!mountedRef.current || seq !== appSeq.current) return;
        // 设备切换/transport 轮换后丢弃过期响应，避免显示上一台设备的应用。
        if (list.serial !== targetSerial) return;
        if (targetUid && list.device_uid !== targetUid) return;
        setApps(list.apps);
        setAppListMeta({ uid: list.device_uid, launchableKnown: list.launchable_known });
        setPackageName((current) =>
          current && list.apps.some((app) => app.package === current) ? current : "",
        );
      } catch (err) {
        if (seq === appSeq.current) setAppsError(toMessage(err));
      } finally {
        if (seq === appSeq.current) setAppsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refreshProbe();
    void refreshDevices();
    void refreshSessions();
    return () => {
      mountedRef.current = false;
      appSeq.current += 1;
    };
  }, [refreshDevices, refreshProbe, refreshSessions]);

  // 运行中/启动中时加快轮询；页面隐藏时暂停，避免后台无意义请求。
  const fastPoll = sessions.some(
    (session) => session.status === "starting" || session.status === "stopping",
  );
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.hidden) return;
        void refreshDevices();
        void refreshSessions();
        setNow(Date.now());
      },
      fastPoll ? 1000 : 3000,
    );
    return () => window.clearInterval(timer);
  }, [fastPoll, refreshDevices, refreshSessions]);

  // 工具链缺失时低频重试：用户可能在页面打开期间安装/改路径。
  const toolchainMissing = probe !== null && (!probe.adb_path || !probe.scrcpy_path);
  useEffect(() => {
    if (!toolchainMissing) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshProbe();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [toolchainMissing, refreshProbe]);

  useEffect(() => {
    void loadApps(serial, selectedUid, includeAll);
  }, [serial, selectedUid, includeAll, loadApps]);

  useEffect(() => {
    if (selectedDevice) selectedUidRef.current = selectedDevice.uid;
  }, [selectedDevice]);

  const deviceOptions = useMemo(
    () =>
      devices.map((device) => ({
        value: device.serial,
        label: device.model ?? device.serial,
        hint: t(connectionLabelKey(device.connection)),
      })),
    [devices, t],
  );

  const appOptions = useMemo(
    () =>
      apps.map((app) => ({
        value: app.package,
        label: app.label ?? app.package,
        hint:
          app.launchable === false
            ? (app.reason ?? t("virtualDisplay.noLaunchable"))
            : app.label
              ? `${app.package} · ${t(
                  app.system ? "virtualDisplay.systemApp" : "virtualDisplay.userApp",
                )}`
              : t(app.system ? "virtualDisplay.systemApp" : "virtualDisplay.userApp"),
        disabled: app.launchable === false,
      })),
    [apps, t],
  );

  const sizeOptions = useMemo(
    () =>
      SIZE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
        hint: option.hint,
      })),
    [t],
  );

  const activeSessions = sessions.filter(isActiveSession);
  const sessionLimit = allowMulti ? 2 : 1;
  const limitReached = activeSessions.length >= sessionLimit;
  const online = selectedDevice?.state === "device";
  const toolchainReady = Boolean(probe?.adb_path && probe?.scrcpy_path);
  const virtualSupported = probe?.supports_new_display === true;
  const chosenPackage = (manual ? manualPackage : packageName).trim();
  const canCreate =
    !busy &&
    !limitReached &&
    online &&
    toolchainReady &&
    (mode === "mirror" || (virtualSupported && Boolean(chosenPackage)));

  const refreshAll = useCallback(async () => {
    setRefreshBusy(true);
    setError(null);
    try {
      await Promise.all([refreshProbe(), refreshDevices()]);
      await loadApps(serial, selectedUid, includeAll);
      await refreshSessions();
    } finally {
      window.setTimeout(() => {
        if (mountedRef.current) setRefreshBusy(false);
      }, 400);
    }
  }, [includeAll, loadApps, refreshDevices, refreshProbe, refreshSessions, selectedUid, serial]);

  const create = async () => {
    if (!canCreate || !serial) return;
    if (mode === "virtual") {
      if (!chosenPackage) {
        setError(t("virtualDisplay.app"));
        return;
      }
      if (!/^[A-Za-z0-9_][A-Za-z0-9._]*$/.test(chosenPackage)) {
        setError(t("virtualDisplay.manualInputHint"));
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const created = await vdStart({
        serial,
        mode,
        packageName: mode === "virtual" ? chosenPackage : null,
        size: mode === "virtual" ? size : null,
        clipboardSync,
        allowMulti,
      });
      if (!mountedRef.current) return;
      setSessions((previous) => [
        ...previous.filter((session) => session.id !== created.id),
        created,
      ]);
      await refreshSessions();
    } catch (err) {
      if (mountedRef.current) setError(toMessage(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const closeSession = async (session: VdSession) => {
    if (closingId) return;
    setClosingId(session.id);
    setError(null);
    try {
      await vdStop(session.id);
      await refreshSessions();
    } catch (err) {
      setError(`${t("virtualDisplay.session.closeFailed")}：${toMessage(err)}`);
    } finally {
      if (mountedRef.current) setClosingId(null);
    }
  };

  const focusSession = async (session: VdSession) => {
    try {
      const result = await vdFocus(session.id);
      if (!result.found) {
        showToast(t("virtualDisplay.session.focusNotFound"), { kind: "error" });
      } else if (!result.focused) {
        showToast(t("virtualDisplay.session.focusRestored"), { kind: "warning" });
      }
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    }
  };

  const captureSession = async (session: VdSession) => {
    if (shotBusy) return;
    setShotBusy(true);
    try {
      const data = await vdScreenshot(session.id);
      if (mountedRef.current) setShot({ sessionId: session.id, data });
    } catch (err) {
      showToast(`${t("virtualDisplay.screenshot.failed")}：${toMessage(err)}`, {
        kind: "error",
      });
    } finally {
      if (mountedRef.current) setShotBusy(false);
    }
  };

  const saveShotToShelf = async () => {
    if (!shot || shotBusy) return;
    setShotBusy(true);
    try {
      await shelfAddPaths([shot.data.path], "managed", "manual");
      showToast(t("virtualDisplay.screenshot.savedShelf"), { kind: "success" });
      if (mountedRef.current) setShot(null);
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setShotBusy(false);
    }
  };

  const saveShotAs = async () => {
    if (!shot || shotBusy) return;
    setShotBusy(true);
    try {
      const chosen = await saveFileDialog({
        defaultPath: `task-dock-screen-${shot.sessionId.slice(0, 8)}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!chosen) return;
      await vdScreenshotExport(shot.sessionId, chosen);
      showToast(t("virtualDisplay.screenshot.savedAs"), { kind: "success" });
      if (mountedRef.current) setShot(null);
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setShotBusy(false);
    }
  };

  const runDiagnostics = async () => {
    if (!serial || diagBusy) return;
    setDiagBusy(true);
    try {
      const result = await vdDiagnostics(serial);
      if (mountedRef.current) setDiag(result);
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setDiagBusy(false);
    }
  };

  const reconnect = async () => {
    if (!serial || reconnectBusy) return;
    setReconnectBusy(true);
    try {
      await vdReconnect(serial);
      showToast(t("virtualDisplay.reconnected"), { kind: "success" });
      if (mountedRef.current) {
        setReconnectOpen(false);
        setDiag(null);
      }
      await refreshDevices();
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setReconnectBusy(false);
    }
  };

  const modeLabel = t(
    mode === "mirror" ? "virtualDisplay.mode.mirror" : "virtualDisplay.mode.virtual",
  );
  const deviceName =
    selectedDevice?.model ?? selectedDevice?.serial ?? t("virtualDisplay.noDevice");

  return (
    <CollapsibleSection
      id="virtual-display"
      className="settings-collapsible"
      icon={<MonitorSmartphone size={13} />}
      title={t("virtualDisplay.title")}
      description={t("virtualDisplay.subtitle")}
      defaultExpanded
    >
      <div className="virtual-display">
        <div className="vd-device-card">
          <span
            className={`vd-device-icon${online ? " is-online" : ""}`}
            aria-hidden="true"
          >
            <Smartphone size={16} />
          </span>
          <div className="vd-device-main">
            <div className="vd-device-name" data-tip={selectedDevice?.model ?? undefined}>
              {deviceName}
            </div>
            <div className="vd-device-meta">
              {selectedDevice ? (
                <>
                  <span
                    className={`vd-status-dot is-${selectedDevice.state}`}
                    aria-hidden="true"
                  />
                  <span>{t(deviceStateKey(selectedDevice.state))}</span>
                  <span className="vd-meta-sep">·</span>
                  <span className="vd-conn-icon" aria-hidden="true">
                    {selectedDevice.connection === "usb" ? (
                      <Usb size={11} />
                    ) : (
                      <Wifi size={11} />
                    )}
                  </span>
                  <span>{t(connectionLabelKey(selectedDevice.connection))}</span>
                  {selectedDevice.transports.length > 1 ? (
                    <>
                      <span className="vd-meta-sep">·</span>
                      <span>
                        {t("virtualDisplay.transports", {
                          count: selectedDevice.transports.length,
                        })}
                      </span>
                    </>
                  ) : null}
                </>
              ) : (
                <span className="vd-device-hint">{t("virtualDisplay.noDeviceHint")}</span>
              )}
            </div>
          </div>
          {selectedDevice ? (
            <StatusBadge tone={deviceTone(selectedDevice.state)} size="sm">
              {t(deviceStateKey(selectedDevice.state))}
            </StatusBadge>
          ) : null}
          <button
            className="icon-btn sm"
            data-tip={t("virtualDisplay.refresh")}
            aria-label={t("virtualDisplay.refresh")}
            onClick={() => void refreshAll()}
            disabled={refreshBusy}
          >
            <RefreshCw size={12} className={refreshBusy ? "spin" : undefined} />
          </button>
        </div>

        {devices.length > 1 ? (
          <div className="setting-row vd-device-row">
            <span>{t("virtualDisplay.deviceList")}</span>
            <div className="vd-control">
              <Select
                value={serial}
                options={deviceOptions}
                onChange={(value) => setSerial(value)}
                placeholder={t("virtualDisplay.noDevice")}
                ariaLabel={t("virtualDisplay.deviceList")}
                size="sm"
                block
              />
            </div>
          </div>
        ) : null}

        <div className="vd-toolchain-row">
          <code className={`vd-tool${probe?.adb_path ? "" : " is-missing"}`}>
            adb {shortVersion(probe?.adb_version ?? null) ?? t("virtualDisplay.missing")}
          </code>
          <code className={`vd-tool${probe?.scrcpy_path ? "" : " is-missing"}`}>
            scrcpy {shortVersion(probe?.scrcpy_version ?? null) ?? t("virtualDisplay.missing")}
          </code>
          <button
            className="icon-btn sm"
            data-tip={t("virtualDisplay.recheck")}
            aria-label={t("virtualDisplay.recheck")}
            onClick={() => void refreshProbe()}
            disabled={probeBusy}
          >
            <RefreshCw size={11} className={probeBusy ? "spin" : undefined} />
          </button>
        </div>

        {probe && !probe.adb_path ? (
          <div className="setting-note vd-note-warn">{t("virtualDisplay.adbMissing")}</div>
        ) : null}
        {probe && !probe.scrcpy_path ? (
          <div className="setting-note vd-note-warn">{t("virtualDisplay.scrcpyMissing")}</div>
        ) : null}
        {probe && probe.scrcpy_path && !probe.supports_new_display ? (
          <div className="setting-note vd-note-warn">
            {t("virtualDisplay.versionUnsupported")}
          </div>
        ) : null}
        {!adbOk ? <div className="setting-note vd-note-warn">{t("virtualDisplay.adbMissing")}</div> : null}
        {deviceError ? <div className="setting-note vd-note-warn">{deviceError}</div> : null}

        <div className="vd-mode-block">
          <div className="vd-seg" role="group" aria-label={t("virtualDisplay.mode.label")}>
            <button
              type="button"
              className={`vd-seg-btn${mode === "mirror" ? " is-active" : ""}`}
              aria-pressed={mode === "mirror"}
              onClick={() => setMode("mirror")}
              disabled={busy}
            >
              <Monitor size={12} />
              {t("virtualDisplay.mode.mirror")}
            </button>
            <button
              type="button"
              className={`vd-seg-btn${mode === "virtual" ? " is-active" : ""}`}
              aria-pressed={mode === "virtual"}
              onClick={() => setMode("virtual")}
              disabled={busy || (probe !== null && !virtualSupported)}
            >
              <AppWindow size={12} />
              {t("virtualDisplay.mode.virtual")}
            </button>
          </div>
          <div className="vd-mode-note">
            {t(
              mode === "mirror"
                ? "virtualDisplay.mode.mirrorDesc"
                : "virtualDisplay.mode.virtualDesc",
            )}
          </div>
          {activeSessions.length > 0 ? (
            <div className="vd-inline-note">{t("virtualDisplay.mode.activeNote")}</div>
          ) : null}
        </div>

        {mode === "virtual" ? (
          <div className="vd-form">
            <div className="setting-row">
              <span>{t("virtualDisplay.app")}</span>
              <div className="vd-control">
                {manual ? (
                  <input
                    className="vd-input"
                    type="text"
                    value={manualPackage}
                    placeholder={t("virtualDisplay.packagePlaceholder")}
                    aria-label={t("virtualDisplay.packagePlaceholder")}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setManualPackage(event.target.value)}
                    disabled={busy}
                  />
                ) : (
                  <Combobox
                    value={packageName}
                    options={appOptions}
                    onChange={(value) => setPackageName(value)}
                    placeholder={
                      appsLoading
                        ? "…"
                        : serial
                          ? t("virtualDisplay.app")
                          : t("virtualDisplay.noDevice")
                    }
                    searchPlaceholder={t("virtualDisplay.searchApp")}
                    emptyText={t("virtualDisplay.noApps")}
                    ariaLabel={t("virtualDisplay.app")}
                    size="sm"
                    disabled={!serial || appsLoading}
                  />
                )}
              </div>
            </div>
            <div className="vd-form-links">
              <button
                type="button"
                className="vd-link"
                onClick={() => setManual((value) => !value)}
              >
                {t(manual ? "virtualDisplay.app" : "virtualDisplay.manualInput")}
              </button>
              {appListMeta?.launchableKnown ? (
                <button
                  type="button"
                  className="vd-link"
                  onClick={() => setIncludeAll((value) => !value)}
                >
                  {t(
                    includeAll
                      ? "virtualDisplay.hideAllApps"
                      : "virtualDisplay.showAllApps",
                  )}
                </button>
              ) : null}
              <button
                type="button"
                className="vd-link"
                onClick={() => void loadApps(serial, selectedUid, includeAll)}
                disabled={!serial || appsLoading}
              >
                {t("virtualDisplay.refreshApps")}
              </button>
            </div>
            <div className="setting-note">
              {t(
                manual
                  ? "virtualDisplay.manualInputHint"
                  : "virtualDisplay.appHint",
              )}
            </div>
            {appsError ? (
              <div className="setting-note vd-note-warn" role="alert">
                {appsError}
              </div>
            ) : null}

            <div className="setting-row">
              <span>{t("virtualDisplay.size")}</span>
              <div className="vd-control">
                <Select
                  value={size}
                  options={sizeOptions}
                  onChange={(value) => setSize(value)}
                  ariaLabel={t("virtualDisplay.size")}
                  size="sm"
                  block
                />
              </div>
            </div>
            <div className="vd-inline-note">{t("virtualDisplay.sizeHint")}</div>

            <div className="setting-row">
              <span>{t("virtualDisplay.clipboard")}</span>
              <Switch
                checked={clipboardSync}
                onChange={setClipboardSync}
                ariaLabel={t("virtualDisplay.clipboard")}
              />
            </div>
            <div className="vd-inline-note">{t("virtualDisplay.clipboardHint")}</div>
          </div>
        ) : null}

        <div className="vd-create-row">
          <button
            className="btn sm vd-create"
            onClick={() => void create()}
            disabled={!canCreate}
          >
            {busy ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
            {mode === "mirror"
              ? t("virtualDisplay.createMirror")
              : t("virtualDisplay.create")}
          </button>
          <span className="vd-create-mode">{modeLabel}</span>
          {limitReached ? (
            <span className="vd-inline-note">{t("virtualDisplay.limitReached")}</span>
          ) : null}
        </div>

        {error ? (
          <div className="setting-note vd-note-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="vd-sessions">
          <div className="vd-sessions-head">
            <span className="vd-sessions-title">{t("virtualDisplay.sessions")}</span>
            <span className="vd-count">{activeSessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="setting-note">{t("virtualDisplay.noSessions")}</div>
          ) : (
            sessions.map((session) => {
              const title = sessionTitle(
                session,
                t("virtualDisplay.mode.mirror"),
                t("virtualDisplay.mode.virtual"),
              );
              const active = isActiveSession(session);
              const duration =
                session.status === "running"
                  ? formatDuration(session.started_at, now)
                  : null;
              const stage = stageKey(session.stage);
              const statusLabel = t(sessionStatusKey(session.status));
              return (
                <div
                  className={`vd-session is-${session.status}`}
                  key={session.id}
                  data-status={session.status}
                >
                  <span className="vd-session-icon" aria-hidden="true">
                    {session.mode === "mirror" ? <Monitor size={14} /> : <AppWindow size={14} />}
                  </span>
                  <div className="vd-session-main">
                    <div className="vd-session-title-row">
                      <span className="vd-session-title" data-tip={title}>
                        {title}
                      </span>
                      <span className={`vd-session-mode is-${session.mode}`}>
                        {t(
                          session.mode === "mirror"
                            ? "virtualDisplay.mode.mirror"
                            : "virtualDisplay.mode.virtual",
                        )}
                      </span>
                    </div>
                    <div className="vd-session-meta">
                      <span
                        className={`vd-status-dot is-${session.status}`}
                        aria-hidden="true"
                      />
                      <span>{statusLabel}</span>
                      {active && stage ? (
                        <>
                          <span className="vd-meta-sep">·</span>
                          <span>{t(stage)}</span>
                        </>
                      ) : null}
                      {duration ? (
                        <>
                          <span className="vd-meta-sep">·</span>
                          <span>
                            {t("virtualDisplay.session.duration", { duration })}
                          </span>
                        </>
                      ) : null}
                      {session.device_model ? (
                        <>
                          <span className="vd-meta-sep">·</span>
                          <span className="vd-session-device">{session.device_model}</span>
                        </>
                      ) : null}
                    </div>
                    {session.package && session.app_label ? (
                      <div className="vd-session-sub" data-tip={session.package}>
                        {session.package}
                      </div>
                    ) : null}
                    {session.error ? (
                      <div className="vd-session-error" role="alert">
                        <CircleAlert size={11} /> {session.error}
                      </div>
                    ) : null}
                    {session.warning ? (
                      <div className="vd-session-warning">
                        <ShieldAlert size={11} /> {session.warning}
                      </div>
                    ) : null}
                  </div>
                  {active ? (
                    <div className="vd-session-actions">
                      <button
                        className="icon-btn sm"
                        data-tip={t("virtualDisplay.session.focus")}
                        aria-label={`${t("virtualDisplay.session.focus")} ${title}`}
                        onClick={() => void focusSession(session)}
                        disabled={session.status === "stopping"}
                      >
                        <LocateFixed size={13} />
                      </button>
                      <button
                        className="icon-btn sm"
                        data-tip={t("virtualDisplay.session.screenshot")}
                        aria-label={`${t("virtualDisplay.session.screenshot")} ${title}`}
                        onClick={() => void captureSession(session)}
                        disabled={session.status !== "running" || shotBusy}
                      >
                        <Camera size={13} />
                      </button>
                      <button
                        className="btn sm danger-ghost"
                        onClick={() => void closeSession(session)}
                        disabled={session.status === "stopping" || closingId === session.id}
                      >
                        {session.status === "stopping" ? (
                          <Loader2 size={12} className="spin" />
                        ) : (
                          <Square size={12} />
                        )}
                        {session.status === "stopping"
                          ? t("virtualDisplay.session.stopping")
                          : t("virtualDisplay.session.close")}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <div className="vd-advanced">
          <button
            type="button"
            className="vd-advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <ChevronRight
              size={12}
              className={advancedOpen ? "is-open" : undefined}
              aria-hidden="true"
            />
            {t("virtualDisplay.advanced")}
          </button>
          {advancedOpen ? (
            <div className="vd-advanced-body">
              <div className="setting-row">
                <span>{t("virtualDisplay.multi")}</span>
                <Switch
                  checked={allowMulti}
                  onChange={setAllowMulti}
                  ariaLabel={t("virtualDisplay.multi")}
                />
              </div>
              <div className="vd-inline-note">{t("virtualDisplay.multiHint")}</div>
              <div className="setting-row">
                <span>{t("virtualDisplay.diagnostics")}</span>
                <div className="btn-row">
                  <button
                    className="btn sm"
                    onClick={() => void runDiagnostics()}
                    disabled={!serial || diagBusy}
                  >
                    {diagBusy ? (
                      <Loader2 size={12} className="spin" />
                    ) : (
                      <Stethoscope size={12} />
                    )}
                    {diagBusy
                      ? t("virtualDisplay.diagnosticsRunning")
                      : t("virtualDisplay.diagnostics")}
                  </button>
                  {diag && diag.stale_displays.length > 0 ? (
                    <button
                      className="btn sm"
                      onClick={() => setReconnectOpen(true)}
                      disabled={reconnectBusy}
                    >
                      {t("virtualDisplay.reconnect")}
                    </button>
                  ) : null}
                </div>
              </div>
              {diag ? (
                <div
                  className={`setting-note${
                    diag.stale_displays.length ? " vd-note-warn" : ""
                  }`}
                >
                  {diag.note}
                  {diag.stale_displays.length ? (
                    <ul className="vd-diag-list">
                      {diag.stale_displays.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="setting-note vd-safety">{t("virtualDisplay.safetyNote")}</div>

        {shot ? (
          <Dialog
            open
            onClose={() => setShot(null)}
            title={t("virtualDisplay.screenshot.title")}
            size="lg"
            footer={
              <div className="btn-row vd-shot-actions">
                <button
                  className="btn sm"
                  onClick={() => void saveShotToShelf()}
                  disabled={shotBusy}
                >
                  <ImageIcon size={12} /> {t("virtualDisplay.screenshot.saveShelf")}
                </button>
                <button
                  className="btn sm"
                  onClick={() => void saveShotAs()}
                  disabled={shotBusy}
                >
                  {t("virtualDisplay.screenshot.saveAs")}
                </button>
                <button className="btn sm" onClick={() => setShot(null)}>
                  {t("virtualDisplay.screenshot.discard")}
                </button>
              </div>
            }
          >
            <div className="vd-shot-wrap">
              <img
                className="vd-shot-image"
                src={convertFileSrc(shot.data.path)}
                alt={t("virtualDisplay.screenshot.title")}
              />
            </div>
            <div className="setting-note">
              {t("virtualDisplay.screenshot.privacy")}
            </div>
          </Dialog>
        ) : null}

        <ConfirmDialog
          open={reconnectOpen}
          title={t("virtualDisplay.reconnectTitle")}
          detail={t("virtualDisplay.reconnectConfirm")}
          confirmLabel={t("virtualDisplay.reconnect")}
          danger
          busy={reconnectBusy}
          onConfirm={() => void reconnect()}
          onCancel={() => setReconnectOpen(false)}
        />
      </div>
    </CollapsibleSection>
  );
}
