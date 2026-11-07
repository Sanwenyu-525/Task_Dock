//! 模块级暂停/恢复按钮（完整页标题栏与资源管理共用）。
//!
//! - 图标语义：运行/恢复中显示 Pause（点击暂停）；暂停/收尾中显示 Play（点击恢复）；
//! - 操作中显示 Loader 并禁用，避免快速连点制造多条并发意图；
//! - 暂停/恢复经 `useLifecycleStore` 写入既有设置键，**不新增第二套状态**；
//! - 失败按真实错误提示，不把「已发请求」当成「已停止」。

import { useEffect } from "react";
import { Loader2, Pause, Play, Power } from "lucide-react";
import { useLifecycleStore } from "../../store/useLifecycleStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import {
  controlFor,
  moduleDisabledFromSettings,
  modulePausedFromSettings,
  moduleStatusById,
} from "../../lib/lifecycle";
import { LIFECYCLE_ERROR_LABELS, presentationFor } from "../../lib/lifecycleCatalog";
import { useLocale } from "../../hooks/useLocale";

interface Props {
  moduleId: string;
  /** icon：标题栏紧凑图标；button：资源管理行内带文字按钮 */
  variant?: "icon" | "button";
  className?: string;
}

export default function ModuleRunControl({ moduleId, variant = "icon", className }: Props) {
  const { t } = useLocale();
  const presentation = presentationFor(moduleId);
  const control = controlFor(moduleId);
  const status = useLifecycleStore((s) => moduleStatusById(s.statuses, moduleId));
  const pending = useLifecycleStore((s) => Boolean(s.pending[moduleId]));
  const moduleError = useLifecycleStore((s) => s.errors[moduleId] ?? null);
  const setPaused = useLifecycleStore((s) => s.setPaused);
  const refresh = useLifecycleStore((s) => s.refresh);
  const settings = useSettingsStore((s) => s.settings);
  const showToast = useUiStore((s) => s.showToast);

  // 页面首次挂载时补一次实际状态：DeferredView 保活后不会重复挂载，
  // 因此这里不是轮询，也不会随每次操作重复注册。
  useEffect(() => {
    if (!useLifecycleStore.getState().statuses) void refresh();
  }, [refresh]);

  // 未登记控制键（共享基础设施/按需模块）不渲染按钮，避免无效开关。
  if (!presentation || !control) return null;

  const label = t(presentation.label);
  const scope = t(presentation.scope);
  // **意图只从设置派生**：其他入口（设置页/资源管理/胶囊）写入后立即同步，
  // 不依赖可能过期的快照 intent；快照只用于过渡态与真实错误。
  const paused = modulePausedFromSettings(moduleId, settings);
  const moduleDisabled = moduleDisabledFromSettings(moduleId, settings);
  const transitioning = status?.state === "pausing" || status?.state === "stopping";
  const busy = pending;
  const disabled = !settings || moduleDisabled;

  const aria = moduleDisabled
    ? t("lifecycle.moduleDisabledAria", { module: label })
    : t(paused ? "lifecycle.resumeAria" : "lifecycle.pauseAria", { module: label });
  const errorCode = moduleError ?? status?.error ?? null;
  const errorKey = errorCode ? LIFECYCLE_ERROR_LABELS[errorCode] : undefined;
  const errorText = errorCode ? (errorKey ? t(errorKey) : errorCode) : null;
  // 停用态必须明确说“需要先启用”，不能提供只会改暂停字段的假恢复按钮。
  // 悬停提示同时说明暂停范围与运行异常。
  const baseTip = moduleDisabled ? t("lifecycle.moduleDisabledTip") : `${aria} · ${scope}`;
  const tip = errorText ? `${baseTip} · ${errorText}` : baseTip;

  async function onClick() {
    if (moduleDisabled) return;
    const result = await setPaused(moduleId, !paused);
    if (result === "failed") {
      const reason = useLifecycleStore.getState().errors[moduleId];
      showToast(
        t("lifecycle.actionFailed", {
          module: label,
          error: reason || t("errors.UNKNOWN_ERROR"),
        }),
        { kind: "error" },
      );
    } else if (result === "unconfirmed") {
      // 配置已写入但状态查询失败：只说“未确认”，不冒充资源已释放。
      showToast(t("lifecycle.statusUnconfirmed", { module: label }), {
        kind: "warning",
      });
    }
  }

  const icon = moduleDisabled ? (
    <Power size={13} aria-hidden="true" />
  ) : busy || transitioning ? (
    <Loader2 size={13} className="spin" aria-hidden="true" />
  ) : paused ? (
    <Play size={13} aria-hidden="true" />
  ) : (
    <Pause size={13} aria-hidden="true" />
  );

  if (variant === "button") {
    return (
      <button
        type="button"
        className={`btn sm lifecycle-run-btn${className ? ` ${className}` : ""}`}
        data-tip={tip}
        aria-label={aria}
        aria-pressed={paused}
        disabled={disabled || busy}
        onClick={() => void onClick()}
      >
        {icon}
        <span>
          {t(
            moduleDisabled
              ? "lifecycle.state.stopped"
              : paused
                ? "lifecycle.resume"
                : "lifecycle.pause",
          )}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`icon-btn sm lifecycle-run-btn${paused ? " active" : ""}${className ? ` ${className}` : ""}`}
      data-tip={tip}
      aria-label={aria}
      aria-pressed={paused}
      disabled={disabled || busy}
      onClick={() => void onClick()}
    >
      {icon}
    </button>
  );
}
