//! 暂存架条目卡：缩略图/类型图标、名称截断、大小、来源、时间、失效徽标、
//! 多选复选与条目菜单（打开/定位/复制/收藏/置顶/分组/删除）。

import { useEffect, useState, type MouseEvent } from "react";
import { Clock, FileQuestion, MoreHorizontal, Pin, Star } from "lucide-react";
import {
  shelfReadImage,
  type ShelfDragOutResult,
  type ShelfItem,
} from "../../lib/bridge";
import { clipboardTime, formatBytes } from "../../lib/clipboardUi";
import { shelfFileTypeUi } from "../../lib/fileTypeUi";
import { useShelfDragOut } from "../../hooks/useShelfDragOut";
import { DropdownMenu } from "../ui";
import type { DropdownMenuItem } from "../ui/DropdownMenu";

function sourceLabel(item: ShelfItem): string {
  switch (item.source_kind) {
    case "drag":
      return "拖入";
    case "picker":
      return "选择器";
    case "clipboard":
      return "剪贴板";
    case "url":
      return "链接";
    default:
      return "手动";
  }
}

/** 托管 / 引用模式徽标：让「是否已保存副本」一目了然（避免误以为只有失效路径）。 */
function modeLabel(item: ShelfItem): string {
  if (item.kind === "link") return "链接";
  if (item.kind === "text") return "文本";
  return item.storage_mode === "managed" ? "托管副本" : "引用";
}

export default function ShelfItemCard({
  item,
  selected,
  thumbUrl,
  menuItems,
  onOpen,
  onToggleSelect,
  onPreview,
  dragEnabled = false,
  resolveDragIds,
  onDragSettled,
  onDragError,
}: {
  item: ShelfItem;
  selected: boolean;
  thumbUrl: string | null;
  menuItems: DropdownMenuItem[];
  onOpen: () => void;
  onToggleSelect: () => void;
  onPreview: () => void;
  /** 只有 file/image/folder 且文件存在时为 true。 */
  dragEnabled?: boolean;
  /** 由父级决定拖单条还是整个多选集。 */
  resolveDragIds?: () => string[];
  onDragSettled?: (result: ShelfDragOutResult, ids: string[]) => void;
  onDragError?: (message: string) => void;
}) {
  const type = shelfFileTypeUi(item);
  const Icon = type.icon;
  const missing = item.exists_state === "missing";
  const [fallbackThumb, setFallbackThumb] = useState<string | null>(null);
  const drag = useShelfDragOut({
    enabled: dragEnabled,
    resolveIds: resolveDragIds ?? (() => []),
    onSettled: onDragSettled,
    onError: onDragError,
  });
  /** 拖拽收尾的 click 不应打开详情/切换选择。 */
  const guarded = (run: () => void) => (event: MouseEvent) => {
    if (drag.shouldSuppressClick()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    run();
  };
  // 列表传入的 thumbUrl 为空时（如翻页合并后），图片条目自行懒加载一次
  useEffect(() => {
    if (thumbUrl || fallbackThumb || item.kind !== "image") return;
    let alive = true;
    shelfReadImage(item.id, false)
      .then((u) => alive && u && setFallbackThumb(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [thumbUrl, fallbackThumb, item.kind, item.id]);

  const thumb = thumbUrl ?? fallbackThumb;

  return (
    <div
      className={`shelf-item surface-card ${selected ? "selected surface-card--selected" : ""} ${missing ? "missing" : ""} ${dragEnabled ? "is-draggable" : ""}`}
      role="listitem"
      aria-selected={selected}
      data-kind={item.kind}
      onPointerDown={drag.onPointerDown}
    >
      <button
        type="button"
        className={`shelf-check ${selected ? "on" : ""}`}
        aria-label={selected ? `取消选择 ${item.display_name}` : `选择 ${item.display_name}`}
        aria-pressed={selected}
        data-no-drag
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
      >
        {selected && "✓"}
      </button>
      <button
        type="button"
        className={`shelf-thumb file-tone-${type.tone}`}
        aria-label={`预览 ${item.display_name}`}
        data-tip={dragEnabled ? "点击预览 · 按住拖到其他窗口" : undefined}
        onClick={guarded(() => onPreview())}
      >
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" draggable={false} />
        ) : (
          <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
        )}
        {missing && (
          <span className="shelf-thumb-badge missing" data-tip="原文件/副本已失效">
            <FileQuestion size={13} aria-hidden="true" />
          </span>
        )}
      </button>
      <div className="shelf-item-body">
        <button
          type="button"
          className="shelf-item-name"
          data-tip={`${item.display_name} · ${type.label} · ${modeLabel(item)}`}
          onClick={guarded(() => onOpen())}
        >
          {item.display_name}
        </button>
        <div className="shelf-item-meta">
          <span className="shelf-tag mode">{modeLabel(item)}</span>
          <span>{formatBytes(item.byte_size)}</span>
          <span className="shelf-item-meta-sep" aria-hidden="true">·</span>
          <span className="shelf-item-src">{sourceLabel(item)}</span>
          <span className="shelf-item-meta-sep" aria-hidden="true">·</span>
          <span className="shelf-item-time">
            <Clock size={11} aria-hidden="true" />
            {clipboardTime(item.created_at)}
          </span>
        </div>
      </div>
      <div className="shelf-item-flags">
        {item.favorite && <Star size={12} aria-hidden="true" className="flag-fav" />}
        {item.pinned && <Pin size={12} aria-hidden="true" className="flag-pin" />}
      </div>
      <DropdownMenu
        trigger={(props) => (
          <button
            {...props}
            type="button"
            className="icon-btn sm shelf-more"
            aria-label={`更多操作：${item.display_name}`}
            data-no-drag
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        )}
        items={menuItems}
        menuLabel={`条目操作：${item.display_name}`}
        placement="bottom-end"
      />
    </div>
  );
}
