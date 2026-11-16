//! 正在运行的投屏会话区：概览、卡片、状态与操作。
//!
//! 会话标题只用「设备 · 屏幕 / 设备 · 应用」，UUID/PID/完整包名不进标题；
//! 关闭只调用 vd_stop（后端按记录 PID 收尾），不会误杀手动启动的 scrcpy。

import {
  AppWindow,
  ArrowLeft,
  Camera,
  CircleAlert,
  Home,
  List,
  LocateFixed,
  MonitorSmartphone,
  ShieldAlert,
  Square,
  Loader2,
} from "lucide-react";

import type { VdDevice, VdSession } from "../../../lib/bridge";
import { EmptyState, StatusBadge } from "../../ui";
import {
  formatDuration,
  isActiveSession,
  sessionDeviceLabel,
  sessionStatusKey,
  sessionStatusTone,
  sessionTitle,
  stageKey,
  type Translate,
} from "./format";

export interface SessionListProps {
  sessions: VdSession[];
  activeCount: number;
  limit: number;
  currentDevice: VdDevice | null;
  now: number;
  closingIds: string[];
  capturingId: string | null;
  navBusyId: string | null;
  t: Translate;
  onFocus: (session: VdSession) => void;
  onCapture: (session: VdSession) => void;
  onNavigate: (
    session: VdSession,
    action: "back" | "home" | "recents",
  ) => void;
  onClose: (session: VdSession) => void;
}

