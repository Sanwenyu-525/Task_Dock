//! Android 虚拟屏 MVP（实验）。
//!
//! 只做四件事：选择 ADB 设备、选择应用、创建/关闭虚拟屏、显示连接状态。
//! 虚拟屏与输入全部由 scrcpy 的独立窗口提供，本组件不实现投屏画面。
import { useCallback, useEffect, useMemo, useState } from "react";
import { MonitorSmartphone, Play, RefreshCw, Square } from "lucide-react";

import {
  vdDevices,
  vdListApps,
  vdProbe,
  vdSessions,
  vdStart,
  vdStop,
  type VdApp,
  type VdDevice,
  type VdProbe,
  type VdSession,
} from "../../lib/bridge";
import { useLocale } from "../../hooks/useLocale";
import { CollapsibleSection, Combobox, Select } from "../ui";
import "./virtual-display.css";

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

export default function VirtualDisplaySection() {
  const { t } = useLocale();
  const [probe, setProbe] = useState<VdProbe | null>(null);
  const [devices, setDevices] = useState<VdDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [serial, setSerial] = useState("");
  const [apps, setApps] = useState<VdApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [packageName, setPackageName] = useState("");
  const [sessions, setSessions] = useState<VdSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await vdSessions());
    } catch {
      // 轮询失败不覆盖已有状态：下一轮会重试。
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await vdDevices();
      setDevices(list.devices);
      setDeviceError(list.error);
      // 保持用户选择；设备掉线时优先选直连（serial 不含空格的 IP:port），
      // mDNS 传输名会随无线调试端口变化且更易掉线，只作为兜底。
      setSerial((current) => {
        const stillOnline = list.devices.some(
          (device) => device.serial === current && device.state === "device",
        );
        if (stillOnline) return current;
        const online = list.devices.filter((device) => device.state === "device");
        const preferred = online.find((device) => !device.serial.includes(" ")) ?? online[0];
        return preferred?.serial ?? "";
      });
    } catch (err) {
      setDeviceError(toMessage(err));
    }
  }, []);

  // 页面打开时探测一次工具链；设备/会话按 3s 轮询（组件卸载即停止）。
  useEffect(() => {
    let cancelled = false;
    void vdProbe()
      .then((next) => {
        if (!cancelled) setProbe(next);
      })
      .catch((err) => {
        if (!cancelled) setProbe(null);
        if (!cancelled) setError(toMessage(err));
      });
    void refreshDevices();
    void refreshSessions();
    const timer = window.setInterval(() => {
      void refreshDevices();
      void refreshSessions();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshDevices, refreshSessions]);

  // 设备切换后加载包名列表（失败只提示，不阻塞创建按钮）。
  useEffect(() => {
    if (!serial) {
      setApps([]);
      setPackageName("");
      return;
    }
    let cancelled = false;
    setAppsLoading(true);
    setError(null);
    void vdListApps(serial)
      .then((list) => {
        if (!cancelled) setApps(list);
      })
      .catch((err) => {
        if (!cancelled) setError(toMessage(err));
      })
      .finally(() => {
        if (!cancelled) setAppsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serial]);

  const deviceOptions = useMemo(
    () =>
      devices.map((device) => ({
        value: device.serial,
        label: `${device.model ?? device.serial}`,
        hint: device.state,
      })),
    [devices],
  );

  const appOptions = useMemo(
    () => apps.map((app) => ({ value: app.package, label: app.package })),
    [apps],
  );

  const online = devices.find((device) => device.serial === serial && device.state === "device");
  const canCreate = Boolean(online && packageName && !busy);

  const create = async () => {
    if (!serial || !packageName) return;
    setBusy(true);
    setError(null);
    try {
      await vdStart(serial, packageName);
      await refreshSessions();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const close = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await vdStop(id);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      await refreshSessions();
      setBusy(false);
    }
  };

  const toolchainMissing = probe !== null && (!probe.adb_path || !probe.scrcpy_path);

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
        <div className="setting-row">
          <span>{t("virtualDisplay.toolchain")}</span>
          <div className="vd-toolchain">
            <code className="vd-tool">
              adb {shortVersion(probe?.adb_version ?? null) ?? t("virtualDisplay.missing")}
            </code>
            <code className="vd-tool">
              scrcpy {shortVersion(probe?.scrcpy_version ?? null) ?? t("virtualDisplay.missing")}
            </code>
          </div>
        </div>
        {toolchainMissing ? (
          <div className="setting-note vd-note-warn">{t("virtualDisplay.errorHint")}</div>
        ) : null}

        <div className="setting-row">
          <span>{t("virtualDisplay.device")}</span>
          <div className="vd-control">
            <Select
              value={serial}
              options={deviceOptions}
              onChange={(value) => setSerial(value)}
              placeholder={t("virtualDisplay.noDevice")}
              ariaLabel={t("virtualDisplay.device")}
              size="sm"
              block
              disabled={deviceOptions.length === 0}
            />
          </div>
        </div>
        {deviceError ? <div className="setting-note vd-note-warn">{deviceError}</div> : null}

        <div className="setting-row">
          <span>{t("virtualDisplay.app")}</span>
          <div className="vd-control">
            <Combobox
              value={packageName}
              options={appOptions}
              onChange={(value) => setPackageName(value)}
              placeholder={appsLoading ? "…" : t("virtualDisplay.app")}
              searchPlaceholder={t("virtualDisplay.searchApp")}
              emptyText={t("virtualDisplay.noSessions")}
              ariaLabel={t("virtualDisplay.app")}
              size="sm"
              disabled={!serial || appsLoading}
            />
          </div>
        </div>
        <div className="setting-note">{t("virtualDisplay.appHint")}</div>

        <div className="setting-row">
          <span>{t("virtualDisplay.create")}</span>
          <div className="btn-row">
            <button
              className="btn sm"
              onClick={() => void create()}
              disabled={!canCreate}
            >
              <Play size={12} /> {t("virtualDisplay.create")}
            </button>
            <button
              className="icon-btn sm"
              data-tip={t("virtualDisplay.refresh")}
              aria-label={t("virtualDisplay.refresh")}
              onClick={() => {
                void refreshDevices();
                void refreshSessions();
              }}
              disabled={busy}
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        {error ? <div className="setting-note vd-note-error">{error}</div> : null}

        <div className="vd-sessions">
          <div className="vd-sessions-title">{t("virtualDisplay.sessions")}</div>
          {sessions.length ? (
            sessions.map((session) => (
              <div className="vd-session" key={session.id}>
                <span className="vd-dot" aria-hidden="true" />
                <div className="vd-session-main">
                  <span className="vd-session-package">{session.package}</span>
                  <span className="vd-session-meta">
                    {session.serial} · PID {session.pid}
                  </span>
                </div>
                <button
                  className="btn sm danger-ghost"
                  onClick={() => void close(session.id)}
                  disabled={busy}
                >
                  <Square size={12} /> {t("virtualDisplay.close")}
                </button>
              </div>
            ))
          ) : (
            <div className="setting-note">{t("virtualDisplay.noSessions")}</div>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
