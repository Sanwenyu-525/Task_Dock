//! 手机互传页（左侧导航）：局域网配对状态、已授权设备与撤销。
//!
//! 交互约束：
//! - 服务默认关闭；只有用户勾选后才监听局域网（Rust 主管 1s 内生效）；
//! - 配对弹层是 App 根部常驻的全局实例（标题栏快捷入口共用），本分区只负责
//!   打开它并在关闭后刷新状态/设备列表，避免出现两个二维码对话框；
//! - 二维码始终黑模块白底，不跟随主题反色（保证扫码率）；
//! - 撤销设备必须走危险确认框，成功/失败都刷新真实设备列表。
//! - 设备行按固定窗口（2 分钟）展示在线状态；同步是手机发起的无状态请求，
//!   「在线」只表示最近有鉴权请求，不引入可配置的连接时长。

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Copy,
  FolderOpen,
  QrCode,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  mobileFileDelete,
  mobileFileList,
  mobileFileOffer,
  mobileFileOpenInbox,
  mobileFileReveal,
  mobileSyncRevokeDevice,
  mobileSyncStatus,
  type MobileDevice,
  type MobileFile,
  type MobileSyncStatus,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { formatBytes } from "../../lib/clipboardUi";
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

/** 设备「在线」判定窗口：最近一次鉴权请求（同步/连接测试）距今不超过 2 分钟。 */
const DEVICE_ONLINE_WINDOW_MS = 120_000;
/** 设置分区展开期间的低频状态轮询：让在线状态与服务状态自己收敛，不依赖手动刷新。 */
const STATUS_POLL_MS = 15_000;

function isDeviceOnline(lastSeenAt: string | null, now: number): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && now - seen <= DEVICE_ONLINE_WINDOW_MS;
}

