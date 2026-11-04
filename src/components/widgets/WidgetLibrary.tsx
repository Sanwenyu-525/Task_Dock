//! 微件库：启用/停用、尺寸与今日任务条目上限。布局排序在卡片上进行。

import { Layers, Lock } from "lucide-react";

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
import { Select, Switch } from "../ui";

const SIZE_OPTIONS: { value: WidgetSize; labelKey: MessageKey }[] = [
  { value: "sm", labelKey: "widgets.size.sm" },
  { value: "md", labelKey: "widgets.size.md" },
  { value: "lg", labelKey: "widgets.size.lg" },
];

export interface WidgetLibraryProps {
  widgets: WidgetItem[];
  /** 已注入的 A/C 数据源；用于区分「依赖模块已接入」与「等待模块接入」。 */
  sources?: WidgetSources;
  onChange: (id: string, enabled: boolean) => void;
  onSize: (id: string, size: WidgetSize) => void;
  onConfig: (id: string, patch: WidgetConfig) => void;
}

export default function WidgetLibrary({
  widgets,
  sources,
  onChange,
  onSize,
  onConfig,
}: WidgetLibraryProps) {
  const { t } = useLocale();
  const ordered = [...widgets].sort((a, b) => a.sort_order - b.sort_order);
  const sizeOptions = SIZE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const maxItemsOptions = MAX_ITEMS_OPTIONS.map((n) => ({
    value: String(n),
    label: t("widgets.maxItems", { n }),
  }));

  return (
    <section className="widget-library" aria-label={t("widgets.library")}>
      <header className="widget-library-head">
        <Layers size={14} aria-hidden="true" />
        <div>
          <h3>{t("widgets.library")}</h3>
          <p>{t("widgets.libraryDesc")}</p>
        </div>
      </header>

      <ul className="widget-library-list">
        {ordered.map((item) => {
          const def = widgetDefinition(item.type);
          const title = t(def.titleKey);
          const dependency = def.dependency;
          const waiting = dependency !== null && !sources?.[dependency];
          return (
            <li key={item.widget_id} className={`widget-library-row ${item.enabled ? "" : "disabled"}`}>
              <div className="widget-library-info">
                <div className="widget-library-title">
                  <strong>{title}</strong>
                  {waiting && (
                    <span className="widget-chip muted">
                      <Lock size={10} aria-hidden="true" /> {t("widgets.waitingModule")}
                    </span>
                  )}
                </div>
                <span className="widget-library-desc">{t(def.descriptionKey)}</span>
              </div>

              <div className="widget-library-controls">
                {item.type === "today-tasks" && (
                  <Select
                    value={String(item.config.maxItems ?? 5)}
                    options={maxItemsOptions}
                    onChange={(value) => onConfig(item.widget_id, { maxItems: Number(value) })}
                    ariaLabel={t("widgets.maxItemsAria", { title })}
                    size="sm"
                    placement="bottom-end"
                  />
                )}
                <Select
                  value={item.size}
                  options={sizeOptions}
                  onChange={(value) => onSize(item.widget_id, value)}
                  ariaLabel={t("widgets.sizeAria", { title })}
                  size="sm"
                  placement="bottom-end"
                />
                <Switch
                  checked={item.enabled}
                  onChange={(checked) => onChange(item.widget_id, checked)}
                  ariaLabel={t("widgets.enableAria", { title })}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
