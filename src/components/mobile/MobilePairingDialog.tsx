//! 手机配对弹层（全局唯一实例）。
//!
//! 入口：
//! - 标题栏「配对新设备」快捷按钮（完整/紧凑模式，任何页面可直达）；
//! - 设置 → 手机与同步 → 配对新设备。
//!
//! 行为约束：
//! - 打开后先探测服务；未开启时提供「一键开启并继续」，不在设置页之间来回跳；
//! - 服务启动有上限（12s），端口占用/未检测到局域网时给出可操作错误与设置入口；
//! - 成功后每 1s 轮询一次配对状态（单飞）；关闭/成功即停止并取消会话；
//! - 二维码始终黑模块白底，不随主题反色；过期后隐藏二维码，只保留重新生成；
//! - 关闭时广播变更事件，让设置分区刷新状态与设备列表。

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import {
  applyMode,
  mobileSyncCancelPairing,
  mobileSyncStartPairing,
  mobileSyncStatus,
  type MobileSyncPairedNotice,
  type MobileSyncPairingOffer,
} from "../../lib/bridge";
import { encodeQr, qrToSvgPath } from "../../lib/qr";
import { formatLocalStamp } from "../../lib/format";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import {
  closeMobilePairing,
  notifyMobileSyncChanged,
  useMobilePairingOpen,
} from "../../lib/mobilePairing";
import { requestSettingsSectionReveal } from "../../lib/settingsSections";
import { Dialog } from "../ui/Dialog";

/** 服务从「已开启设置」到真正绑定端口的等待上限（主管任务 1s 轮询 + 失败 5s 重试）。 */
const START_TIMEOUT_MS = 12_000;
const START_POLL_MS = 600;

type Phase = "loading" | "disabled" | "starting" | "ready" | "error";

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

