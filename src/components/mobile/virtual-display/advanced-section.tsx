//! 高级设置与诊断：默认折叠，不与主操作争夺注意力。
//!
//! 只有真实检测到残留/异常时才显示恢复操作；危险操作（重连 ADB）由父组件弹确认框。
//! 完整设备序列号、UID、transport 只出现在这里，并提供复制。

import { ChevronRight, Copy, Loader2, Stethoscope } from "lucide-react";

import type { VdDevice, VdDiagnostics, VdProbe } from "../../../lib/bridge";
import { Select, Switch } from "../../ui";
import { deviceStateKey, shortVersion, type Translate } from "./format";

export interface AdvancedSectionProps {
  open: boolean;
  onToggle: () => void;
  allowMulti: boolean;
  onAllowMultiChange: (value: boolean) => void;
  clipboardSync: boolean;
  onClipboardChange: (value: boolean) => void;
  size: string;
  onSizeChange: (value: string) => void;
  sizeOptions: { value: string; label: string; hint?: string }[];
  probe: VdProbe | null;
  selectedDevice: VdDevice | null;
  diag: VdDiagnostics | null;
  diagBusy: boolean;
  reconnectBusy: boolean;
  t: Translate;
  onRunDiagnostics: () => void;
  onReconnect: () => void;
  onCopy: (text: string) => void;
}

