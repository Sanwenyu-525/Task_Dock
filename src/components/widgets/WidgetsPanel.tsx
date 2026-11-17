//! 微件面板（管理中心）。
//!
//! - 「看板启用」与「桌面显示」是两条独立状态：关闭看板卡片不会销毁桌面窗口；
//! - 只挂载已启用的看板微件：停用即卸载，随之释放全部订阅与共享时钟引用；
//! - 布局由 useWidgetsStore 持久化，支持启用/停用、拖动排序、尺寸与条目配置；
//! - 桌面窗口由主窗口 `WidgetDesktopBridge` 按布局创建/销毁，本页只写入配置；
//! - 面板本身仍是独立窗口的复用入口：传入 sources 即可获得 A/C 数据。
//! - 职责划分：本页是工作台（管理已启用微件）；「添加微件」只负责添加，
//!   不在库中重复展示尺寸/置顶/停用等管理表单。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  AlertTriangle, Blocks, ChevronDown, ChevronUp, EyeOff, LayoutGrid, LocateFixed,
  Monitor, Plus, RotateCcw, X,
} from "lucide-react";

import {
  enabledWidgets,
  MAX_ITEMS_OPTIONS,
  widgetDefinition,
  type WidgetConfig,
  type WidgetItem,
  type WidgetSize,
} from "../../lib/widgets/model";
import type { WidgetSources } from "../../lib/widgets/sources";
import { useLocale } from "../../hooks/useLocale";
import { useWidgetsStore } from "../../store/useWidgetsStore";
import { useUiStore } from "../../store/useUiStore";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import WorkspaceSplit from "../../workbench/WorkspaceSplit";
import { WorkbenchPageDetail, useWorkbenchDetailHost } from "../../workbench/pageDetail";
import { ConfirmDialog, Select, Switch } from "../ui";
import WidgetCard from "./WidgetCard";
import WidgetLibrary from "./WidgetLibrary";
import "./widgets.css";

type WidgetTab = "enabled" | "library" | "layout";

const WIDGET_SIZE_LABELS: Record<WidgetSize, "widgets.size.sm" | "widgets.size.md" | "widgets.size.lg"> = {
  sm: "widgets.size.sm",
  md: "widgets.size.md",
  lg: "widgets.size.lg",
};

export interface WidgetsPanelProps {
  /** A（专注计时）/ C（效率统计）数据源；未提供时对应微件显示「等待接入」。 */
  sources?: WidgetSources;
}