export default function MobilePairingDialog() {
  const open = useMobilePairingOpen();
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  const enabled = settings?.mobile_sync_enabled ?? false;
  const settingsReady = settings !== null;

  const [phase, setPhase] = useState<Phase>("loading");
  const [offer, setOffer] = useState<MobileSyncPairingOffer | null>(null);
  const [paired, setPaired] = useState<MobileSyncPairedNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** 本地倒计时截止时间（毫秒）：不依赖轮询回包，避免刚打开时把有效二维码误判为过期 */
  const [deadline, setDeadline] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  /** 会话代次：关闭/重来时让在途的开始请求失效，避免晚到的响应重新打开弹层。 */
  const epoch = useRef(0);
  const pairBusy = useRef(false);

  const close = useCallback(() => {
    epoch.current += 1;
    pairBusy.current = false;
    setPhase("loading");
    setOffer(null);
    setPaired(null);
    setError(null);
    setDeadline(null);
    closeMobilePairing();
    void mobileSyncCancelPairing().catch(() => {
      // 关闭失败由 120s TTL 兜底；不阻塞 UI。
    });
    notifyMobileSyncChanged();
  }, []);

  const openSettings = useCallback(() => {
    close();
    useUiStore.getState().setTab("settings");
    requestSettingsSectionReveal("mobile-sync");
    void applyMode("full");
  }, [close]);

  const enableAndPair = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await update({ mobile_sync_enabled: true });
      // enabled 变化后主 effect 重新探测服务并生成配对码。
    } catch (reason) {
      setError(localizedErrorMessage(reason));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, [update]);

  // 重新生成只替换服务端会话（start_pairing 原子覆盖旧会话），不先取消：
  // 取消会让弹层回到 loading 再重建，出现一次可见的空白闪烁。这里原地换码，
  // 旧二维码保持可见到新码返回，随后按新 code 重挂载并播放一次淡入。
  const regenerate = useCallback(() => {
    if (pairBusy.current) return;
    const myEpoch = epoch.current;
    pairBusy.current = true;
    setRegenerating(true);
    setError(null);
    void mobileSyncStartPairing()
      .then((next) => {
        if (epoch.current !== myEpoch) {
          // 弹层已关闭/重来：作废刚落库的会话，避免留下 120s 空窗。
          void mobileSyncCancelPairing().catch(() => undefined);
          return;
        }
        setOffer(next);
        setDeadline(Date.now() + next.expires_in_secs * 1000);
        setClock(Date.now());
        setPhase("ready");
      })
      .catch((reason) => {
        if (epoch.current === myEpoch) {
          setError(localizedErrorMessage(reason));
          setPhase("error");
        }
      })
      .finally(() => {
        pairBusy.current = false;
        setRegenerating(false);
      });
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // 打开（或重试）后：探测服务 → 等待绑定 → 生成一次性配对码。
  useEffect(() => {
    if (!open) return;
    if (!settingsReady) {
      setPhase("loading");
      return;
    }
    const myEpoch = ++epoch.current;
    const stale = () => epoch.current !== myEpoch;
    let timer: number | null = null;

    const fail = (reason: unknown) => {
      if (stale()) return;
      setError(localizedErrorMessage(reason));
      setPhase("error");
    };

    const start = async () => {
      if (pairBusy.current) return;
      pairBusy.current = true;
      try {
        const next = await mobileSyncStartPairing();
        if (stale()) {
          // 弹层已关闭或重来：作废刚落库的会话，避免留下 120s 空窗。
          void mobileSyncCancelPairing().catch(() => undefined);
          return;
        }
        setOffer(next);
        setDeadline(Date.now() + next.expires_in_secs * 1000);
        setClock(Date.now());
        setPhase("ready");
      } catch (reason) {
        fail(reason);
      } finally {
        pairBusy.current = false;
      }
    };

    const poll = async (expiresAt: number) => {
      if (stale()) return;
      if (!enabled) {
        setPhase("disabled");
        return;
      }
      try {
        const current = await mobileSyncStatus();
        if (stale()) return;
        if (current.running && current.lan_ip) {
          await start();
          return;
        }
        if (current.error) {
          setError(current.error);
          setPhase("error");
          return;
        }
        if (Date.now() >= expiresAt) {
          setError(t("settings.mobileSync.serviceTimeout"));
          setPhase("error");
          return;
        }
        setPhase("starting");
        timer = window.setTimeout(() => void poll(expiresAt), START_POLL_MS);
      } catch (reason) {
        fail(reason);
      }
    };

    setPhase("loading");
    setOffer(null);
    setPaired(null);
    setError(null);
    setDeadline(null);
    void poll(Date.now() + START_TIMEOUT_MS);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [open, settingsReady, enabled, attempt, t]);

  // 配对码有效期内轮询配对结果：单飞、1s 间隔、成功/关闭即停止。
  useEffect(() => {
    if (!open || phase !== "ready" || paired) return;
    let cancelled = false;
    let inFlight = false;
    const timer = window.setInterval(() => {
      setClock(Date.now());
      if (inFlight) return;
      inFlight = true;
      mobileSyncStatus()
        .then((next) => {
          if (cancelled) return;
          // 重新生成期间旧会话可能刚好配对成功：以新码为准，不把旧结果当成本次成功。
          if (next.paired_device && !pairBusy.current) {
            setPaired(next.paired_device);
            setError(null);
            notifyMobileSyncChanged();
          }
        })
        .catch((reason) => {
          if (!cancelled) setError(localizedErrorMessage(reason));
        })
        .finally(() => {
          inFlight = false;
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, phase, paired]);

  const qr = (() => {
    if (!offer) return null;
    try {
      const matrix = encodeQr(offer.qr_payload);
      return { size: matrix.size, path: qrToSvgPath(matrix) };
    } catch {
      return null;
    }
  })();

  const remaining = deadline ? Math.max(0, Math.ceil((deadline - clock) / 1000)) : 0;

  const footer = paired ? (
    <button className="btn primary" onClick={close} data-autofocus>
      {t("settings.mobileSync.pairDone")}
    </button>
  ) : (
    <>
      <button className="btn" onClick={close}>
        {t("settings.mobileSync.pairCancel")}
      </button>
      {phase === "ready" || phase === "error" ? (
        <button
          className="btn"
          onClick={phase === "error" ? retry : regenerate}
          disabled={regenerating}
          aria-busy={regenerating}
        >
          {phase === "ready"
            ? regenerating
              ? t("settings.mobileSync.pairRegenerating")
              : t("settings.mobileSync.pairRegenerate")
            : t("settings.mobileSync.retry")}
        </button>
      ) : null}
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("settings.mobileSync.pairTitle")}
      size="md"
      dismissOnScrim={false}
      footer={footer}
    >
      {paired ? (
        <div className="mobile-sync-success">
          <CheckCircle2 size={34} aria-hidden="true" />
          <strong>{t("settings.mobileSync.pairSuccess")}</strong>
          <p>{t("settings.mobileSync.pairSuccessDetail", { name: paired.name })}</p>
          <span className="mobile-sync-device-meta">
            {platformLabel(paired.platform)} · {formatStamp(paired.paired_at)}
          </span>
        </div>
      ) : phase === "disabled" ? (
        <div className="mobile-sync-pair">
          <p className="mobile-sync-hint">{t("settings.mobileSync.disabledHint")}</p>
          <div className="btn-row">
            <button
              className="btn primary"
              onClick={() => void enableAndPair()}
              disabled={busy}
            >
              {busy
                ? t("settings.mobileSync.statusStarting")
                : t("settings.mobileSync.enableAndPair")}
            </button>
            <button className="btn" onClick={openSettings}>
              {t("settings.mobileSync.openSettings")}
            </button>
          </div>
        </div>
      ) : phase === "error" ? (
        <div className="mobile-sync-pair">
          <div className="mobile-sync-error" role="alert">
            <XCircle size={13} aria-hidden="true" />
            {t("settings.mobileSync.startFailed", { error: error ?? "" })}
          </div>
          <button className="btn" onClick={openSettings}>
            {t("settings.mobileSync.openSettings")}
          </button>
        </div>
      ) : phase === "starting" || phase === "loading" ? (
        <div className="mobile-sync-pair">
          <span className="mobile-sync-starting">
            <Loader2 size={14} className="spin" aria-hidden="true" />
            {phase === "starting"
              ? t("settings.mobileSync.serviceStarting")
              : t("settings.mobileSync.statusStarting")}
          </span>
          <span className="mobile-sync-hint">{t("settings.mobileSync.firewallNote")}</span>
        </div>
      ) : offer && qr ? (
        <div className="mobile-sync-pair">
          {remaining > 0 ? (
            <div key={offer.code} className="mobile-sync-qr">
              <svg
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                width={176}
                height={176}
                role="img"
                aria-label={t("settings.mobileSync.pairTitle")}
                shapeRendering="crispEdges"
              >
                <rect width={qr.size} height={qr.size} fill="#fff" />
                <path d={qr.path} fill="#000" />
              </svg>
            </div>
          ) : null}
          <p className="mobile-sync-hint">{t("settings.mobileSync.pairScanHint")}</p>
          <span className="mobile-sync-hint">{t("settings.mobileSync.pairCodeLabel")}</span>
          <div className="mobile-sync-code" aria-label={offer.code} aria-live="polite">
            {offer.code}
          </div>
          <span
            className={
              remaining > 0 ? "mobile-sync-countdown" : "mobile-sync-countdown is-expired"
            }
          >
            {remaining > 0
              ? t("settings.mobileSync.pairExpires", { seconds: remaining })
              : t("settings.mobileSync.pairExpired")}
          </span>
          <div className="mobile-sync-pair-meta">
            <span>{offer.server_name}</span>
            <span>
              {t("settings.mobileSync.pairNetwork", {
                address: `${offer.lan_ip}:${offer.port}`,
              })}
            </span>
            <span>
              {t("settings.mobileSync.fingerprint")}: {fingerprintLabel(offer.fingerprint)}
            </span>
          </div>
          {error ? (
            <div className="mobile-sync-error" role="alert">
              <XCircle size={13} aria-hidden="true" /> {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
