//! 原型页面管理：新增、切换、重命名、删除。

import { Plus, Trash2 } from "lucide-react";
import type { ProtoPage } from "./prototype-types";

export interface PrototypePageManagerProps {
  pages: ProtoPage[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}

export default function PrototypePageManager({
  pages,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}: PrototypePageManagerProps) {
  const active = pages.find((p) => p.id === activeId) ?? pages[0];
  return (
    <div className="proto-pages" aria-label="页面管理">
      <div className="proto-page-tabs" role="tablist">
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            role="tab"
            aria-selected={page.id === activeId}
            className={`proto-page-tab ${page.id === activeId ? "is-active" : ""}`}
            onClick={() => onSelect(page.id)}
          >
            {page.name}
            <span className="collab-muted">{page.components.length}</span>
          </button>
        ))}
        <button className="btn icon-btn" aria-label="新增页面" data-tip="新增页面" onClick={onAdd}>
          <Plus size={14} />
        </button>
      </div>
      {active ? (
        <div className="proto-page-edit">
          <input
            className="input small"
            aria-label="当前页面名称"
            value={active.name}
            onChange={(e) => onRename(active.id, e.target.value)}
          />
          <button
            className="btn ghost small"
            onClick={() => onRemove(active.id)}
            disabled={pages.length <= 1}
            aria-label="删除当前页面"
          >
            <Trash2 size={14} /> 删除页面
          </button>
          <span className="collab-muted">组件 {active.components.length} / 200</span>
        </div>
      ) : null}
    </div>
  );
}
