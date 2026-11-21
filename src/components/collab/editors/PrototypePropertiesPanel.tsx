//! 原型属性面板：按组件类型动态显示字段。

import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import Select from "../../ui/Select";
import type { VisualAsset } from "../../../lib/collab";
import {
  EVENT_ACTIONS,
  STYLE_KEYS,
  type ProtoComponent,
  type ProtoPage,
} from "./prototype-types";

export interface PrototypePropertiesPanelProps {
  component: ProtoComponent | null;
  pages: ProtoPage[];
  assets: VisualAsset[];
  /**
   * `fieldKey` 用于编辑器合并连续输入（同一次输入只记一条历史），
   * 例如 `prop:text` / `style:bg` / `geometry:x` / `event:onClick`。
   */
  onChange: (
    mutate: (component: ProtoComponent) => ProtoComponent,
    fieldKey?: string,
  ) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onLayer: (direction: "up" | "down" | "top" | "bottom") => void;
  onImportAsset: () => Promise<VisualAsset | null>;
}

const EVENT_KEYS = ["onClick", "onChange", "onSubmit"] as const;

const STYLE_HINTS: Record<string, string> = {
  bg: "var(--accent) / #ffffff",
  fg: "var(--text-primary)",
  radius: "8px",
  fontSize: "14px",
  fontWeight: "bold / 600",
  padding: "8px",
  gap: "6px",
  border: "1px solid var(--border-subtle)",
  align: "left / center / column",
};

