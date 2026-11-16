//! 投屏面板第一层：设备连接卡片 + 工具链状态。
//!
//! 只展示「已检测到的事实」：设备来自 adb，工具链来自真实版本/帮助探测；
//! 不推断、不把未授权设备显示为已连接。完整序列号/UID 不在此出现（见高级诊断）。

import { useState } from "react";
import {
  ChevronRight,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Usb,
  Wifi,
} from "lucide-react";

import type { VdDevice, VdProbe } from "../../../lib/bridge";
import { EmptyState, Select, StatusBadge } from "../../ui";
import {
  connectionLabelKey,
  deviceStateKey,
  deviceTone,
  shortVersion,
  type Translate,
} from "./format";

export interface DeviceToolsProps {
  devices: VdDevice[];
  selected: VdDevice | null;
  serial: string;
  adbOk: boolean;
  deviceError: string | null;
  probe: VdProbe | null;
  probeBusy: boolean;
  refreshing: boolean;
  /** 首次挂载检测中：不要先闪出「未发现设备」的空态。 */
  loading: boolean;
  t: Translate;
  onSelect: (serial: string) => void;
  onRefresh: () => void;
  onRecheck: () => void;
}

type ChipState = "ok" | "warn" | "error" | "missing" | "idle" | "checking";

function chipLabel(state: ChipState, t: Translate): string {
  if (state === "ok") return t("virtualDisplay.toolchain.ok");
  if (state === "warn") return t("virtualDisplay.toolchain.unavailable");
  if (state === "error") return t("virtualDisplay.toolchain.abnormal");
  if (state === "missing") return t("virtualDisplay.toolchain.missing");
  if (state === "checking") return t("virtualDisplay.toolchain.checking");
  return t("virtualDisplay.toolchain.unknown");
}

