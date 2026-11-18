//! 「更多」面板：会话信息（连接信息）+ 会话诊断 + 结束投屏。
//!
//! 只包含真实存在且具有独立价值的次级功能（调用链路见 ToolbarApp）：
//! - 会话信息来自 `vd_session` 快照；
//! - 诊断来自 `vd_diagnostics(serial)`（真实 dumpsys display 解析）；
//! - 结束投屏来自 `vd_stop`。
//! 绝不放 Windows 原生窗口已提供的最小化/最大化/关闭。

import { Loader2, Stethoscope } from "lucide-react";

import { useLocale } from "../../../../hooks/useLocale";
import type { VdSessionStatus } from "../../../../lib/bridge";
import type { ProjectionCapabilities } from "./types";
import { sessionStatusKey } from "../format";

interface ProjectionMoreMenuProps {
  capabilities: ProjectionCapabilities;
  busyAction: string | null;
  session: {
    mode: "mirror" | "virtual";
    status: VdSessionStatus;
    size: string | null;
    package: string | null;
    app_label: string | null;
    display_id: number | null;
  };
  diagBusy: boolean;
  diagNote: string | null;
  onRunDiagnostics(): void;
  onEnd(): void;
}

export function ProjectionMoreMenu({
  capabilities,
  busyAction,
  session,
  diagBusy,
  diagNote,
  onRunDiagnostics,
  onEnd,
}: ProjectionMoreMenuProps) {
  const { t } = useLocale();

  return (
    <div className="projection-more-menu" role="menu" aria-label={t("projectionToolbar.more")}>
      <dl className="projection-more-facts">
        <dt>{t("projectionToolbar.mode")}</dt>
        <dd>
          {t(
            session.mode === "mirror"
              ? "virtualDisplay.mode.mirror"
              : "virtualDisplay.mode.virtual",
          )}
        </dd>
        <dt>{t("projectionToolbar.status")}</dt>
        <dd>{t(sessionStatusKey(session.status))}</dd>
        {session.size ? (
          <>
            <dt>{t("projectionToolbar.resolution")}</dt>
            <dd>{session.size}</dd>
          </>
        ) : null}
        {session.package ? (
          <>
            <dt>{t("projectionToolbar.app")}</dt>
            <dd className="is-wrap">{session.app_label ?? session.package}</dd>
          </>
        ) : null}
        {session.display_id !== null ? (
          <>
            <dt>{t("projectionToolbar.display")}</dt>
            <dd>{session.display_id}</dd>
          </>
        ) : null}
      </dl>

      <button
        type="button"
        className="projection-more-action"
        role="menuitem"
        onClick={onRunDiagnostics}
        disabled={diagBusy}
      >
        {diagBusy ? (
          <Loader2 size={14} className="spin" aria-hidden="true" />
        ) : (
          <Stethoscope size={14} aria-hidden="true" />
        )}
        {t("projectionToolbar.diagnostics")}
      </button>
      {diagNote ? (
        <div className="projection-more-diag" role="status">
          {diagNote}
        </div>
      ) : null}

      <button
        type="button"
        className="projection-more-action is-danger"
        role="menuitem"
        disabled={!capabilities.close || Boolean(busyAction)}
        onClick={onEnd}
      >
        {t("projectionToolbar.close")}
      </button>
    </div>
  );
}
