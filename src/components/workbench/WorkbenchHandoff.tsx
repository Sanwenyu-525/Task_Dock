//! Phase D：主窗口旧完整面板的兼容入口。
//!
//! 大型管理功能只在唯一工作台（`workspace` 窗口）中提供完整界面；主窗口的
//! 完整模式保留导航位置与快捷键语义，但页面退化为「功能摘要 + 打开工作台」，
//! 不再承载第二套完整管理宿主。业务组件本身没有复制，工作台直接复用原面板。
//!
//! 打开过程必须**状态可见、失败可重试**：创建工作台 → 连接工作台 → 完成页面切换
//! 三段文案来自真实等待时长，不是装饰；失败时保留原因并给出重试与诊断入口，
//! 绝不把按钮永久停在「正在打开」。

import { useEffect, useState } from "react";
import { Activity, ExternalLink, LayoutGrid } from "lucide-react";
import { openWorkbench } from "../../lib/workbenchNav";
import { leftEntryForTab, navLabel } from "../../lib/navigationRegistry";
import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import type { WorkbenchRoute } from "../../lib/workbenchLayout";

interface Props {
  /** 工作台目标路由（与导航注册中心同一套稳定 ID）。 */
  tab: WorkbenchRoute;
}

/** 打开阶段：时间阈值与 Rust 侧「创建 → 揭示」节奏对齐（创建通常 <1.5s）。 */
const PHASE_CONNECT_MS = 2_500;
const PHASE_SWITCH_MS = 6_500;

export default function WorkbenchHandoff({ tab }: Props) {
  const { t } = useLocale();
  const entry = tab === "home" ? undefined : leftEntryForTab(tab);
  const Icon = entry?.icon ?? LayoutGrid;
  const label = entry ? navLabel(entry, t) : tab;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState(0);

  // 阶段推进只在等待期间运行；结束（成功/失败）立即回到 0，重试从头开始。
  useEffect(() => {
    if (!busy) {
      setPhase(0);
      return;
    }
    setPhase(0);
    const connect = window.setTimeout(() => setPhase(1), PHASE_CONNECT_MS);
    const switching = window.setTimeout(() => setPhase(2), PHASE_SWITCH_MS);
    return () => {
      window.clearTimeout(connect);
      window.clearTimeout(switching);
    };
  }, [busy]);

  async function open(target: WorkbenchRoute) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await openWorkbench({ tab: target });
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

  const busyLabel =
    phase === 0
      ? t("nav.workbenchPhaseCreate")
      : phase === 1
        ? t("nav.workbenchPhaseConnect")
        : t("nav.workbenchPhaseSwitch");
  const primaryLabel = busy
    ? busyLabel
    : error
      ? t("nav.retryOpenWorkbench")
      : t("nav.openInWorkbench");

  return (
    <div className="page-fill">
      <div className="page-scroll handoff-scroll">
        <div className="empty-state is-handoff" data-testid={`workbench-handoff-${tab}`}>
          <div className="empty-icon">
            <Icon size={22} strokeWidth={1.7} aria-hidden="true" />
          </div>
          <div className="empty-title">{label}</div>
          <div className="empty-hint">{t("nav.workbenchMigrated", { feature: label })}</div>
          <div className="empty-action">
            <button
              type="button"
              className="btn primary"
              onClick={() => void open(tab)}
              disabled={busy}
              aria-busy={busy}
            >
              <ExternalLink size={14} aria-hidden="true" />
              {primaryLabel}
            </button>
          </div>
          {error && (
            <>
              <div className="empty-hint error-text" role="alert">
                {error}
              </div>
              <div className="empty-action">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void open("diagnostics")}
                  disabled={busy}
                >
                  <Activity size={14} aria-hidden="true" />
                  {t("nav.openWorkbenchDiagnostics")}
                </button>
              </div>
            </>
          )}
          <div className="empty-hint">{t("nav.workbenchMigratedHint")}</div>
        </div>
      </div>
    </div>
  );
}
