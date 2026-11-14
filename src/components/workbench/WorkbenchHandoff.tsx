//! Phase D：主窗口旧完整面板的兼容入口。
//!
//! 大型管理功能只在唯一工作台（`workspace` 窗口）中提供完整界面；主窗口的
//! 完整模式保留导航位置与快捷键语义，但页面退化为「功能摘要 + 打开工作台」，
//! 不再承载第二套完整管理宿主。业务组件本身没有复制，工作台直接复用原面板。

import { useState } from "react";
import { ExternalLink, LayoutGrid } from "lucide-react";
import { openWorkbench } from "../../lib/workbenchNav";
import { leftEntryForTab, navLabel } from "../../lib/navigationRegistry";
import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import type { WorkbenchRoute } from "../../lib/workbenchLayout";

interface Props {
  /** 工作台目标路由（与导航注册中心同一套稳定 ID）。 */
  tab: WorkbenchRoute;
}

export default function WorkbenchHandoff({ tab }: Props) {
  const { t } = useLocale();
  const entry = tab === "home" ? undefined : leftEntryForTab(tab);
  const Icon = entry?.icon ?? LayoutGrid;
  const label = entry ? navLabel(entry, t) : tab;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await openWorkbench({ tab });
      // pending 表示工作台已弹出未保存确认条：窗口已就绪，不是打开失败。
      // cancelled 是用户在工作台里明确取消，不当作错误再次弹出。
      if (outcome.status === "failed") {
        setError(outcome.error ?? t("nav.openWorkbenchFailed", { error: "unknown" }));
      }
    } catch (e) {
      setError(t("nav.openWorkbenchFailed", { error: errorMessage(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-fill">
      <div className="page-scroll">
        <div className="empty-state is-framed" data-testid={`workbench-handoff-${tab}`}>
          <div className="empty-icon">
            <Icon size={22} strokeWidth={1.7} aria-hidden="true" />
          </div>
          <div className="empty-title">{label}</div>
          <div className="empty-hint">{t("nav.workbenchMigrated", { feature: label })}</div>
          <div className="empty-action">
            <button
              type="button"
              className="btn primary"
              onClick={() => void open()}
              disabled={busy}
            >
              <ExternalLink size={14} aria-hidden="true" />
              {busy ? t("nav.openingWorkbench") : t("nav.openInWorkbench")}
            </button>
          </div>
          {error && (
            <div className="empty-hint error-text" role="alert">
              {error}
            </div>
          )}
          <div className="empty-hint">{t("nav.workbenchMigratedHint")}</div>
        </div>
      </div>
    </div>
  );
}
