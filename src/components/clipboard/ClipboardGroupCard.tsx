//! 分组卡片：整组复制、逐项粘贴、收藏/置顶、详情与删除。

import { useLayoutEffect, useRef } from "react";
import {
  CheckSquare, Copy, Files, Link2, Maximize2, Pin, Play, Square, Star, Trash2,
} from "lucide-react";
import type { ClipboardGroup } from "../../lib/bridge";
import { clipboardTime, groupModeLabel, groupStatusLabel } from "../../lib/clipboardUi";

export default function ClipboardGroupCard({
  group,
  selected,
  linkMode,
  removing,
  pending,
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
  /** 已删除、正在播放退出动画 */
  removing: boolean;
  /** 删除请求在途（后端尚未确认）：显示执行中并挡住重复操作 */
  pending: boolean;
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
  // 在途或正在离场：整卡冻结，避免对同一个分组连发第二次删除
  const locked = removing || pending;
  const cardRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (removing && el) el.style.setProperty("--clip-exit-h", `${el.offsetHeight}px`);
  }, [removing]);

  return (
    <article
      ref={cardRef}
      data-clip-id={group.id}
      className={`clip-group-card ${selected ? "selected" : ""} ${removing ? "removing" : ""} ${pending ? "pending" : ""}`}
      onClick={locked ? undefined : onDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !locked) onDetail();
      }}
      tabIndex={locked ? -1 : 0}
      role="button"
      aria-hidden={removing || undefined}
      // 离场期间整棵子树不可交互：inert 补上 pointer-events 挡不住的键盘焦点
      inert={removing || undefined}
      aria-busy={pending || undefined}
      aria-label={`分组 ${group.name}，${group.item_count} 项`}
    >
      <button
        className="clip-check"
        aria-label={selected ? "取消选择分组" : "选择分组"}
        aria-pressed={selected}
        disabled={locked}
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
          {group.pinned && <Pin size={10} className="clip-flag" aria-label="已置顶" />}
          {group.favorite && <Star size={10} className="clip-flag favorite" aria-label="已收藏" />}
          <span className="clip-time">{clipboardTime(group.updated_at)}</span>
        </div>
        <div className="clip-group-name" title={group.name}>{group.name}</div>
        <div className="clip-preview">
          <span>{group.preview || "（分组暂无文本预览）"}</span>
        </div>
        {/* 模式与计数属于次要信息，合并到一行弱化展示，避免顶部堆满标签 */}
        <div className="clip-meta">
          <span>
            {group.item_count} 项
            {group.image_count > 0 && ` · ${group.image_count} 张截图`}
            {` · ${groupModeLabel(group.mode)}`}
          </span>
        </div>
      </div>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} disabled={locked} title="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        <button
          className="icon-btn sm"
          data-tip="复制富文本（整组）"
          aria-label="复制富文本"
          onClick={onCopyRich}
          disabled={locked}
        >
          <Copy size={12} />
        </button>
        <button
          className="icon-btn sm"
          data-tip="复制文件（整组）"
          aria-label="复制文件"
          onClick={onCopyFiles}
          disabled={locked}
        >
          <Files size={12} />
        </button>
        <button className="icon-btn sm" data-tip="逐项粘贴" aria-label="逐项粘贴" onClick={onPaste} disabled={locked}>
          <Play size={12} />
        </button>
        <button
          className={`icon-btn sm ${group.pinned ? "active" : ""}`}
          data-tip={group.pinned ? "取消置顶" : "置顶"}
          aria-label={group.pinned ? "取消置顶" : "置顶"}
          aria-pressed={group.pinned}
          onClick={() => onToggle("pinned")}
          disabled={locked}
        >
          <Pin size={12} />
        </button>
        <button
          className={`icon-btn sm ${group.favorite ? "active" : ""}`}
          data-tip={group.favorite ? "取消收藏" : "收藏"}
          aria-label={group.favorite ? "取消收藏" : "收藏"}
          aria-pressed={group.favorite}
          onClick={() => onToggle("favorite")}
          disabled={locked}
        >
          <Star size={12} />
        </button>
        <button className="icon-btn sm" data-tip="详情" aria-label="详情" onClick={onDetail} disabled={locked}>
          <Maximize2 size={12} />
        </button>
        <button
          className="icon-btn sm danger-ghost"
          data-tip="删除分组（保留条目）"
          aria-label="删除分组"
          onClick={onDelete}
          disabled={locked}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </article>
  );
}
