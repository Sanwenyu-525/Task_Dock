//! 微件卡片外壳：尺寸、拖动排序、键盘上移/下移与停用。
//! 卡片本身只读；具体内容由 WidgetBody 按类型渲染。

import { ChevronDown, ChevronUp, EyeOff, GripVertical } from "lucide-react";

import { widgetDefinition, type WidgetItem } from "../../lib/widgets/model";
import type { WidgetSources } from "../../lib/widgets/sources";
import WidgetBody from "./WidgetBody";

export interface WidgetCardProps {
  item: WidgetItem;
  index: number;
  total: number;
  sources: WidgetSources;
  dragging: boolean;
  draggingId: string | null;
  onMoveBy: (id: string, delta: -1 | 1) => void;
  onDisable: (id: string) => void;
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
  onMoveBy,
  onDisable,
  onDragStart,
  onDragEnd,
  onDropOn,
}: WidgetCardProps) {
  const def = widgetDefinition(item.type);

  return (
    <section
      className={`widget-card widget-size-${item.size} ${dragging ? "dragging" : ""}`}
      data-widget-id={item.widget_id}
      aria-label={`微件：${def.title}`}
      draggable={total > 1}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.widget_id);
        onDragStart(item.widget_id);
      }}
      onDragEnd={onDragEnd}
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
        <span className="widget-grip" data-tip="拖动排序，或用右侧按钮上移/下移" aria-hidden="true">
          <GripVertical size={13} />
        </span>
        <h3>{def.title}</h3>
        <div className="widget-card-tools">
          <button
            className="widget-icon-btn"
            aria-label={`上移「${def.title}」`}
            data-tip="上移"
            disabled={index === 0}
            onClick={() => onMoveBy(item.widget_id, -1)}
          >
            <ChevronUp size={13} aria-hidden="true" />
          </button>
          <button
            className="widget-icon-btn"
            aria-label={`下移「${def.title}」`}
            data-tip="下移"
            disabled={index === total - 1}
            onClick={() => onMoveBy(item.widget_id, 1)}
          >
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <button
            className="widget-icon-btn"
            aria-label={`停用「${def.title}」`}
            data-tip="停用（可在微件库重新启用）"
            onClick={() => onDisable(item.widget_id)}
          >
            <EyeOff size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="widget-card-body">
        <WidgetBody item={item} sources={sources} />
      </div>
    </section>
  );
}
