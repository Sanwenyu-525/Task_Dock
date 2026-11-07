//! 资源管理 → 功能运行：集中查看/暂停各模块的后台生命周期。
//!
//! 数据来自后端 `lifecycle_status` 的只读批量快照；用户意图仍写既有设置键
//! （见 `lib/lifecycle.ts`），本分区不持有第二份暂停状态。
//!
//! 显示规则：
//! - resident：常驻后台，提供暂停/恢复；
//! - task：任务级能力，暂停属于具体运行中的任务（如工作流/专注）；
//! - shared：共享基础设施，明确说明「停止会丢失什么」，不提供模块级按钮；
//! - ondemand：纯按需执行，显示状态但不造无效暂停按钮。

import { useEffect, useMemo, useRef } from "react";
import {
  Activity,
  AppWindow,
  Archive,
  Bell,
  Clipboard,
  FileText,
  History,
  Inbox,
  Keyboard,
  Layers,
  LayoutGrid,
  Map as MapIcon,
  Plug,
  RefreshCw,
  ScanText,
  Timer,
  Volume2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useLifecycleStore } from "../../store/useLifecycleStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { LIFECYCLE_STATE_LABEL } from "../../lib/lifecycle";
import {
  BACKGROUND_LABELS,
  LIFECYCLE_ERROR_LABELS,
  presentationFor,
  type ModuleIcon,
} from "../../lib/lifecycleCatalog";
import type { LifecycleCategory, ModuleRuntimeStatus } from "../../lib/bridge";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import ModuleRunControl from "../lifecycle/ModuleRunControl";

const ICONS: Record<ModuleIcon, LucideIcon> = {
  clipboard: Clipboard,
  shelf: Archive,
  bell: Bell,
  activity: Activity,
  volume: Volume2,
  plug: Plug,
  "file-text": FileText,
  keyboard: Keyboard,
  workflow: Workflow,
  timer: Timer,
  archive: Archive,
  layers: Layers,
  "layout-grid": LayoutGrid,
  "app-window": AppWindow,
  history: History,
  map: MapIcon,
  "scan-text": ScanText,
  inbox: Inbox,
};

const GROUPS: { id: LifecycleCategory; label: MessageKey }[] = [
  { id: "resident", label: "resource.modules.group.resident" },
  { id: "task", label: "resource.modules.group.task" },
  { id: "shared", label: "resource.modules.group.shared" },
  { id: "ondemand", label: "resource.modules.group.ondemand" },
];

function stateTone(state: string): string {
  switch (state) {
    case "running":
    case "idle":
      return "ok";
    case "pausing":
    case "stopping":
      return "warn";
    case "error":
      return "bad";
    default:
      return "off";
  }
}

/**
 * 设置中与生命周期相关的字段：任一变化就重查实际状态。
 *
 * 只订阅这几个键而不是整个 settings 对象：切换主题/字号不会触发无意义的
 * 状态查询；查询本身单飞合并，多个入口同时修改也只产生一次 IPC。
 */
function lifecycleSettingsKey(settings: ReturnType<typeof useSettingsStore.getState>["settings"]) {
  if (!settings) return "";
  return [
    settings.clipboard_enabled,
    settings.clipboard_paused,
    settings.reminders_paused,
    settings.shelf_auto_cleanup_enabled,
    settings.actions_enabled,
    settings.actions_paused,
    settings.tts_enabled,
    settings.audio_sound_enabled,
  ].join("|");
}

