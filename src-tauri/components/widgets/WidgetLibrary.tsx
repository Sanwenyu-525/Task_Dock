//! 微件库：只负责「添加」，不承担已启用微件的管理。
//!
//! - 只列出尚未加入工作台的微件，已启用项不会在这里重复占位；
//! - 提供「添加到工作台」与「添加到桌面」两个入口，后者同时打开桌面显示；
//! - 尺寸、置顶、位置与条目配置统一由工作台卡片承担，避免两套管理表单；
//! - 全部添加后给出简洁完成态；「恢复默认」统一由工作台页头承担，不在此重复出现。

import { Check, Layers, Lock, Monitor, Plus } from "lucide-react";

import { widgetDefinition, type WidgetItem } from "../../lib/widgets/model";
import type { WidgetSources } from "../../lib/widgets/sources";
import { useLocale } from "../../hooks/useLocale";

export interface WidgetLibraryProps {
  widgets: WidgetItem[];
  /** 已注入的 A/C 数据源；用于区分「依赖模块已接入」与「等待模块接入」。 */
  sources?: WidgetSources;
  /** 添加到工作台（不会自动打开桌面显示）。 */
  onAdd: (id: string) => void;
  /** 添加到工作台并同时打开桌面显示。 */
  onAddToDesktop: (id: string) => void;
}

export default function WidgetLibrary({
  widgets,
  sources,
  onAdd,
  onAddToDesktop,
}: WidgetLibraryProps) {
  const { t } = useLocale();
  const addable = widgets
    .filter((item) => !item.enabled)
    .sort((a, b) => a.sort_order - b.sort_order);

  return (
    <section className="widget-library" aria-label={t("widgets.addWidgets")}>
      <header className="widget-library-head">
        <Layers size={14} aria-hidden="true" />
        <div>
          <h3>{t("widgets.addWidgets")}</h3>
          <p>{t("widgets.addWidgetsDesc")}</p>
        </div>
      </header>

      {addable.length > 0 ? (
        <>
          <ul className="widget-library-list">
            {addable.map((item) => {
              const def = widgetDefinition(item.type);
              const title = t(def.titleKey);
              const dependency = def.dependency;
              const waiting = dependency !== null && !sources?.[dependency];
              return (
                <li key={item.widget_id} className="widget-library-row">
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
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={t("widgets.addToBoardAria", { title })}
                      onClick={() => onAdd(item.widget_id)}
                    >
                      <Plus size={13} aria-hidden="true" /> {t("widgets.addToBoard")}
                    </button>
                    <button
                      type="button"
                      className="btn sm primary"
                      aria-label={t("widgets.addToDesktopAria", { title })}
                      onClick={() => onAddToDesktop(item.widget_id)}
                    >
                      <Monitor size={13} aria-hidden="true" /> {t("widgets.addToDesktop")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="widget-library-hint">{t("widgets.libraryHint")}</p>
        </>
      ) : (
        <div className="widget-library-done" role="status">
          <Check size={16} aria-hidden="true" />
          <div className="widget-library-done-text">
            <strong>{t("widgets.allAddedTitle")}</strong>
            <span>{t("widgets.allAddedDesc")}</span>
          </div>
        </div>
      )}
    </section>
  );
}
