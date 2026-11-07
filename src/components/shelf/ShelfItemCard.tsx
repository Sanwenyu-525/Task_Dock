//! 暂存架条目卡：缩略图/类型图标、名称截断、大小、来源、时间、失效徽标、
//! 多选复选与条目菜单（打开/定位/复制/收藏/置顶/分组/删除）。

import { useEffect, useState } from "react";
import {
  Clock, File, FileQuestion, Folder, Image as ImageIcon, Link2,
  MoreHorizontal, Pin, Star, Type,
} from "lucide-react";
import {
  shelfReadImage,
  SHELF_KIND_LABELS,
  type ShelfItem,
} from "../../lib/bridge";
import { clipboardTime, formatBytes } from "../../lib/clipboardUi";
import { DropdownMenu } from "../ui";
import type { DropdownMenuItem } from "../ui/DropdownMenu";

const KIND_ICONS = {
  file: File,
  folder: Folder,
  image: ImageIcon,
  link: Link2,
  text: Type,
} as const;

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
}: {
  item: ShelfItem;
  selected: boolean;
  thumbUrl: string | null;
  menuItems: DropdownMenuItem[];
  onOpen: () => void;
  onToggleSelect: () => void;
  onPreview: () => void;
}) {
  const Icon = KIND_ICONS[item.kind] ?? File;
  const missing = item.exists_state === "missing";
  const [fallbackThumb, setFallbackThumb] = useState<string | null>(null);
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
      className={`shelf-item surface-card ${selected ? "selected surface-card--selected" : ""} ${missing ? "missing" : ""}`}
      role="listitem"
      aria-selected={selected}
      data-kind={item.kind}
    >
      <button
        type="button"
        className={`shelf-check ${selected ? "on" : ""}`}
        aria-label={selected ? `取消选择 ${item.display_name}` : `选择 ${item.display_name}`}
        aria-pressed={selected}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
      >
        {selected && "✓"}
      </button>
      <button
        type="button"
        className="shelf-thumb"
        aria-label={`预览 ${item.display_name}`}
        onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
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
          data-tip={item.display_name}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {item.display_name}
        </button>
        <div className="shelf-item-meta">
          <span className="shelf-tag mode">{modeLabel(item)}</span>
          <span>{formatBytes(item.byte_size)}</span>
          <span aria-hidden="true">·</span>
          <span className="shelf-item-src">{sourceLabel(item)}</span>
          <span aria-hidden="true">·</span>
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

export { SHELF_KIND_LABELS };