export default function RuntimeModulesSection({ active = true }: { active?: boolean }) {
  const { t } = useLocale();
  const statuses = useLifecycleStore((s) => s.statuses);
  const loading = useLifecycleStore((s) => s.loading);
  const error = useLifecycleStore((s) => s.error);
  const refresh = useLifecycleStore((s) => s.refresh);
  const stale = useLifecycleStore((s) => s.stale);
  const settings = useSettingsStore((s) => s.settings);
  const settingsKey = lifecycleSettingsKey(settings);
  /** 上次真正查询时使用的设置键：隐藏期间不更新，重新显示后必然重查一次。 */
  const queriedKeyRef = useRef<string | null>(null);

  // 只在分区可见时查询：首次显示、重新显示、可见期间相关设置变化。
  // 隐藏时不因任何设置变化发请求；没有轮询与常驻定时器。
  // `stale` 由设置 Store 的跨入口变化推进（含设置页/模块页），本分区只负责
  // “可见时收敛”；请求代际由 useLifecycleStore.refresh 保证旧响应不覆盖新状态。
  useEffect(() => {
    if (!active) {
      // 隐藏期间设置可能变化，清空水位让下次显示重新读取真实状态。
      queriedKeyRef.current = null;
      return;
    }
    if (queriedKeyRef.current === settingsKey && !stale) return;
    queriedKeyRef.current = settingsKey;
    void refresh();
  }, [active, refresh, settingsKey, stale]);

  const grouped = useMemo(() => {
    if (!statuses) return null;
    const map = new Map<LifecycleCategory, ModuleRuntimeStatus[]>();
    for (const item of statuses) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return map;
  }, [statuses]);

  return (
    <section className="runtime-section" aria-labelledby="runtime-section-title">
      <header className="runtime-section-head">
        <div>
          <h3 id="runtime-section-title">{t("resource.modules.title")}</h3>
          <p>{t("resource.modules.desc")}</p>
        </div>
      </header>

      {error && (
        <div className="runtime-section-error" role="alert">
          <p>{t("resource.modules.error", { error })}</p>
          {/* 失败时的局部重试；正常刷新统一走页头，不设第二个常驻刷新按钮。 */}
          <button type="button" className="btn sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={12} className={loading ? "spin" : undefined} aria-hidden="true" />{" "}
            {t("common.retry")}
          </button>
        </div>
      )}

      {!grouped && loading && (
        <p className="runtime-section-loading" role="status">
          {t("resource.reading")}
        </p>
      )}

      {grouped &&
        GROUPS.map((group) => {
          const items = grouped.get(group.id);
          if (!items || items.length === 0) return null;
          return (
            <div className="runtime-group" key={group.id}>
              <h4 className="runtime-group-title">{t(group.label)}</h4>
              <ul className="runtime-list">
                {items.map((item) => {
                  const presentation = presentationFor(item.id);
                  const Icon = presentation ? ICONS[presentation.icon] : Activity;
                  const stateLabel = LIFECYCLE_STATE_LABEL[item.state]
                    ? t(LIFECYCLE_STATE_LABEL[item.state] as MessageKey)
                    : item.state;
                  const errorKey = item.error
                    ? LIFECYCLE_ERROR_LABELS[item.error]
                    : undefined;
                  return (
                    <li
                      key={item.id}
                      className={`runtime-row tone-${stateTone(item.state)}`}
                      data-module-id={item.id}
                    >
                      <span className="runtime-icon" aria-hidden="true">
                        <Icon size={14} />
                      </span>
                      <div className="runtime-main">
                        <div className="runtime-title">
                          <strong>
                            {presentation ? t(presentation.label) : item.id}
                          </strong>
                          <span className={`runtime-state tone-${stateTone(item.state)}`}>
                            <i aria-hidden="true" /> {stateLabel}
                          </span>
                          <span
                            className={`runtime-bg-badge${item.background.length > 0 ? " on" : ""}`}
                          >
                            {t(
                              item.background.length > 0
                                ? "resource.modules.backgroundOn"
                                : "resource.modules.backgroundOff",
                            )}
                          </span>
                        </div>
                        {presentation && (
                          <p className="runtime-scope">{t(presentation.scope)}</p>
                        )}
                        {item.background.length > 0 && (
                          <p className="runtime-bg-list">
                            {item.background
                              .map((flag) =>
                                BACKGROUND_LABELS[flag] ? t(BACKGROUND_LABELS[flag]) : flag,
                              )
                              .join(" · ")}
                          </p>
                        )}
                        {item.error && (
                          <p className="runtime-error" role="status">
                            {errorKey ? t(errorKey) : item.error}
                          </p>
                        )}
                      </div>
                      <div className="runtime-action">
                        {item.controllable ? (
                          <ModuleRunControl moduleId={item.id} variant="button" />
                        ) : (
                          <span className="runtime-managed">
                            {t(
                              item.category === "shared"
                                ? "resource.modules.sharedManaged"
                                : "resource.modules.managed",
                            )}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

      <p className="setting-note runtime-section-footnote">
        {t("resource.modules.footnote")}
      </p>
    </section>
  );
}