export default function AdvancedSection({
  open,
  onToggle,
  allowMulti,
  onAllowMultiChange,
  clipboardSync,
  onClipboardChange,
  size,
  onSizeChange,
  sizeOptions,
  probe,
  selectedDevice,
  diag,
  diagBusy,
  reconnectBusy,
  t,
  onRunDiagnostics,
  onReconnect,
  onCopy,
}: AdvancedSectionProps) {
  const stale = diag?.stale_displays.length ?? 0;
  const owned = diag?.owned_sessions ?? 0;

  const diagSummary = !diag
    ? null
    : stale === 0
      ? t("virtualDisplay.diag.none")
      : owned > 0
        ? t("virtualDisplay.diag.active", { count: stale })
        : t("virtualDisplay.diag.residual", { count: stale });

  return (
    <section className="vd-advanced" aria-label={t("virtualDisplay.advanced.title")}>
      <button
        type="button"
        className="vd-advanced-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRight size={12} className={open ? "is-open" : undefined} aria-hidden="true" />
        <span className="vd-advanced-toggle-title">{t("virtualDisplay.advanced.title")}</span>
        <span className="vd-advanced-toggle-hint">
          {t("virtualDisplay.advanced.summary")}
        </span>
      </button>

      {open ? (
        <div className="vd-advanced-grid">
          <div className="vd-advanced-card">
            <h4 className="vd-card-title">{t("virtualDisplay.advanced.sessions")}</h4>
            <div className="vd-setting-row">
              <div className="vd-setting-main">
                <span className="vd-setting-label">{t("virtualDisplay.multi")}</span>
                <span className="vd-hint">{t("virtualDisplay.multiHint")}</span>
              </div>
              <Switch
                checked={allowMulti}
                onChange={onAllowMultiChange}
                ariaLabel={t("virtualDisplay.multi")}
              />
            </div>
            <div className="vd-setting-row">
              <div className="vd-setting-main">
                <span className="vd-setting-label">{t("virtualDisplay.clipboard")}</span>
                <span className="vd-hint">{t("virtualDisplay.clipboardHint")}</span>
              </div>
              <Switch
                checked={clipboardSync}
                onChange={onClipboardChange}
                ariaLabel={t("virtualDisplay.clipboard")}
              />
            </div>
            <div className="vd-setting-row">
              <div className="vd-setting-main">
                <span className="vd-setting-label">
                  {t("virtualDisplay.advanced.defaultSize")}
                </span>
                <span className="vd-hint">{t("virtualDisplay.sizeHint")}</span>
              </div>
              <div className="vd-setting-control">
                <Select
                  value={size}
                  options={sizeOptions}
                  onChange={onSizeChange}
                  ariaLabel={t("virtualDisplay.advanced.defaultSize")}
                  size="sm"
                  block
                />
              </div>
            </div>
          </div>

          <div className="vd-advanced-card">
            <h4 className="vd-card-title">{t("virtualDisplay.advanced.toolchain")}</h4>
            <dl className="vd-fact-grid">
              <dt>ADB</dt>
              <dd>
                {probe?.adb_path
                  ? `${shortVersion(probe.adb_version) ?? "—"}`
                  : t("virtualDisplay.toolchain.missing")}
              </dd>
              <dt>{t("virtualDisplay.toolchain.path")} · ADB</dt>
              <dd className="vd-mono vd-path">{probe?.adb_path ?? "—"}</dd>
              <dt>scrcpy</dt>
              <dd>
                {probe?.scrcpy_path
                  ? `${shortVersion(probe.scrcpy_version) ?? "—"}`
                  : t("virtualDisplay.toolchain.missing")}
              </dd>
              <dt>{t("virtualDisplay.toolchain.path")} · scrcpy</dt>
              <dd className="vd-mono vd-path">{probe?.scrcpy_path ?? "—"}</dd>
              <dt>{t("virtualDisplay.toolchain.virtualSupport")}</dt>
              <dd>
                {probe?.supports_new_display
                  ? t("virtualDisplay.toolchain.supported")
                  : t("virtualDisplay.toolchain.unsupported")}
              </dd>
              <dt>{t("virtualDisplay.toolchain.imeSupport")}</dt>
              <dd>
                {probe?.supports_ime_local
                  ? t("virtualDisplay.toolchain.supported")
                  : t("virtualDisplay.toolchain.unsupported")}
              </dd>
            </dl>
            <div className="vd-hint">{t("virtualDisplay.toolchain.installHint")}</div>
          </div>

          <div className="vd-advanced-card vd-advanced-diagnostics">
            <h4 className="vd-card-title">{t("virtualDisplay.advanced.diagnostics")}</h4>
            <dl className="vd-fact-grid">
              <dt>{t("virtualDisplay.advanced.adbStatus")}</dt>
              <dd>
                {probe?.adb_path
                  ? t("virtualDisplay.toolchain.ok")
                  : t("virtualDisplay.toolchain.missing")}
              </dd>
              <dt>{t("virtualDisplay.advanced.deviceAuth")}</dt>
              <dd>
                {selectedDevice
                  ? t(deviceStateKey(selectedDevice.state))
                  : t("virtualDisplay.toolchain.notConnected")}
              </dd>
              <dt>{t("virtualDisplay.advanced.transport")}</dt>
              <dd className="vd-mono vd-path">
                {selectedDevice?.transports.join(" · ") ?? "—"}
              </dd>
              <dt>{t("virtualDisplay.advanced.virtualDisplay")}</dt>
              <dd>{diagSummary ?? t("virtualDisplay.advanced.detectFirst")}</dd>
            </dl>

            {stale > 0 ? (
              <ul className="vd-diag-list">
                {diag?.stale_displays.map((line) => (
                  <li key={line} className="vd-mono">
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="vd-advanced-actions">
              <button
                className="btn sm"
                onClick={onRunDiagnostics}
                disabled={!selectedDevice || diagBusy}
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
              {stale > 0 ? (
                <button
                  className="btn sm danger-ghost"
                  onClick={onReconnect}
                  disabled={owned > 0 || reconnectBusy}
                  data-tip={
                    owned > 0 ? t("virtualDisplay.diag.closeFirst") : undefined
                  }
                >
                  {t("virtualDisplay.reconnect")}
                </button>
              ) : null}
            </div>
            {stale > 0 && owned > 0 ? (
              <div className="vd-hint">{t("virtualDisplay.diag.closeFirst")}</div>
            ) : null}
          </div>

          <div className="vd-advanced-card">
            <h4 className="vd-card-title">{t("virtualDisplay.advanced.identity")}</h4>
            {selectedDevice ? (
              <dl className="vd-fact-grid vd-identity-grid">
                <dt>{t("virtualDisplay.advanced.serial")}</dt>
                <dd className="vd-identity-value">
                  <code className="vd-mono" data-tip={selectedDevice.serial}>
                    {selectedDevice.serial}
                  </code>
                  <button
                    className="icon-btn sm"
                    data-tip={t("virtualDisplay.advanced.copy")}
                    aria-label={`${t("virtualDisplay.advanced.copy")} ${t(
                      "virtualDisplay.advanced.serial",
                    )}`}
                    onClick={() => onCopy(selectedDevice.serial)}
                  >
                    <Copy size={11} />
                  </button>
                </dd>
                <dt>{t("virtualDisplay.advanced.uid")}</dt>
                <dd className="vd-identity-value">
                  <code className="vd-mono">{selectedDevice.uid}</code>
                  <button
                    className="icon-btn sm"
                    data-tip={t("virtualDisplay.advanced.copy")}
                    aria-label={`${t("virtualDisplay.advanced.copy")} ${t(
                      "virtualDisplay.advanced.uid",
                    )}`}
                    onClick={() => onCopy(selectedDevice.uid)}
                  >
                    <Copy size={11} />
                  </button>
                </dd>
                <dt>{t("virtualDisplay.advanced.transportId")}</dt>
                <dd className="vd-mono">{selectedDevice.transport_id ?? "—"}</dd>
              </dl>
            ) : (
              <div className="vd-hint">{t("virtualDisplay.toolchain.notConnected")}</div>
            )}
            <div className="vd-hint">{t("virtualDisplay.advanced.identityHint")}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
