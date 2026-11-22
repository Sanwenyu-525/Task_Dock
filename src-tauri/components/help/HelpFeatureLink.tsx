//! 相关功能跳转行：功能标题 + 状态徽标 +（可用时）跳转按钮。
//!
//! 状态处理（不做死链接）：
//! - planned / blocked：只显示状态提示，不提供跳转；
//! - partial：提供跳转，同时显示「部分实现」徽标；
//! - implemented：提供跳转；对应导航入口被用户隐藏时，附提示说明
//!   （页面仍可从「更多」打开，跳转依然有效，如实说明而非伪装直达）。
//! 「行动」入口在行动中心被整体关闭时同样附提示（跳转有效但页面为关闭态）。

import { ArrowRight } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import { getFeatureById, type FeatureStatus } from "../../lib/featureCatalog";
import { navEntry, navLabel } from "../../lib/navigationRegistry";
import { useNavigationLayout } from "../../lib/navigationLayout";
import { useUiStore } from "../../store/useUiStore";
import { useActionsStore } from "../../store/useActionsStore";
import { StatusBadge, type StatusTone } from "../ui";
import type { MessageKey } from "../../i18n/messages";

const FEATURE_STATUS_META: Record<
  Exclude<FeatureStatus, "implemented">,
  { labelKey: MessageKey; tone: StatusTone }
> = {
  partial: { labelKey: "help.featurePartial", tone: "info" },
  planned: { labelKey: "help.featurePlanned", tone: "neutral" },
  blocked: { labelKey: "help.featureBlocked", tone: "warning" },
};

export interface HelpFeatureLinkProps {
  featureId: string;
  /** 跳转目标：文章登记的相关页面入口 ID（必须存在于 navigationRegistry，契约测试兜底） */
  routeId?: string;
}

export default function HelpFeatureLink({ featureId, routeId }: HelpFeatureLinkProps) {
  const { t } = useLocale();
  const setTab = useUiStore((s) => s.setTab);
  // 行动中心整体关闭时「行动」页是关闭态：跳转仍有效，但如实提示
  const actionsEnabled = useActionsStore((s) => s.feed?.enabled !== false);
  // 左侧导航可见入口（设置派生）：用于「入口已隐藏」提示
  const layout = useNavigationLayout();

  const feature = getFeatureById(featureId);
  if (!feature) return null;

  const entry = routeId ? navEntry(routeId) : undefined;
  const label = entry ? navLabel(entry, t) : routeId ?? "";
  const statusMeta =
    feature.status === "implemented" ? null : FEATURE_STATUS_META[feature.status];
  // planned / blocked 不提供跳转（死链接）；implemented / partial 可跳转
  const jumpable =
    Boolean(entry) && feature.status !== "planned" && feature.status !== "blocked";

  const hints: string[] = [];
  if (statusMeta && (feature.status === "planned" || feature.status === "blocked")) {
    hints.push(
      `${t(statusMeta.labelKey)}：${t("help.featureUnavailableHint")}`,
    );
  }
  if (jumpable && entry && !layout.left.includes(entry.id)) {
    hints.push(t("help.featureHidden"));
  }
  if (jumpable && entry?.id === "actions" && !actionsEnabled) {
    hints.push(t("help.featureHidden"));
  }

  return (
    <div className="help-related-row">
      <span className="help-meta-text">{feature.title}</span>
      {statusMeta && (
        <StatusBadge
          tone={statusMeta.tone}
          size="sm"
          dataTip={t("help.statusHintAria", { status: t(statusMeta.labelKey) })}
        >
          {t(statusMeta.labelKey)}
        </StatusBadge>
      )}
      {jumpable && entry && (
        <button
          type="button"
          className="btn sm"
          aria-label={t("help.goToPage", { label })}
          onClick={() => setTab(entry.tabs[0])}
        >
          {t("help.goToPage", { label })}
          <ArrowRight size={12} aria-hidden="true" style={{ marginLeft: 4 }} />
        </button>
      )}
      {hints.map((hint, i) => (
        <span key={i} className="help-route-hint" role="note">
          {hint}
        </span>
      ))}
    </div>
  );
}
