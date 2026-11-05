//! 微件卡片外壳：工作台主管理入口。
//!
//! - 头部：拖动手柄、名称、必要状态 + 桌面显示快捷开关、更多配置、停用；
//! - 配置区：尺寸、条目上限、置顶、上移/下移与位置重置，默认收起（无模态弹窗）；
//! - 「看板启用」与「桌面显示」保持独立：停用卡片不会关闭桌面窗口；
//! - 卡片主体只读，具体内容仍由 WidgetBody 按类型渲染。

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  EyeOff,
  GripVertical,
  LocateFixed,
  Monitor,
  MonitorOff,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";

import {
  MAX_ITEMS_OPTIONS,
  widgetDefinition,
  type WidgetConfig,
  type WidgetItem,
  type WidgetSize,
} from "../../lib/widgets/model";
import type { WidgetSources } from "../../lib/widgets/sources";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import type { WidgetDesktopRuntime } from "../../store/useWidgetsStore";
import { Select, Switch } from "../ui";
import WidgetBody from "./WidgetBody";

const SIZE_OPTIONS: { value: WidgetSize; labelKey: MessageKey }[] = [
  { value: "sm", labelKey: "widgets.size.sm" },
  { value: "md", labelKey: "widgets.size.md" },
  { value: "lg", labelKey: "widgets.size.lg" },
];

export interface WidgetCardProps {
  item: WidgetItem;
  index: number;
  total: number;
  sources: WidgetSources;
  dragging: boolean;
  draggingId: string | null;
  /** 桌面窗口真实状态（仅内存）；失败时卡片头部可直接重试。 */
  desktopRuntime?: WidgetDesktopRuntime;
  onMoveBy: (id: string, delta: -1 | 1) => void;
  onDisable: (id: string) => void;
  onDesktop: (id: string, visible: boolean) => void;
  onTopmost: (id: string, topmost: boolean) => void;
  onSize: (id: string, size: WidgetSize) => void;
  onConfig: (id: string, patch: WidgetConfig) => void;
  onResetPosition: (id: string) => void;
  onRetryDesktop: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropOn: (draggedId: string, targetId: string) => void;
}