/** 文件列表时间：当年省略年份，把宽度留给文件名与状态胶囊。 */
function formatShortStamp(iso: string | null | undefined): string | null {
  const stamp = formatLocalStamp(iso);
  if (!stamp) return null;
  const year = String(new Date().getFullYear());
  const date = stamp.date.startsWith(`${year}-`) ? stamp.date.slice(5) : stamp.date;
  return `${date} ${stamp.time}`;
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
  /** 在线判定的本地时钟：定时推进，让设备在无请求时也能从「在线」落到「离线」。 */
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MobileDevice | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [files, setFiles] = useState<MobileFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [fileBusy, setFileBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MobileFile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const mounted = useRef(false);
  const requestSeq = useRef(0);
  const filesRequestSeq = useRef(0);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const request = ++requestSeq.current;
    try {
      const next = await mobileSyncStatus();
      if (!mounted.current || request !== requestSeq.current) return;
      setStatus(next);
      setNow(Date.now());
      setLoadError(null);
    } catch (reason) {
      if (!mounted.current || request !== requestSeq.current) return;
      setLoadError(localizedErrorMessage(reason));
    } finally {
      if (mounted.current && request === requestSeq.current) setLoading(false);
    }
  }, []);

  const refreshFiles = useCallback(
    async (quiet = false) => {
      const request = ++filesRequestSeq.current;
      try {
        const next = await mobileFileList();
        if (!mounted.current || request !== filesRequestSeq.current) return;
        setFiles(next);
      } catch (reason) {
        // 轮询失败不弹 Toast：服务/DB 暂时不可用时每 3s 一条会淹没界面。
        if (!quiet && mounted.current && request === filesRequestSeq.current) {
          showToast(localizedErrorMessage(reason), { kind: "error" });
        }
      } finally {
        if (mounted.current && request === filesRequestSeq.current) setFilesLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshFiles(true);
    // 全局配对弹层关闭/成功后会广播变更：刷新状态与设备列表。
    const onChanged = () => void refresh();
    window.addEventListener(MOBILE_SYNC_CHANGED_EVENT, onChanged);
    // 上传/下载由手机端驱动，桌面端没有事件可订阅；仅在分区展开时低频轮询。
    const filesTimer = window.setInterval(() => {
      if (!document.hidden) void refreshFiles(true);
    }, 3000);
    // 服务/设备状态没有推送通道：低频轮询 last_seen_at，让「在线」自己落到「离线」。
    const statusTimer = window.setInterval(() => {
      if (document.hidden) return;
      setNow(Date.now());
      void refresh();
    }, STATUS_POLL_MS);
    return () => {
      mounted.current = false;
      requestSeq.current += 1;
      filesRequestSeq.current += 1;
      window.removeEventListener(MOBILE_SYNC_CHANGED_EVENT, onChanged);
      window.clearInterval(filesTimer);
      window.clearInterval(statusTimer);
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refresh, refreshFiles]);

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

  const pickFiles = useCallback(async () => {
    if (fileBusy) return;
    try {
      const selected = await openFileDialog({
        multiple: true,
        title: t("settings.mobileSync.files.pickTitle"),
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      setFileBusy(true);
      const created = await mobileFileOffer(paths);
      if (!mounted.current) return;
      showToast(t("settings.mobileSync.files.offered", { count: created.length }), {
        kind: "success",
      });
      await refreshFiles();
    } catch (reason) {
      if (mounted.current) showToast(localizedErrorMessage(reason), { kind: "error" });
    } finally {
      if (mounted.current) setFileBusy(false);
    }
  }, [fileBusy, refreshFiles, showToast, t]);

  const revealFile = useCallback(
    async (file: MobileFile) => {
      try {
        await mobileFileReveal(file.id);
      } catch (reason) {
        showToast(localizedErrorMessage(reason), { kind: "error" });
      }
    },
    [showToast],
  );

  const openInbox = useCallback(async () => {
    try {
      await mobileFileOpenInbox();
    } catch (reason) {
      showToast(localizedErrorMessage(reason), { kind: "error" });
    }
  }, [showToast]);

  const confirmDeleteFile = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const removed = await mobileFileDelete(deleteTarget.id);
      if (mounted.current) {
        showToast(
          removed ? t("settings.mobileSync.files.deleted") : t("settings.mobileSync.files.deleteFailed"),
          { kind: removed ? "success" : "error" },
        );
      }
      setDeleteTarget(null);
      await refreshFiles();
    } catch (reason) {
      if (mounted.current) showToast(localizedErrorMessage(reason), { kind: "error" });
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  }, [deleteTarget, refreshFiles, showToast, t]);

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

  const fileStatusLabel = (file: MobileFile) => {
    if (file.status === "ready") {
      return t(
        file.direction === "to_phone"
          ? "settings.mobileSync.files.statusReadyToPhone"
          : "settings.mobileSync.files.statusReadyToDesktop",
      );
    }
    if (file.status === "failed") return t("settings.mobileSync.files.statusFailed");
    return t("settings.mobileSync.files.statusPending", {
      received: file.received_chunks,
      total: file.chunks,
    });
  };

  const renderFileGroup = (direction: MobileFile["direction"], items: MobileFile[]) => {
    if (items.length === 0) return null;
    return (
      <div className="mobile-file-group" key={direction}>
        <div className="mobile-file-group-head">
          <span className="mobile-file-group-title">
            {t(
              direction === "to_phone"
                ? "settings.mobileSync.files.toPhone"
                : "settings.mobileSync.files.toDesktop",
            )}
          </span>
          <span className="mobile-file-group-count">{items.length}</span>
          <span className="mobile-file-group-rule" />
        </div>
        <div className="mobile-file-list">
          {items.map((file) => {
            const stamp = formatShortStamp(file.completed_at ?? file.created_at);
            return (
              <div className="mobile-file-item" key={file.id}>
                <span className={`mobile-file-icon is-${file.direction}`} aria-hidden="true">
                  {file.direction === "to_phone" ? (
                    <ArrowUpRight size={14} />
                  ) : (
                    <ArrowDownLeft size={14} />
                  )}
                </span>
                <div className="mobile-file-main">
                  <span className="mobile-file-name" data-tip={file.name}>
                    {file.name}
                  </span>
                  <span className="mobile-file-meta">
                    {formatBytes(file.size)}
                    {stamp ? ` · ${stamp}` : ""}
                  </span>
                </div>
                <span className={`mobile-file-status is-${file.status}`}>
                  {fileStatusLabel(file)}
                </span>
                <div className="mobile-file-actions">
                  {file.status === "ready" ? (
                    <button
                      className="icon-btn sm"
                      data-tip={t("settings.mobileSync.files.reveal")}
                      aria-label={`${t("settings.mobileSync.files.reveal")} ${file.name}`}
                      onClick={() => void revealFile(file)}
                    >
                      <FolderOpen size={12} />
                    </button>
                  ) : null}
                  <button
                    className="icon-btn sm"
                    data-tip={t("settings.mobileSync.files.delete")}
                    aria-label={`${t("settings.mobileSync.files.delete")} ${file.name}`}
                    onClick={() => setDeleteTarget(file)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

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

      <div className="setting-row mobile-sync-address-row">
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
          {status.devices.map((device) => {
            const online = isDeviceOnline(device.last_seen_at, now);
            const seen = formatStamp(device.last_seen_at);
            return (
              <div className="mobile-sync-device" key={device.id}>
                <span className="mobile-sync-device-icon" aria-hidden="true">
                  <Smartphone size={16} />
                </span>
                <div className="mobile-sync-device-main">
                  <span className="mobile-sync-device-name-line">
                    <span
                      className={`mobile-sync-presence-dot${online ? " is-online" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="mobile-sync-device-name">{device.name}</span>
                  </span>
                  <span className="mobile-sync-device-meta">
                    {platformLabel(device.platform)} ·{" "}
                    {online ? (
                      <span
                        className="mobile-sync-device-online"
                        data-tip={t("settings.mobileSync.presenceHint")}
                      >
                        {t("settings.mobileSync.online")}
                      </span>
                    ) : seen ? (
                      `${t("settings.mobileSync.lastSeen")} ${seen}`
                    ) : (
                      t("settings.mobileSync.neverSeen")
                    )}
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
            );
          })}
        </div>
      ) : (
        <div className="setting-note">{t("settings.mobileSync.noDevices")}</div>
      )}

      <div className="setting-row mobile-file-toolbar">
        <span>{t("settings.mobileSync.files.title")}</span>
        <div className="btn-row">
          <button className="btn sm" onClick={() => void pickFiles()} disabled={fileBusy}>
            <Send size={12} />
            {fileBusy
              ? t("settings.mobileSync.files.sending")
              : t("settings.mobileSync.files.send")}
          </button>
          <button className="btn sm" onClick={() => void openInbox()}>
            <FolderOpen size={12} /> {t("settings.mobileSync.files.openInbox")}
          </button>
        </div>
      </div>
      <div className="setting-note">{t("settings.mobileSync.files.note")}</div>

      {filesLoading && files.length === 0 ? (
        <div className="mobile-file-empty" role="status">
          <span className="mobile-file-empty-icon" aria-hidden="true">
            <RefreshCw size={14} className="spin" />
          </span>
          <div className="mobile-file-empty-main">
            <span className="mobile-file-empty-title">
              {t("settings.mobileSync.files.loading")}
            </span>
          </div>
        </div>
      ) : files.length === 0 ? (
        <div className="mobile-file-empty">
          <span className="mobile-file-empty-icon" aria-hidden="true">
            <Send size={14} />
          </span>
          <div className="mobile-file-empty-main">
            <span className="mobile-file-empty-title">
              {t("settings.mobileSync.files.empty")}
            </span>
            <span className="mobile-file-empty-hint">
              {t("settings.mobileSync.files.emptyHint")}
            </span>
          </div>
        </div>
      ) : (
        <div className="mobile-file-groups">
          {renderFileGroup(
            "to_phone",
            files.filter((file) => file.direction === "to_phone"),
          )}
          {renderFileGroup(
            "to_desktop",
            files.filter((file) => file.direction === "to_desktop"),
          )}
        </div>
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

      <ConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget
            ? t("settings.mobileSync.files.deleteTitle", { name: deleteTarget.name })
            : t("settings.mobileSync.files.delete")
        }
        detail={t("settings.mobileSync.files.deleteDetail")}
        confirmLabel={t("settings.mobileSync.files.delete")}
        danger
        busy={deleteBusy}
        onConfirm={() => void confirmDeleteFile()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
