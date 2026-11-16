//! 截图预览：先确认文件可读/可显示，再允许加入暂存架或另存。
//!
//! 后端已校验 PNG 可解码与尺寸；这里再验证浏览器能否真正显示（防破图/空图）。
//! 启发式质量警告只提示，不伪装成确定性失败。

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Image as ImageIcon, Loader2, ShieldAlert } from "lucide-react";

import type { VdScreenshot, VdSession } from "../../../lib/bridge";
import { Dialog } from "../../ui";
import { formatLocalStamp } from "../../../lib/format";
import { sessionTitle, type Translate } from "./format";

export interface ScreenshotPreviewProps {
  session: VdSession;
  shot: VdScreenshot;
  busy: boolean;
  t: Translate;
  onSaveShelf: () => void;
  onSaveAs: () => void;
  onDiscard: () => void;
}

export default function ScreenshotPreview({
  session,
  shot,
  busy,
  t,
  onSaveShelf,
  onSaveAs,
  onDiscard,
}: ScreenshotPreviewProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
    setLoaded(false);
  }, [shot.path]);

  const stamp = formatLocalStamp(shot.captured_at);
  const capturedAt = stamp ? `${stamp.date} ${stamp.time}` : shot.captured_at;
  const source = sessionTitle(session, session.device_model ?? "Android", t);

  return (
    <Dialog
      open
      onClose={onDiscard}
      title={t("virtualDisplay.screenshot.title")}
      size="lg"
      footer={
        <div className="btn-row vd-shot-actions">
          <button
            className="btn sm vd-shot-primary"
            onClick={onSaveShelf}
            disabled={busy || loadFailed || !loaded}
            data-tip={
              loadFailed ? t("virtualDisplay.screenshot.unreadable") : undefined
            }
          >
            {busy ? <Loader2 size={12} className="spin" /> : <ImageIcon size={12} />}
            {t("virtualDisplay.screenshot.saveShelf")}
          </button>
          <button
            className="btn sm"
            onClick={onSaveAs}
            disabled={busy || loadFailed || !loaded}
          >
            {t("virtualDisplay.screenshot.saveAs")}
          </button>
          <button className="btn sm" onClick={onDiscard} disabled={busy}>
            {t("virtualDisplay.screenshot.discard")}
          </button>
        </div>
      }
    >
      {shot.warning ? (
        <div className="vd-alert is-warning" role="status">
          <ShieldAlert size={13} aria-hidden="true" />
          <div className="vd-alert-body">
            <strong>{t("virtualDisplay.screenshot.warningTitle")}</strong>
            <span>{t("virtualDisplay.screenshot.warningHint")}</span>
            <span className="vd-alert-detail">{shot.warning}</span>
          </div>
        </div>
      ) : null}

      <div className="vd-shot-wrap">
        {loadFailed ? (
          <div className="vd-shot-error" role="alert">
            {t("virtualDisplay.screenshot.unreadable")}
          </div>
        ) : (
          <img
            className="vd-shot-image"
            src={convertFileSrc(shot.path)}
            alt={t("virtualDisplay.screenshot.title")}
            onLoad={() => setLoaded(true)}
            onError={() => setLoadFailed(true)}
          />
        )}
        {!loaded && !loadFailed ? (
          <span className="vd-shot-loading" role="status">
            <Loader2 size={14} className="spin" aria-hidden="true" />
            {t("virtualDisplay.screenshot.loading")}
          </span>
        ) : null}
      </div>

      <dl className="vd-fact-grid vd-shot-facts">
        <dt>{t("virtualDisplay.screenshot.source")}</dt>
        <dd>{source}</dd>
        <dt>{t("virtualDisplay.screenshot.capturedAt")}</dt>
        <dd>{capturedAt}</dd>
        <dt>{t("virtualDisplay.screenshot.size")}</dt>
        <dd>
          {shot.width} × {shot.height}
        </dd>
      </dl>
      <div className="vd-hint">{t("virtualDisplay.screenshot.privacy")}</div>
    </Dialog>
  );
}
