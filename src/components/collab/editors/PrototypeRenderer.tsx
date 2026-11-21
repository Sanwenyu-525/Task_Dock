//! 原型纯渲染：只按白名单组件映射 React 元素，不执行 HTML/JS。
//! 编辑态与预览态共用本组件，区别只在是否接收交互回调。

import type { CSSProperties } from "react";
import AssetImage from "./AssetImage";
import { defaultEventFor, type ProtoComponent, type ProtoEvent, type ProtoPage } from "./prototype-types";

export function componentStyle(style?: Record<string, string>): CSSProperties {
  const out: CSSProperties = {};
  if (!style) return out;
  if (style.bg) out.background = style.bg;
  if (style.fg) out.color = style.fg;
  if (style.radius) out.borderRadius = style.radius;
  if (style.fontSize) out.fontSize = style.fontSize;
  if (style.fontWeight) out.fontWeight = style.fontWeight;
  if (style.padding) out.padding = style.padding;
  if (style.gap) out.gap = style.gap;
  if (style.border) out.border = style.border;
  if (style.align) {
    if (["left", "center", "right"].includes(style.align)) {
      out.textAlign = style.align as CSSProperties["textAlign"];
    } else {
      out.alignItems = style.align;
    }
  }
  return out;
}

function labelOf(component: ProtoComponent): string {
  return String(component.props.text ?? component.props.label ?? component.id);
}

export interface PrototypeRendererProps {
  page: ProtoPage;
  values?: Record<string, unknown>;
  interactive?: boolean;
  onEvent?: (component: ProtoComponent, event: ProtoEvent) => void;
}

export default function PrototypeRenderer({
  page,
  values,
  interactive = false,
  onEvent,
}: PrototypeRendererProps) {
  /**
   * 事件优先级：组件显式配置 → 组件类型的默认行为 → 无动作。
   * 预览与编辑共用同一份渲染，保证「看到的行为」就是「保存下来的行为」。
   */
  const fire = (component: ProtoComponent, payload?: unknown) => {
    if (!interactive) return;
    const configured =
      component.type === "input"
        ? component.events.onChange
        : component.events.onClick;
    const event =
      configured ??
      defaultEventFor(component, payload);
    if (!event) return;
    onEvent?.(
      component,
      payload === undefined ? event : { ...event, value: payload },
    );
  };

  return (
    <>
      {page.components.map((component) => {
        const baseStyle: CSSProperties = {
          position: "absolute",
          left: component.x,
          top: component.y,
          width: component.w,
          height: component.h,
          ...componentStyle(component.style),
        };
        const value = values?.[component.id];
        const label = labelOf(component);
        switch (component.type) {
          case "heading":
            return (
              <div key={component.id} style={baseStyle} className="proto-heading" onClick={() => fire(component)}>
                {label}
              </div>
            );
          case "text":
            return (
              <div key={component.id} style={baseStyle} className="proto-text" onClick={() => fire(component)}>
                {label}
              </div>
            );
          case "button":
            return (
              <button
                key={component.id}
                type="button"
                style={baseStyle}
                className={`proto-button ${String(component.props.variant ?? "") === "primary" ? "is-primary" : ""}`}
                onClick={() => fire(component)}
              >
                {label}
              </button>
            );
          case "input":
            return (
              <input
                key={component.id}
                style={baseStyle}
                className="proto-input"
                aria-label={label}
                placeholder={String(component.props.placeholder ?? label)}
                value={String(value ?? component.props.value ?? "")}
                readOnly={!interactive}
                onChange={(e) => fire(component, e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            );
          case "switch": {
            const on = Boolean(value ?? component.props.value ?? false);
            return (
              <button
                key={component.id}
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={label}
                style={baseStyle}
                className={`proto-switch${on ? " is-on" : ""}`}
                onClick={() => fire(component)}
              >
                <span className="proto-switch-knob" />
                <span className="proto-switch-label">{label}</span>
              </button>
            );
          }
          case "badge":
            return (
              <span key={component.id} style={baseStyle} className="proto-badge">
                {label}
              </span>
            );
          case "divider":
            return <div key={component.id} style={baseStyle} className="proto-divider" />;
          case "image": {
            const assetId = String(component.props.assetId ?? "");
            return (
              <div key={component.id} style={baseStyle} className="proto-image">
                {assetId.startsWith("va_") ? (
                  <AssetImage
                    assetId={assetId}
                    alt={label}
                    style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }}
                  />
                ) : (
                  <>图片：{label}</>
                )}
              </div>
            );
          }
          case "frame":
            return (
              <div key={component.id} style={baseStyle} className="proto-frame" onClick={() => fire(component)}>
                {label}
              </div>
            );
          case "tabs":
            return (
              <div key={component.id} style={baseStyle} className="proto-tabs">
                <span className="proto-tab is-active">{label}</span>
              </div>
            );
          case "list":
            return (
              <div key={component.id} style={baseStyle} className="proto-list" onClick={() => fire(component)}>
                {label}
              </div>
            );
          case "chart":
            return (
              <div key={component.id} style={baseStyle} className="proto-chart" aria-label={label}>
                <span style={{ height: "40%" }} />
                <span style={{ height: "70%" }} />
                <span style={{ height: "55%" }} />
              </div>
            );
          default:
            return (
              <div key={component.id} style={baseStyle} className="proto-text" onClick={() => fire(component)}>
                {label}
              </div>
            );
        }
      })}
    </>
  );
}
