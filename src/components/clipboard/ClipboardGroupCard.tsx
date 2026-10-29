//! 分组卡片：整组复制、逐项粘贴、收藏/置顶、详情与删除。

import {
  CheckSquare, Copy, Files, Link2, Maximize2, Pin, Play, Square, Star, Trash2,
} from "lucide-react";
import type { ClipboardGroup } from "../../lib/bridge";
import { clipboardTime, groupModeLabel, groupStatusLabel } from "../../lib/clipboardUi";

export default function ClipboardGroupCard({
  group,
  selected,
  linkMode,
  onSelect,
  onToggle,
  onCopyRich,
  onCopyFiles,
  onPaste,
  onDetail,
  onDelete,
  onLink,
}: {
  group: ClipboardGroup;
  selected: boolean;
  linkMode: boolean;
  onSelect: () => void;
  onToggle: (flag: "favorite" | "pinned") => void;
  onCopyRich: () => void;
  onCopyFiles: () => void;
  onPaste: () => void;
  onDetail: () => void;
  onDelete: () => void;
  onLink: () => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <article
      className={`clip-group-card ${selected ? "selected" : ""}`}
      onClick={onDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDetail();
      }}
      tabIndex={0}
      role="button"
      aria-label={`分组 ${group.name}，${group.item_count} 项`}
    >
      <button
        className="clip-check"
        aria-label={selected ? "取消选择分组" : "选择分组"}
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
          <span className={`clip-badge ${group.status === "collecting" ? "live" : ""}`}>
            {groupStatusLabel(group.status)}
          </span>
          <span className="clip-group-mode">{groupModeLabel(group.mode)}</span>
          {group.pinned && <Pin size={10} className="clip-flag" aria-label="已置顶" />}
          {group.favorite && <Star size={10} className="clip-flag favorite" aria-label="已收藏" />}
          <span className="clip-time">{clipboardTime(group.updated_at)}</span>
        </div>
        <div className="clip-group-name" title={group.name}>{group.name}</div>
        <div className="clip-preview">
          <span>{group.preview || "（分组暂无文本预览）"}</span>
        </div>
        <div className="clip-meta">
          <span>{group.item_count} 项</span>
          <span>{group.image_count} 张图片</span>
        </div>
      </div>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} title="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        <button className="icon-btn sm" title="复制富文本（整组）" aria-label="复制富文本" onClick={onCopyRich}>
          <Copy size={12} />
        </button>
        <button className="icon-btn sm" title="复制文件（整组）" aria-label="复制文件" onClick={onCopyFiles}>
          <Files size={12} />
        </button>
        <button className="icon-btn sm" title="逐项粘贴" aria-label="逐项粘贴" onClick={onPaste}>
          <Play size={12} />
        </button>
        <button
          className={`icon-btn sm ${group.pinned ? "active" : ""}`}
          title={group.pinned ? "取消置顶" : "置顶"}
          aria-label={group.pinned ? "取消置顶" : "置顶"}
          aria-pressed={group.pinned}
          onClick={() => onToggle("pinned")}
        >
          <Pin size={12} />
        </button>
        <button
          className={`icon-btn sm ${group.favorite ? "active" : ""}`}
          title={group.favorite ? "取消收藏" : "收藏"}
          aria-label={group.favorite ? "取消收藏" : "收藏"}
          aria-pressed={group.favorite}
          onClick={() => onToggle("favorite")}
        >
          <Star size={12} />
        </button>
        <button className="icon-btn sm" title="详情" aria-label="详情" onClick={onDetail}>
          <Maximize2 size={12} />
        </button>
        <button className="icon-btn sm danger-ghost" title="删除分组（保留条目）" aria-label="删除分组" onClick={onDelete}>
          <Trash2 size={12} />
        </button>
      </div>
    </article>
  );
}