export default function DeviceTools({
  devices,
  selected,
  serial,
  adbOk,
  deviceError,
  probe,
  probeBusy,
  refreshing,
  loading,
  t,
  onSelect,
  onRefresh,
  onRecheck,
}: DeviceToolsProps) {
  const [identityOpen, setIdentityOpen] = useState(false);
  const [toolchainOpen, setToolchainOpen] = useState(false);

  const hasDevice = devices.length > 0;
  const online = selected?.state === "device";
  const authorized = selected?.state === "device";
  const adbReady = Boolean(probe?.adb_path) && adbOk;
  const toolsReady = adbReady && Boolean(probe?.scrcpy_path);
  const ready = online && toolsReady;

  const adbState: ChipState =
    probe === null
      ? "checking"
      : !probe.adb_path
        ? "missing"
        : adbReady
          ? "ok"
          : "error";
  const scrcpyState: ChipState =
    probe === null ? "checking" : probe.scrcpy_path ? "ok" : "missing";
  const virtualState: ChipState =
    probe === null
      ? "checking"
      : !probe.scrcpy_path
        ? "missing"
        : probe.supports_new_display
          ? "ok"
          : "warn";
  const authState: ChipState = !selected
    ? "idle"
    : authorized
      ? "ok"
      : selected.state === "unauthorized"
        ? "warn"
        : "error";

  const deviceOptions = devices.map((device) => ({
    value: device.serial,
    label: device.model?.trim() || t("virtualDisplay.device.unnamed"),
    hint: t(connectionLabelKey(device.connection)),
  }));

  const blockedReason = !selected
    ? t("virtualDisplay.start.blockedDevice")
    : !online
      ? t(deviceStateKey(selected.state))
      : !adbReady
        ? t("virtualDisplay.adbMissing")
        : !probe?.scrcpy_path
          ? t("virtualDisplay.scrcpyMissing")
          : null;

  return (
    <>
      <section className="vd-device-card" aria-label={t("virtualDisplay.device")}>
        {loading && !hasDevice ? (
          <div className="vd-device-loading" role="status">
            <Loader2 size={15} className="spin" aria-hidden="true" />
            {t("virtualDisplay.device.detecting")}
          </div>
        ) : !hasDevice ? (
          <EmptyState
            className="vd-device-empty"
            icon={<Smartphone size={18} />}
            title={t("virtualDisplay.device.emptyTitle")}
            hint={t("virtualDisplay.device.emptyHint")}
            action={
              <div className="vd-device-empty-actions">
                <button className="btn sm" onClick={onRefresh} disabled={refreshing}>
                  <RefreshCw size={12} className={refreshing ? "spin" : undefined} />
                  {refreshing
                    ? t("virtualDisplay.device.detecting")
                    : t("virtualDisplay.device.detect")}
                </button>
                <button
                  type="button"
                  className="vd-link"
                  onClick={() => setToolchainOpen(true)}
                >
                  {t("virtualDisplay.device.checkTools")}
                </button>
              </div>
            }
          />
        ) : (
          <>
            <div className="vd-device-head">
              <span className={`vd-device-avatar${online ? " is-online" : ""}`} aria-hidden="true">
                <Smartphone size={18} />
              </span>
              <div className="vd-device-info">
                <div className="vd-device-title-row">
                  <span className="vd-device-name">
                    {selected?.model?.trim() ||
                      t("virtualDisplay.device.unnamed")}
                  </span>
                  {selected ? (
                    <StatusBadge tone={deviceTone(selected.state)} size="sm">
                      {t(deviceStateKey(selected.state))}
                    </StatusBadge>
                  ) : null}
                </div>
                {selected ? (
                  <div className="vd-device-meta">
                    <span className="vd-conn-icon" aria-hidden="true">
                      {selected.connection === "usb" ? <Usb size={11} /> : <Wifi size={11} />}
                    </span>
                    <span>{t(connectionLabelKey(selected.connection))}</span>
                    {selected.transports.length > 1 ? (
                      <>
                        <span className="vd-meta-sep">·</span>
                        <span>
                          {t("virtualDisplay.transports", {
                            count: selected.transports.length,
                          })}
                        </span>
                      </>
                    ) : null}
                    {selected.product ? (
                      <>
                        <span className="vd-meta-sep">·</span>
                        <span className="vd-device-product">{selected.product}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <div
                  className={`vd-device-capability${ready ? " is-ready" : " is-blocked"}`}
                >
                  <span className="vd-capability-dot" aria-hidden="true" />
                  <span>
                    {ready
                      ? t("virtualDisplay.device.ready")
                      : t("virtualDisplay.device.notReady")}
                  </span>
                  {ready ? null : blockedReason ? (
                    <span className="vd-capability-why" data-tip={blockedReason}>
                      {blockedReason}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="vd-device-actions">
                <button
                  className="icon-btn sm"
                  data-tip={t("virtualDisplay.refresh")}
                  aria-label={t("virtualDisplay.refresh")}
                  onClick={onRefresh}
                  disabled={refreshing}
                >
                  <RefreshCw size={12} className={refreshing ? "spin" : undefined} />
                </button>
                {selected ? (
                  <button
                    type="button"
                    className="btn sm"
                    aria-expanded={identityOpen}
                    onClick={() => setIdentityOpen((value) => !value)}
                  >
                    {identityOpen
                      ? t("virtualDisplay.device.hideDetails")
                      : t("virtualDisplay.device.details")}
                    <ChevronRight
                      size={11}
                      className={identityOpen ? "is-open" : undefined}
                      aria-hidden="true"
                    />
                  </button>
                ) : null}
              </div>
            </div>

            {devices.length > 1 ? (
              <div className="vd-device-picker">
                <span className="vd-field-label">{t("virtualDisplay.device.select")}</span>
                <div className="vd-device-picker-control">
                  <Select
                    value={serial}
                    options={deviceOptions}
                    onChange={onSelect}
                    placeholder={t("virtualDisplay.noDevice")}
                    ariaLabel={t("virtualDisplay.device.select")}
                    size="sm"
                    block
                  />
                </div>
              </div>
            ) : null}

            {identityOpen && selected ? (
              <div className="vd-device-details">
                <dl className="vd-fact-grid">
                  <dt>{t("virtualDisplay.device.connectionType")}</dt>
                  <dd>{t(connectionLabelKey(selected.connection))}</dd>
                  <dt>{t("virtualDisplay.device.transports")}</dt>
                  <dd>
                    {t("virtualDisplay.device.transportsValue", {
                      count: selected.transports.length,
                    })}
                  </dd>
                  <dt>{t("virtualDisplay.device.model")}</dt>
                  <dd>{selected.model ?? "—"}</dd>
                  <dt>{t("virtualDisplay.device.product")}</dt>
                  <dd>{selected.product ?? selected.device ?? "—"}</dd>
                </dl>
                <div className="vd-hint">{t("virtualDisplay.device.identityHint")}</div>
              </div>
            ) : null}

            {selected && !authorized ? (
              <div className="vd-alert is-warning" role="alert">
                <ShieldAlert size={13} aria-hidden="true" />
                <div className="vd-alert-body">
                  <strong>{t("virtualDisplay.device.unauthorizedTitle")}</strong>
                  <span>{t("virtualDisplay.device.unauthorizedHint")}</span>
                </div>
              </div>
            ) : null}
          </>
        )}

        {deviceError ? (
          <div className="vd-alert is-error" role="alert">
            {deviceError}
          </div>
        ) : null}
        {probe?.error && !deviceError ? (
          <div className="vd-alert is-warning" role="status">
            {probe.error}
          </div>
        ) : null}
      </section>

      <section className="vd-toolchain" aria-label={t("virtualDisplay.toolchain.title")}>
        <div className="vd-toolchain-head">
          <span className="vd-toolchain-title">{t("virtualDisplay.toolchain.title")}</span>
          <div className="vd-toolchain-chips">
            <span className={`vd-tool-chip is-${adbState}`}>
              <span className="vd-chip-dot" aria-hidden="true" />
              ADB <b>{chipLabel(adbState, t)}</b>
            </span>
            <span className={`vd-tool-chip is-${scrcpyState}`}>
              <span className="vd-chip-dot" aria-hidden="true" />
              scrcpy <b>{chipLabel(scrcpyState, t)}</b>
            </span>
            <span className={`vd-tool-chip is-${virtualState}`}>
              <span className="vd-chip-dot" aria-hidden="true" />
              {t("virtualDisplay.toolchain.virtualSupport")}
              <b>
                {virtualState === "ok"
                  ? t("virtualDisplay.toolchain.supported")
                  : virtualState === "warn"
                    ? t("virtualDisplay.toolchain.unsupported")
                    : chipLabel(virtualState, t)}
              </b>
            </span>
            <span className={`vd-tool-chip is-${authState}`}>
              <span className="vd-chip-dot" aria-hidden="true" />
              {t("virtualDisplay.toolchain.authorization")}
              <b>
                {authState === "ok"
                  ? t("virtualDisplay.toolchain.authorized")
                  : authState === "idle"
                    ? t("virtualDisplay.toolchain.notConnected")
                    : selected
                      ? t(deviceStateKey(selected.state))
                      : chipLabel(authState, t)}
              </b>
            </span>
          </div>
          <div className="vd-toolchain-actions">
            <button
              className="icon-btn sm"
              data-tip={t("virtualDisplay.recheck")}
              aria-label={t("virtualDisplay.recheck")}
              onClick={onRecheck}
              disabled={probeBusy}
            >
              <RefreshCw size={12} className={probeBusy ? "spin" : undefined} />
            </button>
            <button
              type="button"
              className="vd-link"
              aria-expanded={toolchainOpen}
              onClick={() => setToolchainOpen((value) => !value)}
            >
              {toolchainOpen
                ? t("virtualDisplay.toolchain.hideDetails")
                : t("virtualDisplay.toolchain.details")}
              <ChevronRight
                size={11}
                className={toolchainOpen ? "is-open" : undefined}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        {toolchainOpen ? (
          <div className="vd-toolchain-details">
            <dl className="vd-fact-grid">
              <dt>ADB</dt>
              <dd>
                {probe?.adb_path ? (
                  <>
                    <span className="vd-mono">
                      {shortVersion(probe.adb_version) ?? t("virtualDisplay.toolchain.unknown")}
                    </span>
                    <span className="vd-path" data-tip={probe.adb_path}>
                      {probe.adb_path}
                    </span>
                  </>
                ) : (
                  t("virtualDisplay.adbMissing")
                )}
              </dd>
              <dt>scrcpy</dt>
              <dd>
                {probe?.scrcpy_path ? (
                  <>
                    <span className="vd-mono">
                      {shortVersion(probe.scrcpy_version) ?? t("virtualDisplay.toolchain.unknown")}
                    </span>
                    <span className="vd-path" data-tip={probe.scrcpy_path}>
                      {probe.scrcpy_path}
                    </span>
                  </>
                ) : (
                  t("virtualDisplay.scrcpyMissing")
                )}
              </dd>
              <dt>{t("virtualDisplay.toolchain.virtualSupport")}</dt>
              <dd>
                {probe?.supports_new_display
                  ? "--new-display"
                  : t("virtualDisplay.versionUnsupported")}
              </dd>
              <dt>{t("virtualDisplay.toolchain.imeSupport")}</dt>
              <dd>
                {probe?.supports_ime_local
                  ? "--display-ime-policy"
                  : t("virtualDisplay.toolchain.unsupported")}
              </dd>
            </dl>
            <div className="vd-hint">{t("virtualDisplay.toolchain.installHint")}</div>
          </div>
        ) : null}
      </section>
    </>
  );
}
