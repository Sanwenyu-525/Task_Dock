//! 设置 → 手机与同步：局域网配对状态、已授权设备与撤销。
//!
//! 交互约束：
//! - 服务默认关闭；只有用户勾选后才监听局域网（Rust 主管 1s 内生效）；
//! - 配对弹层是 App 根部常驻的全局实例（标题栏快捷入口共用），本分区只负责
//!   打开它并在关闭后刷新状态/设备列表，避免出现两个二维码对话框；
//! - 二维码始终黑模块白底，不跟随主题反色（保证扫码率）；
//! - 撤销设备必须走危险确认框，成功/失败都刷新真实设备列表。

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, QrCode, RefreshCw, Smartphone } from "lucide-react";
import {
  mobileSyncRevokeDevice,
  mobileSyncStatus,
  type MobileDevice,
  type MobileSyncStatus,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { formatLocalStamp } from "../../lib/format";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import {
  MOBILE_SYNC_CHANGED_EVENT,
  openMobilePairing,
} from "../../lib/mobilePairing";
import { ConfirmDialog } from "../ui/Dialog";
import { NumberInput, Switch } from "../ui";

function formatStamp(iso: string | null | undefined): string | null {
  const stamp = formatLocalStamp(iso);
  return stamp ? `${stamp.date} ${stamp.time}` : null;
}

function platformLabel(platform: string): string {
  if (platform === "android") return "Android";
  if (platform === "ios") return "iOS";
  return platform || "—";
}

function fingerprintLabel(value: string): string {
  if (value.length === 8) return `${value.slice(0, 4)}-${value.slice(4)}`;
  return value;
}

function statusTone(status: MobileSyncStatus | null) {
  if (!status) return { labelKey: "settings.mobileSync.statusStarting", tone: "pending" } as const;
  if (status.error) return { labelKey: "settings.mobileSync.statusError", tone: "error" } as const;
  if (status.running) return { labelKey: "settings.mobileSync.statusRunning", tone: "running" } as const;
  return { labelKey: "settings.mobileSync.statusStopped", tone: "stopped" } as const;
}

export default function MobileSyncSection() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);

  const [status, setStatus] = useState<MobileSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MobileDevice | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const mounted = useRef(false);
  const requestSeq = useRef(0);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const request = ++requestSeq.current;
    try {
      const next = await mobileSyncStatus();
      if (!mounted.current || request !== requestSeq.current) return;
      setStatus(next);
      setLoadError(null);
    } catch (reason) {
      if (!mounted.current || request !== requestSeq.current) return;
      setLoadError(localizedErrorMessage(reason));
    } finally {
      if (mounted.current && request === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // 全局配对弹层关闭/成功后会广播变更：刷新状态与设备列表。
    const onChanged = () => void refresh();
    window.addEventListener(MOBILE_SYNC_CHANGED_EVENT, onChanged);
    return () => {
      mounted.current = false;
      requestSeq.current += 1;
      window.removeEventListener(MOBILE_SYNC_CHANGED_EVENT, onChanged);
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refresh]);

  const enabled = settings?.mobile_sync_enabled ?? false;
  const port = settings?.mobile_sync_port ?? 47822;

  const toggleEnabled = useCallback(
    async (next: boolean) => {
      try {
        await update({ mobile_sync_enabled: next });
        if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = null;
          void refresh();
        }, 1200);
      } catch (reason) {
        showToast(localizedErrorMessage(reason), { kind: "error" });
      }
    },
    [update, refresh, showToast],
  );

  const changePort = useCallback(
    async (value: number) => {
      try {
        await update({ mobile_sync_port: value });
        if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = null;
          void refresh();
        }, 1500);
      } catch (reason) {
        showToast(localizedErrorMessage(reason), { kind: "error" });
      }
    },
    [update, refresh, showToast],
  );

  const copyAddress = useCallback(async () => {
    const address = status?.base_url;
    if (!address) return;
    const ok = await copyText(address);
    if (ok) showToast(t("settings.mobileSync.copied"), { kind: "success" });
  }, [status?.base_url, showToast, t]);

  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      const revoked = await mobileSyncRevokeDevice(revokeTarget.id);
      if (mounted.current) {
        showToast(
          revoked ? t("settings.mobileSync.revokeDone") : t("settings.mobileSync.revokeDetail"),
          { kind: revoked ? "success" : "error" },
        );
      }
      setRevokeTarget(null);
      await refresh();
    } catch (reason) {
      if (mounted.current) showToast(localizedErrorMessage(reason), { kind: "error" });
    } finally {
      if (mounted.current) setRevokeBusy(false);
    }
  }, [revokeTarget, refresh, showToast, t]);

  const tone = statusTone(status);
  const statusLabel =
    tone.labelKey === "settings.mobileSync.statusError"
      ? t("settings.mobileSync.statusError", { error: status?.error ?? "" })
      : t(tone.labelKey);
  const canPair = enabled && status?.running === true && !!status.lan_ip;

  return (
    <>
      <div className="setting-row">
        <span>{t("settings.mobileSync.enabled")}</span>
        <Switch
          checked={enabled}
          ariaLabel={t("settings.mobileSync.enabled")}
          onChange={(value) => void toggleEnabled(value)}
        />
      </div>
      <div className="setting-note">{t("settings.mobileSync.enabledNote")}</div>

      <div className="setting-row">
        <span>{t("settings.mobileSync.port")}</span>
        <NumberInput
          value={port}
          min={1024}
          max={65535}
          ariaLabel={t("settings.mobileSync.port")}
          onChange={(value) => void changePort(value)}
        />
      </div>

      <div className="setting-row">
        <span>{t("settings.mobileSync.status")}</span>
        <div className="mobile-sync-status">
          <span className={`mobile-sync-dot is-${tone.tone}`} aria-hidden="true" />
          <span className="mobile-sync-status-text">{loading && !status ? "…" : statusLabel}</span>
          <button
            className="icon-btn sm"
            data-tip={t("settings.mobileSync.refresh")}
            aria-label={t("settings.mobileSync.refresh")}
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={12} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </div>

      <div className="setting-row">
        <span>{t("settings.mobileSync.address")}</span>
        <div className="btn-row">
          {status?.base_url ? (
            <>
              <code className="token-box mobile-sync-address">{status.base_url}</code>
              <button
                className="icon-btn sm"
                data-tip={t("settings.mobileSync.copyAddress")}
                aria-label={t("settings.mobileSync.copyAddress")}
                onClick={() => void copyAddress()}
              >
                <Copy size={12} />
              </button>
            </>
          ) : (
            <span className="setting-value">{t("settings.mobileSync.addressUnknown")}</span>
          )}
        </div>
      </div>
      {status?.fingerprint ? (
        <div className="setting-row">
          <span>{t("settings.mobileSync.fingerprint")}</span>
          <code className="mobile-sync-fingerprint">{fingerprintLabel(status.fingerprint)}</code>
        </div>
      ) : null}

      <div className="setting-row">
        <span>{t("settings.mobileSync.pair")}</span>
        <button
          className="btn sm"
          onClick={openMobilePairing}
          disabled={!canPair}
          data-tip={!canPair ? t("settings.mobileSync.pairDisabled") : undefined}
        >
          <QrCode size={12} /> {t("settings.mobileSync.pair")}
        </button>
      </div>

      {status?.devices.length ? (
        <div className="mobile-sync-devices">
          {status.devices.map((device) => (
            <div className="mobile-sync-device" key={device.id}>
              <span className="mobile-sync-device-icon" aria-hidden="true">
                <Smartphone size={16} />
              </span>
              <div className="mobile-sync-device-main">
                <span className="mobile-sync-device-name">{device.name}</span>
                <span className="mobile-sync-device-meta">
                  {platformLabel(device.platform)} ·{" "}
                  {device.last_seen_at
                    ? `${t("settings.mobileSync.lastSeen")} ${formatStamp(device.last_seen_at)}`
                    : t("settings.mobileSync.neverSeen")}
                </span>
              </div>
              <button
                className="btn sm danger-ghost"
                onClick={() => setRevokeTarget(device)}
                aria-label={`${t("settings.mobileSync.revoke")} ${device.name}`}
              >
                {t("settings.mobileSync.revoke")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="setting-note">{t("settings.mobileSync.noDevices")}</div>
      )}

      <div className="setting-note">{t("settings.mobileSync.firewallNote")}</div>
      <div className="setting-note">{t("settings.mobileSync.securityNote")}</div>
      {loadError ? (
        <div className="setting-note mobile-sync-error" role="alert">
          {loadError}
        </div>
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        title={
          revokeTarget
            ? t("settings.mobileSync.revokeTitle", { name: revokeTarget.name })
            : t("settings.mobileSync.revoke")
        }
        detail={t("settings.mobileSync.revokeDetail")}
        confirmLabel={t("settings.mobileSync.revoke")}
        danger
        busy={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </>
  );
}
