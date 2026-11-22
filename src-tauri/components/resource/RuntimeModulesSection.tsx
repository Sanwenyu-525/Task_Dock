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
//!
//! 2026-11-14：默认只显示「图标 + 名称 + 状态 + 一行说明」，运行范围、后台活动
//! 明细与控制方式放进行内详情；分组仍可折叠，状态仍只来自生命周期 Store。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Archive,
  Bell,
  ChevronDown,
  ChevronRight,
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

const CATEGORY_NOTE: Record<LifecycleCategory, MessageKey> = {
  resident: "resource.modules.category.resident",
  task: "resource.modules.category.task",
  shared: "resource.modules.category.shared",
  ondemand: "resource.modules.category.ondemand",
};

const CONTROL_LABEL: Record<LifecycleCategory, MessageKey> = {
  resident: "resource.modules.controlResident",
  task: "resource.modules.controlTask",
  shared: "resource.modules.controlShared",
  ondemand: "resource.modules.controlOndemand",
};

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
  /** 只默认折叠纯按需分组：常驻/任务/共享仍直接可见，避免把功能藏起来。 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<LifecycleCategory>>(
    () => new Set<LifecycleCategory>(["ondemand"]),
  );
  /** 行内详情按模块 ID 记忆：状态刷新或排序不会丢失展开态。 */
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());

  function toggleGroup(category: LifecycleCategory) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function toggleRow(moduleId: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  }

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
        <h3 id="runtime-section-title">{t("resource.modules.title")}</h3>
        {statuses && (
          <span className="runtime-section-count">
            {t("resource.modules.count", { count: statuses.length })}
          </span>
        )}
        <p data-tip={t("resource.modules.desc")}>{t("resource.modules.desc")}</p>
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

      {/* 快照过期/读取失败：旧状态只能作为参考，不能继续显示成已验证的实时状态。 */}
      {statuses && stale && (
        <div className="runtime-section-stale" role="status" data-runtime-stale="true">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>
            {t(
              loading
                ? "resource.modules.refreshingState"
                : error
                  ? "resource.modules.staleFailed"
                  : "resource.modules.stale",
            )}
          </span>
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
          const groupOpen = !collapsed.has(group.id);
          return (
            <div className="runtime-group" key={group.id}>
              <h4 className="runtime-group-title">
                <button
                  type="button"
                  className="runtime-group-toggle"
                  aria-expanded={groupOpen}
                  onClick={() => toggleGroup(group.id)}
                >
                  <ChevronRight
                    size={12}
                    className={`runtime-group-chevron${groupOpen ? " is-open" : ""}`}
                    aria-hidden="true"
                  />
                  <span>{t(group.label)}</span>
                  <span className="runtime-group-count">{items.length}</span>
                </button>
              </h4>
              <ul className="runtime-list" hidden={!groupOpen}>
                {items.map((item) => {
                  const presentation = presentationFor(item.id);
                  const Icon = presentation ? ICONS[presentation.icon] : Activity;
                  const stateLabel = LIFECYCLE_STATE_LABEL[item.state]
                    ? t(LIFECYCLE_STATE_LABEL[item.state] as MessageKey)
                    : item.state;
                  const errorKey = item.error
                    ? LIFECYCLE_ERROR_LABELS[item.error]
                    : undefined;
                  const unverified = stale && Boolean(statuses);
                  const rowOpen = expandedRows.has(item.id);
                  const name = presentation ? t(presentation.label) : item.id;
                  const scopeText = presentation ? t(presentation.scope) : null;
                  const backgroundText =
                    item.background.length > 0
                      ? item.background
                          .map((flag) =>
                            BACKGROUND_LABELS[flag] ? t(BACKGROUND_LABELS[flag]) : flag,
                          )
                          .join(" · ")
                      : t("resource.modules.detailNone");
                  return (
                    <li
                      key={item.id}
                      className={`runtime-row tone-${stateTone(item.state)}${
                        unverified ? " is-unverified" : ""
                      }${rowOpen ? " is-open" : ""}`}
                      data-module-id={item.id}
                    >
                      <button
                        type="button"
                        className="runtime-row-toggle"
                        aria-expanded={rowOpen}
                        onClick={() => toggleRow(item.id)}
                      >
                        <span className="runtime-icon" aria-hidden="true">
                          <Icon size={15} />
                        </span>
                        <span className="runtime-main">
                          <span className="runtime-title">
                            <strong data-tip={name}>{name}</strong>
                            <span className={`runtime-state tone-${stateTone(item.state)}`}>
                              <i aria-hidden="true" /> {stateLabel}
                              {unverified && (
                                <em className="runtime-state-unverified">
                                  {t("resource.modules.unverified")}
                                </em>
                              )}
                            </span>
                            {item.background.length > 0 && (
                              <span
                                className="runtime-bg-badge on"
                                data-tip={backgroundText}
                              >
                                {t("resource.modules.backgroundOn")}
                              </span>
                            )}
                          </span>
                          {scopeText && (
                            <span className="runtime-scope" data-tip={scopeText}>
                              {scopeText}
                            </span>
                          )}
                        </span>
                        <ChevronDown
                          size={13}
                          className={`runtime-row-chevron${rowOpen ? " is-open" : ""}`}
                          aria-hidden="true"
                        />
                      </button>
                      <div className="runtime-action">
                        {item.controllable ? (
                          <ModuleRunControl moduleId={item.id} variant="button" />
                        ) : (
                          <span className="runtime-managed">
                            {t(
                              item.category === "shared"
                                ? "resource.modules.sharedManaged"
                                : item.category === "task"
                                  ? "resource.modules.taskManaged"
                                  : "resource.modules.managed",
                            )}
                          </span>
                        )}
                      </div>
                      {rowOpen && (
                        <div className="runtime-row-detail">
                          <dl className="runtime-detail-grid">
                            <div>
                              <dt>{t("resource.modules.detailScope")}</dt>
                              <dd>{scopeText ?? t("resource.modules.detailNone")}</dd>
                            </div>
                            <div>
                              <dt>{t("resource.modules.detailBackground")}</dt>
                              <dd>{backgroundText}</dd>
                            </div>
                            <div>
                              <dt>{t("resource.modules.detailControl")}</dt>
                              <dd>{t(CONTROL_LABEL[item.category])}</dd>
                            </div>
                          </dl>
                          <p className="runtime-category-note">{t(CATEGORY_NOTE[item.category])}</p>
                          {item.error && (
                            <p className="runtime-error" role="status">
                              {errorKey ? t(errorKey) : item.error}
                            </p>
                          )}
                        </div>
                      )}
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
