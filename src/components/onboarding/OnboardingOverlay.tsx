//! 首次使用引导（页内卡片形态，非全屏 Modal）。
//!
//! 可见性门控（本组件自行判定，App.tsx 只挂载一次）：
//! - 仅完整模式（mode=full）且设置已加载；停靠/胶囊期随 dock-app inert，
//!   这里再显式排除，避免卡片浮在胶囊轨道上；
//! - store.open（首次使用 / 未完成未跳过 / 从帮助中心重开）。
//!
//! Escape 经 overlayStack（sublayer 层）：一次按键只关本卡片，等价「跳过」。
//! 引导不写入任何业务数据：第 2/3 步的按钮只做页面跳转。

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import { useOnboardingStore, ONBOARDING_STEP_COUNT } from "../../store/useOnboardingStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useUiStore } from "../../store/useUiStore";
import { resolveWindowMode } from "../../lib/windowMode";
import { isCapsuleMode } from "../../lib/edgeSnap";
import { useOverlayLayer } from "../ui/overlay";
import type { MessageKey } from "../../i18n/messages";
import "./onboarding.css";

const TITLE_KEYS: readonly MessageKey[] = [
  "onboarding.title.1",
  "onboarding.title.2",
  "onboarding.title.3",
];
const BODY_KEYS: readonly MessageKey[] = [
  "onboarding.body.1",
  "onboarding.body.2",
  "onboarding.body.3",
];

export default function OnboardingOverlay() {
  const { t } = useLocale();
  const open = useOnboardingStore((s) => s.open);
  const hydrated = useOnboardingStore((s) => s.hydrated);
  const step = useOnboardingStore((s) => s.step);
  const hydrate = useOnboardingStore((s) => s.hydrate);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const skip = useOnboardingStore((s) => s.skip);
  const finish = useOnboardingStore((s) => s.finish);
  const setTab = useUiStore((s) => s.setTab);

  const settings = useSettingsStore((s) => s.settings);
  const snapPhase = useEdgeSnapStore((s) => s.phase);
  const mode = resolveWindowMode(settings?.mode);
  const capsuleMode = isCapsuleMode(snapPhase);
  // 设置未加载完成前不展示：避免紧凑/极简用户在启动瞬间看到闪现
  const visible = hydrated && open && settings !== null && mode === "full" && !capsuleMode;

  // 启动决定一次是否自动展示（store 内部幂等，重复调用无害）
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Escape 经全局弹层栈：栈里还有更高层（菜单/对话框）时先关它们
  const rootRef = useRef<HTMLDivElement | null>(null);
  useOverlayLayer("sublayer", visible, () => skip(), rootRef);

  if (!visible) return null;

  const isLast = step === ONBOARDING_STEP_COUNT - 1;

  return (
    <div ref={rootRef} className="onboarding-card" role="region" aria-label={t("onboarding.label")}>
      <div className="onboarding-head">
        <span className="onboarding-step-label">
          {t("onboarding.stepOf", { current: step + 1, total: ONBOARDING_STEP_COUNT })}
        </span>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={t("onboarding.closeAria")}
          data-tip={t("onboarding.closeAria")}
          onClick={skip}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <h2 className="onboarding-title">{t(TITLE_KEYS[step])}</h2>
      <p className="onboarding-body">{t(BODY_KEYS[step])}</p>
      {step === 1 && (
        <div className="onboarding-step-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setTab("tasks");
              next();
            }}
          >
            {t("onboarding.goTasks")}
          </button>
        </div>
      )}
      {step === 2 && (
        <div className="onboarding-step-actions">
          <button type="button" className="btn sm" onClick={() => setTab("settings")}>
            {t("onboarding.openSettings")}
          </button>
        </div>
      )}
      <div className="onboarding-actions">
        {step > 0 && (
          <button type="button" className="btn sm" onClick={back}>
            {t("onboarding.back")}
          </button>
        )}
        <span className="flex-spacer" />
        <button type="button" className="onboarding-skip" onClick={skip}>
          {t("onboarding.skip")}
        </button>
        {isLast ? (
          <button type="button" className="btn sm onboarding-primary" onClick={finish}>
            {t("onboarding.finish")}
          </button>
        ) : (
          <button type="button" className="btn sm onboarding-primary" onClick={next}>
            {t("onboarding.next")}
          </button>
        )}
      </div>
      <p className="onboarding-hint">{t("onboarding.hintRerun")}</p>
    </div>
  );
}
