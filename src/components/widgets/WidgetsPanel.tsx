//! 微件面板（管理中心）。
//!
//! - 「看板启用」与「桌面显示」是两条独立状态：关闭看板卡片不会销毁桌面窗口；
//! - 只挂载已启用的看板微件：停用即卸载，随之释放全部订阅与共享时钟引用；
//! - 布局由 useWidgetsStore 持久化，支持启用/停用、拖动排序、尺寸与条目配置；
//! - 桌面窗口由主窗口 `WidgetDesktopBridge` 按布局创建/销毁，本页只写入配置；
//! - 面板本身仍是独立窗口的复用入口：传入 sources 即可获得 A/C 数据。
//! - 职责划分：本页是工作台（管理已启用微件）；「添加微件」只负责添加，
//!   不在库中重复展示尺寸/置顶/停用等管理表单。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { AlertTriangle, Blocks, LayoutGrid, Plus, RotateCcw } from "lucide-react";

import {
  enabledWidgets,
  widgetDefinition,
  type WidgetConfig,
  type WidgetSize,
} from "../../lib/widgets/model";
import type { WidgetSources } from "../../lib/widgets/sources";
import { useLocale } from "../../hooks/useLocale";
import { useWidgetsStore } from "../../store/useWidgetsStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui";
import WidgetCard from "./WidgetCard";
import WidgetLibrary from "./WidgetLibrary";
import "./widgets.css";

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

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  /** 已请求桌面显示、但窗口尚未确认成功的微件（id → 标题）。 */
  const pendingDesktopRef = useRef<Map<string, string>>(new Map());

  // 用 layout effect 在首帧绘制前完成布局读取，避免「先闪默认布局再跳变」。
  useLayoutEffect(() => {
    hydrate();
  }, [hydrate]);

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
    <div className="widgets-page">
      <header className="widgets-head">
        <div className="widgets-head-title">
          <Blocks size={18} aria-hidden="true" />
          <div>
            <h2>{t("widgets.title")}</h2>
            <p>{t("widgets.subtitle")}</p>
          </div>
        </div>
        <div className="widgets-head-actions">
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
          <button
            className={`btn sm ${libraryOpen ? "primary" : ""}`}
            aria-expanded={libraryOpen}
            aria-controls="widget-library-panel"
            onClick={() => setLibraryOpen((open) => !open)}
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
        </div>
      </header>

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

      {libraryOpen && (
        <div id="widget-library-panel">
          <WidgetLibrary
            widgets={widgets}
            sources={sources}
            onAdd={onAdd}
            onAddToDesktop={onAddToDesktop}
          />
        </div>
      )}

      {visible.length > 0 ? (
        <div className="widgets-grid" aria-label={t("widgets.gridAria")}>
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
          <button className="btn sm primary" onClick={() => setLibraryOpen(true)}>
            <Plus size={13} aria-hidden="true" /> {t("widgets.addWidgets")}
          </button>
        </div>
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
