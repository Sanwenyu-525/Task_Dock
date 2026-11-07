//! 模块级暂停/恢复按钮（完整页标题栏与资源管理共用）。
//!
//! - 图标语义：运行/恢复中显示 Pause（点击暂停）；暂停/收尾中显示 Play（点击恢复）；
//! - 操作中显示 Loader 并禁用，避免快速连点制造多条并发意图；
//! - 暂停/恢复经 `useLifecycleStore` 写入既有设置键，**不新增第二套状态**；
//! - 失败按真实错误提示，不把「已发请求」当成「已停止」。

import { useEffect } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { useLifecycleStore } from "../../store/useLifecycleStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import {
  controlFor,
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
  // 首帧用设置派生意图；快照到达后以 intent 为准（实际状态另由 state 表达）。
  const paused = status
    ? status.intent === "paused"
    : modulePausedFromSettings(moduleId, settings);
  const transitioning = status?.state === "pausing";
  const busy = pending;
  const disabled = !settings;

  const aria = t(paused ? "lifecycle.resumeAria" : "lifecycle.pauseAria", { module: label });
  const errorCode = moduleError ?? status?.error ?? null;
  const errorKey = errorCode ? LIFECYCLE_ERROR_LABELS[errorCode] : undefined;
  const errorText = errorCode ? (errorKey ? t(errorKey) : errorCode) : null;
  // 悬停提示必须说明“暂停后会停止什么”，运行异常也一并如实展示。
  const tip = errorText ? `${aria} · ${scope} · ${errorText}` : `${aria} · ${scope}`;

  async function onClick() {
    const ok = await setPaused(moduleId, !paused);
    if (!ok) {
      const reason = useLifecycleStore.getState().errors[moduleId];
      showToast(
        t("lifecycle.actionFailed", {
          module: label,
          error: reason || t("errors.UNKNOWN_ERROR"),
        }),
        { kind: "error" },
      );
    }
  }

  const icon = busy || transitioning ? (
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
        <span>{t(paused ? "lifecycle.resume" : "lifecycle.pause")}</span>
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
