//! 标注只读渲染层：预览模式使用，不注册任何指针/编辑回调，也不产生写入操作。
//!
//! 编辑态复用 `AnnotationShape`（传入 `onSelect` 才可选中），保证预览与编辑的
//! 视觉呈现完全一致，差别只在是否可交互。

import type { PointerEvent as ReactPointerEvent } from "react";
import type { Annotation } from "./annotation-types";

const ARROW_MARKER_ID = "annotation-arrow";

export function AnnotationShape({
  annotation,
  selected = false,
  onSelect,
  onPointerDown,
}: {
  annotation: Annotation;
  selected?: boolean;
  onSelect?: () => void;
  /** 编辑态拖动起点；只读渲染不传，保证预览不产生任何交互。 */
  onPointerDown?: (event: ReactPointerEvent) => void;
}) {
  const color = annotation.color ?? "var(--status-danger)";
  const stroke = { stroke: color, strokeWidth: selected ? 3 : 2, fill: "none" };
  const common =
    onSelect || onPointerDown
      ? {
          className: "annotation-shape is-interactive",
          onPointerDown: (event: ReactPointerEvent) => {
            event.stopPropagation();
            onSelect?.();
            onPointerDown?.(event);
          },
        }
      : { className: "annotation-shape", pointerEvents: "none" as const };
  switch (annotation.shape) {
    case "circle":
      return (
        <ellipse
          cx={annotation.x + annotation.w / 2}
          cy={annotation.y + annotation.h / 2}
          rx={Math.max(1, annotation.w / 2)}
          ry={Math.max(1, annotation.h / 2)}
          {...stroke}
          {...common}
        />
      );
    case "arrow":
      return (
        <line
          x1={annotation.x}
          y1={annotation.y}
          x2={annotation.x + annotation.w}
          y2={annotation.y + annotation.h}
          {...stroke}
          markerEnd={`url(#${ARROW_MARKER_ID})`}
          {...common}
        />
      );
    case "text":
      return (
        <text
          x={annotation.x}
          y={annotation.y}
          fontSize={Math.max(14, annotation.h || 16)}
          style={{ fill: color, cursor: onSelect ? "pointer" : "default" }}
          {...common}
        >
          {annotation.note || "说明文字"}
        </text>
      );
    case "highlight":
      return (
        <rect
          x={annotation.x}
          y={annotation.y}
          width={Math.max(1, annotation.w)}
          height={Math.max(1, annotation.h)}
          style={{
            fill: color,
            opacity: 0.28,
            stroke: color,
            strokeWidth: 1,
            pointerEvents: onSelect ? undefined : "none",
          }}
          {...common}
        />
      );
    default:
      return (
        <rect
          x={annotation.x}
          y={annotation.y}
          width={Math.max(1, annotation.w)}
          height={Math.max(1, annotation.h)}
          {...stroke}
          {...common}
        />
      );
  }
}

/** 只读标注层：无 pointer 事件、无选中态、无草稿。 */
export default function AnnotationRenderer({
  width,
  height,
  annotations,
  className,
}: {
  width: number;
  height: number;
  annotations: Annotation[];
  className?: string;
}) {
  return (
    <svg
      className={className ?? "image-annotator-overlay is-readonly"}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`标注层（${annotations.length} 条）`}
      data-testid="annotation-renderer"
      style={{ pointerEvents: "none" }}
    >
      <defs>
        <marker id={ARROW_MARKER_ID} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--status-danger)" }} />
        </marker>
      </defs>
      {annotations.map((annotation, index) => (
        <AnnotationShape key={`${annotation.shape}-${index}`} annotation={annotation} />
      ))}
    </svg>
  );
}