export default function SessionList({
  sessions,
  activeCount,
  limit,
  currentDevice,
  now,
  closingIds,
  capturingId,
  navBusyId,
  t,
  onFocus,
  onCapture,
  onNavigate,
  onClose,
}: SessionListProps) {
  return (
    <section className="vd-block vd-sessions" aria-label={t("virtualDisplay.sessions.title")}>
      <div className="vd-block-head">
        <h3 className="vd-block-title">{t("virtualDisplay.sessions.title")}</h3>
        <span className="vd-count" aria-label={t("virtualDisplay.sessions.countLabel")}>
          {t("virtualDisplay.sessions.count", { count: activeCount, max: limit })}
        </span>
        <span className="vd-block-note">{t("virtualDisplay.sessions.maxHint")}</span>
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone size={17} />}
          title={t("virtualDisplay.sessions.empty")}
          hint={t("virtualDisplay.sessions.emptyHint")}
        />
      ) : (
        <div className="vd-session-list">
          {sessions.map((session) => {
            const active = isActiveSession(session);
            const title = sessionTitle(
              session,
              sessionDeviceLabel(session, currentDevice, t),
              t,
            );
            const device = sessionDeviceLabel(session, currentDevice, t);
            const duration =
              session.status === "running" ? formatDuration(session.started_at, now) : null;
            const stage = stageKey(session.stage);
            const closing = session.status === "stopping" || closingIds.includes(session.id);
            const canCapture = session.status === "running" && capturingId !== session.id;
            const navUnavailable =
              session.mode === "virtual" && session.display_id === null;
            const navDisabled =
              session.status !== "running" || navUnavailable || navBusyId === session.id;
            const navTip = navUnavailable
              ? t("virtualDisplay.session.navUnavailable")
              : session.status !== "running"
                ? t("virtualDisplay.session.navNotReady")
                : undefined;
            const modeLabel = t(
              session.mode === "mirror"
                ? "virtualDisplay.mode.mirror"
                : "virtualDisplay.mode.virtual",
            );

            return (
              <article
                className={`vd-session-card is-${session.status}`}
                key={session.id}
                data-status={session.status}
              >
                <div className="vd-session-head">
                  <span className="vd-session-icon" aria-hidden="true">
                    {session.mode === "mirror" ? (
                      <MonitorSmartphone size={15} />
                    ) : (
                      <AppWindow size={15} />
                    )}
                  </span>
                  <div className="vd-session-heading">
                    <span className="vd-session-name" data-tip={session.title}>
                      {title}
                    </span>
                    <div className="vd-session-status-row">
                      <StatusBadge tone={sessionStatusTone(session.status)} size="sm">
                        {t(sessionStatusKey(session.status))}
                      </StatusBadge>
                      {active && stage ? (
                        <span className="vd-session-stage">{t(stage)}</span>
                      ) : null}
                      {duration ? (
                        <span className="vd-session-duration">
                          {t("virtualDisplay.session.duration", { duration })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className={`vd-mode-chip is-${session.mode}`}>{modeLabel}</span>
                </div>

                <div className="vd-session-facts">
                  <span className="vd-session-fact" data-tip={device}>
                    <span className="vd-fact-key">{t("virtualDisplay.session.device")}</span>
                    {device}
                  </span>
                  {session.size ? (
                    <span className="vd-session-fact">
                      <span className="vd-fact-key">{t("virtualDisplay.session.size")}</span>
                      {session.size}
                    </span>
                  ) : null}
                  {session.package ? (
                    <span className="vd-session-fact is-wide" data-tip={session.package}>
                      <span className="vd-fact-key">
                        {t("virtualDisplay.session.appPackage")}
                      </span>
                      <span className="vd-session-package">{session.package}</span>
                    </span>
                  ) : null}
                </div>

                {session.error ? (
                  <div className="vd-session-alert is-error" role="alert">
                    <CircleAlert size={12} aria-hidden="true" />
                    <span>{session.error}</span>
                  </div>
                ) : null}
                {session.warning ? (
                  <div className="vd-session-alert is-warning">
                    <ShieldAlert size={12} aria-hidden="true" />
                    <span>{session.warning}</span>
                  </div>
                ) : null}

                {active ? (
                  <>
                    <div className="vd-session-nav" aria-label={t("virtualDisplay.session.nav")}>
                      <button
                        type="button"
                        className="btn sm vd-nav-btn"
                        onClick={() => onNavigate(session, "back")}
                        disabled={navDisabled}
                        data-tip={navTip}
                      >
                        {navBusyId === session.id ? (
                          <Loader2 size={12} className="spin" />
                        ) : (
                          <ArrowLeft size={12} />
                        )}
                        {t("virtualDisplay.session.back")}
                      </button>
                      <button
                        type="button"
                        className="btn sm vd-nav-btn"
                        onClick={() => onNavigate(session, "home")}
                        disabled={navDisabled}
                        data-tip={navTip}
                      >
                        <Home size={12} />
                        {t("virtualDisplay.session.home")}
                      </button>
                      <button
                        type="button"
                        className="btn sm vd-nav-btn"
                        onClick={() => onNavigate(session, "recents")}
                        disabled={navDisabled}
                        data-tip={navTip}
                      >
                        <List size={12} />
                        {t("virtualDisplay.session.recents")}
                      </button>
                      {navUnavailable ? (
                        <span className="vd-nav-note">
                          {t("virtualDisplay.session.navUnavailableShort")}
                        </span>
                      ) : null}
                    </div>

                    <div className="vd-session-actions">
                    <button
                      className="btn sm"
                      onClick={() => onFocus(session)}
                      disabled={session.status === "stopping"}
                    >
                      <LocateFixed size={12} />
                      {t("virtualDisplay.session.focus")}
                    </button>
                    <button
                      className="btn sm"
                      onClick={() => onCapture(session)}
                      disabled={!canCapture}
                      data-tip={
                        session.status === "running"
                          ? t("virtualDisplay.session.screenshot")
                          : t("virtualDisplay.session.screenshotNotReady")
                      }
                    >
                      {capturingId === session.id ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Camera size={12} />
                      )}
                      {capturingId === session.id
                        ? t("virtualDisplay.screenshot.capturing")
                        : t("virtualDisplay.session.screenshot")}
                    </button>
                    <button
                      className="btn sm danger-ghost vd-session-close"
                      onClick={() => onClose(session)}
                      disabled={closing}
                    >
                      {closing ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Square size={12} />
                      )}
                      {closing
                        ? t("virtualDisplay.session.stopping")
                        : t("virtualDisplay.session.close")}
                    </button>
                  </div>
                  </>
                ) : (
                  <div className="vd-session-ended" role="status">
                    {t("virtualDisplay.sessions.endedHint")}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