export default function PrototypePropertiesPanel({
  component,
  pages,
  assets,
  onChange,
  onDelete,
  onDuplicate,
  onLayer,
  onImportAsset,
}: PrototypePropertiesPanelProps) {
  if (!component) {
    return (
      <aside className="proto-properties" aria-label="原型属性面板">
        <strong>属性</strong>
        <div className="collab-muted">选择一个组件查看属性。</div>
      </aside>
    );
  }

  const textKey = component.type === "heading" || component.type === "text" ? "text" : "label";
  const pageOptions = pages.map((p) => ({ value: p.id, label: p.name }));
  const componentOptions = pages
    .flatMap((p) => p.components.map((c) => ({ value: c.id, label: `${p.name} · ${c.id}` })))
    .filter((o) => o.value !== component.id);

  const setProp = (key: string, value: string) =>
    onChange((c) => ({ ...c, props: { ...c.props, [key]: value } }), `prop:${key}`);

  const setStyle = (key: string, value: string) =>
    onChange((c) => {
      const style = { ...c.style };
      if (value.trim()) style[key] = value.trim();
      else delete style[key];
      return { ...c, style };
    }, `style:${key}`);

  const setEvent = (key: string, action: string, target?: string, value?: string) =>
    onChange((c) => {
      const events = { ...c.events };
      if (!action) {
        delete events[key];
      } else {
        events[key] = {
          action,
          ...(target ? { target } : {}),
          ...(action === "setValue" ? { value: value ?? "" } : {}),
        };
      }
      return { ...c, events };
    }, `event:${key}`);

  return (
    <aside className="proto-properties" aria-label="原型属性面板">
      <div className="proto-prop-head">
        <strong>属性</strong>
        <span className="collab-muted">{component.id}</span>
      </div>

      <label>
        文案
        <input
          className="input"
          value={String(component.props[textKey] ?? "")}
          onChange={(e) => setProp(textKey, e.target.value)}
        />
      </label>

      {component.type === "input" ? (
        <label>
          占位文字
          <input
            className="input"
            value={String(component.props.placeholder ?? "")}
            onChange={(e) => setProp("placeholder", e.target.value)}
          />
        </label>
      ) : null}

      {component.type === "image" ? (
        <div className="proto-prop-group">
          <strong>图片资产</strong>
          <Select
            value={String(component.props.assetId ?? "")}
            options={[
              { value: "", label: "未选择" },
              ...assets.map((asset) => ({
                value: asset.id,
                label: asset.title || asset.sha256.slice(0, 8),
              })),
            ]}
            onChange={(value) => setProp("assetId", value)}
            ariaLabel="图片资产"
            size="sm"
            block
          />
          <button
            className="btn ghost small"
            onClick={() => {
              void onImportAsset().then((asset) => {
                if (asset) setProp("assetId", asset.id);
              });
            }}
          >
            导入图片
          </button>
        </div>
      ) : null}

      {component.type === "button" ? (
        <label>
          样式变体
          <Select
            value={String(component.props.variant ?? "")}
            options={[
              { value: "", label: "默认" },
              { value: "primary", label: "主要" },
            ]}
            onChange={(value) => setProp("variant", value)}
            ariaLabel="按钮变体"
            size="sm"
            block
          />
        </label>
      ) : null}

      <div className="proto-prop-grid">
        {(["x", "y", "w", "h"] as const).map((key) => (
          <label key={key}>
            {key.toUpperCase()}
            <input
              className="input small"
              type="number"
              min={key === "w" || key === "h" ? 1 : 0}
              max={key === "w" || key === "h" ? 2000 : 5000}
              value={component[key]}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || n < 0) return;
                onChange(
                  (c) => ({
                    ...c,
                    [key]:
                      key === "w" || key === "h"
                        ? Math.min(2000, Math.max(1, n))
                        : Math.min(5000, n),
                  }),
                  `geometry:${key}`,
                );
              }}
            />
          </label>
        ))}
      </div>

      <div className="proto-prop-group">
        <strong>样式</strong>
        {STYLE_KEYS.map((key) => (
          <label key={key}>
            {key}
            <input
              className="input small"
              placeholder={STYLE_HINTS[key]}
              value={component.style[key] ?? ""}
              onChange={(e) => setStyle(key, e.target.value)}
            />
          </label>
        ))}
      </div>

      <div className="proto-prop-group">
        <strong>事件</strong>
        {EVENT_KEYS.map((key) => {
          const event = component.events[key];
          const action = event?.action ?? "";
          const target = event?.target ?? "";
          return (
            <div key={key} className="proto-event-row">
              <span className="proto-event-key">{key}</span>
              <Select
                value={action}
                options={EVENT_ACTIONS}
                onChange={(value) => setEvent(key, value)}
                ariaLabel={`${key} 动作`}
                size="sm"
              />
              {action === "navigate" ? (
                <Select
                  value={target}
                  options={pageOptions}
                  onChange={(value) => setEvent(key, action, value)}
                  ariaLabel={`${key} 目标页面`}
                  size="sm"
                />
              ) : null}
              {action === "openModal" ? (
                <Select
                  value={target}
                  options={componentOptions}
                  onChange={(value) => setEvent(key, action, value)}
                  ariaLabel={`${key} 目标组件`}
                  size="sm"
                />
              ) : null}
              {action === "toggle" || action === "setValue" ? (
                <Select
                  value={target}
                  options={componentOptions}
                  onChange={(value) => setEvent(key, action, value, String(event?.value ?? ""))}
                  ariaLabel={`${key} 目标组件`}
                  size="sm"
                />
              ) : null}
              {action === "setValue" ? (
                <input
                  className="input small"
                  placeholder="写入值"
                  value={String(event?.value ?? "")}
                  onChange={(e) => setEvent(key, action, target, e.target.value)}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="proto-prop-group">
        <strong>层级</strong>
        <div className="proto-layer-actions">
          <button className="btn icon-btn" aria-label="置顶" data-tip="置顶" onClick={() => onLayer("top")}>
            <ArrowUp size={14} />
          </button>
          <button className="btn icon-btn" aria-label="上移一层" data-tip="上移一层" onClick={() => onLayer("up")}>
            <ArrowUp size={12} />
          </button>
          <button className="btn icon-btn" aria-label="下移一层" data-tip="下移一层" onClick={() => onLayer("down")}>
            <ArrowDown size={12} />
          </button>
          <button className="btn icon-btn" aria-label="置底" data-tip="置底" onClick={() => onLayer("bottom")}>
            <ArrowDown size={14} />
          </button>
        </div>
      </div>

      <div className="proto-prop-group">
        <div className="collab-form-actions">
          <button className="btn small" onClick={onDuplicate}>
            <Copy size={14} /> 复制
          </button>
          <button className="btn ghost small" onClick={onDelete}>
            <Trash2 size={14} /> 删除
          </button>
        </div>
      </div>
    </aside>
  );
}
