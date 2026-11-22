//! 设置与帮助中心共用的「重新打开新手引导」入口。

import { useLocale } from "../../hooks/useLocale";
import { useOnboardingStore } from "../../store/useOnboardingStore";
import "./onboarding.css";

export interface ReopenOnboardingButtonProps {
  className?: string;
}

export default function ReopenOnboardingButton({ className }: ReopenOnboardingButtonProps) {
  const { t } = useLocale();
  const hasNewContent = useOnboardingStore((state) => state.hasNewContent);
  const reopen = useOnboardingStore((state) => state.reopenFromHelp);

  return (
    <button
      type="button"
      className={`btn sm onboarding-reopen-btn${className ? ` ${className}` : ""}`}
      onClick={reopen}
    >
      {t("help.reopenOnboarding")}
      {hasNewContent && <span className="onboarding-reopen-dot" aria-hidden="true" />}
    </button>
  );
}