export default function WidgetCard({
  item,
  index,
  total,
  sources,
  dragging,
  draggingId,
  desktopRuntime,
  onMoveBy,
  onDisable,
  onDesktop,
  onTopmost,
  onSize,
  onConfig,
  onResetPosition,
  onRetryDesktop,
  onDragStart,
  onDragEnd,
  onDropOn,
}: WidgetCardProps) {
  const { t } = useLocale();
  const [configOpen, setConfigOpen] = useState(false);
  const def = widgetDefinition(item.type);
  const title = t(def.titleKey);
  const configId = `widget-config-${item.widget_id}`;

  const phase = desktopRuntime?.phase ?? "hidden";
  // 只有「正在创建 / 创建失败」需要占用头部状态位；已显示由桌面开关的选中态表达，
  // 不重复刷一条常驻 chip 增加噪声。
  const status = phase === "failed" ? "failed" : item.desktop.visible && phase === "creating" ? "creating" : null;

  const sizeOptions = SIZE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const maxItemsOptions = MAX_ITEMS_OPTIONS.map((n) => ({
    value: String(n),
    label: t("widgets.maxItems", { n }),
  }));

  return (
    <section
      className={`widget-card surface-card widget-size-${item.size} ${dragging ? "dragging" : ""}`}
      data-widget-id={item.widget_id}
      aria-label={t("widgets.cardAria", { title })}
      onDragOver={(event) => {
        if (draggingId && draggingId !== item.widget_id) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const draggedId = event.dataTransfer.getData("text/plain") || draggingId;
        if (draggedId && draggedId !== item.widget_id) onDropOn(draggedId, item.widget_id);
        onDragEnd();
      }}
    >
      <header className="widget-card-head">
        {/* 只有手柄承担拖动：卡片内的按钮、Select、Switch 与任务条目不会被误拖排序。 */}
        <span
          className="widget-grip"
          draggable={total > 1}
          data-tip={t("widgets.dragTip")}
          aria-hidden="true"
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.widget_id);
            onDragStart(item.widget_id);
          }}
          onDragEnd={onDragEnd}
        >
          <GripVertical size={13} />
        </span>
        <h3>{title}</h3>
        {status && (
          <span
            className={`widget-chip widget-desktop-chip ${status}`}
            data-tip={status === "failed" ? desktopRuntime?.error ?? t("widgets.desktop.runtime.failed") : undefined}
          >
            {t(status === "failed" ? "widgets.desktop.runtime.failed" : "widgets.desktop.runtime.creating")}
          </span>
        )}
        <div className="widget-card-tools">
          {phase === "failed" && (
            <button
              className="widget-icon-btn"
              aria-label={t("widgets.desktop.retryAria", { title })}
              data-tip={t("widgets.desktop.retryTip")}
              onClick={() => onRetryDesktop(item.widget_id)}
            >
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          )}
          <button
            className={`widget-icon-btn ${item.desktop.visible ? "is-on" : ""}`}
            aria-label={t(
              item.desktop.visible ? "widgets.desktop.hideAria" : "widgets.desktop.showAria",
              { title },
            )}
            aria-pressed={item.desktop.visible}
            data-tip={
              phase === "failed"
                ? desktopRuntime?.error ?? t("widgets.desktop.runtime.failed")
                : t(item.desktop.visible ? "widgets.desktop.hideTip" : "widgets.desktop.showTip")
            }
            onClick={() => onDesktop(item.widget_id, !item.desktop.visible)}
          >
            {item.desktop.visible ? (
              <Monitor size={13} aria-hidden="true" />
            ) : (
              <MonitorOff size={13} aria-hidden="true" />
            )}
          </button>
          <button
            className="widget-icon-btn"
            aria-label={t("widgets.cardConfigAria", { title })}
            aria-expanded={configOpen}
            aria-controls={configId}
            data-tip={t(configOpen ? "widgets.lessConfig" : "widgets.moreConfig")}
            onClick={() => setConfigOpen((open) => !open)}
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
          </button>
          <button
            className="widget-icon-btn"
            aria-label={t("widgets.disableAria", { title })}
            data-tip={t("widgets.disableTip")}
            onClick={() => onDisable(item.widget_id)}
          >
            <EyeOff size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      {configOpen && (
        <div className="widget-card-config" id={configId} role="group" aria-label={t("widgets.cardConfigAria", { title })}>
          <div className="widget-config-row">
            <div className="widget-config-field">
              <span className="widget-config-label">{t("widgets.configSize")}</span>
              <Select
                value={item.size}
                options={sizeOptions}
                onChange={(value) => onSize(item.widget_id, value)}
                ariaLabel={t("widgets.sizeAria", { title })}
                size="sm"
                align="start"
                triggerClassName="widget-config-select"
              />
            </div>
            {item.type === "today-tasks" && (
              <div className="widget-config-field">
                <span className="widget-config-label">{t("widgets.maxItemsLabel")}</span>
                <Select
                  value={String(item.config.maxItems ?? 5)}
                  options={maxItemsOptions}
                  onChange={(value) => onConfig(item.widget_id, { maxItems: Number(value) })}
                  ariaLabel={t("widgets.maxItemsAria", { title })}
                  size="sm"
                  align="start"
                  triggerClassName="widget-config-select"
                />
              </div>
            )}
            <Switch
              label={t("widgets.desktop.topmost")}
              checked={item.desktop.topmost}
              disabled={!item.desktop.visible}
              onChange={(checked) => onTopmost(item.widget_id, checked)}
              ariaLabel={t("widgets.desktop.topmostAria", { title })}
            />
          </div>

          <div className="widget-config-actions">
            <button
              className="widget-icon-btn"
              aria-label={t("widgets.moveUpAria", { title })}
              data-tip={t("widgets.moveUp")}
              disabled={index === 0}
              onClick={() => onMoveBy(item.widget_id, -1)}
            >
              <ChevronUp size={13} aria-hidden="true" />
            </button>
            <button
              className="widget-icon-btn"
              aria-label={t("widgets.moveDownAria", { title })}
              data-tip={t("widgets.moveDown")}
              disabled={index === total - 1}
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
          </div>
        </div>
      )}

      <div className="widget-card-body">
        <WidgetBody item={item} sources={sources} />
      </div>
    </section>
  );
}
