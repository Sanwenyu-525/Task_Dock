//! 历史条目卡片：类型/预览/来源/时间 + 复制、收藏、置顶、详情、删除、关联。

import {
  CheckSquare, Code2, Copy, Files, Globe, Image as ImageIcon, Link2, Maximize2,
  Pin, Square, Star, Trash2, Type,
} from "lucide-react";
import type { ClipboardItem } from "../../lib/bridge";
import { clipboardTime, fileBaseName, formatBytes, kindLabel, sourceLabel } from "../../lib/clipboardUi";
import { ClipboardThumb } from "./Media";

const KIND_ICONS: Record<string, typeof Type> = {
  text: Type,
  url: Globe,
  html: Code2,
  image: ImageIcon,
  files: Files,
};

export default function ClipboardItemCard({
  item,
  selected,
  linkMode,
  onSelect,
  onCopy,
  onToggle,
  onDetail,
  onDelete,
  onLink,
}: {
  item: ClipboardItem;
  selected: boolean;
  linkMode: boolean;
  onSelect: () => void;
  onCopy: () => void;
  onToggle: (flag: "favorite" | "pinned") => void;
  onDetail: () => void;
  onDelete: () => void;
  onLink: () => void;
}) {
  const Icon = KIND_ICONS[item.kind] ?? Type;
  const meta = sourceLabel(item.source_app, item.source_title);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <article
      className={`clip-item ${selected ? "selected" : ""}`}
      onClick={onDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDetail();
      }}
      tabIndex={0}
      role="button"
      aria-label={`${kindLabel(item.kind)}：${item.preview || "空内容"}`}
    >
      <button
        className="clip-check"
        aria-label={selected ? "取消选择" : "选择条目"}
        aria-pressed={selected}
        onClick={(e) => {
          stop(e);
          onSelect();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {selected ? <CheckSquare size={14} /> : <Square size={14} />}
      </button>

      <div className="clip-item-main">
        <div className="clip-item-top">
          <span className={`clip-kind kind-${item.kind}`}>
            <Icon size={11} /> {kindLabel(item.kind)}
          </span>
          {item.pinned && <Pin size={10} className="clip-flag" aria-label="已置顶" />}
          {item.favorite && <Star size={10} className="clip-flag favorite" aria-label="已收藏" />}
          <span className="clip-time">{clipboardTime(item.last_seen_at)}</span>
        </div>

        <div className={`clip-preview ${item.kind === "image" ? "with-thumb" : ""}`}>
          {item.kind === "image" && (
            <ClipboardThumb itemId={item.id} hasThumb={item.has_thumb} size={44} />
          )}
          <span className={item.kind === "text" || item.kind === "html" ? "clip-text" : ""}>
            {item.preview || "（无文本预览）"}
          </span>
        </div>

        <div className="clip-meta">
          <span title={item.source_title || item.source_app}>{meta}</span>
          <span>{formatBytes(item.byte_size)}</span>
          {item.copy_count > 0 && <span>使用 {item.copy_count} 次</span>}
        </div>

        {item.file_paths.length > 0 && (
          <div className="clip-file-list">
            {item.file_paths.slice(0, 3).map((p) => (
              <span key={p} title={p}>{fileBaseName(p)}</span>
            ))}
            {item.file_paths.length > 3 && <span>… 共 {item.file_paths.length} 个</span>}
          </div>
        )}
      </div>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} title="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        <button className="icon-btn sm" title="复制" aria-label="复制" onClick={onCopy}>
          <Copy size={12} />
        </button>
        <button
          className={`icon-btn sm ${item.pinned ? "active" : ""}`}
          title={item.pinned ? "取消置顶" : "置顶"}
          aria-label={item.pinned ? "取消置顶" : "置顶"}
          aria-pressed={item.pinned}
          onClick={() => onToggle("pinned")}
        >
          <Pin size={12} />
        </button>
        <button
          className={`icon-btn sm ${item.favorite ? "active" : ""}`}
          title={item.favorite ? "取消收藏" : "收藏"}
          aria-label={item.favorite ? "取消收藏" : "收藏"}
          aria-pressed={item.favorite}
          onClick={() => onToggle("favorite")}
        >
          <Star size={12} />
        </button>
        <button className="icon-btn sm" title="详情" aria-label="详情" onClick={onDetail}>
          <Maximize2 size={12} />
        </button>
        <button className="icon-btn sm danger-ghost" title="删除" aria-label="删除" onClick={onDelete}>
          <Trash2 size={12} />
        </button>
      </div>
    </article>
  );
}