export default function WidgetsPanel({ sources = {} }: WidgetsPanelProps) {
  const { t } = useLocale();
  const widgets = useWidgetsStore((s) => s.widgets);
  const hydrate = useWidgetsStore((s) => s.hydrate);
  const addWidget = useWidgetsStore((s) => s.addWidget);
  const toggle = useWidgetsStore((s) => s.toggle);
  const setSize = useWidgetsStore((s) => s.setSize);
  const setConfig = useWidgetsStore((s) => s.setConfig);
  const moveTo = useWidgetsStore((s) => s.moveTo);
  const reset = useWidgetsStore((s) => s.reset);
  const setDesktop = useWidgetsStore((s) => s.setDesktop);
  const resetDesktopPosition = useWidgetsStore((s) => s.resetDesktopPosition);
  const retryDesktop = useWidgetsStore((s) => s.retryDesktop);
  const desktopRuntime = useWidgetsStore((s) => s.desktopRuntime);
  const persistError = useWidgetsStore((s) => s.persistError);
  const showToast = useUiStore((s) => s.showToast);

  const [tab, setTab] = useState<WidgetTab>("enabled");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  /** 右栏配置：首次进入已启用视图时自动选中首个微件；用户关闭后不强行重开。 */
  const [configuredId, setConfiguredId] = useState<string | null>(null);
  const autoConfigRef = useRef<WidgetTab | null>(null);
  const detailHost = useWorkbenchDetailHost();
  const configInRail = detailHost !== null;
  /** 已请求桌面显示、但窗口尚未确认成功的微件（id → 标题）。 */
  const pendingDesktopRef = useRef<Map<string, string>>(new Map());

  // 用 layout effect 在首帧绘制前完成布局读取，避免「先闪默认布局再跳变」。
  useLayoutEffect(() => {
    hydrate();
  }, [hydrate]);

  // 全部添加后自动收起添加面板：添加入口已清空时（Store 实际状态，而非按钮点击）
  // 关闭添加面板，把主区域让给微件工作台。用户重新停用微件后添加入口可正常恢复；
  // 恢复默认（默认含停用项）后同样恢复。手动重开时会保留打开状态（只承载停止操作）。
  const allAdded = widgets.length > 0 && widgets.every((item) => item.enabled);
  useEffect(() => {
    if (allAdded) setTab((current) => (current === "library" ? "enabled" : current));
  }, [allAdded]);

  // 「添加到桌面」的成功提示必须等 desktopRuntime 真正进入 shown；
  // 失败提示由 WidgetDesktopBridge 统一发出，这里只结束等待，避免重复 Toast。
  useEffect(() => {
    if (pendingDesktopRef.current.size === 0) return;
    for (const [id, title] of pendingDesktopRef.current) {
      const phase = desktopRuntime[id]?.phase;
      if (phase === "shown") {
        pendingDesktopRef.current.delete(id);
        showToast(t("widgets.addedDesktopToast", { title }), { kind: "success" });
      } else if (phase === "failed" || phase === "hidden") {
        pendingDesktopRef.current.delete(id);
      }
    }
  }, [desktopRuntime, showToast, t]);

  const visible = enabledWidgets(widgets);
  const configuredWidget = useMemo(
    () => visible.find((item) => item.widget_id === configuredId) ?? null,
    [visible, configuredId],
  );

  // 大屏下右栏应常驻一个可编辑对象，而不是默认停留在通用上下文。
  // 只在首次进入「已启用」视图时自动选中首个微件；用户关闭配置或切到库/布局后不强行重开。
  useEffect(() => {
    if (!configInRail) return;
    if (tab !== "enabled") {
      autoConfigRef.current = null;
      return;
    }
    if (configuredWidget || visible.length === 0 || autoConfigRef.current === "enabled") return;
    autoConfigRef.current = "enabled";
    setConfiguredId(visible[0].widget_id);
  }, [configInRail, tab, configuredWidget, visible]);
  const desktopCount = widgets.filter((item) => item.desktop.visible).length;
  // 「配置期望」与「真实已显示」分开统计，不能用配置冒充已创建窗口。
  const desktopShownCount = widgets.filter(
    (item) => desktopRuntime[item.widget_id]?.phase === "shown",
  ).length;
  const desktopFailedCount = widgets.filter(
    (item) => desktopRuntime[item.widget_id]?.phase === "failed",
  ).length;

  function moveBy(id: string, delta: -1 | 1) {
    const ids = visible.map((item) => item.widget_id);
    const pos = ids.indexOf(id);
    const targetPos = pos + delta;
    if (pos < 0 || targetPos < 0 || targetPos >= ids.length) return;
    const targetIndex = widgets.findIndex((item) => item.widget_id === ids[targetPos]);
    if (targetIndex >= 0) moveTo(id, targetIndex);
  }

  function onDropOn(draggedId: string, targetId: string) {
    const targetIndex = widgets.findIndex((item) => item.widget_id === targetId);
    if (targetIndex >= 0) moveTo(draggedId, targetIndex);
  }

  /** 写盘失败时只提示失败，不谎报操作成功。 */
  function reportPersistFailure() {
    const message = useWidgetsStore.getState().persistError;
    if (message) showToast(t("widgets.persistError", { message }), { kind: "error" });
  }

  /** 只加入工作台：不改变桌面显示配置。 */
  function onAdd(id: string) {
    const item = widgets.find((entry) => entry.widget_id === id);
    const title = item ? t(widgetDefinition(item.type).titleKey) : id;
    const ok = addWidget(id, { desktop: false });
    if (!ok) {
      reportPersistFailure();
      return;
    }
    // 添加完成后回到「已启用」：用户应立刻看到新卡片，而不是停在库列表。
    setTab("enabled");
    showToast(t("widgets.addedToast", { title }), { kind: "success" });
  }

  /**
   * 加入工作台并请求桌面显示（一次写盘，避免 toggle + setDesktop 的中间态）。
   * 只有 desktopRuntime 变为 shown 后才提示「已显示到桌面」；创建失败由
   * WidgetDesktopBridge 发出错误 Toast，卡片保留重试入口。
   */
  function onAddToDesktop(id: string) {
    const item = widgets.find((entry) => entry.widget_id === id);
    const title = item ? t(widgetDefinition(item.type).titleKey) : id;
    // 非 Tauri（浏览器预览）没有桌面窗口能力：只加入工作台，不宣称已显示。
    if (!isTauri()) {
      onAdd(id);
      return;
    }
    const ok = addWidget(id, { desktop: true });
    if (!ok) {
      reportPersistFailure();
      return;
    }
    setTab("enabled");
    const phase = useWidgetsStore.getState().desktopRuntime[id]?.phase;
    if (phase === "shown") {
      showToast(t("widgets.addedDesktopToast", { title }), { kind: "success" });
      return;
    }
    pendingDesktopRef.current.set(id, title);
    if (phase === "failed") retryDesktop(id);
  }

  function onSize(id: string, size: WidgetSize) {
    setSize(id, size);
  }

  function onConfig(id: string, patch: WidgetConfig) {
    setConfig(id, patch);
  }

  /** 恢复默认会关闭桌面窗口并清除位置/置顶/尺寸，先用现有轻量确认拦截。 */
  function onReset() {
    setResetConfirmOpen(true);
  }

  function confirmReset() {
    setResetConfirmOpen(false);
    const ok = reset();
    setDraggingId(null);
    pendingDesktopRef.current.clear();
    if (!ok) {
      reportPersistFailure();
      return;
    }
    showToast(`${t("widgets.resetToast")} · ${t("widgets.resetLayoutHint")}`, { kind: "info" });
  }

  return (
    <div className="widgets-page page-fill">
      {/* 页面级页头（2026-11-15 统一）：三个真实计数进 meta 槽，库/重置进动作区。 */}
      <WorkbenchPageHeader
        icon={Blocks}
        title={t("widgets.title")}
        subtitle={t("widgets.subtitle")}
        meta={
          <>
            <span className="widgets-count">
              {t("widgets.enabledCount", { enabled: visible.length, total: widgets.length })}
            </span>
            <span className="widgets-count">
              {t("widgets.desktopCount", { count: desktopCount })}
            </span>
            <span
              className={`widgets-count ${desktopShownCount !== desktopCount ? "warn" : ""}`}
              data-tip={
                desktopFailedCount > 0
                  ? t("widgets.desktop.failedHint", { count: desktopFailedCount })
                  : undefined
              }
            >
              {t("widgets.desktopShownCount", { count: desktopShownCount })}
            </span>
          </>
        }
        actions={
          <>
            <button
              className={`btn sm ${tab === "library" ? "primary" : ""}`}
              aria-expanded={tab === "library"}
              aria-controls="widget-tab-body"
              onClick={() => setTab((current) => (current === "library" ? "enabled" : "library"))}
            >
              <Plus size={13} aria-hidden="true" /> {t("widgets.addWidgets")}
            </button>
            <button
              className="btn sm"
              onClick={onReset}
              aria-label={t("widgets.resetLayoutAria")}
              data-tip={t("widgets.resetLayoutHint")}
            >
              <RotateCcw size={13} aria-hidden="true" /> {t("widgets.resetLayout")}
            </button>
          </>
        }
      />

      <div className="widgets-body">
        <WorkspaceSplit
          id="widgets-management"
          sidebarLabel="微件管理视图"
          defaultWidth={224}
          minWidth={204}
          maxWidth={300}
          sidebar={
            <aside className="widgets-rail">
              <div className="workspace-rail-head">
                <span className="workspace-rail-eyebrow">WIDGETS</span>
                <h2>微件管理</h2>
              </div>
              <div className="widgets-tabs widgets-tabs-vertical" role="tablist" aria-label="微件管理视图" aria-orientation="vertical">
                {([
                  ["enabled", "已启用", LayoutGrid],
                  ["library", "微件库", Plus],
                  ["layout", "布局设置", Blocks],
                ] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    className={`widgets-tab ${tab === key ? "is-active" : ""}`}
                    onClick={() => setTab(key)}
                  >
                    <Icon size={13} aria-hidden="true" />
                    {label}
                  </button>
                ))}
                <span className="widgets-tabs-meta">
                  {tab === "enabled"
                    ? `${visible.length} 个已启用`
                    : tab === "library"
                      ? `${widgets.length - visible.length} 个可添加`
                      : "排序 / 尺寸 / 桌面显示"}
                </span>
              </div>

              <section className="widgets-rail-preview" aria-label="桌面预览">
                <p className="widgets-rail-label">桌面预览</p>
                {visible.length === 0 ? (
                  <p className="widgets-rail-empty">尚未启用微件。</p>
                ) : (
                  <ul className="widgets-rail-preview-list">
                    {visible.slice(0, 6).map((item) => {
                      const phase = desktopRuntime[item.widget_id]?.phase ?? "hidden";
                      return (
                        <li key={item.widget_id}>
                          <span>{t(widgetDefinition(item.type).titleKey)}</span>
                          <em className={`is-${phase}`}>
                            {item.desktop.visible
                              ? phase === "shown"
                                ? "桌面已显示"
                                : phase === "failed"
                                  ? "创建失败"
                                  : "等待创建"
                              : "仅工作台"}
                          </em>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {visible.length > 6 && (
                  <p className="widgets-rail-empty">另有 {visible.length - 6} 个已启用微件。</p>
                )}
              </section>
            </aside>
          }
        >
          <div className="page-scroll ui-page-frame widgets-main">
        {/* 大数字摘要：管理页先给四条真实状态，再按 tabs 进入列表/库/布局。
            失败数来自 desktopRuntime，不能用「配置为显示」冒充已创建窗口。 */}
        <div className="widgets-stat-grid" aria-label="微件状态摘要">
          <div className="widgets-stat-card">
            <span>工作台微件</span>
            <strong>{visible.length}</strong>
            <em>共 {widgets.length} 个配置</em>
          </div>
          <div className="widgets-stat-card">
            <span>桌面显示</span>
            <strong>{desktopCount}</strong>
            <em>配置为显示到桌面</em>
          </div>
          <div className="widgets-stat-card is-success">
            <span>窗口已创建</span>
            <strong>{desktopShownCount}</strong>
            <em>本轮真实运行态</em>
          </div>
          <div className={`widgets-stat-card ${desktopFailedCount > 0 ? "is-danger" : ""}`}>
            <span>创建失败</span>
            <strong>{desktopFailedCount}</strong>
            <em>{desktopFailedCount > 0 ? "可在卡片上重试" : "暂无失败"}</em>
          </div>
        </div>

        {persistError && (
          <div className="widgets-persist-error" role="alert">
            <AlertTriangle size={13} aria-hidden="true" />
            <div>
              <strong>{t("widgets.persistError", { message: persistError })}</strong>
              <span>{t("widgets.persistErrorHint")}</span>
            </div>
          </div>
        )}

        {!isTauri() && (
          <div className="widgets-desktop-unavailable" role="status">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>{t("widgets.desktop.unavailable")}</span>
          </div>
        )}

        <div id="widget-tab-body" role="tabpanel">
          {tab === "library" && (
            <div id="widget-library-panel">
              <WidgetLibrary
                widgets={widgets}
                sources={sources}
                onAdd={onAdd}
                onAddToDesktop={onAddToDesktop}
              />
            </div>
          )}

          {tab === "enabled" &&
            (visible.length > 0 ? (
              <div className="widgets-grid ui-adaptive-grid" aria-label={t("widgets.gridAria")}>
                {visible.map((item, index) => (
                  <WidgetCard
                    key={item.widget_id}
                    item={item}
                    index={index}
                    total={visible.length}
                    sources={sources}
                    dragging={draggingId === item.widget_id}
                    draggingId={draggingId}
                    desktopRuntime={desktopRuntime[item.widget_id]}
                    configInRail={configInRail}
                    onConfigure={setConfiguredId}
                    selected={configuredId === item.widget_id}
                    onMoveBy={moveBy}
                    onDisable={(id) => toggle(id, false)}
                    onDesktop={(id, visibleDesktop) => setDesktop(id, { visible: visibleDesktop })}
                    onTopmost={(id, topmost) => setDesktop(id, { topmost })}
                    onSize={onSize}
                    onConfig={onConfig}
                    onResetPosition={resetDesktopPosition}
                    onRetryDesktop={retryDesktop}
                    onDragStart={setDraggingId}
                    onDragEnd={() => setDraggingId(null)}
                    onDropOn={onDropOn}
                  />
                ))}
              </div>
            ) : (
              <div className="widgets-empty">
                <LayoutGrid size={26} aria-hidden="true" />
                <strong>{t("widgets.emptyTitle")}</strong>
                <span>{t("widgets.emptyDesc")}</span>
                <button className="btn sm primary" onClick={() => setTab("library")}>
                  <Plus size={13} aria-hidden="true" /> {t("widgets.addWidgets")}
                </button>
              </div>
            ))}

          {tab === "layout" && (
            <section className="widgets-layout" aria-label="微件布局设置">
              <div className="widgets-layout-head">
                <div>
                  <h3>看板布局</h3>
                  <p>调整顺序、尺寸与桌面显示；独立桌面窗口由真实运行态确认。</p>
                </div>
                <button className="btn sm" onClick={onReset} data-tip={t("widgets.resetLayoutHint")}>
                  <RotateCcw size={13} aria-hidden="true" /> {t("widgets.resetLayout")}
                </button>
              </div>
              {visible.length === 0 ? (
                <div className="widgets-empty compact">
                  <LayoutGrid size={22} aria-hidden="true" />
                  <strong>{t("widgets.emptyTitle")}</strong>
                  <button className="btn sm primary" onClick={() => setTab("library")}>
                    <Plus size={13} aria-hidden="true" /> {t("widgets.addWidgets")}
                  </button>
                </div>
              ) : (
                <ul className="widgets-layout-list">
                  {visible.map((item, index) => {
                    const title = t(widgetDefinition(item.type).titleKey);
                    const phase = desktopRuntime[item.widget_id]?.phase ?? "hidden";
                    return (
                      <li key={item.widget_id} className="widgets-layout-row">
                        <span className="widgets-layout-index">{index + 1}</span>
                        <div className="widgets-layout-info">
                          <strong>{title}</strong>
                          <span>
                            {t(WIDGET_SIZE_LABELS[item.size])}
                            {" · "}
                            {item.desktop.visible
                              ? phase === "shown"
                                ? "桌面已显示"
                                : phase === "failed"
                                  ? "桌面创建失败"
                                  : "等待桌面窗口"
                              : "仅工作台"}
                          </span>
                        </div>
                        <div className="widgets-layout-actions">
                          <button
                            className="widget-icon-btn"
                            disabled={index === 0}
                            aria-label={t("widgets.moveUpAria", { title })}
                            onClick={() => moveBy(item.widget_id, -1)}
                          >
                            <ChevronUp size={13} aria-hidden="true" />
                          </button>
                          <button
                            className="widget-icon-btn"
                            disabled={index === visible.length - 1}
                            aria-label={t("widgets.moveDownAria", { title })}
                            onClick={() => moveBy(item.widget_id, 1)}
                          >
                            <ChevronDown size={13} aria-hidden="true" />
                          </button>
                          <button
                            className="widget-icon-btn"
                            aria-label={t("widgets.cardConfigAria", { title })}
                            data-tip="配置微件"
                            onClick={() => setConfiguredId(item.widget_id)}
                          >
                            <Blocks size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </div>
          </div>
        </WorkspaceSplit>
      </div>
      {configInRail && configuredWidget && (
        <WidgetConfigRail
          item={configuredWidget}
          index={visible.findIndex((item) => item.widget_id === configuredWidget.widget_id)}
          total={visible.length}
          onClose={() => setConfiguredId(null)}
          onSize={onSize}
          onConfig={onConfig}
          onMoveBy={moveBy}
          onDesktop={setDesktop}
          onResetPosition={resetDesktopPosition}
          onDisable={(id) => {
            toggle(id, false);
            setConfiguredId(null);
          }}
        />
      )}

      <ConfirmDialog
        open={resetConfirmOpen}
        title={t("widgets.resetLayoutAria")}
        detail={t("widgets.resetLayoutHint")}
        confirmLabel={t("widgets.resetLayout")}
        danger
        onConfirm={confirmReset}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </div>
  );
}

/**
 * 右栏微件配置：与卡片内联配置互斥（有宿主时卡片只负责选中，右栏负责表单）。
 * 不把桌面窗口状态写进本地推测，`desktopRuntime` 的 shown/failed 仍由主页面传入。
 */
function WidgetConfigRail({
  item,
  index,
  total,
  onClose,
  onSize,
  onConfig,
  onMoveBy,
  onDesktop,
  onResetPosition,
  onDisable,
}: {
  item: WidgetItem;
  index: number;
  total: number;
  onClose: () => void;
  onSize: (id: string, size: WidgetSize) => void;
  onConfig: (id: string, patch: WidgetConfig) => void;
  onMoveBy: (id: string, delta: -1 | 1) => void;
  onDesktop: (id: string, patch: { visible?: boolean; topmost?: boolean }) => void;
  onResetPosition: (id: string) => void;
  onDisable: (id: string) => void;
}) {
  const { t } = useLocale();
  const def = widgetDefinition(item.type);
  const title = t(def.titleKey);
  const sizeOptions = (["sm", "md", "lg"] as WidgetSize[]).map((size) => ({
    value: size,
    label: t(WIDGET_SIZE_LABELS[size]),
  }));
  const maxItemsOptions = MAX_ITEMS_OPTIONS.map((n) => ({
    value: String(n),
    label: t("widgets.maxItems", { n }),
  }));

  return (
    <WorkbenchPageDetail
      title="微件配置"
      actions={
        <button className="icon-btn sm" aria-label="关闭微件配置" data-tip="关闭" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      }
    >
      <div className="widgets-rail-hero">
        <span className="widgets-rail-index">{index + 1}</span>
        <div>
          <strong>{title}</strong>
          <span>{t(def.descriptionKey)}</span>
        </div>
      </div>

      <div className="widgets-rail-form">
        <label className="widgets-rail-field">
          <span>{t("widgets.configSize")}</span>
          <Select
            value={item.size}
            options={sizeOptions}
            onChange={(value) => onSize(item.widget_id, value)}
            ariaLabel={t("widgets.sizeAria", { title })}
            size="sm"
            align="start"
            triggerClassName="widget-config-select"
          />
        </label>

        {item.type === "today-tasks" && (
          <label className="widgets-rail-field">
            <span>{t("widgets.maxItemsLabel")}</span>
            <Select
              value={String(item.config.maxItems ?? 5)}
              options={maxItemsOptions}
              onChange={(value) => onConfig(item.widget_id, { maxItems: Number(value) })}
              ariaLabel={t("widgets.maxItemsAria", { title })}
              size="sm"
              align="start"
              triggerClassName="widget-config-select"
            />
          </label>
        )}

        <div className="widgets-rail-switch">
          <Switch
            label={t("widgets.desktop.showAria", { title })}
            checked={item.desktop.visible}
            onChange={(checked) => onDesktop(item.widget_id, { visible: checked })}
            ariaLabel={t("widgets.desktop.showAria", { title })}
          />
          <span>桌面独立窗口使用同一份布局配置</span>
        </div>
        <div className="widgets-rail-switch">
          <Switch
            label={t("widgets.desktop.topmost")}
            checked={item.desktop.topmost}
            disabled={!item.desktop.visible}
            onChange={(checked) => onDesktop(item.widget_id, { topmost: checked })}
            ariaLabel={t("widgets.desktop.topmostAria", { title })}
          />
          <span>仅在桌面窗口已显示时生效</span>
        </div>
      </div>

      <div className="widgets-rail-actions">
        <button
          className="widget-icon-btn"
          disabled={index <= 0}
          aria-label={t("widgets.moveUpAria", { title })}
          data-tip={t("widgets.moveUp")}
          onClick={() => onMoveBy(item.widget_id, -1)}
        >
          <ChevronUp size={13} aria-hidden="true" />
        </button>
        <button
          className="widget-icon-btn"
          disabled={index >= total - 1}
          aria-label={t("widgets.moveDownAria", { title })}
          data-tip={t("widgets.moveDown")}
          onClick={() => onMoveBy(item.widget_id, 1)}
        >
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        <button
          className="widget-icon-btn"
          aria-label={t("widgets.desktop.resetPositionAria", { title })}
          data-tip={t("widgets.desktop.resetPositionTip")}
          onClick={() => onResetPosition(item.widget_id)}
        >
          <LocateFixed size={13} aria-hidden="true" />
        </button>
        <button
          className="widget-icon-btn"
          aria-label={t("widgets.desktop.showAria", { title })}
          data-tip={t(item.desktop.visible ? "widgets.desktop.hideTip" : "widgets.desktop.showTip")}
          onClick={() => onDesktop(item.widget_id, { visible: !item.desktop.visible })}
        >
          <Monitor size={13} aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        className="btn sm danger-ghost widgets-rail-disable"
        onClick={() => onDisable(item.widget_id)}
      >
        <EyeOff size={13} aria-hidden="true" /> {t("widgets.disable")}
      </button>
    </WorkbenchPageDetail>
  );
}
