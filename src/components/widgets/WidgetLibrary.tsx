//! 微件库：启用/停用、尺寸与今日任务条目上限。布局排序在卡片上进行。

import { Layers, Lock } from "lucide-react";

import {
  MAX_ITEMS_OPTIONS,
  widgetDefinition,
  type WidgetConfig,
  type WidgetItem,
  type WidgetSize,
} from "../../lib/widgets/model";
import { Select, Switch } from "../ui";

const SIZE_OPTIONS: { value: WidgetSize; label: string }[] = [
  { value: "sm", label: "窄" },
  { value: "md", label: "标准" },
  { value: "lg", label: "宽" },
];

export interface WidgetLibraryProps {
  widgets: WidgetItem[];
  onChange: (id: string, enabled: boolean) => void;
  onSize: (id: string, size: WidgetSize) => void;
  onConfig: (id: string, patch: WidgetConfig) => void;
}

export default function WidgetLibrary({ widgets, onChange, onSize, onConfig }: WidgetLibraryProps) {
  const ordered = [...widgets].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <section className="widget-library" aria-label="微件库">
      <header className="widget-library-head">
        <Layers size={14} aria-hidden="true" />
        <div>
          <h3>微件库</h3>
          <p>微件只做持续展示；高频操作、磁吸停靠与当前状态入口仍由悬浮胶囊承担。</p>
        </div>
      </header>

      <ul className="widget-library-list">
        {ordered.map((item) => {
          const def = widgetDefinition(item.type);
          return (
            <li key={item.widget_id} className={`widget-library-row ${item.enabled ? "" : "disabled"}`}>
              <div className="widget-library-info">
                <div className="widget-library-title">
                  <strong>{def.title}</strong>
                  {def.dependency && (
                    <span className="widget-chip muted">
                      <Lock size={10} aria-hidden="true" /> 等待模块接入
                    </span>
                  )}
                </div>
                <span className="widget-library-desc">{def.description}</span>
              </div>

              <div className="widget-library-controls">
                {item.type === "today-tasks" && (
                  <Select
                    value={String(item.config.maxItems ?? 5)}
                    options={MAX_ITEMS_OPTIONS.map((n) => ({ value: String(n), label: `${n} 条` }))}
                    onChange={(value) => onConfig(item.widget_id, { maxItems: Number(value) })}
                    ariaLabel={`「${def.title}」条目数量`}
                    size="sm"
                    placement="bottom-end"
                  />
                )}
                <Select
                  value={item.size}
                  options={SIZE_OPTIONS}
                  onChange={(value) => onSize(item.widget_id, value)}
                  ariaLabel={`「${def.title}」尺寸`}
                  size="sm"
                  placement="bottom-end"
                />
                <Switch
                  checked={item.enabled}
                  onChange={(checked) => onChange(item.widget_id, checked)}
                  ariaLabel={`启用「${def.title}」`}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
