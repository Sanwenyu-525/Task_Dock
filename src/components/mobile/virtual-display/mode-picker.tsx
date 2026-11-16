//! 投屏模式选择：两张完整语义卡片，不依赖颜色区分。
//!
//! 镜像模式不需要应用与分辨率；虚拟屏模式才展开配置。已有会话时只提示
//! 「切换不影响正在运行的窗口」，绝不关闭窗口。

import { AppWindow, Check, MonitorSmartphone } from "lucide-react";

import type { VdMode } from "../../../lib/bridge";
import type { Translate } from "./format";

export interface ModePickerProps {
  mode: VdMode;
  busy: boolean;
  virtualSupported: boolean;
  activeCount: number;
  t: Translate;
  onModeChange: (mode: VdMode) => void;
}

export default function ModePicker({
  mode,
  busy,
  virtualSupported,
  activeCount,
  t,
  onModeChange,
}: ModePickerProps) {
  const virtualDisabled = busy || !virtualSupported;

  return (
    <section className="vd-block vd-mode-block" aria-label={t("virtualDisplay.mode.title")}>
      <div className="vd-block-head">
        <h3 className="vd-block-title">{t("virtualDisplay.mode.title")}</h3>
        {activeCount > 0 ? (
          <span className="vd-block-note">{t("virtualDisplay.mode.activeNote")}</span>
        ) : null}
      </div>
      <div className="vd-mode-grid" role="group" aria-label={t("virtualDisplay.mode.title")}>
        <button
          type="button"
          className={`vd-mode-card${mode === "mirror" ? " is-selected" : ""}`}
          aria-pressed={mode === "mirror"}
          onClick={() => onModeChange("mirror")}
          disabled={busy}
        >
          <span className="vd-mode-icon" aria-hidden="true">
            <MonitorSmartphone size={20} />
          </span>
          <span className="vd-mode-main">
            <span className="vd-mode-title">{t("virtualDisplay.mode.mirrorName")}</span>
            <span className="vd-mode-desc">{t("virtualDisplay.mode.mirrorDesc")}</span>
            <span className="vd-mode-use">{t("virtualDisplay.mode.mirrorUse")}</span>
          </span>
          <span className="vd-mode-state" aria-hidden="true">
            {mode === "mirror" ? <Check size={14} /> : null}
          </span>
        </button>

        <button
          type="button"
          className={`vd-mode-card${mode === "virtual" ? " is-selected" : ""}`}
          aria-pressed={mode === "virtual"}
          onClick={() => onModeChange("virtual")}
          disabled={virtualDisabled}
        >
          <span className="vd-mode-icon" aria-hidden="true">
            <AppWindow size={20} />
          </span>
          <span className="vd-mode-main">
            <span className="vd-mode-title">{t("virtualDisplay.mode.virtualName")}</span>
            <span className="vd-mode-desc">{t("virtualDisplay.mode.virtualDesc")}</span>
            <span className="vd-mode-use">{t("virtualDisplay.mode.virtualUse")}</span>
            {!virtualSupported ? (
              <span className="vd-mode-unavailable">
                {t("virtualDisplay.mode.unavailable")}
              </span>
            ) : null}
          </span>
          <span className="vd-mode-state" aria-hidden="true">
            {mode === "virtual" ? <Check size={14} /> : null}
          </span>
        </button>
      </div>
    </section>
  );
}
