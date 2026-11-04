//! 微件面板（Task Dock 内部第一版）。
//!
//! - 只挂载已启用的微件：停用即卸载，随之释放全部订阅与共享时钟引用；
//! - 布局由 useWidgetsStore 持久化，支持启用/停用、拖动排序、尺寸与条目配置；
//! - 本组件同时是未来独立桌面窗口的复用入口：传入 sources 即可获得 A/C 数据。
//! - 独立窗口的多窗口透明/置顶/点击穿透/DPI 支持尚未验证，因此第一版不创建。

import { useEffect, useState } from "react";
import { Blocks, LayoutGrid, RotateCcw, SlidersHorizontal } from "lucide-react";

import { enabledWidgets, type WidgetConfig, type WidgetSize } from "../../lib/widgets/model";
import type { WidgetSources } from "../../lib/widgets/sources";
import { useWidgetsStore } from "../../store/useWidgetsStore";
import { useUiStore } from "../../store/useUiStore";
import WidgetCard from "./WidgetCard";
import WidgetLibrary from "./WidgetLibrary";
import "./widgets.css";

export interface WidgetsPanelProps {
  /** A（专注计时）/ C（效率统计）数据源；未提供时对应微件显示「等待接入」。 */
  sources?: WidgetSources;
}

export default function WidgetsPanel({ sources = {} }: WidgetsPanelProps) {
  const widgets = useWidgetsStore((s) => s.widgets);
  const hydrate = useWidgetsStore((s) => s.hydrate);
  const toggle = useWidgetsStore((s) => s.toggle);
  const setSize = useWidgetsStore((s) => s.setSize);
  const setConfig = useWidgetsStore((s) => s.setConfig);
  const moveTo = useWidgetsStore((s) => s.moveTo);
  const reset = useWidgetsStore((s) => s.reset);
  const showToast = useUiStore((s) => s.showToast);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const visible = enabledWidgets(widgets);

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

  function onToggle(id: string, enabled: boolean) {
    toggle(id, enabled);
  }

  function onSize(id: string, size: WidgetSize) {
    setSize(id, size);
  }

  function onConfig(id: string, patch: WidgetConfig) {
    setConfig(id, patch);
  }

  function onReset() {
    reset();
    setDraggingId(null);
    showToast("已恢复默认微件布局", { kind: "info" });
  }

  return (
    <div className="widgets-page">
      <header className="widgets-head">
        <div className="widgets-head-title">
          <Blocks size={18} aria-hidden="true" />
          <div>
            <h2>微件</h2>
            <p>持续展示少量信息；高频操作与当前状态仍由悬浮胶囊承担。</p>
          </div>
        </div>
        <div className="widgets-head-actions">
          <span className="widgets-count">
            已启用 {visible.length} / {widgets.length}
          </span>
          <button
            className={`btn sm ${libraryOpen ? "primary" : ""}`}
            aria-expanded={libraryOpen}
            aria-controls="widget-library-panel"
            onClick={() => setLibraryOpen((open) => !open)}
          >
            <SlidersHorizontal size={13} aria-hidden="true" /> 微件库
          </button>
          <button className="btn sm" onClick={onReset} aria-label="恢复默认微件布局">
            <RotateCcw size={13} aria-hidden="true" /> 恢复默认
          </button>
        </div>
      </header>

      {libraryOpen && (
        <div id="widget-library-panel">
          <WidgetLibrary
            widgets={widgets}
            onChange={onToggle}
            onSize={onSize}
            onConfig={onConfig}
          />
        </div>
      )}

      {visible.length > 0 ? (
        <div className="widgets-grid" aria-label="已启用的微件">
          {visible.map((item, index) => (
            <WidgetCard
              key={item.widget_id}
              item={item}
              index={index}
              total={visible.length}
              sources={sources}
              dragging={draggingId === item.widget_id}
              draggingId={draggingId}
              onMoveBy={moveBy}
              onDisable={(id) => toggle(id, false)}
              onDragStart={setDraggingId}
              onDragEnd={() => setDraggingId(null)}
              onDropOn={onDropOn}
            />
          ))}
        </div>
      ) : (
        <div className="widgets-empty">
          <LayoutGrid size={26} aria-hidden="true" />
          <strong>还没有启用任何微件</strong>
          <span>在微件库中打开需要的卡片；停用的微件不会挂载，也不会产生刷新。</span>
          <button className="btn sm primary" onClick={() => setLibraryOpen(true)}>
            打开微件库
          </button>
        </div>
      )}
    </div>
  );
}
